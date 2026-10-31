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
  // Include direct delegates even if their cwd or relation later changed; an
  // active writer cannot disappear from this guard through metadata movement.
  const family = await prisma.runtimeSession.findMany({ where: { OR: [
    { id: primary.id },
    { cwd: task.worktreePath!, repositoryId: task.repositoryId, machineId: task.machineId },
    { outgoingRelations: { some: { targetSessionId: primary.id, relationship: "spawned-by" } } },
  ] }, take: 2001 });
  if (family.length > 2000 || family.some(session => !["idle", "closed"].includes(session.status)
    || runtime?.observeSessionActivity && runtime.observeSessionActivity(session.id).state !== "unknown")) {
    throw new Error("Closed cleanup waits for the original task family to stop executing");
  }
  if (await prisma.runtimeInstruction.count({ where: { sessionId: { in: family.map(session => session.id) }, state: { in: ["preparing", "queued", "dispatching", "unknown"] } } })) {
    throw new Error("Closed cleanup preserves unresolved task-family instructions");
  }
}
