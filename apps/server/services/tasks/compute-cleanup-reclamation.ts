import type { Prisma, RemoteTask, RemoteTaskResource, RuntimeInstruction, RuntimeLifecycleEvent, RuntimeSession } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { hasPreparedCleanup, inspectPreparedCleanupState } from "./cleanup-lifecycle.ts";
import { computeFamilySettled } from "./compute-family.ts";
import { assertDevelopmentWork, DevelopmentWorkUnavailable } from "./development-intent.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";

/** An accepted cleanup may continue recording evidence after its app has
 * gone. Only that original primary may remain busy; every other possible
 * writer must be settled. This is an accounting fence, never stop authority
 * or physical absence proof. The caller must still collect that proof and
 * compare this entire epoch again when settling the allocation. */
export async function releasedComputeCleanupFence(input: {
  prisma: Prisma.TransactionClient; config: ServerConfig; task: RemoteTask; primary: RuntimeSession; resource: RemoteTaskResource;
  sessions: RuntimeSession[]; instructions: RuntimeInstruction[]; lifecycle: RuntimeLifecycleEvent[];
  runtime: Pick<AgentSessionRuntime, "observeSessionActivity">;
}) {
  const { prisma, config, task, primary, resource, sessions, instructions, lifecycle, runtime } = input;
  if (resource.state !== "released" || task.ownerPaused || !runtime.observeSessionActivity) return null;
  const requestKey = `finalize:${task.id}`;
  if (!await hasPreparedCleanup(prisma, task.id, primary.id, requestKey)) return null;
  if (!computeFamilySettled(task, sessions.filter(session => session.id !== primary.id),
    instructions.filter(instruction => instruction.sessionId !== primary.id), lifecycle, runtime)) return null;
  const pending = instructions.filter(instruction => instruction.sessionId === primary.id);
  const activity = runtime.observeSessionActivity(primary.id), latest = lifecycle.find(event => event.runtimeSessionId === primary.id);
  const idle = primary.status === "idle" && activity.state === "unknown" && !pending.length && latest?.phase !== "started";
  const executing = primary.status === "active" && activity.state === "executing" && Boolean(activity.requestId)
    && latest?.phase === "started" && latest.requestId === activity.requestId
    && pending.length === 1 && pending[0]!.state === "dispatching" && pending[0]!.executionRequestId === activity.requestId;
  if (!idle && !executing) return null;
  const active = await inspectPreparedCleanupState({ prisma, config, sessionId: primary.id, requestKey, runtime });
  const original = active.operation.binding.resources.find(value => value.id === resource.id);
  if (!original || original.state === "released" || finalizationResourceIdentity(original).identityDigest !== finalizationResourceIdentity(resource).identityDigest) {
    throw new Error("Compute cleanup does not bind the original released app");
  }
  // The very same guard runs on every start/renewal, including old claimed
  // offers. Explicit return to work invalidates this exception atomically.
  let fenced = false;
  try { await assertDevelopmentWork({ prisma }, task); }
  catch (error) { if (!(error instanceof DevelopmentWorkUnavailable)) throw error; fenced = true; }
  if (!fenced) throw new Error("Compute cleanup no longer prevents an app restart");
  return { operationRevision: active.operationRevision, operationDigest: finalizationDigest(active.operation),
    authorityEpoch: active.authorityEpoch, bindingDigest: finalizationDigest(active.binding) };
}
