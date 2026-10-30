import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";
import { assertCompletedCleanup, assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { FINALIZATION_CONFIRMED } from "./finalization-receipts.ts";
import { retirementDigest } from "./retirement-receipts.ts";

type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string; requestKey: string };
export function cleanupStatusPayload(active: Active) {
  return { requestKey: `${active.prepared.requestKey}:cleanup`, body: `Cleanup is continuing for ${active.prepared.issueIdentifier}. Its accepted delivery and cleanup preparation are saved. Required resources and the original worktree will be retired under that existing authority; retained data stays protected.`, state: "Cleanup", expectedState: "Merge", evidence: [] as [] };
}

/** This is an ordinary publication receipt, never a new cleanup grant. */
export async function cleanupStatusReceipt(prisma: Pick<PrismaClient, "runtimeIssueUpdate">, active: Active) {
  const payload = cleanupStatusPayload(active);
  const receipt = await prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: active.prepared.sessionId, requestKey: payload.requestKey } } });
  if (!receipt) return null;
  if (receipt.issueId !== active.prepared.issueId || receipt.connectionId !== active.prepared.connectionId
    || retirementDigest(receipt.input) !== retirementDigest(payload) || retirementDigest(receipt.evidence) !== retirementDigest([])) throw new Error("Cleanup status publication identity changed");
  return receipt;
}

export async function assertCleanupStatusHandoff(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; requestKey: string; body: string; state?: string; expectedState?: string; evidence?: unknown[] }) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
  const requestKey = `finalize:${task.id}`;
  const active = await assertPreparedCleanup({ ...input, requestKey });
  if (await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED, key: requestKey } })) throw new Error("Cleanup start publication is superseded by confirmed cleanup");
  const payload = cleanupStatusPayload(active);
  if (retirementDigest({ requestKey: input.requestKey, body: input.body, state: input.state, expectedState: input.expectedState, evidence: input.evidence ?? [] }) !== retirementDigest(payload)) throw new Error("Cleanup status requires the existing prepared handoff");
}

/** Optional visibility: absent configuration and later owner states never
 * become prerequisites for resource effects. A completed operation can never
 * replay a pending Merge-to-Cleanup publication, even after closure. */
export async function publishCleanupStatus(input: Context, client = issueUpdateDelivery) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Cleanup status requires the original primary");
  const context = { ...input, sessionId: task.primarySessionId };
  if (await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED, key: input.requestKey } })) {
    await assertCompletedCleanup(context);
    return { state: "superseded" as const };
  }
  const active = await assertPreparedCleanup(context);
  // Save reporting intent before any network read, independently of whether
  // Cleanup exists or its comment/state response arrives. Confirmation uses
  // this same row; it never guesses state application from commentPosted.
  const seeded = await input.prisma.$transaction(async prisma => {
    const current = await assertPreparedCleanup({ ...context, prisma });
    if (current.operationRevision !== active.operationRevision || retirementDigest(current.operation) !== retirementDigest(active.operation)) throw new Error("Cleanup status operation changed");
    if (await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId!, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED, key: input.requestKey } })) return false;
    const payload = cleanupStatusPayload(current);
    await prisma.runtimeIssueUpdate.upsert({ where: { runtimeSessionId_requestKey: { runtimeSessionId: task.primarySessionId!, requestKey: payload.requestKey } }, update: {},
      create: { runtimeSessionId: task.primarySessionId!, requestKey: payload.requestKey, connectionId: current.prepared.connectionId, issueId: current.prepared.issueId, input: payload, evidence: [] } });
    await cleanupStatusReceipt(prisma, current);
    return true;
  });
  if (!seeded) { await assertCompletedCleanup(context); return { state: "superseded" as const }; }
  const receipt = await cleanupStatusReceipt(input.prisma, active);
  const source = await client.source(context);
  if (source.issue.id !== active.prepared.issueId || source.link.connectionId !== active.prepared.connectionId) throw new Error("Cleanup status source identity changed");
  if (receipt?.published && source.issue.state.name !== "Cleanup") return { state: "superseded" as const };
  if (source.issue.state.name !== "Merge" && !(source.issue.state.name === "Cleanup" && receipt?.commentPosted)) return { state: "superseded" as const };
  const states = source.issue.team.states.nodes.filter(state => state.name === "Cleanup");
  if (states.length !== 1 || states[0]!.type !== "completed") return { state: "unavailable" as const };
  try {
    const result = await publishSessionIssueUpdate({ ...context, ...cleanupStatusPayload(active) }, client);
    return { state: "published" as const, reportId: result.commentId };
  } catch (error) {
    if (await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED, key: input.requestKey } })) {
      await assertCompletedCleanup(context);
      return { state: "superseded" as const };
    }
    throw error;
  }
}
