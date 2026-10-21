import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { queueInstruction, deliverInstructions } from "../../services/sessions/inbox.ts";
import { changeTaskControl } from "../../services/tasks/control.ts";
import { answerSessionQuestion } from "../../services/sessions/questions.ts";

export const taskSupervisionRoutes = new Hono<AppEnv>();

taskSupervisionRoutes.post("/:taskId/questions/:questionId/answer", async (c) => {
  const parsed = z.object({ answer: z.string().min(1).max(100_000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A nonempty answer is required" }, 400);
  const task = await c.get("prisma").remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!task?.primarySessionId) return c.json({ error: "Task has no primary session" }, 409);
  try { return c.json(await answerSessionQuestion(c.get("prisma"), { sessionId: task.primarySessionId, questionId: c.req.param("questionId"), answer: parsed.data.answer }), 202); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskSupervisionRoutes.get("/:taskId/activity", async (c) => {
  const prisma = c.get("prisma");
  const task = await prisma.remoteTask.findUnique({ where: { id: c.req.param("taskId") }, include: { resources: true } });
  if (!task) return c.json({ error: "Task not found" }, 404);
  const sessionId = task.primarySessionId;
  const runtime = c.get("agentRuntime");
  const [session, history, questions, instructions] = sessionId ? await Promise.all([
    runtime.getSession(sessionId), runtime.history(sessionId),
    prisma.runtimeQuestion.findMany({ where: { runtimeSessionId: sessionId }, orderBy: { createdAt: "asc" } }),
    prisma.runtimeInstruction.findMany({ where: { sessionId }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]) : [null, [], [], []];
  return c.json({ task, session, history, questions, instructions });
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
    void deliverInstructions(prisma, runtime).catch(() => undefined);
    return c.json({ instruction }, 202);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskSupervisionRoutes.post("/:taskId/instructions/:instructionId/resolve", async (c) => {
  const parsed = z.object({ action: z.enum(["acknowledge", "cancel", "retry"]), reason: z.string().min(1).max(2000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Choose a resolution and record the evidence from inspecting session history" }, 400);
  const prisma = c.get("prisma");
  const task = await prisma.remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!task?.primarySessionId) return c.json({ error: "Task has no primary session" }, 409);
  const result = await prisma.runtimeInstruction.updateMany({ where: { id: c.req.param("instructionId"), sessionId: task.primarySessionId, state: "unknown" }, data: { state: { acknowledge: "acknowledged", cancel: "cancelled", retry: "queued" }[parsed.data.action], detail: parsed.data.reason } });
  return result.count ? c.json({ resolved: true }) : c.json({ error: "Instruction is not awaiting resolution" }, 409);
});

taskSupervisionRoutes.post("/:taskId/automation", async (c) => {
  const parsed = z.object({ action: z.enum(["pause", "resume", "close"]) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Choose pause, resume, or close" }, 400);
  const prisma = c.get("prisma"), runtime = c.get("agentRuntime");
  const task = await prisma.remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!task) return c.json({ error: "Task not found" }, 404);
  const controllerId = `task-supervisor:${task.id}`;
  try {
    if (task.controllerId && task.controllerId !== controllerId) throw new Error("Return control from the browser viewer first");
    if (parsed.data.action === "resume") {
      await changeTaskControl(prisma, runtime, { taskId: task.id, controllerId, action: "resume" });
    } else {
      await changeTaskControl(prisma, runtime, { taskId: task.id, controllerId, action: "take" });
      await changeTaskControl(prisma, runtime, { taskId: task.id, controllerId, action: "pause" });
      if (parsed.data.action === "close") {
        if (task.primarySessionId) {
          await runtime.close(task.primarySessionId, "Owner closed task; code, history and retained previews are preserved");
          await prisma.runtimeInstruction.updateMany({ where: { sessionId: task.primarySessionId, state: "queued" }, data: { state: "cancelled", detail: "Task closed by owner" } });
        }
        await prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "closed", recoveryDetail: "Agent closed. Resource cleanup is a separate operation; inspect retained resources." } });
      }
    }
    return c.json({ task: await prisma.remoteTask.findUnique({ where: { id: task.id }, include: { resources: true } }) });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
