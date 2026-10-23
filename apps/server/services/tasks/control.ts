import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";

export async function assertTaskAutomationAllowed(prisma: PrismaClient, cwd: string): Promise<void> {
  const task = await prisma.remoteTask.findUnique({ where: { worktreePath: cwd }, select: { controlMode: true } });
  if (task && task.controlMode !== "agent") throw new Error(`Task automation is ${task.controlMode}; explicit human resume is required`);
}

/** Blocks new turns before cancelling active ones. The human receives a
 * control grant only after every session in the task's worktree is idle. */
export async function changeTaskControl(prisma: PrismaClient, runtime: AgentSessionRuntime, input: {
  taskId: string; controllerId: string; action: "take" | "pause" | "resume";
}) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (task.controllerId && task.controllerId !== input.controllerId) throw new Error("Another viewer owns task control");
  if (input.action !== "take") {
    if (task.controllerId !== input.controllerId) throw new Error("This viewer has no control lease");
    const changed = await prisma.remoteTask.updateMany({ where: { id: task.id, controlGeneration: task.controlGeneration, controllerId: input.controllerId }, data: {
      controlMode: input.action === "resume" ? "agent" : "paused",
      controllerId: input.action === "resume" ? null : input.controllerId,
      controlGeneration: { increment: 1 },
    } });
    if (!changed.count) throw new Error("Control changed; refresh before retrying");
    return prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
  }
  if (task.controlMode === "human") return task;
  const claimed = await prisma.remoteTask.updateMany({ where: { id: task.id, controlGeneration: task.controlGeneration }, data: { controlMode: "draining", controllerId: input.controllerId, controlGeneration: { increment: 1 } } });
  if (!claimed.count) throw new Error("Control changed; refresh before retrying");
  if (task.worktreePath) {
    const sessions = await runtime.listSessions({ cwd: task.worktreePath });
    for (const session of sessions) {
      if (session.cwd === task.worktreePath && session.status === "active") await runtime.cancel(session.id, "Human requested task browser control");
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await runtime.listSessions({ cwd: task.worktreePath });
      if (!current.some((session) => session.cwd === task.worktreePath && session.status === "active")) break;
      if (attempt === 49) throw new Error("Still waiting for agent work to stop; control remains pending");
      await Bun.sleep(100);
    }
  }
  const granted = await prisma.remoteTask.updateMany({ where: { id: task.id, controlMode: "draining", controllerId: input.controllerId, controlGeneration: task.controlGeneration + 1 }, data: { controlMode: "human" } });
  if (!granted.count) throw new Error("Control request was superseded");
  return prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
}

export async function reconcileTaskControls(prisma: PrismaClient): Promise<void> {
  await prisma.remoteTask.updateMany({ where: { controlMode: { in: ["human", "draining"] } }, data: { controlMode: "paused", controlGeneration: { increment: 1 } } });
}
