import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { reconcileObservedCompute, scheduleComputeOffers } from "./compute-admission.ts";
import { refreshComputeObservation, computeEvidenceState } from "./compute-observation.ts";
import { considerIdleComputeSuspension } from "./compute-suspension.ts";
import { developmentProjection } from "./development-intent.ts";
import { operationEnvironment, verifiedComputeRuntime } from "./compute-observer.ts";
import { bindServerContinuation } from "./tooling-operations.ts";
import { canonicalDigest } from "./tooling-releases.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { reclaimStoppedCompute } from "./compute-reclamation.ts";
import { isSavedComputeEnvironment } from "./compute-saved-resource.ts";
import { reconcileClosedTaskFamily } from "./closure-recovery.ts";

/** Executing a recorded suspension continues the existing group with its own
 * code: the producer's release (bound once per environment/intent, so a retry
 * or unknown outcome reuses it), or the group's retained first-bootstrap
 * snapshot without a binding. Pre-protocol repositories keep the configured
 * revision. Nothing here installs tooling or selects a newer release. */
async function continueSuspension(input: Context & { taskId: string; primarySessionId: string; environmentId: string; intentRevision: number; intentDigest: string }, bind = bindServerContinuation) {
  const reference = { intentRevision: input.intentRevision, intentDigest: input.intentDigest };
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (task.primarySessionId !== input.primarySessionId) throw new Error("Compute continuation primary changed");
  // A command fence derived from the group's retained reader; the adapter's
  // child callbacks (development intent, resources) inherit its release.
  const command = computeContinueInput(input.taskId, reference, input.environmentId);
  const { binding, code } = await bind({ prisma: input.prisma, config: input.config, task, environmentId: input.environmentId, request: { requestKey: `compute-continue:${input.environmentId}:${input.intentRevision}`, inputDigest: command.inputDigest } });
  const runtime = await verifiedComputeRuntime({ ...input, sessionId: input.primarySessionId, development: reference, release: code, install: false });
  await executeOwnedObserver([process.execPath, "--no-env-file", runtime.adapterPath, "compute", "continue", "--socket", input.config.controlIpcPath, "--task", input.taskId], {
    // Bound process context the release-aware adapter reads for its callbacks.
    cwd: runtime.receipt.checkout, env: operationEnvironment(binding, input.config.controlIpcPath),
    timeoutMs: 60_000, input: command.stdin,
  });
  if (runtime.before !== await runtime.checked()) throw new Error("Compute runtime changed during continuation");
}
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime };
const defaults = { refresh: refreshComputeObservation, evidence: computeEvidenceState, consider: considerIdleComputeSuspension, continue: continueSuspension, reclaim: reclaimStoppedCompute, settle: reconcileClosedTaskFamily };

/** A bounded host collector uses the configured immutable runtime capability.
 * It never asks an agent to invent a stop, nor treats an observation failure as
 * idle. Every adapter effect renews the existing scoped development intent. */
/** The exact spawned `compute continue` input and the digest the adapter's
 * cliInputDigest computes for it, including the CLI's effective parser
 * defaults; a retained continuation fence must carry this exact digest. */
export function computeContinueInput(taskId: string, reference: { intentRevision: number; intentDigest: string }, environmentId: string) {
  const stdin = JSON.stringify({ ...reference, environmentId });
  return { stdin, inputDigest: canonicalDigest({ operation: "compute continue", taskId, positionals: ["compute", "continue"], options: { purpose: "development", task: taskId }, files: {},
    stdin: createHash("sha256").update(stdin).digest("hex") }) };
}
export { continueSuspension as continueComputeSuspension };
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
        if (task.phase === "closed" && !task.ownerPaused) {
          const closure = await deps.settle({ prisma: input.prisma, runtime: input.runtime, machineId: input.config.machine, taskId: task.id });
          if (closure.state === "pending") throw new Error(closure.reason);
        }
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
        // A freshly observed app may become eligible before any earlier tick
        // advanced its claim to running. Preserve that physical transition
        // before stopping, so a real stop can settle the same allocation.
        if (evidence.physicalState === "running") await reconcileObservedCompute({ prisma: input.prisma, machineId: input.config.machine,
          policy: input.config.compute!, environmentId: environment.id, runtime: input.runtime });
        if (intent?.state === "pending" && intent.reason === "runtime-suspended" && intent.suspension?.environmentId === environment.id
          && evidence.eligible && evidence.snapshotDigest === intent.suspension.snapshotDigest) {
          await deps.continue({ ...context, primarySessionId: environment.primarySessionId, intentRevision: intent.revision, intentDigest: intent.digest });
          await deps.refresh(context);
        } else {
          if (evidence.eligible && evidence.physicalState === "running") {
            const decision = await deps.consider({ ...context, requestKey: `idle:${evidence.snapshotDigest}` });
            if (decision?.intent && decision.outcome === "suspension-recorded") {
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
  await scheduleComputeOffers({ prisma: input.prisma, machineId: input.config.machine, policy: input.config.compute, config: input.config, runtime: input.runtime });
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
