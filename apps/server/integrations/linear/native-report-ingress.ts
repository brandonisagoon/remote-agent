import { z } from "zod";
import { LinearCommentGeneration, observeLinearCommentGeneration, classifyLinearCommentGeneration } from "./comment-generation.ts";
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

const LegacyInitial = z.object({ createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), authorId: z.string().min(1), bodyDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Initial = z.union([z.object({ version: z.literal(2), authorId: z.string().min(1), bodyDigest: z.string().regex(/^[a-f0-9]{64}$/), providerGeneration: LinearCommentGeneration.extend({ editedAt: z.null() }) }).strict(), LegacyInitial]);
type Witness = z.infer<typeof Initial>;

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
  const previousValue = old[0]?.value ?? null;
  const previousRevision = old[0]?.sequence ?? null;
  const initial = old.length ? Initial.parse(JSON.parse(previousValue!)) : null;
  const result = (informational: boolean, revision: string, authorId: string, nextInitial: Witness | null = null) => ({ ...saved, informational, revision, authorId, previousValue, previousRevision, nextInitial });
  const actor = webhook.actor?.id;
  const subscribed = actor && config.webhooks[config.activeWebhookId]?.repositoryRouting[config.activeRepositoryId]?.when?.some(rule => rule["linear.userId"]?.includes(actor));
  if (webhook.action === "create") {
    if (data.body !== origin.request.body) throw new Error("Native report create does not match the reserved publication");
    if (initial && !("version" in initial)) {
      if (nativeReportDigest(initial) !== nativeReportDigest(generation)) throw new Error("Native report create does not match the reserved publication");
      return result(true, `${data.createdAt}:${data.updatedAt}`, creator);
    }
  } else if (!subscribed) throw new Error("Native report edit has no subscribed human actor");

  const current = await readDeliveryComment(config.linearApiKey, data.id);
  if (!current || current.id !== data.id || current.issue?.id !== origin.issueId || current.user?.id !== creator || current.parentId || current.createdAt !== data.createdAt || !current.updatedAt || Date.parse(current.updatedAt) < Date.parse(data.updatedAt)) throw new Error("Native report edit changed during provider observation");
  if (webhook.action === "update" && (current.body !== data.body || current.updatedAt !== data.updatedAt)) throw new Error("Native report edit changed during provider observation");
  if (initial && !("version" in initial)) {
    // Never rewrite or invent author-edit evidence for old raw witnesses.
    if (initial.createdAt !== data.createdAt || initial.authorId !== creator || Date.parse(data.updatedAt) <= Date.parse(initial.updatedAt)) throw new Error("Native report edit is not a later provider generation");
    return result(false, `${data.createdAt}:${data.updatedAt}`, actor!);
  }
  const providerGeneration = observeLinearCommentGeneration(current);
  if (initial && (initial.authorId !== creator || initial.bodyDigest !== nativeReportDigest(origin.request.body) || initial.providerGeneration.createdAt !== data.createdAt)) throw new Error("Native report initial generation changed");
  const samePublication = current.body === origin.request.body;
  const revision = `${providerGeneration.createdAt}:author-edit:${providerGeneration.editedAt ?? "none"}`;
  if (webhook.action === "create") {
    // A delayed signed original create remains the reserved publication, even
    // after a human edit was delivered first. Do not invent an unedited witness.
    if (providerGeneration.editedAt !== null) {
      if (initial) classifyLinearCommentGeneration(initial.providerGeneration, providerGeneration, samePublication);
      if (Date.parse(providerGeneration.editedAt) <= Date.parse(providerGeneration.createdAt)) throw new Error("Native report edit generation is unavailable");
      return result(true, revision, creator);
    }
    if (!samePublication) throw new Error("Native report create changed during provider observation");
  }
  if (initial) {
    const classified = classifyLinearCommentGeneration(initial.providerGeneration, providerGeneration, samePublication);
    return result(classified.informational, classified.revision, classified.informational ? creator : actor!);
  }
  if (providerGeneration.editedAt === null) {
    if (!samePublication) throw new Error("Native report unedited content changed");
    return result(true, revision, creator, { version: 2, authorId: creator, bodyDigest: nativeReportDigest(origin.request.body), providerGeneration: { ...providerGeneration, editedAt: null } });
  }
  if (Date.parse(providerGeneration.editedAt) <= Date.parse(providerGeneration.createdAt)) throw new Error("Native report edit generation is unavailable");
  return result(false, revision, actor!);
}

export type NativeReportWebhook = NonNullable<Awaited<ReturnType<typeof observeNativeReportWebhook>>>;
/** DB-only CAS inside the existing ingress transaction. No provider work here. */
export async function assertNativeReportWebhook(store: Store, observed: NativeReportWebhook) {
  const current = await readNativeReportOrigin(store, observed.origin.connectionId, observed.origin.commentId);
  if (current?.fingerprint !== observed.fingerprint) throw new Error("Native report provenance changed during ingress");
  const rows = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: observed.origin.sessionId, action: GENERATION, source: "native-report-webhook", key: observed.origin.commentId } });
  if (rows.length > 1 || (rows[0]?.sequence ?? null) !== observed.previousRevision || (rows[0]?.value ?? null) !== observed.previousValue) throw new Error("Native report initial generation changed");
  if (observed.nextInitial) {
    if (rows.length || !observed.informational) throw new Error("Native report initial generation changed");
    await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: observed.origin.sessionId, action: GENERATION, source: "native-report-webhook", key: observed.origin.commentId, value: JSON.stringify(observed.nextInitial) } });
  }
}
