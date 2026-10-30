import { TASK_READ_DEADLINE_MS, taskRequest } from "../../middleware/request-lifetime.ts";
import { preparationStage } from "../../services/tasks/preparation-diagnostics.ts";
import { CleanupOperation, assertPreparedCleanup, hasPreparedCleanup } from "../../services/tasks/cleanup-lifecycle.ts";
import { automaticCleanupTurn } from "../../services/tasks/cleanup-inbox.ts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { queueInstruction, deliverInstructions, resolveTaskInstruction } from "../../services/sessions/inbox.ts";
import { answerSessionQuestion } from "../../services/sessions/questions.ts";
import { readTaskActivity } from "../../services/tasks/activity.ts";
import { ProjectionRetryStage, retryTaskRuntimeProjection } from "../../services/sessions/runtime-events/projection-retries.ts";
import { AutomationInput, DevelopmentAuthorityInput, DevelopmentCompleteInput, assertDevelopmentRequest, completeDevelopmentIntent, developmentProjection, recordDevelopmentIntent, renewDevelopmentAuthority } from "../../services/tasks/development-intent.ts";

import { taskResponse } from "./response.ts";

export const taskSupervisionRoutes = new Hono<AppEnv>();

taskSupervisionRoutes.post("/:taskId/development-authority", async c => {
  const parsed = DevelopmentAuthorityInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Use the saved development intent and exact compute keys" }, 400);
  try { return c.json(await renewDevelopmentAuthority({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), taskId: c.req.param("taskId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskSupervisionRoutes.post("/:taskId/development-complete", async c => {
  const parsed = DevelopmentCompleteInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A development completion must match the saved intent and complete compute membership" }, 400);
  try { return c.json({ developmentIntent: await completeDevelopmentIntent({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), taskId: c.req.param("taskId") }) }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

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

taskSupervisionRoutes.get("/:taskId/activity", async (c) => taskRequest(c, TASK_READ_DEADLINE_MS, async () => {
  const result = await preparationStage("activity", () => readTaskActivity(c.get("prisma"), c.get("agentRuntime"), c.req.param("taskId")));
  return result ? c.json(result) : c.json({ error: "Task not found" }, 404);
}));

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
  const parsed = AutomationInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Choose pause, resume, or close" }, 400);
  const prisma = c.get("prisma"), runtime = c.get("agentRuntime");
  const initialTask = await prisma.remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!initialTask) return c.json({ error: "Task not found" }, 404);
  let task = initialTask;
  try {
    let development: { intentRevision: number; intentDigest: string } | undefined;
    if ("requestKey" in parsed.data) {
      development = await recordDevelopmentIntent({ prisma, config: c.get("config"), taskId: task.id, request: parsed.data });
      task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    }
    const responseTask = async () => {
      const response = { ...taskResponse(await prisma.remoteTask.findUnique({ where: { id: task.id }, include: { resources: true } })),
        ...await developmentProjection({ prisma, config: c.get("config"), taskId: task.id }) };
      if (development) await assertDevelopmentRequest({ prisma, config: c.get("config"), taskId: task.id, ...development });
      return response;
    };
    if (development) await assertDevelopmentRequest({ prisma, config: c.get("config"), taskId: task.id, ...development });
    if (parsed.data.action === "stop-development") return c.json({ task: await responseTask() });
    if (parsed.data.action !== "close") {
      if (task.phase === "closed") throw new Error("A closed task cannot be resumed");
      const paused = parsed.data.action === "pause";
      // Persist first: active turns and queued delegates observe the same pause.
      // Explicit intent already changed this atomically with its receipt. An
      // older HTTP continuation must never overwrite a newer owner decision.
      if (!development && task.ownerPaused !== paused) await prisma.remoteTask.update({ where: { id: task.id }, data: { ownerPaused: paused } });
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
          try {
            if (development) await assertDevelopmentRequest({ prisma, config: c.get("config"), taskId: task.id, ...development });
            await runtime.cancel(session.id, "Owner paused task"); return null;
          }
          catch (error) { return { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }; }
        }))).filter(failure => failure !== null);
        // A successful cancellation request does not prove the turn stopped.
        // Re-read terminal state; a retry only targets the remaining live work.
        const pendingSessionIds = (await liveSessions()).map(session => session.id);
        const pause = { state: pendingSessionIds.length ? "pending" : "paused", attemptedSessionIds: sessions.map(session => session.id), pendingSessionIds, failures };
        const current = await responseTask();
        if (failures.length) return c.json({ task: current, pause,
          error: `Task remains owner-paused. Cancellation failed: ${failures.map(failure => `${failure.sessionId}: ${failure.error}`).join("; ")}. Pending sessions: ${pendingSessionIds.join(", ") || "none"}.`,
        }, development ? 202 : 409);
        return c.json({ task: current, pause }, pendingSessionIds.length ? 202 : 200);
      }
      return c.json({ task: await responseTask() });
    }
    // Stop new deliveries before cancelling current work, including delegates.
    await prisma.$transaction(async tx => {
      // Closing an automatic cleanup turn must not cancel a follow-up that
      // arrived after confirmation. Claim closure against the same local inbox
      // transaction; ordinary explicit owner close remains unchanged.
      if ("cleanup" in parsed.data && parsed.data.cleanup && task.primarySessionId && task.phase !== "closed") {
        const operation = await hasPreparedCleanup(tx, task.id, task.primarySessionId, `finalize:${task.id}`);
        const automatic = operation && CleanupOperation.parse(JSON.parse(operation.value!)).automatic;
        const current = await tx.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
        const executing = await automaticCleanupTurn(tx, current, Boolean(automatic), runtime);
        if (executing) await assertPreparedCleanup({ prisma: tx, config: c.get("config"), sessionId: task.primarySessionId, requestKey: `finalize:${task.id}`, runtime });
      }
      await tx.remoteTask.update({ where: { id: task.id }, data: { phase: "closed", recoveryDetail: "Agent closed. Resource cleanup is a separate operation; inspect retained resources." } });
    });
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
