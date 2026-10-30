import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity } from "../../integrations/linear/comments.ts";
import { getSourceIssueForUpdate } from "../../integrations/linear/session-store/source-issue/read.ts";
import { registerThread } from "../sessions/threads.ts";
import { assertCompletedCleanup, assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { inspectSavedCleanup } from "./cleanup-inspection.ts";
import { cleanupProgressProjection } from "./cleanup-progress.ts";
import { retirementDigest } from "./retirement-receipts.ts";

export const CLEANUP_REPORT = "finalization-cleanup-report";
export const CleanupReportRequest = z.object({ requestKey: z.string().min(1).max(180) }).strict();
const Report = z.object({ version: z.literal(1), taskId: z.string(), sessionId: z.string(), connectionId: z.string(), issueId: z.string(), issueIdentifier: z.string(),
  operationRevision: z.number().int().positive(), preparedRevision: z.number().int().positive(), confirmedRevision: z.number().int().positive(),
  reportId: z.string().uuid(), payload: z.object({ requestKey: z.string(), body: z.string(), evidence: z.tuple([]) }).strict(),
}).strict();
type Database = Pick<PrismaClient, "runtimeIssueUpdate" | "runtimeMetadataEvent">;
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
const where = (taskId: string, sessionId: string, requestKey: string) => ({ runtimeSessionId: sessionId, source: `finalizer:${taskId}`, action: CLEANUP_REPORT, key: requestKey });

/** Runs in the confirmation transaction. This records the already verified
 * cleanup fact before closure; it neither reads nor changes Linear. */
export async function queueCleanupReport(prisma: Database, active: Active, confirmedRevision: number) {
  const prepared = active.prepared;
  const payload = { requestKey: `${prepared.requestKey}:cleanup-report`, body: `Cleanup is confirmed for ${prepared.issueIdentifier}. Its accepted work at ${prepared.revision} is preserved. Required task resources are retired, explicitly retained evidence remains recorded, and the original development worktree and Git registration are absent.`, evidence: [] as [] };
  const report = await prisma.runtimeIssueUpdate.upsert({ where: { runtimeSessionId_requestKey: { runtimeSessionId: prepared.sessionId, requestKey: payload.requestKey } }, update: {},
    create: { runtimeSessionId: prepared.sessionId, requestKey: payload.requestKey, connectionId: prepared.connectionId, issueId: prepared.issueId, input: payload, evidence: [] } });
  if (report.connectionId !== prepared.connectionId || report.issueId !== prepared.issueId || retirementDigest(report.input) !== retirementDigest(payload) || retirementDigest(report.evidence) !== retirementDigest([])) throw new Error("Cleanup report identity already belongs to another publication");
  const frozen = Report.parse({ version: 1, taskId: prepared.taskId, sessionId: prepared.sessionId, connectionId: prepared.connectionId, issueId: prepared.issueId, issueIdentifier: prepared.issueIdentifier,
    operationRevision: active.operationRevision, preparedRevision: active.preparation.sequence, confirmedRevision, reportId: report.id, payload });
  const key = where(prepared.taskId, prepared.sessionId, prepared.requestKey), previous = await prisma.runtimeMetadataEvent.findFirst({ where: key });
  if (previous && retirementDigest(JSON.parse(previous.value!)) !== retirementDigest(frozen)) throw new Error("Cleanup reporting receipt changed");
  if (!previous) await prisma.runtimeMetadataEvent.create({ data: { ...key, value: JSON.stringify(frozen) } });
  return { reportId: report.id, published: report.published };
}

type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string; requestKey: string };
type ReadContext = Omit<Context, "prisma"> & { prisma: Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "remoteTaskResource" | "runtimeMetadataEvent" | "runtimeIssueUpdate"> };
async function load(input: ReadContext) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Cleanup report requires the original primary");
  const active = await assertCompletedCleanup({ ...input, sessionId: task.primarySessionId });
  const event = await input.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: where(task.id, task.primarySessionId, input.requestKey) });
  const frozen = Report.parse(JSON.parse(event.value!));
  const prepared = active.prepared;
  if (frozen.taskId !== task.id || frozen.sessionId !== prepared.sessionId || frozen.connectionId !== prepared.connectionId || frozen.issueId !== prepared.issueId || frozen.issueIdentifier !== prepared.issueIdentifier
    || frozen.operationRevision !== active.operationRevision || frozen.preparedRevision !== active.preparation.sequence || frozen.confirmedRevision !== active.confirmed.sequence
    || frozen.payload.requestKey !== `${input.requestKey}:cleanup-report`) throw new Error("Cleanup reporting authority changed");
  const receipt = await input.prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: frozen.reportId } });
  if (receipt.runtimeSessionId !== frozen.sessionId || receipt.connectionId !== frozen.connectionId || receipt.issueId !== frozen.issueId || receipt.requestKey !== frozen.payload.requestKey
    || retirementDigest(receipt.input) !== retirementDigest(frozen.payload) || retirementDigest(receipt.evidence) !== retirementDigest([])) throw new Error("Cleanup publication payload or comment identity changed");
  return { active, frozen, receipt };
}
export const cleanupReportDelivery = { read: getSourceIssueForUpdate, comment: fetchIssueCommentIdentity, create: createThreadedIssueComment };

/** A lost response retries one UUID/body after closure. Existing preparations
 * lack source-version evidence, so this path never writes a Linear state. */
export async function publishCleanupReport(input: Context, client = cleanupReportDelivery) {
  const saved = await load(input), { frozen } = saved;
  if (saved.receipt.published) return { published: true as const, reportId: frozen.reportId };
  const config = scopeConfig(input.config, { repositoryId: saved.active.prepared.repositoryId, connectionId: frozen.connectionId });
  const issue = await client.read(config, { id: frozen.issueId });
  if (!issue || issue.id !== frozen.issueId || issue.identifier !== frozen.issueIdentifier) throw new Error("Cleanup report source identity changed");
  const matches = (comment: Awaited<ReturnType<typeof client.comment>>) => Boolean(comment && comment.id === frozen.reportId && comment.issue?.id === frozen.issueId && comment.body === frozen.payload.body);
  let existing = await client.comment(config.linearApiKey, frozen.reportId);
  if (existing && !matches(existing)) throw new Error("Cleanup report comment identity or body changed");
  if (!existing) {
    await load(input);
    await registerThread(input.prisma, { provider: "linear", connectionId: frozen.connectionId, runtimeSessionId: frozen.sessionId, threadRootCommentId: frozen.reportId });
    try { await client.create(config.linearApiKey, { id: frozen.reportId, issueId: frozen.issueId, body: frozen.payload.body }); }
    catch (error) { existing = await client.comment(config.linearApiKey, frozen.reportId); if (!matches(existing)) throw error; }
    existing = await client.comment(config.linearApiKey, frozen.reportId);
    if (!matches(existing)) throw new Error("Cleanup report delivery is unconfirmed; retry the same persisted receipt");
  }
  await input.prisma.$transaction(async tx => {
    // All external observations precede this local authority/identity CAS.
    const current = await load({ ...input, prisma: tx });
    if (current.frozen.reportId !== frozen.reportId || retirementDigest(current.frozen) !== retirementDigest(frozen)) throw new Error("Cleanup reporting receipt changed during publication");
    await tx.runtimeIssueUpdate.update({ where: { id: frozen.reportId }, data: { commentPosted: true, published: true } });
  });
  return { published: true as const, reportId: frozen.reportId };
}

/** Saved visibility is independent of effect authority. Keep the original
 * cleanupOperation field guarded for existing clients that select adapters
 * from its presence; cleanupHistory is explicitly read-only. */
export async function cleanupProjection(prisma: PrismaClient, config: ServerConfig, task: { id: string; primarySessionId: string | null }) {
  let saved: Awaited<ReturnType<typeof inspectSavedCleanup>>;
  try { saved = await inspectSavedCleanup(prisma, task.id); }
  catch (error) { return { cleanupRequired: true as const, cleanupBlocked: error instanceof Error ? error.message : String(error) }; }
  if (!saved) return {};
  const requestKey = `finalize:${task.id}`, sessionId = saved.history.originalSessionId;
  const progress = await cleanupProgressProjection(prisma, { id: task.id, primarySessionId: sessionId }, saved.history, saved.history.resources);
  const history = { ...progress, cleanupRequired: true as const, cleanupHistory: saved.history };
  try {
    if (task.primarySessionId !== sessionId) throw new Error("Cleanup original primary identity changed");
    const input = { prisma, config, sessionId, requestKey };
    const active = saved.history.recordedConfirmationRevision ? await assertCompletedCleanup(input) : await assertPreparedCleanup(input);
    if (active.operationRevision !== saved.history.operationRevision || retirementDigest(active.operation) !== saved.history.operationDigest) throw new Error("Cleanup operation changed during inspection");
    const report = await prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: sessionId, requestKey: `${requestKey}:cleanup-report` } } });
    return { ...history, cleanupOperation: { operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation),
      preparedRevision: active.preparation.sequence, ...(saved.history.recordedConfirmationRevision ? { confirmedRevision: saved.history.recordedConfirmationRevision } : {}), reportingPending: Boolean(saved.history.recordedConfirmationRevision && !report?.published) } };
  } catch (error) { return { ...history, cleanupBlocked: error instanceof Error ? error.message : String(error) }; }
}
