/**
 * TEST-ONLY fixture (never imported by server code): one committed Neon
 * recovery seeded exactly as the staged design (551400d9) stores it in its
 * single transaction — the recovery event (full stored binding, staged proof,
 * verbatim legacy-group handoff, drafted.runtime/2 state write, result), the
 * real ToolingStateWrite row and the resolved ToolingLegacyConsumer row.
 *
 * This is a seeded record for verifier and read-route tests. It is NOT the
 * actual writer's output and is never acceptance for it: real-writer
 * integration (service -> event -> GET/completion) is a separate, required
 * test once the writer is frozen.
 */
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ToolingOperationBinding } from "../../../../types/tooling-release.ts";
import { canonicalSha256, neonRecoveryInputDigest } from "./compute-neon-recovery.ts";
import { finalizationDigest } from "./finalization-resources.ts";

export const seededValues = { head: "22406a5eddb33f983a669f8f686b9a416beac113", revision: "a".repeat(40), pin: "d".repeat(40), oldHash: "b".repeat(64), nextHash: "c".repeat(64) } as const;
const { head, revision, pin, oldHash, nextHash } = seededValues;

/** Test mirror of the writer's staged evidence (design §7: + candidateSha256). */
export const stagedEvidence = (proof: any) => {
  const { baselineSha256, candidateSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision } = proof;
  return finalizationDigest({ baselineSha256, candidateSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision });
};
/** Test mirror of the writer's transition key. */
const transitionKey = (environmentId: string, resourceId: string, request: { offerId: string; operationId: string; previousRecipeHash: string; recipeHash: string }) =>
  finalizationDigest({ environmentId, resourceId, offerId: request.offerId, operationId: request.operationId, previousRecipeHash: request.previousRecipeHash, recipeHash: request.recipeHash });

/** A recovery request for `taskId`; its operation binding must use this
 * request's offerId as existingOperationId and its lock-free digest. */
export function seededRecoveryRequest(taskId: string) {
  return { offerId: crypto.randomUUID(), operationId: crypto.randomUUID(), resourceKey: "runtime-development", previousRecipeHash: oldHash, recipeHash: nextHash,
    baselineFile: `/private/${taskId}/baseline.json`, lockPid: 4242, outcome: "absent" as const, sourceRevision: head };
}
export const seededInputDigest = (request: ReturnType<typeof seededRecoveryRequest>) => neonRecoveryInputDigest(request);

/** Seeds the committed record for `binding` (the full stored binding, as
 * `readToolingOperation` projects it). The runtime session must exist. */
export async function seedCommittedNeonRecovery(prisma: PrismaClient, binding: ToolingOperationBinding, request: ReturnType<typeof seededRecoveryRequest>) {
  const task = binding.taskId, environmentId = crypto.randomUUID(), resourceId = `resource-${task}`;
  const saved = { provider: "planetscale" as const, id: `ps-${task}`, name: `drafted-${task}` };
  const attempt = { version: 1 as const, name: saved.name, projectId: "spatial-project", templateBranchId: "br-template", parentLsn: "0/1A2B3C4", requestedAt: "2026-11-04T10:01:00.000Z", expiresAt: "2026-11-11T10:01:00.000Z",
    rejection: { status: 422, code: "BRANCHES_LIMIT_EXCEEDED", observedAt: "2026-11-04T10:01:01.000Z" } };
  const reconciliation = { operation: "create-neon", outcome: "absent", name: saved.name, projectId: "spatial-project", observedAt: "2026-11-05T09:00:00.000Z", attempt, absence: { basis: "provider-rejection" } };
  const { release } = binding;
  // First commit: the canonical receipt is still its baseline.
  const proof = { version: 1, contract: "runtime-neon-recovery/v1", transition: "neon-template-child", taskId: task, primarySessionId: binding.sessionId, toolingRevision: pin,
    environmentId, resourceId, resourceKey: request.resourceKey, offerId: request.offerId, operationId: request.operationId, revision, sourceRevision: request.sourceRevision,
    previousRecipeHash: request.previousRecipeHash, recipeHash: request.recipeHash, receiptSha256: "2".repeat(64), baselineSha256: "2".repeat(64), lockSha256: "3".repeat(64), lockPid: request.lockPid,
    stage: { phase: "failed", pending: null, setupComplete: false, schemaApplied: false, fixturesComplete: false, spatialSchema: false, container: false, containerOperation: false, configuration: false, coverage: false, startBundle: false },
    baselineProviders: [saved], providers: [saved], reconciliation, baselineNeonCreateSha256: canonicalSha256(attempt),
    operation: { operationId: binding.operationId, releaseId: release.id, revision: release.revision, tree: release.tree },
    candidateSha256: "4".repeat(64), candidateVersion: 2, canonical: "baseline" };
  const observer = { operationId: binding.operationId, releaseId: release.id, revision: release.revision, tree: release.tree, adapterSha256: "8".repeat(64) };
  const write = await prisma.toolingStateWrite.create({ data: { repositoryId: binding.repositoryId, taskId: task, family: "drafted.runtime", scopeKey: "runtime-development", version: 2, preservesUnknown: true,
    operationId: binding.operationId, releaseId: release.id } });
  const legacy = await prisma.toolingLegacyConsumer.create({ data: { id: `legacy-${task}`, repositoryId: binding.repositoryId, taskId: task, consumerKind: "compute-environment", consumerId: environmentId, provenance: "exact",
    revision: pin, checkout: "/fixture/tooling", status: "resolved", resolution: { kind: "compute-neon-recovery", reference: binding.operationId }, resolvedAt: new Date() } });
  const stateWrite = { family: "drafted.runtime" as const, scopeKey: "runtime-development" as const, version: 2 as const, operationId: binding.operationId, releaseId: release.id, sequence: write.sequence };
  const result = { environmentId, resourceId, resourceIdentity: "5".repeat(64), offerId: request.offerId, operationId: request.operationId, previousRecipeHash: request.previousRecipeHash, recipeHash: request.recipeHash,
    sourceRevision: request.sourceRevision, outcome: request.outcome, basis: "provider-rejection" as const, reconciliationSha256: finalizationDigest(reconciliation), observer,
    allocation: "retained-existing-claim" as const, stateWrite };
  // The legacy-group helper's NeonRecoveryHandoff, stored verbatim.
  const handoff = { version: 1, operationId: binding.operationId, taskId: task, environmentId, resourceId,
    rows: [{ id: legacy.id, consumerKind: legacy.consumerKind, consumerId: legacy.consumerId, revision: legacy.revision, checkout: legacy.checkout }] };
  const value = { version: 1, contract: "runtime-neon-recovery/v1", transition: "neon-template-child", taskIdentity: `identity-${task}`, request,
    environment: { id: environmentId }, resource: { id: resourceId }, offer: { id: request.offerId }, allocations: { offers: [], slots: [], wait: null }, operation: binding,
    proof, observer, evidence: stagedEvidence(proof), projectionIdentity: "6".repeat(64), handoff, stateWrite, result };
  const event = await prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: binding.sessionId, source: `compute:${task}`, action: "compute-neon-recovery",
    key: transitionKey(environmentId, resourceId, request), value: JSON.stringify(value) } });
  /** Exactly what the public read returns for this record. */
  const { lockPid: _pid, ...stable } = request;
  const committed = { operation: { operationId: binding.operationId, requestKey: binding.requestKey, inputDigest: binding.inputDigest, taskId: task, sessionId: binding.sessionId, kind: "compute-neon-recovery" as const,
    existingOperationId: request.offerId, resourceKey: request.resourceKey, release: { id: release.id, revision: release.revision, tree: release.tree } }, request: stable, result };
  return { result, event, write, legacy, committed };
}
