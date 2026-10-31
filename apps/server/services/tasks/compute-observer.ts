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
const Output = z.object({ observation: ComputeObservation, traffic: z.array(TrafficStateSchema).max(32) }).strict();

export async function verifiedComputeRuntime(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; development?: { intentRevision: number; intentDigest: string } }, dependencies = { resolve: resolveSessionToolingCapability, execute: executeOwnedObserver }) {
  const { receipt } = await dependencies.resolve({ prisma: input.prisma, config: input.config, sessionId: input.sessionId, capability: "runtime", ...(input.development ? { development: input.development } : {}) });
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
  const { receipt, adapterPath, checked, before } = await verifiedComputeRuntime({ ...input, sessionId: task.primarySessionId }, dependencies);
  const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
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
 * grants, resumes an owner or requires the archived product path to exist. */
export async function readInstalledComputeReclamation(input: { config: ServerConfig }, task: RemoteTask, request: unknown, execute = executeOwnedObserver) {
  const repository = input.config.repositories[task.repositoryId];
  if (!repository?.tooling) throw new Error("No configured compute reclamation runtime");
  const revision = repository.tooling.revision;
  const checkout = path.join(input.config.installRoot, "tooling", repository.id, revision);
  const manifest = JSON.parse(await execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "show", `${revision}:.remote-agent-capabilities.json`], { cwd: checkout, timeoutMs: 10_000 }));
  const relative = z.string().min(1).parse(manifest.capabilities?.runtime?.adapter);
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Compute reclamation adapter path changed");
  const verified = await verifyComputeRuntimeReceipt({ contract: "remote-agent.tooling-capability/v1", capability: "runtime", source: "configured-host", taskToolingRevision: task.toolingRevision,
    capabilityRevision: revision, checkout, instructions: "", adapter: path.join(checkout, relative) }, execute);
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 2*1024*1024) throw new Error("Compute reclamation input exceeds its bound");
  const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const result = JSON.parse(await execute([process.execPath, "--no-env-file", verified.adapterPath, "compute", "reclaim-observe"], { cwd: checkout, env, timeoutMs: 10_000, input: payload }));
  if (verified.before !== await verified.checked()) throw new Error("Compute reclamation observer changed during observation");
  return result;
}
