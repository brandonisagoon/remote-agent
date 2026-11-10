import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient, RemoteTask, RemoteTaskResource, ComputeEnvironment, ComputeTraffic } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import type { CompatibilityReceipt } from "./tooling-compatibility.ts";
import { resolveSessionToolingCapability } from "./tooling-capabilities.ts";
import { ComputeObservation, recordComputeObservation } from "./compute-observation.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { TrafficStateSchema } from "../../../../lib/compute-telemetry.ts";
import type { ToolingOperationBinding } from "../../../../types/tooling-release.ts";
import { currentToolingOperation, resourceGroupCode, toolingOperationDependencies, toolingProcessContext, type ToolingCodeIdentity } from "./tooling-operations.ts";
const Output = z.object({ observation: ComputeObservation, traffic: z.array(TrafficStateSchema).max(32) }).strict();

const processEnvironment = () => Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
/** Binding metadata for an old strict envelope travels only in process
 * context, never as a new stdin field: operation, socket, task and session. */
export const operationEnvironment = (binding: Pick<ToolingOperationBinding, "operationId" | "taskId" | "sessionId"> | null | undefined, socket?: string) =>
  ({ ...processEnvironment(), ...toolingProcessContext(binding, socket) });

/** Code observing a resource group: its confirmed producer's release, else
 * its retained first-bootstrap snapshot. Only a never-started group uses the
 * guarded callback's own (admitting) binding. An unclaimed saved resource
 * also has its exact acknowledged request binding for independent collection.
 * Neither is a producer or start grant. Before any activation boundary
 * the pre-protocol configured revision applies (null). Unknown or missing
 * provenance throws: an observer tick never borrows the active release. */
export async function environmentCode(prisma: PrismaClient, task: RemoteTask, environment: Pick<ComputeEnvironment, "id">) {
  const scoped = currentToolingOperation();
  return resourceGroupCode({ prisma, task, reference: { type: "compute-environment", id: environment.id }, ...(scoped ? { unstarted: scoped } : {}) });
}

export async function verifiedComputeRuntime(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; development?: { intentRevision: number; intentDigest: string }; release?: ToolingCodeIdentity | null; install?: boolean }, dependencies = { resolve: resolveSessionToolingCapability, execute: executeOwnedObserver }) {
  const { receipt } = await dependencies.resolve({ prisma: input.prisma, config: input.config, sessionId: input.sessionId, capability: "runtime", ...(input.development ? { development: input.development } : {}),
    ...(input.release !== undefined ? { release: input.release } : {}), ...(input.install === false ? { install: false } : {}) });
  return verifyComputeRuntimeReceipt(receipt, dependencies.execute);
}

async function verifyComputeRuntimeReceipt(receipt: CompatibilityReceipt, execute = executeOwnedObserver) {
  const adapterPath = receipt.adapter;
  if (!adapterPath) throw new Error("Configured runtime has no compute observer adapter");
  const checked = async () => {
    const root = await realpath(receipt.checkout), adapter = await realpath(adapterPath), stat = await lstat(adapter);
    if (root !== receipt.checkout || adapter !== adapterPath || !adapter.startsWith(`${root}${path.sep}`) || !stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o022 || stat.size > 1024 * 1024) throw new Error("Compute observer capability identity changed");
    const git = (...args: string[]) => execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: root, timeoutMs: 10_000 });
    if ((await git("rev-parse", "HEAD")).trim() !== receipt.capabilityRevision || (await git("status", "--porcelain=v1", "--untracked-files=normal")).trim()) throw new Error("Compute observer checkout changed");
    const manifest = JSON.parse(await git("show", `${receipt.capabilityRevision}:.remote-agent-capabilities.json`));
    if (manifest.capabilities?.runtime?.adapter !== path.relative(root, adapter) || !manifest.capabilities?.runtime?.observationContracts?.includes("compute-traffic/v1")) throw new Error("Configured runtime cannot observe compute traffic");
    const committed = await git("show", `${receipt.capabilityRevision}:${path.relative(root, adapter)}`);
    if (!Buffer.from(committed).equals(await readFile(adapter))) throw new Error("Compute observer bytes changed");
    return createHash("sha256").update(committed).digest("hex");
  };
  const before = await checked();
  return { receipt, adapterPath, checked, before };
}

export async function readConfiguredComputeObservation(input: { prisma: PrismaClient; config: ServerConfig }, task: RemoteTask, environment: ComputeEnvironment, resource: RemoteTaskResource, previousTraffic: ComputeTraffic[] = [], dependencies = { resolve: resolveSessionToolingCapability, execute: executeOwnedObserver }, selection?: { code: ToolingCodeIdentity | null; binding: ToolingOperationBinding | null }) {
  if (!task.primarySessionId) throw new Error("Compute requires its original primary");
  const identity = finalizationResourceIdentity(resource);
  const { code, binding } = selection ?? await environmentCode(input.prisma, task, environment);
  const { receipt, adapterPath, checked, before } = await verifiedComputeRuntime({ ...input, sessionId: task.primarySessionId, release: code, install: false }, dependencies);
  const env = operationEnvironment(binding, input.config.controlIpcPath);
  const previous = ComputeObservation.safeParse(environment.observation).data;
  const previousOperations = previous?.environmentId === environment.id && previous.resourceIdentity === identity.identityDigest ? previous.operations : undefined;
  const previousSourceRevision = previousOperations ? previous?.sourceRevision : undefined;
  const request = JSON.stringify({ version: 1, previousOperations, previousSourceRevision, previousTraffic: previousTraffic.map(value => TrafficStateSchema.parse(value.state)), task: { id: task.id, primarySessionId: task.primarySessionId, toolingRevision: task.toolingRevision, worktreePath: task.worktreePath }, environment: { id: environment.id, key: environment.key, purpose: environment.purpose, revision: environment.revision, recipeDigest: environment.recipeDigest }, resource: { ...identity, metadata: environment.configuration ? { ...z.record(z.string(), z.unknown()).parse(resource.metadata ?? {}), compute: environment.configuration } : resource.metadata } });
  if (Buffer.byteLength(request) > 2*1024*1024) throw new Error("Compute observation input exceeds its bound");
  const output = Output.parse(JSON.parse(await dependencies.execute([process.execPath, "--no-env-file", adapterPath, "compute", "observe"], { cwd: receipt.checkout, timeoutMs: 10_000, env,
    input: request })));
  if (before !== await checked()) throw new Error("Compute observer changed during observation");
  return output;
}

export async function refreshComputeObservation(input: { prisma: PrismaClient; config: ServerConfig; environmentId: string }, dependencies = { resolve: resolveSessionToolingCapability, execute: executeOwnedObserver }) {
  const environment = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: environment.taskId } });
  if (task.ownerPaused || task.phase === "closed" || !task.primarySessionId || !environment.resourceId) throw new Error("Compute physical observation is unavailable for this task");
  const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: environment.resourceId } });
  if (resource.taskId !== task.id) throw new Error("Compute physical observation resource changed");
  const identity = finalizationResourceIdentity(resource);
  const previousTraffic = await input.prisma.computeTraffic.findMany({ where: { environmentId: environment.id }, take: 33 });
  if (previousTraffic.length > 32) throw new Error("Compute route inventory exceeds its bound");
  const output = await readConfiguredComputeObservation(input, task, environment, resource, previousTraffic, dependencies);
  return input.prisma.$transaction(async tx => {
    const fresh = await tx.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } });
    if (finalizationResourceIdentity(fresh).identityDigest !== identity.identityDigest || fresh.state !== resource.state) throw new Error("Compute resource changed during observation");
    await recordComputeObservation({ ...input, prisma: tx, observation: output.observation });
    const routes = output.observation.routes;
    if (output.traffic.length !== routes.length || output.traffic.some(value => !routes.some(route => finalizationDigest(route) === finalizationDigest(value.route)))) throw new Error("Compute traffic coverage is incomplete");
    for (const state of output.traffic) {
      const previous = await tx.computeTraffic.findUnique({ where: { routeId: state.route.id } });
      if (previous && (previous.environmentId !== environment.id || previous.taskId !== task.id)) throw new Error("Compute route belongs to another environment");
      if (previous && (previous.epoch !== state.epoch && ComputeObservation.safeParse(environment.observation).data?.state !== "stopped" || previous.epoch === state.epoch && previous.sequence > state.sequence)) { state.coverage = "incomplete"; state.reason = "collector-restart"; }
      await tx.computeTraffic.upsert({ where: { routeId: state.route.id }, create: { routeId: state.route.id, taskId: task.id, environmentId: environment.id, epoch: state.epoch, sequence: state.sequence, state }, update: { epoch: state.epoch, sequence: state.sequence, state } });
    }
    return output.observation;
  });
}

/** Read-only collector recovery never installs tooling, records capability
 * grants, resumes an owner or requires the archived product path to exist.
 * Reclamation reads with the environment's producer (or retained snapshot).
 * Baseline groups have no environment: a retained first-bootstrap group uses
 * its snapshot; a group whose every member was registered after the
 * boundary has frozen post-boundary provenance and is an independently bound
 * observation of the active release; anything else fails closed. */
export async function accountingCode(input: { config: ServerConfig; prisma?: PrismaClient }, task: RemoteTask, request: unknown, mode: "reclaim-observe" | "baseline-observe", dependencies = toolingOperationDependencies)
  : Promise<{ code: ToolingCodeIdentity | null; binding: ToolingOperationBinding | null }> {
  if (!input.prisma) return { code: null, binding: null };
  if (mode === "reclaim-observe") {
    const environmentId = z.object({ environment: z.object({ id: z.string() }).passthrough() }).passthrough().parse(request).environment.id;
    return resourceGroupCode({ prisma: input.prisma, task, reference: { type: "compute-environment", id: environmentId } }, dependencies);
  }
  const purpose = z.object({ purpose: z.string() }).passthrough().parse(request).purpose;
  const consumer = await dependencies.legacy({ prisma: input.prisma, repositoryId: task.repositoryId, consumerKind: "compute-baseline", consumerId: `${task.id}:${purpose}` });
  if (consumer.status === "no-boundary") return { code: null, binding: null };
  if (consumer.status === "legacy" && consumer.taskId === task.id) return { code: { repositoryId: task.repositoryId, revision: consumer.revision, checkout: consumer.checkout }, binding: null };
  // A baseline handed off with exactly its recovered resource (DRA-24) is
  // observed by that committed recovery's release, strictly validated.
  if (consumer.status === "resolved") {
    const handedOff = await (await import("./tooling-neon-recovery.ts")).neonRecoveryHandoffCode(input.prisma, { task, reference: { type: "compute-baseline", id: `${task.id}:${purpose}` } }, dependencies.read);
    if (handedOff) return handedOff;
  }
  const boundary = await dependencies.boundary({ prisma: input.prisma, repositoryId: task.repositoryId });
  const members = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id, purpose }, select: { createdAt: true }, take: 10001 });
  if (consumer.status !== "not-legacy" || !boundary || !members.length || members.some(member => member.createdAt.getTime() <= boundary.recordedAt.getTime())) throw new Error(`Compute baseline ${task.id}:${purpose} has no frozen provenance (${consumer.status})`);
  const active = await dependencies.active({ prisma: input.prisma, config: input.config, repositoryId: task.repositoryId });
  if (!active) throw new Error("Compute baseline has no active release for its post-boundary provenance");
  return { code: active.release, binding: null };
}

async function readInstalledComputeAccounting(input: { config: ServerConfig; prisma?: PrismaClient }, task: RemoteTask, request: unknown, mode: "reclaim-observe" | "baseline-observe", execute = executeOwnedObserver, explicit?: { code: ToolingCodeIdentity | null; binding?: ToolingOperationBinding | null }) {
  const repository = input.config.repositories[task.repositoryId];
  if (!repository?.tooling) throw new Error("No configured compute reclamation runtime");
  const { code, binding } = explicit ? { code: explicit.code, binding: explicit.binding ?? null } : await accountingCode(input, task, request, mode);
  if (code && code.repositoryId !== task.repositoryId) throw new Error("Compute accounting code belongs to another repository");
  const revision = code?.revision ?? repository.tooling.revision;
  const checkout = code?.checkout ?? path.join(input.config.installRoot, "tooling", repository.id, revision);
  const manifest = JSON.parse(await execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "show", `${revision}:.remote-agent-capabilities.json`], { cwd: checkout, timeoutMs: 10_000 }));
  const relative = z.string().min(1).parse(manifest.capabilities?.runtime?.adapter);
  if (mode === "baseline-observe" && !manifest.capabilities?.runtime?.observationContracts?.includes("compute-baseline/v1")) throw new Error("Configured runtime cannot observe initial compute accounting");
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Compute reclamation adapter path changed");
  const verified = await verifyComputeRuntimeReceipt({ contract: "remote-agent.tooling-capability/v1", capability: "runtime", source: "configured-host", taskToolingRevision: task.toolingRevision,
    capabilityRevision: revision, checkout, instructions: "", adapter: path.join(checkout, relative) }, execute);
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 2*1024*1024) throw new Error("Compute reclamation input exceeds its bound");
  const result = JSON.parse(await execute([process.execPath, "--no-env-file", verified.adapterPath, "compute", mode], { cwd: checkout, env: operationEnvironment(binding, input.config.controlIpcPath), timeoutMs: mode === "baseline-observe" ? 60_000 : 10_000, input: payload }));
  if (verified.before !== await verified.checked()) throw new Error("Compute reclamation observer changed during observation");
  return result;
}

export async function readInstalledComputeReclamation(input: { config: ServerConfig; prisma?: PrismaClient }, task: RemoteTask, request: unknown, execute = executeOwnedObserver, explicit?: { code: ToolingCodeIdentity | null; binding?: ToolingOperationBinding | null }) {
  return readInstalledComputeAccounting(input, task, request, "reclaim-observe", execute, explicit);
}

export async function readInstalledComputeBaseline(input: { config: ServerConfig; prisma?: PrismaClient }, task: RemoteTask, request: unknown, execute = executeOwnedObserver, explicit?: { code: ToolingCodeIdentity | null }) {
  return readInstalledComputeAccounting(input, task, request, "baseline-observe", execute, explicit);
}
