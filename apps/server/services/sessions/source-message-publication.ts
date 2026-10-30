import type { PrismaClient, RuntimeSourceMessage } from "../../../../generated/prisma/client.ts";

type Store = Pick<PrismaClient, "runtimeIssueUpdate" | "runtimeQuestion" | "runtimeSourceMessage" | "runtimeMessageControl" | "runtimeSourceMessageResolution">;

/** Only server-held publication identities establish provenance. Native chat
 * connector reports have no such receipt: author identity/prose cannot tell a
 * human request from an agent writing through the same Linear account. */
export async function sourcePublicationOrigin(prisma: Store, source: RuntimeSourceMessage) {
  if (source.provider !== "linear") return null;
  const identity = { connectionId: source.connectionId, issueId: source.resourceId,
    runtimeSession: { repositoryId: source.repositoryId, machineId: source.machineId } };
  const update = await prisma.runtimeIssueUpdate.findFirst({ where: { ...identity, id: source.commentId } });
  if (update) return { kind: "issue-update" as const, receiptId: update.id, confirmed: update.commentPosted };
  const question = await prisma.runtimeQuestion.findFirst({ where: { ...identity, id: source.commentId } });
  if (question) return { kind: "question" as const, receiptId: question.id, confirmed: question.state === "posted" || question.state === "answered" };
  const origin = { provider: source.provider, connectionId: source.connectionId, repositoryId: source.repositoryId,
    machineId: source.machineId, resourceId: source.resourceId };
  const reply = await prisma.runtimeSourceMessage.findFirst({ where: { ...origin, replyId: source.commentId } });
  if (reply) return { kind: "source-reply" as const, receiptId: reply.id, confirmed: reply.replyPosted };
  const archived = await prisma.runtimeSourceMessageResolution.findFirst({ where: { priorReplyId: source.commentId, sourceMessage: origin } });
  if (archived) return { kind: "prior-source-reply" as const, receiptId: archived.id, confirmed: archived.priorReplyPosted };
  const control = await prisma.runtimeMessageControl.findFirst({ where: { provider: source.provider, connectionId: source.connectionId,
    repositoryId: source.repositoryId, machineId: source.machineId, noticeId: source.commentId } });
  if (control?.sourceMessageId) {
    const target = await prisma.runtimeSourceMessage.findFirst({ where: { ...origin, id: control.sourceMessageId } });
    if (target) return { kind: "control-notice" as const, receiptId: control.id, confirmed: control.noticePosted };
  }
  return null;
}
