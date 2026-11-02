import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import type { CleanupDeliveryRetention } from "./cleanup-delivery-reference.ts";
import { completionObservation } from "./completion-observation.ts";
import { observeLocalCleanupReference } from "./external-delivery-observation.ts";
import { ExternalDeliveryObservation } from "./external-delivery-schema.ts";
import { finalizationDigest, finalizationResourceIdentity, FinalizationResourcePlan } from "./finalization-resources.ts";

export const LOCAL_CLEANUP_REFERENCE = "finalization-local-reference";
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
type Database = Pick<PrismaClient, "runtimeMetadataEvent">;
const Digest = z.string().regex(/^[a-f0-9]{64}$/), Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Metadata = z.object({ repository: z.string().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/), number: z.number().int().positive(), head: Sha, branch: z.string().min(1), baseBranch: z.string().min(1) });
const Observation = ExternalDeliveryObservation.pick({ id: true, repository: true, pullRequest: true, url: true, reviewedHead: true, mergeCommit: true, mergedAt: true, baseHead: true, ci: true }).extend({ ci: z.tuple([]) });
const Proof = z.object({ version: z.literal(1), taskId: z.string(), sessionId: z.string(), requestKey: z.string(), toolingRevision: Sha,
  preparedRevision: z.number().int().positive(), preparedRawDigest: Digest, operationRevision: z.number().int().positive(), operationRawDigest: Digest, operationDigest: Digest,
  bindingDigest: Digest, originalWork: z.object({ revision: z.number().int().positive(), digest: Digest, rawDigest: Digest }).strict().optional(),
  resource: FinalizationResourcePlan, observation: Observation,
}).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const where = (active: Active) => ({ runtimeSessionId: active.binding.sessionId, source: `finalizer:${active.task.id}`, action: LOCAL_CLEANUP_REFERENCE, key: active.prepared.requestKey });
const bindingDigest = (active: Active) => finalizationDigest({ ...active.binding, resources: active.binding.resources.map(({ state: _state, ...resource }) => resource) });

function selection(active: Active) {
  if (active.kind !== "v1" || active.prepared.delivery.boundary !== "local-only" || active.prepared.localCompletion?.boundary !== "local-only"
    || active.binding.connectionId !== null || active.binding.issueIdentifier !== null) return;
  const originals = active.operation.binding.resources.filter(resource => ["pull-request", "github-pull-request"].includes(resource.kind));
  if (!originals.length) return;
  if (originals.length !== 1) throw Error("Local cleanup reference requires exactly one frozen pull request");
  const original = originals[0]!, current = active.binding.resources.find(resource => resource.id === original.id);
  if (!current || original.state !== "ready" || current.state !== "ready" || !["development", "review", "browser"].includes(current.purpose)
    || active.binding.resources.filter(resource => resource.externalId === original.externalId).length !== 1
    || active.operation.binding.resources.filter(resource => resource.externalId === original.externalId).length !== 1
    || finalizationResourceIdentity(original).identityDigest !== finalizationResourceIdentity(current).identityDigest) throw Error("Local cleanup reference Ready identity changed or is ambiguous");
  const metadata = Metadata.parse(current.metadata), prepared = active.prepared;
  if (current.externalId !== `https://github.com/${metadata.repository}/pull/${metadata.number}` || metadata.head !== prepared.revision || metadata.branch !== prepared.branch
    || !prepared.delivery.receipts.snapshot.clean || prepared.delivery.receipts.snapshot.head !== prepared.revision || prepared.delivery.receipts.snapshot.branch !== prepared.branch
    || !prepared.delivery.receipts.commit.observed || !prepared.delivery.receipts.commit.clean || prepared.delivery.receipts.commit.sha !== prepared.revision) throw Error("Local cleanup reference differs from the accepted source snapshot");
  return { resource: current, metadata };
}

async function bindings(prisma: Database, active: Active) {
  const operation = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: active.operationRevision } });
  if (!active.preparation.value || !operation?.value || operation.action !== "finalization-cleanup-started" || operation.source !== `finalizer:${active.task.id}`
    || operation.runtimeSessionId !== active.binding.sessionId || operation.key !== active.prepared.requestKey
    || finalizationDigest(JSON.parse(operation.value)) !== finalizationDigest(active.operation)) throw Error("Local cleanup reference operation bytes changed");
  let originalWork: z.infer<typeof Proof>["originalWork"];
  if (active.originalWorkReceipt) {
    const receipt = active.originalWorkReceipt, event = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: receipt.revision } });
    if (!event?.value || event.action !== "finalization-legacy-original-work" || event.source !== `owner:${active.task.id}` || event.runtimeSessionId !== active.binding.sessionId
      || event.key !== active.prepared.requestKey || finalizationDigest(JSON.parse(event.value)) !== receipt.digest) throw Error("Local cleanup reference original source adoption changed");
    originalWork = { revision: receipt.revision, digest: receipt.digest, rawDigest: hash(event.value) };
  } else if (active.kind === "v1" && active.prepared.localCompletion?.sourceCaptureRequired) throw Error("Local cleanup reference requires its accepted original source adoption");
  return { taskId: active.task.id, sessionId: active.binding.sessionId, requestKey: active.prepared.requestKey, toolingRevision: active.binding.toolingRevision,
    preparedRevision: active.preparation.sequence, preparedRawDigest: hash(active.preparation.value), operationRevision: active.operationRevision,
    operationRawDigest: hash(operation.value), operationDigest: finalizationDigest(active.operation), bindingDigest: bindingDigest(active), ...(originalWork ? { originalWork } : {}) };
}

/** Database-only projection of independently observed history. It never starts
 * provider IO, creates a proof, rewrites a receipt or releases a resource. */
export async function localCleanupReferenceRetention(prisma: Database, active: Active, confirmedRevision?: number): Promise<CleanupDeliveryRetention | undefined> {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: where(active) });
  if (!event) return;
  const selected = selection(active), proof = Proof.parse(JSON.parse(event.value!));
  if (!selected) throw Error("Unexpected local cleanup reference supplement");
  const { resource, observation, version, ...savedBinding } = proof;
  if (finalizationDigest(savedBinding) !== finalizationDigest(await bindings(prisma, active)) || resource.disposition !== "retain-reference"
    || finalizationResourceIdentity(selected.resource).identityDigest !== resource.identityDigest || resource.id !== selected.resource.id
    || resource.reference.deliveryId !== `finalizer:${active.task.id}:${active.preparation.sequence}` || resource.reference.type !== "pull-request"
    || observation.id !== selected.resource.id || observation.repository !== selected.metadata.repository || observation.pullRequest !== selected.metadata.number
    || observation.url !== selected.resource.externalId || observation.reviewedHead !== selected.metadata.head
    || resource.reference.repository !== observation.repository || resource.reference.number !== observation.pullRequest
    || resource.reference.reviewedHead !== observation.reviewedHead || resource.reference.mergeCommit !== observation.mergeCommit) throw Error("Local cleanup reference supplement binding changed");
  const expected = FinalizationResourcePlan.parse({ ...finalizationResourceIdentity(selected.resource), disposition: "retain-reference", reference: {
    deliveryId: `finalizer:${active.task.id}:${active.preparation.sequence}`, type: "pull-request", repository: observation.repository,
    number: observation.pullRequest, reviewedHead: observation.reviewedHead, mergeCommit: observation.mergeCommit } });
  if (finalizationDigest(resource) !== finalizationDigest(expected)) throw Error("Local cleanup reference plan identity changed");
  return { version: 1, taskId: active.task.id, sessionId: active.binding.sessionId, requestKey: active.prepared.requestKey, preparedRevision: active.preparation.sequence,
    operationRevision: active.operationRevision, operationDigest: finalizationDigest(active.operation), ...(confirmedRevision !== undefined ? { confirmedRevision } : {}),
    resourcePlanDigest: finalizationDigest([resource]), resources: [resource as CleanupDeliveryRetention["resources"][0]] };
}

export const localCleanupReferenceDependencies = { repository: completionObservation.repository, observe: observeLocalCleanupReference };
/** Only the existing full preparation may add this server-observed reference
 * history. All remote work precedes a fresh, short local authority/receipt CAS. */
export async function ensureLocalCleanupReference(input: { prisma: PrismaClient; active: Active; assertAuthority(db: PrismaClient): Promise<Active> }, dependencies = localCleanupReferenceDependencies) {
  const selected = selection(input.active);
  if (!selected) return;
  const prior = await localCleanupReferenceRetention(input.prisma, input.active);
  if (prior) return prior;
  const initial = await bindings(input.prisma, input.active);
  const repository = await dependencies.repository(input.active.prepared.worktree);
  if (repository.repository !== selected.metadata.repository) throw Error("Local cleanup reference belongs to another configured repository");
  const observation = Observation.parse(await dependencies.observe({ id: selected.resource.id, repository: selected.metadata.repository, pullRequest: selected.metadata.number,
    reviewedHead: selected.metadata.head, branch: selected.metadata.branch, baseBranch: selected.metadata.baseBranch }));
  if (observation.id !== selected.resource.id || observation.repository !== selected.metadata.repository || observation.pullRequest !== selected.metadata.number
    || observation.url !== selected.resource.externalId || observation.reviewedHead !== selected.metadata.head) throw Error("Observed local cleanup reference identity changed");
  const resource = FinalizationResourcePlan.parse({ ...finalizationResourceIdentity(selected.resource), purpose: selected.resource.purpose, disposition: "retain-reference", reference: {
    deliveryId: `finalizer:${input.active.task.id}:${input.active.preparation.sequence}`, type: "pull-request", repository: observation.repository,
    number: observation.pullRequest, reviewedHead: observation.reviewedHead, mergeCommit: observation.mergeCommit } });
  const proof = Proof.parse({ version: 1, ...initial, resource, observation });
  const fresh = await input.assertAuthority(input.prisma);
  if (fresh.authorityEpoch !== input.active.authorityEpoch || finalizationDigest(await bindings(input.prisma, fresh)) !== finalizationDigest(initial)) throw Error("Local cleanup reference authority changed during observation");
  return input.prisma.$transaction(async tx => {
    const current = await input.assertAuthority(tx as PrismaClient);
    if (current.authorityEpoch !== fresh.authorityEpoch || finalizationDigest(await bindings(tx, current)) !== finalizationDigest(initial)) throw Error("Local cleanup reference authority changed before publication");
    selection(current);
    if (await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: current.binding.sessionId, source: `finalizer:${current.task.id}`, action: "finalization-confirmed", key: current.prepared.requestKey } })) throw Error("Confirmed cleanup cannot adopt a new reference supplement");
    if (await localCleanupReferenceRetention(tx, current)) throw Error("Local cleanup reference was supplemented concurrently; inspect the same operation");
    await tx.runtimeMetadataEvent.create({ data: { ...where(current), value: JSON.stringify(proof) } });
    return localCleanupReferenceRetention(tx, current);
  });
}
