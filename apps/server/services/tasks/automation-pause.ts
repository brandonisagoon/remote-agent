import type { RemoteTask } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";

/** Shared owner-pause cancellation/recheck. The caller persists pause first.
 * Never infer stopped work merely from accepted cancellation. */
export async function pauseTaskFamily(task: RemoteTask, runtime: AgentSessionRuntime, assertCurrent: () => Promise<void> = async () => {}) {
  const liveSessions = async () => task.worktreePath ? (await runtime.listSessions({ cwd: task.worktreePath })).filter(session => {
    if (session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || session.status === "closed") return false;
    if (session.status === "active" || session.status === "provisioning") return true;
    const observed = runtime.observeSessionActivity?.(session.id).state;
    return observed === "executing" || observed === "queued";
  }) : [];
  const sessions = await liveSessions();
  // Cancellation may fail or wait for a provider receipt. Start every
  // owned session independently so neither case leaves delegates running.
  const failures = (await Promise.all(sessions.map(async session => {
    try {
      await assertCurrent();
      await runtime.cancel(session.id, "Owner paused task"); return null;
    }
    catch (error) { return { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }; }
  }))).filter(failure => failure !== null);
  // A successful cancellation request does not prove the turn stopped.
  // Re-read terminal state; a retry only targets the remaining live work.
  const pendingSessionIds = (await liveSessions()).map(session => session.id);
  return { state: pendingSessionIds.length ? "pending" as const : "paused" as const, attemptedSessionIds: sessions.map(session => session.id), pendingSessionIds, failures };
}
