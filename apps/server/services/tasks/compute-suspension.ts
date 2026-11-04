import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { ComputeSuspensionDecision as Decision, ComputeDecisionEvidence, classifyCompute } from "./compute-decision.ts";
import { assertComputeEvidence, collectComputeEvidence, computeEvidenceState, refreshComputeObservation } from "./compute-observation.ts";
import { developmentProjection, recordRuntimeSuspension } from "./development-intent.ts";
import { finalizationDigest } from "./finalization-resources.ts";

import { computeIdleAttemptStatus, currentComputeIdleClaim, finishComputeIdleAttempt, reserveComputeIdleAttempt, type ComputeIdleClaim } from "./compute-idle-attempt.ts";

const Result = Decision.shape.result.unwrap();
const Reference = Decision.shape.intent.unwrap();
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Pick<AgentSessionRuntime, "history" | "observeSessionActivity">;
  environmentId: string; requestKey: string; attempt?: ComputeIdleClaim };
type Dependencies = { refresh: typeof refreshComputeObservation; collect: typeof collectComputeEvidence; classify: typeof classifyCompute; now: () => number };
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
  if (candidate && input.attempt && !await idleDevelopmentAvailable(input, environment.taskId)) throw new Error("Idle decision waits for existing development work");
  if (candidate && input.attempt && !await currentComputeIdleClaim({ ...input, claim: input.attempt, snapshotDigest: observed.snapshotDigest, now: (dependencies.now ?? Date.now)() })) throw new Error("Idle attempt is no longer current");
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
    const decisionAt = (dependencies.now ?? Date.now)();
    const raced = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    if (raced?.value) {
      const saved = Decision.parse(JSON.parse(raced.value));
      if (saved.environmentId !== environment.id || saved.requestKey !== requestKey) throw new Error("Compute decision request belongs to another environment");
      return { ...saved, revision: raced.sequence, replayed: true };
    }
    const claimCurrent = !input.attempt || Boolean(await currentComputeIdleClaim({ ...input, prisma: tx, claim: input.attempt, snapshotDigest: observed.snapshotDigest, now: decisionAt }));
    let outcome: z.infer<typeof Decision>["outcome"] = !claimCurrent ? "stale" : candidate ? "advisory" : "not-eligible";
    let intent: z.infer<typeof Reference> | undefined;
    if (claimCurrent && candidate && result?.choice === "suspend-compute" && !result.failure && result.requested) {
      outcome = "stale";
      try {
        if (!refreshed) throw new Error("Current compute observation is unavailable");
        const current = await assertComputeEvidence({ ...input, prisma: tx, snapshotDigest: observed.snapshotDigest });
        if (current.sessionIds.some(id => ["executing", "queued"].includes(input.runtime.observeSessionActivity?.(id)?.state ?? ""))) throw new Error("Current runtime work prevents suspension");
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
    if (input.attempt) await finishComputeIdleAttempt({ ...input, prisma: tx, claim: input.attempt, now: decisionAt, decision: { ...value, revision: saved.sequence } });
    return { ...value, revision: saved.sequence, replayed: false };
  });
}

/** Host scheduling is distinct from exact-request receipt replay. Cooldown ticks
 * perform no conversation collection or paid request. A reservation is committed
 * before dispatch; restart never resends that attempt, even after an unknown result. */
export async function considerIdleComputeSuspension(input: Omit<Context, "attempt">, dependencies: Partial<Dependencies> = {}) {
  const now = dependencies.now ?? Date.now;
  const observed = await computeEvidenceState(input);
  if (!await idleDevelopmentAvailable(input, observed.evidence.task.id)) return;
  const status = await computeIdleAttemptStatus({ ...input, observed, now: now() });
  if (status.status === "cooldown" || status.status === "blocked" || status.status === "advisory" || status.status === "suspension-recorded" || status.status === "pending" && now() < status.nextEligibleAt!) return;
  if (status.status === "due") {
    await (dependencies.refresh ?? refreshComputeObservation)(input);
    const fresh = await (dependencies.collect ?? collectComputeEvidence)(input);
    if (!fresh.eligible || fresh.evidence.task.purpose !== "development" || fresh.physicalState !== "running") return;
    const claim = await input.prisma.$transaction(async tx => {
      const current = await assertComputeEvidence({ ...input, prisma: tx, snapshotDigest: fresh.snapshotDigest });
      if (current.sessionIds.some(id => ["executing", "queued"].includes(input.runtime.observeSessionActivity?.(id)?.state ?? ""))) return;
      if (!await idleDevelopmentAvailable({ ...input, prisma: tx }, current.evidence.task.id)) return;
      return reserveComputeIdleAttempt({ ...input, prisma: tx, observed: current, now: now() });
    });
    if (!claim) return;
    try { return await considerComputeSuspension({ ...input, requestKey: claim.requestKey, attempt: claim }, dependencies); }
    catch (error) {
      // No provider error text or assumption that an interrupted call was free.
      await input.prisma.$transaction(tx => finishComputeIdleAttempt({ ...input, prisma: tx, claim, now: now() }));
      throw error;
    }
  }
  // Persist expiry/attention once, without classifying or bypassing ineligibility.
  await input.prisma.$transaction(tx => reserveComputeIdleAttempt({ ...input, prisma: tx, observed, now: now() }));
}

async function idleDevelopmentAvailable(input: { prisma: Parameters<typeof developmentProjection>[0]["prisma"]; config: ServerConfig; runtime: Context["runtime"] }, taskId: string) {
  const projection = await developmentProjection({ ...input, taskId });
  return !projection.developmentBlocked && !projection.developmentIntent?.blocked && !(projection.developmentIntent?.state === "pending" && projection.developmentIntent.reason !== "runtime-suspended");
}
