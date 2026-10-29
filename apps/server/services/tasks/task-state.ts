import type { PrismaClient } from "../../../../generated/prisma/client.ts";

export async function assertTaskOpen(prisma: PrismaClient, cwd: string): Promise<void> {
  const task = await prisma.remoteTask.findUnique({ where: { worktreePath: cwd }, select: { phase: true, ownerPaused: true } });
  if (task && (task.ownerPaused || task.phase === "closed")) throw new Error("Task is paused or closed");
}
