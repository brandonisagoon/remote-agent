import type { PrismaClient } from "../../../../generated/prisma/client.ts";

export async function getBbEventCursor(
  prisma: PrismaClient,
  bbThreadId: string,
): Promise<number> {
  const cursor = await prisma.bbEventCursor.findUnique({
    where: { bbThreadId },
  });
  return cursor ? Number(cursor.lastSeq) : 0;
}

export async function advanceBbEventCursor(
  prisma: PrismaClient,
  input: { bbThreadId: string; seq: number },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.bbEventCursor.findUnique({
      where: { bbThreadId: input.bbThreadId },
    });
    if (current && current.lastSeq >= BigInt(input.seq)) return false;
    await tx.bbEventCursor.upsert({
      where: { bbThreadId: input.bbThreadId },
      create: { bbThreadId: input.bbThreadId, lastSeq: BigInt(input.seq) },
      update: { lastSeq: BigInt(input.seq) },
    });
    await tx.agentIssueRecord.updateMany({
      where: { bbThreadId: input.bbThreadId },
      data: { lastBbEventSeq: BigInt(input.seq) },
    });
    return true;
  });
}
