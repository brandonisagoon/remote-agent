import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { reconcileObservedCompute, offerNextCompute } from "./compute-admission.ts";
import { refreshComputeObservation, computeEvidenceState } from "./compute-observation.ts";
import { considerComputeSuspension } from "./compute-suspension.ts";
import { developmentProjection } from "./development-intent.ts";
import { verifiedComputeRuntime } from "./compute-observer.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { reclaimStoppedCompute } from "./compute-reclamation.ts";
import { isSavedComputeEnvironment } from "./compute-saved-resource.ts";

async function continueSuspension(input: Context & { taskId: string; primarySessionId: string; environmentId: string; intentRevision: number; intentDigest: string }) {
  const reference = { intentRevision: input.intentRevision, intentDigest: input.intentDigest };
  const runtime = await verifiedComputeRuntime({ ...input, sessionId: input.primarySessionId, development: reference });
  const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  await executeOwnedObserver([process.execPath, "--no-env-file", runtime.adapterPath, "compute", "continue", "--socket", input.config.controlIpcPath, "--task", input.taskId], {
    cwd: runtime.receipt.checkout, env, timeoutMs: 60_000, input: JSON.stringify({ ...reference, environmentId: input.environmentId }),
  });
  if (runtime.before !== await runtime.checked()) throw new Error("Compute runtime changed during continuation");
}
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime };
const defaults = { refresh: refreshComputeObservation, evidence: computeEvidenceState, consider: considerComputeSuspension, continue: continueSuspension, reclaim: reclaimStoppedCompute };

/** A bounded host collector uses the configured immutable runtime capability.
 * It never asks an agent to invent a stop, nor treats an observation failure as
 * idle. Every adapter effect renews the existing scoped development intent. */
export async function tickCompute(input: Context, dependencies: Partial<typeof defaults> = {}) {
  if (!input.config.compute?.enabled) return { observed: 0, unavailable: 0 };
  const deps = { ...defaults, ...dependencies };
  const environments = await input.prisma.computeEnvironment.findMany({ where: { machineId: input.config.machine, resourceId: { not: null } }, orderBy: { id: "asc" }, take: 1001 });
  if (environments.length > 1000) throw new Error("Compute host inventory exceeds its bound");
  let index = 0, observed = 0, unavailable = 0;
  await Promise.all(Array.from({ length: Math.min(4, environments.length) }, async () => {
    for (;;) {
      const environment = environments[index++]; if (!environment) return;
      try {
        const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: environment.taskId } });
        const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: environment.resourceId! } });
        if (task.ownerPaused || task.phase === "closed" || resource.state === "released") {
          await deps.reclaim({ ...input, environmentId: environment.id });
          observed++; continue;
        }
        await deps.refresh({ ...input, environmentId: environment.id });
        if (isSavedComputeEnvironment(environment)) {
          // Physical-only legacy recipes never supply inactivity authority.
          // Their actual HEAD may have moved while the allocated app ran;
          // exact stopped/settled reconciliation preserves the old generation.
          await reconcileObservedCompute({ prisma: input.prisma, machineId: input.config.machine, policy: input.config.compute!, environmentId: environment.id, runtime: input.runtime });
          observed++; continue;
        }
        const context = { ...input, taskId: environment.taskId, environmentId: environment.id };
        const projection = await developmentProjection(context);
        const intent = projection.developmentIntent;
        const evidence = await deps.evidence({ ...context, allowStopped: true });
        if (intent?.state === "pending" && intent.reason === "runtime-suspended" && intent.suspension?.environmentId === environment.id
          && evidence.eligible && evidence.snapshotDigest === intent.suspension.snapshotDigest) {
          await deps.continue({ ...context, primarySessionId: environment.primarySessionId, intentRevision: intent.revision, intentDigest: intent.digest });
          await deps.refresh(context);
        } else {
          if (evidence.eligible && evidence.physicalState === "running") {
            const decision = await deps.consider({ ...context, requestKey: `idle:${evidence.snapshotDigest}` });
            if (decision.intent && decision.outcome === "suspension-recorded") {
              await deps.continue({ ...context, primarySessionId: environment.primarySessionId, ...decision.intent });
              await deps.refresh(context);
            }
          }
        }
        await reconcileObservedCompute({ prisma: input.prisma, machineId: input.config.machine, policy: input.config.compute!, environmentId: environment.id, runtime: input.runtime });
        observed++;
      } catch {
        // Metadata only. Existing slots/intent remain reserved on uncertainty;
        // another environment still receives its independent observation.
        unavailable++;
      }
    }
  }));
  await offerNextCompute({ prisma: input.prisma, machineId: input.config.machine, policy: input.config.compute });
  return { observed, unavailable };
}

export function startComputeCollection(input: Context) {
  if (!input.config.compute?.enabled) return async () => {};
  let stopped = false, running: Promise<unknown> | undefined;
  const tick = () => { if (stopped || running) return; running = tickCompute(input).catch(() => {
    console.warn("Compute collection remains unavailable; existing allocations are preserved");
  }).finally(() => { running = undefined; }); };
  const timer = setInterval(tick, Math.max(1000, Math.min(5000, input.config.compute.collectorFreshnessSeconds * 1000 / 3)));
  tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
