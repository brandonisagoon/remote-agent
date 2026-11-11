import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Prisma, PrismaClient, ToolingRelease, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { cleanupFamily } from "./closed-cleanup.ts";
import { computeFamilySettled } from "./compute-family.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { canonicalDigest, readToolingOperation } from "./tooling-releases.ts";
import type { ToolingOperationBinding } from "../../../../types/tooling-release.ts";
import { verifyPreparedToolingRelease, ToolingReleaseManifestSchema } from "./tooling.ts";

const CONTRACT = "runtime-configuration-refusal/v1", ACTION = "configuration-refusal-repaired";
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Key = z.string().min(1).max(200);
const absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
export const ConfigurationRefusalRepairInput = z.strictObject({ requestKey: Key, operationId: Key, expectedInputDigest: Sha,
  expectedGeneration: z.number().int().positive(), values: z.strictObject({ task: Key, config: absolute, "state-directory": absolute, purpose: z.literal("development") }) });
const Proof = z.strictObject({ contract: z.literal(CONTRACT), operationId: Key, inputDigest: Sha, ownerDigest: Sha,
  environmentId: z.string().uuid(), resourceId: Key, offerId: z.string().uuid(), recipeHash: Sha, receiptSha256: Sha,
  transition: z.enum(["platform-home-readiness", "platform-test-auth-readiness"]), observedAt: z.number().int(), outcome: z.literal("configuration-not-attempted") });
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Pick<AgentSessionRuntime, "observeSessionActivity">; repositoryId: string; taskId: string };
const stableDigest = (value: unknown) => canonicalDigest(JSON.parse(JSON.stringify(value)));

async function snapshot(store: PrismaClient | Prisma.TransactionClient, input: Context, request: z.infer<typeof ConfigurationRefusalRepairInput>) {
  const task = await store.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.ownerPaused || !task.primarySessionId || !task.worktreePath || task.repositoryId !== input.repositoryId || task.machineId !== input.config.machine
    || ["closed", "complete", "review"].includes(task.phase) || request.values.task !== task.id) throw new Error("Configuration refusal repair requires the original open task held paused on its owner host");
  const native = task.connectionId && task.issueIdentifier ? await store.nativeTakeover.findUnique({ where: { connectionId_repositoryId_issueIdentifier: {
    connectionId: task.connectionId, repositoryId: task.repositoryId, issueIdentifier: task.issueIdentifier } } }) : null;
  if (native && (native.mode !== "managed" || native.grantedSessionId !== task.primarySessionId)) throw new Error("Configuration refusal repair cannot race native task ownership");
  const operation = await store.toolingOperation.findUniqueOrThrow({ where: { id: request.operationId } });
  if (operation.taskId !== task.id || operation.sessionId !== task.primarySessionId || operation.repositoryId !== task.repositoryId
    || operation.kind !== "adapter-command" || operation.status !== "bound" || operation.inputDigest !== request.expectedInputDigest
    || operation.parentOperationId || operation.retainedConsumerId || operation.existingOperationId || operation.resourceKey !== "runtime-development") throw new Error("Configuration refusal repair requires the unchanged unattempted command binding");
  const [children, consumers, writes, resources, environment] = await Promise.all([
    store.toolingOperation.count({ where: { parentOperationId: operation.id } }),
    store.toolingRetainedConsumer.count({ where: { operationId: operation.id } }),
    store.toolingStateWrite.findMany({ where: { operationId: operation.id }, orderBy: { sequence: "asc" }, take: 101 }),
    store.remoteTaskResource.findMany({ where: { taskId: task.id }, orderBy: { id: "asc" }, take: 1001 }),
    store.computeEnvironment.findUnique({ where: { taskId_key: { taskId: task.id, key: "runtime-development" } } }),
  ]);
  const resource = resources.find(value => value.id === environment?.resourceId);
  if (children || consumers || !writes.length || writes.length > 100 || resources.length > 1000
    || writes.some(write => write.family !== "drafted.runtime" || write.scopeKey !== "runtime-development" || write.version !== 1)
    || !environment || environment.primarySessionId !== task.primarySessionId || environment.machineId !== task.machineId
    || environment.purpose !== "development" || environment.configuration !== null
    || !resource || resource.key !== "runtime-development" || resource.kind !== "task-runtime" || resource.purpose !== "development" || resource.state === "released")
    throw new Error("Configuration refusal repair cannot replace attempted configuration or unrelated state");
  const latestWrite = await store.toolingStateWrite.findFirst({ where: { taskId: task.id, family: "drafted.runtime", scopeKey: "runtime-development" }, orderBy: { sequence: "desc" } });
  if (latestWrite?.operationId !== operation.id || latestWrite.version !== 1) throw new Error("Another operation changed the retained runtime");
  const offers = await store.computeOffer.findMany({ where: { environmentId: environment.id }, orderBy: { id: "asc" }, take: 101 });
  const allocations = await store.computeSlot.findMany({ where: { allocationId: { in: offers.map(offer => offer.id) } }, orderBy: { id: "asc" }, take: 101 });
  if (offers.length > 100 || allocations.length > 100) throw new Error("Configuration refusal allocation inventory exceeds its bound");
  const family = await cleanupFamily(store, task, task.primarySessionId), sameDirectory = await store.runtimeSession.findMany({ where: { cwd: task.worktreePath }, take: 2001 });
  const sessions = [...new Map([...family, ...sameDirectory].map(value => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const instructions = await store.runtimeInstruction.findMany({ where: { sessionId: { in: sessions.map(value => value.id) }, state: { in: ["queued", "preparing", "dispatching", "steered", "unknown"] } }, take: 1001, orderBy: { id: "asc" } });
  const lifecycle = await Promise.all(sessions.map(value => store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: value.id }, orderBy: { sequence: "desc" } })));
  if (!input.runtime.observeSessionActivity || sessions.length > 2000 || instructions.length > 1000
    || sessions.some(value => value.machineId !== task.machineId || value.repositoryId !== task.repositoryId)
    || !sessions.some(value => value.id === task.primarySessionId && value.role === "primary")
    || !computeFamilySettled(task, sessions, instructions, lifecycle, input.runtime)) throw new Error("Configuration refusal repair requires the whole original task family to be inactive");
  const selection = await store.toolingSelection.findUniqueOrThrow({ where: { repositoryId: task.repositoryId } });
  const release = await store.toolingRelease.findUniqueOrThrow({ where: { id: selection.releaseId } });
  const manifest = ToolingReleaseManifestSchema.parse(release.manifest), format = manifest.stateFormats["drafted.runtime"];
  if (selection.generation !== request.expectedGeneration || release.id === operation.releaseId || release.repositoryId !== task.repositoryId
    || !format?.read.includes(1) || !(format.writeVersions ?? [format.write]).includes(1) || manifest.serverProtocol.min > operation.protocol || manifest.serverProtocol.max < operation.protocol) throw new Error("Configuration refusal repair needs the selected compatible corrected release");
  const owner = { taskId: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId,
    worktreePath: task.worktreePath, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot };
  return { task, operation, selection, release, owner, environment, resource, offers, digest: stableDigest({ task, native, operation: { ...operation, updatedAt: null }, selection, release, writes, latestWrite, resources, environment, offers, allocations, sessions, instructions, lifecycle }) };
}

async function observe(release: ToolingRelease, request: unknown) {
  await verifyPreparedToolingRelease(release);
  const manifest = JSON.parse(await readFile(path.join(release.checkout, ".remote-agent-capabilities.json"), "utf8"));
  const capability = z.object({ adapter: z.literal("src/cli.ts"), observationContracts: z.array(z.string()) }).parse(manifest.capabilities?.runtime);
  if (!capability.observationContracts.includes(CONTRACT)) throw new Error("Corrected release does not declare configuration refusal observation");
  const result = await executeOwnedObserver([process.execPath, "--no-env-file", path.join(release.checkout, capability.adapter), "compute", "configuration-refusal-observe"],
    { cwd: release.checkout, input: JSON.stringify(request), timeoutMs: 30_000 });
  await verifyPreparedToolingRelease(release);
  return Proof.parse(JSON.parse(result));
}
export const configurationRefusalRepairDependencies = { observe };

/** Owner-only recovery of a known local validation refusal. Keep the failed
 * release, state writes and journal; link one corrected successor to the same
 * immutable command input. This grants no provider or configuration effects:
 * those still pass the ordinary runtime lock, admission and observation. */
export async function repairConfigurationRefusal(input: Context & { request: z.infer<typeof ConfigurationRefusalRepairInput> }, dependencies = configurationRefusalRepairDependencies) {
  const request = ConfigurationRefusalRepairInput.parse(input.request), requestDigest = stableDigest({ taskId: input.taskId, repositoryId: input.repositoryId, request });
  const source = `tooling-operation:${input.taskId}`;
  const prior = async (store: PrismaClient | Prisma.TransactionClient) => store.runtimeMetadataEvent.findFirst({ where: { source, action: ACTION, key: request.requestKey }, orderBy: { sequence: "desc" } });
  const replay = async (event: NonNullable<Awaited<ReturnType<typeof prior>>>) => {
    const receipt = z.object({ requestDigest: Sha, originalOperationId: Key, successorOperationId: Key }).passthrough().parse(JSON.parse(event.value!));
    if (receipt.requestDigest !== requestDigest || receipt.originalOperationId !== request.operationId) throw new Error("Configuration refusal repair retry changed");
    const original = await input.prisma.toolingOperation.findUniqueOrThrow({ where: { id: receipt.originalOperationId } });
    if (original.status !== "completed" || stableDigest(original.completionEvidence) !== stableDigest({ kind: "configuration-validation-failed", reference: receipt.successorOperationId })) throw new Error("Configuration refusal repair outcome changed");
    const binding = await readToolingOperation({ prisma: input.prisma, operationId: receipt.successorOperationId });
    if (!binding || binding.taskId !== input.taskId || binding.inputDigest !== request.expectedInputDigest) throw new Error("Configuration refusal repair successor changed");
    return { receipt, binding };
  };
  const saved = await prior(input.prisma); if (saved) return replay(saved);
  const before = await snapshot(input.prisma, input, request);
  const observation = { contract: CONTRACT, owner: before.owner, operationId: before.operation.id, inputDigest: before.operation.inputDigest, values: request.values,
    environment: { id: before.environment.id, key: before.environment.key, revision: before.environment.revision, recipeDigest: before.environment.recipeDigest },
    resource: { id: before.resource.id, externalId: before.resource.externalId, metadata: before.resource.metadata } };
  const proof = Proof.parse(await dependencies.observe(before.release, observation));
  const fresh = () => {
    if (proof.operationId !== before.operation.id || proof.inputDigest !== before.operation.inputDigest || proof.ownerDigest !== canonicalDigest(before.owner)
      || proof.environmentId !== before.environment.id || proof.resourceId !== before.resource.id || proof.recipeHash !== before.environment.recipeDigest
      || !before.offers.some(offer => offer.id === proof.offerId && offer.claimedAt) || proof.observedAt > Date.now() || Date.now() - proof.observedAt > 15_000) throw new Error("Configuration refusal evidence is stale or belongs to another command");
  };
  fresh();
  const { configurationRefusalPredecessors } = await import("./tooling-operations.ts");
  const predecessors = await configurationRefusalPredecessors(input.prisma, before.task, proof.environmentId, proof.offerId);
  const event = await input.prisma.$transaction(async tx => {
    // Take the write lock before checking every original owner/input again.
    const fenced = await tx.toolingOperation.updateMany({ where: { id: before.operation.id, status: "bound", updatedAt: before.operation.updatedAt }, data: { status: "bound" } });
    if (fenced.count !== 1) { const raced = await prior(tx); if (raced) return raced; throw new Error("Configuration refusal changed during repair"); }
    const current = await snapshot(tx, input, request);
    if (current.digest !== before.digest) throw new Error("Configuration refusal repair ownership or selected release changed");
    if (stableDigest(await configurationRefusalPredecessors(tx, current.task, proof.environmentId, proof.offerId)) !== stableDigest(predecessors))
      throw new Error("Configuration refusal predecessor changed");
    fresh();
    const successor = await tx.toolingOperation.create({ data: { id: randomUUID(), taskId: before.task.id, sessionId: before.task.primarySessionId!, repositoryId: before.task.repositoryId,
      requestKey: `configuration-refusal:${canonicalDigest({ operationId: before.operation.id, requestKey: request.requestKey })}`, inputDigest: before.operation.inputDigest,
      kind: "adapter-command", resourceKey: before.operation.resourceKey, turnId: null, releaseId: before.release.id, generation: before.selection.generation, protocol: before.operation.protocol } });
    await tx.toolingOperation.update({ where: { id: before.operation.id }, data: { status: "completed", completionEvidence: { kind: "configuration-validation-failed", reference: successor.id } } });
    return tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.task.primarySessionId!, source, action: ACTION, key: request.requestKey,
      value: JSON.stringify({ version: 1, requestDigest, originalOperationId: before.operation.id, successorOperationId: successor.id, proof, releaseId: before.release.id,
        predecessors, owner: before.owner, generation: before.selection.generation }) } });
  });
  return replay(event);
}

/** The one linked successor may continue only the frozen runtime's known
 * admission and configuration. It cannot adopt another task, offer or unknown
 * producer; ordinary callback authority and physical validation still apply. */
export async function configurationRefusalContinuationAllows(store: PrismaClient | Prisma.TransactionClient, task: RemoteTask, binding: ToolingOperationBinding,
  request: { kind: "admission"; environmentKey: string; owner: string } | { kind: "configuration"; offerId: string; owner: string }) {
  if (task.ownerPaused || ["closed", "complete", "review"].includes(task.phase) || !binding.parentOperationId || binding.taskId !== task.id || binding.sessionId !== task.primarySessionId) return false;
  const parent = await store.toolingOperation.findUnique({ where: { id: binding.parentOperationId } });
  if (!parent || parent.kind !== "adapter-command" || !["bound", "running"].includes(parent.status)
    || parent.releaseId !== binding.release.id || parent.generation !== binding.generation || parent.resourceKey !== "runtime-development") return false;
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId!, source: `tooling-operation:${task.id}`, action: ACTION,
    value: { contains: parent.id } }, take: 2 });
  if (events.length !== 1) return false;
  const receipt = z.object({ originalOperationId: Key, successorOperationId: Key, proof: Proof, releaseId: Key, generation: z.number(), owner: z.unknown(),
    predecessors: z.object({ admission: Key.nullable(), producer: Key.nullable(), owner: Key.nullable() }) }).safeParse(JSON.parse(events[0]!.value ?? "null"));
  if (!receipt.success) return false;
  const r = receipt.data, original = await store.toolingOperation.findUnique({ where: { id: r.originalOperationId } });
  const currentOwner = { taskId: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId,
    worktreePath: task.worktreePath, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot };
  if (r.successorOperationId !== parent.id || r.releaseId !== parent.releaseId || r.generation !== parent.generation
    || stableDigest(r.owner) !== stableDigest(currentOwner) || r.proof.inputDigest !== parent.inputDigest || original?.status !== "completed"
    || stableDigest(original.completionEvidence) !== stableDigest({ kind: "configuration-validation-failed", reference: parent.id })) return false;
  const environment = await store.computeEnvironment.findUnique({ where: { id: r.proof.environmentId } });
  if (!environment || environment.taskId !== task.id || environment.primarySessionId !== task.primarySessionId || environment.resourceId !== r.proof.resourceId
    || environment.key !== "runtime-development") return false;
  const { producerOperationId } = await import("./tooling-operations.ts");
  if (request.kind === "admission") return binding.kind === "compute-admission" && request.environmentKey === environment.key
    && request.owner === r.predecessors.admission && environment.recipeDigest === r.proof.recipeHash
    && await producerOperationId(store, task, environment.id) === r.predecessors.producer;
  if (!["compute-configure", "compute-admission"].includes(binding.kind) || request.offerId !== r.proof.offerId || binding.existingOperationId !== request.offerId || request.owner !== r.predecessors.owner) return false;
  let producer: string | null;
  try { producer = await producerOperationId(store, task, environment.id); }
  catch {
    // Only this exact configure child may retry its own pending producer.
    // Any other unknown producer remains a hard refusal.
    const latest = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId!, source: `tooling-operation:${task.id}`,
      action: "tooling-operation-association", key: `producer:compute-environment:${environment.id}` }, orderBy: { sequence: "desc" } });
    const pending = z.object({ operationId: Key, state: z.literal("intent") }).safeParse(JSON.parse(latest?.value ?? "null"));
    return pending.success && pending.data.operationId === binding.operationId;
  }
  if (producer === r.predecessors.producer) return true;
  const current = producer ? await store.toolingOperation.findUnique({ where: { id: producer } }) : null;
  return current?.parentOperationId === parent.id && current.releaseId === parent.releaseId && current.generation === parent.generation;
}
