import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { canonicalDigest } from "./tooling-releases.ts";
import { planRuntimeCommandRetirement, retireRuntimeCommand } from "./runtime-command-retirement.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
const at = (day: number) => new Date(`2026-01-0${day}T00:00:00Z`);
const sha = "a".repeat(64), revision = "b".repeat(40), compute = { configurationFile: "/fixture/next.json", configurationSha256: sha };
async function fixture() {
  const p = db.prisma;
  await p.runtimeSession.create({ data: { id: "primary", scopeKey: "task", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture", status: "idle" } });
  const task = await p.remoteTask.create({ data: { id: "task", requestKey: "task", primarySessionId: "primary", repositoryId: "repo", machineId: "host", branchName: "codex/task", toolingRoot: "/tooling", toolingRevision: revision, phase: "working" } });
  const metadata = { recipeHash: "new", revision, compute, container: { id: "original" } };
  const resource = await p.remoteTaskResource.create({ data: { id: "resource", taskId: task.id, key: "runtime-development", kind: "task-runtime", purpose: "development", externalId: "/fixture/runtime.json", metadata } });
  const environment = await p.computeEnvironment.create({ data: { id: "environment", taskId: task.id, primarySessionId: "primary", machineId: "host", key: resource.key, purpose: "development", revision, recipeDigest: "new", taskIdentity: sha, resourceId: resource.id } });
  await p.computeOffer.create({ data: { id: "old-offer", environmentId: environment.id, machineId: "host", instructionId: "old-instruction", state: "stopped", dispatchDeadline: at(1), claimedAt: at(1), completedAt: at(3) } });
  const common = { taskId: task.id, sessionId: "primary", repositoryId: "repo", inputDigest: sha, generation: 1, releaseId: "release", protocol: 1 };
  await p.toolingOperation.create({ data: { ...common, id: "parent", requestKey: "parent", kind: "adapter-command", resourceKey: resource.key, status: "bound", turnId: "original-turn", createdAt: at(1) } });
  await p.toolingOperation.create({ data: { ...common, id: "child", requestKey: "child", kind: "compute-admission", status: "running", parentOperationId: "parent", existingOperationId: "old-offer", createdAt: at(1) } });
  await p.runtimeLifecycleEvent.create({ data: { id: "original-ended", runtimeSessionId: "primary", requestId: "original-turn", phase: "completed", occurredAt: at(2) } });
  await p.toolingOperation.create({ data: { ...common, id: "successor", requestKey: "successor", kind: "adapter-command", resourceKey: resource.key, status: "completed", createdAt: at(3), completionEvidence: { kind: "command-completed", reference: "successor" } } });
  await p.toolingOperation.create({ data: { ...common, id: "configure", requestKey: "configure", kind: "compute-configure", status: "completed", parentOperationId: "successor", existingOperationId: "old-offer", createdAt: at(3) } });
  const reader = { repositoryId: "repo", taskId: task.id, consumerKind: "compute-environment", consumerId: environment.id, scopeKey: "task", releaseId: "release", generation: 1, protocol: 1,
    status: "resolved", confirmedAt: at(1), resolvedAt: at(3) };
  await p.toolingRetainedConsumer.create({ data: { ...reader, id: "old-reader", operationId: "child", evidence: { kind: "compute-bind", reference: "old-offer" }, resolution: { kind: "superseded", reference: "new-reader" } } });
  await p.toolingRetainedConsumer.create({ data: { ...reader, id: "new-reader", operationId: "configure", evidence: { kind: "compute-configure", reference: "old-offer" }, resolution: { kind: "stopped", reference: environment.id } } });
  await p.toolingStateWrite.create({ data: { repositoryId: "repo", taskId: task.id, operationId: "parent", releaseId: "release", family: "drafted.runtime", scopeKey: resource.key, version: 1, preservesUnknown: true, createdAt: at(1) } });
  const event = (action: string, key: string, value: unknown, source = `tooling-operation:${task.id}`) => p.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source, action, key, value: JSON.stringify(value), occurredAt: at(3) } });
  const attempt = (id: string, state: string) => event("tooling-operation-association", `outcome:${id}`, { version: 1, role: "outcome", operationId: id, inputDigest: sha, attemptId: `${id}-attempt`,
    route: `POST /api/tasks/:taskId/${id === "child" ? "compute-bind" : "compute-configure"}`, state, status: state === "acknowledged" ? 200 : null });
  await attempt("child", "intent"); const oldOutcome = await attempt("child", "acknowledged");
  await attempt("configure", "intent");
  const transition = await event("compute-runtime-configuration", "transition", { version: 1, taskIdentity: sha, environment: { ...environment, recipeDigest: "old" }, resource: { ...resource, metadata: { ...metadata, recipeHash: "old" } },
    proof: { version: 1, taskId: task.id, primarySessionId: "primary", environmentId: environment.id, resourceId: resource.id, offerId: "old-offer", revision, previousRecipeHash: "old", recipeHash: "new", stopped: true, compute },
    compute, baselineFile: "/fixture/baseline.json", stoppedObservation: { state: "stopped", taskId: task.id, primarySessionId: "primary", environmentId: environment.id, resourceId: resource.id, revision, recipeDigest: "new", configurationDigest: sha } }, `compute:${task.id}`);
  const commit = await event("configuration-attempt-committed", "configure:configure-attempt", { version: 1, operationId: "configure", parentOperationId: "successor", inputDigest: sha, attemptId: "configure-attempt", requestDigest: sha, transitionKey: "transition", environmentId: environment.id, readerId: "new-reader" });
  await attempt("configure", "acknowledged");
  await event("tooling-operation-association", `producer:compute-environment:${environment.id}`, { version: 1, role: "producer", operationId: "configure", state: "confirmed" });
  const input = { task, environment, parentId: "parent", admittingCommandId: "successor", admissionSequence: 1000, offerCreatedAt: at(4) };
  return { p, input, event, attempt, oldOutcome, transition, commit, resource };
}

test("retirement records supersession, preserves failed history and never claims command success", async () => {
  const f = await fixture(), original = await f.p.runtimeMetadataEvent.findMany();
  const result = await planRuntimeCommandRetirement(f.p, f.input);
  expect("plan" in result).toBe(true); if (!("plan" in result)) throw new Error(result.reason);
  expect((await f.p.toolingOperation.findUniqueOrThrow({ where: { id: "parent" } })).status).toBe("bound");
  await f.p.$transaction(async tx => { await retireRuntimeCommand(tx, result.plan); });
  expect((await f.p.toolingOperation.findUniqueOrThrow({ where: { id: "parent" } })).completionEvidence).toEqual({ kind: "runtime-command-superseded", reference: "successor" });
  expect((await f.p.toolingOperation.findUniqueOrThrow({ where: { id: "child" } })).completionEvidence).toEqual({ kind: "callback-acknowledged", reference: "parent" });
  expect(await f.p.runtimeMetadataEvent.findMany({ where: { sequence: { in: original.map(row => row.sequence) } } })).toEqual(original);
  expect(await f.p.runtimeMetadataEvent.count({ where: { action: "runtime-command-retired" } })).toBe(1);
});

for (const fault of ["unknown-parent", "unknown-child", "active-turn", "missing-turn", "late-turn", "unsuccessful-successor", "foreign-child", "nested-child", "unrelated-child", "unknown-attempt", "inflight-attempt", "duplicate-outcome", "late-callback", "later-write", "other-state-family", "child-state-write", "active-reader", "foreign-reader", "cyclic-reader", "changed-recipe", "changed-resource", "changed-proof", "changed-commit", "running-offer", "late-stop", "missing-commit"] as const)
test(`refuses retirement with ${fault}`, async () => {
  const f = await fixture(), p = f.p;
  if (fault === "unknown-parent") await p.toolingOperation.update({ where: { id: "parent" }, data: { status: "unknown" } });
  if (fault === "unknown-child") await p.toolingOperation.update({ where: { id: "child" }, data: { status: "unknown" } });
  if (fault === "active-turn") await p.runtimeLifecycleEvent.update({ where: { id: "original-ended" }, data: { phase: "started" } });
  if (fault === "missing-turn") await p.toolingOperation.update({ where: { id: "parent" }, data: { turnId: null } });
  if (fault === "late-turn") await p.runtimeLifecycleEvent.update({ where: { id: "original-ended" }, data: { occurredAt: at(4) } });
  if (fault === "unsuccessful-successor") await p.toolingOperation.update({ where: { id: "successor" }, data: { completionEvidence: { kind: "no-effect", reference: "successor" } } });
  if (fault === "foreign-child") await p.toolingOperation.update({ where: { id: "child" }, data: { taskId: "foreign" } });
  if (fault === "nested-child") { const { completionEvidence: _evidence, ...child } = await p.toolingOperation.findUniqueOrThrow({ where: { id: "child" } }); await p.toolingOperation.create({ data: { ...child, id: "nested", requestKey: "nested", parentOperationId: "child" } }); }
  if (fault === "unrelated-child") await p.toolingOperation.update({ where: { id: "child" }, data: { kind: "finalization" } });
  if (fault === "unknown-attempt") await p.runtimeMetadataEvent.update({ where: { sequence: f.oldOutcome.sequence }, data: { value: JSON.stringify({ ...JSON.parse(f.oldOutcome.value!), state: "unknown" }) } });
  if (fault === "inflight-attempt") await p.runtimeMetadataEvent.delete({ where: { sequence: f.oldOutcome.sequence } });
  if (fault === "duplicate-outcome" || fault === "late-callback") await f.attempt("child", "acknowledged");
  const write = await p.toolingStateWrite.findFirstOrThrow();
  if (fault === "later-write") await p.toolingStateWrite.update({ where: { sequence: write.sequence }, data: { createdAt: at(4) } });
  if (fault === "other-state-family") await p.toolingStateWrite.update({ where: { sequence: write.sequence }, data: { family: "unrelated" } });
  if (fault === "child-state-write") await p.toolingStateWrite.update({ where: { sequence: write.sequence }, data: { operationId: "child" } });
  if (fault === "active-reader") await p.toolingRetainedConsumer.update({ where: { id: "old-reader" }, data: { status: "confirmed" } });
  if (fault === "foreign-reader") await p.toolingRetainedConsumer.update({ where: { id: "old-reader" }, data: { consumerId: "foreign" } });
  if (fault === "cyclic-reader") await p.toolingRetainedConsumer.update({ where: { id: "new-reader" }, data: { resolution: { kind: "superseded", reference: "old-reader" } } });
  if (fault === "changed-recipe") f.input.environment.recipeDigest = "foreign";
  if (fault === "changed-resource") await p.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), container: { id: "replacement" } } } });
  if (fault === "changed-proof") { const value = JSON.parse(f.transition.value!); value.proof.resourceId = "foreign"; await p.runtimeMetadataEvent.update({ where: { sequence: f.transition.sequence }, data: { value: JSON.stringify(value) } }); }
  if (fault === "changed-commit") { const value = JSON.parse(f.commit.value!); value.requestDigest = canonicalDigest("changed"); await p.runtimeMetadataEvent.update({ where: { sequence: f.commit.sequence }, data: { value: JSON.stringify(value) } }); }
  if (fault === "running-offer") await p.computeOffer.update({ where: { id: "old-offer" }, data: { state: "running" } });
  if (fault === "late-stop") await p.computeOffer.update({ where: { id: "old-offer" }, data: { completedAt: at(4) } });
  if (fault === "missing-commit") await p.runtimeMetadataEvent.delete({ where: { sequence: f.commit.sequence } });
  const result = await planRuntimeCommandRetirement(p, f.input);
  expect("reason" in result).toBe(true);
  expect(await p.runtimeMetadataEvent.count({ where: { action: "runtime-command-retired" } })).toBe(0);
  expect((await p.toolingOperation.findUniqueOrThrow({ where: { id: "parent" } })).completionEvidence).toBeNull();
});

test("changed command cancels the whole retirement transaction", async () => {
  const f = await fixture(), result = await planRuntimeCommandRetirement(f.p, f.input);
  if (!("plan" in result)) throw new Error(result.reason);
  await f.p.toolingOperation.update({ where: { id: "child" }, data: { status: "unknown" } });
  await expect(f.p.$transaction(tx => retireRuntimeCommand(tx, result.plan))).rejects.toThrow("changed during retirement");
  expect((await f.p.toolingOperation.findUniqueOrThrow({ where: { id: "parent" } })).status).toBe("bound");
  expect(await f.p.runtimeMetadataEvent.count({ where: { action: "runtime-command-retired" } })).toBe(0);
});
