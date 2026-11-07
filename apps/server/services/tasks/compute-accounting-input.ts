import path from "node:path";
import { z } from "zod";
import type { ComputeEnvironment, Prisma, RemoteTask, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { readDevelopmentJson } from "./development-selection.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import type { ComputeReclamationContext } from "./compute-reclamation.ts";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
export const ComputeAccountingInput = z.object({ environmentId: z.string().uuid(), resourceIdentity: Sha,
  allocationResourceIdentity: Sha, configurationSha256: Sha, retainedConfigurationFile: Absolute }).strict();
const Record = ComputeAccountingInput.extend({ version: z.literal(1), bindingDigest: Sha }).strict();
const action = "compute-retained-configuration";
type Configuration = { configurationFile: string; configurationSha256: string };

function binding(task: RemoteTask, environment: ComputeEnvironment, resource: RemoteTaskResource, original: Configuration) {
  return finalizationDigest({ taskId: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId,
    machineId: task.machineId, worktreePath: task.worktreePath, toolingRevision: task.toolingRevision, toolingRoot: task.toolingRoot,
    environmentId: environment.id, taskIdentity: environment.taskIdentity, key: environment.key, purpose: environment.purpose,
    revision: environment.revision, recipeDigest: environment.recipeDigest, resourceId: resource.id,
    resourceIdentity: finalizationResourceIdentity(resource).identityDigest, allocationResourceIdentity: environment.resourceIdentity, original });
}

/** A locator for already-pinned bytes, never a physical observation or a new
 * resource/configuration generation. Ambiguous, malformed or stale records
 * refuse rather than falling back to a different input. */
export async function retainedComputeConfiguration(store: Prisma.TransactionClient, task: RemoteTask, environment: ComputeEnvironment,
  resource: RemoteTaskResource, original: Configuration) {
  const rows = await store.runtimeMetadataEvent.findMany({ where: { action, source: `compute:${task.id}`, key: environment.id }, orderBy: { sequence: "asc" }, take: 2 });
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0]!.runtimeSessionId !== task.primarySessionId) throw new Error("Retained compute input ownership is ambiguous");
  const record = Record.parse(JSON.parse(rows[0]!.value ?? "null"));
  if (record.environmentId !== environment.id || record.resourceIdentity !== finalizationResourceIdentity(resource).identityDigest
    || record.allocationResourceIdentity !== environment.resourceIdentity || record.configurationSha256 !== original.configurationSha256
    || record.bindingDigest !== binding(task, environment, resource, original)) throw new Error("Retained compute input binding changed");
  return record;
}

/** Owner-only evidence-location registration. It reads a bounded private
 * file and appends one immutable binding. The collector still selects the
 * original observer, validates the complete configuration and independently
 * inventories physical members before it can change accounting. */
export async function retainComputeAccountingInput(input: ComputeReclamationContext
  & { taskId: string; request: z.infer<typeof ComputeAccountingInput> }, read = readDevelopmentJson) {
  const request = ComputeAccountingInput.parse(input.request);
  if (!input.config.compute?.enabled || request.environmentId !== input.environmentId) throw new Error("Compute accounting input is unavailable");
  const { readComputeReclamationSnapshot } = await import("./compute-reclamation.ts");
  const before = await readComputeReclamationSnapshot(input.prisma, input);
  const { task, environment, resource, originalConfiguration } = before;
  if (task.id !== input.taskId || !before.settled || !task.ownerPaused && task.phase !== "closed" || !originalConfiguration
    || request.resourceIdentity !== before.identity.identityDigest || request.allocationResourceIdentity !== environment.resourceIdentity
    || request.configurationSha256 !== before.configurationDigest || request.retainedConfigurationFile === originalConfiguration.configurationFile) throw new Error("Compute accounting input owner or original binding changed");
  const record = { version: 1 as const, ...request, bindingDigest: binding(task, environment, resource, originalConfiguration) };
  if (before.retainedConfiguration && finalizationDigest(before.retainedConfiguration) !== finalizationDigest(record)) throw new Error("Retained compute input is already bound differently");
  const verify = async () => {
    const value = z.object({ taskId: z.string(), primarySessionId: z.string(), environmentId: z.string(), resourceKey: z.string(),
      purpose: z.string(), revision: z.string(), recipeDigest: z.string() }).passthrough().parse(await read(request.retainedConfigurationFile, request.configurationSha256));
    if (value.taskId !== task.id || value.primarySessionId !== task.primarySessionId || value.environmentId !== environment.id || value.resourceKey !== resource.key
      || value.purpose !== environment.purpose || value.revision !== environment.revision || value.recipeDigest !== environment.recipeDigest) throw new Error("Retained compute configuration belongs to another allocation");
  };
  await verify();
  return input.prisma.$transaction(async tx => {
    const current = await readComputeReclamationSnapshot(tx, input);
    if (!current.settled || current.digest !== before.digest) throw new Error("Compute accounting input changed during registration");
    await verify();
    if (!current.retainedConfiguration) await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: task.primarySessionId!, action,
      source: `compute:${task.id}`, key: environment.id, value: JSON.stringify(record) } });
    return { environmentId: environment.id, resourceId: resource.id, configurationSha256: request.configurationSha256, registered: true };
  });
}
