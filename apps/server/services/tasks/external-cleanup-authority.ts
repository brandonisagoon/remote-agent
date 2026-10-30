import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { assertExternalBindingAuthority, assertExternalResourceRecords, latestExternalBinding, type ExternalDatabase } from "./external-deliveries.ts";
import { EXTERNAL_OBSERVATION, ExternalBinding, externalDigest } from "./external-delivery-schema.ts";
import { PreparedExternalFinalization } from "./external-finalization-schema.ts";
import { FINALIZATION_PREPARED, FINALIZATION_CONFIRMED } from "./finalization-receipts.ts";
import { finalizationDigest } from "./finalization-resources.ts";

export async function assertExternalResourceProofs(prisma: Pick<PrismaClient, "runtimeMetadataEvent">, prepared: PreparedExternalFinalization, preparedRevision: number, value: string | null) {
  const data = z.object({ version: z.literal(2), preparedRevision: z.number().int(), resourceProofs: z.array(z.number().int()) }).strict().parse(JSON.parse(value!));
  if (data.preparedRevision !== preparedRevision || data.resourceProofs.length !== prepared.resources.length || new Set(data.resourceProofs).size !== data.resourceProofs.length) throw new Error("External finalization confirmation proof identity mismatch");
  const proofs = await prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: data.resourceProofs } } });
  if (proofs.length !== prepared.resources.length || prepared.resources.some((entry) => !proofs.some((proof) => {
    const value = JSON.parse(proof.value ?? "null");
    return proof.runtimeSessionId === prepared.sessionId && proof.source === `finalizer:${prepared.taskId}` && proof.action === "finalization-resource-proof" && proof.key === `${preparedRevision}:${entry.id}:${entry.disposition}` && value?.preparedRevision === preparedRevision && value?.resourceId === entry.id && value?.identityDigest === entry.identityDigest && value?.disposition === entry.disposition;
  }))) throw new Error("External finalization resource proof is missing or mismatched");
}

/** Local authority only. A generic Released record is never a physical proof:
 * full preparation/confirmation independently observes the frozen resources.
 * This seam binds that existing receipt to the common cleanup operation. */
export async function inspectExternalCleanupAuthority(input: { prisma: ExternalDatabase; config: ServerConfig; sessionId: string; requestKey: string; allowConfirmedClosed?: boolean }) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
  if (input.requestKey !== `finalize:${task.id}`) throw new Error("External cleanup requires the original finalization request");
  const where = { runtimeSessionId: input.sessionId, source: `finalizer:${task.id}`, key: input.requestKey };
  const preparation = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: where.source, action: FINALIZATION_PREPARED }, orderBy: { sequence: "desc" } });
  if (!preparation?.value || preparation.key !== input.requestKey) throw new Error("External cleanup requires its existing preparation");
  const prepared = PreparedExternalFinalization.parse(JSON.parse(preparation.value));
  const adopted = await latestExternalBinding(input.prisma, task.id, input.sessionId);
  if (!adopted?.value) throw new Error("External cleanup requires its accepted delivery binding");
  const binding = ExternalBinding.parse(JSON.parse(adopted.value));
  const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
  if (input.allowConfirmedClosed && !confirmed) throw new Error("Closed external cleanup requires its exact confirmation");
  if (confirmed) await assertExternalResourceProofs(input.prisma, prepared, preparation.sequence, confirmed.value);
  const current = await assertExternalBindingAuthority(input.prisma, input.config, binding, adopted.sequence, { allowConfirmedClosed: input.allowConfirmedClosed });
  const identity = current.identity;
  const branch = binding.version === 2 ? binding.cleanupSnapshot.branch : identity.branch;
  if (prepared.taskId !== task.id || prepared.sessionId !== input.sessionId || prepared.requestKey !== input.requestKey
    || prepared.repositoryId !== identity.repositoryId || prepared.machineId !== identity.machineId || prepared.connectionId !== identity.connectionId
    || prepared.issueId !== binding.acceptance.issueId || prepared.issueIdentifier !== identity.issueIdentifier || prepared.taskWorktree !== identity.taskWorktree
    || prepared.baseCommit !== identity.baseCommit || prepared.toolingRevision !== identity.toolingRevision || prepared.pinnedToolingRoot !== identity.pinnedToolingRoot
    || prepared.bindingRevision !== adopted.sequence || prepared.bindingDigest !== binding.manifestDigest || externalDigest(binding.input) !== binding.manifestDigest
    || prepared.contractRevision !== binding.contractRevision || prepared.branch !== branch || prepared.revision !== prepared.cleanupSnapshot.head
    || prepared.cleanupSnapshot.branch !== branch || prepared.resourcePlanDigest !== binding.resourcePlanDigest
    || finalizationDigest(prepared.resources) !== binding.resourcePlanDigest || finalizationDigest(binding.resources) !== binding.resourcePlanDigest
    || path.resolve(getRepositoryConfig(input.config, task.repositoryId).root) !== prepared.gitCwd) throw new Error("External cleanup preparation or original identity changed");
  if (binding.version === 2) {
    const accepted = { kind: "present-day-owner", bindingRevision: adopted.sequence, bindingDigest: binding.manifestDigest, recordedBranch: identity.branch, sourceStateId: binding.acceptance.stateId };
    if (finalizationDigest(prepared.deliveredRetirement) !== finalizationDigest(accepted) || prepared.doneHandoff.expectedState !== "Done"
      || finalizationDigest(prepared.cleanupSnapshot) !== finalizationDigest(binding.cleanupSnapshot)) throw new Error("External cleanup accepted branch correspondence changed");
  } else if (prepared.deliveredRetirement !== undefined || prepared.doneHandoff.expectedState !== "Merge") throw new Error("External cleanup authority variant changed");
  if (finalizationDigest(prepared.originalWork ?? null) !== finalizationDigest(binding.originalWork ?? null)
    || prepared.originalWork && prepared.originalWork.restore.gitDirectory !== prepared.gitDirectory || !prepared.originalWork && !prepared.cleanupSnapshot.clean) throw new Error("External cleanup original-work preservation changed");
  const observation = await input.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: prepared.delivery.observationRevision } });
  if (!observation?.value || observation.action !== EXTERNAL_OBSERVATION || observation.runtimeSessionId !== input.sessionId
    || observation.source !== `observer:${task.id}` || observation.key !== input.requestKey) throw new Error("External cleanup has no matching delivery observation");
  const observed = JSON.parse(observation.value);
  if (observed.bindingRevision !== adopted.sequence || observed.bindingDigest !== binding.manifestDigest || observed.contractRevision !== binding.contractRevision
    || externalDigest(observed.deliveries) !== externalDigest(prepared.delivery.deliveries)) throw new Error("External cleanup delivery observation changed");
  const resources = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } });
  assertExternalResourceRecords(resources, prepared.resources, Boolean(confirmed));
  const revisions = binding.version === 2 ? [binding.ownerHistoryRevision] : [binding.contractRevision, binding.verificationRevision, binding.acceptance.approvalEventSequence];
  const ownerEvents = await input.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: revisions.filter(revision => revision > 0) } } });
  if (ownerEvents.length !== new Set(revisions.filter(revision => revision > 0)).size || ownerEvents.some(event => event.runtimeSessionId !== input.sessionId || event.source !== `owner:${task.id}`)) throw new Error("External cleanup accepted owner history changed");
  return { task: current.task, prepared, preparation, authorityEvents: [...ownerEvents, adopted, observation].sort((a, b) => a.sequence - b.sequence),
    retainedResourceIds: new Set(prepared.resources.filter(resource => resource.disposition.startsWith("retain-")).map(resource => resource.id)) };
}

