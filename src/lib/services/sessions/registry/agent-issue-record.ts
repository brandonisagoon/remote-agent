import type { PrismaClient } from "../../../../generated/prisma/client.ts";

const UNIQUE_VIOLATION = "P2002";

interface AgentIssueRecordInput {
  harnessSessionId: string;
  agentIssueId: string;
  agentIssueIdentifier?: string | null;
  machine?: string | null;
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

/**
 * Claim the canonical Linear issue for a harness session. The update branch
 * intentionally preserves the existing issue identity: a concurrent creator
 * must observe the winner rather than replace it with its own issue.
 */
export async function upsertAgentIssueRecord(
  prisma: PrismaClient,
  input: AgentIssueRecordInput,
) {
  const runtime = { machine: input.machine ?? null };
  const eventUpdate = {
    ...(input.lastEventId !== undefined
      ? { lastEventId: input.lastEventId }
      : {}),
    ...(input.lastGeneration !== undefined
      ? { lastGeneration: generation(input.lastGeneration) }
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
      lastEventId: input.lastEventId ?? null,
      lastGeneration: generation(input.lastGeneration),
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
