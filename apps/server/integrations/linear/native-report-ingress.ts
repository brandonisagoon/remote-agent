import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { nativeReportDigest, readNativeReportOrigin } from "../../services/sessions/native-report-origin.ts";
import { readDeliveryComment } from "./comment-context.ts";
import type { LinearCommentWebhook } from "./webhook-types/comment.ts";

type Store = Pick<PrismaClient, "runtimeIssueUpdate" | "runtimeMetadataEvent">;
const GENERATION = "native-report-created";

/** Only a registered native outbox allows an update's signed actor to replace
 * its creator for subscription routing. Ordinary comment routing is unchanged. */
export async function nativeReportRoutingActor(store: Store, machineId: string, connectionId: string, webhook: unknown) {
  const parsed = webhook as Partial<LinearCommentWebhook>;
  if (parsed.type !== "Comment" || parsed.action !== "update" || typeof parsed.data?.id !== "string" || typeof parsed.actor?.id !== "string") return null;
  const saved = await readNativeReportOrigin(store, connectionId, parsed.data.id);
  if (!saved || saved.origin.machineId !== machineId || (parsed.data.issueId ?? parsed.data.issue?.id) !== saved.origin.issueId) return null;
  return parsed.actor.id;
}

export async function observeNativeReportWebhook(store: Store, config: ServerConfig, webhook: LinearCommentWebhook) {
  const saved = await readNativeReportOrigin(store, config.activeConnectionId, webhook.data.id);
  if (!saved) return null;
  const { origin } = saved; const data = webhook.data;
  if (origin.machineId !== config.machine || origin.repositoryId !== config.activeRepositoryId || origin.issueId !== (data.issueId ?? data.issue?.id) || origin.issueIdentifier !== data.issue?.identifier || data.parentId) throw new Error("Native report webhook has a different source scope");
  const creator = data.userId ?? data.user?.id;
  if (!creator || !data.createdAt || !data.updatedAt || !Number.isFinite(Date.parse(data.createdAt)) || !Number.isFinite(Date.parse(data.updatedAt)) || Date.parse(data.createdAt) > Date.now() || Date.parse(data.updatedAt) > Date.now()) throw new Error("Native report webhook needs its exact provider generation");
  const generation = { createdAt: data.createdAt, updatedAt: data.updatedAt, authorId: creator, bodyDigest: nativeReportDigest(data.body) };
  const old = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: origin.sessionId, action: GENERATION, source: "native-report-webhook", key: origin.commentId } });
  if (old.length > 1) throw new Error("Native report has ambiguous initial generation");
  const initial = old[0]?.value ? JSON.parse(old[0].value) as typeof generation : null;
  if (webhook.action === "create") {
    if (data.body !== origin.request.body || (initial && nativeReportDigest(initial) !== nativeReportDigest(generation))) throw new Error("Native report create does not match the reserved publication");
    return { ...saved, informational: true as const, generation, revision: `${data.createdAt}:${data.updatedAt}`, authorId: creator };
  }
  const actor = webhook.actor?.id;
  const subscribed = actor && config.webhooks[config.activeWebhookId]?.repositoryRouting[config.activeRepositoryId]?.when?.some(rule => rule["linear.userId"]?.includes(actor));
  if (!subscribed) throw new Error("Native report edit has no subscribed human actor");
  const current = await readDeliveryComment(config.linearApiKey, data.id);
  if (!current || current.id !== data.id || current.issue?.id !== origin.issueId || current.user?.id !== creator || current.parentId || current.body !== data.body || current.createdAt !== data.createdAt || current.updatedAt !== data.updatedAt) throw new Error("Native report edit changed during provider observation");
  if (initial && (initial.createdAt !== data.createdAt || initial.authorId !== creator || Date.parse(data.updatedAt) <= Date.parse(initial.updatedAt))) throw new Error("Native report edit is not a later provider generation");
  return { ...saved, informational: false as const, generation, revision: `${data.createdAt}:${data.updatedAt}`, authorId: actor! };
}

export type NativeReportWebhook = NonNullable<Awaited<ReturnType<typeof observeNativeReportWebhook>>>;
/** DB-only CAS inside the existing ingress transaction. No provider work here. */
export async function assertNativeReportWebhook(store: Store, observed: NativeReportWebhook) {
  const current = await readNativeReportOrigin(store, observed.origin.connectionId, observed.origin.commentId);
  if (current?.fingerprint !== observed.fingerprint) throw new Error("Native report provenance changed during ingress");
  const rows = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: observed.origin.sessionId, action: GENERATION, source: "native-report-webhook", key: observed.origin.commentId } });
  if (rows.length > 1) throw new Error("Native report has ambiguous initial generation");
  const old = rows[0]?.value ? JSON.parse(rows[0].value) as NativeReportWebhook["generation"] : null;
  if (observed.informational) {
    if (old && nativeReportDigest(old) !== nativeReportDigest(observed.generation)) throw new Error("Native report initial generation changed");
    if (!old) await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: observed.origin.sessionId, action: GENERATION, source: "native-report-webhook", key: observed.origin.commentId, value: JSON.stringify(observed.generation) } });
  } else if (old && (old.createdAt !== observed.generation.createdAt || old.authorId !== observed.generation.authorId || Date.parse(observed.generation.updatedAt) <= Date.parse(old.updatedAt))) throw new Error("Native report edit generation changed");
}
