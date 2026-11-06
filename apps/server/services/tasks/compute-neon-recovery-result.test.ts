import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { requestCompute } from "./compute-admission.ts";
import { canonicalSha256, type ComputeNeonRecoveryProof, neonRecoveryInputDigest, recoverComputeNeon, type BoundToolingOperation } from "./compute-neon-recovery.ts";
import { NeonRecoveryResultUnverifiable, readCommittedNeonRecovery } from "./compute-neon-recovery-result.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import type { ToolingOperationBinding } from "../../../../types/tooling-release.ts";

let db: TestDatabase;
const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: true, slots: 2 }) });
const head = "22406a5eddb33f983a669f8f686b9a416beac113", revision = "a".repeat(40), pin = "d".repeat(40), oldHash = "b".repeat(64), nextHash = "c".repeat(64);
const release = { id: "tr_release_b", repositoryId: "repo", revision: "9".repeat(40), tree: "6".repeat(40), checkout: "/install/tooling/repo/release-b" };
/** The server's full release record, as readToolingOperation projects it. */
const fullRelease = { ...release, policyBlob: "4".repeat(40), manifest: { schemaVersion: 1, serverProtocol: { min: 1, max: 1 } } } as unknown as ToolingOperationBinding["release"];
// Database setup applies every migration; keep it bounded but tolerant of host load.
setDefaultTimeout(60_000);
beforeEach(async () => { db = await createTestDatabase(); }, 60_000);
afterEach(async () => { await db.cleanup(); }, 60_000);

/** The client's `NeonCommittedResult` (Drafted runtime-neon-transition.ts), strictly. */
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Revision = z.string().regex(/^[a-f0-9]{40}$/), Id = z.string().min(1);
const ClientCommittedResult = z.strictObject({
  operation: z.strictObject({ operationId: Id, requestKey: Id, inputDigest: Sha, taskId: Id, sessionId: Id, kind: z.literal("compute-neon-recovery"), existingOperationId: z.uuid(),
    resourceKey: z.string().min(1), release: z.strictObject({ id: Id, revision: Revision, tree: Revision }) }),
  request: z.record(z.string(), z.unknown()),
  result: z.strictObject({ environmentId: z.uuid(), resourceId: Id, resourceIdentity: Sha, offerId: z.uuid(), operationId: z.uuid(), previousRecipeHash: Sha, recipeHash: Sha, sourceRevision: Revision,
    outcome: z.enum(["absent", "owned"]), basis: z.enum(["provider-rejection", "complete-inventory", "legacy-provider-rejection", "exact-owned-child"]), reconciliationSha256: Sha,
    observer: z.strictObject({ operationId: Id, releaseId: Id, revision: Revision, tree: Revision, adapterSha256: Sha }), allocation: z.enum(["retained-existing-claim", "previously-stopped-await-normal-admission"]),
    // Staged design 551400d9 §7: the acknowledgment's REQUIRED state write.
    stateWrite: z.strictObject({ family: z.literal("drafted.runtime"), scopeKey: z.literal("runtime-development"), version: z.literal(2), operationId: Id, releaseId: Id, sequence: z.number().int().positive() }) }),
});
/** Planned staged evidence (design 551400d9 §7: evidence() gains candidateSha256). */
const stagedEvidence = (proof: any) => {
  const { baselineSha256, candidateSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision } = proof;
  return finalizationDigest({ baselineSha256, candidateSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision });
};

/** One container-less runtime with a retained claim, recovered through the
 * real writer (`recoverComputeNeon`) with a fixed observation. */
async function committed(ids = { task: "task", primary: "primary", operation: "op-recovery", slot: "host:0" }) {
  const worktree = `/fixture/${ids.task}`;
  const saved = { provider: "planetscale" as const, id: `ps-${ids.task}`, name: `drafted-${ids.task}` };
  await db.prisma.runtimeSession.create({ data: { id: ids.primary, scopeKey: ids.task, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: worktree, status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: ids.task, requestKey: ids.task, repositoryId: "repo", machineId: "host", branchName: `codex/${ids.task}`, worktreePath: worktree, toolingRoot: "/fixture/tooling", toolingRevision: pin, primarySessionId: ids.primary, phase: "working" } });
  const environment = await requestCompute({ prisma: db.prisma, config, machineId: "host", policy: config.compute!, taskId: ids.task, request: { key: "runtime-development", purpose: "development", revision, recipeDigest: oldHash } });
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: ids.task, key: environment.key, kind: "task-runtime", purpose: "development", externalId: `/private/${ids.task}/runtime.json`, state: "failed",
    metadata: { recipeHash: oldHash, revision, providers: [saved], observed: "failed" } } });
  const offer = await db.prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: environment.id, machineId: "host", instructionId: `historical-offer:${ids.task}`, dispatchDeadline: new Date(), state: "unknown", claimedAt: new Date(Date.now() - 3_600_000) } });
  await db.prisma.computeSlot.create({ data: { id: ids.slot, ordinal: Number(ids.slot.split(":")[1]), machineId: "host", allocationId: offer.id } });
  await db.prisma.computeWait.deleteMany({ where: { environmentId: environment.id } });
  await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { state: "unknown", resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest } });
  const computeOperation = crypto.randomUUID();
  const request = { offerId: offer.id, operationId: computeOperation, resourceKey: environment.key, previousRecipeHash: oldHash, recipeHash: nextHash, baselineFile: `/private/${ids.task}/baseline.json`, lockPid: 4242, outcome: "absent" as const, sourceRevision: head };
  const operation: BoundToolingOperation = { contract: "remote-agent.tooling-operation/v1", operationId: ids.operation, requestKey: `neon-recovery-${ids.task}`, inputDigest: neonRecoveryInputDigest(request),
    repositoryId: "repo", taskId: ids.task, sessionId: ids.primary, kind: "compute-neon-recovery", existingOperationId: offer.id, resourceKey: environment.key, generation: 5, release: { ...release } };
  const attempt = { version: 1 as const, name: saved.name, projectId: "spatial-project", templateBranchId: "br-template", parentLsn: "0/1A2B3C4", requestedAt: "2026-11-04T10:01:00.000Z", expiresAt: "2026-11-11T10:01:00.000Z",
    rejection: { status: 422, code: "BRANCHES_LIMIT_EXCEEDED", observedAt: "2026-11-04T10:01:01.000Z" } };
  const proof: ComputeNeonRecoveryProof = { version: 1, contract: "runtime-neon-recovery/v1", transition: "neon-template-child", taskId: ids.task, primarySessionId: ids.primary, toolingRevision: pin,
    environmentId: environment.id, resourceId: resource.id, resourceKey: environment.key, offerId: offer.id, operationId: computeOperation, revision, sourceRevision: head,
    previousRecipeHash: oldHash, recipeHash: nextHash, receiptSha256: "1".repeat(64), baselineSha256: "2".repeat(64), lockSha256: "3".repeat(64), lockPid: 4242,
    stage: { phase: "failed", pending: null, setupComplete: false, schemaApplied: false, fixturesComplete: false, spatialSchema: false, container: false, containerOperation: false, configuration: false, coverage: false, startBundle: false },
    baselineProviders: [saved], providers: [saved],
    reconciliation: { operation: "create-neon", outcome: "absent", name: saved.name, projectId: "spatial-project", observedAt: "2026-11-05T09:00:00.000Z", attempt, absence: { basis: "provider-rejection" } },
    baselineNeonCreateSha256: canonicalSha256(attempt), operation: { operationId: ids.operation, releaseId: release.id, revision: release.revision, tree: release.tree } };
  const observer = { operationId: ids.operation, releaseId: release.id, revision: release.revision, tree: release.tree, adapterSha256: "8".repeat(64) };
  const written = await recoverComputeNeon({ prisma: db.prisma, config, taskId: ids.task, request, operation }, async () => ({ proof: structuredClone(proof), observer: { ...observer } }), async () => head);
  const original = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-neon-recovery", source: `compute:${ids.task}` } });
  // The foundation writer predates the staged design: the same transaction's
  // planned rows and fields (S5 handoff, S6 drafted.runtime/2, S6b event) are
  // added here exactly as designed, keeping the writer's own key and values.
  const write = await db.prisma.toolingStateWrite.create({ data: { repositoryId: "repo", taskId: ids.task, family: "drafted.runtime", scopeKey: "runtime-development", version: 2, preservesUnknown: true, operationId: ids.operation, releaseId: release.id } });
  const legacy = await db.prisma.toolingLegacyConsumer.create({ data: { id: `legacy-${ids.task}`, repositoryId: "repo", taskId: ids.task, consumerKind: "compute-environment", consumerId: environment.id, provenance: "first-bootstrap",
    revision: pin, checkout: "/fixture/tooling", status: "resolved", resolution: { kind: "compute-neon-recovery", reference: ids.operation }, resolvedAt: new Date() } });
  const stateWrite = { family: "drafted.runtime" as const, scopeKey: "runtime-development" as const, version: 2 as const, operationId: ids.operation, releaseId: release.id, sequence: write.sequence };
  const result = { ...written, stateWrite };
  const value = JSON.parse(original.value!);
  value.proof = { ...value.proof, candidateSha256: "4".repeat(64), candidateVersion: 2, canonical: "baseline" };
  value.evidence = stagedEvidence(value.proof);
  value.handoff = { legacyRows: [{ id: legacy.id, consumerKind: legacy.consumerKind, consumerId: legacy.consumerId, revision: legacy.revision, checkout: legacy.checkout }] };
  value.stateWrite = stateWrite; value.result = result;
  // The service records the full stored binding (parent explicitly null for a root operation).
  const binding: ToolingOperationBinding = { ...operation, turnId: null, parentOperationId: null, retainedConsumerId: null, release: fullRelease, status: "running" };
  value.operation = binding;
  const event = await db.prisma.runtimeMetadataEvent.update({ where: { sequence: original.sequence }, data: { value: JSON.stringify(value) } });
  return { request, operation: binding, result, event, write, legacy };
}
const read = (operation: Parameters<typeof readCommittedNeonRecovery>[1]) => readCommittedNeonRecovery(db.prisma, operation);
/** Test-only tampering of the stored event's JSON value. */
async function rewrite(sequence: number, change: (value: any) => void) {
  const row = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence } });
  const value = JSON.parse(row.value!); change(value);
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence }, data: { value: JSON.stringify(value) } });
}
const unverifiable = async (promise: Promise<unknown>, reason: string) => {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(NeonRecoveryResultUnverifiable);
  expect((error as NeonRecoveryResultUnverifiable).reason).toBe(reason as NeonRecoveryResultUnverifiable["reason"]);
};

test("returns the real writer's exact committed result in the client's strict shape, without the lock PID", async () => {
  const f = await committed();
  const all = async () => db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const before = await all();
  const found = await read(f.operation);
  expect(found?.sequence).toBe(f.event.sequence);
  const { lockPid: _pid, ...stable } = f.request;
  expect(found?.committed).toEqual({ operation: { operationId: "op-recovery", requestKey: f.operation.requestKey, inputDigest: f.operation.inputDigest, taskId: "task", sessionId: "primary",
    kind: "compute-neon-recovery", existingOperationId: f.request.offerId, resourceKey: "runtime-development", release: { id: release.id, revision: release.revision, tree: release.tree } }, request: stable, result: f.result });
  expect(ClientCommittedResult.parse(found!.committed)).toEqual(found!.committed);
  // A full stored binding with server-only fields and a parent reads the same.
  expect((await read({ ...f.operation, parentOperationId: null }))?.committed).toEqual(found!.committed);
  // Pure: nothing written.
  expect(await all()).toEqual(before);
});

test("null only when the operation genuinely committed nothing", async () => {
  await committed();
  const other = { contract: "remote-agent.tooling-operation/v1" as const, operationId: "op-never-committed", requestKey: "k", inputDigest: "e".repeat(64), repositoryId: "repo", taskId: "task", sessionId: "primary", turnId: null,
    kind: "compute-neon-recovery", existingOperationId: crypto.randomUUID(), parentOperationId: null, retainedConsumerId: null, resourceKey: "runtime-development", generation: 5, release: fullRelease };
  expect(await read(other)).toBeNull();
  // Another task's history is not this task's: its own scan is empty.
  expect(await read({ ...other, taskId: "elsewhere" })).toBeNull();
});

test("a retry holding a different lock PID still matches; any other request field does not", async () => {
  const f = await committed();
  await rewrite(f.event.sequence, value => { value.request.lockPid = 9999; value.proof.lockPid = 9999; });
  expect((await read(f.operation))?.committed.request).toEqual((({ lockPid: _pid, ...stable }) => stable)(f.request));
  await rewrite(f.event.sequence, value => { value.request.baselineFile = "/private/other/baseline.json"; });
  await unverifiable(read(f.operation), "event-mismatch");
});

test.each([
  ["requestKey", { requestKey: "other" }], ["inputDigest", { inputDigest: "f".repeat(64) }], ["generation", { generation: 6 }], ["existingOperationId", { existingOperationId: crypto.randomUUID() }],
  ["resourceKey", { resourceKey: "runtime-preview" }], ["repositoryId", { repositoryId: "other-repo" }], ["release id", { release: { ...fullRelease, id: "tr_other" } }],
  ["release revision", { release: { ...fullRelease, revision: "7".repeat(40) } }], ["release tree", { release: { ...fullRelease, tree: "5".repeat(40) } }], ["release checkout", { release: { ...fullRelease, checkout: "/elsewhere" } }],
  ["release policy", { release: { ...fullRelease, policyBlob: "3".repeat(40) } }], ["release manifest", { release: { ...fullRelease, manifest: { schemaVersion: 2 } as any } }],
  ["parent", { parentOperationId: "op-command" }], ["turn", { turnId: "turn-1" }], ["retained consumer", { retainedConsumerId: "consumer-1" }],
] as const)("binding %s mismatch is unverifiable, never null", async (_name, change) => {
  const f = await committed();
  await unverifiable(read({ ...f.operation, ...change }), "event-mismatch");
});

test("a binding that is not a bound Neon recovery operation is refused before any read", async () => {
  const f = await committed();
  await unverifiable(read({ ...f.operation, kind: "compute-admission" }), "binding-invalid");
  await unverifiable(read({ ...f.operation, resourceKey: null }), "binding-invalid");
  // A projection without its (possibly null) parent is never accepted as a root operation.
  const { parentOperationId: _parent, ...withoutParent } = f.operation;
  await unverifiable(read(withoutParent), "binding-invalid");
});

test.each<[string, (value: any) => void]>([
  ["recipe hash", value => { value.request.recipeHash = "9".repeat(64); value.proof.recipeHash = "9".repeat(64); value.result.recipeHash = "9".repeat(64); }],
  ["evidence", value => { value.evidence = "0".repeat(64); }],
  ["proof stage", value => { value.proof.stage.phase = "preparing"; }],
  ["proof release", value => { value.proof.operation.tree = "5".repeat(40); }],
  ["observer", value => { value.observer.adapterSha256 = "7".repeat(64); }],
  ["result offer", value => { value.result.offerId = crypto.randomUUID(); }],
  ["result basis", value => { value.result.basis = "complete-inventory"; }],
  ["result reconciliation", value => { value.result.reconciliationSha256 = "0".repeat(64); }],
  ["result outcome", value => { value.result.outcome = "owned"; }],
  ["environment", value => { value.environment.id = crypto.randomUUID(); }],
])("stored %s tampering is unverifiable, never null", async (_name, change) => {
  const f = await committed();
  await rewrite(f.event.sequence, change);
  await unverifiable(read(f.operation), "event-mismatch");
});

test("a transition key that does not derive from the stored request is unverifiable", async () => {
  const f = await committed();
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.event.sequence }, data: { key: "0".repeat(64) } });
  await unverifiable(read(f.operation), "event-mismatch");
});

test.each<[string, (value: any) => string]>([
  ["non-JSON", () => "{not json"],
  ["unknown top-level field", value => JSON.stringify({ ...value, extra: {} })],
  ["missing result", ({ result: _r, ...value }) => JSON.stringify(value)],
])("an unreadable recovery event (%s) fails closed even if it names another operation", async (_name, make) => {
  const f = await committed();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "compute:task", action: "compute-neon-recovery", key: "1".repeat(64),
    value: make({ ...JSON.parse(f.event.value!), operation: { ...f.operation, operationId: "op-other" } }) } });
  await unverifiable(read(f.operation), "event-unreadable");
});

test("two events naming the operation, or a second event under its transition key, are ambiguous", async () => {
  const f = await committed();
  const copy = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "compute:task", action: "compute-neon-recovery", key: "1".repeat(64), value: f.event.value } });
  await unverifiable(read(f.operation), "event-ambiguous");
  // Another operation's event under the same transition key.
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: copy.sequence }, data: { key: f.event.key, value: JSON.stringify({ ...JSON.parse(f.event.value!),
    operation: { ...f.operation, operationId: "op-other" }, observer: { ...JSON.parse(f.event.value!).observer, operationId: "op-other" },
    result: { ...JSON.parse(f.event.value!).result, observer: { ...JSON.parse(f.event.value!).observer, operationId: "op-other" } },
    proof: { ...JSON.parse(f.event.value!).proof, operation: { ...JSON.parse(f.event.value!).proof.operation, operationId: "op-other" } } }) } });
  await unverifiable(read(f.operation), "event-ambiguous");
});

test("another task's valid event is independent; a history past its bound refuses", async () => {
  const f = await committed();
  const g = await committed({ task: "task-2", primary: "primary-2", operation: "op-recovery-2", slot: "host:1" });
  expect((await read(g.operation))?.sequence).toBe(g.event.sequence);
  expect((await read(f.operation))?.sequence).toBe(f.event.sequence);
  await db.prisma.runtimeMetadataEvent.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({ runtimeSessionId: "primary", source: "compute:task", action: "compute-neon-recovery", key: `filler-${index}`, value: "{}" })) });
  await unverifiable(read(f.operation), "history-bound");
});

test("the result's state write must be the exact stored drafted.runtime/2 row of this operation", async () => {
  const f = await committed();
  for (const [field, value] of [["version", 1], ["operationId", "op-other"], ["releaseId", "tr_other"], ["family", "drafted.other"], ["scopeKey", "runtime-review"], ["taskId", "elsewhere"], ["repositoryId", "other-repo"]] as const) {
    await db.prisma.toolingStateWrite.update({ where: { sequence: f.write.sequence }, data: { [field]: value } });
    await unverifiable(read(f.operation), "event-mismatch");
    await db.prisma.toolingStateWrite.update({ where: { sequence: f.write.sequence }, data: { [field]: (f.write as any)[field] } });
  }
  expect((await read(f.operation))?.committed.result.stateWrite.sequence).toBe(f.write.sequence);
  await db.prisma.toolingStateWrite.delete({ where: { sequence: f.write.sequence } });
  await unverifiable(read(f.operation), "event-mismatch");
});

test.each<[string, (value: any) => void, string]>([
  ["result state write differs from the event's", value => { value.result.stateWrite.sequence += 1; }, "event-mismatch"],
  ["event state write names another operation", value => { value.stateWrite.operationId = "op-other"; value.result.stateWrite.operationId = "op-other"; }, "event-mismatch"],
  ["state write version 1", value => { value.stateWrite.version = 1; value.result.stateWrite.version = 1; }, "event-unreadable"],
  ["result without its state write", value => { delete value.result.stateWrite; }, "event-unreadable"],
  ["event without its handoff", value => { delete value.handoff; }, "event-unreadable"],
  ["proof without its candidate", value => { delete value.proof.candidateSha256; }, "event-unreadable"],
  ["candidate version 1", value => { value.proof.candidateVersion = 1; }, "event-unreadable"],
  ["candidate digest without matching evidence", value => { value.proof.candidateSha256 = "5".repeat(64); }, "event-mismatch"],
  ["first commit observed over a published candidate", value => { value.proof.canonical = "candidate"; }, "event-mismatch"],
  ["candidate equal to the baseline", value => { value.proof.candidateSha256 = value.proof.baselineSha256; value.evidence = stagedEvidence(value.proof); }, "event-mismatch"],
  ["handoff row twice", value => { value.handoff.legacyRows.push(value.handoff.legacyRows[0]); }, "event-mismatch"],
  ["handoff row with an extra field", value => { value.handoff.legacyRows[0].extra = 1; }, "event-unreadable"],
  ["handoff snapshot revision", value => { value.handoff.legacyRows[0].revision = "e".repeat(40); }, "event-mismatch"],
])("staged fields: %s", async (_name, change, reason) => {
  const f = await committed();
  await rewrite(f.event.sequence, change);
  await unverifiable(read(f.operation), reason);
});

test("each handed-off legacy row must be resolved by this operation with its snapshot unchanged", async () => {
  const f = await committed();
  for (const data of [{ status: "retained" }, { resolution: { kind: "compute-neon-recovery", reference: "op-other" } }, { resolution: { kind: "compute-bind", reference: "op-recovery" } }, { checkout: "/elsewhere" }, { consumerId: "other-environment" }, { taskId: "elsewhere" }]) {
    await db.prisma.toolingLegacyConsumer.update({ where: { id: f.legacy.id }, data });
    await unverifiable(read(f.operation), "event-mismatch");
    await db.prisma.toolingLegacyConsumer.update({ where: { id: f.legacy.id }, data: { status: f.legacy.status, resolution: f.legacy.resolution as object, checkout: f.legacy.checkout, consumerId: f.legacy.consumerId, taskId: f.legacy.taskId } });
  }
  expect(await read(f.operation)).not.toBeNull();
  await db.prisma.toolingLegacyConsumer.delete({ where: { id: f.legacy.id } });
  await unverifiable(read(f.operation), "event-mismatch");
  // A group that had no legacy rows hands off none.
  await rewrite(f.event.sequence, value => { value.handoff.legacyRows = []; });
  expect((await read(f.operation))?.committed.result.stateWrite.sequence).toBe(f.write.sequence);
});

test.each<[string, (value: any) => void]>([
  ["without its parent", value => { delete value.operation.parentOperationId; }],
  ["as the route's admitted subset", value => { for (const key of ["turnId", "retainedConsumerId", "status"]) delete value.operation[key]; delete value.operation.release.manifest; delete value.operation.release.policyBlob; }],
  ["with an extra field", value => { value.operation.extra = 1; }],
  ["with an extra release field", value => { value.operation.release.extra = 1; }],
])("a stored binding %s is unreadable, never accepted", async (_name, change) => {
  const f = await committed();
  await rewrite(f.event.sequence, change);
  await unverifiable(read(f.operation), "event-unreadable");
});

test("a command-parented operation must match its recorded parent exactly", async () => {
  const f = await committed();
  await rewrite(f.event.sequence, value => { value.operation.parentOperationId = "op-command"; });
  expect((await read({ ...f.operation, parentOperationId: "op-command" }))?.sequence).toBe(f.event.sequence);
  await unverifiable(read(f.operation), "event-mismatch");
  await unverifiable(read({ ...f.operation, parentOperationId: "op-other-command" }), "event-mismatch");
});
