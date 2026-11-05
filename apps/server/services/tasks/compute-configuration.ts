import path from "node:path";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { assertComputeEnvironmentOwner, computeTaskOwner } from "./compute-admission.ts";
import { assertComputeStartIntent, developmentProjection } from "./development-intent.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { verifiedComputeRuntime, readConfiguredComputeObservation } from "./compute-observer.ts";
import { ComputeObservation, recordComputeObservation } from "./compute-observation.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { readComputeWorktreeRevision } from "./compute-worktree-revision.ts";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().max(4096).refine(p => path.isAbsolute(p) && path.normalize(p) === p);
const ComputeReference = z.object({ configurationFile: Absolute, configurationSha256: Sha }).strict();
export const ComputeConfiguration = z.object({ offerId: z.string().uuid(), resourceKey: z.string().min(1).max(180), previousRecipeHash: Sha, recipeHash: Sha,
  baselineFile: Absolute, lockPid: z.number().int().positive(), coverage: z.object({ previousFile: Absolute, next: ComputeReference }).strict(), }).strict();
const Proof = z.object({ version: z.literal(1), taskId: z.string(), primarySessionId: z.string(), environmentId: z.string().uuid(), resourceId: z.string(), offerId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{40}$/), previousRecipeHash: Sha, recipeHash: Sha, receiptSha256: Sha, baselineSha256: Sha, lockSha256: Sha, stopped: z.literal(true), compute: ComputeReference }).strict();
type Input = { prisma: PrismaClient; config: ServerConfig; taskId: string; request: z.infer<typeof ComputeConfiguration> };
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const Action = "compute-runtime-configuration";
async function snapshot(input: Omit<Input, "prisma"> & { prisma: Prisma.TransactionClient }) {
  const owner = await computeTaskOwner(input.prisma, input.taskId, input.config.machine);
  const offer = await input.prisma.computeOffer.findUniqueOrThrow({ where: { id: input.request.offerId } });
  const environment = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
  await assertComputeEnvironmentOwner(input.prisma, environment);
  const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: input.taskId, key: input.request.resourceKey } } });
  const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata);
  const offers = await input.prisma.computeOffer.findMany({ where: { environmentId: environment.id }, orderBy: { id: "asc" }, take: 1001 });
  const slots = await input.prisma.computeSlot.findMany({ where: { allocationId: { in: offers.map(value => value.id) } }, orderBy: { id: "asc" }, take: 1001 });
  if (offers.length > 1000 || slots.length > 1000) throw new Error("Configuration allocation history exceeds its bound");
  const allocations = { offers, slots };
  const active = allocations.offers.filter(o => ["queued", "offered", "claimed", "running", "unknown"].includes(o.state));
  const retained = ["claimed", "running", "unknown"].includes(offer.state) && !offer.completedAt && active.length === 1 && active[0]!.id === offer.id
    && slots.length === 1 && slots[0]!.allocationId === offer.id && slots[0]!.machineId === input.config.machine;
  const lastClaim = offers.filter(value => value.claimedAt).sort((a, b) => b.claimedAt!.getTime() - a.claimedAt!.getTime())[0];
  const stopped = offer.state === "stopped" && Boolean(offer.completedAt) && lastClaim?.id === offer.id && environment.state === "suspended" && active.length === 0 && slots.length === 0;
  const intent = await developmentProjection(input);
  if (owner.task.phase === "complete" || intent.developmentBlocked || intent.developmentIntent?.blocked
    || intent.developmentIntent?.action === "stop" && intent.developmentIntent.reason !== "runtime-suspended") throw new Error("Configuration was superseded by a development stop");
  if (retained) await assertComputeStartIntent(input.prisma, input.taskId, environment.id, offer.id);
  if (environment.taskId !== input.taskId || environment.primarySessionId !== owner.session.id || environment.taskIdentity !== owner.identity || environment.machineId !== input.config.machine
    || environment.purpose !== "development" || environment.configuration !== null || environment.key !== input.request.resourceKey
    || resource.kind !== "task-runtime" || resource.purpose !== environment.purpose || resource.state === "released" || environment.resourceId !== resource.id
    || metadata.revision !== environment.revision || ![input.request.previousRecipeHash, input.request.recipeHash].includes(String(metadata.recipeHash))
    || ![input.request.previousRecipeHash, input.request.recipeHash].includes(environment.recipeDigest) || input.request.previousRecipeHash === input.request.recipeHash
    || offer.machineId !== input.config.machine || !offer.claimedAt || !retained && !stopped) throw new Error("Configuration requires its exact retained claim or independently stopped unallocated runtime");
  const key = finalizationDigest({ environmentId: environment.id, offerId: offer.id, resourceId: resource.id, previousRecipeHash: input.request.previousRecipeHash, recipeHash: input.request.recipeHash });
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owner.session.id, source: `compute:${input.taskId}`, action: Action, key } });
  if (environment.recipeDigest === input.request.recipeHash && (!event || metadata.recipeHash !== input.request.recipeHash)) throw new Error("Configuration transition has no durable acknowledgment");
  const identity = finalizationResourceIdentity(resource).identityDigest;
  if (environment.resourceIdentity !== identity) {
    // save() publishes progress before its separate ordinary bind. A crash in
    // that gap may change the identity hash, but may not change any authority
    // or physical target. Only a committed transition can reconcile this gap.
    if (!event || environment.recipeDigest !== input.request.recipeHash) throw new Error("Configuration projection has no retained transition");
    const prior = JSON.parse(event.value!);
    const original = { ...prior.resource, metadata: { ...prior.resource.metadata, recipeHash: input.request.recipeHash, compute: prior.compute } };
    const fixed = (value: typeof resource) => {
      const { observed: _observed, observedAt: _at, progress: _progress, ...fields } = z.record(z.string(), z.unknown()).parse(value.metadata);
      return finalizationResourceIdentity({ ...value, metadata: { ...fields, recipeHash: input.request.recipeHash } }).identityDigest;
    };
    if (fixed(resource) !== fixed(original)) throw new Error("Configuration projection changed its physical or configuration identity");
  }
  const traffic = await input.prisma.computeTraffic.findMany({ where: { environmentId: environment.id }, orderBy: { routeId: "asc" }, take: 33 });
  if (traffic.length > 32) throw new Error("Configuration traffic inventory exceeds its bound");
  return { owner, offer, environment, resource, allocations, traffic, event, key, stopped, intent };
}

async function readConfiguration(input: Input, before: Snapshot) {
  const { receipt, adapterPath, checked, before: adapterHash } = await verifiedComputeRuntime({ ...input, sessionId: before.owner.session.id });
  const manifest = await Bun.file(path.join(receipt.checkout, ".remote-agent-capabilities.json")).json();
  if (!manifest.capabilities?.runtime?.observationContracts?.includes("runtime-configuration/v1")) throw new Error("Configured runtime cannot verify saved configuration transitions");
  const request = { request: input.request, task: { id: input.taskId, primarySessionId: before.owner.session.id, worktreePath: before.owner.task.worktreePath },
    environment: { id: before.environment.id, key: before.environment.key, purpose: before.environment.purpose, revision: before.environment.revision },
    resource: { id: before.resource.id, key: before.resource.key, kind: before.resource.kind, purpose: before.resource.purpose, externalId: before.resource.externalId, metadata: before.resource.metadata } };
  const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const proof = Proof.parse(JSON.parse(await executeOwnedObserver([process.execPath, "--no-env-file", adapterPath, "compute", "configuration-observe"], {
    cwd: receipt.checkout, timeoutMs: 30_000, env, input: JSON.stringify(request),
  })));
  if (adapterHash !== await checked()) throw new Error("Configuration observer changed");
  return proof;
}

/** Changes only the projection of an already claimed, physically stopped
 * application. A terminal stopped offer is history, never revived: ordinary
 * admission must allocate afresh. No offer, slot, start permission, pin or provider is created.
 * The journal and both hashes commit together; retries still re-observe ownership. */
export async function configureCompute(input: Input, read = readConfiguration, head = readComputeWorktreeRevision, observe = readConfiguredComputeObservation) {
  if (!input.config.compute?.enabled) throw new Error("Compute admission is disabled");
  input = { ...input, request: ComputeConfiguration.parse(input.request) };
  const before = await snapshot(input);
  if (await head(before.owner.task.worktreePath!) !== before.environment.revision) throw new Error("Configuration source changed");
  const proof = Proof.parse(await read(input, before));
  if (proof.taskId !== input.taskId || proof.primarySessionId !== before.owner.session.id || proof.environmentId !== before.environment.id || proof.resourceId !== before.resource.id
    || proof.offerId !== input.request.offerId || proof.revision !== before.environment.revision || proof.previousRecipeHash !== input.request.previousRecipeHash || proof.recipeHash !== input.request.recipeHash
    || finalizationDigest(proof.compute) !== finalizationDigest(input.request.coverage.next)) throw new Error("Configuration proof changed ownership");
  const again = Proof.parse(await read(input, before));
  if (finalizationDigest(again) !== finalizationDigest(proof)) throw new Error("Configuration evidence changed during observation");
  const metadata = { ...z.record(z.string(), z.json()).parse(before.resource.metadata), recipeHash: input.request.recipeHash, compute: proof.compute };
  const projected = { ...before.resource, metadata };
  const projectedIdentity = finalizationResourceIdentity(projected).identityDigest;
  const candidate = { ...before.environment, recipeDigest: input.request.recipeHash, resourceIdentity: projectedIdentity, observation: null };
  // The ordinary configured observer must accept the staged generation before
  // it can be activated. This supplies real stopped accounting now and leaves
  // a valid immutable manifest for subsequent collector refresh while queued.
  const stopped = await observe(input, before.owner.task, candidate, projected, []);
  const observation = ComputeObservation.parse(stopped.observation);
  if (observation.state !== "stopped"
    || observation.operations.active !== 0 || observation.configurationDigest !== proof.compute.configurationSha256) throw new Error("Staged configuration has no fresh stopped accounting");
  if (stopped.traffic.length !== observation.routes.length || stopped.traffic.some(value => !observation.routes.some(route => finalizationDigest(route) === finalizationDigest(value.route)))) throw new Error("Staged configuration traffic proof changed");
  if (await head(before.owner.task.worktreePath!) !== before.environment.revision) throw new Error("Configuration source changed during observation");
  return input.prisma.$transaction(async tx => {
    // This fresh snapshot also checks current pause, original primary/source
    // link, intent, slot, active offer and prior transition receipt.
    const current = await snapshot({ ...input, prisma: tx });
    const stable = (value: Snapshot) => ({ identity: value.owner.identity, ownerPaused: value.owner.task.ownerPaused, environment: value.environment, resource: value.resource, offer: value.offer, allocations: value.allocations, traffic: value.traffic, event: value.event, intent: value.intent });
    if (finalizationDigest(stable(current)) !== finalizationDigest(stable(before))) throw new Error("Configuration authority changed during observation");
    if (!current.event) {
      const resource = await tx.remoteTaskResource.update({ where: { id: current.resource.id }, data: { metadata } });
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.owner.session.id, source: `compute:${input.taskId}`, action: Action, key: current.key,
        value: JSON.stringify({ version: 1, taskIdentity: current.owner.identity, environment: current.environment, resource: current.resource, offer: current.offer, allocations: current.allocations,
          traffic: current.traffic, proof, compute: proof.compute, stoppedObservation: observation, baselineFile: input.request.baselineFile,
          allocation: current.stopped ? "previously-stopped-await-normal-admission" : "retained-existing-claim" }) } });
      await tx.computeEnvironment.update({ where: { id: current.environment.id }, data: { recipeDigest: input.request.recipeHash, resourceIdentity: finalizationResourceIdentity(resource).identityDigest,
        observation: Prisma.DbNull } });
      await tx.computeTraffic.deleteMany({ where: { environmentId: current.environment.id } });
    } else {
      const prior = JSON.parse(current.event.value!);
      if (prior.proof.baselineSha256 !== proof.baselineSha256 || finalizationDigest(prior.compute) !== finalizationDigest(proof.compute)) throw new Error("Configuration baseline or staged manifest changed after acknowledgment");
      const identity = finalizationResourceIdentity(current.resource).identityDigest;
      if (identity !== current.environment.resourceIdentity) {
        await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.owner.session.id, source: `compute:${input.taskId}`, action: `${Action}-projection`,
          key: finalizationDigest({ transition: current.key, before: current.environment.resourceIdentity, after: identity }),
          value: JSON.stringify({ transition: current.key, before: current.environment, resource: current.resource, proof }) } });
        await tx.computeEnvironment.update({ where: { id: current.environment.id }, data: { resourceIdentity: identity, observation: Prisma.DbNull } });
        await tx.computeTraffic.deleteMany({ where: { environmentId: current.environment.id } });
      }
    }
    await tx.computeTraffic.deleteMany({ where: { environmentId: current.environment.id } });
    await recordComputeObservation({ ...input, prisma: tx, environmentId: current.environment.id, observation });
    for (const state of stopped.traffic) {
      const previous = await tx.computeTraffic.findUnique({ where: { routeId: state.route.id } });
      if (previous) throw new Error("Staged route is already owned by another environment");
      await tx.computeTraffic.create({ data: { routeId: state.route.id, taskId: input.taskId, environmentId: current.environment.id, epoch: state.epoch, sequence: state.sequence, state } });
    }
    return { environmentId: current.environment.id, resourceId: current.resource.id, recipeHash: input.request.recipeHash, compute: proof.compute };
  });
}
