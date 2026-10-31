import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { ComputeDecisionChoice, ComputeDecisionEvidence, classifyCompute } from "./compute-decision.ts";
import { assertComputeEvidence, collectComputeEvidence, refreshComputeObservation } from "./compute-observation.ts";
import { recordRuntimeSuspension } from "./development-intent.ts";
import { finalizationDigest } from "./finalization-resources.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Reference = z.object({ intentRevision: z.number().int().positive(), intentDigest: Digest }).strict();
const Result = z.object({ choice: ComputeDecisionChoice, confidence: z.number().min(0).max(1), model: z.literal("gpt-6-luna"),
  evidenceDigest: Digest, requestDigest: Digest, requested: z.boolean(),
  failure: z.enum(["missing-credential", "request-failed", "timeout", "http-error", "invalid-response", "refused"]).optional(),
}).strict();
const Decision = z.object({ version: z.literal(1), environmentId: z.string(), requestKey: z.string(), snapshotDigest: Digest,
  evidence: ComputeDecisionEvidence, result: Result.nullable(), outcome: z.enum(["not-eligible", "advisory", "stale", "suspension-recorded"]),
  intent: Reference.optional(),
}).strict();
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Pick<AgentSessionRuntime, "history" | "observeSessionActivity">;
  environmentId: string; requestKey: string };
type Dependencies = { refresh: typeof refreshComputeObservation; collect: typeof collectComputeEvidence; classify: typeof classifyCompute };
const action = "compute-idle-decision";

/** Decisions is advisory. The same deterministic collector guard and original
 * development intent path remain responsible for every eventual stop effect.
 * This function does not stop a process, free capacity, close work or pause it. */
export async function considerComputeSuspension(input: Context, dependencies: Partial<Dependencies> = {}) {
  if (!input.config.compute?.enabled) throw new Error("Host compute admission is disabled");
  const requestKey = z.string().min(1).max(180).parse(input.requestKey);
  const environment = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  const where = { runtimeSessionId: environment.primarySessionId, source: `compute:${environment.taskId}`, action, key: requestKey };
  const previous = await input.prisma.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
  if (previous?.value) {
    const saved = Decision.parse(JSON.parse(previous.value));
    if (saved.environmentId !== environment.id || saved.requestKey !== requestKey) throw new Error("Compute decision request belongs to another environment");
    // Historical outcome is a receipt, not renewed stop authority. Any pending
    // stop still passes fresh per-effect development authority on continuation.
    return { ...saved, revision: previous.sequence, replayed: true };
  }
  const refresh = dependencies.refresh ?? refreshComputeObservation;
  await refresh(input);
  const observed = await (dependencies.collect ?? collectComputeEvidence)(input);
  const evidence = ComputeDecisionEvidence.parse(observed.evidence);
  if (evidence.task.environmentId !== environment.id || evidence.task.id !== environment.taskId || evidence.task.primarySessionId !== environment.primarySessionId
    || evidence.evidenceDigest !== observed.snapshotDigest) throw new Error("Compute decision evidence belongs to another owner");
  // Review compute is tracked for admission and measurements, but protected
  // review leases are not automatically suspended by this development path.
  const candidate = observed.eligible && evidence.task.purpose === "development";
  const result = candidate ? Result.parse(await (dependencies.classify ?? classifyCompute)(evidence, {
    apiKey: input.config.compute.decisionApiKey ?? "", model: "gpt-6-luna",
  })) : null;
  if (result && result.evidenceDigest !== observed.snapshotDigest) throw new Error("Compute decision returned different evidence");
  // Slow classification may outlast a request or collector restart. Complete
  // a fresh physical read before the database-only compare-and-swap below.
  let refreshed = true;
  if (candidate && result?.choice === "suspend-compute" && !result.failure) {
    try { await refresh(input); } catch { refreshed = false; }
  }
  return input.prisma.$transaction(async tx => {
    const raced = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    if (raced?.value) {
      const saved = Decision.parse(JSON.parse(raced.value));
      if (saved.environmentId !== environment.id || saved.requestKey !== requestKey) throw new Error("Compute decision request belongs to another environment");
      return { ...saved, revision: raced.sequence, replayed: true };
    }
    let outcome: z.infer<typeof Decision>["outcome"] = candidate ? "advisory" : "not-eligible";
    let intent: z.infer<typeof Reference> | undefined;
    if (candidate && result?.choice === "suspend-compute" && !result.failure && result.requested) {
      outcome = "stale";
      try {
        if (!refreshed) throw new Error("Current compute observation is unavailable");
        await assertComputeEvidence({ ...input, prisma: tx, snapshotDigest: observed.snapshotDigest });
        intent = await recordRuntimeSuspension({ ...input, prisma: tx, taskId: environment.taskId,
          requestKey: `compute:${finalizationDigest([environment.id, requestKey])}`, suspension: {
            environmentId: environment.id, snapshotDigest: observed.snapshotDigest,
            resourceId: observed.resource.id, resourceKey: observed.resource.key, resourceIdentity: observed.resource.identityDigest,
          } });
        outcome = "suspension-recorded";
      } catch {
        // Preserve the bounded classifier output and evidence when deterministic
        // authority changed. Never persist raw provider errors or infer a stop.
        outcome = "stale";
      }
    }
    const value = Decision.parse({ version: 1, environmentId: environment.id, requestKey, snapshotDigest: observed.snapshotDigest, evidence, result, outcome, ...(intent ? { intent } : {}) });
    const saved = await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(value) } });
    return { ...value, revision: saved.sequence, replayed: false };
  });
}
