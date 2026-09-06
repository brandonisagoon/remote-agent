import type { PrismaClient } from "../../../../generated/prisma/client.ts";

const UNIQUE_VIOLATION = "P2002";

interface SessionMirrorInput {
  sessionKey: string;
  externalId: string;
  externalRef?: string | null;
  machineId?: string | null;
  lastEventId?: string | null;
  lastGeneration?: number | bigint | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function generation(value: SessionMirrorInput["lastGeneration"]): bigint | null {
  return value == null ? null : BigInt(value);
}

export function findSessionMirrorBySessionKey(
  prisma: PrismaClient,
  query: { sessionKey: string },
) {
  return prisma.sessionMirror.findUnique({
    where: { sessionKey: query.sessionKey },
  });
}

/**
 * Claim the canonical provider-side mirror for a session. The update branch
 * intentionally preserves the existing mirror identity: a concurrent creator
 * must observe the winner rather than replace it with its own resource.
 */
export async function upsertSessionMirror(
  prisma: PrismaClient,
  input: SessionMirrorInput,
) {
  const runtime = { machineId: input.machineId ?? null };
  const eventUpdate = {
    ...(input.lastEventId !== undefined
      ? { lastEventId: input.lastEventId }
      : {}),
    ...(input.lastGeneration !== undefined
      ? { lastGeneration: generation(input.lastGeneration) }
      : {}),
  };

  try {
    return await prisma.sessionMirror.upsert({
      where: { sessionKey: input.sessionKey },
      create: {
        sessionKey: input.sessionKey,
        externalId: input.externalId,
        externalRef: input.externalRef ?? null,
        ...runtime,
        lastEventId: input.lastEventId ?? null,
        lastGeneration: generation(input.lastGeneration),
      },
      update: { ...runtime, ...eventUpdate },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await findSessionMirrorBySessionKey(prisma, {
      sessionKey: input.sessionKey,
    });
    if (!winner) throw error;
    return winner;
  }
}

export function updateSessionMirror(
  prisma: PrismaClient,
  input: Omit<SessionMirrorInput, "externalId" | "externalRef">,
) {
  return prisma.sessionMirror.update({
    where: { sessionKey: input.sessionKey },
    data: {
      machineId: input.machineId ?? null,
      lastEventId: input.lastEventId ?? null,
      lastGeneration: generation(input.lastGeneration),
    },
  });
}

export function deleteSessionMirror(
  prisma: PrismaClient,
  query: { sessionKey: string; externalId: string },
) {
  return prisma.sessionMirror.deleteMany({
    where: {
      sessionKey: query.sessionKey,
      externalId: query.externalId,
    },
  });
}
