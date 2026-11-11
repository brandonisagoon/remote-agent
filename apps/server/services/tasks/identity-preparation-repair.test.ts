import { afterEach, expect, test } from "bun:test";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { canonicalDigest, readToolingOperation } from "./tooling-releases.ts";
import { repairIdentityPreparation } from "./identity-preparation-repair.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const manifest = { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 3, max: 3 }, stateFormats: { "drafted.test-identities": { read: [1], write: 1, preservesUnknown: false } } };

async function fixture() {
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const prisma = db.prisma, config = testConfig({ machine: "host" }), runtime = createFakeAgentRuntime();
  runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/original/worktree", status: "idle" } });
  await prisma.remoteTask.create({ data: { id: "task", requestKey: "task", primarySessionId: "primary", repositoryId: "repo", machineId: "host", branchName: "original", worktreePath: "/original/worktree", toolingRoot: "/original/tooling", toolingRevision: "a".repeat(40), ownerPaused: true, phase: "blocked" } });
  for (const [id, revision] of [["old", "a".repeat(40)], ["fixed", "b".repeat(40)]]) await prisma.toolingRelease.create({ data: {
    id: id!, revision: revision!, repositoryId: "repo", tree: "c".repeat(40), policyBlob: "d".repeat(40), checkout: "/install/" + id, manifest, lockfileDigest: "e".repeat(64), bunVersion: "1.3.14" } });
  await prisma.toolingSelection.create({ data: { repositoryId: "repo", releaseId: "fixed", generation: 5, activatedAt: new Date() } });
  await prisma.toolingOperation.create({ data: { id: "original", taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: "original-key", inputDigest: "1".repeat(64), kind: "adapter-command", releaseId: "old", generation: 4, protocol: 3 } });
  await prisma.toolingStateWrite.create({ data: { taskId: "task", repositoryId: "repo", operationId: "original", releaseId: "old", family: "drafted.test-identities", scopeKey: "test-identities", version: 1, preservesUnknown: false } });
  const request = { requestKey: "repair-once", operationId: "original", expectedInputDigest: "1".repeat(64), expectedGeneration: 5,
    values: { task: "task", config: "/private/scenario.json", "state-directory": "/private/state", "request-key": "original-key", purpose: "development" as const } };
  const input = { prisma, config, runtime, taskId: "task", repositoryId: "repo", request };
  const observe = async (_release: unknown, value: unknown) => {
    const v = value as { owner: unknown; operationId: string; inputDigest: string };
    return { contract: "test-identity-preparation/v1" as const, operationId: v.operationId, inputDigest: v.inputDigest, ownerDigest: canonicalDigest(v.owner), allocationId: "2".repeat(64),
      journal: { file: "/private/registry.json", digest: "3".repeat(64), count: 2 }, observedAt: Date.now(), outcome: "no-account-attempt" as const };
  };
  const rows = () => Promise.all([prisma.remoteTask.findMany(), prisma.runtimeSession.findMany(), prisma.remoteTaskResource.findMany(), prisma.toolingStateWrite.findMany(), prisma.toolingSelection.findMany()]);
  return { ...input, input, observe, rows, run: (read = observe) => repairIdentityPreparation(input, { observe: read }) };
}

test("one verified failure records a linked corrected command and keeps original task, pin and state writes", async () => {
  const f = await fixture(), before = await f.rows(), original = await readToolingOperation({ prisma: f.prisma, operationId: "original" });
  const result = await f.run();
  expect(result.binding).toMatchObject({ taskId: "task", sessionId: "primary", inputDigest: original!.inputDigest, status: "bound", release: { id: "fixed" }, generation: 5 });
  const ended = await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "original" } });
  expect(ended).toMatchObject({ releaseId: "old", requestKey: "original-key", generation: 4, status: "completed", completionEvidence: { kind: "identity-preparation-failed", reference: result.binding.operationId } });
  expect(await f.rows()).toEqual(before);
  // Lost response then owner resume: the exact receipt replays, never re-runs
  // observation or makes a second command on a later selected generation.
  await f.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  expect(await f.run(async () => { throw new Error("must not observe on replay"); })).toEqual(result);
  expect(await f.prisma.toolingOperation.count()).toBe(2);
  f.request.values.config = "/different/scenario.json";
  await expect(f.run()).rejects.toThrow("retry changed");
});

for (const change of ["unpaused", "active", "running", "unknown", "child", "consumer", "resource", "other-state", "input", "generation", "stale-proof", "foreign-proof", "changed-owner", "changed-selection", "native-owner", "later-writer"] as const) test("identity repair preserves the failed command on " + change, async () => {
  const f = await fixture();
  if (change === "unpaused") await f.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  if (change === "active") await f.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "active" } });
  if (change === "running" || change === "unknown") await f.prisma.toolingOperation.update({ where: { id: "original" }, data: { status: change } });
  if (change === "child") await f.prisma.toolingOperation.create({ data: { id: "child", taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: "child", inputDigest: "0".repeat(64), kind: "compute-admission", releaseId: "old", generation: 4, protocol: 3, parentOperationId: "original" } });
  if (change === "consumer") await f.prisma.toolingRetainedConsumer.create({ data: { id: "consumer", taskId: "task", repositoryId: "repo", operationId: "original", releaseId: "old", generation: 4, protocol: 3, consumerKind: "test", consumerId: "test", scopeKey: "test-identities", status: "pending" } });
  if (change === "resource") await f.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "account", purpose: "development", kind: "clerk-test-user", externalId: "reserved@example.com", state: "unknown" } });
  if (change === "other-state") await f.prisma.toolingStateWrite.updateMany({ data: { family: "drafted.runtime" } });
  if (change === "input") f.request.expectedInputDigest = "0".repeat(64);
  if (change === "generation") f.request.expectedGeneration = 6;
  if (change === "native-owner") {
    await f.prisma.remoteTask.update({ where: { id: "task" }, data: { connectionId: "linear", issueIdentifier: "ISSUE-1" } });
    await f.prisma.nativeTakeover.create({ data: { sourceKey: "source", connectionId: "linear", repositoryId: "repo", machineId: "host", issueId: "issue", issueIdentifier: "ISSUE-1", revision: 1, mode: "native", settled: true, decidedAt: new Date() } });
  }
  if (change === "later-writer") await f.prisma.toolingStateWrite.create({ data: { taskId: "task", repositoryId: "repo", operationId: "other", releaseId: "old", family: "drafted.test-identities", scopeKey: "test-identities", version: 1, preservesUnknown: false } });
  await expect(f.run(async (...args) => {
    const proof = await f.observe(...args);
    if (change === "stale-proof") proof.observedAt -= 30_000;
    if (change === "foreign-proof") proof.ownerDigest = "0".repeat(64);
    if (change === "changed-owner") await f.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
    if (change === "changed-selection") await f.prisma.toolingSelection.update({ where: { repositoryId: "repo" }, data: { generation: 6 } });
    return proof;
  })).rejects.toThrow();
  expect((await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "original" } })).status).toBe(change === "running" || change === "unknown" ? change : "bound");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "identity-preparation-repaired" } })).toBe(0);
  expect(await f.prisma.toolingOperation.count({ where: { releaseId: "fixed" } })).toBe(0);
});
