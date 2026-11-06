import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ToolingOperationBinding } from "../../../../types/tooling-release.ts";
import { ComputeNeonRecovery, ComputeNeonRecoveryProof, NeonRecoveryContract, NeonRecoveryOperationKind, NeonRecoveryTransition, neonRecoveryInputDigest } from "./compute-neon-recovery.ts";
import { finalizationDigest } from "./finalization-resources.ts";

/**
 * Exact committed result of one Neon recovery operation, read only from the
 * server's own durable recovery event (the single atomic effect of
 * `recoverComputeNeon`: projection, event, legacy handoff, drafted.runtime/2
 * registration and operation completion). Internal and authority-free: the
 * caller has already validated the stored operation binding under its own
 * read authority.
 *
 * Pure apart from bounded database reads (the task's recovery events, the
 * registered state write and the handed-off legacy rows). It never executes
 * an observer, calls a provider, replays a handler, repairs status or writes
 * anything. `null` means only that this task's complete, fully readable
 * recovery history holds no event of this operation. Anything unreadable,
 * ambiguous, oversized or inconsistent throws
 * `NeonRecoveryResultUnverifiable`, never `null`.
 *
 * Staged-handoff wire fields (design 551400d9 §3/§7) are REQUIRED here:
 * proof candidateSha256/candidateVersion/canonical, event handoff and
 * stateWrite, result stateWrite. There is no fallback for older events.
 */

/** Fixed reasons a stored recovery result cannot be verified. */
export const NeonRecoveryResultReason = z.enum(["binding-invalid", "history-bound", "event-unreadable", "event-ambiguous", "event-mismatch"]);
export type NeonRecoveryResultReason = z.infer<typeof NeonRecoveryResultReason>;
export class NeonRecoveryResultUnverifiable extends Error {
  readonly code = "neon-recovery-result-unverifiable";
  constructor(readonly reason: NeonRecoveryResultReason, detail: string) { super(`Neon recovery result is unverifiable (${reason}): ${detail}`); }
}

// Mirrors of private identities in compute-neon-recovery.ts (its event
// action, `journalKey` and `evidence`, the latter with the staged design's
// candidateSha256). Replace with that module's exports once provided; until
// then the key is pinned by this module's test against the real writer.
const EVENT_ACTION = "compute-neon-recovery";
const journalKey = (environmentId: string, resourceId: string, request: z.infer<typeof ComputeNeonRecovery>) =>
  finalizationDigest({ environmentId, resourceId, offerId: request.offerId, operationId: request.operationId, previousRecipeHash: request.previousRecipeHash, recipeHash: request.recipeHash });
function evidence(proof: Proof) {
  const { baselineSha256, candidateSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision } = proof;
  return finalizationDigest({ baselineSha256, candidateSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision });
}
const HISTORY_BOUND = 1000, HANDOFF_BOUND = 1000;
/** The one state write a recovery registers (design 551400d9 S6). */
export const NeonRecoveryStateFamily = "drafted.runtime", NeonRecoveryStateScope = "runtime-development", NeonRecoveryStateVersion = 2;
const HANDOFF_EVIDENCE_KIND = "compute-neon-recovery";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.string().regex(/^[a-f0-9]{40}$/);
const Id = z.string().min(1).max(256);
const ObserverIdentity = z.strictObject({ operationId: Id, releaseId: Id, revision: Revision, tree: Revision, adapterSha256: Sha });
/** The proof with the staged candidate (strict; no fallback). The stored
 * proof is the first commit's, observed while canonical == baseline. */
const Proof = ComputeNeonRecoveryProof.extend({ candidateSha256: Sha, candidateVersion: z.literal(2), canonical: z.enum(["baseline", "candidate"]) }).strict();
type Proof = z.infer<typeof Proof>;
const StateWrite = z.strictObject({ family: z.literal(NeonRecoveryStateFamily), scopeKey: z.literal(NeonRecoveryStateScope), version: z.literal(NeonRecoveryStateVersion),
  operationId: Id, releaseId: Id, sequence: z.number().int().positive() });
/** The canonical server-only handoff record (the legacy-group helper's
 * `NeonRecoveryHandoff`, stored verbatim): full identity, and each resolved
 * row's exact snapshot. Revision and checkout are never null: a reader
 * without exact executable provenance is never handed off. */
const Handoff = z.strictObject({ version: z.literal(1), operationId: Id, taskId: Id, environmentId: Id, resourceId: Id,
  rows: z.array(z.strictObject({ id: Id, consumerKind: Id, consumerId: Id, revision: z.string().min(1), checkout: z.string().min(1) })).max(HANDOFF_BOUND) });
/** The server response shape (`ComputeNeonRecoveryResult`), strictly. */
const Result = z.strictObject({
  environmentId: Id, resourceId: Id, resourceIdentity: Sha, offerId: z.uuid(), operationId: z.uuid(), previousRecipeHash: Sha, recipeHash: Sha, sourceRevision: Revision,
  outcome: z.enum(["absent", "owned"]), basis: z.enum(["provider-rejection", "complete-inventory", "legacy-provider-rejection", "exact-owned-child"]), reconciliationSha256: Sha,
  observer: ObserverIdentity, allocation: z.enum(["retained-existing-claim", "previously-stopped-await-normal-admission"]), stateWrite: StateWrite,
});
/** The full stored binding the service records (the server's
 * `ToolingOperationBinding`, exactly): every field required, nullable ones
 * explicitly null, so a missing parent is never silently accepted. `status`
 * is the binding's status when admitted and is not identity. */
const StoredOperation = z.strictObject({
  contract: z.literal("remote-agent.tooling-operation/v1"), operationId: Id, requestKey: Id, inputDigest: Sha, repositoryId: Id, taskId: Id, sessionId: Id, turnId: Id.nullable(),
  kind: z.literal(NeonRecoveryOperationKind), existingOperationId: Id, parentOperationId: Id.nullable(), retainedConsumerId: Id.nullable(), resourceKey: Id, generation: z.number().int().positive(),
  release: z.strictObject({ id: Id, repositoryId: Id, revision: Revision, tree: Revision, policyBlob: z.string().min(1), checkout: z.string().min(1), manifest: z.record(z.string(), z.unknown()) }),
  status: z.enum(["bound", "running", "unknown", "completed"]),
});
const Row = z.object({ id: Id }).passthrough();
/** Every top-level field `recoverComputeNeon` writes, and nothing else. */
const StoredEvent = z.strictObject({
  version: z.literal(1), contract: z.literal(NeonRecoveryContract), transition: z.literal(NeonRecoveryTransition), taskIdentity: z.string().min(1),
  request: ComputeNeonRecovery, environment: Row, resource: Row, offer: Row, allocations: z.unknown(), operation: StoredOperation,
  proof: Proof, observer: ObserverIdentity, evidence: Sha, projectionIdentity: Sha, handoff: Handoff, stateWrite: StateWrite, result: Result,
});
type StoredEvent = z.infer<typeof StoredEvent>;

/** The validated stored binding the caller supplies: the server's full
 * `ToolingOperationBinding` (as `readToolingOperation` projects it, with
 * `parentOperationId` and `retainedConsumerId` present, possibly null). */
export type NeonRecoveryResultBinding = Omit<ToolingOperationBinding, "status">;
/** Exactly the client's `NeonCommittedResult`: the operation identity, the
 * stable request (without the attempt's lock PID) and the committed result. */
export type NeonCommittedResult = {
  operation: { operationId: string; requestKey: string; inputDigest: string; taskId: string; sessionId: string; kind: typeof NeonRecoveryOperationKind; existingOperationId: string; resourceKey: string;
    release: { id: string; revision: string; tree: string } };
  request: Omit<z.infer<typeof ComputeNeonRecovery>, "lockPid">;
  result: z.infer<typeof Result>;
};

export async function readCommittedNeonRecovery(store: Pick<PrismaClient, "runtimeMetadataEvent" | "toolingStateWrite" | "toolingLegacyConsumer">, binding: NeonRecoveryResultBinding): Promise<{ sequence: number; committed: NeonCommittedResult } | null> {
  if (binding.kind !== NeonRecoveryOperationKind || binding.contract !== "remote-agent.tooling-operation/v1" || !binding.existingOperationId || !binding.resourceKey
    || binding.parentOperationId === undefined || binding.retainedConsumerId === undefined) {
    throw new NeonRecoveryResultUnverifiable("binding-invalid", `operation ${binding.operationId} is not a bound Neon recovery operation`);
  }
  const where = { runtimeSessionId: binding.sessionId, source: `compute:${binding.taskId}`, action: EVENT_ACTION };
  const rows = await store.runtimeMetadataEvent.findMany({ where, orderBy: { sequence: "asc" }, take: HISTORY_BOUND + 1 });
  if (rows.length > HISTORY_BOUND) throw new NeonRecoveryResultUnverifiable("history-bound", `more than ${HISTORY_BOUND} recovery events for task ${binding.taskId}`);
  // Every row is parsed strictly first: an unreadable row could be this
  // operation's, so it is never skipped.
  const parsed = rows.map(row => {
    let raw: unknown;
    try { raw = JSON.parse(row.value ?? "null"); } catch { throw new NeonRecoveryResultUnverifiable("event-unreadable", `event ${row.sequence} is not JSON`); }
    const value = StoredEvent.safeParse(raw);
    if (!value.success || row.runtimeSessionId !== where.runtimeSessionId || row.source !== where.source || row.action !== where.action) {
      throw new NeonRecoveryResultUnverifiable("event-unreadable", `event ${row.sequence} is not a readable recovery event`);
    }
    return { sequence: row.sequence, key: row.key, value: value.data };
  });
  // A row naming this operation anywhere is attributed to it.
  const names = (value: StoredEvent) => [value.operation.operationId, value.observer.operationId, value.result.observer.operationId, value.proof.operation.operationId].includes(binding.operationId);
  const mine = parsed.filter(row => names(row.value));
  if (!mine.length) return null;
  if (mine.length > 1) throw new NeonRecoveryResultUnverifiable("event-ambiguous", `${mine.length} recovery events name operation ${binding.operationId}`);
  const event = mine[0]!;
  if (parsed.some(row => row !== event && row.key === event.key)) throw new NeonRecoveryResultUnverifiable("event-ambiguous", `another recovery event shares transition key ${event.key}`);
  verify(event, binding);
  await verifyStoredRows(store, event, binding);
  const { value } = event, { lockPid: _pid, ...request } = value.request;
  return { sequence: event.sequence, committed: {
    operation: { operationId: binding.operationId, requestKey: binding.requestKey, inputDigest: binding.inputDigest, taskId: binding.taskId, sessionId: binding.sessionId, kind: NeonRecoveryOperationKind,
      existingOperationId: binding.existingOperationId, resourceKey: binding.resourceKey, release: { id: binding.release.id, revision: binding.release.revision, tree: binding.release.tree } },
    request, result: value.result } };
}

function verify(event: { sequence: number; key: string; value: StoredEvent }, binding: NeonRecoveryResultBinding) {
  const { value } = event, { request, proof, observer, result, operation } = value;
  const fail = (detail: string): never => { throw new NeonRecoveryResultUnverifiable("event-mismatch", `event ${event.sequence}: ${detail}`); };
  if (event.key !== journalKey(value.environment.id, value.resource.id, request)) fail("transition key does not derive from its request");
  // The stored binding is the caller's validated binding: every immutable
  // field, including the (possibly null) parent and the release record.
  const identity = (value: NeonRecoveryResultBinding | z.infer<typeof StoredOperation>) => ({ contract: value.contract, operationId: value.operationId, requestKey: value.requestKey, inputDigest: value.inputDigest,
    repositoryId: value.repositoryId, taskId: value.taskId, sessionId: value.sessionId, turnId: value.turnId, kind: value.kind, existingOperationId: value.existingOperationId,
    parentOperationId: value.parentOperationId, retainedConsumerId: value.retainedConsumerId, resourceKey: value.resourceKey, generation: value.generation,
    release: { id: value.release.id, repositoryId: value.release.repositoryId, revision: value.release.revision, tree: value.release.tree, policyBlob: value.release.policyBlob, checkout: value.release.checkout,
      manifest: finalizationDigest(value.release.manifest) } });
  if (finalizationDigest(identity(operation)) !== finalizationDigest(identity(binding))) fail("stored operation binding is not this operation");
  // The binding's input digest excludes only the attempt's lock PID.
  if (neonRecoveryInputDigest(request) !== binding.inputDigest || request.offerId !== binding.existingOperationId || request.resourceKey !== binding.resourceKey) fail("request is not the operation's input");
  if (proof.taskId !== binding.taskId || proof.primarySessionId !== binding.sessionId || proof.environmentId !== value.environment.id || proof.resourceId !== value.resource.id
    || proof.resourceKey !== request.resourceKey || proof.offerId !== request.offerId || proof.operationId !== request.operationId || proof.sourceRevision !== request.sourceRevision
    || proof.previousRecipeHash !== request.previousRecipeHash || proof.recipeHash !== request.recipeHash || proof.lockPid !== request.lockPid || proof.reconciliation.outcome !== request.outcome) fail("proof is not this request's");
  if (proof.operation.operationId !== binding.operationId || proof.operation.releaseId !== binding.release.id || proof.operation.revision !== binding.release.revision || proof.operation.tree !== binding.release.tree) fail("proof was not observed by the bound release");
  if (evidence(proof) !== value.evidence) fail("recorded evidence does not derive from its proof");
  if (proof.canonical !== "baseline" || proof.receiptSha256 !== proof.baselineSha256 || proof.candidateSha256 === proof.baselineSha256) fail("proof was not observed over the staged candidate with the canonical receipt at its baseline");
  if (observer.operationId !== binding.operationId || observer.releaseId !== binding.release.id || observer.revision !== binding.release.revision || observer.tree !== binding.release.tree
    || finalizationDigest(result.observer) !== finalizationDigest(observer)) fail("observer is not the bound release's");
  if (result.environmentId !== value.environment.id || result.resourceId !== value.resource.id || result.offerId !== value.offer.id || result.offerId !== request.offerId
    || result.operationId !== request.operationId || result.previousRecipeHash !== request.previousRecipeHash || result.recipeHash !== request.recipeHash || result.sourceRevision !== request.sourceRevision
    || result.outcome !== request.outcome || result.basis !== (proof.reconciliation.absence?.basis ?? "exact-owned-child") || result.reconciliationSha256 !== finalizationDigest(proof.reconciliation)) fail("result is not the committed transition's");
  if (finalizationDigest(result.stateWrite) !== finalizationDigest(value.stateWrite) || value.stateWrite.operationId !== binding.operationId || value.stateWrite.releaseId !== binding.release.id) fail("state write is not this operation's");
}

/** The exact rows the transaction wrote beside the event: the registered
 * drafted.runtime/2 write, and exactly the handed-off legacy rows (the set of
 * this task's rows resolved by this operation equals the recorded rows, each
 * with exact provenance and its snapshot unchanged). Bounded, read-only. */
async function verifyStoredRows(store: Pick<PrismaClient, "toolingStateWrite" | "toolingLegacyConsumer">, event: { sequence: number; value: StoredEvent }, binding: NeonRecoveryResultBinding) {
  const fail = (detail: string): never => { throw new NeonRecoveryResultUnverifiable("event-mismatch", `event ${event.sequence}: ${detail}`); };
  const { stateWrite, handoff } = event.value;
  const write = await store.toolingStateWrite.findUnique({ where: { sequence: stateWrite.sequence } });
  if (!write || write.repositoryId !== binding.repositoryId || write.taskId !== binding.taskId || write.family !== stateWrite.family || write.scopeKey !== stateWrite.scopeKey
    || write.version !== stateWrite.version || write.operationId !== binding.operationId || write.releaseId !== binding.release.id) fail(`state write ${stateWrite.sequence} is not the registered drafted.runtime/2 write of this operation`);
  if (handoff.operationId !== binding.operationId || handoff.taskId !== binding.taskId || handoff.environmentId !== event.value.environment.id || handoff.resourceId !== event.value.resource.id) {
    fail("handoff is not this operation's environment and resource");
  }
  const ids = handoff.rows.map(row => row.id);
  if (new Set(ids).size !== ids.length) fail("handoff names a legacy row twice");
  // Every legacy row of the task, bounded: the rows this operation resolved
  // must be exactly the recorded ones (no unrecorded or missing row).
  const rows = await store.toolingLegacyConsumer.findMany({ where: { repositoryId: binding.repositoryId, taskId: binding.taskId }, orderBy: { id: "asc" }, take: HANDOFF_BOUND + 1 });
  if (rows.length > HANDOFF_BOUND) throw new NeonRecoveryResultUnverifiable("history-bound", `more than ${HANDOFF_BOUND} legacy readers for task ${binding.taskId}`);
  const Resolution = z.object({ kind: z.string(), reference: z.string() }).passthrough();
  const resolvedHere = rows.filter(row => { const resolution = Resolution.safeParse(row.resolution).data; return resolution?.kind === HANDOFF_EVIDENCE_KIND && resolution.reference === binding.operationId; });
  if (resolvedHere.length !== ids.length || resolvedHere.some(row => !ids.includes(row.id))) fail("the legacy rows resolved by this operation are not exactly the recorded handoff");
  for (const entry of handoff.rows) {
    const row = resolvedHere.find(value => value.id === entry.id)!;
    if (row.status !== "resolved" || row.provenance !== "exact" || row.consumerKind !== entry.consumerKind || row.consumerId !== entry.consumerId || row.revision !== entry.revision || row.checkout !== entry.checkout) {
      fail(`legacy row ${entry.id} is not resolved by this operation with exact provenance and its recorded snapshot`);
    }
  }
}
