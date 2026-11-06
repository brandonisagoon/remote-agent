import { assertComputeStartIntent, assertDevelopmentWork, DevelopmentWorkUnavailable, supersedeRuntimeSuspension } from "./development-intent.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient, ComputeEnvironment } from "../../../../generated/prisma/client.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { ComputeObservation } from "./compute-observation.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { SavedComputeBinding, SavedComputeIdentityChanged, assertSavedComputeObservation, assertSavedComputeRequest, assertSavedComputeResource, assertSavedComputeStopped, isSavedComputeEnvironment } from "./compute-saved-resource.ts";

import { ComputeReclamation } from "./compute-reclamation-schema.ts";
import { readComputeWorktreeRevision } from "./compute-worktree-revision.ts";
type Store = Prisma.TransactionClient;
type Context = { prisma: PrismaClient; machineId: string; policy: ComputePolicy; now?: Date; config?: ServerConfig; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity"> };
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ComputeRequest = z.object({ key: Key, purpose: z.enum(["development", "review"]), revision: z.string().regex(/^[a-f0-9]{40}$/), recipeDigest: Digest, saved: SavedComputeBinding.optional() }).strict();
export const COMPUTE_VALIDATION_MS = 300_000;
const activeOffers = ["queued", "offered", "validating", "claimed", "running", "unknown"];
const computeKinds = ["native-app", "launch-agent", "launch-agents", "task-runtime", "docker-container", "docker-compose-project"];
const at = (input: Context) => input.now ?? new Date();
function policy(input: Context) {
  const value = ComputePolicy.parse(input.policy);
  if (!value.enabled) throw new Error("Host compute admission is not enabled");
  return value;
}
class ComputeOwnerUnavailable extends Error {}
type OwnerStore = Pick<Store, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeMetadataEvent">;
export async function computeTaskOwner(store: OwnerStore, taskId: string, machineId: string, options: { allowPaused?: boolean } = {}) {
  const task = await store.remoteTask.findUnique({ where: { id: taskId } });
  const session = task?.primarySessionId && await store.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!task || !session || task.machineId !== machineId || session.machineId !== machineId || task.ownerPaused && !options.allowPaused || task.phase === "closed" || session.closedAt || session.status === "closed"
    || session.role !== "primary" || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || !task.worktreePath) throw new ComputeOwnerUnavailable("Compute requires the original eligible task primary");
  await assertDevelopmentWork({ prisma: store }, task);
  let sourceLinkId: string | null = null;
  if (task.issueIdentifier) {
    if (!task.connectionId) throw new ComputeOwnerUnavailable("Compute source ownership is unavailable");
    const link = await store.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
    if (!link) throw new ComputeOwnerUnavailable("Compute source ownership was revoked"); sourceLinkId = link.id;
  }
  const identity = computeTaskIdentity(task, session.id, machineId, sourceLinkId);
  return { task, session, identity };
}
export function computeTaskIdentity(task: import("../../../../generated/prisma/client.ts").RemoteTask, primarySessionId: string, machineId: string, sourceLinkId: string | null) {
  return finalizationDigest({ taskId: task.id, primarySessionId: primarySessionId, machineId, repositoryId: task.repositoryId, worktreePath: task.worktreePath,
    connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, sourceLinkId, baseCommit: task.baseCommit, branchName: task.branchName, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot });
}
export async function assertComputeEnvironmentOwner(store: OwnerStore & Pick<Store, "remoteTaskResource">, environment: ComputeEnvironment, options: { allowPaused?: boolean } = {}) {
  const owned = await computeTaskOwner(store, environment.taskId, environment.machineId, options);
  if (owned.identity !== environment.taskIdentity || owned.session.id !== environment.primarySessionId) throw new ComputeOwnerUnavailable("Compute task ownership changed");
  if (isSavedComputeEnvironment(environment)) {
    try { await assertSavedComputeResource(store, { ...environment, saved: { resourceId: environment.resourceId!, resourceIdentity: environment.resourceIdentity! } }); }
    catch (error) { if (error instanceof SavedComputeIdentityChanged) throw new ComputeOwnerUnavailable("Saved compute resource ownership changed", { cause: error }); throw error; }
  }
  return owned;
}
/** Exact evidence for a group that consumes the explicit budget. */
export type ComputeBlocker = { group: string; reason: "unrecorded-resource" | "uncredited-baseline" | "uncertain-environment"; ids: string[]; detail: string; action: string };
const BLOCKER_ACTION: Record<ComputeBlocker["reason"], string> = {
  "unrecorded-resource": "No fresh stopped observation accounts for these resources; the collector must observe them stopped or their owner must release them.",
  "uncredited-baseline": "The original group has no current stopped proof; the next settled baseline refresh can credit it.",
  "uncertain-environment": "This environment may still be running; only a fresh physical reclamation releases its charge.",
};
/** Unknown existing environments consume the explicit budget conservatively.
 * A stale Ready/Allocated receipt is not proof that physical compute is free.
 * Every debited group is returned with the exact rows that caused it. */
async function unaccounted(store: Store, input: Context): Promise<{ count: number; blockers: ComputeBlocker[] }> {
  const machineId = input.machineId;
  const resources = await store.remoteTaskResource.findMany({ where: { task: { machineId }, purpose: { in: ["development", "review"] }, state: { not: "released" }, kind: { in: computeKinds } }, take: 10001 });
  if (resources.length > 10000) throw new Error("Host compute inventory exceeds the observation bound");
  const environments = await store.computeEnvironment.findMany({ where: { machineId }, take: 10001 });
  if (environments.length > 10000) throw new Error("Host compute allocation inventory exceeds the observation bound");
  const allocations = await store.computeOffer.findMany({ where: { machineId, state: { in: ["claimed", "running", "unknown"] } }, take: 10001 });
  const slots = await store.computeSlot.findMany({ where: { machineId, allocationId: { not: null } }, take: 10001 });
  if (allocations.length > 10000 || slots.length > 10000) throw new Error("Host compute allocation inventory exceeds its bound");
  const occupied = new Set(allocations.filter(offer => slots.some(slot => slot.allocationId === offer.id)).map(offer => offer.environmentId));
  const recorded = new Set(environments.filter(environment => {
    if (occupied.has(environment.id)) return true;
    const observation = ComputeObservation.safeParse(environment.observation);
    const resource = resources.find(value => value.id === environment.resourceId);
    const reclaimed = ComputeReclamation.safeParse(environment.observation);
    if (resource && reclaimed.success && environment.state === "suspended" && ["stopped", "absent"].includes(reclaimed.data.state)
      && reclaimed.data.environmentId === environment.id && reclaimed.data.taskId === environment.taskId && reclaimed.data.primarySessionId === environment.primarySessionId
      && reclaimed.data.resourceId === resource.id && reclaimed.data.resourceIdentity === finalizationResourceIdentity(resource).identityDigest
      && reclaimed.data.allocationResourceIdentity === environment.resourceIdentity && at(input).getTime() >= reclaimed.data.observedAt
      && at(input).getTime() - reclaimed.data.observedAt <= input.policy.collectorFreshnessSeconds * 1000) return true;
    return observation.success && resource && observation.data.state === "stopped"
      && observation.data.resourceId === resource.id && observation.data.resourceIdentity === finalizationResourceIdentity(resource).identityDigest
      && observation.data.environmentId === environment.id && observation.data.taskId === environment.taskId
      && at(input).getTime() >= observation.data.observedAt && at(input).getTime() - observation.data.observedAt <= input.policy.collectorFreshnessSeconds * 1000;
  }).map(value => value.resourceId).filter(Boolean));
  // A Released registry row is not proof that a later observation is idle.
  // Unallocated running/unknown environments remain host usage until a fresh
  // physical reclamation succeeds, even after ordinary resource cleanup.
  const uncertain = environments.filter(environment => !occupied.has(environment.id) && ["running", "unknown", "starting"].includes(environment.state));
  const baselines = await (await import("./compute-baseline.ts")).computeBaselineCredits(store, input);
  for (const baseline of baselines) if (baseline.credited) for (const id of baseline.resourceIds) recorded.add(id);
  const originalClaims = baselines.filter(baseline => !baseline.credited && baseline.resourceIds.some(id => !recorded.has(id)));
  const groups = new Map<string, ComputeBlocker>();
  const add = (group: string, reason: ComputeBlocker["reason"], id: string, detail: string) => {
    const value = groups.get(group) ?? groups.set(group, { group, reason, ids: [], detail, action: BLOCKER_ACTION[reason] }).get(group)!;
    if (!value.ids.includes(id)) value.ids.push(id);
  };
  // Baseline groups first: their exact credit reason explains their members.
  for (const group of originalClaims) for (const id of group.resourceIds.filter(id => !recorded.has(id)))
    add(`${group.taskId}:${group.purpose}`, "uncredited-baseline", id, `baseline ${group.reason ?? "uncredited"}${group.observedAt === undefined ? "" : ` (last proof observed ${new Date(group.observedAt).toISOString()})`}`);
  for (const resource of resources) if (!recorded.has(resource.id)) add(`${resource.taskId}:${resource.purpose}`, "unrecorded-resource", resource.id, `resource ${resource.key} (${resource.kind}, ${resource.state})`);
  for (const environment of uncertain) add(`${environment.taskId}:${environment.purpose}`, "uncertain-environment", environment.id, `environment ${environment.id} is ${environment.state} without an allocation`);
  return { count: groups.size, blockers: [...groups.values()] };
}
/** Accounting, not offer expiry, refused this reservation. Carries the exact
 * debited groups and held allocations; the reservation itself is retained. */
export class ComputeCapacityBlocked extends Error {
  readonly blockers: ComputeCapacity["blockers"];
  constructor(readonly capacity: Pick<ComputeCapacity, "slots" | "unaccounted" | "occupied" | "usable" | "blockers">) {
    super(`Compute reservation is unavailable: capacity accounting blocks this claim (${capacity.occupied} held of ${capacity.usable} usable, ${capacity.slots} slots, ${capacity.unaccounted} unaccounted group(s)${capacity.blockers.unaccounted.length ? `: ${capacity.blockers.unaccounted.map(blocker => `${blocker.group} ${blocker.detail}`).join("; ")}` : ""})`);
    this.blockers = capacity.blockers;
  }
}
type ComputeCapacity = Awaited<ReturnType<typeof computeAdmissionCapacity>>;
const baselineRefreshes = new WeakMap<PrismaClient, Map<string, Promise<unknown>>>();
async function refreshBaseline(input: Context) {
  if (!input.config || !input.runtime) return; // Internal callers without a live observer cannot create baseline credit.
  if (input.config.machine !== input.machineId) throw new Error("Compute accounting belongs to another host");
  let pending = baselineRefreshes.get(input.prisma);
  if (!pending) { pending = new Map(); baselineRefreshes.set(input.prisma, pending); }
  const active = pending.get(input.machineId);
  if (active) return active;
  const work = import("./compute-baseline.ts").then(module => module.refreshComputeBaselines({ prisma: input.prisma, config: input.config!, runtime: input.runtime!, now: input.now }));
  pending.set(input.machineId, work);
  try { return await work; } finally { if (pending.get(input.machineId) === work) pending.delete(input.machineId); }
}
/** The same conservative budget used by selection, claim and diagnostics.
 * Reads only: stale/missing proof retains its existing reservation. Blocked
 * capacity is explained by exact debited groups and held allocations, never
 * inferred from an empty slot count. */
export async function computeAdmissionCapacity(store: Store, input: Context) {
  const settings = policy(input), accounting = await unaccounted(store, input), unaccountedGroups = accounting.count;
  // Count every occupied ordinal, including slots above a reduced budget.
  const held = await store.computeSlot.findMany({ where: { machineId: input.machineId, allocationId: { not: null } }, orderBy: { ordinal: "asc" }, take: 10001 });
  const offers = held.length ? await store.computeOffer.findMany({ where: { id: { in: held.map(slot => slot.allocationId!) } }, take: 10001 }) : [];
  const occupied = held.length;
  const budgetUsable = Math.max(0, settings.slots - unaccountedGroups);
  const usable = Math.min(budgetUsable, settings.maxManagedAllocations ?? budgetUsable);
  const blockers = { unaccounted: accounting.blockers, allocations: held.map(slot => ({ slot: slot.id, ordinal: slot.ordinal, allocationId: slot.allocationId!,
    state: offers.find(offer => offer.id === slot.allocationId)?.state ?? "unrecorded", environmentId: offers.find(offer => offer.id === slot.allocationId)?.environmentId ?? null })) };
  return { slots: settings.slots, unaccounted: unaccountedGroups, occupied, usable, headroom: usable - occupied, blockers,
    ...(settings.maxManagedAllocations === undefined ? {} : { maxManagedAllocations: settings.maxManagedAllocations, budgetUsable }) };
}

/** Observe the daemon's real activity and existing proof in a read transaction.
 * This never refreshes proof, reconciles offers or creates a slot/claim. */
export async function readComputeCapacity(input: Context & { taskId: string }) {
  if (!input.runtime?.observeSessionActivity) throw new Error("Compute execution observation is unavailable");
  const now = at(input);
  return input.prisma.$transaction(async store => {
    const task = await store.remoteTask.findUnique({ where: { id: input.taskId } });
    if (!task || task.machineId !== input.machineId) throw new Error("Compute diagnostic owner is unavailable");
    return { ...await computeAdmissionCapacity(store, { ...input, now }), observedAt: now.toISOString() };
  });
}

async function freeSlot(store: Store, input: Context) {
  const { usable, occupied } = await computeAdmissionCapacity(store, input);
  if (occupied >= usable) return null;
  for (let ordinal = 0; ordinal < usable; ordinal++) {
    const id = `${input.machineId}:${ordinal}`;
    await store.computeSlot.upsert({ where: { id }, create: { id, machineId: input.machineId, ordinal }, update: {} });
  }
  return store.computeSlot.findFirst({ where: { machineId: input.machineId, ordinal: { lt: usable }, allocationId: null }, orderBy: { ordinal: "asc" } });
}
async function rotate(store: Store, environment: ComputeEnvironment, now: Date) {
  await store.computeWait.deleteMany({ where: { environmentId: environment.id } });
  await store.computeWait.create({ data: { environmentId: environment.id, machineId: environment.machineId, eligibleAt: now } });
}
async function withdraw(store: Store, offerId: string, reason: "expired" | "declined" | "ineligible", now: Date, options: { preserveQueue?: boolean } = {}) {
  const offer = await store.computeOffer.findUniqueOrThrow({ where: { id: offerId } });
  if (!["queued", "offered", "validating"].includes(offer.state)) return false;
  await store.computeOffer.update({ where: { id: offer.id }, data: { state: reason, completedAt: now } });
  await store.computeSlot.updateMany({ where: { allocationId: offer.id }, data: { allocationId: null } });
  // Only our undelivered queued message may be cancelled. Dispatching or
  // uncertain turns retain their ordinary inbox reconciliation semantics.
  await store.runtimeInstruction.updateMany({ where: { id: offer.instructionId, state: "queued" }, data: { state: "cancelled", detail: `Compute offer ${reason}` } });
  const env = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
  await store.computeEnvironment.update({ where: { id: env.id }, data: { state: "waiting" } });
  if (!options.preserveQueue) await rotate(store, env, now);
  return true;
}

export async function savedRevisionAllocations(store: Pick<Store, "computeOffer" | "computeSlot">, environmentId: string) {
  const offers = await store.computeOffer.findMany({ where: { environmentId }, orderBy: { id: "asc" }, take: 1001 });
  if (offers.length > 1000) throw new Error("Saved compute revision history exceeds its bound");
  if (offers.some(value => ["validating", "claimed", "running", "unknown"].includes(value.state))) throw new Error("Saved compute revision still has an active or uncertain allocation");
  const slots = await store.computeSlot.findMany({ where: { allocationId: { in: offers.map(value => value.id) } }, orderBy: { id: "asc" }, take: 1001 });
  // Selection reserves before dispatch: queued and delivered unclaimed offers
  // each explain exactly their own reserved slot.
  if (slots.length > 1000 || slots.some(slot => !offers.some(offer => offer.id === slot.allocationId && ["queued", "offered"].includes(offer.state) && offer.claimedAt === null))) throw new Error("Saved compute revision has an unexplained slot");
  return { offers, slots };
}

/** Owner enrollment can replace a stopped instrumentation generation, but it
 * never releases an executing allocation or gives an old offer a new recipe. */
export async function withdrawComputeConfigurationOffers(store: Store, environment: ComputeEnvironment, allocations: Awaited<ReturnType<typeof savedRevisionAllocations>>, now: Date) {
  const waiting = await store.computeWait.findUnique({ where: { environmentId: environment.id } });
  for (const offer of allocations.offers) if (["queued", "offered"].includes(offer.state)) await withdraw(store, offer.id, "ineligible", now);
  if (waiting) await rotate(store, environment, now);
}

/** Before the first claim, admission is the authority that prevents provider
 * creation. A complete never-claimed ledger can advance with product HEAD;
 * absent local files alone must never make a previously started app eligible. */
async function unstartedRevisionEvidence(store: Store, environment: ComputeEnvironment) {
  const owned = await assertComputeEnvironmentOwner(store, environment);
  if (owned.task.phase === "complete" || environment.purpose !== "development" || !["waiting", "offered"].includes(environment.state)
    || environment.resourceId !== null || environment.resourceIdentity !== null || environment.configuration !== null || environment.observation !== null) throw new Error("Compute revision requires a never-started development environment");
  const intent = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owned.session.id, source: `development:${environment.taskId}`, action: "development-compute-intent" }, orderBy: { sequence: "desc" } });
  if (intent && z.object({ version: z.literal(1), action: z.enum(["stop", "resume"]) }).parse(JSON.parse(intent.value!)).action !== "resume") throw new Error("Compute revision cannot supersede development stop");
  const allocations = await savedRevisionAllocations(store, environment.id);
  if (allocations.offers.some(offer => offer.claimedAt !== null || !["queued", "offered", "expired", "declined", "ineligible"].includes(offer.state))) throw new Error("Compute revision has a prior or uncertain claim");
  if (await store.remoteTaskResource.count({ where: { taskId: environment.taskId, purpose: environment.purpose } })
    || await store.computeTraffic.count({ where: { environmentId: environment.id } })) throw new Error("Compute revision has existing resources or traffic");
  const waiting = await store.computeWait.findUnique({ where: { environmentId: environment.id } });
  if (!waiting || waiting.machineId !== environment.machineId) throw new Error("Compute revision has no original queue entry");
  return { identity: owned.identity, worktree: owned.task.worktreePath!, allocations, waiting, intent };
}

export async function requestCompute(input: Context & { taskId: string; request: z.infer<typeof ComputeRequest>; config?: ServerConfig }, readRevision?: typeof import("./compute-observer.ts").readConfiguredComputeObservation, readUnstartedHead = readComputeWorktreeRevision) {
  policy(input); const request = ComputeRequest.parse(input.request);
  const prior = await input.prisma.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
  // A saved app can survive normal product commits. Observe the actual new
  // HEAD before changing its generation; never relabel an old observation.
  const transition = await (async () => {
    if (!prior || prior.revision === request.revision) return;
    if (!input.config || input.config.machine !== input.machineId) throw new Error("Compute request identity changed");
    if (!request.saved) {
      if (prior.purpose !== request.purpose || prior.recipeDigest !== request.recipeDigest) throw new Error("Compute request identity changed");
      const evidence = await unstartedRevisionEvidence(input.prisma, prior);
      if (await readUnstartedHead(evidence.worktree) !== request.revision) throw new Error("Compute request does not match worktree HEAD");
      return { unstarted: evidence };
    }
    const owned = await assertComputeEnvironmentOwner(input.prisma, prior);
    assertSavedComputeRequest(prior, request.saved);
    if (prior.taskIdentity !== owned.identity || prior.purpose !== request.purpose || prior.recipeDigest !== request.recipeDigest) throw new Error("Compute request identity changed");
    const resource = await assertSavedComputeResource(input.prisma, { taskId: input.taskId, ...request, saved: request.saved });
    const allocations = await savedRevisionAllocations(input.prisma, prior.id);
    const candidate = { ...prior, revision: request.revision, observation: null };
    const read = readRevision ?? (await import("./compute-observer.ts")).readConfiguredComputeObservation;
    const output = await read({ prisma: input.prisma, config: input.config }, owned.task, candidate, resource, []);
    const observation = ComputeObservation.parse(output.observation);
    assertSavedComputeStopped(candidate, observation, at(input), input.policy.collectorFreshnessSeconds);
    if (output.traffic.length) throw new Error("Saved revision cannot inherit traffic coverage");
    return { resource, allocations, observation };
  })();
  return input.prisma.$transaction(async store => {
    const owned = await computeTaskOwner(store, input.taskId, input.machineId);
    if (request.saved) await assertSavedComputeResource(store, { taskId: input.taskId, ...request, saved: request.saved });
    const old = await store.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
    if (old) {
      if (old.taskIdentity !== owned.identity || old.purpose !== request.purpose || old.recipeDigest !== request.recipeDigest) throw new Error("Compute request identity changed");
      assertSavedComputeRequest(old, request.saved);
      if (transition && "unstarted" in transition) {
        const evidence = await unstartedRevisionEvidence(store, old);
        if (finalizationDigest(old) !== finalizationDigest(prior) || finalizationDigest(evidence) !== finalizationDigest(transition.unstarted)
          || await readUnstartedHead(evidence.worktree) !== request.revision) throw new Error("Unstarted compute revision changed during observation");
        // Withdraw old unclaimed offers without rotating the existing queue.
        // Old instructions and results remain; their old offers cannot claim.
        for (const offer of evidence.allocations.offers) if (["queued", "offered"].includes(offer.state)) await withdraw(store, offer.id, "ineligible", at(input), { preserveQueue: true });
        await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: old.primarySessionId, source: `compute:${old.taskId}`, action: "compute-unstarted-revision", key: finalizationDigest({ environmentId: old.id, from: old.revision, to: request.revision }), value: JSON.stringify({ version: 1, environmentId: old.id, taskIdentity: old.taskIdentity, fromRevision: old.revision, toRevision: request.revision, evidence }) } });
        return store.computeEnvironment.update({ where: { id: old.id }, data: { revision: request.revision, state: "waiting" } });
      }
      if (transition) {
        const current = await store.remoteTaskResource.findUniqueOrThrow({ where: { id: transition.resource.id } });
        const allocations = await savedRevisionAllocations(store, old.id);
        if (finalizationDigest(old) !== finalizationDigest(prior) || finalizationDigest(current) !== finalizationDigest(transition.resource)
          || finalizationDigest(allocations) !== finalizationDigest(transition.allocations)) throw new Error("Saved compute revision changed during observation");
        assertSavedComputeStopped({ ...old, revision: request.revision }, transition.observation, at(input), input.policy.collectorFreshnessSeconds);
        // Keep original offer IDs/results. Even an already dispatched old
        // instruction cannot claim its now-withdrawn offer at the new HEAD.
        for (const offer of allocations.offers) if (["queued", "offered"].includes(offer.state)) await withdraw(store, offer.id, "ineligible", at(input));
        await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: old.primarySessionId, source: `compute:${old.taskId}`, action: "compute-saved-revision", key: finalizationDigest({ environmentId: old.id, from: old.revision, to: request.revision, previous: finalizationDigest(old) }), value: JSON.stringify({ version: 1, environmentId: old.id,
          taskIdentity: old.taskIdentity, resourceId: old.resourceId, resourceIdentity: old.resourceIdentity, fromRevision: old.revision, toRevision: request.revision,
          previousObservation: old.observation, observation: transition.observation, offers: allocations.offers.map(value => ({ id: value.id, state: value.state, instructionId: value.instructionId })) }) } });
        const updated = await store.computeEnvironment.update({ where: { id: old.id }, data: { revision: request.revision, observation: transition.observation, state: "waiting" } });
        await rotate(store, updated, at(input)); return updated;
      }
      if (old.revision !== request.revision) throw new Error("Compute request identity changed");
      if (old.state === "suspended" && !(await store.computeWait.findUnique({ where: { environmentId: old.id } }))) await rotate(store, old, at(input));
      return old;
    }
    const { saved, ...recipe } = request;
    const environment = await store.computeEnvironment.create({ data: { id: randomUUID(), taskId: input.taskId, primarySessionId: owned.session.id, machineId: input.machineId, taskIdentity: owned.identity, ...recipe,
      ...(saved ? { resourceId: saved.resourceId, resourceIdentity: saved.resourceIdentity } : {}) } });
    await rotate(store, environment, at(input)); return environment;
  });
}

const terminalInstruction = ["completed", "failed", "cancelled"];
async function startedEvent(store: Pick<Store, "runtimeLifecycleEvent">, sessionId: string, requestId: string | null) {
  return requestId ? store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: sessionId, requestId, phase: "started" }, orderBy: { sequence: "asc" } }) : null;
}
/** Progress only: the slot was reserved at selection. Idempotent. */
async function recordDelivery(store: Store, offerId: string, requestId: string, occurredAt: Date) {
  const updated = await store.computeOffer.updateMany({ where: { id: offerId, state: "queued" }, data: { state: "offered", executionRequestId: requestId, deliveredAt: occurredAt, expiresAt: null } });
  return { recorded: updated.count === 1, offer: await store.computeOffer.findUniqueOrThrow({ where: { id: offerId } }) };
}
/** A legacy queued offer (created before selection-time reservation) may
 * reserve conservatively when delivered; never by refreshing accounting. */
async function reserveLegacyDelivery(store: Store, input: Context, offerId: string) {
  if (await store.computeSlot.findUnique({ where: { allocationId: offerId } })) return true;
  const slot = await freeSlot(store, input);
  if (!slot) return false;
  return (await store.computeSlot.updateMany({ where: { id: slot.id, allocationId: null }, data: { allocationId: offerId } })).count === 1;
}
async function sessionQuiescent(store: Pick<Store, "runtimeSession">, sessionId: string, runtime?: Context["runtime"]) {
  const session = await store.runtimeSession.findUnique({ where: { id: sessionId } });
  return Boolean(session && (session.closedAt || ["idle", "closed"].includes(session.status)) && !["executing", "queued"].includes(runtime?.observeSessionActivity?.(sessionId)?.state ?? ""));
}

/** Release only with proof. Owner ineligibility withdraws unclaimed offers
 * (claims recheck ownership atomically). Otherwise: a never-dispatched
 * assignment is withdrawn only by cancelling its still-queued instruction
 * (compare-and-set); a delivered assignment is released only after its turn
 * ended without claiming and the primary is quiescent; dispatching/unknown
 * turns keep their reservation regardless of any timer. Validation never
 * authorizes a start, so an expired validation not running in this process
 * is reclaimed. */
export async function reconcileComputeOffers(input: Context) {
  policy(input); const now = at(input);
  const offers = await input.prisma.computeOffer.findMany({ where: { machineId: input.machineId, state: { in: ["queued", "offered", "validating", "claimed"] } }, take: 1001 });
  if (offers.length > 1000) throw new Error("Compute offer reconciliation exceeds its bound");
  await settleUndispatchableRetries(input);
  for (const listed of offers) {
    await input.prisma.$transaction(async store => {
      const offer = await store.computeOffer.findUniqueOrThrow({ where: { id: listed.id } });
      if (offer.state === "claimed") {
        // A timeout does not prove a partial startup absent and never frees it.
        if (offer.claimedAt && now.getTime() - offer.claimedAt.getTime() >= input.policy.startupTimeoutSeconds * 1000) {
          await store.computeOffer.update({ where: { id: offer.id }, data: { state: "unknown" } });
          await store.computeEnvironment.update({ where: { id: offer.environmentId }, data: { state: "unknown" } });
        }
        return;
      }
      if (!["queued", "offered", "validating"].includes(offer.state)) return;
      const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
      try { await assertComputeEnvironmentOwner(store, environment); }
      catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; await withdraw(store, offer.id, "ineligible", now); return; }
      if (offer.state === "validating") {
        if (offer.validationExpiresAt && offer.validationExpiresAt <= now && !claimValidations.get(input.prisma)?.has(offer.id)) await withdraw(store, offer.id, "expired", now);
        return;
      }
      const instruction = await store.runtimeInstruction.findUnique({ where: { id: offer.instructionId } });
      if (!instruction) { await withdraw(store, offer.id, "ineligible", now); return; }
      const started = await startedEvent(store, instruction.sessionId, instruction.executionRequestId);
      if (offer.state === "queued") {
        if (started) {
          // Lost delivery acknowledgment: recover the exact persisted start.
          if (await reserveLegacyDelivery(store, input, offer.id)) await recordDelivery(store, offer.id, instruction.executionRequestId!, started.occurredAt);
          else if (terminalInstruction.includes(instruction.state) && await sessionQuiescent(store, instruction.sessionId, input.runtime)) await withdraw(store, offer.id, "expired", now);
          return;
        }
        if (instruction.state === "queued") {
          if (offer.dispatchDeadline > now) return;
          // Never-started proof: the still-queued message is cancelled first.
          const cancelled = await store.runtimeInstruction.updateMany({ where: { id: instruction.id, state: "queued" }, data: { state: "cancelled", detail: "Compute assignment was not dispatched in time; its reservation was released" } });
          if (cancelled.count === 1) await withdraw(store, offer.id, "expired", now);
          return;
        }
        if (terminalInstruction.includes(instruction.state)) await withdraw(store, offer.id, "expired", now);
        return; // dispatching/unknown without a start record: uncertain, keep.
      }
      // Delivered and unclaimed: held while the delivering turn runs.
      if (terminalInstruction.includes(instruction.state) && await sessionQuiescent(store, instruction.sessionId, input.runtime)) await withdraw(store, offer.id, "expired", now);
    });
  }
}

/** An owner retry re-queues a previously dispatched offer turn. If its
 * assignment was meanwhile claimed (startup intent: only the adapter's own
 * idempotent claim continues it) or withdrawn, the retry can never dispatch;
 * cancel it (compare-and-set on the still-queued instruction) with the reason
 * instead of leaving it queued. Nothing here frees or changes a slot. */
async function settleUndispatchableRetries(input: Context) {
  const retried = await input.prisma.runtimeInstruction.findMany({ where: { id: { startsWith: "compute-offer:" }, state: "queued", executionRequestId: { not: null } }, take: 1001 });
  if (retried.length > 1000) throw new Error("Compute retry reconciliation exceeds its bound");
  for (const instruction of retried) {
    const offer = await input.prisma.computeOffer.findUnique({ where: { instructionId: instruction.id } });
    if (!offer || offer.machineId !== input.machineId || ["queued", "offered", "validating"].includes(offer.state)) continue;
    const detail = ["claimed", "running", "unknown"].includes(offer.state)
      ? `Compute assignment ${offer.id} is already ${offer.state}; its start continues only through the adapter's own claim, not a redelivered offer turn`
      : `Compute assignment ${offer.id} was ${offer.state}; a retried offer turn cannot redeem it`;
    await input.prisma.runtimeInstruction.updateMany({ where: { id: instruction.id, state: "queued", updatedAt: instruction.updatedAt }, data: { state: "cancelled", detail } });
  }
}

type WaiterStore = Pick<Store, "computeWait" | "computeEnvironment" | "computeOffer" | "runtimeInstruction" | "runtimeMetadataEvent" | "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "remoteTaskResource">;
/** Cheap eligibility filter, run before any physical accounting scan. A
 * closed task/primary retires its wait with a durable receipt; paused or
 * otherwise temporarily ineligible waiters are kept for later resumption. */
export async function eligibleComputeWaiters(store: WaiterStore, input: Context) {
  const queue = await store.computeWait.findMany({ where: { machineId: input.machineId, eligibleAt: { lte: at(input) } }, orderBy: { sequence: "asc" }, take: 1001 });
  if (queue.length > 1000) throw new Error("Compute waiting queue exceeds its bound");
  const eligible: Array<{ wait: typeof queue[number]; environment: ComputeEnvironment; owned: Awaited<ReturnType<typeof assertComputeEnvironmentOwner>> }> = [];
  for (const wait of queue) {
    const environment = await store.computeEnvironment.findUnique({ where: { id: wait.environmentId } });
    const task = environment && await store.remoteTask.findUnique({ where: { id: environment.taskId } });
    const primary = task?.primarySessionId ? await store.runtimeSession.findUnique({ where: { id: task.primarySessionId } }) : null;
    if (!environment || !task || task.phase === "closed" || !primary || primary.closedAt || primary.status === "closed") {
      // Terminal only: remove exactly this wait row and audit what proved it.
      const removed = await store.computeWait.deleteMany({ where: { environmentId: wait.environmentId, sequence: wait.sequence, machineId: wait.machineId } });
      if (removed.count === 1 && environment) await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: environment.primarySessionId, source: `compute:${environment.taskId}`, action: "compute-wait-retired", key: `${environment.id}:${wait.sequence}`,
        value: JSON.stringify({ version: 1, environmentId: environment.id, taskId: environment.taskId, primarySessionId: environment.primarySessionId, machineId: wait.machineId,
          wait: { sequence: wait.sequence, eligibleAt: wait.eligibleAt.toISOString() },
          reason: !task ? "task-missing" : task.phase === "closed" ? "task-closed" : "primary-closed",
          evidence: { taskPhase: task?.phase ?? null, primarySessionId: task?.primarySessionId ?? null, primaryStatus: primary?.status ?? null, primaryClosedAt: primary?.closedAt?.toISOString() ?? null } }) } });
      continue;
    }
    let owned;
    try { owned = await assertComputeEnvironmentOwner(store as Store, environment); } catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; continue; }
    if (owned.session.status !== "idle" || await store.computeOffer.findFirst({ where: { environmentId: environment.id, state: { in: activeOffers } } })
      || await store.runtimeInstruction.count({ where: { sessionId: owned.session.id, state: { in: ["queued", "preparing", "dispatching", "unknown"] } } })) continue;
    eligible.push({ wait, environment, owned });
  }
  return eligible;
}

/** Selection reserves before dispatch: after exact eligibility and a fresh
 * conservative accounting decision, one transaction creates the offer, its
 * notification and the slot reservation. The notification therefore names a
 * durable assignment; delivery only records progress. */
export async function offerNextCompute(input: Context) {
  const settings = policy(input); await reconcileComputeOffers(input);
  // One pending assignment per host avoids a burst of messages.
  if (await input.prisma.computeOffer.findFirst({ where: { machineId: input.machineId, state: "queued" } })) return null;
  if (!(await input.prisma.$transaction(store => eligibleComputeWaiters(store, input))).length) return null;
  await refreshBaseline(input);
  return input.prisma.$transaction(async store => {
    if (await store.computeOffer.findFirst({ where: { machineId: input.machineId, state: "queued" } })) return null;
    const slot = await freeSlot(store, input);
    if (!slot) return null;
    for (const { environment, owned } of await eligibleComputeWaiters(store, input)) {
      const id = randomUUID(), instructionId = `compute-offer:${id}`;
      const command = isSavedComputeEnvironment(environment) ? `resource resume --key ${environment.key} --compute-offer ${id}` : `normal runtime start command with --compute-offer ${id}`;
      const offer = await store.computeOffer.create({ data: { id, environmentId: environment.id, machineId: input.machineId, instructionId, dispatchDeadline: new Date(at(input).getTime() + settings.deliveryTimeoutSeconds * 1000) } });
      const reserved = await store.computeSlot.updateMany({ where: { id: slot.id, allocationId: null }, data: { allocationId: offer.id } });
      if (reserved.count !== 1) throw new Error("Compute capacity changed before reservation");
      await store.computeEnvironment.update({ where: { id: environment.id }, data: { state: "offered" } });
      await store.runtimeInstruction.create({ data: { id: instructionId, sessionId: owned.session.id, text:
        `Compute capacity is reserved for environment ${environment.id} (offer ${id}). The reservation is held while this turn runs and is released if this turn ends without claiming it. First resolve_tooling_capability with capability runtime, then use that returned immutable adapter for the ${command}. Preserve the original task tooling pin. A conversational reply does not claim it. If the command reports the offer superseded, continue useful work without compute; the service will offer again fairly. Preserve the task's existing work and data.` } });
      return store.computeOffer.findUniqueOrThrow({ where: { id: offer.id } });
    }
    return null;
  });
}

const schedulers = new WeakMap<PrismaClient, Map<string, Promise<unknown>>>();
/** Coalesced, bounded scheduler tick: at most one selection per host runs at
 * a time, off the inbox delivery path. Errors are retained as diagnostics. */
export function scheduleComputeOffers(input: Context): Promise<unknown> {
  let running = schedulers.get(input.prisma);
  if (!running) { running = new Map(); schedulers.set(input.prisma, running); }
  const active = running.get(input.machineId);
  if (active) return active;
  const work = offerNextCompute(input).catch(error => { console.error(`Compute admission requires reconciliation: ${error instanceof Error ? error.message : String(error)}`); return null; })
    .finally(() => { if (running!.get(input.machineId) === work) running!.delete(input.machineId); });
  running.set(input.machineId, work);
  return work;
}

/** Turn-start progress for an already reserved assignment. No accounting
 * refresh or capacity decision happens here, so a slow scan cannot expire it. */
export async function confirmComputeDelivery(input: Context & { sessionId: string; requestId: string }) {
  policy(input);
  return input.prisma.$transaction(async store => {
    const instruction = await store.runtimeInstruction.findFirst({ where: { sessionId: input.sessionId, executionRequestId: input.requestId } });
    if (!instruction) return null;
    const offer = await store.computeOffer.findUnique({ where: { instructionId: instruction.id } });
    if (!offer || offer.state !== "queued") return offer;
    const started = await startedEvent(store, input.sessionId, input.requestId);
    if (!started || !["dispatching", "completed", "failed", "cancelled", "unknown"].includes(instruction.state)) return null;
    const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
    try { await assertComputeEnvironmentOwner(store, environment); }
    catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; await withdraw(store, offer.id, "ineligible", at(input)); return null; }
    if (environment.primarySessionId !== input.sessionId || offer.machineId !== input.machineId) throw new Error("Compute offer delivery ownership changed");
    // Started work is never expired by a timer; an unreserved legacy offer
    // stays queued until its turn ends, then reconciliation releases it.
    if (!await reserveLegacyDelivery(store, input, offer.id)) return offer;
    return (await recordDelivery(store, offer.id, input.requestId, started.occurredAt)).offer;
  });
}

const claimValidations = new WeakMap<PrismaClient, Map<string, Promise<unknown>>>();
type ClaimInput = Context & { taskId: string; offerId: string; request: z.infer<typeof ComputeRequest> };

export async function claimCompute(input: ClaimInput, refresh = refreshBaseline) {
  policy(input); const request = ComputeRequest.parse(input.request);
  let pending = claimValidations.get(input.prisma);
  if (!pending) { pending = new Map(); claimValidations.set(input.prisma, pending); }
  // Persist timely intent and retain the existing slot before slow physical
  // reads. VALIDATING is never start authority; redeeming the same
  // reservation after a lost acknowledgment or restart is idempotent.
  const reservation = await input.prisma.$transaction(async store => {
    let offer = await store.computeOffer.findUniqueOrThrow({ where: { id: input.offerId } });
    const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
    await assertComputeEnvironmentOwner(store, environment);
    const { saved, ...recipe } = request;
    if (environment.taskId !== input.taskId || environment.machineId !== input.machineId || Object.entries(recipe).some(([key, value]) => environment[key as keyof typeof recipe] !== value)) throw new Error("Compute claim does not match its exact environment");
    assertSavedComputeRequest(environment, saved);
    if (["claimed", "running", "unknown"].includes(offer.state)) { await assertComputeStartIntent(store, input.taskId, environment.id, offer.id); return { completed: { offer, environment, resumed: true }, token: null }; }
    if (!["queued", "offered", "validating"].includes(offer.state)) throw new Error("Compute offer is expired or superseded");
    // Join an in-flight redemption only after this caller's exact owner, task
    // and recipe were verified above; never touch its token.
    if (offer.state === "validating" && pending!.has(offer.id)) return { completed: null, token: null, join: true };
    if (!await store.computeSlot.findUnique({ where: { allocationId: offer.id } })) throw new Error("Compute reservation is unavailable");
    if (offer.state === "validating") {
      // Redeem the same reservation and token; a concurrent redeemer of the
      // same identity shares it rather than superseding it.
      const token = offer.validationToken ?? randomUUID();
      await store.computeOffer.update({ where: { id: offer.id }, data: { validationToken: token, validationExpiresAt: new Date(at(input).getTime() + COMPUTE_VALIDATION_MS) } });
      return { completed: null, token };
    }
    const instruction = await store.runtimeInstruction.findUnique({ where: { id: offer.instructionId } });
    if (offer.state === "queued" && instruction) {
      // A start whose delivery acknowledgment was lost is recovered exactly.
      const started = await startedEvent(store, instruction.sessionId, instruction.executionRequestId);
      if (started) offer = (await recordDelivery(store, offer.id, instruction.executionRequestId!, started.occurredAt)).offer;
    }
    // Only the delivering turn (running or uncertain) may redeem it.
    if (offer.state !== "offered" || !instruction || !["dispatching", "unknown"].includes(instruction.state)) throw new Error("Compute offer is expired or superseded");
    if (saved) {
      const observed = ComputeObservation.safeParse(environment.observation);
      if (!observed.success) throw new Error("Saved compute requires a fresh stopped observation before claiming");
      assertSavedComputeStopped(environment, observed.data, at(input), input.policy.collectorFreshnessSeconds);
    }
    const token = randomUUID();
    await store.computeOffer.update({ where: { id: offer.id }, data: { state: "validating", validationToken: token, validationExpiresAt: new Date(at(input).getTime() + COMPUTE_VALIDATION_MS) } });
    return { completed: null, token };
  });
  if (reservation.completed) return reservation.completed;
  const existing = pending.get(input.offerId);
  // Every caller reaching here passed its own exact identity checks.
  if (existing) return existing as ReturnType<typeof finishComputeValidation>;
  // The joined validation finished in between: re-read its durable outcome.
  if ("join" in reservation) return claimCompute(input, refresh);
  const work = finishComputeValidation(input, request, reservation.token!, refresh);
  pending.set(input.offerId, work);
  try { return await work; } finally { if (pending.get(input.offerId) === work) pending.delete(input.offerId); }
}

async function finishComputeValidation(input: ClaimInput, request: z.infer<typeof ComputeRequest>, token: string, refresh: typeof refreshBaseline) {
  try {
    await refresh(input);
    return await input.prisma.$transaction(async store => {
      const offer = await store.computeOffer.findUniqueOrThrow({ where: { id: input.offerId } });
      const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
      await assertComputeEnvironmentOwner(store, environment);
      const { saved, ...recipe } = request;
      if (environment.taskId !== input.taskId || environment.machineId !== input.machineId || Object.entries(recipe).some(([key, value]) => environment[key as keyof typeof recipe] !== value)) throw new Error("Compute claim identity changed during validation");
      assertSavedComputeRequest(environment, saved);
      // A same-identity redeemer already completed this reservation.
      if (["claimed", "running", "unknown"].includes(offer.state)) { await assertComputeStartIntent(store, input.taskId, environment.id, offer.id); return { offer, environment, resumed: true }; }
      // The token is the reservation's redemption identity; its deadline only
      // lets reconciliation reclaim a validation no longer running here.
      if (offer.state !== "validating" || offer.validationToken !== token) throw new Error("Compute validation expired or superseded");
      if (saved) {
        const observed = ComputeObservation.safeParse(environment.observation);
        if (!observed.success) throw new Error("Saved compute requires a fresh stopped observation before claiming");
        assertSavedComputeStopped(environment, observed.data, at(input), input.policy.collectorFreshnessSeconds);
      }
      if (!await store.computeSlot.findUnique({ where: { allocationId: offer.id } })) throw new Error("Compute reservation is unavailable");
      const capacity = await computeAdmissionCapacity(store, input);
      if (capacity.occupied + capacity.unaccounted > capacity.slots || capacity.occupied > capacity.usable) throw new ComputeCapacityBlocked(capacity);
      const claimed = await store.computeOffer.update({ where: { id: offer.id }, data: { state: "claimed", claimedAt: at(input), validationToken: null, validationExpiresAt: null } });
      await store.computeWait.deleteMany({ where: { environmentId: environment.id } });
      const updated = await store.computeEnvironment.update({ where: { id: environment.id }, data: { state: "starting" } });
      await supersedeRuntimeSuspension(store, input.taskId, environment.id, offer.id);
      await assertComputeStartIntent(store, input.taskId, environment.id, offer.id);
      return { offer: claimed, environment: updated, resumed: false };
    });
  } catch (error) {
    // A failed observer does not free a reservation. The durable validation
    // deadline, explicit decline or owner reconciliation releases it safely.
    throw error;
  }
}

export async function declineCompute(input: Context & { taskId: string; offerId: string }) {
  policy(input);
  return input.prisma.$transaction(async store => {
    const offer = await store.computeOffer.findUniqueOrThrow({ where: { id: input.offerId } });
    const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
    await assertComputeEnvironmentOwner(store, environment);
    if (environment.taskId !== input.taskId || environment.machineId !== input.machineId) throw new Error("Compute decline ownership changed");
    return { declined: await withdraw(store, offer.id, "declined", at(input)) };
  });
}

/** The ordinary inbox must not execute a withdrawn or foreign compute offer.
 * This gate creates no slot and does not start the offer's claim clock. */
export async function computeInstructionAllows(store: Store, receipt: { id: string; sessionId: string }, now = new Date()) {
  if (!receipt.id.startsWith("compute-offer:")) return true;
  const offer = await store.computeOffer.findUnique({ where: { instructionId: receipt.id } });
  if (!offer) return false;
  const environment = await store.computeEnvironment.findUnique({ where: { id: offer.environmentId } });
  if (!environment || environment.primarySessionId !== receipt.sessionId) return false;
  // A queued assignment dispatches before its deadline. A delivered,
  // unclaimed one redispatches only for the owner's explicit retry of its
  // interrupted turn, on its same still-reserved slot.
  if (offer.state === "queued" ? offer.dispatchDeadline <= now : !(await ownerRetriesDeliveredOffer(store, offer, environment, receipt))) return false;
  try { await assertComputeEnvironmentOwner(store, environment); return true; } catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; return false; }
}

const RetryDecision = z.object({ action: z.literal("retry") }).passthrough();
/** Durable proof that the owner retried THIS delivered, unclaimed
 * assignment's interrupted turn (resolveTaskInstruction verified the
 * provider was not alive and recorded the decision): the same instruction is
 * queued again after a real delivery, its latest supervisor decision is a
 * retry made after that delivery, and the same slot is still reserved. A
 * claimed, validating or withdrawn assignment is never redispatched. */
async function ownerRetriesDeliveredOffer(store: Store, offer: { id: string; state: string; deliveredAt: Date | null; executionRequestId: string | null; machineId: string },
  environment: ComputeEnvironment, receipt: { id: string; sessionId: string }) {
  if (offer.state !== "offered" || !offer.deliveredAt || !offer.executionRequestId || offer.machineId !== environment.machineId) return false;
  const instruction = await store.runtimeInstruction.findUnique({ where: { id: receipt.id } });
  if (!instruction || instruction.sessionId !== receipt.sessionId || instruction.state !== "queued" || !instruction.executionRequestId) return false;
  const decision = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: receipt.sessionId, source: `task-supervisor:${environment.taskId}`,
    action: "instruction-resolved", key: receipt.id }, orderBy: { sequence: "desc" } });
  let retry = false;
  try { retry = RetryDecision.safeParse(JSON.parse(decision?.value ?? "null")).success; } catch { retry = false; }
  if (!decision || !retry || decision.occurredAt < offer.deliveredAt) return false;
  return Boolean(await store.computeSlot.findFirst({ where: { allocationId: offer.id, machineId: offer.machineId } }));
}

/** Binds the claimed slot to its first exact runtime receipt before any Docker
 * create. It cannot transfer an allocation to another recipe or container. */
export async function bindComputeResource(input: Context & { taskId: string; offerId: string; resourceKey: string }) {
  return input.prisma.$transaction(async store => {
    const offer = await store.computeOffer.findUniqueOrThrow({ where: { id: input.offerId } });
    const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
    await assertComputeEnvironmentOwner(store, environment);
    if (environment.taskId !== input.taskId || environment.machineId !== input.machineId || !["claimed", "running", "unknown"].includes(offer.state)
      || !(await store.computeSlot.findUnique({ where: { allocationId: offer.id } }))) throw new Error("Runtime allocation is unavailable");
    const resource = await store.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: input.taskId, key: input.resourceKey } } });
    const metadata = z.object({ recipeHash: z.string(), revision: z.string() }).parse(resource.metadata);
    if (resource.kind !== "task-runtime" || resource.purpose !== environment.purpose || resource.key !== environment.key || resource.state === "released"
      || metadata.recipeHash !== environment.recipeDigest || metadata.revision !== environment.revision || environment.resourceId && environment.resourceId !== resource.id) throw new Error("Runtime allocation resource changed");
    const { finalizationResourceIdentity } = await import("./finalization-resources.ts");
    const identity = finalizationResourceIdentity(resource);
    await store.computeEnvironment.update({ where: { id: environment.id }, data: { resourceId: resource.id, resourceIdentity: identity.identityDigest } });
    return { environmentId: environment.id, resourceId: resource.id, resourceIdentity: identity.identityDigest };
  });
}

/** Only a fresh independently observed exact lifetime can release a claimed
 * slot. Timeouts, receipt states and absence of a provider turn are not proof. */
export async function reconcileObservedCompute(input: Context & { environmentId: string; runtime: Pick<AgentSessionRuntime, "observeSessionActivity"> }) {
  const result = await reconcileObservedComputeOnce(input);
  if (result.released) await (await import("./tooling-operations.ts")).resolveEnvironmentConsumers(input.prisma, input.environmentId, { kind: "stopped", reference: input.environmentId })
    .catch(error => console.warn(`Retained readers of ${input.environmentId} remain until reconciled: ${error instanceof Error ? error.message : String(error)}`));
  return result;
}
async function reconcileObservedComputeOnce(input: Context & { environmentId: string; runtime: Pick<AgentSessionRuntime, "observeSessionActivity"> }) {
  return input.prisma.$transaction(async store => {
    const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
    await assertComputeEnvironmentOwner(store, environment);
    const observation = ComputeObservation.parse(environment.observation);
    if (isSavedComputeEnvironment(environment)) assertSavedComputeObservation(environment, observation, true);
    const resource = environment.resourceId && await store.remoteTaskResource.findUnique({ where: { id: environment.resourceId } });
    if (!resource || observation.environmentId !== environment.id || observation.taskId !== environment.taskId || observation.primarySessionId !== environment.primarySessionId
      || observation.resourceId !== resource.id || observation.resourceIdentity !== finalizationResourceIdentity(resource).identityDigest
      || observation.observedAt > at(input).getTime() || at(input).getTime() - observation.observedAt > input.policy.collectorFreshnessSeconds * 1000) throw new Error("Compute physical allocation evidence changed");
    const offers = await store.computeOffer.findMany({ where: { environmentId: environment.id, state: { in: ["claimed", "running", "unknown"] } }, take: 2 });
    if (offers.length > 1) throw new Error("Compute has ambiguous allocations");
    const offer = offers[0];
    const slot = offer && await store.computeSlot.findUnique({ where: { allocationId: offer.id } });
    if (offer && (!slot || slot.machineId !== input.machineId)) throw new Error("Compute slot ownership changed");
    if (observation.state === "running") {
      if (offer) await store.computeOffer.update({ where: { id: offer.id }, data: { state: "running" } });
      await store.computeEnvironment.update({ where: { id: environment.id }, data: { state: "running" } });
      return { released: false };
    }
    if (observation.state !== "stopped" || offer && !["running", "unknown"].includes(offer.state)) return { released: false };
    const task = await store.remoteTask.findUniqueOrThrow({ where: { id: environment.taskId } });
    const sessions = await store.runtimeSession.findMany({ where: { cwd: task.worktreePath! }, take: 1001 });
    if (sessions.length > 1000 || sessions.some(value => !value.closedAt && (!["idle", "closed"].includes(value.status)
      || ["executing", "queued"].includes(input.runtime.observeSessionActivity?.(value.id)?.state ?? "")))) return { released: false };
    if (await store.runtimeInstruction.count({ where: { sessionId: { in: sessions.map(value => value.id) }, state: { in: ["queued", "preparing", "dispatching", "unknown"] } } })) return { released: false };
    const lifecycle = await store.runtimeLifecycleEvent.findMany({ where: { runtimeSessionId: { in: sessions.map(value => value.id) } }, orderBy: { sequence: "desc" }, take: 1001 });
    if (sessions.some(session => !session.closedAt && lifecycle.find(value => value.runtimeSessionId === session.id)?.phase === "started")) return { released: false };
    if (offer && slot) {
      await store.computeOffer.update({ where: { id: offer.id }, data: { state: "stopped", completedAt: at(input) } });
      await store.computeSlot.update({ where: { id: slot.id }, data: { allocationId: null } });
    }
    await store.computeEnvironment.update({ where: { id: environment.id }, data: { state: "suspended" } });
    return { released: true };
  });
}
