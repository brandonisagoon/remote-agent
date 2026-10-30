import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, RuntimeSourceMessage } from "../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { assertRequestActive } from "../../request-lifetime.ts";
import { readDeliveryComment } from "../../integrations/linear/comment-context.ts";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().trim().min(1).max(2000);
export const QueuedNativeReport = z.object({
  version: z.literal(1), sourceSequence: z.number().int().positive(), taskId: Id, ownershipDigest: Sha, bodySha256: Sha,
  instruction: z.object({ id: Id, sequence: z.number().int().positive(), updatedAt: z.iso.datetime(), textSha256: Sha }).strict(),
  publication: z.object({ provider: z.literal("linear"), connectionId: Id, issueId: Id, commentId: Id, threadRootId: Id, authorId: Id,
    bodySha256: Sha, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict(),
  nativeReceipt: z.object({ tool: z.literal("linear.save_comment"), toolCallId: Id, turnId: Id, reference: Id, sha256: Sha }).strict(),
}).strict();
type Store = Pick<PrismaClient, "runtimeSourceMessage" | "runtimeInstruction" | "runtimeSession" | "remoteTask" | "runtimeSessionResourceLink" | "runtimeMetadataEvent" | "runtimeLifecycleEvent" | "runtimeMessageControl" | "runtimeSourceMessageResolution">;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
const action = "record-native-report";

/** A configured author is still a human authority, not evidence of report origin. */
function subscribed(config: ServerConfig, source: RuntimeSourceMessage) {
  if (source.provider !== "linear" || source.machineId !== config.machine) throw new Error("Report source belongs to another integration or machine");
  const webhook = Object.values(config.webhooks).find(row => row.connectionId === source.connectionId && row.repositoryRouting[source.repositoryId]);
  const rules = webhook?.repositoryRouting[source.repositoryId]?.when;
  if (!webhook || !rules?.some(rule => rule["linear.userId"]?.includes(source.authorId))) throw new Error("Report author is no longer explicitly subscribed");
  return scopeConfig(config, { repositoryId: source.repositoryId, connectionId: source.connectionId, webhookId: webhook.id });
}
async function currentBinding(store: Store, config: ServerConfig, source: RuntimeSourceMessage) {
  subscribed(config, source);
  if (source.state !== "queued" || !source.sessionId || source.requestId || source.targetRequestId || source.replyPosted || source.replyBody || source.replyRequestKey) throw new Error("Only a never-started queued report with no reply is eligible");
  const instruction = await store.runtimeInstruction.findUnique({ where: { sourceMessageId: source.id } });
  if (!instruction || instruction.id !== source.id || instruction.sessionId !== source.sessionId || instruction.state !== "queued" || instruction.executionRequestId) throw new Error("Report instruction is not its original never-started queue item");
  const session = await store.runtimeSession.findUnique({ where: { id: source.sessionId } });
  const task = session && await store.remoteTask.findUnique({ where: { primarySessionId: session.id } });
  if (!session || !task || session.role !== "primary" || session.status !== "idle" || task.ownerPaused || task.phase === "closed" || task.worktreePath !== session.cwd || task.repositoryId !== source.repositoryId || task.machineId !== source.machineId || task.connectionId !== source.connectionId || task.issueIdentifier !== source.resourceIdentifier || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) throw new Error("Original report owner is paused, busy, closed or changed");
  const tasks = await store.remoteTask.findMany({ where: { repositoryId: source.repositoryId, machineId: source.machineId, connectionId: source.connectionId, issueIdentifier: source.resourceIdentifier, phase: { not: "closed" } }, select: { id: true } });
  const links = await store.runtimeSessionResourceLink.findMany({ where: { provider: source.provider, connectionId: source.connectionId, resourceType: "issue-identifier", externalId: source.resourceIdentifier, relationship: "handles", endedAt: null, runtimeSession: { role: "primary", status: { not: "closed" } } }, orderBy: { id: "asc" } });
  if (tasks.length !== 1 || tasks[0]!.id !== task.id || links.length !== 1 || links[0]!.runtimeSessionId !== session.id) throw new Error("Report source has no unique original primary");
  const attempt = { runtimeSessionId: session.id, OR: [{ requestId: instruction.id }, { requestId: { startsWith: `${instruction.id}:retry:` } }] };
  if (await store.runtimeLifecycleEvent.findFirst({ where: attempt }) || await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, OR: [{ action: "source-message-turn", value: source.id }, { key: instruction.id }, { key: { startsWith: `${instruction.id}:retry:` } }] } }) || await store.runtimeMessageControl.findFirst({ where: { sourceMessageId: source.id } }) || await store.runtimeSourceMessageResolution.findFirst({ where: { sourceMessageId: source.id } })) throw new Error("Report already has execution, control or recovery history");
  const latest = await store.runtimeSourceMessage.findFirst({ where: { provider: source.provider, connectionId: source.connectionId, commentId: source.commentId }, orderBy: { sequence: "desc" } });
  if (latest?.id !== source.id) throw new Error("A newer comment revision must remain owner input");
  const ownershipDigest = digest({ task: { id: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, phase: task.phase, ownerPaused: task.ownerPaused, branchName: task.branchName, worktreePath: task.worktreePath, toolingRoot: task.toolingRoot, pinnedToolingRoot: task.pinnedToolingRoot, toolingRevision: task.toolingRevision }, session: { id: session.id, scopeKey: session.scopeKey, role: session.role, cwd: session.cwd, repositoryId: session.repositoryId, machineId: session.machineId }, links });
  const binding = { sourceSequence: source.sequence, taskId: task.id, ownershipDigest, bodySha256: sha(source.body), instruction: { id: instruction.id, sequence: instruction.sequence, updatedAt: instruction.updatedAt.toISOString(), textSha256: sha(instruction.text) } };
  return { binding, instruction, task, sourceDigest: digest(source) };
}
export async function inspectQueuedReportDisposition(store: Store, config: ServerConfig, source: RuntimeSourceMessage) {
  try { return { eligible: true as const, binding: (await currentBinding(store, config, source)).binding }; }
  catch (error) { return { eligible: false as const, reason: error instanceof Error ? error.message : String(error) }; }
}

type Request = { requestKey: string; expectedUpdatedAt: string; reason: string; owner: { kind: "native-codex-chat"; threadId: string; hostId: string }; outcome: string; evidence: string[]; queuedReport: z.infer<typeof QueuedNativeReport> };
/** Called only by the owner-authenticated branch of the existing disposition API.
 * The native tool receipt is an explicit owner attestation, never machine-verified
 * native execution. Provider reads independently bind its exact publication. */
export async function recordQueuedReportDisposition(input: { prisma: PrismaClient; config: ServerConfig; id: string; request: Request }) {
  const { prisma, config, id, request } = input;
  const report = QueuedNativeReport.parse(request.queuedReport);
  if (request.outcome !== "informational") throw new Error("Queued native reports require an informational disposition");
  const hash = digest({ action, value: request });
  const replay = async (store: Store) => {
    const prior = await store.runtimeSourceMessageResolution.findUnique({ where: { sourceMessageId_requestKey: { sourceMessageId: id, requestKey: request.requestKey } } });
    if (!prior) return null;
    if (prior.action !== action || prior.fingerprint !== hash) throw new Error("Disposition requestKey already belongs to another request");
    return { receipt: prior, replayed: true, source: await store.runtimeSourceMessage.findUniqueOrThrow({ where: { id } }) };
  };
  const source = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id } });
  const scoped = subscribed(config, source);
  const prior = await replay(prisma); if (prior) return prior;
  const before = await currentBinding(prisma, config, source);
  const { publication, nativeReceipt: _nativeReceipt, version: _version, ...expected } = report;
  if (digest(before.binding) !== digest(expected) || source.updatedAt.toISOString() !== request.expectedUpdatedAt) throw new Error("Report source, instruction or original owner generation changed");
  if (publication.provider !== source.provider || publication.connectionId !== source.connectionId || publication.issueId !== source.resourceId || publication.commentId !== source.commentId || publication.threadRootId !== source.threadRootId || publication.authorId !== source.authorId || publication.bodySha256 !== sha(source.body)) throw new Error("Attested publication does not match the exact queued source");
  if (Date.parse(publication.createdAt) > Date.now() || Date.parse(publication.updatedAt) > Date.now()) throw new Error("Publication timestamps are in the future");
  const observe = async () => {
    const current = await readDeliveryComment(scoped.linearApiKey, source.commentId);
    assertRequestActive();
    if (!current || current.id !== publication.commentId || current.issue?.id !== publication.issueId || current.user?.id !== publication.authorId || (current.parentId ?? current.id) !== publication.threadRootId || current.body !== source.body || current.createdAt !== publication.createdAt || current.updatedAt !== publication.updatedAt) throw new Error("Published report was changed, removed or does not match the native receipt");
  };
  await observe();
  await currentBinding(prisma, config, source);
  await observe();
  return prisma.$transaction(async tx => {
    assertRequestActive();
    const old = await replay(tx); if (old) return old;
    const current = await tx.runtimeSourceMessage.findUniqueOrThrow({ where: { id } });
    const checked = await currentBinding(tx, config, current);
    if (checked.sourceDigest !== before.sourceDigest || digest(checked.binding) !== digest(before.binding)) throw new Error("Report changed during publication verification");
    assertRequestActive();
    const receipt = await tx.runtimeSourceMessageResolution.create({ data: { sourceMessageId: id, requestKey: request.requestKey, fingerprint: hash, action, reason: request.reason, externalOwner: request.owner, outcome: "informational", sessionId: current.sessionId, evidence: { version: 1, attestation: report, evidence: request.evidence, sourceDigest: before.sourceDigest }, revisionSequence: current.sequence } });
    const detail = `External informational report; no managed execution (${receipt.id})`;
    const instruction = await tx.runtimeInstruction.updateMany({ where: { id: checked.instruction.id, sequence: checked.instruction.sequence, sessionId: current.sessionId!, sourceMessageId: id, state: "queued", executionRequestId: null, updatedAt: checked.instruction.updatedAt, text: checked.instruction.text }, data: { state: "acknowledged", detail } });
    if (instruction.count !== 1) throw new Error("Report instruction changed before disposition");
    const updated = await tx.runtimeSourceMessage.updateMany({ where: { id, sequence: current.sequence, state: "queued", sessionId: current.sessionId, requestId: null, targetRequestId: null, updatedAt: current.updatedAt }, data: { state: "handled", detail, projectionPending: true } });
    if (updated.count !== 1) throw new Error("Report source changed before disposition");
    assertRequestActive();
    return { receipt, replayed: false, source: await tx.runtimeSourceMessage.findUniqueOrThrow({ where: { id } }) };
  });
}
