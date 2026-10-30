import type { ServerConfig } from "../../../../lib/config.ts";
import { readDeliveryComment } from "../../integrations/linear/comment-context.ts";
import { LinearCommentGeneration, observeLinearCommentGeneration, classifyLinearCommentGeneration } from "../../integrations/linear/comment-generation.ts";
import type { SourceMessageInput } from "./source-messages.ts";
import { createHash } from "node:crypto";
import { QueuedNativeReport } from "./source-report-disposition.ts";
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
  const report = await prisma.runtimeSourceMessageResolution.findFirst({ where: { sourceMessageId: source.id, action: "record-native-report", outcome: "informational" } });
  const saved = QueuedNativeReport.safeParse((report?.evidence as { attestation?: unknown } | null)?.attestation);
  if (report && saved.success) {
    const publication = saved.data.publication;
    if (saved.data.sourceSequence === source.sequence && publication.provider === source.provider && publication.connectionId === source.connectionId && publication.issueId === source.resourceId && publication.commentId === source.commentId && publication.threadRootId === source.threadRootId && publication.authorId === source.authorId && publication.bodySha256 === createHash("sha256").update(source.body).digest("hex")) {
      return { kind: "native-report-attestation" as const, receiptId: report.id, confirmed: true };
    }
  }
  return null;
}

/** Exact provider generation, not body equality, decides whether a native report
 * webhook is still the attested publication. Later edits keep their own input ID,
 * including a human A→B→A edit which otherwise collides with content-only history. */
export async function nativeReportIngress(prisma: Store, config: ServerConfig, input: SourceMessageInput) {
  const receipt = await prisma.runtimeSourceMessageResolution.findFirst({ where: { action: "record-native-report", outcome: "informational", sourceMessage: { provider: input.provider, connectionId: input.connectionId, repositoryId: input.repositoryId, machineId: input.machineId, resourceId: input.resourceId, commentId: input.commentId } }, orderBy: { sequence: "asc" }, include: { sourceMessage: true } });
  if (!receipt) return null;
  const origin = await sourcePublicationOrigin(prisma, receipt.sourceMessage);
  if (origin?.kind !== "native-report-attestation" || origin.receiptId !== receipt.id) throw new Error("Native report provenance is unavailable");
  const saved = QueuedNativeReport.parse((receipt.evidence as { attestation: unknown }).attestation).publication;
  const current = await readDeliveryComment(config.linearApiKey, input.commentId);
  if (!current || current.id !== input.commentId || current.issue?.id !== input.resourceId || current.user?.id !== input.authorId || (current.parentId ?? current.id) !== input.threadRootId || current.body !== input.body || !current.createdAt || !current.updatedAt || !Number.isFinite(Date.parse(current.updatedAt)) || !Number.isFinite(Date.parse(current.createdAt))) throw new Error("Comment generation changed during native report ingress");
  const evidence = receipt.evidence as { providerGeneration?: unknown };
  if (Object.hasOwn(evidence, "providerGeneration")) {
    const generation = LinearCommentGeneration.parse(evidence.providerGeneration);
    if (generation.createdAt !== saved.createdAt) throw new Error("Native report generation does not match its attestation");
    const result = classifyLinearCommentGeneration(generation, observeLinearCommentGeneration(current), createHash("sha256").update(input.body).digest("hex") === saved.bodySha256 && input.authorId === saved.authorId && input.threadRootId === saved.threadRootId);
    return { receiptId: receipt.id, fingerprint: receipt.fingerprint, ...result };
  }
  // Historical receipts have no author-edit observation. Keep their original
  // strict version contract; never silently manufacture that missing proof.
  const same = current.createdAt === saved.createdAt && current.updatedAt === saved.updatedAt && createHash("sha256").update(input.body).digest("hex") === saved.bodySha256 && input.authorId === saved.authorId && input.threadRootId === saved.threadRootId;
  if (!same && (current.createdAt !== saved.createdAt || Date.parse(current.updatedAt) <= Date.parse(saved.updatedAt))) throw new Error("Comment is not a later generation of the attested publication");
  return { receiptId: receipt.id, fingerprint: receipt.fingerprint, informational: same, revision: `${current.createdAt}:${current.updatedAt}` };
}
