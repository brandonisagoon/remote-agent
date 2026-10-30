import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Prisma, RuntimeSourceMessage } from "../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { withToolingInstructions } from "../../../../lib/skills/compose.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { fetchRouteCandidates, isEligibleCandidate } from "./selection/find-candidates.ts";
import { findThreadSession, registerThread } from "./threads.ts";
import { deliverInstructions, queueInstruction } from "./inbox.ts";
import { sourcePublicationOrigin } from "./source-message-publication.ts";

const OperatorRequest = z.object({
  requestKey: z.string().trim().min(1).max(200),
  expectedUpdatedAt: z.iso.datetime(),
  reason: z.string().trim().min(1).max(4000),
});
export const RetrySourceMessageInput = OperatorRequest.extend({
  sessionId: z.string().min(1).max(256),
  authorityRef: z.string().trim().min(1).max(2000),
}).strict();
export const ExternalSourceDispositionInput = OperatorRequest.extend({
  owner: z.object({ kind: z.literal("native-codex-chat"), threadId: z.string().min(1).max(256), hostId: z.string().min(1).max(256) }).strict(),
  outcome: z.enum(["handled", "assigned", "informational", "needs-action"]),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
}).strict();

function fingerprint(action: string, value: unknown) {
  return createHash("sha256").update(JSON.stringify({ action, value })).digest("hex");
}
async function sourceForOperator(prisma: PrismaClient, config: ServerConfig, id: string) {
  const source = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id } });
  if (source.machineId !== config.machine) throw new Error("Source message belongs to another machine");
  const { tracker } = await import("../../integrations/tracker/port.ts");
  if (tracker.sourceMessages.provider !== source.provider) throw new Error("Source integration is unavailable");
  scoped(config, source); // Reject removed repository/connection configuration.
  return source;
}
function assertUnbound(source: RuntimeSourceMessage, expectedUpdatedAt: string) {
  if (source.state !== "unrouted" || source.sessionId || source.requestId || source.targetRequestId) throw new Error("Only an unbound unrouted comment can be recovered; inspect its existing instruction instead");
  if (source.updatedAt.toISOString() !== expectedUpdatedAt) throw new Error("Source message changed; inspect it again before recovery");
}
async function assertNoInstruction(prisma: Pick<PrismaClient, "runtimeInstruction">, id: string) {
  if (await prisma.runtimeInstruction.findFirst({ where: { OR: [{ sourceMessageId: id }, { id }] } })) throw new Error("Source already has an instruction; recovery must not replay an existing or uncertain delivery");
}
async function previousRequest(prisma: PrismaClient, id: string, requestKey: string, hash: string) {
  const receipt = await prisma.runtimeSourceMessageResolution.findUnique({ where: { sourceMessageId_requestKey: { sourceMessageId: id, requestKey } } });
  if (receipt && receipt.fingerprint !== hash) throw new Error("Recovery requestKey already belongs to a different request");
  return receipt;
}
function scoped(config: ServerConfig, source: RuntimeSourceMessage) {
  return scopeConfig(config, { repositoryId: source.repositoryId, connectionId: source.connectionId });
}

export async function inspectSourceMessage(prisma: PrismaClient, config: ServerConfig, id: string) {
  const source = await sourceForOperator(prisma, config, id);
  const owners = await fetchRouteCandidates(scoped(config, source), prisma, source.resourceIdentifier);
  const resolutions = await prisma.runtimeSourceMessageResolution.findMany({ where: { sourceMessageId: id }, orderBy: { sequence: "desc" }, take: 100 });
  return { source, publicationOrigin: await sourcePublicationOrigin(prisma, source),
    managedOwners: await Promise.all(owners.map(async owner => {
      const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: owner.runtime.runtimeSessionId! } });
      const task = await prisma.remoteTask.findUnique({ where: { primarySessionId: session.id } });
      return { sessionId: session.id, provider: owner.runtime.harness, state: session.status,
        machineId: owner.runtime.machine, ownerPaused: task?.ownerPaused ?? false,
        eligible: session.machineId === config.machine && isEligibleCandidate(config, owner)
          && (!task || (task.phase !== "closed" && task.worktreePath === session.cwd && task.connectionId === source.connectionId && task.issueIdentifier === source.resourceIdentifier)) };
    })),
    nativeCodexChatTransport: "unsupported" as const, resolutions,
    externalDisposition: resolutions.find(row => row.action === "record-external") ?? null };
}

export const ListSourceMessagesInput = z.object({
  state: z.enum(["unrouted", "routing", "queued", "processing", "handled", "failed", "unknown", "attention"]).default("unrouted"),
  connectionId: z.string().min(1).optional(), repositoryId: z.string().min(1).optional(), resourceIdentifier: z.string().min(1).optional(),
  afterSequence: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export async function listSourceMessages(prisma: PrismaClient, config: ServerConfig, query: z.infer<typeof ListSourceMessagesInput>) {
  if (query.connectionId && !config.connections[query.connectionId]) throw new Error("Unknown source connection");
  if (query.repositoryId && !config.repositories[query.repositoryId]) throw new Error("Unknown source repository");
  const rows = await prisma.runtimeSourceMessage.findMany({ where: { machineId: config.machine, state: query.state,
    sequence: { gt: query.afterSequence }, connectionId: query.connectionId ?? { in: Object.keys(config.connections) },
    repositoryId: query.repositoryId ?? { in: Object.keys(config.repositories) }, resourceIdentifier: query.resourceIdentifier },
    orderBy: { sequence: "asc" }, take: query.limit + 1,
    select: { id: true, sequence: true, provider: true, connectionId: true, repositoryId: true, machineId: true, resourceId: true,
      resourceIdentifier: true, commentId: true, threadRootId: true, state: true, detail: true, sessionId: true, requestId: true,
      replyId: true, replyPosted: true, createdAt: true, updatedAt: true,
      resolutions: { where: { action: "record-external" }, orderBy: { sequence: "desc" }, take: 1 } } });
  return { messages: rows.slice(0, query.limit), nextAfterSequence: rows.length > query.limit ? rows[query.limit - 1]!.sequence : null,
    nativeCodexChatTransport: "unsupported" as const };
}

export async function retrySourceMessage(input: { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime; id: string; request: z.infer<typeof RetrySourceMessageInput> }) {
  const { prisma, config, runtime, id, request } = input;
  const hash = fingerprint("retry", request);
  const source = await sourceForOperator(prisma, config, id);
  const previous = await previousRequest(prisma, id, request.requestKey, hash);
  if (previous) return { receipt: previous, replayed: true, source };
  assertUnbound(source, request.expectedUpdatedAt);
  await assertNoInstruction(prisma, id);
  if (await sourcePublicationOrigin(prisma, source)) throw new Error("Source matches a server publication receipt; record its disposition instead of replaying an agent report");
  const selected = scoped(config, source);
  const candidates = (await fetchRouteCandidates(selected, prisma, source.resourceIdentifier)).filter(owner => isEligibleCandidate(selected, owner));
  if (candidates.length !== 1 || candidates[0]!.runtime.runtimeSessionId !== request.sessionId) throw new Error("Retry requires the unique eligible existing ACP primary linked to this source issue; native chat IDs are not managed delivery targets");
  const registration = await findThreadSession(prisma, { provider: source.provider, connectionId: source.connectionId, threadRootCommentId: source.threadRootId });
  if (registration && registration.runtimeSessionId !== request.sessionId) throw new Error("This thread still belongs to another live session");
  const revisionIdentity = { provider: source.provider, connectionId: source.connectionId, commentId: source.commentId };
  // Sequence orders webhook arrival, not provider edits. Capture the local
  // revision set around canonical reads to detect concurrent ingress without
  // treating a delayed obsolete edit as the current comment.
  const revisionSnapshot = await prisma.runtimeSourceMessage.findFirst({ where: revisionIdentity, orderBy: { sequence: "desc" }, select: { sequence: true } });
  const { tracker } = await import("../../integrations/tracker/port.ts");
  const authorized = await tracker.sourceMessages.validateOwner(config, prisma, { ...source, sessionId: request.sessionId });
  const root = await tracker.sourceMessages.readComment(authorized.linearApiKey, source.threadRootId);
  if (root?.issue?.id !== source.resourceId) throw new Error("Original reply thread is unavailable or belongs to another issue");
  const comment = source.commentId === source.threadRootId ? root : await tracker.sourceMessages.readComment(authorized.linearApiKey, source.commentId);
  if (comment?.issue?.id !== source.resourceId || comment.body !== source.body || (comment.parentId ?? comment.id) !== source.threadRootId) throw new Error("Retained comment was changed, removed or moved; inspect its current revision instead");
  const result = await prisma.$transaction(async (tx) => {
    const old = await tx.runtimeSourceMessageResolution.findUnique({ where: { sourceMessageId_requestKey: { sourceMessageId: id, requestKey: request.requestKey } } });
    if (old) {
      if (old.fingerprint !== hash) throw new Error("Recovery requestKey already belongs to a different request");
      return { receipt: old, replayed: true };
    }
    const current = await tx.runtimeSourceMessage.findUniqueOrThrow({ where: { id } });
    assertUnbound(current, request.expectedUpdatedAt); await assertNoInstruction(tx, id);
    const revisionNow = await tx.runtimeSourceMessage.findFirst({ where: revisionIdentity, orderBy: { sequence: "desc" }, select: { sequence: true } });
    if (revisionNow?.sequence !== revisionSnapshot?.sequence) throw new Error("Comment revisions changed during validation; inspect the canonical comment again");
    if (await sourcePublicationOrigin(tx, current)) throw new Error("Source matches a server publication receipt; record its disposition instead of replaying an agent report");
    const external = await tx.runtimeSourceMessageResolution.findFirst({ where: { sourceMessageId: id, action: "record-external" }, orderBy: { sequence: "desc" } });
    if (external && external.outcome !== "needs-action") throw new Error("External handling is already recorded; do not replay it as a new command");
    const session = await tx.runtimeSession.findUniqueOrThrow({ where: { id: request.sessionId } });
    if (!["idle", "active"].includes(session.status) || session.role !== "primary" || session.repositoryId !== current.repositoryId || session.machineId !== current.machineId) throw new Error("Selected source owner is no longer eligible");
    const owners = await tx.runtimeSessionResourceLink.findMany({ where: { provider: current.provider, connectionId: current.connectionId,
      resourceType: "issue-identifier", externalId: current.resourceIdentifier, relationship: "handles", endedAt: null,
      runtimeSession: { role: "primary", status: { in: ["idle", "active"] }, repositoryId: current.repositoryId } } });
    if (owners.length !== 1 || owners[0]!.runtimeSessionId !== session.id) throw new Error("Source ownership changed before retry committed");
    const task = await tx.remoteTask.findUnique({ where: { primarySessionId: session.id } });
    if (task && (task.phase === "closed" || task.worktreePath !== session.cwd || task.connectionId !== current.connectionId || task.issueIdentifier !== current.resourceIdentifier || task.repositoryId !== current.repositoryId || task.machineId !== current.machineId)) throw new Error("Source task ownership changed before retry committed");
    const sourceTasks = await tx.remoteTask.findMany({ where: { connectionId: current.connectionId, repositoryId: current.repositoryId,
      machineId: current.machineId, issueIdentifier: current.resourceIdentifier } });
    const openTasks = sourceTasks.filter(row => row.phase !== "closed");
    if (sourceTasks.length && (openTasks.length !== 1 || openTasks[0]!.primarySessionId !== session.id)) throw new Error("Existing source task has no unique matching primary; recovery cannot replace its owner");
    const liveThread = await findThreadSession(tx as PrismaClient, { provider: current.provider, connectionId: current.connectionId, threadRootCommentId: current.threadRootId });
    if (liveThread && liveThread.runtimeSessionId !== session.id) throw new Error("Thread ownership changed before retry committed");
    const otherThreadOwner = await tx.runtimeSessionResourceLink.findFirst({ where: { provider: current.provider, connectionId: current.connectionId,
      resourceType: "comment-thread", externalId: current.threadRootId, endedAt: null, runtimeSessionId: { not: session.id },
      runtimeSession: { status: { not: "closed" } } } });
    if (otherThreadOwner) throw new Error("Thread has competing live ownership; inspect it before recovery");
    const receipt = await tx.runtimeSourceMessageResolution.create({ data: { sourceMessageId: id, requestKey: request.requestKey, fingerprint: hash,
      action: "retry", reason: request.reason, authorityRef: request.authorityRef, sessionId: session.id, evidence: [],
      revisionSequence: revisionSnapshot!.sequence,
      priorReplyId: current.replyId, priorReplyBody: current.replyBody, priorReplyPosted: current.replyPosted,
      createdAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)) } });
    await tx.runtimeSourceMessage.update({ where: { id }, data: { state: "routing", detail: null, replyId: randomUUID(), replyBody: null,
      replyRequestKey: null, replyPosted: false, projectionPending: true } });
    const question = liveThread?.relationship === "question" ? await tx.runtimeQuestion.findFirst({ where: { id: current.threadRootId, runtimeSessionId: session.id, connectionId: current.connectionId } }) : null;
    const text = `[Operator recovery ${receipt.id}] ${request.reason}\nAuthority: ${request.authorityRef}\n\n${question ? `This answers your earlier question in this thread.\nQuestion: ${question.body}\n\n` : ""}[Linear ${current.resourceIdentifier} — retained comment ${current.commentId}]\n${current.body}`;
    await queueInstruction(tx, { requestId: id, sessionId: session.id, sourceMessageId: id,
      text: task?.pinnedToolingRoot ? withToolingInstructions(text, session.cwd, task.pinnedToolingRoot) : text });
    await registerThread(tx as PrismaClient, { provider: current.provider, connectionId: current.connectionId, threadRootCommentId: current.threadRootId, runtimeSessionId: session.id });
    if (question) await tx.runtimeQuestion.update({ where: { id: question.id }, data: { state: "answered", error: null } });
    return { receipt, replayed: false };
  });
  void deliverInstructions(prisma, runtime, config).catch(() => undefined);
  return { ...result, source: await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id } }) };
}

export async function recordExternalSourceDisposition(input: { prisma: PrismaClient; config: ServerConfig; id: string; request: z.infer<typeof ExternalSourceDispositionInput> }) {
  const { prisma, config, id, request } = input;
  const hash = fingerprint("record-external", request);
  await sourceForOperator(prisma, config, id);
  const previous = await previousRequest(prisma, id, request.requestKey, hash);
  if (previous) return { receipt: previous, replayed: true, source: await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id } }) };
  return prisma.$transaction(async (tx) => {
    const old = await tx.runtimeSourceMessageResolution.findUnique({ where: { sourceMessageId_requestKey: { sourceMessageId: id, requestKey: request.requestKey } } });
    if (old) { if (old.fingerprint !== hash) throw new Error("Recovery requestKey already belongs to a different request"); return { receipt: old, replayed: true, source: await tx.runtimeSourceMessage.findUniqueOrThrow({ where: { id } }) }; }
    const source = await tx.runtimeSourceMessage.findUniqueOrThrow({ where: { id } });
    assertUnbound(source, request.expectedUpdatedAt); await assertNoInstruction(tx, id);
    const recordedAt = new Date(Math.max(Date.now(), source.updatedAt.getTime() + 1));
    const receipt = await tx.runtimeSourceMessageResolution.create({ data: { sourceMessageId: id, requestKey: request.requestKey, fingerprint: hash,
      action: "record-external", reason: request.reason, externalOwner: request.owner as Prisma.InputJsonObject, outcome: request.outcome, evidence: request.evidence, createdAt: recordedAt } });
    const current = await tx.runtimeSourceMessage.update({ where: { id }, data: { updatedAt: recordedAt } });
    return { receipt, replayed: false, source: current };
  });
}
