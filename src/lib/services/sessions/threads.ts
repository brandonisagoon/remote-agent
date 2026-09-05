import type { PrismaClient } from "../../../generated/prisma/client.ts";

/** Conversation threads live in RuntimeSessionResourceLink: the thread root
    comment is the resource, the owning session holds a live link. Replies in
    a registered thread deliver deterministically — the semantic router runs
    only for new threads. `question` marks a thread whose next human reply
    answers a question the session asked. */
const RESOURCE_TYPE = "comment-thread";

export type ThreadRelationship = "thread" | "question";

export interface ThreadKey {
  provider: string;
  connectionId: string;
  threadRootCommentId: string;
}

export async function registerThread(
  prisma: PrismaClient,
  input: ThreadKey & {
    runtimeSessionId: string;
    relationship?: ThreadRelationship;
  },
): Promise<void> {
  const relationship = input.relationship ?? "thread";
  const now = new Date();
  // A thread belongs to exactly one live session/relationship at a time.
  await prisma.runtimeSessionResourceLink.updateMany({
    where: {
      provider: input.provider,
      connectionId: input.connectionId,
      resourceType: RESOURCE_TYPE,
      externalId: input.threadRootCommentId,
      endedAt: null,
      NOT: { runtimeSessionId: input.runtimeSessionId, relationship },
    },
    data: { endedAt: now },
  });
  const existing = await prisma.runtimeSessionResourceLink.findFirst({
    where: {
      provider: input.provider,
      connectionId: input.connectionId,
      resourceType: RESOURCE_TYPE,
      externalId: input.threadRootCommentId,
      runtimeSessionId: input.runtimeSessionId,
      relationship,
    },
  });
  if (existing) {
    if (existing.endedAt) {
      await prisma.runtimeSessionResourceLink.update({
        where: { id: existing.id },
        data: { endedAt: null },
      });
    }
    return;
  }
  await prisma.runtimeSessionResourceLink.create({
    data: {
      runtimeSessionId: input.runtimeSessionId,
      provider: input.provider,
      connectionId: input.connectionId,
      resourceType: RESOURCE_TYPE,
      externalId: input.threadRootCommentId,
      relationship,
    },
  });
}

export interface ThreadRegistration {
  runtimeSessionId: string;
  relationship: ThreadRelationship;
}

/** Live link joined to a non-closed session, or null. */
export async function findThreadSession(
  prisma: PrismaClient,
  key: ThreadKey,
): Promise<ThreadRegistration | null> {
  const link = await prisma.runtimeSessionResourceLink.findFirst({
    where: {
      provider: key.provider,
      connectionId: key.connectionId,
      resourceType: RESOURCE_TYPE,
      externalId: key.threadRootCommentId,
      endedAt: null,
      runtimeSession: { status: { not: "closed" } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!link) return null;
  return {
    runtimeSessionId: link.runtimeSessionId,
    relationship: link.relationship === "question" ? "question" : "thread",
  };
}

/** The question was answered: the thread stays registered as a plain thread. */
export async function resolveQuestionThread(
  prisma: PrismaClient,
  key: ThreadKey & { runtimeSessionId: string },
): Promise<void> {
  await registerThread(prisma, { ...key, relationship: "thread" });
}

/** Ends a thread registration without touching the session. */
export async function unregisterThread(
  prisma: PrismaClient,
  key: ThreadKey & { runtimeSessionId: string },
): Promise<void> {
  await prisma.runtimeSessionResourceLink.updateMany({
    where: {
      provider: key.provider,
      connectionId: key.connectionId,
      resourceType: RESOURCE_TYPE,
      externalId: key.threadRootCommentId,
      runtimeSessionId: key.runtimeSessionId,
      endedAt: null,
    },
    data: { endedAt: new Date() },
  });
}
