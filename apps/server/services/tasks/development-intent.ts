import { z } from "zod";
import type { PrismaClient, RemoteTask, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { finalizationDigest, finalizationResourceIdentity, type FinalizationResourceRecord } from "./finalization-resources.ts";
import { CompletionContractInput } from "./completion.ts";
import { readDevelopmentJson, retainedDevelopmentIds } from "./development-selection.ts";

import { AutomationInput, DevelopmentAuthority, DevelopmentAuthorityInput, DevelopmentCompleteInput, DevelopmentProjection, DevelopmentReference, RuntimeSuspension } from "../../../../lib/development-intent.ts";
import { assertComputeEvidence, computeEvidenceMatches, refreshComputeObservation } from "./compute-observation.ts";
export { AutomationInput, DevelopmentAuthority, DevelopmentAuthorityInput, DevelopmentCompleteInput, DevelopmentProjection, DevelopmentReference } from "../../../../lib/development-intent.ts";
const Digest = DevelopmentReference.shape.intentDigest;
const Key = DevelopmentProjection.shape.requestKey;
const Review = DevelopmentProjection.shape.review.unwrap();
type IntentRequest = Extract<z.infer<typeof AutomationInput>, { requestKey: string }>;
const Intent = z.object({ version: z.literal(1), identityDigest: Digest, requestKey: Key,
  action: z.enum(["stop", "resume"]), reason: z.enum(["owner-pause", "owner-resume", "review-handoff", "runtime-suspended"]), review: Review.optional(),
  suspension: RuntimeSuspension.optional(),
}).strict();
const IntentAction = "development-compute-intent", CompleteAction = "development-compute-complete";
const SupersededAction = "development-compute-superseded";
type Database = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeInstruction" | "runtimeLifecycleEvent" | "remoteTaskResource" | "runtimeMetadataEvent" | "computeEnvironment" | "computeTraffic" | "computeOffer" | "computeSlot">;
type Context = { prisma: Database; config: ServerConfig; taskId: string; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">;
  refreshCompute?: typeof refreshComputeObservation };
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
const resourceSnapshot = (resources: RemoteTaskResource[]) => finalizationDigest(resources.map(resource => ({
  ...finalizationResourceIdentity(resource), state: resource.state,
})).sort((a, b) => a.key.localeCompare(b.key)));
const epoch = (resources: RemoteTaskResource[]) => resourceSnapshot(resources.filter(resource => resource.purpose === "development"));

export class DevelopmentWorkUnavailable extends Error {}

export async function assertDevelopmentWork(input: { prisma: Pick<Database, "runtimeMetadataEvent"> }, task: RemoteTask) {
  const where = { runtimeSessionId: task.primarySessionId! };
  const transport = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, source: "runtime", action: "cleanup-provider-transport" }, orderBy: { sequence: "desc" } });
  if (transport && z.object({ mode: z.enum(["work", "cleanup"]) }).parse(JSON.parse(transport.value!)).mode !== "work") throw new DevelopmentWorkUnavailable("Development resume requires the existing explicit return-to-work transition");
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
  if (!revoked) throw new DevelopmentWorkUnavailable("Development resume cannot restart compute while cleanup authority remains active");
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

async function superseded(prisma: Database, task: RemoteTask, revision: number) {
  return Boolean(await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId!, source: source(task.id),
    action: SupersededAction, sequence: { gt: revision } } }));
}

/** Called in the decision transaction after fresh evidence. This never changes
 * an owner pause, grants closure, or selects another environment's compute. */
export async function recordRuntimeSuspension(input: Context & { requestKey: string; suspension: z.infer<typeof RuntimeSuspension> }) {
  const suspension = RuntimeSuspension.parse(input.suspension), owned = await ownership(input);
  if (owned.task.ownerPaused || owned.task.phase === "complete") throw new Error("Automatic suspension requires an open unpaused task");
  await assertDevelopmentWork(input, owned.task);
  const observed = await assertComputeEvidence({ ...input, ...suspension });
  if (observed.evidence.task.id !== owned.task.id || observed.evidence.task.purpose !== "development"
    || observed.resource.id !== suspension.resourceId || observed.resource.key !== suspension.resourceKey || observed.resource.identityDigest !== suspension.resourceIdentity) throw new Error("Automatic suspension resource scope changed");
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(owned.task), orderBy: { sequence: "desc" } });
  const existing = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...eventWhere(owned.task), key: input.requestKey }, orderBy: { sequence: "desc" } });
  const value = Intent.parse({ version: 1, identityDigest: owned.identityDigest, requestKey: input.requestKey, action: "stop", reason: "runtime-suspended", suspension });
  if (existing) {
    if (existing.sequence !== prior?.sequence || existing.value !== JSON.stringify(value) || await superseded(input.prisma, owned.task, existing.sequence)) throw new Error("Automatic suspension was superseded or changed");
    return { intentRevision: existing.sequence, intentDigest: finalizationDigest(value) };
  }
  if (prior?.value && !await superseded(input.prisma, owned.task, prior.sequence)) {
    const previous = Intent.parse(JSON.parse(prior.value));
    const complete = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owned.primary.id, source: source(owned.task.id), action: CompleteAction, key: prior.key } });
    const completed = complete?.value ? z.object({ intentRevision: z.literal(prior.sequence), intentDigest: z.literal(finalizationDigest(previous)) }).safeParse(JSON.parse(complete.value)).success : false;
    // Fresh activity can invalidate an unfinished automatic stop. A later
    // measured quiet period may replace it; explicit pending owner work may
    // not be superseded merely because a classifier chose suspension.
    if (previous.reason !== "runtime-suspended" && !completed) throw new Error("Automatic suspension cannot replace pending development work");
    if (previous.suspension && previous.suspension.environmentId !== suspension.environmentId && !completed) {
      const valid = await computeEvidenceMatches({ ...input, ...previous.suspension, allowStopped: true });
      if (valid) throw new Error("Automatic suspension waits for the other environment's pending stop");
    }
  }
  const saved = await input.prisma.runtimeMetadataEvent.create({ data: { ...eventWhere(owned.task), key: input.requestKey, value: JSON.stringify(value) } });
  return { intentRevision: saved.sequence, intentDigest: finalizationDigest(value) };
}

/** Admission calls this inside the same transaction as its successful claim.
 * Neither maintenance unpause nor ordinary owner resume can forge this fact. */
export async function supersedeRuntimeSuspension(prisma: Database, taskId: string, environmentId: string, offerId: string) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(task), orderBy: { sequence: "desc" } });
  if (!event?.value) return;
  const value = Intent.parse(JSON.parse(event.value));
  if (value.reason !== "runtime-suspended" || await superseded(prisma, task, event.sequence)) return;
  const offer = await prisma.computeOffer.findUnique({ where: { id: offerId } });
  const environment = await prisma.computeEnvironment.findUnique({ where: { id: environmentId } });
  if (task.ownerPaused || task.phase === "closed" || !value.suspension || value.suspension.environmentId !== environmentId
    || !offer || offer.environmentId !== environmentId || offer.state !== "claimed" || !offer.claimedAt
    || !environment || environment.taskId !== taskId || environment.primarySessionId !== task.primarySessionId || environment.state !== "starting"
    || !await prisma.computeSlot.findFirst({ where: { allocationId: offerId, machineId: task.machineId } })) throw new Error("Suspended compute requires its exact allocated claim");
  await prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: task.primarySessionId!, source: source(taskId), action: SupersededAction, key: offerId,
    value: JSON.stringify({ version: 1, intentRevision: event.sequence, intentDigest: finalizationDigest(value), environmentId, offerId }) } });
}

/** Both the first claim and every start-effect renewal use this guard. A
 * previously claimed offer cannot override a later owner or review stop. */
export async function assertComputeStartIntent(prisma: Database, taskId: string, environmentId: string, offerId: string) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const environment = await prisma.computeEnvironment.findUnique({ where: { id: environmentId } });
  const offer = await prisma.computeOffer.findUnique({ where: { id: offerId } });
  if (task.ownerPaused || ["closed", "complete"].includes(task.phase) || !task.primarySessionId
    || !environment || environment.taskId !== task.id || environment.primarySessionId !== task.primarySessionId || environment.machineId !== task.machineId
    || !offer || offer.environmentId !== environment.id || offer.machineId !== task.machineId || !offer.claimedAt || !["claimed", "running", "unknown"].includes(offer.state)
    || !await prisma.computeSlot.findFirst({ where: { allocationId: offer.id, machineId: task.machineId } })) throw new Error("Compute start requires its current allocated claim");
  const latest = await prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(task), orderBy: { sequence: "desc" } });
  if (latest?.value && Intent.parse(JSON.parse(latest.value)).action === "stop" && !await superseded(prisma, task, latest.sequence)) throw new Error("Compute start was superseded by a development stop");
}

async function current(input: Context, reference?: z.infer<typeof DevelopmentReference>) {
  const owned = await ownership(input);
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(owned.task), orderBy: { sequence: "desc" } });
  if (!event?.value) throw new Error("No explicit development intent is recorded");
  const value = Intent.parse(JSON.parse(event.value)), digest = finalizationDigest(value);
  if (await superseded(input.prisma, owned.task, event.sequence)) throw new Error("Development intent was superseded by a compute claim");
  if ((value.reason === "runtime-suspended") !== Boolean(value.suspension) || value.suspension && (value.action !== "stop" || value.review)) throw new Error("Development suspension scope is invalid");
  if (value.identityDigest !== owned.identityDigest || reference && (reference.intentRevision !== event.sequence || reference.intentDigest !== digest)) throw new Error("Development intent or original task identity changed");
  const intent = { revision: event.sequence, digest, requestKey: value.requestKey, action: value.action, reason: value.reason, ...(value.review ? { review: value.review } : {}), ...(value.suspension ? { suspension: value.suspension } : {}) };
  return { ...owned, event, value, intent };
}
export async function assertDevelopmentRequest(input: Context & z.infer<typeof DevelopmentReference>) {
  const active = await current(input, input);
  if (active.value.reason === "owner-pause" ? !active.task.ownerPaused : active.task.ownerPaused) throw new Error("Development intent does not match the current owner pause");
  if (active.value.action === "resume" && active.task.phase === "complete") throw new Error("A completed task cannot resume development services");
  if (active.value.action === "resume") await assertDevelopmentWork(input, active.task);
  if (active.value.review) await reviewIdentity(input, active.value.review);
  if (active.value.suspension) {
    await assertDevelopmentWork(input, active.task);
    const checked = await assertComputeEvidence({ ...input, ...active.value.suspension, allowStopped: true });
    if (checked.evidence.task.id !== active.task.id || checked.resource.id !== active.value.suspension.resourceId || checked.resource.key !== active.value.suspension.resourceKey
      || checked.resource.identityDigest !== active.value.suspension.resourceIdentity) throw new Error("Runtime suspension resource identity changed");
  }
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
async function selection(input: Context & z.infer<typeof DevelopmentReference>, read = readDevelopmentJson) {
  const before = await current(input, input);
  if (before.value.suspension) await (input.refreshCompute ?? refreshComputeObservation)({ prisma: input.prisma as PrismaClient, config: input.config, environmentId: before.value.suspension.environmentId });
  const active = await assertDevelopmentIntent(input);
  const records = await input.prisma.remoteTaskResource.findMany({ where: { taskId: active.task.id } });
  // Held local proof reads finish before a write transaction. The transaction
  // then rechecks the original identity, intent and complete resource epoch.
  const retained = await retainedDevelopmentIds(active.task, records, read);
  return { identityDigest: active.identityDigest, snapshot: resourceSnapshot(records), retained };
}
function selectedCompute(resource: RemoteTaskResource, value: z.infer<typeof Intent>) {
  const compute = developmentCompute(resource) || Boolean(value.suspension) && resource.purpose === "development" && resource.state !== "released" && resource.kind === "docker-compose-project";
  return compute && (!value.suspension || resource.id === value.suspension.resourceId && resource.key === value.suspension.resourceKey
    && finalizationResourceIdentity(resource).identityDigest === value.suspension.resourceIdentity);
}
export async function renewDevelopmentAuthority(input: Context & { prisma: PrismaClient } & z.infer<typeof DevelopmentAuthorityInput>, read = readDevelopmentJson) {
  DevelopmentAuthorityInput.parse({ intentRevision: input.intentRevision, intentDigest: input.intentDigest, resourceKeys: input.resourceKeys });
  const observed = await selection(input, read);
  return input.prisma.$transaction(async tx => {
    const active = await assertDevelopmentIntent({ ...input, prisma: tx });
    const records = await tx.remoteTaskResource.findMany({ where: { taskId: active.task.id } });
    if (active.identityDigest !== observed.identityDigest || resourceSnapshot(records) !== observed.snapshot) throw new Error("Development selection changed during proof inspection");
    const selected = records.filter(resource => input.resourceKeys.includes(resource.key));
    if (selected.length !== input.resourceKeys.length || selected.some(resource => !selectedCompute(resource, active.value) || observed.retained.has(resource.id))) throw new Error("Development authority requires exact current development compute");
    if (active.value.action === "resume" && input.config.compute?.enabled) {
      for (const resource of selected) {
        const environment = await tx.computeEnvironment.findFirst({ where: { taskId: active.task.id, resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest } });
        const offers = environment && await tx.computeOffer.findMany({ where: { environmentId: environment.id, state: { in: ["claimed", "running", "unknown"] } }, take: 2 });
        if (!environment || !offers || offers.length !== 1) throw new Error("Development resume is waiting for its exact compute claim");
        await assertComputeStartIntent(tx, active.task.id, environment.id, offers[0]!.id);
      }
    }
    return DevelopmentAuthority.parse({ version: 1, task: { id: active.task.id, primarySessionId: active.primary.id, worktreePath: active.task.worktreePath, toolingRevision: active.task.toolingRevision },
      intent: active.intent, resourcesEpoch: epoch(records), resources: identities(selected) });
  });
}
export async function completeDevelopmentIntent(input: Context & { prisma: PrismaClient } & z.infer<typeof DevelopmentCompleteInput>, read = readDevelopmentJson) {
  const observed = await selection(input, read);
  return input.prisma.$transaction(async tx => {
    const active = await assertDevelopmentIntent({ ...input, prisma: tx });
    if (active.value.suspension) {
      const physical = await assertComputeEvidence({ ...input, prisma: tx, ...active.value.suspension, allowStopped: true });
      if (physical.physicalState !== "stopped") throw new Error("Runtime suspension completion requires physically stopped compute");
    }
    const records = await tx.remoteTaskResource.findMany({ where: { taskId: active.task.id } });
    if (active.identityDigest !== observed.identityDigest || resourceSnapshot(records) !== observed.snapshot) throw new Error("Development selection changed during proof inspection");
    const expected = identities(records.filter(resource => selectedCompute(resource, active.value) && !observed.retained.has(resource.id)));
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
  if (await superseded(input.prisma, task, event.sequence)) return {};
  let active: Awaited<ReturnType<typeof current>>;
  try { active = await current(input); } catch { return { developmentBlocked: "The saved development intent no longer matches the original task identity" }; }
  if (active.intent.reason !== "owner-pause") {
    try {
      if (active.task.phase === "complete") throw new Error("Task completed");
      await assertDevelopmentWork(input, active.task);
    } catch { return { developmentBlocked: "The saved development resume or review handoff is unavailable during cleanup or until work is restored" }; }
  }
  const records = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } });
  let retained: Set<string>;
  try { retained = await retainedDevelopmentIds(active.task, records); }
  catch { return { developmentIntent: DevelopmentProjection.parse({ version: 1, ...active.intent, state: "pending", blocked: "The saved retained development bindings could not be verified" }) }; }
  const complete = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: source(task.id), action: CompleteAction, key: active.value.requestKey }, orderBy: { sequence: "desc" } });
  const expected = JSON.stringify({ version: 1, intentRevision: active.intent.revision, intentDigest: active.intent.digest, resourcesEpoch: epoch(records), resources: identities(records.filter(resource => selectedCompute(resource, active.value) && !retained.has(resource.id))) });
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
function acknowledgmentAction(task: RemoteTask, value: z.infer<typeof Intent>, resource: RemoteTaskResource, state: string) {
  return value.action === "stop" ? value.reason === "owner-pause" && task.ownerPaused && state === "allocated"
    : !task.ownerPaused && (state === "ready" || resource.kind === "task-runtime" && state === resource.state);
}
type ResourceSelection = Awaited<ReturnType<typeof selection>> & z.infer<typeof DevelopmentReference>;
const retainedAppMarker = (resource: RemoteTaskResource) => resource.metadata !== null && typeof resource.metadata === "object" && Object.hasOwn(resource.metadata, "retainedStudio");

/** Only the existing cleanup acknowledgment exception needs a retained scope.
 * Inspect it before PUT opens its transaction; no local files are read in SQL. */
export async function developmentResourceSelection(input: Context & { sessionId: string }, key: string, state: string): Promise<ResourceSelection | undefined> {
  if (!["allocated", "ready"].includes(state)) return;
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (task.primarySessionId !== input.sessionId) return;
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(task), orderBy: { sequence: "desc" } });
  if (!event?.value) return;
  const operation = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: `finalizer:${task.id}`, action: "finalization-cleanup-started", key: `finalize:${task.id}` } });
  if (!operation) return;
  const records = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } }), resource = records.find(value => value.key === key);
  if (!resource || !developmentCompute(resource) || !records.some(retainedAppMarker)) return;
  const value = Intent.parse(JSON.parse(event.value));
  if (!acknowledgmentAction(task, value, resource, state)) return;
  const reference = { intentRevision: event.sequence, intentDigest: finalizationDigest(value) };
  return { ...await selection({ ...input, ...reference }), ...reference };
}

/** Explicit intent may acknowledge stopped compute, or the same saved compute
 * after cleanup has been revoked and work restored. No receipt is Released or
 * resurrected, and the original preparation/operation bytes are never changed. */
export async function developmentResourceUpdate(input: Context & { sessionId: string }, resource: RemoteTaskResource,
  next: { state: string; metadata?: unknown; expiresAt: Date | null }, scope?: ResourceSelection) {
  if (!["allocated", "ready"].includes(next.state) || !developmentCompute(resource) || resource.state === "released") return false;
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (task.primarySessionId !== input.sessionId) return false;
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: eventWhere(task), orderBy: { sequence: "desc" } });
  if (!event?.value) return false;
  const value = Intent.parse(JSON.parse(event.value));
  if (!acknowledgmentAction(task, value, resource, next.state)) return false;
  const { inspectSavedCleanup } = await import("./cleanup-inspection.ts");
  const saved = await inspectSavedCleanup(input.prisma, task.id);
  if (!saved) return false;
  const records = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } });
  if (scope || records.some(retainedAppMarker)) {
    if (!scope || scope.intentRevision !== event.sequence || scope.intentDigest !== finalizationDigest(value)
      || resourceSnapshot(records) !== scope.snapshot || scope.retained.has(resource.id)) throw new Error("Development acknowledgment is outside the verified current app selection");
  }
  const binding = saved.operation.binding;
  const original = binding.resources.find(record => record.id === resource.id);
  if (saved.history.recordedConfirmationRevision || !original || original.state === "released" || !sameDevelopmentIdentity(original, resource, true)
    || binding.sessionId !== task.primarySessionId || binding.worktree !== task.worktreePath || binding.branch !== task.branchName || binding.repositoryId !== task.repositoryId
    || binding.machineId !== task.machineId || binding.toolingRevision !== task.toolingRevision || binding.toolingRoot !== task.toolingRoot || binding.pinnedToolingRoot !== task.pinnedToolingRoot) throw new Error("Development acknowledgment does not match the original cleanup resource");
  const active = await assertDevelopmentIntent({ ...input, intentRevision: event.sequence, intentDigest: finalizationDigest(value) });
  if (scope && active.identityDigest !== scope.identityDigest) throw new Error("Development acknowledgment task identity changed");
  const updated = { ...resource, state: next.state, metadata: next.metadata ?? resource.metadata, expiresAt: next.expiresAt };
  if (!sameDevelopmentIdentity(resource, updated, active.intent.action === "resume")) throw new Error("Development acknowledgment cannot change saved resource identity or metadata");
  return true;
}
