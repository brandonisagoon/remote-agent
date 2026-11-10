import type { RemoteTask, RuntimeInstruction, RuntimeLifecycleEvent, RuntimeSession, RuntimeSessionRelation, RuntimeSessionResourceLink } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";

/** Accounting only. A durable queue is not executing work when the same
 * task/cwd fence checked by inbox dispatch prevents it from starting. Moved
 * descendants do not inherit that fence. Uncertain or previously dispatched
 * instructions, active providers and unmatched starts still refuse. */
export function computeFamilySettled(task: RemoteTask, sessions: RuntimeSession[], instructions: RuntimeInstruction[],
  lifecycle: Array<RuntimeLifecycleEvent | null>, runtime: Pick<AgentSessionRuntime, "observeSessionActivity">) {
  if (instructions.length && !runtime.observeSessionActivity) return false;
  const fenced = task.ownerPaused || task.phase === "closed";
  if (instructions.some(instruction => {
    const session = sessions.find(value => value.id === instruction.sessionId);
    return instruction.state !== "queued" || instruction.executionRequestId !== null || !fenced
      || !session || session.cwd !== task.worktreePath;
  })) return false;
  return sessions.every(session => (["idle", "closed"].includes(session.status)
      || fenced && session.cwd === task.worktreePath && session.status === "error")
    && (!runtime.observeSessionActivity || runtime.observeSessionActivity(session.id).state === "unknown")
    && (session.closedAt || lifecycle.find(event => event?.runtimeSessionId === session.id)?.phase !== "started"));
}

/** The generic canonical digest treats Date objects as objects. Bind these
 * revisions explicitly so a pause/resume or queue update cannot disappear
 * from the before/after accounting snapshot. */
export function computeFamilyGeneration(task: RemoteTask, sessions: RuntimeSession[], instructions: RuntimeInstruction[]) {
  return { task: task.updatedAt.toISOString(), sessions: sessions.map(value => [value.id, value.updatedAt.toISOString()]),
    instructions: instructions.map(value => [value.id, value.updatedAt.toISOString()]) };
}

/** Stable ownership for an explicitly adopted read-only historical checker.
 * Activity is checked separately on every collection; it is never frozen as
 * an assertion that this family will remain stopped. */
export function computeAccountingOwnership(task: RemoteTask, sessions: RuntimeSession[], relations: RuntimeSessionRelation[], links: RuntimeSessionResourceLink[]) {
  return { task: { id: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId,
    connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, worktreePath: task.worktreePath, branchName: task.branchName,
    baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot },
  sessions: sessions.map(session => ({ id: session.id, machineId: session.machineId, repositoryId: session.repositoryId, cwd: session.cwd, role: session.role })),
  relations: relations.map(relation => ({ id: relation.id, sourceSessionId: relation.sourceSessionId, targetSessionId: relation.targetSessionId, relationship: relation.relationship })),
  links: links.filter(link => link.relationship === "handles").map(link => ({ id: link.id, runtimeSessionId: link.runtimeSessionId, provider: link.provider,
    connectionId: link.connectionId, resourceType: link.resourceType, externalId: link.externalId, relationship: link.relationship })) };
}
