import { assertNativeLaunch } from "../launches/native-takeover.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { RepositoryConfig } from "../../../../lib/config.ts";
import type { ToolingReleaseSelection } from "../../../../types/tooling-release.ts";

/** A new task records the active release (when one exists) as its initial
 * audit pin; an existing task's pin is never rewritten by a later launch. */
export async function beginTask(prisma: PrismaClient, input: {
  requestKey: string; repository: RepositoryConfig; machineId: string;
  connectionId?: string; issueIdentifier?: string; branchName: string;
  requestFingerprint?: string; selection?: ToolingReleaseSelection | null;
}) {
  const { repository, selection, ...identity } = input;
  if (!repository.tooling) throw new Error("Managed tasks require a pinned tooling source");
  if (selection && (selection.repositoryId !== repository.id || selection.release.repositoryId !== repository.id)) throw new Error("Active tooling selection belongs to another repository");
  const tooling = { root: repository.tooling.root, revision: selection?.release.revision ?? repository.tooling.revision };
  const task = await prisma.$transaction(async tx => {
    if (input.connectionId && input.issueIdentifier) await assertNativeLaunch(tx, { connectionId: input.connectionId, repositoryId: repository.id, issueIdentifier: input.issueIdentifier }, input.requestKey);
    return tx.remoteTask.upsert({
      where: { requestKey: input.requestKey },
      update: {},
      create: { ...identity, repositoryId: repository.id, toolingRoot: tooling.root, toolingRevision: tooling.revision },
    });
  });
  if (task.repositoryId !== repository.id || task.machineId !== input.machineId || task.branchName !== input.branchName || task.connectionId !== (input.connectionId ?? null) || task.issueIdentifier !== (input.issueIdentifier ?? null)) {
    throw new Error("Task request key already belongs to a different launch");
  }
  if (input.requestFingerprint && task.requestFingerprint !== input.requestFingerprint) {
    throw new Error("Task request key has different or unverifiable launch content; inspect the existing task before continuing it");
  }
  return task;
}

export async function taskForSession(prisma: PrismaClient, sessionId: string) {
  const primary = await prisma.remoteTask.findUnique({ where: { primarySessionId: sessionId }, include: { resources: true } });
  if (primary) return primary;
  const session = await prisma.runtimeSession.findUnique({ where: { id: sessionId }, select: { cwd: true } });
  return session ? prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd }, include: { resources: true } }) : null;
}
