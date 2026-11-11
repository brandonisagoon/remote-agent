import { afterEach, expect, test } from "bun:test";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { bindToolingOperation, canonicalDigest, readToolingOperation } from "./tooling-releases.ts";
import { configurationRefusalContinuationAllows, repairConfigurationRefusal } from "./configuration-refusal-repair.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const manifest = { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 3, max: 3 }, stateFormats: { "drafted.runtime": { read: [1], write: 1, preservesUnknown: false } } };

async function fixture() {
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const prisma = db.prisma, config = testConfig({ machine: "host" }), runtime = createFakeAgentRuntime();
  runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/original/worktree", status: "idle" } });
  await prisma.remoteTask.create({ data: { id: "task", requestKey: "task", primarySessionId: "primary", repositoryId: "repo", machineId: "host", branchName: "original", worktreePath: "/original/worktree", toolingRoot: "/original/tooling", toolingRevision: "a".repeat(40), ownerPaused: true, phase: "blocked" } });
  for (const [id, revision] of [["old", "a".repeat(40)], ["fixed", "b".repeat(40)]]) await prisma.toolingRelease.create({ data: {
    id: id!, revision: revision!, repositoryId: "repo", tree: "c".repeat(40), policyBlob: "d".repeat(40), checkout: "/install/" + id, manifest, lockfileDigest: "e".repeat(64), bunVersion: "1.3.14" } });
  await prisma.toolingSelection.create({ data: { repositoryId: "repo", releaseId: "fixed", generation: 5, activatedAt: new Date() } });
  await prisma.toolingOperation.create({ data: { id: "original", taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: "original-key", inputDigest: "1".repeat(64), kind: "adapter-command", resourceKey: "runtime-development", releaseId: "old", generation: 4, protocol: 3 } });
  await prisma.toolingStateWrite.create({ data: { taskId: "task", repositoryId: "repo", operationId: "original", releaseId: "old", family: "drafted.runtime", scopeKey: "runtime-development", version: 1, preservesUnknown: false } });
  const environmentId = "00000000-0000-4000-8000-000000000001", offerId = "00000000-0000-4000-8000-000000000002";
  const resource = await prisma.remoteTaskResource.create({ data: { id: "runtime", taskId: "task", key: "runtime-development", kind: "task-runtime", purpose: "development", externalId: "/private/state/runtimes/task/development/runtime.json", state: "failed" } });
  await prisma.computeEnvironment.create({ data: { id: environmentId, taskId: "task", primarySessionId: "primary", machineId: "host", key: "runtime-development", purpose: "development", revision: "a".repeat(40), recipeDigest: "4".repeat(64), taskIdentity: "5".repeat(64), resourceId: resource.id, state: "running" } });
  await prisma.computeOffer.create({ data: { id: offerId, environmentId, machineId: "host", instructionId: "offer-instruction", dispatchDeadline: new Date(Date.now()+60000), state: "running", expiresAt: new Date(Date.now()+60000), claimedAt: new Date() } });
  const request = { requestKey: "repair-once", operationId: "original", expectedInputDigest: "1".repeat(64), expectedGeneration: 5,
    values: { task: "task", config: "/private/scenario.json", "state-directory": "/private/state", purpose: "development" as const } };
  const input = { prisma, config, runtime, taskId: "task", repositoryId: "repo", request };
  const observe = async (_release: unknown, value: unknown) => {
    const v = value as { owner: unknown; operationId: string; inputDigest: string };
    return { contract: "runtime-configuration-refusal/v1" as const, operationId: v.operationId, inputDigest: v.inputDigest, ownerDigest: canonicalDigest(v.owner), environmentId, resourceId: resource.id, offerId, recipeHash: "4".repeat(64), receiptSha256: "3".repeat(64), transition: "platform-home-readiness" as const, observedAt: Date.now(), outcome: "configuration-not-attempted" as const };
  };
  const rows = () => Promise.all([prisma.remoteTask.findMany(), prisma.runtimeSession.findMany(), prisma.remoteTaskResource.findMany(), prisma.toolingStateWrite.findMany(), prisma.toolingSelection.findMany()]);
  return { ...input, input, observe, rows, run: (read = observe) => repairConfigurationRefusal(input, { observe: read }) };
}

async function predecessors(f: Awaited<ReturnType<typeof fixture>>) {
  const environment = await f.prisma.computeEnvironment.findFirstOrThrow(), offer = await f.prisma.computeOffer.findFirstOrThrow();
  await f.prisma.toolingOperation.create({ data: { id: "earlier", taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: "earlier", inputDigest: "2".repeat(64), kind: "adapter-command", releaseId: "old", generation: 4, protocol: 3 } });
  const event = (key: string, value: unknown) => f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key, value: JSON.stringify(value) } });
  for (const [id, kind, route] of [["admitted", "compute-admission", "POST /api/tasks/:taskId/compute-request"], ["configured", "compute-configure", "POST /api/tasks/:taskId/compute-configure"]]) {
    await f.prisma.toolingOperation.create({ data: { id: id!, taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: id!, inputDigest: "2".repeat(64), kind: kind!, parentOperationId: "earlier", releaseId: "old", generation: 4, protocol: 3, status: "running" } });
    for (const state of ["intent", "acknowledged"]) await event(`outcome:${id}`, { version: 1, operationId: id, inputDigest: "2".repeat(64), role: "outcome", state, attemptId: id, route, status: state === "acknowledged" ? 200 : null });
  }
  await event("admission:environment-key:runtime-development", { version: 1, operationId: "admitted", role: "admission", state: "confirmed" });
  await event(`producer:compute-environment:${environment.id}`, { version: 1, operationId: "configured", role: "producer", state: "confirmed" });
  await event(`owner:compute-offer:${offer.id}`, { version: 1, operationId: "configured", role: "owner", state: "confirmed" });
  return { environment, offer, event };
}

for (const fault of ["exact", "pause", "pin", "parent", "release", "offer", "owner", "resource", "unknown-producer", "other-producer", "original-outcome"] as const)
test("linked successor authority remains scoped to its original runtime: " + fault, async () => {
  const f = await fixture(), prior = await predecessors(f), result = await f.run();
  await f.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  const child = await bindToolingOperation({ prisma: f.prisma, config: f.config, taskId: "task", sessionId: "primary", turnId: null,
    request: { requestKey: "new-configure", kind: "compute-configure", parentOperationId: result.binding.operationId, existingOperationId: prior.offer.id, inputDigest: "6".repeat(64) } });
  if (fault === "pause") await f.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (fault === "pin") await f.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
  if (fault === "parent") child.parentOperationId = "original";
  if (fault === "release") child.generation++;
  if (fault === "offer") child.existingOperationId = "foreign-offer";
  if (fault === "resource") await f.prisma.computeEnvironment.update({ where: { id: prior.environment.id }, data: { resourceId: "foreign" } });
  if (fault === "original-outcome") await f.prisma.toolingOperation.update({ where: { id: "original" }, data: { completionEvidence: { kind: "command-completed", reference: "wrong" } } });
  if (fault === "unknown-producer" || fault === "other-producer") await prior.event(`producer:compute-environment:${prior.environment.id}`, { version: 1, role: "producer", operationId: "foreign-producer", state: fault === "unknown-producer" ? "intent" : "confirmed" });
  const task = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  expect(await configurationRefusalContinuationAllows(f.prisma, task, child, { kind: "configuration", offerId: prior.offer.id, owner: fault === "owner" ? "foreign" : "configured" })).toBe(fault === "exact");
});

test.each(["unacknowledged", "unknown-producer", "pending-reader"])("refusal handoff cannot cover uncertain predecessor effects: %s", async fault => {
  const f = await fixture(), prior = await predecessors(f);
  if (fault === "unacknowledged") await prior.event("outcome:admitted", { version: 1, role: "outcome", operationId: "admitted", inputDigest: "2".repeat(64), state: "intent", attemptId: "later", route: "POST /api/tasks/:taskId/compute-request" });
  if (fault === "unknown-producer") await prior.event(`producer:compute-environment:${prior.environment.id}`, { version: 1, role: "producer", operationId: "other", state: "intent" });
  if (fault === "pending-reader") await f.prisma.toolingRetainedConsumer.create({ data: { id: "reader", taskId: "task", repositoryId: "repo", operationId: "configured", releaseId: "old", generation: 4, protocol: 3, consumerKind: "compute-environment", consumerId: prior.environment.id, scopeKey: "runtime-development", status: "pending" } });
  await expect(f.run()).rejects.toThrow();
  expect((await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "original" } })).status).toBe("bound");
});

test("one verified failure records a linked corrected command and keeps original task, pin and state writes", async () => {
  const f = await fixture(), before = await f.rows(), original = await readToolingOperation({ prisma: f.prisma, operationId: "original" });
  const result = await f.run();
  expect(result.binding).toMatchObject({ taskId: "task", sessionId: "primary", inputDigest: original!.inputDigest, status: "bound", release: { id: "fixed" }, generation: 5 });
  const ended = await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "original" } });
  expect(ended).toMatchObject({ releaseId: "old", requestKey: "original-key", generation: 4, status: "completed", completionEvidence: { kind: "configuration-validation-failed", reference: result.binding.operationId } });
  expect(await f.rows()).toEqual(before);
  // Lost response then owner resume: the exact receipt replays, never re-runs
  // observation or makes a second command on a later selected generation.
  await f.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  expect(await f.run(async () => { throw new Error("must not observe on replay"); })).toEqual(result);
  expect(await f.prisma.toolingOperation.count()).toBe(2);
  f.request.values.config = "/different/scenario.json";
  await expect(f.run()).rejects.toThrow("retry changed");
});

for (const change of ["unpaused", "active", "running", "unknown", "child", "consumer", "resource", "other-state", "input", "generation", "stale-proof", "foreign-proof", "changed-owner", "changed-selection", "native-owner", "later-writer"] as const) test("configuration refusal repair preserves the failed command on " + change, async () => {
  const f = await fixture();
  if (change === "unpaused") await f.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  if (change === "active") await f.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "active" } });
  if (change === "running" || change === "unknown") await f.prisma.toolingOperation.update({ where: { id: "original" }, data: { status: change } });
  if (change === "child") await f.prisma.toolingOperation.create({ data: { id: "child", taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: "child", inputDigest: "0".repeat(64), kind: "compute-admission", releaseId: "old", generation: 4, protocol: 3, parentOperationId: "original" } });
  if (change === "consumer") await f.prisma.toolingRetainedConsumer.create({ data: { id: "consumer", taskId: "task", repositoryId: "repo", operationId: "original", releaseId: "old", generation: 4, protocol: 3, consumerKind: "test", consumerId: "test", scopeKey: "runtime-development", status: "pending" } });
  if (change === "resource") await f.prisma.remoteTaskResource.update({ where: { id: "runtime" }, data: { state: "released" } });
  if (change === "other-state") await f.prisma.toolingStateWrite.updateMany({ data: { family: "drafted.test-identities" } });
  if (change === "input") f.request.expectedInputDigest = "0".repeat(64);
  if (change === "generation") f.request.expectedGeneration = 6;
  if (change === "native-owner") {
    await f.prisma.remoteTask.update({ where: { id: "task" }, data: { connectionId: "linear", issueIdentifier: "ISSUE-1" } });
    await f.prisma.nativeTakeover.create({ data: { sourceKey: "source", connectionId: "linear", repositoryId: "repo", machineId: "host", issueId: "issue", issueIdentifier: "ISSUE-1", revision: 1, mode: "native", settled: true, decidedAt: new Date() } });
  }
  if (change === "later-writer") await f.prisma.toolingStateWrite.create({ data: { taskId: "task", repositoryId: "repo", operationId: "other", releaseId: "old", family: "drafted.runtime", scopeKey: "runtime-development", version: 1, preservesUnknown: false } });
  await expect(f.run(async (...args) => {
    const proof = await f.observe(...args);
    if (change === "stale-proof") proof.observedAt -= 30_000;
    if (change === "foreign-proof") proof.ownerDigest = "0".repeat(64);
    if (change === "changed-owner") await f.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
    if (change === "changed-selection") await f.prisma.toolingSelection.update({ where: { repositoryId: "repo" }, data: { generation: 6 } });
    return proof;
  })).rejects.toThrow();
  expect((await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "original" } })).status).toBe(change === "running" || change === "unknown" ? change : "bound");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "configuration-refusal-repaired" } })).toBe(0);
  expect(await f.prisma.toolingOperation.count({ where: { releaseId: "fixed" } })).toBe(0);
});
