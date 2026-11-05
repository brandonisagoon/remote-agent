import path from "node:path";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { assertComputeEnvironmentOwner, computeTaskOwner } from "./compute-admission.ts";
import { assertComputeStartIntent } from "./development-intent.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { verifiedComputeRuntime } from "./compute-observer.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { readComputeWorktreeRevision } from "./compute-worktree-revision.ts";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ComputeConfiguration = z.object({ offerId: z.string().uuid(), resourceKey: z.string().min(1).max(180), previousRecipeHash: Sha, recipeHash: Sha,
  baselineFile: z.string().max(4096).refine(p => path.isAbsolute(p) && path.normalize(p) === p), lockPid: z.number().int().positive(), }).strict();
const Proof = z.object({ version: z.literal(1), taskId: z.string(), primarySessionId: z.string(), environmentId: z.string().uuid(), resourceId: z.string(), offerId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{40}$/), previousRecipeHash: Sha, recipeHash: Sha, receiptSha256: Sha, baselineSha256: Sha, lockSha256: Sha, stopped: z.literal(true) }).strict();
type Input = { prisma: PrismaClient; config: ServerConfig; taskId: string; request: z.infer<typeof ComputeConfiguration> };
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const Action = "compute-runtime-configuration";
async function snapshot(input: Omit<Input, "prisma"> & { prisma: Prisma.TransactionClient }) {
  const owner = await computeTaskOwner(input.prisma, input.taskId, input.config.machine);
  const offer = await input.prisma.computeOffer.findUniqueOrThrow({ where: { id: input.request.offerId } });
  const environment = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
  await assertComputeEnvironmentOwner(input.prisma, environment);
  await assertComputeStartIntent(input.prisma, input.taskId, environment.id, offer.id);
  const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: input.taskId, key: input.request.resourceKey } } });
  const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata);
  const offers = await input.prisma.computeOffer.findMany({ where: { environmentId: environment.id }, orderBy: { id: "asc" }, take: 1001 });
  const slots = await input.prisma.computeSlot.findMany({ where: { allocationId: { in: offers.map(value => value.id) } }, orderBy: { id: "asc" }, take: 1001 });
  if (offers.length > 1000 || slots.length > 1000) throw new Error("Configuration allocation history exceeds its bound");
  const allocations = { offers, slots };
  const active = allocations.offers.filter(o => ["queued", "offered", "claimed", "running", "unknown"].includes(o.state));
  if (environment.taskId !== input.taskId || environment.primarySessionId !== owner.session.id || environment.taskIdentity !== owner.identity || environment.machineId !== input.config.machine
    || environment.purpose !== "development" || environment.configuration !== null || environment.key !== input.request.resourceKey
    || resource.kind !== "task-runtime" || resource.purpose !== environment.purpose || resource.state === "released" || environment.resourceId !== resource.id
    || environment.resourceIdentity !== finalizationResourceIdentity(resource).identityDigest
    || metadata.revision !== environment.revision || ![input.request.previousRecipeHash, input.request.recipeHash].includes(String(metadata.recipeHash))
    || ![input.request.previousRecipeHash, input.request.recipeHash].includes(environment.recipeDigest) || input.request.previousRecipeHash === input.request.recipeHash
    || offer.machineId !== input.config.machine || !offer.claimedAt || offer.completedAt || !["claimed", "running", "unknown"].includes(offer.state)
    || active.length !== 1 || active[0]!.id !== offer.id || allocations.slots.length !== 1 || allocations.slots[0]!.allocationId !== offer.id || allocations.slots[0]!.machineId !== input.config.machine) throw new Error("Configuration requires its exact existing claimed runtime allocation");
  const key = finalizationDigest({ environmentId: environment.id, offerId: offer.id, resourceId: resource.id, previousRecipeHash: input.request.previousRecipeHash, recipeHash: input.request.recipeHash });
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owner.session.id, source: `compute:${input.taskId}`, action: Action, key } });
  if (environment.recipeDigest === input.request.recipeHash && (!event || metadata.recipeHash !== input.request.recipeHash)) throw new Error("Configuration transition has no durable acknowledgment");
  const traffic = await input.prisma.computeTraffic.findMany({ where: { environmentId: environment.id }, orderBy: { routeId: "asc" }, take: 33 });
  if (traffic.length > 32) throw new Error("Configuration traffic inventory exceeds its bound");
  return { owner, offer, environment, resource, allocations, traffic, event, key };
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
 * application. No offer, slot, start permission, task pin or provider is created.
 * The journal and both hashes commit together; retries still re-observe ownership. */
export async function configureCompute(input: Input, read = readConfiguration, head = readComputeWorktreeRevision) {
  if (!input.config.compute?.enabled) throw new Error("Compute admission is disabled");
  input = { ...input, request: ComputeConfiguration.parse(input.request) };
  const before = await snapshot(input);
  if (await head(before.owner.task.worktreePath!) !== before.environment.revision) throw new Error("Configuration source changed");
  const proof = Proof.parse(await read(input, before));
  if (proof.taskId !== input.taskId || proof.primarySessionId !== before.owner.session.id || proof.environmentId !== before.environment.id || proof.resourceId !== before.resource.id
    || proof.offerId !== input.request.offerId || proof.revision !== before.environment.revision || proof.previousRecipeHash !== input.request.previousRecipeHash || proof.recipeHash !== input.request.recipeHash) throw new Error("Configuration proof changed ownership");
  const again = Proof.parse(await read(input, before));
  if (finalizationDigest(again) !== finalizationDigest(proof) || await head(before.owner.task.worktreePath!) !== before.environment.revision) throw new Error("Configuration evidence changed during observation");
  return input.prisma.$transaction(async tx => {
    // This fresh snapshot also checks current pause, original primary/source
    // link, intent, slot, active offer and prior transition receipt.
    const current = await snapshot({ ...input, prisma: tx });
    const stable = (value: Snapshot) => ({ identity: value.owner.identity, ownerPaused: value.owner.task.ownerPaused, environment: value.environment, resource: value.resource, offer: value.offer, allocations: value.allocations, traffic: value.traffic, event: value.event });
    if (finalizationDigest(stable(current)) !== finalizationDigest(stable(before))) throw new Error("Configuration authority changed during observation");
    if (!current.event) {
      const metadata = { ...z.record(z.string(), z.unknown()).parse(current.resource.metadata), recipeHash: input.request.recipeHash };
      const resource = await tx.remoteTaskResource.update({ where: { id: current.resource.id }, data: { metadata } });
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.owner.session.id, source: `compute:${input.taskId}`, action: Action, key: current.key,
        value: JSON.stringify({ version: 1, taskIdentity: current.owner.identity, environment: current.environment, resource: current.resource, offer: current.offer, allocations: current.allocations,
          traffic: current.traffic, proof, baselineFile: input.request.baselineFile }) } });
      await tx.computeEnvironment.update({ where: { id: current.environment.id }, data: { recipeDigest: input.request.recipeHash, resourceIdentity: finalizationResourceIdentity(resource).identityDigest,
        observation: Prisma.DbNull } });
      await tx.computeTraffic.deleteMany({ where: { environmentId: current.environment.id } });
    } else {
      const prior = JSON.parse(current.event.value!);
      if (prior.proof.baselineSha256 !== proof.baselineSha256) throw new Error("Configuration baseline changed after acknowledgment");
    }
    return { environmentId: current.environment.id, resourceId: current.resource.id, recipeHash: input.request.recipeHash };
  });
}
