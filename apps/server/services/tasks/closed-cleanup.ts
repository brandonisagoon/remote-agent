import type { PrismaClient, RemoteTask, RuntimeSession } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";

type Store = Pick<PrismaClient, "runtimeSession" | "runtimeInstruction">;

/** Closure grants no cleanup authority. This only permits the original saved
 * operation to be checked after its coding family has actually settled. Full
 * preparation, resource identity, retention and owner revocation checks still
 * run on every renewal. No session or instruction is created or reopened. */
export async function assertClosedCleanupFamily(prisma: Store, task: RemoteTask, primary: RuntimeSession,
  operation: { occurredAt: Date } | null, runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">) {
  const closedAt = primary.closedAt?.getTime();
  if (task.phase !== "closed" || !Number.isFinite(closedAt) || !operation || !Number.isFinite(operation.occurredAt.getTime())
    || operation.occurredAt.getTime() > closedAt! || primary.id !== task.primarySessionId || !["closed", "idle"].includes(primary.status)) {
    throw new Error("Closed cleanup requires the original operation recorded before settled primary closure");
  }
  const family = await cleanupFamily(prisma, task, primary.id);
  if (family.some(session => !["idle", "closed"].includes(session.status)
    || runtime?.observeSessionActivity && runtime.observeSessionActivity(session.id).state !== "unknown")) {
    throw new Error("Closed cleanup waits for the original task family to stop executing");
  }
  if (await prisma.runtimeInstruction.count({ where: { sessionId: { in: family.map(session => session.id) }, state: { in: ["preparing", "queued", "dispatching", "unknown"] } } })) {
    throw new Error("Closed cleanup preserves unresolved task-family instructions");
  }
}

/** Shared bounded ownership inventory; no activity or effect permission. */
export async function cleanupFamily(prisma: Pick<PrismaClient, "runtimeSession">, task: RemoteTask, primaryId: string) {
  // Keep same-worktree writers and every original spawned descendant, even
  // after cwd movement or relation closure. Traverse only this primary's graph;
  // cycles/ambiguous ancestry and excessive depth or size refuse conservatively.
  const family = await prisma.runtimeSession.findMany({ where: { OR: [
    { id: primaryId },
    { cwd: task.worktreePath!, repositoryId: task.repositoryId, machineId: task.machineId },
  ] }, take: 2001 });
  const members = new Set(family.map(session => session.id)), descendants = new Set([primaryId]);
  let frontier = [primaryId], depth = 0;
  while (frontier.length) {
    if (++depth > 64 || members.size > 2000) throw new Error("Closed cleanup family exceeds its observation bound");
    const children = await prisma.runtimeSession.findMany({ where: { outgoingRelations: { some: { targetSessionId: { in: frontier }, relationship: "spawned-by" } } }, take: 2001 });
    frontier = [];
    for (const child of children) {
      if (descendants.has(child.id)) throw new Error("Closed cleanup descendant ancestry is cyclic or ambiguous");
      descendants.add(child.id); frontier.push(child.id);
      if (!members.has(child.id)) { members.add(child.id); family.push(child); }
      if (members.size > 2000) throw new Error("Closed cleanup family exceeds its observation bound");
    }
  }
  if (family.length > 2000) throw new Error("Closed cleanup family exceeds its observation bound");
  return family;
}
