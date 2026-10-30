import type { PrismaClient, RuntimeSourceMessage, RuntimeMessageControl } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { sourceReplyInstructions } from "./source-messages.ts";

const delivering = new WeakSet<AgentSessionRuntime>();

/** Native steering is an optional runtime capability. This promotes the same
 * durable instruction, rather than making a second copy of a queued comment. */
export async function deliverMessageControls(prisma: PrismaClient, runtime: AgentSessionRuntime, authorize?: (message: RuntimeSourceMessage) => Promise<unknown>) {
  if (delivering.has(runtime)) return;
  delivering.add(runtime);
  try {
    const interrupted = await prisma.runtimeMessageControl.findMany({ where: { state: { in: ["sending", "applied"] } } });
    for (const control of interrupted) {
      if (control.state === "applied") {
        const source = control.sourceMessageId ? await prisma.runtimeSourceMessage.findUnique({ where: { id: control.sourceMessageId } }) : null;
        if (source && ["handled", "failed", "attention"].includes(source.state)) {
          await prisma.runtimeMessageControl.updateMany({ where: { id: control.id, state: "applied" }, data: { state: "settled" } });
          continue;
        }
        if (source?.state !== "processing" || !source.sessionId || !source.targetRequestId) continue;
        const activity = runtime.observeSessionActivity?.(source.sessionId);
        if (activity?.state === "executing" && activity.requestId === source.targetRequestId) continue;
        if (await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: source.sessionId, requestId: source.targetRequestId, phase: { in: ["completed", "failed", "cancelled"] } } })) continue;
      }
      await prisma.$transaction(async (tx) => {
        await tx.runtimeMessageControl.update({ where: { id: control.id }, data: { state: "unknown", noticeBody: "Steering delivery was interrupted and its outcome is unknown. It will not be sent again automatically." } });
        if (control.sourceMessageId) {
          await tx.runtimeInstruction.updateMany({ where: { sourceMessageId: control.sourceMessageId, state: { in: ["steering", "steered"] } }, data: { state: "unknown" } });
          await tx.runtimeSourceMessage.update({ where: { id: control.sourceMessageId }, data: { state: "unknown", projectionPending: true } });
        }
      });
    }
    let cursor: { createdAt: Date; id: string } | null = null;
    while (true) {
    const pending: RuntimeMessageControl[] = await prisma.runtimeMessageControl.findMany({ where: { state: "pending", ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
    if (!pending.length) break;
    for (const control of pending) {
      cursor = { createdAt: control.createdAt, id: control.id };
      const message = await prisma.runtimeSourceMessage.findFirst({ where: { provider: control.provider, connectionId: control.connectionId,
        repositoryId: control.repositoryId, machineId: control.machineId, commentId: control.commentId, authorId: control.authorId }, orderBy: { sequence: "desc" } });
      if (!message) continue;
      if (!message.sessionId) {
        if (message.state === "unrouted") await prisma.runtimeMessageControl.update({ where: { id: control.id }, data: { state: "rejected", sourceMessageId: message.id } });
        continue;
      }
      const instruction = await prisma.runtimeInstruction.findUnique({ where: { sourceMessageId: message.id } });
      const finish = (state: string, noticeBody?: string) => prisma.runtimeMessageControl.update({ where: { id: control.id }, data: { state, sourceMessageId: message.id, noticeBody: noticeBody ?? null } });
      if (!instruction || instruction.state !== "queued") { await finish(instruction?.state === "unknown" ? "unknown" : "noop", instruction?.state === "unknown"
        ? "This comment has an uncertain delivery outcome. Steering will not resend it; inspect the session before resolving it."
        : "This comment is already being handled or has a delivery outcome; steering did not inject it again."); continue; }
      const session = await runtime.getSession(message.sessionId);
      const task = session ? await prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd } }) : null;
      if (!session || session.status === "closed" || session.role !== "primary" || session.machineId !== message.machineId || session.repositoryId !== message.repositoryId || task?.phase === "closed") {
        await finish("rejected", "This comment's owning session is no longer eligible for steering."); continue;
      }
      // Pausing retains queued owner input. Do not promote it while the
      // provider's cancellation of the previous turn is still settling.
      if (task?.ownerPaused) continue;
      try { await authorize?.(message); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "source_ownership_revoked") await finish("rejected", "This comment is no longer owned by the selected task; steering was not sent.");
        continue;
      }
      const activity = runtime.observeSessionActivity?.(session.id);
      if (activity?.state !== "executing" || !activity.requestId) {
        // Normal delivery will claim the original instruction when idle.
        await finish("idle", "There is no confirmed active turn to steer. This comment remains queued for its normal turn."); continue;
      }
      let claimed = false;
      try {
        const result = runtime.steer ? await runtime.steer({ sessionId: session.id, requestId: control.id, targetRequestId: activity.requestId,
          text: instruction.text + sourceReplyInstructions(message.id), beforeSend: async () => {
            const accepted = await prisma.$transaction(async (tx) => {
            const current = await tx.runtimeSession.findUnique({ where: { id: session.id } });
            const currentTask = await tx.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
            if (current?.status !== "active" || current.role !== "primary" || currentTask?.ownerPaused || currentTask?.phase === "closed") return false;
            const claim = await tx.runtimeInstruction.updateMany({ where: { id: instruction.id, state: "queued" }, data: { state: "steering", executionRequestId: control.id } });
            if (!claim.count) return false;
            await tx.runtimeMessageControl.update({ where: { id: control.id }, data: { state: "sending", sourceMessageId: message.id } });
            await tx.runtimeSourceMessage.update({ where: { id: message.id }, data: { targetRequestId: activity.requestId, requestId: control.id } });
            return true;
          });
          claimed = accepted;
          return accepted;
        } }) : { status: "unsupported" as const };
        if (result.status === "applied") {
          if (!claimed) throw new Error("Runtime did not claim the steering instruction");
          await prisma.$transaction(async (tx) => {
            await tx.runtimeInstruction.update({ where: { id: instruction.id }, data: { state: "steered" } });
            await tx.runtimeMessageControl.update({ where: { id: control.id }, data: { state: "applied" } });
            const terminal = await tx.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id, requestId: activity.requestId, phase: { in: ["completed", "cancelled", "failed"] } } });
            await tx.runtimeSourceMessage.update({ where: { id: message.id }, data: { state: terminal ? terminal.phase === "completed" ? "handled" : "attention" : "processing", projectionPending: true } });
          });
        } else {
          if (claimed) {
            // The runtime's idle/unsupported response guarantees no send occurred.
            await prisma.runtimeInstruction.updateMany({ where: { id: instruction.id, state: "steering" }, data: { state: "queued", executionRequestId: null } });
            await prisma.runtimeSourceMessage.update({ where: { id: message.id }, data: { requestId: null, targetRequestId: null, state: "queued", projectionPending: true } });
          }
          await finish(result.status, result.status === "unsupported"
            ? "This runtime does not support confirmed active-turn steering. Your comment remains queued and will be handled normally."
            : "The active turn ended before steering. Your comment remains queued for its normal turn.");
        }
      } catch {
        await finish(claimed ? "unknown" : "pending", claimed ? "Steering was attempted but not confirmed. Automatic replay is disabled; inspect the session before retrying." : undefined);
        if (claimed) {
          await prisma.runtimeInstruction.updateMany({ where: { id: instruction.id, state: "steering" }, data: { state: "unknown" } });
          await prisma.runtimeSourceMessage.update({ where: { id: message.id }, data: { state: "unknown", projectionPending: true } });
        }
      }
    }
    }
  } finally { delivering.delete(runtime); }
}
