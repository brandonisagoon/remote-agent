import type { PrismaClient } from "../../../../generated/prisma/client.ts";

const UNIQUE_VIOLATION = "P2002";

interface AgentIssueRecordInput {
  harnessSessionId: string;
  agentIssueId: string;
  agentIssueIdentifier?: string | null;
  machine?: string | null;
  bbThreadId?: string | null;
  lastBbEventSeq?: number | bigint | null;
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

function generation(value: AgentIssueRecordInput["lastGeneration"]): bigint | null {
  return value == null ? null : BigInt(value);
}

export function findAgentIssueRecordByHarnessSessionId(
  prisma: PrismaClient,
  query: { harnessSessionId: string },
) {
  return prisma.agentIssueRecord.findUnique({
    where: { harnessSessionId: query.harnessSessionId },
  });
}

export function findAgentIssueRecordByBbThreadId(
  prisma: PrismaClient,
  query: { bbThreadId: string },
) {
  return prisma.agentIssueRecord.findUnique({
    where: { bbThreadId: query.bbThreadId },
  });
}

/**
 * Claim the canonical Linear issue for a harness session. The update branch
 * intentionally preserves the existing issue identity: a concurrent creator
 * must observe the winner rather than replace it with its own issue.
 */
export async function upsertAgentIssueRecord(
  prisma: PrismaClient,
  input: AgentIssueRecordInput,
) {
  const runtime = {
    machine: input.machine ?? null,
    bbThreadId: input.bbThreadId ?? null,
  };
  const eventUpdate = {
    ...(input.lastEventId !== undefined
      ? { lastEventId: input.lastEventId }
      : {}),
    ...(input.lastGeneration !== undefined
      ? { lastGeneration: generation(input.lastGeneration) }
      : {}),
    ...(input.lastBbEventSeq !== undefined
      ? { lastBbEventSeq: generation(input.lastBbEventSeq) }
      : {}),
  };

  try {
    return await prisma.agentIssueRecord.upsert({
      where: { harnessSessionId: input.harnessSessionId },
      create: {
        harnessSessionId: input.harnessSessionId,
        agentIssueId: input.agentIssueId,
        agentIssueIdentifier: input.agentIssueIdentifier ?? null,
        ...runtime,
        lastBbEventSeq: generation(input.lastBbEventSeq),
        lastEventId: input.lastEventId ?? null,
        lastGeneration: generation(input.lastGeneration),
      },
      update: { ...runtime, ...eventUpdate },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await findAgentIssueRecordByHarnessSessionId(prisma, {
      harnessSessionId: input.harnessSessionId,
    });
    if (!winner) throw error;
    return winner;
  }
}

export function updateAgentIssueRecord(
  prisma: PrismaClient,
  input: Omit<AgentIssueRecordInput, "agentIssueId" | "agentIssueIdentifier">,
) {
  return prisma.agentIssueRecord.update({
    where: { harnessSessionId: input.harnessSessionId },
    data: {
      machine: input.machine ?? null,
      bbThreadId: input.bbThreadId ?? null,
      lastBbEventSeq: generation(input.lastBbEventSeq),
      lastEventId: input.lastEventId ?? null,
      lastGeneration: generation(input.lastGeneration),
    },
  });
}

export function setAgentIssueRecordSessionRoot(
  prisma: PrismaClient,
  input: { bbThreadId: string; sessionRootCommentId: string },
) {
  return prisma.agentIssueRecord.update({
    where: { bbThreadId: input.bbThreadId },
    data: { sessionRootCommentId: input.sessionRootCommentId },
  });
}

export function setAgentIssueRecordErrorNotice(
  prisma: PrismaClient,
  input: {
    bbThreadId: string;
    lastErrorCommentId: string;
    lastErrorEventId: string;
    lastErrorTurnId: string | null;
    lastErrorAt: Date;
  },
) {
  return prisma.agentIssueRecord.update({
    where: { bbThreadId: input.bbThreadId },
    data: {
      lastErrorCommentId: input.lastErrorCommentId,
      lastErrorEventId: input.lastErrorEventId,
      lastErrorTurnId: input.lastErrorTurnId,
      lastErrorAt: input.lastErrorAt,
    },
  });
}

export function clearAgentIssueRecordErrorNotice(
  prisma: PrismaClient,
  input: { bbThreadId: string },
) {
  return prisma.agentIssueRecord.update({
    where: { bbThreadId: input.bbThreadId },
    data: {
      lastErrorCommentId: null,
      lastErrorEventId: null,
      lastErrorTurnId: null,
      lastErrorAt: null,
    },
  });
}

export function deleteAgentIssueRecord(
  prisma: PrismaClient,
  query: { harnessSessionId: string; agentIssueId: string },
) {
  return prisma.agentIssueRecord.deleteMany({
    where: {
      harnessSessionId: query.harnessSessionId,
      agentIssueId: query.agentIssueId,
    },
  });
}
