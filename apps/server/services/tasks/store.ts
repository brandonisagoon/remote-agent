import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { RepositoryConfig } from "../../../../lib/config.ts";

export async function beginTask(prisma: PrismaClient, input: {
  requestKey: string; repository: RepositoryConfig; machineId: string;
  connectionId?: string; issueIdentifier?: string; branchName: string;
}) {
  const { repository, ...identity } = input;
  if (!repository.tooling) throw new Error("Managed tasks require a pinned tooling source");
  const task = await prisma.remoteTask.upsert({
    where: { requestKey: input.requestKey },
    update: {},
    create: { ...identity, repositoryId: repository.id, toolingRoot: repository.tooling.root, toolingRevision: repository.tooling.revision },
  });
  if (task.repositoryId !== repository.id || task.machineId !== input.machineId || task.branchName !== input.branchName || task.connectionId !== (input.connectionId ?? null) || task.issueIdentifier !== (input.issueIdentifier ?? null)) {
    throw new Error("Task request key already belongs to a different launch");
  }
  return task;
}

export async function taskForSession(prisma: PrismaClient, sessionId: string) {
  const primary = await prisma.remoteTask.findUnique({ where: { primarySessionId: sessionId }, include: { resources: true } });
  if (primary) return primary;
  const session = await prisma.runtimeSession.findUnique({ where: { id: sessionId }, select: { cwd: true } });
  return session ? prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd }, include: { resources: true } }) : null;
}
