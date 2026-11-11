import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Prisma, PrismaClient, ToolingRelease } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { cleanupFamily } from "./closed-cleanup.ts";
import { computeFamilySettled } from "./compute-family.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { canonicalDigest, readToolingOperation } from "./tooling-releases.ts";
import { verifyPreparedToolingRelease, ToolingReleaseManifestSchema } from "./tooling.ts";

const CONTRACT = "test-identity-preparation/v1", ACTION = "identity-preparation-repaired";
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Key = z.string().min(1).max(200);
const absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
export const IdentityPreparationRepairInput = z.strictObject({ requestKey: Key, operationId: Key, expectedInputDigest: Sha,
  expectedGeneration: z.number().int().positive(), values: z.strictObject({ task: Key, config: absolute, "state-directory": absolute, "request-key": Key, purpose: z.enum(["development", "review"]).default("development") }) });
const Proof = z.strictObject({ contract: z.literal(CONTRACT), operationId: Key, inputDigest: Sha, ownerDigest: Sha, allocationId: Sha,
  journal: z.strictObject({ file: absolute, digest: Sha, count: z.number().int().min(1).max(4) }), observedAt: z.number().int(), outcome: z.literal("no-account-attempt") });
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: Pick<AgentSessionRuntime, "observeSessionActivity">; repositoryId: string; taskId: string };
const stableDigest = (value: unknown) => canonicalDigest(JSON.parse(JSON.stringify(value)));

async function snapshot(store: PrismaClient | Prisma.TransactionClient, input: Context, request: z.infer<typeof IdentityPreparationRepairInput>) {
  const task = await store.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.ownerPaused || !task.primarySessionId || !task.worktreePath || task.repositoryId !== input.repositoryId || task.machineId !== input.config.machine
    || ["closed", "complete", "review"].includes(task.phase) || request.values.task !== task.id) throw new Error("Identity repair requires the original open task held paused on its owner host");
  const native = task.connectionId && task.issueIdentifier ? await store.nativeTakeover.findUnique({ where: { connectionId_repositoryId_issueIdentifier: {
    connectionId: task.connectionId, repositoryId: task.repositoryId, issueIdentifier: task.issueIdentifier } } }) : null;
  if (native && (native.mode !== "managed" || native.grantedSessionId !== task.primarySessionId)) throw new Error("Identity repair cannot race native task ownership");
  const operation = await store.toolingOperation.findUniqueOrThrow({ where: { id: request.operationId } });
  if (operation.taskId !== task.id || operation.sessionId !== task.primarySessionId || operation.repositoryId !== task.repositoryId
    || operation.kind !== "adapter-command" || operation.status !== "bound" || operation.inputDigest !== request.expectedInputDigest
    || operation.parentOperationId || operation.retainedConsumerId || operation.existingOperationId || operation.resourceKey) throw new Error("Identity repair requires the unchanged unattempted command binding");
  const [children, consumers, writes, resources, environments] = await Promise.all([
    store.toolingOperation.count({ where: { parentOperationId: operation.id } }),
    store.toolingRetainedConsumer.count({ where: { operationId: operation.id } }),
    store.toolingStateWrite.findMany({ where: { operationId: operation.id }, orderBy: { sequence: "asc" }, take: 101 }),
    store.remoteTaskResource.findMany({ where: { taskId: task.id }, orderBy: { id: "asc" }, take: 1001 }),
    store.computeEnvironment.count({ where: { taskId: task.id } }),
  ]);
  if (children || consumers || environments || !writes.length || writes.length > 100 || resources.length > 1000
    || writes.some(write => write.family !== "drafted.test-identities" || write.scopeKey !== "test-identities" || write.version !== 1)
    || resources.some(resource => resource.kind === "clerk-test-user")) throw new Error("Identity repair cannot replace attempted account/provider work or unrelated state");
  const latestWrite = await store.toolingStateWrite.findFirst({ where: { taskId: task.id, family: "drafted.test-identities", scopeKey: "test-identities" }, orderBy: { sequence: "desc" } });
  if (latestWrite?.operationId !== operation.id || latestWrite.version !== 1) throw new Error("Another operation changed the retained identity assignment");
  const family = await cleanupFamily(store, task, task.primarySessionId), sameDirectory = await store.runtimeSession.findMany({ where: { cwd: task.worktreePath }, take: 2001 });
  const sessions = [...new Map([...family, ...sameDirectory].map(value => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const instructions = await store.runtimeInstruction.findMany({ where: { sessionId: { in: sessions.map(value => value.id) }, state: { in: ["queued", "preparing", "dispatching", "steered", "unknown"] } }, take: 1001, orderBy: { id: "asc" } });
  const lifecycle = await Promise.all(sessions.map(value => store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: value.id }, orderBy: { sequence: "desc" } })));
  if (!input.runtime.observeSessionActivity || sessions.length > 2000 || instructions.length > 1000
    || sessions.some(value => value.machineId !== task.machineId || value.repositoryId !== task.repositoryId)
    || !sessions.some(value => value.id === task.primarySessionId && value.role === "primary")
    || !computeFamilySettled(task, sessions, instructions, lifecycle, input.runtime)) throw new Error("Identity repair requires the whole original task family to be inactive");
  const selection = await store.toolingSelection.findUniqueOrThrow({ where: { repositoryId: task.repositoryId } });
  const release = await store.toolingRelease.findUniqueOrThrow({ where: { id: selection.releaseId } });
  const manifest = ToolingReleaseManifestSchema.parse(release.manifest), format = manifest.stateFormats["drafted.test-identities"];
  if (selection.generation !== request.expectedGeneration || release.id === operation.releaseId || release.repositoryId !== task.repositoryId
    || !format?.read.includes(1) || format.write !== 1 || manifest.serverProtocol.min > operation.protocol || manifest.serverProtocol.max < operation.protocol) throw new Error("Identity repair needs the selected compatible corrected release");
  const owner = { taskId: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId,
    worktreePath: task.worktreePath, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot };
  return { task, operation, selection, release, owner, digest: stableDigest({ task, native, operation: { ...operation, updatedAt: null }, selection, release, writes, latestWrite, resources, sessions, instructions, lifecycle }) };
}

async function observe(release: ToolingRelease, request: unknown) {
  await verifyPreparedToolingRelease(release);
  const manifest = JSON.parse(await readFile(path.join(release.checkout, ".remote-agent-capabilities.json"), "utf8"));
  const capability = z.object({ adapter: z.literal("src/cli.ts"), observationContracts: z.array(z.string()) }).parse(manifest.capabilities?.prepare);
  if (!capability.observationContracts.includes(CONTRACT)) throw new Error("Corrected release does not declare identity preparation observation");
  const result = await executeOwnedObserver([process.execPath, "--no-env-file", path.join(release.checkout, capability.adapter), "identity", "preparation-observe"],
    { cwd: release.checkout, input: JSON.stringify(request), timeoutMs: 15_000 });
  await verifyPreparedToolingRelease(release);
  return Proof.parse(JSON.parse(result));
}
export const identityPreparationRepairDependencies = { observe };

/** Owner-only, narrowly verified failure boundary. Preserve the original
 * release, writes, reservation and task pin; record failure (never success)
 * and bind one linked successor to the selected compatible release. This is
 * not a generic retry escape hatch and refuses any attempted account effect. */
export async function repairIdentityPreparation(input: Context & { request: z.infer<typeof IdentityPreparationRepairInput> }, dependencies = identityPreparationRepairDependencies) {
  const request = IdentityPreparationRepairInput.parse(input.request), requestDigest = stableDigest({ taskId: input.taskId, repositoryId: input.repositoryId, request });
  const source = `tooling-operation:${input.taskId}`;
  const prior = async (store: PrismaClient | Prisma.TransactionClient) => store.runtimeMetadataEvent.findFirst({ where: { source, action: ACTION, key: request.requestKey }, orderBy: { sequence: "desc" } });
  const replay = async (event: NonNullable<Awaited<ReturnType<typeof prior>>>) => {
    const receipt = z.object({ requestDigest: Sha, originalOperationId: Key, successorOperationId: Key }).passthrough().parse(JSON.parse(event.value!));
    if (receipt.requestDigest !== requestDigest || receipt.originalOperationId !== request.operationId) throw new Error("Identity repair retry changed");
    const original = await input.prisma.toolingOperation.findUniqueOrThrow({ where: { id: receipt.originalOperationId } });
    if (original.status !== "completed" || stableDigest(original.completionEvidence) !== stableDigest({ kind: "identity-preparation-failed", reference: receipt.successorOperationId })) throw new Error("Identity repair outcome changed");
    const binding = await readToolingOperation({ prisma: input.prisma, operationId: receipt.successorOperationId });
    if (!binding || binding.taskId !== input.taskId || binding.inputDigest !== request.expectedInputDigest) throw new Error("Identity repair successor changed");
    return { receipt, binding };
  };
  const saved = await prior(input.prisma); if (saved) return replay(saved);
  const before = await snapshot(input.prisma, input, request);
  const observation = { contract: CONTRACT, owner: before.owner, operationId: before.operation.id, inputDigest: before.operation.inputDigest, values: request.values };
  const proof = Proof.parse(await dependencies.observe(before.release, observation));
  const fresh = () => {
    if (proof.operationId !== before.operation.id || proof.inputDigest !== before.operation.inputDigest || proof.ownerDigest !== canonicalDigest(before.owner)
      || proof.observedAt > Date.now() || Date.now() - proof.observedAt > 15_000) throw new Error("Identity preparation evidence is stale or belongs to another command");
  };
  fresh();
  const event = await input.prisma.$transaction(async tx => {
    // Take the write lock before checking every original owner/input again.
    const fenced = await tx.toolingOperation.updateMany({ where: { id: before.operation.id, status: "bound", updatedAt: before.operation.updatedAt }, data: { status: "bound" } });
    if (fenced.count !== 1) { const raced = await prior(tx); if (raced) return raced; throw new Error("Identity preparation changed during repair"); }
    const current = await snapshot(tx, input, request);
    if (current.digest !== before.digest) throw new Error("Identity repair ownership or selected release changed");
    fresh();
    const successor = await tx.toolingOperation.create({ data: { id: randomUUID(), taskId: before.task.id, sessionId: before.task.primarySessionId!, repositoryId: before.task.repositoryId,
      requestKey: `identity-repair:${canonicalDigest({ operationId: before.operation.id, requestKey: request.requestKey })}`, inputDigest: before.operation.inputDigest,
      kind: "adapter-command", turnId: null, releaseId: before.release.id, generation: before.selection.generation, protocol: before.operation.protocol } });
    await tx.toolingOperation.update({ where: { id: before.operation.id }, data: { status: "completed", completionEvidence: { kind: "identity-preparation-failed", reference: successor.id } } });
    return tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.task.primarySessionId!, source, action: ACTION, key: request.requestKey,
      value: JSON.stringify({ version: 1, requestDigest, originalOperationId: before.operation.id, successorOperationId: successor.id, proof, releaseId: before.release.id }) } });
  });
  return replay(event);
}
