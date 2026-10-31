import { assertComputeStartIntent, assertDevelopmentWork, DevelopmentWorkUnavailable, supersedeRuntimeSuspension } from "./development-intent.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient, ComputeEnvironment } from "../../../../generated/prisma/client.ts";
import { COMPUTE_CLAIM_MS, ComputePolicy } from "../../../../lib/compute-policy.ts";
import { ComputeObservation } from "./compute-observation.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { SavedComputeBinding, SavedComputeIdentityChanged, assertSavedComputeObservation, assertSavedComputeRequest, assertSavedComputeResource, assertSavedComputeStopped, isSavedComputeEnvironment } from "./compute-saved-resource.ts";

import { ComputeReclamation } from "./compute-reclamation-schema.ts";
type Store = Prisma.TransactionClient;
type Context = { prisma: PrismaClient; machineId: string; policy: ComputePolicy; now?: Date; config?: ServerConfig; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity"> };
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ComputeRequest = z.object({ key: Key, purpose: z.enum(["development", "review"]), revision: z.string().regex(/^[a-f0-9]{40}$/), recipeDigest: Digest, saved: SavedComputeBinding.optional() }).strict();
const activeOffers = ["queued", "offered", "claimed", "running", "unknown"];
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
/** Unknown existing environments consume the explicit budget conservatively.
 * A stale Ready/Allocated receipt is not proof that physical compute is free. */
async function unaccounted(store: Store, input: Context) {
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
  return new Set([...resources.filter(resource => !recorded.has(resource.id)).map(resource => `${resource.taskId}:${resource.purpose}`),
    ...originalClaims.map(group => `${group.taskId}:${group.purpose}`),
    ...uncertain.map(environment => `${environment.taskId}:${environment.purpose}`)]).size;
}
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
async function freeSlot(store: Store, input: Context) {
  const settings = policy(input), unavailable = await unaccounted(store, input);
  const usable = Math.max(0, settings.slots - unavailable);
  // Count allocations at every ordinal, including slots left above a reduced
  // budget. Moving the free-slot range alone could overbook the host.
  const occupied = await store.computeSlot.count({ where: { machineId: input.machineId, allocationId: { not: null } } });
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
async function withdraw(store: Store, offerId: string, reason: "expired" | "declined" | "ineligible", now: Date) {
  const offer = await store.computeOffer.findUniqueOrThrow({ where: { id: offerId } });
  if (!["queued", "offered"].includes(offer.state)) return false;
  await store.computeOffer.update({ where: { id: offer.id }, data: { state: reason, completedAt: now } });
  await store.computeSlot.updateMany({ where: { allocationId: offer.id }, data: { allocationId: null } });
  // Only our undelivered queued message may be cancelled. Dispatching or
  // uncertain turns retain their ordinary inbox reconciliation semantics.
  await store.runtimeInstruction.updateMany({ where: { id: offer.instructionId, state: "queued" }, data: { state: "cancelled", detail: `Compute offer ${reason}` } });
  const env = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
  await store.computeEnvironment.update({ where: { id: env.id }, data: { state: "waiting" } });
  await rotate(store, env, now);
  return true;
}

export async function savedRevisionAllocations(store: Pick<Store, "computeOffer" | "computeSlot">, environmentId: string) {
  const offers = await store.computeOffer.findMany({ where: { environmentId }, orderBy: { id: "asc" }, take: 1001 });
  if (offers.length > 1000) throw new Error("Saved compute revision history exceeds its bound");
  if (offers.some(value => ["claimed", "running", "unknown"].includes(value.state))) throw new Error("Saved compute revision still has an active or uncertain allocation");
  const slots = await store.computeSlot.findMany({ where: { allocationId: { in: offers.map(value => value.id) } }, orderBy: { id: "asc" }, take: 1001 });
  if (slots.length > 1000 || slots.some(slot => !offers.some(offer => offer.id === slot.allocationId && offer.state === "offered" && offer.claimedAt === null))) throw new Error("Saved compute revision has an unexplained slot");
  return { offers, slots };
}

/** Owner enrollment can replace a stopped instrumentation generation, but it
 * never releases an executing allocation or gives an old offer a new recipe. */
export async function withdrawComputeConfigurationOffers(store: Store, environment: ComputeEnvironment, allocations: Awaited<ReturnType<typeof savedRevisionAllocations>>, now: Date) {
  const waiting = await store.computeWait.findUnique({ where: { environmentId: environment.id } });
  for (const offer of allocations.offers) if (["queued", "offered"].includes(offer.state)) await withdraw(store, offer.id, "ineligible", now);
  if (waiting) await rotate(store, environment, now);
}

export async function requestCompute(input: Context & { taskId: string; request: z.infer<typeof ComputeRequest>; config?: ServerConfig }, readRevision?: typeof import("./compute-observer.ts").readConfiguredComputeObservation) {
  policy(input); const request = ComputeRequest.parse(input.request);
  const prior = await input.prisma.computeEnvironment.findUnique({ where: { taskId_key: { taskId: input.taskId, key: request.key } } });
  // A saved app can survive normal product commits. Observe the actual new
  // HEAD before changing its generation; never relabel an old observation.
  const transition = await (async () => {
    if (!prior || prior.revision === request.revision) return;
    if (!request.saved || !input.config || input.config.machine !== input.machineId) throw new Error("Compute request identity changed");
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

export async function reconcileComputeOffers(input: Context) {
  policy(input); const now = at(input);
  // A server may exit after persisting prompt-start but before reserving the
  // offer. Recover that exact event before considering dispatch expiry.
  const pending = await input.prisma.computeOffer.findMany({ where: { machineId: input.machineId, state: "queued" }, take: 1001 });
  if (pending.length > 1000) throw new Error("Compute offer reconciliation exceeds its bound");
  for (const offer of pending) {
    const instruction = await input.prisma.runtimeInstruction.findUnique({ where: { id: offer.instructionId } });
    if (instruction?.executionRequestId) {
      // Recheck this queued offer's ownership locally. A pause/revocation after
      // durable prompt-start must not strand all subsequent waiting tasks.
      const eligible = await input.prisma.$transaction(async store => {
        const current = await store.computeOffer.findUniqueOrThrow({ where: { id: offer.id } });
        if (current.state !== "queued") return false;
        const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: current.environmentId } });
        try { await assertComputeEnvironmentOwner(store, environment); return true; }
        catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; await withdraw(store, current.id, "ineligible", now); return false; }
      });
      if (eligible) await confirmComputeDelivery({ ...input, sessionId: instruction.sessionId, requestId: instruction.executionRequestId });
    }
  }
  return input.prisma.$transaction(async store => {
    const offers = await store.computeOffer.findMany({ where: { machineId: input.machineId, state: { in: ["queued", "offered", "claimed"] } }, take: 1001 });
    if (offers.length > 1000) throw new Error("Compute offer reconciliation exceeds its bound");
    for (const offer of offers) {
      if (offer.state === "claimed") {
        // A timeout does not prove a partial startup absent and never frees it.
        if (offer.claimedAt && now.getTime() - offer.claimedAt.getTime() >= input.policy.startupTimeoutSeconds * 1000) {
          await store.computeOffer.update({ where: { id: offer.id }, data: { state: "unknown" } });
          await store.computeEnvironment.update({ where: { id: offer.environmentId }, data: { state: "unknown" } });
        }
        continue;
      }
      const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
      try { await assertComputeEnvironmentOwner(store, environment); }
      catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; await withdraw(store, offer.id, "ineligible", now); continue; }
      const deadline = offer.state === "queued" ? offer.dispatchDeadline : offer.expiresAt;
      if (deadline && deadline <= now) await withdraw(store, offer.id, "expired", now);
    }
  });
}

/** Selection creates only a durable message. It reserves no capacity until
 * an exact persisted prompt-start event confirms delivery to the executing turn. */
export async function offerNextCompute(input: Context) {
  const settings = policy(input); await reconcileComputeOffers(input);
  if (!await input.prisma.computeWait.findFirst({ where: { machineId: input.machineId, eligibleAt: { lte: at(input) } } })) return null;
  await refreshBaseline(input);
  return input.prisma.$transaction(async store => {
    if (!(await freeSlot(store, input))) return null;
    // One pending delivery per host avoids a burst of messages for one slot.
    if (await store.computeOffer.findFirst({ where: { machineId: input.machineId, state: "queued" } })) return null;
    const queue = await store.computeWait.findMany({ where: { machineId: input.machineId, eligibleAt: { lte: at(input) } }, orderBy: { sequence: "asc" }, take: 1001 });
    if (queue.length > 1000) throw new Error("Compute waiting queue exceeds its bound");
    for (const entry of queue) {
      const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: entry.environmentId } });
      let owned;
      try { owned = await assertComputeEnvironmentOwner(store, environment); } catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; continue; }
      if (owned.session.status !== "idle" || await store.computeOffer.findFirst({ where: { environmentId: environment.id, state: { in: activeOffers } } })
        || await store.runtimeInstruction.count({ where: { sessionId: owned.session.id, state: { in: ["queued", "preparing", "dispatching", "unknown"] } } })) continue;
      const id = randomUUID(), instructionId = `compute-offer:${id}`;
      const command = isSavedComputeEnvironment(environment) ? `resource resume --key ${environment.key} --compute-offer ${id}` : `normal runtime start command with --compute-offer ${id}`;
      const offer = await store.computeOffer.create({ data: { id, environmentId: environment.id, machineId: input.machineId, instructionId, dispatchDeadline: new Date(at(input).getTime() + settings.deliveryTimeoutSeconds * 1000) } });
      await store.runtimeInstruction.create({ data: { id: instructionId, sessionId: owned.session.id, text:
        `Compute may be available for environment ${environment.id}. This offer is reserved only when this turn starts and expires 60 seconds after confirmed delivery. First resolve_tooling_capability with capability runtime, then use that returned immutable adapter for the ${command}. Preserve the original task tooling pin. A conversational reply does not claim it. If the command reports expired or superseded, continue useful work without compute; the service will offer again fairly. Preserve the task's existing work and data.` } });
      return offer;
    }
    return null;
  });
}

export async function confirmComputeDelivery(input: Context & { sessionId: string; requestId: string }) {
  policy(input);
  const candidate = await input.prisma.runtimeInstruction.findFirst({ where: { sessionId: input.sessionId, executionRequestId: input.requestId }, select: { id: true } });
  if (candidate && await input.prisma.computeOffer.findFirst({ where: { instructionId: candidate.id, state: "queued" } })) await refreshBaseline(input);
  return input.prisma.$transaction(async store => {
    const instruction = await store.runtimeInstruction.findFirst({ where: { sessionId: input.sessionId, executionRequestId: input.requestId } });
    if (!instruction) return null;
    const offer = await store.computeOffer.findUnique({ where: { instructionId: instruction.id } });
    if (!offer || offer.state !== "queued") return offer;
    const started = await store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: input.sessionId, requestId: input.requestId, phase: "started" }, orderBy: { sequence: "asc" } });
    if (!started || !["dispatching", "completed", "failed", "cancelled", "unknown"].includes(instruction.state)) return null;
    const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
    try { await assertComputeEnvironmentOwner(store, environment); }
    catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; await withdraw(store, offer.id, "ineligible", at(input)); return null; }
    if (environment.primarySessionId !== input.sessionId || offer.machineId !== input.machineId) throw new Error("Compute offer delivery ownership changed");
    const expiresAt = new Date(started.occurredAt.getTime() + COMPUTE_CLAIM_MS);
    if (expiresAt <= at(input) || started.occurredAt > offer.dispatchDeadline) { await withdraw(store, offer.id, "expired", at(input)); return null; }
    const slot = await freeSlot(store, input);
    if (!slot) { await withdraw(store, offer.id, "expired", at(input)); return null; }
    const claimed = await store.computeSlot.updateMany({ where: { id: slot.id, allocationId: null }, data: { allocationId: offer.id } });
    if (!claimed.count) throw new Error("Compute capacity changed before delivery");
    await store.computeEnvironment.update({ where: { id: environment.id }, data: { state: "offered" } });
    return store.computeOffer.update({ where: { id: offer.id }, data: { state: "offered", executionRequestId: input.requestId, deliveredAt: started.occurredAt, expiresAt } });
  });
}

export async function claimCompute(input: Context & { taskId: string; offerId: string; request: z.infer<typeof ComputeRequest> }) {
  policy(input); const request = ComputeRequest.parse(input.request);
  if (await input.prisma.computeOffer.findFirst({ where: { id: input.offerId, state: "offered" } })) await refreshBaseline(input);
  return input.prisma.$transaction(async store => {
    const offer = await store.computeOffer.findUniqueOrThrow({ where: { id: input.offerId } });
    const environment = await store.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
    await assertComputeEnvironmentOwner(store, environment);
    const { saved, ...recipe } = request;
    if (environment.taskId !== input.taskId || environment.machineId !== input.machineId || Object.entries(recipe).some(([key, value]) => environment[key as keyof typeof recipe] !== value)) throw new Error("Compute claim does not match its exact environment");
    assertSavedComputeRequest(environment, saved);
    if (["claimed", "running", "unknown"].includes(offer.state)) { await assertComputeStartIntent(store, input.taskId, environment.id, offer.id); return { offer, environment, resumed: true }; }
    if (offer.state !== "offered" || !offer.expiresAt || offer.expiresAt <= at(input)) throw new Error("Compute offer is expired or superseded");
    if (saved) {
      const observed = ComputeObservation.safeParse(environment.observation);
      if (!observed.success) throw new Error("Saved compute requires a fresh stopped observation before claiming");
      assertSavedComputeStopped(environment, observed.data, at(input), input.policy.collectorFreshnessSeconds);
    }
    const slot = await store.computeSlot.findUnique({ where: { allocationId: offer.id } });
    const occupied = await store.computeSlot.count({ where: { machineId: input.machineId, allocationId: { not: null } } });
    if (!slot || occupied + await unaccounted(store, input) > input.policy.slots) throw new Error("Compute reservation is unavailable");
    const claimed = await store.computeOffer.update({ where: { id: offer.id }, data: { state: "claimed", claimedAt: at(input) } });
    await store.computeWait.deleteMany({ where: { environmentId: environment.id } });
    const updated = await store.computeEnvironment.update({ where: { id: environment.id }, data: { state: "starting" } });
    await supersedeRuntimeSuspension(store, input.taskId, environment.id, offer.id);
    await assertComputeStartIntent(store, input.taskId, environment.id, offer.id);
    return { offer: claimed, environment: updated, resumed: false };
  });
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
  if (!offer || offer.state !== "queued" || offer.dispatchDeadline <= now) return false;
  const environment = await store.computeEnvironment.findUnique({ where: { id: offer.environmentId } });
  if (!environment || environment.primarySessionId !== receipt.sessionId) return false;
  try { await assertComputeEnvironmentOwner(store, environment); return true; } catch (error) { if (!(error instanceof ComputeOwnerUnavailable || error instanceof DevelopmentWorkUnavailable)) throw error; return false; }
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
