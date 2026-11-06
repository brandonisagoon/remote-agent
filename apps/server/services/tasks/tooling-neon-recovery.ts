import { z } from "zod";
import type { Prisma, PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ToolingOperationBinding, ToolingReleaseRecord } from "../../../../types/tooling-release.ts";
import { canonicalDigest, resolveToolingLegacyConsumer } from "./tooling-releases.ts";
import { COUNTED_COMPUTE_KINDS, TOOLING_OPERATION_ASSOCIATION, ToolingOperationRefused, type ExistingReference, type ToolingCodeIdentity, type ToolingOperationDependencies } from "./tooling-operations.ts";

/**
 * DRA-24 bound Neon recovery: the legacy reader handoff of ONE container-less
 * resource group (design 551400d9). These seams decide eligibility, retire
 * the group's first-bootstrap readers inside the caller's proof transaction,
 * and select the recovery release afterwards. They never register state,
 * project the recipe, complete an operation, or touch admission, producer,
 * owner, retained-reader, offer, slot or claim records — the recovery service
 * composes those under its own write lock.
 *
 * The group is computed from server rows only. Every retained legacy reader of
 * the task must belong to it: unrelated groups (G6) and finalization/cleanup
 * readers (G5) refuse, because a drafted.runtime/2 registration is deferred by
 * any retained legacy row of the task. Unparseable, overflowing or
 * unavailable records refuse; nothing is inferred from absence.
 */
export const NEON_RECOVERY_OPERATION_KIND = "compute-neon-recovery";
/** Resolution evidence kind on handed-off legacy rows (reference: operation ID). */
export const NEON_RECOVERY_RESOLUTION_KIND = "compute-neon-recovery";
/** Durable recovery event: source `compute:<taskId>`, this action. */
export const NEON_RECOVERY_EVENT_ACTION = "compute-neon-recovery";
export const NEON_RECOVERY_STATE_FAMILY = "drafted.runtime";
const BOUND = 1000;
const DEVELOPMENT_INTENT_ACTION = "development-compute-intent";
const CAPABILITY_ACTION = "tooling-capability";

type GroupStore = Pick<Prisma.TransactionClient, "remoteTask" | "computeOffer" | "computeEnvironment" | "remoteTaskResource" | "computeBaseline" | "runtimeMetadataEvent"
  | "toolingLegacyBoundary" | "toolingLegacyConsumer" | "toolingRetainedConsumer">;
type FenceStore = Pick<Prisma.TransactionClient, "toolingOperation" | "computeOffer" | "computeEnvironment" | "remoteTaskResource" | "runtimeMetadataEvent">;

const refuse = (detail: string): never => { throw new ToolingOperationRefused("retained-release-required", `Neon recovery ${detail}`); };
const bounded = <T>(rows: T[], what: string) => rows.length > BOUND ? refuse(`cannot prove ${what}: more than ${BOUND} records`) : rows;
const parse = (text: string | null | undefined): unknown => { try { return JSON.parse(text ?? "null"); } catch { return undefined; } };

export const NeonRecoveryLegacyRow = z.strictObject({ id: z.string().min(1), consumerKind: z.string().min(1), consumerId: z.string().min(1), revision: z.string().min(1), checkout: z.string().min(1) });
export type NeonRecoveryLegacyRow = z.infer<typeof NeonRecoveryLegacyRow>;
/** Stored in the recovery event as `handoff`; the code selector validates it. */
export const NeonRecoveryHandoff = z.strictObject({ version: z.literal(1), operationId: z.string().min(1), taskId: z.string().min(1), environmentId: z.string().min(1),
  resourceId: z.string().min(1), rows: z.array(NeonRecoveryLegacyRow).max(BOUND) });
export type NeonRecoveryHandoff = z.infer<typeof NeonRecoveryHandoff>;

export type NeonRecoveryGroup = {
  taskId: string; repositoryId: string; environmentId: string; environmentKey: string; resourceId: string; resourceKey: string; offerIds: string[];
  /** Retained first-bootstrap readers of the group, to be handed off. Empty for a post-boundary group. */
  legacy: NeonRecoveryLegacyRow[];
  /** Group rows already resolved by `operationId` (an exact replay). */
  handedOff: NeonRecoveryLegacyRow[];
  /** Canonical identity of the group as read; compare begin vs. under-lock reads. */
  digest: string;
};

const Resolution = z.strictObject({ kind: z.string(), reference: z.string() });
const IntentScope = z.object({ action: z.enum(["stop", "resume"]), reason: z.string(), suspension: z.object({ environmentId: z.string() }).passthrough().optional() }).passthrough();
const Capability = z.object({ capability: z.string(), capabilityRevision: z.string() }).passthrough();
const Ids = z.array(z.string()).max(10_000);

export type NeonRecoveryGroupInput = {
  taskId: string; offerId: string; resourceKey: string;
  /** Names the recovering operation, so its own earlier handoff is recognised as a replay rather than refused. */
  operationId?: string;
  /** Authoritative cutoff (the proof-derived start of the ORIGINAL failed
   * provider request): only runtime capabilities granted at or before it can
   * have executed. Without it (begin) the check is advisory and any grant
   * counts; the resolver always requires it, so a later grant never authorizes. */
  grantedAtOrBefore?: Date;
  /** For the legacy-provider-rejection basis: the reviewed executed revision
   * every handed-off legacy snapshot must equal. */
  legacySourceRevision?: string;
};
/** Read the exact recovery group of `offerId` and decide handoff eligibility
 * (G0–G3, G5, G6). Read-only; call at begin (advisory) and again under the
 * write lock through `resolveNeonRecoveryLegacyGroup` (authoritative). */
export async function readNeonRecoveryLegacyGroup(store: GroupStore, input: NeonRecoveryGroupInput): Promise<NeonRecoveryGroup> {
  const task = await store.remoteTask.findUnique({ where: { id: input.taskId } });
  if (!task?.primarySessionId) return refuse("requires the task's original primary");
  const offer = await store.computeOffer.findUnique({ where: { id: input.offerId } });
  const environment = offer ? await store.computeEnvironment.findUnique({ where: { id: offer.environmentId } }) : null;
  const resource = await store.remoteTaskResource.findUnique({ where: { taskId_key: { taskId: task.id, key: input.resourceKey } } });
  if (!offer || !environment || !resource || environment.taskId !== task.id || environment.key !== input.resourceKey || environment.resourceId !== resource.id) {
    return refuse(`offer ${input.offerId} is not this task's exact environment and resource ${input.resourceKey}`);
  }
  const offers = bounded(await store.computeOffer.findMany({ where: { environmentId: environment.id }, select: { id: true }, orderBy: { id: "asc" }, take: BOUND + 1 }), "the environment's offers");
  const offerIds = offers.map(row => row.id);
  if (!await store.toolingLegacyBoundary.findUnique({ where: { repositoryId: task.repositoryId } })) return refuse("is bound-only; this repository has no first-bootstrap boundary");
  const rows = bounded(await store.toolingLegacyConsumer.findMany({ where: { repositoryId: task.repositoryId, taskId: task.id }, orderBy: { id: "asc" }, take: BOUND + 1 }), "the task's legacy readers");

  const member = async (row: { consumerKind: string; consumerId: string }) => {
    if (row.consumerKind === "compute-environment") return row.consumerId === environment.id;
    if (row.consumerKind === "compute-offer") return offerIds.includes(row.consumerId);
    if (row.consumerKind === "development-intent") return developmentMember(store, task, environment.id, row.consumerId);
    if (row.consumerKind === "compute-baseline") return baselineMember(store, task, resource, row.consumerId);
    if (row.consumerKind === "finalization" || row.consumerKind === "cleanup-request") return refuse(`refuses a finalizing task: ${row.consumerKind} ${row.consumerId} keeps a legacy reader`);
    return false;
  };
  const legacy: NeonRecoveryLegacyRow[] = [], handedOff: NeonRecoveryLegacyRow[] = [];
  for (const row of rows) {
    const identity = { id: row.id, consumerKind: row.consumerKind, consumerId: row.consumerId, revision: row.revision ?? "", checkout: row.checkout ?? "" };
    if (row.status === "resolved") {
      const resolution = Resolution.safeParse(row.resolution ?? null);
      if (!resolution.success) return refuse(`cannot read the resolution of legacy reader ${row.consumerKind} ${row.consumerId}`);
      if (resolution.data.kind !== NEON_RECOVERY_RESOLUTION_KIND || !await member(row)) continue; // ordinary history
      if (resolution.data.reference !== input.operationId) return refuse(`group was already handed off by operation ${resolution.data.reference}`);
      handedOff.push(NeonRecoveryLegacyRow.parse(identity));
      continue;
    }
    if (row.status !== "retained") return refuse(`cannot classify legacy reader ${row.consumerKind} ${row.consumerId} (${row.status})`);
    if (row.provenance === "unavailable" || !row.revision || !row.checkout) return refuse(`refuses legacy reader ${row.consumerKind} ${row.consumerId}: its executable provenance is unavailable`);
    if (!await member(row)) return refuse(`refuses: retained legacy reader ${row.consumerKind} ${row.consumerId} is outside the recovered group and would defer its state version`);
    legacy.push(NeonRecoveryLegacyRow.parse(identity));
  }
  if (legacy.length && handedOff.length) return refuse("group is partially handed off");
  if (legacy.length) {
    if (input.grantedAtOrBefore !== undefined && !Number.isFinite(input.grantedAtOrBefore.getTime())) return refuse("needs a valid capability cutoff");
    const allowed = await executedRevisions(store, task, input.grantedAtOrBefore);
    const foreign = legacy.find(row => !allowed.has(row.revision));
    if (foreign) return refuse(`refuses ${foreign.consumerKind} ${foreign.consumerId}: its snapshot ${foreign.revision} is neither the task pin nor a runtime capability granted ${input.grantedAtOrBefore ? `by ${input.grantedAtOrBefore.toISOString()}` : "to this primary"}`);
    const unreviewed = input.legacySourceRevision === undefined ? undefined : legacy.find(row => row.revision !== input.legacySourceRevision);
    if (unreviewed) return refuse(`refuses ${unreviewed.consumerKind} ${unreviewed.consumerId}: its snapshot ${unreviewed.revision} is not the reviewed executed revision ${input.legacySourceRevision}`);
    await assertUntouched(store, task, environment, offerIds);
  }
  const group = { taskId: task.id, repositoryId: task.repositoryId, environmentId: environment.id, environmentKey: environment.key, resourceId: resource.id, resourceKey: input.resourceKey, offerIds, legacy, handedOff };
  return { ...group, digest: canonicalDigest(group) };
}

/** A live legacy development intent belongs to the group only when its scope
 * provably is the group: a suspension of this environment, or a task-wide
 * intent of a task whose only development environment is this one. */
async function developmentMember(store: GroupStore, task: RemoteTask, environmentId: string, consumerId: string) {
  const sequence = Number(consumerId);
  const event = Number.isSafeInteger(sequence) ? await store.runtimeMetadataEvent.findUnique({ where: { sequence } }) : null;
  const scope = event && event.action === DEVELOPMENT_INTENT_ACTION && event.source === `development:${task.id}` && event.runtimeSessionId === task.primarySessionId ? IntentScope.safeParse(parse(event.value)) : null;
  if (!scope?.success) return refuse(`cannot read legacy development intent ${consumerId}`);
  if (scope.data.suspension) return scope.data.suspension.environmentId === environmentId;
  const environments = bounded(await store.computeEnvironment.findMany({ where: { taskId: task.id, purpose: "development" }, select: { id: true }, take: BOUND + 1 }), "the task's development environments");
  return environments.length === 1 && environments[0]!.id === environmentId;
}

/** Exact proven baseline membership: the purpose's baseline accounting group
 * is exactly this resource (no other unreleased counted resource, and every
 * recorded baseline row lists only it). Anything else is not this group. */
async function baselineMember(store: GroupStore, task: RemoteTask, resource: { id: string; purpose: string }, consumerId: string) {
  if (consumerId !== `${task.id}:${resource.purpose}`) return false;
  const others = await store.remoteTaskResource.count({ where: { taskId: task.id, purpose: resource.purpose, state: { not: "released" }, kind: { in: [...COUNTED_COMPUTE_KINDS] }, id: { not: resource.id } } });
  if (others) return refuse(`refuses baseline ${consumerId}: it accounts for other resources than the recovered one`);
  const baselines = bounded(await store.computeBaseline.findMany({ where: { taskId: task.id, purpose: resource.purpose }, take: BOUND + 1 }), "the baseline membership");
  for (const row of baselines) {
    const ids = Ids.safeParse(row.resourceIds);
    if (!ids.success) return refuse(`cannot read baseline ${row.id} membership`);
    if (ids.data.length !== 1 || ids.data[0] !== resource.id) return refuse(`refuses baseline ${consumerId}: its recorded membership is not exactly the recovered resource`);
  }
  return true;
}

/** The task pin, plus runtime capabilities the server granted this primary
 * (at or before `cutoff` when given). */
async function executedRevisions(store: GroupStore, task: RemoteTask, cutoff?: Date) {
  const allowed = new Set<string>([task.toolingRevision]);
  const grants = bounded(await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId!, source: `task:${task.id}`, action: CAPABILITY_ACTION,
    ...(cutoff ? { occurredAt: { lte: cutoff } } : {}) }, take: BOUND + 1 }), "the granted capabilities");
  for (const grant of grants) {
    const value = Capability.safeParse(parse(grant.value));
    if (!value.success) return refuse(`cannot read capability grant ${grant.sequence}`);
    if (value.data.capability === "runtime") allowed.add(value.data.capabilityRevision);
  }
  return allowed;
}

/** G3: a legacy group never touched by bound code. Any record at all, in any
 * state, refuses: no admission, producer, owner or retained reader. */
async function assertUntouched(store: GroupStore, task: RemoteTask, environment: { id: string; key: string }, offerIds: string[]) {
  const keys = [`admission:environment-key:${environment.key}`, `producer:compute-environment:${environment.id}`, `owner:compute-environment:${environment.id}`, ...offerIds.map(id => `owner:compute-offer:${id}`)];
  const touched = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId!, source: `tooling-operation:${task.id}`, action: TOOLING_OPERATION_ASSOCIATION, key: { in: keys } } });
  if (touched) refuse(`refuses a legacy group already touched by bound code (${touched.key})`);
  const reader = await store.toolingRetainedConsumer.findFirst({ where: { taskId: task.id, consumerKind: "compute-environment", consumerId: environment.id } });
  if (reader) refuse(`refuses a legacy group with a retained reader (${reader.id})`);
}

/** G4 (state format only): the recovering release reads the original v1 and
 * writes the recovered v2. The format manifest establishes NOTHING about
 * observation: the service must also verify, from the bound release's own
 * committed capability manifest (verifyBoundObserver), every contract in
 * `neonRecoveryObservationContracts(group)`. */
export function assertNeonRecoveryRelease(release: Pick<ToolingReleaseRecord, "revision" | "manifest">) {
  const format = release.manifest.stateFormats[NEON_RECOVERY_STATE_FAMILY];
  if (!format || !format.read.includes(1) || !format.read.includes(2) || !(format.writeVersions ?? [format.write]).includes(2)) {
    refuse(`requires release ${release.revision} to read ${NEON_RECOVERY_STATE_FAMILY} versions 1 and 2 and write version 2`);
  }
}

/** Runtime observation contracts the bound release's committed capability
 * manifest must declare for this group: recovery and environment observation
 * always, baseline accounting when a baseline reader is handed off. */
export function neonRecoveryObservationContracts(group: Pick<NeonRecoveryGroup, "legacy" | "handedOff">): string[] {
  const baseline = [...group.legacy, ...group.handedOff].some(row => row.consumerKind === "compute-baseline");
  return ["runtime-neon-recovery/v1", "compute-traffic/v1", ...(baseline ? ["compute-baseline/v1"] : [])];
}

/**
 * Inside the recovery service's proof transaction, under its write lock:
 * re-read the group with the authoritative capability cutoff (and the
 * legacy basis's reviewed revision when given), require it to equal
 * `expectedDigest` when given, and
 * resolve exactly its retained legacy readers with this operation as
 * evidence. Rows and their snapshots are kept (CAS retained -> resolved). The
 * task must then hold no retained legacy reader. An exact replay returns the
 * same handoff without writing. The caller stores the result as the event's
 * `handoff`, and rolls everything back if any later step fails.
 */
export async function resolveNeonRecoveryLegacyGroup(tx: Prisma.TransactionClient, input: NeonRecoveryGroupInput & { operationId: string; grantedAtOrBefore: Date; expectedDigest?: string }): Promise<NeonRecoveryHandoff> {
  if (!(input.grantedAtOrBefore instanceof Date)) refuse("handoff requires the original request's capability cutoff");
  const group = await readNeonRecoveryLegacyGroup(tx, input);
  // First commit only: a replay has already resolved the rows it read.
  if (input.expectedDigest !== undefined && !group.handedOff.length && group.digest !== input.expectedDigest) refuse("group changed since it was read");
  const rows = group.handedOff.length ? group.handedOff : group.legacy;
  if (!group.handedOff.length) {
    for (const row of group.legacy) await resolveToolingLegacyConsumer({ prisma: tx, id: row.id, evidence: { kind: NEON_RECOVERY_RESOLUTION_KIND, reference: input.operationId } });
  }
  const remaining = await tx.toolingLegacyConsumer.findFirst({ where: { repositoryId: group.repositoryId, taskId: group.taskId, status: "retained" } });
  if (remaining) refuse(`left retained legacy reader ${remaining.consumerKind} ${remaining.consumerId}`);
  return NeonRecoveryHandoff.parse({ version: 1, operationId: input.operationId, taskId: group.taskId, environmentId: group.environmentId, resourceId: group.resourceId, rows });
}
/**
 * Code of a group whose first-bootstrap reader row was handed off by a
 * committed recovery: that operation's own release. Strict: the resolution,
 * the completed operation (kind, task, primary, repository, release), and the
 * single committed event read through `readCommittedNeonRecovery` (full stored
 * binding, proof, state write and the exact handed-off rows, this one among
 * them). Null when the row is not a recovery handoff. Never falls back to the
 * active release: any mismatch throws. Callers check a confirmed producer
 * first; this never outranks one.
 */
export async function neonRecoveryHandoffCode(store: Pick<PrismaClient, "toolingLegacyConsumer" | "runtimeMetadataEvent" | "toolingStateWrite">, input: { task: RemoteTask; reference: Pick<ExistingReference, "type" | "id"> },
  read: ToolingOperationDependencies["read"]): Promise<{ code: ToolingCodeIdentity; binding: ToolingOperationBinding } | null> {
  const { task, reference } = input;
  const row = await store.toolingLegacyConsumer.findUnique({ where: { repositoryId_consumerKind_consumerId: { repositoryId: task.repositoryId, consumerKind: reference.type, consumerId: reference.id } } });
  if (!row || row.status !== "resolved") return null;
  const resolution = Resolution.safeParse(row.resolution ?? null);
  if (!resolution.success) throw new ToolingOperationRefused("producer-unknown", `Legacy reader ${reference.type} ${reference.id} has an unreadable resolution`);
  if (resolution.data.kind !== NEON_RECOVERY_RESOLUTION_KIND) return null;
  const fail = (detail: string): never => { throw new ToolingOperationRefused("producer-unknown", `${reference.type} ${reference.id} Neon recovery handoff ${resolution.data.reference} is not verifiable: ${detail}`); };
  if (row.taskId !== task.id || !row.revision || !row.checkout) fail("the legacy row does not belong to this task");
  const binding = await read({ prisma: store as PrismaClient, operationId: resolution.data.reference });
  if (!binding) return fail("the operation is missing");
  if (binding.kind !== NEON_RECOVERY_OPERATION_KIND || binding.status !== "completed" || binding.taskId !== task.id || binding.sessionId !== task.primarySessionId
    || binding.repositoryId !== task.repositoryId || binding.release.repositoryId !== task.repositoryId) fail("the operation is not this task's completed recovery");
  // Dynamic: the result reader imports the recovery service, which imports this module.
  const { readCommittedNeonRecovery } = await import("./compute-neon-recovery-result.ts");
  let committed: Awaited<ReturnType<typeof readCommittedNeonRecovery>>;
  try { committed = await readCommittedNeonRecovery(store, binding); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (!committed) return fail("no committed recovery event names the operation");
  // readCommittedNeonRecovery proved the rows this operation resolved are
  // exactly its recorded handoff with unchanged snapshots; this row is one.
  return { code: binding.release, binding };
}

/** Environments of the task with a Neon recovery operation in ANY status
 * (bound through completed). Null means the set cannot be proven. */
async function recoveredEnvironments(store: FenceStore, taskId: string): Promise<Set<string> | null> {
  const operations = await store.toolingOperation.findMany({ where: { taskId, kind: NEON_RECOVERY_OPERATION_KIND }, select: { existingOperationId: true }, take: BOUND + 1 });
  if (operations.length > BOUND) return null;
  const environments = new Set<string>();
  for (const operation of operations) {
    const offer = operation.existingOperationId ? await store.computeOffer.findUnique({ where: { id: operation.existingOperationId } }) : null;
    if (!offer) return null;
    environments.add(offer.environmentId);
  }
  return environments;
}

/**
 * Group-scoped fence for header-less (legacy-continuation) callbacks: once a
 * recovery operation exists for a group — before its commit (the private
 * candidate is not canonical yet, but the transition holds the group) and
 * after its committed handoff — no first-bootstrap snapshot continues it.
 * Returns the refusal detail, or null. Finalization and cleanup references
 * are never fenced; other groups are unaffected.
 */
export async function neonRecoveryFence(store: FenceStore, task: Pick<RemoteTask, "id" | "primarySessionId">, reference: Pick<ExistingReference, "type" | "id">): Promise<string | null> {
  if (reference.type === "finalization" || reference.type === "cleanup-request") return null;
  const environments = await recoveredEnvironments(store, task.id);
  if (environments && !environments.size) return null;
  const fenced = `${reference.type} ${reference.id} belongs to a resource group under Neon recovery; only bound operations continue it`;
  if (!environments) return fenced;
  if (reference.type === "compute-environment") return environments.has(reference.id) ? fenced : null;
  if (reference.type === "compute-offer") {
    const offer = await store.computeOffer.findUnique({ where: { id: reference.id } });
    return !offer || environments.has(offer.environmentId) ? fenced : null;
  }
  if (reference.type === "development-intent") {
    const sequence = Number(reference.id);
    const event = Number.isSafeInteger(sequence) ? await store.runtimeMetadataEvent.findUnique({ where: { sequence } }) : null;
    const scope = event ? IntentScope.safeParse(parse(event.value)) : null;
    if (!scope?.success || !scope.data.suspension) return fenced; // task-wide or unreadable: covers the recovered group
    return environments.has(scope.data.suspension.environmentId) ? fenced : null;
  }
  // compute-baseline `<task>:<purpose>`: fenced when a recovered environment has that purpose.
  const purpose = reference.id.startsWith(`${task.id}:`) ? reference.id.slice(task.id.length + 1) : null;
  const recovered = await store.computeEnvironment.findMany({ where: { id: { in: [...environments] } }, select: { purpose: true } });
  return !purpose || recovered.some(environment => environment.purpose === purpose) ? fenced : null;
}
