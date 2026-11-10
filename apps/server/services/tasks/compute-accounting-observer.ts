import { z } from "zod";
import type { Prisma, PrismaClient, RemoteTask, ToolingRelease } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { finalizationDigest } from "./finalization-resources.ts";
import { verifyPreparedToolingRelease } from "./tooling.ts";
import { originalAccountingCode, readInstalledComputeBaseline, readInstalledComputeReclamation, verifyInstalledComputeAccountingCode } from "./compute-observer.ts";
import { ComputeBaselineObservation, computeBaselineRequest, readComputeBaselineSnapshot } from "./compute-baseline.ts";
import { ComputeReclamation } from "./compute-reclamation-schema.ts";
import { computeReclamationRequest, readComputeReclamationSnapshot } from "./compute-reclamation.ts";
import type { ToolingCodeIdentity } from "./tooling-operations.ts";

const Sha = z.string().regex(/^[a-f0-9]{64}$/), Key = z.string().min(1).max(256);
export const ComputeAccountingTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baseline"), purpose: z.enum(["development", "review"]) }).strict(),
  z.object({ kind: z.literal("environment"), environmentId: z.string().uuid() }).strict(),
]);
export const ComputeAccountingObserverInput = z.object({ target: ComputeAccountingTarget, requestKey: Key,
  expectedBindingDigest: Sha, expectedRevision: z.number().int().nonnegative(), releaseId: Key }).strict();
type Target = z.infer<typeof ComputeAccountingTarget>;
type Mode = "baseline-observe" | "reclaim-observe";
type Runtime = Pick<AgentSessionRuntime, "observeSessionActivity">;
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Runtime; taskId: string };
const action = "compute-accounting-observer-adopted";
const scope = (target: Target) => target.kind === "baseline" ? `baseline:${target.purpose}` : `environment:${target.environmentId}`;
const Receipt = z.object({ version: z.literal(1), requestKey: Key, target: ComputeAccountingTarget, bindingDigest: Sha,
  releaseId: Key, releaseDigest: Sha, adapterDigest: Sha, proofDigest: Sha }).strict();
const releaseDigest = (release: ToolingRelease) => finalizationDigest({ id: release.id, repositoryId: release.repositoryId, revision: release.revision,
  tree: release.tree, policyBlob: release.policyBlob, checkout: release.checkout, lockfileDigest: release.lockfileDigest, manifest: release.manifest });

// Observed annotations are not new physical identity. All other retained
// metadata, configuration hashes and complete membership remain binding.
function stableRequest(request: unknown) {
  const value = structuredClone(request) as Record<string, any>;
  for (const resource of value.resources ?? [value.resource]) {
    delete resource.state; // Released is a projection, never physical absence.
    if (resource?.metadata && typeof resource.metadata === "object") {
      delete resource.metadata.observed; delete resource.metadata.observedAt;
    }
  }
  return value;
}

async function selection(store: Prisma.TransactionClient, config: ServerConfig, taskId: string, target: Target, runtime: Runtime) {
  let task: RemoteTask, request: unknown, digest: string, ownership: unknown, settled: boolean, mode: Mode;
  if (target.kind === "baseline") {
    const row = await store.computeBaseline.findFirstOrThrow({ where: { taskId, machineId: config.machine, purpose: target.purpose } });
    const snapshot = await readComputeBaselineSnapshot(store, row, runtime);
    ({ task, digest, ownership, settled } = snapshot); request = computeBaselineRequest(snapshot, row.purpose); mode = "baseline-observe";
  } else {
    const snapshot = await readComputeReclamationSnapshot(store, { prisma: store as PrismaClient, config, environmentId: target.environmentId, runtime });
    ({ task, digest, ownership, settled } = snapshot); request = computeReclamationRequest(snapshot); mode = "reclaim-observe";
  }
  if (task.id !== taskId || task.machineId !== config.machine || !task.primarySessionId) throw new Error("Historical accounting original ownership changed");
  const resources = (request as { resources?: Array<{ id: string; externalId: string }>; resource?: { id: string; externalId: string } }).resources
    ?? [(request as { resource: { id: string; externalId: string } }).resource];
  if (await store.remoteTaskResource.count({ where: { taskId: { not: task.id }, task: { machineId: config.machine }, state: { not: "released" },
    externalId: { in: resources.map(resource => resource.externalId) } } })) throw new Error("Historical accounting resource is also claimed by another task");
  return { task, request, mode, snapshotDigest: digest, settled, bindingDigest: finalizationDigest({ target, ownership, request: stableRequest(request) }) };
}

async function latest(store: Prisma.TransactionClient, taskId: string, target: Target) {
  return store.runtimeMetadataEvent.findFirst({ where: { source: `compute:${taskId}`, action, key: scope(target) }, orderBy: { sequence: "desc" } });
}

export const accountingObserverDependencies = {
  original: originalAccountingCode,
  verify: verifyInstalledComputeAccountingCode,
  verifyRelease: verifyPreparedToolingRelease,
  observe: async (input: Context, task: RemoteTask, request: unknown, mode: Mode, code: ToolingCodeIdentity) => mode === "baseline-observe"
    ? readInstalledComputeBaseline(input, task, request, undefined, { code }) : readInstalledComputeReclamation(input, task, request, undefined, { code }),
};
type Dependencies = typeof accountingObserverDependencies;

async function originalAvailable(input: Context, selected: Awaited<ReturnType<typeof selection>>, dependencies: Dependencies) {
  try {
    const original = await dependencies.original(input, selected.task, selected.request, selected.mode);
    await dependencies.verify(input, selected.task, selected.mode, original.code);
    return true;
  } catch { return false; } // Only executable selection/verification; never physical provider output.
}

/** Owner status exposes IDs and digests, never retained configuration bytes. */
export async function inspectComputeAccountingObserver(input: Context & { target: Target }, dependencies = accountingObserverDependencies) {
  const target = ComputeAccountingTarget.parse(input.target), selected = await selection(input.prisma, input.config, input.taskId, target, input.runtime);
  const prior = await latest(input.prisma, input.taskId, target);
  return { target, bindingDigest: selected.bindingDigest, revision: prior?.sequence ?? 0, settled: selected.settled,
    originalAvailable: await originalAvailable(input, selected, dependencies), ...(prior ? { adoption: Receipt.parse(JSON.parse(prior.value!)) } : {}) };
}

function validateObservation(selected: Awaited<ReturnType<typeof selection>>, raw: unknown, config: ServerConfig) {
  const request = selected.request as any, now = Date.now(), freshness = config.compute!.collectorFreshnessSeconds * 1000;
  const fresh = (at: number) => at <= now && now - at <= freshness;
  if (selected.mode === "baseline-observe") {
    const observed = ComputeBaselineObservation.parse(raw);
    if (observed.machineId !== config.machine || observed.taskId !== selected.task.id || observed.primarySessionId !== selected.task.primarySessionId
      || observed.purpose !== request.purpose || observed.resourceSetDigest !== request.resourceSetDigest || !fresh(observed.observedAt)
      || observed.resources.length !== request.resources.length || new Set(observed.resources.map(resource => resource.resourceId)).size !== request.resources.length
      || observed.resources.some(resource => !["stopped", "absent"].includes(resource.state) || !request.resources.some((identity: any) => identity.id === resource.resourceId && identity.identityDigest === resource.resourceIdentity))) {
      throw new Error("Historical accounting requires fresh absence of every original member");
    }
  } else {
    const observed = ComputeReclamation.parse(raw);
    if (observed.environmentId !== request.environment.id || observed.taskId !== selected.task.id || observed.primarySessionId !== selected.task.primarySessionId
      || observed.resourceId !== request.resource.id || observed.resourceIdentity !== request.resource.identityDigest || observed.allocationResourceIdentity !== request.allocationResourceIdentity
      || observed.configurationDigest !== request.configurationDigest || !fresh(observed.observedAt) || !["stopped", "absent"].includes(observed.state)) {
      throw new Error("Historical accounting requires fresh absence of the original allocation");
    }
  }
}

/** This appends a truthful reader choice only. It does not rewrite producer
 * provenance, task pins, observations, resource states or allocations. The
 * normal collector must independently read again to grant any capacity. */
export async function adoptComputeAccountingObserver(input: Context & { request: z.infer<typeof ComputeAccountingObserverInput> }, dependencies = accountingObserverDependencies) {
  const request = ComputeAccountingObserverInput.parse(input.request), target = request.target;
  if (!input.config.compute?.enabled) throw new Error("Compute accounting is disabled");
  const before = await selection(input.prisma, input.config, input.taskId, target, input.runtime);
  if (!before.settled || !before.task.ownerPaused && before.task.phase !== "closed" || before.bindingDigest !== request.expectedBindingDigest) throw new Error("Historical accounting needs the unchanged, settled original task under pause or closure");
  const prior = await latest(input.prisma, input.taskId, target);
  const saved = prior && Receipt.parse(JSON.parse(prior.value!));
  if (saved?.requestKey === request.requestKey) {
    if (saved.bindingDigest !== before.bindingDigest || saved.releaseId !== request.releaseId || prior!.runtimeSessionId !== before.task.primarySessionId) throw new Error("Historical observer retry changed");
    return { revision: prior!.sequence, adoption: saved };
  }
  if ((prior?.sequence ?? 0) !== request.expectedRevision) throw new Error("Historical observer adoption generation changed");
  if (await originalAvailable(input, before, dependencies)) throw new Error("Original accounting observer is available; use the ordinary collector");
  const release = await input.prisma.toolingRelease.findUniqueOrThrow({ where: { id: request.releaseId } });
  if (release.repositoryId !== before.task.repositoryId) throw new Error("Historical observer belongs to another repository");
  await dependencies.verifyRelease(release);
  const verified = await dependencies.verify(input, before.task, before.mode, release, undefined, true);
  const proof = await dependencies.observe(input, before.task, before.request, before.mode, release);
  validateObservation(before, proof, input.config);
  await dependencies.verifyRelease(release);
  if (verified.before !== await verified.checked()) throw new Error("Historical observer changed during its physical read");
  const receipt = Receipt.parse({ version: 1, requestKey: request.requestKey, target, bindingDigest: before.bindingDigest,
    releaseId: release.id, releaseDigest: releaseDigest(release), adapterDigest: verified.before, proofDigest: finalizationDigest(proof) });
  return input.prisma.$transaction(async tx => {
    const current = await selection(tx, input.config, input.taskId, target, input.runtime), currentPrior = await latest(tx, input.taskId, target);
    if (!current.settled || current.snapshotDigest !== before.snapshotDigest || current.bindingDigest !== before.bindingDigest
      || (currentPrior?.sequence ?? 0) !== request.expectedRevision || releaseDigest(await tx.toolingRelease.findUniqueOrThrow({ where: { id: release.id } })) !== receipt.releaseDigest) throw new Error("Historical observer input changed during registration");
    validateObservation(current, proof, input.config);
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.task.primarySessionId!, source: `compute:${before.task.id}`, action, key: scope(target), value: JSON.stringify(receipt) } });
    return { revision: event.sequence, adoption: receipt };
  });
}

/** This choice is used only by read-only accounting, never by an operation
 * producer, start, runtime recovery, finalizer or task tooling resolver. */
export async function adoptedAccountingCode(prisma: PrismaClient, config: ServerConfig, task: RemoteTask, request: unknown, mode: Mode) {
  const target: Target = mode === "baseline-observe"
    ? { kind: "baseline", purpose: z.object({ purpose: z.enum(["development", "review"]) }).parse(request).purpose }
    : { kind: "environment", environmentId: z.object({ environment: z.object({ id: z.string().uuid() }) }).parse(request).environment.id };
  const prior = await latest(prisma, task.id, target);
  if (!prior) return null;
  const receipt = Receipt.parse(JSON.parse(prior.value!)), current = await selection(prisma, config, task.id, target, {});
  if (prior.runtimeSessionId !== task.primarySessionId || receipt.bindingDigest !== current.bindingDigest
    || finalizationDigest(stableRequest(request)) !== finalizationDigest(stableRequest(current.request))
    || !current.task.ownerPaused && current.task.phase !== "closed") throw new Error("Adopted historical observer ownership or input changed");
  const release = await prisma.toolingRelease.findUniqueOrThrow({ where: { id: receipt.releaseId } });
  if (release.repositoryId !== task.repositoryId || releaseDigest(release) !== receipt.releaseDigest) throw new Error("Adopted historical observer release changed");
  await verifyPreparedToolingRelease(release);
  const verified = await verifyInstalledComputeAccountingCode({ config }, current.task, mode, release, undefined, true);
  if (verified.before !== receipt.adapterDigest) throw new Error("Adopted historical observer bytes changed");
  return { code: { repositoryId: release.repositoryId, revision: release.revision, checkout: release.checkout }, binding: null };
}
