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
import type { ToolingOperationBinding, ToolingReleaseRecord } from "../../../../types/tooling-release.ts";
import { TOOLING_OPERATION_ENV, currentToolingOperation, inLegacyContinuation, producingToolingOperation } from "./tooling-operations.ts";
import { getActiveToolingRelease } from "./tooling-releases.ts";
const Output = z.object({ observation: ComputeObservation, traffic: z.array(TrafficStateSchema).max(32) }).strict();

const processEnvironment = () => Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
/** Binding metadata for an old strict envelope travels only in process
 * context, never as a new stdin field. */
export const operationEnvironment = (binding: Pick<ToolingOperationBinding, "operationId"> | null | undefined) => ({ ...processEnvironment(), ...(binding ? { [TOOLING_OPERATION_ENV]: binding.operationId } : {}) });

/** Observation of an existing resource group: its producing (or last
 * continuing) operation, else the guarded callback's own binding. Null means
 * a pre-protocol group: the legacy configured revision, never installed and
 * never the newly active release. */
export async function environmentOperation(prisma: PrismaClient, task: RemoteTask, environment: Pick<ComputeEnvironment, "id">) {
  if (inLegacyContinuation()) return null;
  return currentToolingOperation() ?? await producingToolingOperation({ prisma, task, reference: { type: "compute-environment", id: environment.id } });
}

export async function verifiedComputeRuntime(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; development?: { intentRevision: number; intentDigest: string }; release?: ToolingReleaseRecord | null; install?: boolean }, dependencies = { resolve: resolveSessionToolingCapability, execute: executeOwnedObserver }) {
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

export async function readConfiguredComputeObservation(input: { prisma: PrismaClient; config: ServerConfig }, task: RemoteTask, environment: ComputeEnvironment, resource: RemoteTaskResource, previousTraffic: ComputeTraffic[] = [], dependencies = { resolve: resolveSessionToolingCapability, execute: executeOwnedObserver }) {
  if (!task.primarySessionId) throw new Error("Compute requires its original primary");
  const identity = finalizationResourceIdentity(resource);
  const binding = await environmentOperation(input.prisma, task, environment);
  const { receipt, adapterPath, checked, before } = await verifiedComputeRuntime({ ...input, sessionId: task.primarySessionId, release: binding?.release ?? null, install: false }, dependencies);
  const env = operationEnvironment(binding);
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
 * Reclamation reads with the environment's producing binding; baseline
 * accounting has no effect binding and is an independently bound observation
 * of the current generation's already prepared checkout. */
async function readInstalledComputeAccounting(input: { config: ServerConfig; prisma?: PrismaClient }, task: RemoteTask, request: unknown, mode: "reclaim-observe" | "baseline-observe", execute = executeOwnedObserver, explicit?: { binding?: ToolingOperationBinding | null; release?: ToolingReleaseRecord | null }) {
  const repository = input.config.repositories[task.repositoryId];
  if (!repository?.tooling) throw new Error("No configured compute reclamation runtime");
  let binding = explicit?.binding ?? null, release = explicit?.release ?? binding?.release ?? null;
  if (!release && input.prisma && explicit?.release === undefined) {
    const environmentId = mode === "reclaim-observe" ? z.object({ environment: z.object({ id: z.string() }).passthrough() }).passthrough().safeParse(request).data?.environment.id : undefined;
    if (environmentId) { binding = await producingToolingOperation({ prisma: input.prisma, task, reference: { type: "compute-environment", id: environmentId } }); release = binding?.release ?? null; }
    else if (mode === "baseline-observe") release = (await getActiveToolingRelease({ prisma: input.prisma, config: input.config, repositoryId: task.repositoryId }))?.release ?? null;
  }
  if (release && release.repositoryId !== task.repositoryId) throw new Error("Compute accounting release belongs to another repository");
  const revision = release?.revision ?? repository.tooling.revision;
  const checkout = release?.checkout ?? path.join(input.config.installRoot, "tooling", repository.id, revision);
  const manifest = JSON.parse(await execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "show", `${revision}:.remote-agent-capabilities.json`], { cwd: checkout, timeoutMs: 10_000 }));
  const relative = z.string().min(1).parse(manifest.capabilities?.runtime?.adapter);
  if (mode === "baseline-observe" && !manifest.capabilities?.runtime?.observationContracts?.includes("compute-baseline/v1")) throw new Error("Configured runtime cannot observe initial compute accounting");
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Compute reclamation adapter path changed");
  const verified = await verifyComputeRuntimeReceipt({ contract: "remote-agent.tooling-capability/v1", capability: "runtime", source: "configured-host", taskToolingRevision: task.toolingRevision,
    capabilityRevision: revision, checkout, instructions: "", adapter: path.join(checkout, relative) }, execute);
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 2*1024*1024) throw new Error("Compute reclamation input exceeds its bound");
  const result = JSON.parse(await execute([process.execPath, "--no-env-file", verified.adapterPath, "compute", mode], { cwd: checkout, env: operationEnvironment(binding), timeoutMs: mode === "baseline-observe" ? 60_000 : 10_000, input: payload }));
  if (verified.before !== await verified.checked()) throw new Error("Compute reclamation observer changed during observation");
  return result;
}

export async function readInstalledComputeReclamation(input: { config: ServerConfig; prisma?: PrismaClient }, task: RemoteTask, request: unknown, execute = executeOwnedObserver, explicit?: { binding?: ToolingOperationBinding | null; release?: ToolingReleaseRecord | null }) {
  return readInstalledComputeAccounting(input, task, request, "reclaim-observe", execute, explicit);
}

export async function readInstalledComputeBaseline(input: { config: ServerConfig; prisma?: PrismaClient }, task: RemoteTask, request: unknown, execute = executeOwnedObserver, explicit?: { release?: ToolingReleaseRecord | null }) {
  return readInstalledComputeAccounting(input, task, request, "baseline-observe", execute, explicit);
}
