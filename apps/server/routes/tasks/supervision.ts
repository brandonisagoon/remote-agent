import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { queueInstruction, deliverInstructions, resolveTaskInstruction } from "../../services/sessions/inbox.ts";
import { answerSessionQuestion } from "../../services/sessions/questions.ts";
import { readTaskActivity } from "../../services/tasks/activity.ts";
import { ProjectionRetryStage, retryTaskRuntimeProjection } from "../../services/sessions/runtime-events/projection-retries.ts";

import { taskResponse } from "./response.ts";

export const taskSupervisionRoutes = new Hono<AppEnv>();

taskSupervisionRoutes.post("/:taskId/projection-retries", async (c) => {
  const parsed = z.object({ sessionId: z.string().min(1).max(200), eventId: z.string().min(1).max(500), stage: ProjectionRetryStage,
    requestKey: z.string().min(1).max(200), reason: z.string().trim().min(1).max(2000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Identify the exhausted delivery and record an explicit recovery reason" }, 400);
  try { return c.json(await retryTaskRuntimeProjection(c.get("prisma"), { taskId: c.req.param("taskId"), ...parsed.data }), 202); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskSupervisionRoutes.post("/:taskId/questions/:questionId/answer", async (c) => {
  const parsed = z.object({ answer: z.string().min(1).max(100_000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A nonempty answer is required" }, 400);
  const task = await c.get("prisma").remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!task?.primarySessionId) return c.json({ error: "Task has no primary session" }, 409);
  try { return c.json(await answerSessionQuestion(c.get("prisma"), { sessionId: task.primarySessionId, questionId: c.req.param("questionId"), answer: parsed.data.answer }), 202); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskSupervisionRoutes.get("/:taskId/activity", async (c) => {
  const result = await readTaskActivity(c.get("prisma"), c.get("agentRuntime"), c.req.param("taskId"));
  return result ? c.json(result) : c.json({ error: "Task not found" }, 404);
});

taskSupervisionRoutes.post("/:taskId/instructions", async (c) => {
  const parsed = z.object({ requestKey: z.string().min(1).max(200), text: z.string().min(1).max(100_000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A stable requestKey and instruction text are required" }, 400);
  const prisma = c.get("prisma");
  const task = await prisma.remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!task?.primarySessionId) return c.json({ error: "Task has no primary session" }, 409);
  const runtime = c.get("agentRuntime");
  const session = await runtime.getSession(task.primarySessionId);
  if (!session || session.status === "closed") return c.json({ error: "Session is unavailable or closed" }, 409);
  try {
    const instruction = await queueInstruction(prisma, { sessionId: session.id, requestId: `task:${task.id}:${parsed.data.requestKey}`, text: parsed.data.text });
    void deliverInstructions(prisma, runtime, c.get("config")).catch(() => undefined);
    return c.json({ instruction }, 202);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskSupervisionRoutes.post("/:taskId/instructions/:instructionId/resolve", async (c) => {
  const parsed = z.object({ action: z.enum(["acknowledge", "cancel", "retry"]), reason: z.string().trim().min(1).max(2000), requestKey: z.string().min(1).max(200).optional() }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Choose a resolution and record the evidence from inspecting session history" }, 400);
  const prisma = c.get("prisma");
  try {
    const result = await resolveTaskInstruction(prisma, c.get("agentRuntime"), { taskId: c.req.param("taskId"), instructionId: c.req.param("instructionId"), ...parsed.data });
    return c.json(result);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

// Owner pause/resume is independent of browser viewing.
taskSupervisionRoutes.post("/:taskId/automation", async (c) => {
  const parsed = z.object({ action: z.enum(["pause", "resume", "close"]) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Choose pause, resume, or close" }, 400);
  const prisma = c.get("prisma"), runtime = c.get("agentRuntime");
  const task = await prisma.remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!task) return c.json({ error: "Task not found" }, 404);
  try {
    if (parsed.data.action !== "close") {
      if (task.phase === "closed") throw new Error("A closed task cannot be resumed");
      const paused = parsed.data.action === "pause";
      // Persist first: active turns and queued delegates observe the same pause.
      if (task.ownerPaused !== paused) await prisma.remoteTask.update({ where: { id: task.id }, data: { ownerPaused: paused } });
      if (paused) {
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
          try { await runtime.cancel(session.id, "Owner paused task"); return null; }
          catch (error) { return { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }; }
        }))).filter(failure => failure !== null);
        // A successful cancellation request does not prove the turn stopped.
        // Re-read terminal state; a retry only targets the remaining live work.
        const pendingSessionIds = (await liveSessions()).map(session => session.id);
        const pause = { state: pendingSessionIds.length ? "pending" : "paused", attemptedSessionIds: sessions.map(session => session.id), pendingSessionIds, failures };
        const current = taskResponse(await prisma.remoteTask.findUnique({ where: { id: task.id }, include: { resources: true } }));
        if (failures.length) return c.json({ task: current, pause,
          error: `Task remains owner-paused. Cancellation failed: ${failures.map(failure => `${failure.sessionId}: ${failure.error}`).join("; ")}. Pending sessions: ${pendingSessionIds.join(", ") || "none"}.`,
        }, 409);
        return c.json({ task: current, pause }, pendingSessionIds.length ? 202 : 200);
      }
      return c.json({ task: taskResponse(await prisma.remoteTask.findUnique({ where: { id: task.id }, include: { resources: true } })) });
    }
    // Stop new deliveries before cancelling current work, including delegates.
    await prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "closed", recoveryDetail: "Agent closed. Resource cleanup is a separate operation; inspect retained resources." } });
    if (task.worktreePath) {
      const sessions = await runtime.listSessions({ cwd: task.worktreePath });
      for (const session of sessions) {
        if (session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) continue;
        await runtime.close(session.id, "Owner closed task; code, history and retained previews are preserved");
        await prisma.runtimeInstruction.updateMany({ where: { sessionId: session.id, state: "queued" }, data: { state: "cancelled", detail: "Task closed by owner" } });
      }
    }
    return c.json({ task: taskResponse(await prisma.remoteTask.findUnique({ where: { id: task.id }, include: { resources: true } })) });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
