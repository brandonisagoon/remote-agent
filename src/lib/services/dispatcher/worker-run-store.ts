import type { PrismaClient } from "../../../generated/prisma/client.ts";
import type { WorkerResult } from "../../../types/dispatcher/index.ts";

export async function startWorkerRun(
  prisma: PrismaClient,
  receiptId: string,
  workerKey: string,
) {
  return prisma.workerRun.upsert({
    where: { receiptId_workerKey: { receiptId, workerKey } },
    create: { receiptId, workerKey, status: "pending", attempts: 1 },
    update: { attempts: { increment: 1 }, status: "pending", detail: null },
  });
}

export async function finishWorkerRun(
  prisma: PrismaClient,
  runId: string,
  result: WorkerResult,
) {
  return prisma.workerRun.update({
    where: { id: runId },
    data: {
      status: result.status,
      detail: result.detail,
      targetAgentIssueIdentifier: result.targetAgentIssueIdentifier,
    },
  });
}
