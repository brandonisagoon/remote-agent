import { assertNoRemainingConsumers } from "./work-map-state.ts";
import { automaticCleanupTurn, AutomaticCleanup, type CleanupInboxStore } from "./cleanup-inbox.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { FINALIZATION_PREPARED, FINALIZATION_CONFIRMED, PreparedFinalization } from "./finalization-receipts.ts";
import { RetirementBinding, RetirementGrant, retirementDigest } from "./retirement-receipts.ts";
import { normalizeRetirementPreviewTransition } from "./retirement-preview.ts";
import { DoneRetirementGrant } from "./delivered-retirement.ts";
import { inspectExternalCleanupAuthority } from "./external-cleanup-authority.ts";
import type { PreparedExternalFinalization } from "./external-finalization-schema.ts";
import { cleanupDeliveryRetention } from "./cleanup-delivery-reference.ts";

export const CLEANUP_OPERATION = "finalization-cleanup-started";
export const CLEANUP_EVIDENCE_SUPPLEMENT = "finalization-cleanup-evidence-supplement";
type Database = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "remoteTaskResource" | "runtimeMetadataEvent">;
function inboxStore(prisma: Database): CleanupInboxStore {
  for (const model of ["runtimeInstruction", "runtimeLifecycleEvent", "runtimeSourceMessage"]) if (!(model in prisma)) throw new Error("Cleanup requires the full local instruction store");
  return prisma as unknown as CleanupInboxStore;
}
type Context = { prisma: Database; config: ServerConfig; sessionId: string; requestKey: string; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity"> };
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const EventReference = z.object({ revision: z.number().int().positive(), source: z.string(), action: z.string(), key: z.string().nullable(), digest: Digest }).strict();
const Resource = RetirementBinding.shape.resources.element;
const CleanupBinding = z.object({
  taskId: z.string(), sessionId: z.string(), repositoryId: z.string(), machineId: z.string(), connectionId: z.string(), issueIdentifier: z.string(),
  worktree: z.string(), branch: z.string(), baseCommit: z.string().nullable(), toolingRoot: z.string(), toolingRevision: z.string(), pinnedToolingRoot: z.string().nullable(), repositoryRoot: z.string(),
  preparedRevision: z.number().int().positive(), preparedDigest: Digest,
  authority: z.array(EventReference), resources: z.array(Resource).max(2000),
}).strict();
export const CleanupOperation = z.object({ version: z.literal(1), requestKey: z.string(), automatic: AutomaticCleanup.optional(), binding: CleanupBinding }).strict();
export type CleanupOperation = z.infer<typeof CleanupOperation>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerActions = ["completion-contract", "completion-verification", "completion-owner-approval", "completion-retirement-authority", "prepared-done-retirement", "delivered-retirement-revoked", "legacy-evidence-retained"];
function stableMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { observed: _observed, observedAt: _observedAt, ...stable } = value as Record<string, unknown>;
  return stable;
}

/** No provider, source issue, Git subprocess or filesystem observation belongs
 * in this check. Native batches use it while retaining their own held-target
 * checks. A status edit is not an owner revocation. */
async function current(input: Context, allowConfirmedClosed = false) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  await assertNoRemainingConsumers(input.prisma, task);
  const closed = task.phase === "closed" || session.status === "closed";
  if (!task.worktreePath || !task.connectionId || !task.issueIdentifier || task.ownerPaused || closed && !allowConfirmedClosed
    || session.role !== "primary" || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || task.machineId !== input.config.machine) throw new Error("Cleanup original ownership is changed, paused or closed");
  if (input.requestKey !== `finalize:${task.id}`) throw new Error("Cleanup requires the existing stable finalization identity");
  const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId,
    resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", ...(closed && allowConfirmedClosed ? {} : { endedAt: null }) } });
  if (!link) throw new Error("Cleanup original source ownership changed");
  const preparation = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, source: `finalizer:${task.id}`, action: FINALIZATION_PREPARED }, orderBy: { sequence: "desc" } });
  if (!preparation?.value || preparation.key !== input.requestKey) throw new Error("Cleanup requires the exact existing preparation");
  const raw = JSON.parse(preparation.value);
  if (raw.version === 2) {
    const external = await inspectExternalCleanupAuthority({ ...input, allowConfirmedClosed });
    const resources = (await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id }, orderBy: { id: "asc" } })).map(resource => Resource.parse({
      id: resource.id, key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId, state: resource.state,
      expiresAt: resource.expiresAt?.toISOString() ?? null, metadata: stableMetadata(resource.metadata),
    }));
    const binding = CleanupBinding.parse({ taskId: task.id, sessionId: session.id, repositoryId: task.repositoryId, machineId: task.machineId,
      connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, worktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit,
      toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, repositoryRoot: getRepositoryConfig(input.config, task.repositoryId).root,
      preparedRevision: preparation.sequence, preparedDigest: sha(preparation.value), resources,
      authority: external.authorityEvents.map(event => ({ revision: event.sequence, source: event.source, action: event.action, key: event.key, digest: sha(event.value ?? "") })),
    });
    return { kind: "v2" as const, ...external, binding, retirementSupplement: undefined };
  }
  if (raw.version !== undefined) throw new Error("Prepared lifecycle currently requires version 1 preparation");
  const prepared = PreparedFinalization.parse(raw);
  if (allowConfirmedClosed) {
    const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED, key: input.requestKey } });
    if (!confirmed || JSON.parse(confirmed.value ?? "null")?.preparedRevision !== preparation.sequence) throw new Error("Closed cleanup reporting requires its exact confirmed preparation");
  }
  if (prepared.taskId !== task.id || prepared.sessionId !== session.id || prepared.requestKey !== input.requestKey || prepared.repositoryId !== task.repositoryId
    || prepared.machineId !== task.machineId || prepared.connectionId !== task.connectionId || prepared.issueIdentifier !== task.issueIdentifier
    || prepared.taskWorktree !== task.worktreePath || prepared.branch !== task.branchName) throw new Error("Cleanup preparation belongs to another original task identity");
  const records = await input.prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: session.id, OR: [
    { source: `owner:${task.id}`, action: { in: ownerActions } },
    { source: `finalizer-archives:${task.id}`, action: "finalization-archive-retention" },
  ] }, orderBy: { sequence: "desc" } });
  const latest = records.filter((event, index) => records.findIndex(candidate => candidate.action === event.action && candidate.source === event.source) === index);
  const contract = latest.find(event => event.action === "completion-contract"), policy = JSON.parse(contract?.value ?? "null");
  if (!contract || contract.sequence !== prepared.contractRevision || policy?.boundary !== "merge") throw new Error("Cleanup accepted completion authority was revoked or replaced");
  const receipt = prepared.delivery.receipts;
  if (prepared.delivery.boundary !== "merge" || receipt.contractRevision !== contract.sequence || !receipt.snapshot.clean || receipt.snapshot.head !== prepared.revision
    || receipt.snapshot.branch !== prepared.branch || !receipt.commit.observed || receipt.commit.sha !== prepared.revision || !receipt.commit.clean
    || !receipt.pullRequest.observed || !receipt.pullRequest.matchesHead || !receipt.merge.observed || !receipt.merge.merged || !receipt.merge.sha) throw new Error("Cleanup has no accepted server-observed delivery");
  const verification = latest.find(event => event.action === "completion-verification"), verified = JSON.parse(verification?.value ?? "null");
  if (policy.verificationRequired !== false && (!verification || verification.sequence > preparation.sequence || verified?.contractRevision !== contract.sequence
    || verified.verification?.passed !== true || verified.snapshot?.fingerprint !== receipt.snapshot.fingerprint || !receipt.verification.matched)) throw new Error("Cleanup accepted verification changed");
  const retirement = latest.find(event => event.action === "completion-retirement-authority"), done = latest.find(event => event.action === "prepared-done-retirement");
  const revoked = latest.find(event => event.action === "delivered-retirement-revoked");
  if (retirement && !RetirementGrant.safeParse(JSON.parse(retirement.value ?? "null")).success || revoked && (!done || revoked.sequence > done.sequence)) throw new Error("Cleanup retirement authority was explicitly revoked");
  if (prepared.retirementAuthority && (!retirement || retirement.sequence !== prepared.retirementAuthority.revision || retirementDigest(JSON.parse(retirement.value!)) !== prepared.retirementAuthority.digest)) throw new Error("Cleanup original retirement grant changed");
  const resources = (await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id }, orderBy: { id: "asc" } })).map(resource => Resource.parse({
    id: resource.id, key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId, state: resource.state,
    expiresAt: resource.expiresAt?.toISOString() ?? null, metadata: stableMetadata(resource.metadata),
  }));
  const binding = CleanupBinding.parse({ taskId: task.id, sessionId: session.id, repositoryId: task.repositoryId, machineId: task.machineId,
    connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, worktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit,
    toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, repositoryRoot: getRepositoryConfig(input.config, task.repositoryId).root,
    preparedRevision: preparation.sequence, preparedDigest: sha(preparation.value), resources,
    authority: latest.map(event => ({ revision: event.sequence, source: event.source, action: event.action, key: event.key, digest: sha(event.value ?? "") })).sort((a, b) => a.revision - b.revision),
  });
  // A historical grant has stronger identity/resource evidence than the old
  // preparation. Never rebind around a changed or revoked grant.
  for (const grant of [retirement ? RetirementGrant.parse(JSON.parse(retirement.value!)) : null, done ? DoneRetirementGrant.parse(JSON.parse(done.value!)) : null]) {
    if (!grant) continue;
    const saved = grant.binding;
    if (saved.taskId !== task.id || saved.sessionId !== session.id || saved.issueId !== prepared.issueId || saved.repositoryId !== binding.repositoryId || saved.machineId !== binding.machineId
      || saved.connectionId !== binding.connectionId || saved.issueIdentifier !== binding.issueIdentifier || saved.taskWorktree !== binding.worktree || saved.branch !== binding.branch
      || saved.baseCommit !== binding.baseCommit || saved.toolingRoot !== binding.toolingRoot || saved.toolingRevision !== binding.toolingRevision || saved.pinnedToolingRoot !== binding.pinnedToolingRoot
      || saved.contractRevision !== contract.sequence || saved.contractDigest !== retirementDigest(policy) || saved.verificationRevision !== verification?.sequence || saved.verificationDigest !== retirementDigest(verified)) throw new Error("Cleanup original retirement identity changed");
    assertResources(resources, saved.resources);
    if ("preparedRevision" in grant && (grant.preparedRevision !== preparation.sequence || grant.preparedDigest !== binding.preparedDigest)) throw new Error("Cleanup Done supplement preparation changed");
  }
  return { kind: "v1" as const, task, prepared, preparation, binding, retirementSupplement: done ? { revision: done.sequence, digest: retirementDigest(JSON.parse(done.value!)) } : undefined };
}

function assertResources(current: z.infer<typeof Resource>[], expected: z.infer<typeof Resource>[]) {
  if (current.length !== expected.length) throw new Error("Cleanup resource scope changed");
  for (let index = 0; index < current.length; index++) {
    const value = current[index]!, saved = expected[index]!;
    if (value.id !== saved.id || saved.state === "released" && value.state !== "released") throw new Error("Cleanup resource identity or terminal state changed");
    const metadata = retirementDigest(value.metadata) === retirementDigest(saved.metadata) ? value.metadata : normalizeRetirementPreviewTransition(saved, value, expected, current);
    if (retirementDigest({ ...value, state: saved.state, metadata }) !== retirementDigest(saved)) throw new Error("Cleanup resource identity or retained metadata changed");
  }
}
function assertBinding(current: z.infer<typeof CleanupBinding>, expected: z.infer<typeof CleanupBinding>) {
  assertResources(current.resources, expected.resources);
  if (retirementDigest({ ...current, resources: expected.resources }) !== retirementDigest(expected)) throw new Error("Cleanup authority, retention proof or original task pin changed");
}
const operationWhere = (taskId: string, sessionId: string, requestKey: string) => ({ runtimeSessionId: sessionId, source: `finalizer:${taskId}`, action: CLEANUP_OPERATION, key: requestKey });
const EvidenceSupplement = z.object({ version: z.literal(1), taskId: z.string(), sessionId: z.string(), requestKey: z.string(),
  operationRevision: z.number().int().positive(), operationDigest: Digest,
  preparedRevision: z.number().int().positive(), preparedDigest: Digest, evidence: EventReference,
}).strict();
const supplementWhere = (taskId: string, sessionId: string, requestKey: string) => ({ ...operationWhere(taskId, sessionId, requestKey), action: CLEANUP_EVIDENCE_SUPPLEMENT });
type OperationEvent = { sequence: number; value: string | null };

function supplementedBinding(operation: CleanupOperation, event: OperationEvent, supplement: z.infer<typeof EvidenceSupplement>) {
  const binding = operation.binding, evidence = supplement.evidence;
  if (supplement.taskId !== binding.taskId || supplement.sessionId !== binding.sessionId || supplement.requestKey !== operation.requestKey
    || supplement.operationRevision !== event.sequence || supplement.operationDigest !== sha(event.value!)
    || supplement.preparedRevision !== binding.preparedRevision || supplement.preparedDigest !== binding.preparedDigest
    || evidence.revision <= event.sequence || evidence.source !== `owner:${binding.taskId}` || evidence.action !== "legacy-evidence-retained"
    || binding.authority.some(reference => reference.action === evidence.action)) throw new Error("Cleanup evidence supplement does not match its original operation");
  return { ...binding, authority: [...binding.authority, evidence].sort((a, b) => a.revision - b.revision) };
}

/** Called only by the existing authenticated adoption transaction, after full
 * saved-copy observation. This adds proof to an existing operation; it cannot
 * replace its authority, scope or automatic origin, or create an operation. */
export async function supplementCleanupEvidence(input: Context, proofRevision: number) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
  const event = await hasPreparedCleanup(input.prisma, task.id, input.sessionId, input.requestKey);
  if (!event?.value) return;
  const observed = await current(input);
  if (observed.kind !== "v1") throw new Error("Saved evidence requires its original version 1 cleanup");
  const operation = CleanupOperation.parse(JSON.parse(event.value));
  if (operation.requestKey !== input.requestKey) throw new Error("Cleanup operation identity changed");
  const { inspectLegacyEvidenceAuthority } = await import("./legacy-evidence.ts");
  const retained = await inspectLegacyEvidenceAuthority(input.prisma, input.config, observed.task.id, proofRevision);
  const evidence = observed.binding.authority.find(reference => reference.action === "legacy-evidence-retained" && reference.revision === proofRevision);
  if (!evidence || retained.receipt.proof.preparedRevision !== observed.preparation.sequence) throw new Error("Cleanup evidence does not match the current preparation");
  // A proof accepted before the operation is already in its immutable epoch.
  if (operation.binding.authority.some(reference => reference.action === evidence.action)) { assertBinding(observed.binding, operation.binding); return; }
  const supplement = EvidenceSupplement.parse({ version: 1, taskId: observed.task.id, sessionId: input.sessionId, requestKey: input.requestKey,
    operationRevision: event.sequence, operationDigest: sha(event.value), preparedRevision: operation.binding.preparedRevision,
    preparedDigest: operation.binding.preparedDigest, evidence });
  assertBinding(observed.binding, supplementedBinding(operation, event, supplement));
  const where = supplementWhere(observed.task.id, input.sessionId, input.requestKey);
  const existing = await input.prisma.runtimeMetadataEvent.findFirst({ where });
  const value = JSON.stringify(supplement);
  if (existing) { if (existing.value !== value) throw new Error("Cleanup evidence supplement changed"); return; }
  if (await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...operationWhere(observed.task.id, input.sessionId, input.requestKey), action: FINALIZATION_CONFIRMED } })) throw new Error("Confirmed cleanup cannot adopt additional evidence");
  await input.prisma.runtimeMetadataEvent.create({ data: { ...where, value } });
}

export const inspectPreparedCleanupAuthority = current;
export function hasPreparedCleanup(prisma: Database, taskId: string, sessionId: string, requestKey: string) {
  return prisma.runtimeMetadataEvent.findFirst({ where: operationWhere(taskId, sessionId, requestKey) });
}

async function activeOperation(input: Context, allowConfirmedClosed = false, supplementInspection = false) {
  const observed = await current(input, allowConfirmedClosed);
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: operationWhere(observed.task.id, input.sessionId, input.requestKey) });
  if (!event?.value) throw new Error("Cleanup operation is not bound; perform full preparation first");
  const operation = CleanupOperation.parse(JSON.parse(event.value));
  if (operation.requestKey !== input.requestKey) throw new Error("Cleanup operation identity changed");
  const supplement = await input.prisma.runtimeMetadataEvent.findFirst({ where: supplementWhere(observed.task.id, input.sessionId, input.requestKey) });
  assertBinding(observed.binding, supplement ? supplementedBinding(operation, event, EvidenceSupplement.parse(JSON.parse(supplement.value!))) : operation.binding);
  if (!allowConfirmedClosed && !supplementInspection) await automaticCleanupTurn(inboxStore(input.prisma), observed.task, Boolean(operation.automatic), input.runtime);
  return { ...observed, operation, operationRevision: event.sequence };
}

async function localSnapshot<T>(input: Context, read: (value: Context) => Promise<T>): Promise<T> {
  const database = input.prisma as Database & Partial<Pick<PrismaClient, "$transaction">>;
  // A batch observes one consistent local epoch. Callers already inside a
  // mutation transaction reuse it rather than opening a nested transaction.
  return database.$transaction ? database.$transaction(tx => read({ ...input, prisma: tx })) : read(input);
}

export const assertPreparedCleanup = (input: Context) => localSnapshot(input, value => activeOperation(value));

/** Existing owner-authenticated adoption may add evidence outside an executing
 * automatic turn. This reads the unchanged operation; it grants no effect. */
export const inspectCleanupSupplementAuthority = (input: Context) => localSnapshot(input, value => activeOperation(value, false, true));

/** Closed-session reporting is restricted to the existing confirmed fact. It
 * confers no new resource effect, preparation or arbitrary publication scope. */
export async function assertCompletedCleanup(input: Context) {
  return localSnapshot(input, async scope => {
    const active = await activeOperation(scope, true);
    const confirmed = await scope.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { runtimeSessionId: scope.sessionId, source: `finalizer:${active.task.id}`, action: FINALIZATION_CONFIRMED, key: scope.requestKey } });
    const retained = await cleanupRetainedResourceIds(scope.prisma, scope.config, active);
    if (active.binding.resources.some(resource => ["development", "browser", "review"].includes(resource.purpose) && resource.state !== "released" && !retained.has(resource.id))) throw new Error("Cleanup reporting has unresolved required resources");
    return { ...active, confirmed };
  });
}

/** Accepted v2 dispositions, v1 archive proofs and exact accepted PR history remain distinct. Neither
 * a registry Released flag nor a reported adapter result creates a proof. */
export async function cleanupRetainedResourceIds(prisma: Database, config: ServerConfig, active: Awaited<ReturnType<typeof activeOperation>>) {
  if (active.kind === "v2") return active.retainedResourceIds;
  const { retainedArchiveResourceIds } = await import("./archive-retention.ts");
  const retained = await retainedArchiveResourceIds(prisma, config, active.prepared);
  for (const resource of cleanupDeliveryRetention(active)?.resources ?? []) retained.add(resource.id);
  const { legacyComposeRetentionReceipt } = await import("./legacy-compose-finalization.ts");
  for (const resource of (await legacyComposeRetentionReceipt(prisma, active))?.resources ?? []) retained.add(resource.id);
  return retained;
}

/** Registry writes cannot expand an active operation or resurrect a released
 * target. The adapter still independently proves ownership and the effect. */
export async function assertCleanupResourceUpdate(input: { prisma: Database; config: ServerConfig; sessionId: string; taskId: string }, resource: RemoteTaskResource,
  next: { state: string; metadata?: unknown; expiresAt: Date | null }) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const operation = task.primarySessionId && await hasPreparedCleanup(input.prisma, task.id, task.primarySessionId, `finalize:${task.id}`);
  if (!operation) return;
  if (input.sessionId !== task.primarySessionId) throw new Error("Only the original primary may update active cleanup receipts");
  const saved = CleanupOperation.parse(JSON.parse(operation.value!)).binding.resources.find(record => record.id === resource.id);
  if (!saved || saved.key !== resource.key || saved.kind !== resource.kind || saved.purpose !== resource.purpose || saved.externalId !== resource.externalId) throw new Error("Cleanup resource scope changed");
  // Pausing still allows an adapter to record that retained compute stopped.
  // An observation-only write never grants a lifecycle effect or changes state.
  if (next.state === resource.state && next.expiresAt?.getTime() === resource.expiresAt?.getTime()
    && retirementDigest(stableMetadata(next.metadata ?? resource.metadata)) === retirementDigest(stableMetadata(resource.metadata))) return;
  const active = await assertPreparedCleanup({ ...input, requestKey: `finalize:${task.id}` });
  if (resource.state === "released" && next.state !== "released") throw new Error("Cleanup cannot resurrect a released target");
  const projected = active.binding.resources.map(record => record.id === resource.id ? { ...record, state: next.state,
    metadata: stableMetadata(next.metadata ?? resource.metadata), expiresAt: next.expiresAt?.toISOString() ?? null } : record);
  assertResources(projected, active.operation.binding.resources);
}

/** A genuine persisted preparation is sufficient authority. The caller makes
 * bounded filesystem/retention observations outside SQL, then this CAS binds
 * their exact local epoch. It never replaces a prior operation to bypass drift. */
export async function bindPreparedCleanup(input: Omit<Context, "prisma"> & { prisma: PrismaClient }, observe: (prepared: PreparedFinalization | PreparedExternalFinalization, revision: number) => Promise<void>) {
  const initial = await current(input);
  const automatic = await automaticCleanupTurn(inboxStore(input.prisma), initial.task, false, input.runtime);
  const where = operationWhere(initial.task.id, input.sessionId, input.requestKey);
  if (await input.prisma.runtimeMetadataEvent.findFirst({ where })) return assertPreparedCleanup(input);
  await observe(initial.prepared, initial.preparation.sequence);
  await input.prisma.$transaction(async tx => {
    const latest = await current({ ...input, prisma: tx });
    const currentAutomatic = await automaticCleanupTurn(tx, latest.task, Boolean(automatic), input.runtime);
    if (retirementDigest(currentAutomatic ?? null) !== retirementDigest(automatic ?? null)) throw new Error("Automatic cleanup turn changed during initial observation");
    if (retirementDigest(latest.binding) !== retirementDigest(initial.binding)) throw new Error("Cleanup authority changed during initial observation");
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where });
    if (duplicate) { assertBinding(latest.binding, CleanupOperation.parse(JSON.parse(duplicate.value!)).binding); return; }
    await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(CleanupOperation.parse({ version: 1, requestKey: input.requestKey, ...(automatic ? { automatic } : {}), binding: initial.binding })) } });
  });
  return assertPreparedCleanup(input);
}
