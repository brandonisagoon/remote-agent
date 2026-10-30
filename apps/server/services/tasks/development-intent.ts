import { z } from "zod";
import type { PrismaClient, RemoteTask, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { finalizationDigest, finalizationResourceIdentity, type FinalizationResourceRecord } from "./finalization-resources.ts";
import { CompletionContractInput } from "./completion.ts";

import { AutomationInput, DevelopmentAuthority, DevelopmentAuthorityInput, DevelopmentCompleteInput, DevelopmentProjection, DevelopmentReference } from "../../../../lib/development-intent.ts";
export { AutomationInput, DevelopmentAuthority, DevelopmentAuthorityInput, DevelopmentCompleteInput, DevelopmentProjection, DevelopmentReference } from "../../../../lib/development-intent.ts";
const Digest = DevelopmentReference.shape.intentDigest;
const Key = DevelopmentProjection.shape.requestKey;
const Review = DevelopmentProjection.shape.review.unwrap();
type IntentRequest = Extract<z.infer<typeof AutomationInput>, { requestKey: string }>;
const Intent = z.object({ version: z.literal(1), identityDigest: Digest, requestKey: Key,
  action: z.enum(["stop", "resume"]), reason: z.enum(["owner-pause", "owner-resume", "review-handoff"]), review: Review.optional(),
}).strict();
const IntentAction = "development-compute-intent", CompleteAction = "development-compute-complete";
type Database = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeInstruction" | "runtimeLifecycleEvent" | "remoteTaskResource" | "runtimeMetadataEvent">;
type Context = { prisma: Database; config: ServerConfig; taskId: string; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity"> };
const source = (taskId: string) => `development:${taskId}`;
const eventWhere = (task: Pick<RemoteTask, "id" | "primarySessionId">) => ({ runtimeSessionId: task.primarySessionId!, source: source(task.id), action: IntentAction });

/** The intent selects compute only. Data, review resources and public routes
 * are never targets of development stop/resume. Legacy envelopes are resolved
 * to their concrete members by the existing adapters. */
export function developmentCompute(resource: Pick<RemoteTaskResource, "purpose" | "state" | "kind" | "metadata">) {
  if (resource.purpose !== "development" || resource.state === "released") return false;
  if (["native-app", "launch-agent", "launch-agents", "docker-container", "task-runtime"].includes(resource.kind)) return true;
  const metadata = resource.metadata as { pidFile?: unknown; observed?: { legacyNative?: unknown } } | null;
  return ["local-http", "local-process"].includes(resource.kind) && (typeof metadata?.pidFile === "string" || Boolean(metadata?.observed?.legacyNative));
}
const identities = (resources: RemoteTaskResource[]) => resources.map(resource => {
  const value = finalizationResourceIdentity(resource); return { id: value.id, key: value.key, identityDigest: value.identityDigest };
}).sort((a, b) => a.key.localeCompare(b.key));
const epoch = (resources: RemoteTaskResource[]) => finalizationDigest(resources.filter(resource => resource.purpose === "development").map(resource => ({
  ...finalizationResourceIdentity(resource), state: resource.state,
})).sort((a, b) => a.key.localeCompare(b.key)));

async function assertDevelopmentWork(input: Context, task: RemoteTask) {
  const where = { runtimeSessionId: task.primarySessionId! };
  const transport = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, source: "runtime", action: "cleanup-provider-transport" }, orderBy: { sequence: "desc" } });
  if (transport && z.object({ mode: z.enum(["work", "cleanup"]) }).parse(JSON.parse(transport.value!)).mode !== "work") throw new Error("Development resume requires the existing explicit return-to-work transition");
  const operation = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, source: `finalizer:${task.id}`, action: "finalization-cleanup-started", key: `finalize:${task.id}` }, orderBy: { sequence: "desc" } });
  if (!operation) return;
  // A historical operation stays in the journal after explicit revocation.
  // Merely changing phase, pausing, or restoring provider cwd is not revocation.
  const decision = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, source: `owner:${task.id}`, action: { in: [
    "completion-contract", "completion-verification", "completion-owner-approval", "completion-retirement-authority", "prepared-done-retirement", "delivered-retirement-revoked", "external-delivery-binding",
  ] } }, orderBy: { sequence: "desc" } });
  const value = decision?.value ? JSON.parse(decision.value) : null;
  const contract = decision?.action === "completion-contract" ? CompletionContractInput.safeParse(value) : undefined;
  const revoked = decision && decision.sequence > operation.sequence && (decision.action === "delivered-retirement-revoked"
    || contract?.success && contract.data.boundary !== "merge"
    || decision.action === "completion-retirement-authority" && value?.version === 1 && value?.action === "revoke");
  if (!revoked) throw new Error("Development resume cannot restart compute while cleanup authority remains active");
}

async function ownership(input: Context) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const primary = task.primarySessionId && await input.prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!primary || primary.role !== "primary" || primary.status === "closed" || task.phase === "closed" || !task.worktreePath || !task.toolingRevision
    || primary.cwd !== task.worktreePath || primary.repositoryId !== task.repositoryId || primary.machineId !== task.machineId || task.machineId !== input.config.machine) throw new Error("Development intent requires the original open task primary");
  let linkId: string | null = null;
  if (task.issueIdentifier) {
    if (!task.connectionId) throw new Error("Development source ownership is unavailable");
    const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: primary.id, provider: "linear", connectionId: task.connectionId,
      resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
    if (!link) throw new Error("Development source ownership was revoked");
    linkId = link.id;
  }
  return { task, primary, identityDigest: finalizationDigest({ id: task.id, primarySessionId: primary.id, repositoryId: task.repositoryId, machineId: task.machineId,
    worktreePath: task.worktreePath, branchName: task.branchName, baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision,
    pinnedToolingRoot: task.pinnedToolingRoot, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, linkId }) };
}
async function reviewIdentity(input: Context, reference: z.infer<typeof Review>) {
  const review = await input.prisma.remoteTaskResource.findUnique({ where: { id: reference.id } });
  if (!review || review.taskId !== input.taskId || review.key !== reference.key || review.purpose !== "review" || review.state !== "ready"
    || !["native-app", "task-runtime"].includes(review.kind) || !review.expiresAt || review.expiresAt.getTime() <= Date.now()
    || finalizationResourceIdentity(review).identityDigest !== reference.identityDigest) throw new Error("Development handoff review ownership or lease changed");
  return review;
}

/** Explicit callers opt in. Maintenance's old pause/resume requests never
 * enter this function and never mint, supersede or resume compute intent. */
export async function recordDevelopmentIntent(input: Context & { prisma: PrismaClient; request: IntentRequest }) {
  return input.prisma.$transaction(async tx => {
    const context = { ...input, prisma: tx }, owned = await ownership(context), request = input.request;
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: eventWhere(owned.task), orderBy: { sequence: "desc" } });
    const existing = await tx.runtimeMetadataEvent.findFirst({ where: { ...eventWhere(owned.task), key: request.requestKey }, orderBy: { sequence: "desc" } });
    const action = request.action === "resume" ? "resume" : "stop";
    if (action === "resume" && owned.task.phase === "complete") throw new Error("A completed task cannot resume development services");
    if (action === "resume") await assertDevelopmentWork(context, owned.task);
    let review: z.infer<typeof Review> | undefined;
    if (request.action === "stop-development") {
      if (owned.task.ownerPaused) throw new Error("A review handoff cannot replace the owner's pause");
      const record = await tx.remoteTaskResource.findUnique({ where: { taskId_key: { taskId: owned.task.id, key: request.review.key } } });
      if (!record) throw new Error("Development handoff requires its exact saved review");
      review = { id: record.id, ...request.review }; await reviewIdentity(context, review);
      if (await tx.remoteTaskResource.findFirst({ where: { taskId: owned.task.id, purpose: "development", externalId: record.externalId } })) throw new Error("Development and review share the same runtime");
    }
    const value = Intent.parse({ version: 1, identityDigest: owned.identityDigest, requestKey: request.requestKey, action,
      reason: request.action === "stop-development" ? "review-handoff" : action === "stop" ? "owner-pause" : "owner-resume", ...(review ? { review } : {}) });
    if (existing) {
      if (existing.sequence !== prior?.sequence || existing.value !== JSON.stringify(value)) throw new Error("Development request was superseded or changed");
      const paused = value.reason === "owner-pause";
      if (request.action !== "stop-development" && owned.task.ownerPaused !== paused) throw new Error("Development request no longer matches the current owner pause");
      return { intentRevision: existing.sequence, intentDigest: finalizationDigest(value) };
    }
    if (request.action !== "stop-development") await tx.remoteTask.update({ where: { id: owned.task.id }, data: { ownerPaused: action === "stop" } });
    const saved = await tx.runtimeMetadataEvent.create({ data: { ...eventWhere(owned.task), key: request.requestKey, value: JSON.stringify(value) } });
    return { intentRevision: saved.sequence, intentDigest: finalizationDigest(value) };
  });
}

async function current(input: Context, reference?: z.infer<typeof DevelopmentReference>) {
  const owned = await ownership(input);
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(owned.task), orderBy: { sequence: "desc" } });
  if (!event?.value) throw new Error("No explicit development intent is recorded");
  const value = Intent.parse(JSON.parse(event.value)), digest = finalizationDigest(value);
  if (value.identityDigest !== owned.identityDigest || reference && (reference.intentRevision !== event.sequence || reference.intentDigest !== digest)) throw new Error("Development intent or original task identity changed");
  const intent = { revision: event.sequence, digest, requestKey: value.requestKey, action: value.action, reason: value.reason, ...(value.review ? { review: value.review } : {}) };
  return { ...owned, event, value, intent };
}
export async function assertDevelopmentRequest(input: Context & z.infer<typeof DevelopmentReference>) {
  const active = await current(input, input);
  if (active.value.reason === "owner-pause" ? !active.task.ownerPaused : active.task.ownerPaused) throw new Error("Development intent does not match the current owner pause");
  if (active.value.action === "resume" && active.task.phase === "complete") throw new Error("A completed task cannot resume development services");
  if (active.value.action === "resume") await assertDevelopmentWork(input, active.task);
  if (active.value.review) await reviewIdentity(input, active.value.review);
  return active;
}
export async function assertDevelopmentIntent(input: Context & z.infer<typeof DevelopmentReference>) {
  const active = await assertDevelopmentRequest(input);
  if (active.value.action === "stop") {
    const sessions = await input.prisma.runtimeSession.findMany({ where: { cwd: active.task.worktreePath!, status: { not: "closed" } } });
    let currentRequest: string | undefined;
    for (const session of sessions) {
      const executingPrimary = active.value.reason === "review-handoff" && session.id === active.primary.id && session.status === "active";
      if (session.repositoryId !== active.task.repositoryId || session.machineId !== active.task.machineId || !executingPrimary && session.status !== "idle") throw new Error("Development stop waits for owned agent work to settle");
      const activity = input.runtime?.observeSessionActivity?.(session.id);
      if (!executingPrimary && ["executing", "queued"].includes(activity?.state ?? "")) throw new Error("Development stop waits for owned agent work to settle");
      if (executingPrimary) {
        const turn = await input.prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } });
        if (!activity?.requestId || activity.state !== "executing" || turn?.phase !== "started" || turn.requestId !== activity.requestId) throw new Error("Development review handoff requires its current primary turn");
        currentRequest = activity.requestId;
      }
    }
    const unsettled = await input.prisma.runtimeInstruction.findMany({ where: { sessionId: { in: sessions.map(session => session.id) }, state: { in: ["preparing", "dispatching", "unknown"] } } });
    if (unsettled.some(instruction => instruction.state !== "dispatching" || instruction.sessionId !== active.primary.id || !currentRequest || instruction.executionRequestId !== currentRequest)) throw new Error("Development stop has unsettled agent instructions");
  }
  return active;
}
export async function renewDevelopmentAuthority(input: Context & { prisma: PrismaClient } & z.infer<typeof DevelopmentAuthorityInput>) {
  DevelopmentAuthorityInput.parse({ intentRevision: input.intentRevision, intentDigest: input.intentDigest, resourceKeys: input.resourceKeys });
  return input.prisma.$transaction(async tx => {
    const active = await assertDevelopmentIntent({ ...input, prisma: tx });
    const records = await tx.remoteTaskResource.findMany({ where: { taskId: active.task.id } });
    const selected = records.filter(resource => input.resourceKeys.includes(resource.key));
    if (selected.length !== input.resourceKeys.length || selected.some(resource => !developmentCompute(resource))) throw new Error("Development authority requires exact current development compute");
    return DevelopmentAuthority.parse({ version: 1, task: { id: active.task.id, primarySessionId: active.primary.id, worktreePath: active.task.worktreePath, toolingRevision: active.task.toolingRevision },
      intent: active.intent, resourcesEpoch: epoch(records), resources: identities(selected) });
  });
}
export async function completeDevelopmentIntent(input: Context & { prisma: PrismaClient } & z.infer<typeof DevelopmentCompleteInput>) {
  return input.prisma.$transaction(async tx => {
    const active = await assertDevelopmentIntent({ ...input, prisma: tx });
    const records = await tx.remoteTaskResource.findMany({ where: { taskId: active.task.id } });
    const expected = identities(records.filter(developmentCompute));
    if (epoch(records) !== input.resourcesEpoch || finalizationDigest(expected) !== finalizationDigest(input.resources)) throw new Error("Development completion resource membership or identity changed");
    const value = JSON.stringify({ version: 1, intentRevision: active.intent.revision, intentDigest: active.intent.digest, resourcesEpoch: input.resourcesEpoch, resources: expected });
    const where = { runtimeSessionId: active.primary.id, source: source(active.task.id), action: CompleteAction, key: active.value.requestKey };
    const prior = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    if (prior?.value !== value) await tx.runtimeMetadataEvent.create({ data: { ...where, value } });
    return DevelopmentProjection.parse({ version: 1, ...active.intent, state: "complete" });
  });
}
export async function developmentProjection(input: Context) {
  const task = await input.prisma.remoteTask.findUnique({ where: { id: input.taskId } });
  if (!task?.primarySessionId) return {};
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(task), orderBy: { sequence: "desc" } });
  if (!event?.value) return {};
  let active: Awaited<ReturnType<typeof current>>;
  try { active = await current(input); } catch { return { developmentBlocked: "The saved development intent no longer matches the original task identity" }; }
  if (active.intent.reason !== "owner-pause") {
    try {
      if (active.task.phase === "complete") throw new Error("Task completed");
      await assertDevelopmentWork(input, active.task);
    } catch { return { developmentBlocked: "The saved development resume or review handoff is unavailable during cleanup or until work is restored" }; }
  }
  const records = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } });
  const complete = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: source(task.id), action: CompleteAction, key: active.value.requestKey }, orderBy: { sequence: "desc" } });
  const expected = JSON.stringify({ version: 1, intentRevision: active.intent.revision, intentDigest: active.intent.digest, resourcesEpoch: epoch(records), resources: identities(records.filter(developmentCompute)) });
  return { developmentIntent: DevelopmentProjection.parse({ version: 1, ...active.intent, state: complete?.value === expected ? "complete" : "pending" }) };
}

const RuntimeProgress = z.object({ step: z.string(), detail: z.string(), state: z.enum(["running", "failed", "complete"]), updatedAt: z.string() }).strict();
function sameDevelopmentIdentity(original: FinalizationResourceRecord, updated: FinalizationResourceRecord, runtimeProgress: boolean) {
  if (finalizationResourceIdentity(original).identityDigest === finalizationResourceIdentity(updated).identityDigest) return true;
  if (!runtimeProgress || original.kind !== "task-runtime") return false;
  const old = z.record(z.string(), z.unknown()).safeParse(original.metadata), next = z.record(z.string(), z.unknown()).safeParse(updated.metadata);
  if (!old.success || !next.success || !RuntimeProgress.safeParse(next.data.progress).success) return false;
  // Runtime resume updates its existing progress projection. Recipe, provider,
  // container, network, volume and every other immutable field stay exact.
  return finalizationResourceIdentity(original).identityDigest === finalizationResourceIdentity({ ...updated, metadata: { ...next.data, progress: old.data.progress } }).identityDigest;
}

/** Explicit intent may acknowledge stopped compute, or the same saved compute
 * after cleanup has been revoked and work restored. No receipt is Released or
 * resurrected, and the original preparation/operation bytes are never changed. */
export async function developmentResourceUpdate(input: Context & { sessionId: string }, resource: RemoteTaskResource,
  next: { state: string; metadata?: unknown; expiresAt: Date | null }) {
  if (!["allocated", "ready"].includes(next.state) || !developmentCompute(resource) || resource.state === "released") return false;
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (task.primarySessionId !== input.sessionId) return false;
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(task), orderBy: { sequence: "desc" } });
  if (!event?.value) return false;
  const value = Intent.parse(JSON.parse(event.value));
  if (value.action === "stop" ? value.reason !== "owner-pause" || !task.ownerPaused || next.state !== "allocated"
    : task.ownerPaused || next.state !== "ready" && !(resource.kind === "task-runtime" && next.state === resource.state)) return false;
  const { inspectSavedCleanup } = await import("./cleanup-inspection.ts");
  const saved = await inspectSavedCleanup(input.prisma, task.id);
  if (!saved) return false;
  const binding = saved.operation.binding;
  const original = binding.resources.find(record => record.id === resource.id);
  if (saved.history.recordedConfirmationRevision || !original || original.state === "released" || !sameDevelopmentIdentity(original, resource, true)
    || binding.sessionId !== task.primarySessionId || binding.worktree !== task.worktreePath || binding.branch !== task.branchName || binding.repositoryId !== task.repositoryId
    || binding.machineId !== task.machineId || binding.toolingRevision !== task.toolingRevision || binding.toolingRoot !== task.toolingRoot || binding.pinnedToolingRoot !== task.pinnedToolingRoot) throw new Error("Development acknowledgment does not match the original cleanup resource");
  const active = await assertDevelopmentIntent({ ...input, intentRevision: event.sequence, intentDigest: finalizationDigest(value) });
  const updated = { ...resource, state: next.state, metadata: next.metadata ?? resource.metadata, expiresAt: next.expiresAt };
  if (!sameDevelopmentIdentity(resource, updated, active.intent.action === "resume")) throw new Error("Development acknowledgment cannot change saved resource identity or metadata");
  return true;
}
