import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";

const Id = z.string().trim().min(1).max(2000);
export const NativeReportInput = z.object({
  requestKey: z.string().trim().min(1).max(150), body: z.string().trim().min(1).max(30_000),
  ownershipDigest: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.object({ kind: z.literal("native-codex-chat"), threadId: Id, hostId: Id, turnId: Id }).strict(),
}).strict();
export const NativeReportOrigin = z.object({
  version: z.literal(1), taskId: Id, sessionId: Id, repositoryId: Id, machineId: Id,
  connectionId: Id, issueId: Id, issueIdentifier: Id, commentId: z.uuid(),
  request: NativeReportInput,
}).strict();
export const NATIVE_REPORT_ORIGIN = "native-report-prepared";
export const nativeReportDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Store = Pick<PrismaClient, "runtimeIssueUpdate" | "runtimeMetadataEvent">;

/** This event is written atomically with the existing issue-update outbox, before
 * publication. A comment ID or matching prose alone is not native provenance. */
export async function readNativeReportOrigin(store: Store, connectionId: string, commentId: string) {
  const receipt = await store.runtimeIssueUpdate.findFirst({ where: { id: commentId, connectionId } });
  if (!receipt) return null;
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: receipt.runtimeSessionId, action: NATIVE_REPORT_ORIGIN, source: "native-report-outbox", key: receipt.id } });
  if (!events.length) return null;
  if (events.length !== 1) throw new Error("Native report has ambiguous publication provenance");
  const event = events[0]!;
  const origin = NativeReportOrigin.parse(JSON.parse(event.value ?? "null"));
  const payload = { requestKey: `native-report:${origin.request.requestKey}`, body: origin.request.body, evidence: [] };
  if (origin.commentId !== receipt.id || origin.sessionId !== receipt.runtimeSessionId || origin.connectionId !== receipt.connectionId || origin.issueId !== receipt.issueId || nativeReportDigest(receipt.input) !== nativeReportDigest(payload) || nativeReportDigest(receipt.evidence) !== nativeReportDigest([])) throw new Error("Native report outbox no longer matches its immutable origin");
  return { receipt, event, origin, fingerprint: nativeReportDigest(event) };
}
