import { enqueueTaskCleanup } from "./cleanup-inbox.ts";
import { taskSupervisionRoutes } from "../../routes/tasks/supervision.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { confirmTaskFinalization, prepareTaskFinalization } from "./finalization.ts";
import { FINALIZATION_PREPARED, FINALIZATION_CONFIRMED } from "./finalization-receipts.ts";
import { CLEANUP_OPERATION, assertPreparedCleanup, bindPreparedCleanup } from "./cleanup-lifecycle.ts";
import { CLEANUP_PROGRESS, recordCleanupProgress, cleanupProgressProjection } from "./cleanup-progress.ts";
import { retirementDigest } from "./retirement-receipts.ts";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskRoutes, sessionTaskRoutes } from "../../routes/tasks/index.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "task-finalization-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  git(root, "worktree", "add", "-b", "codex/task", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: directory, toolingRevision: "a".repeat(40), phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Blocked", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", branchName: "codex/task", title: "Task", description: "Request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const context = { prisma: db.prisma, config, taskId: task.id };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "owner-verified", passed: true, evidence: ["Owner accepted verified content"] } });
  const head = git(worktree, "rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const observer = { ...completionObservation, remote: async () => remote };
  const input = { prisma: db.prisma, config, sessionId: session.id, requestKey: "finalize:task" };
  const dependencies = { source: async () => ({ session, link, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, observer), snapshot: completionObservation.snapshot };
  const remove = () => git(root, "worktree", "remove", worktree);
  const revoke = () => setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "revoke", expectedRevision: contract.revision, boundary: "revoked", basis: "Owner withdrew delivery" }) });
  return { root, worktree, config, session, task, issue, states, context, contract, remote, observer, input, dependencies, remove, revoke };
}

async function preparedFixture() {
  const f = await fixture();
  await db.prisma.remoteTaskResource.create({ data: { id: "volume", taskId: f.task.id, key: "data", kind: "docker-volume", purpose: "development", externalId: "exact-owned-volume", state: "ready", metadata: { taskId: f.task.id } } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies);
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const observe = async () => { expect(await completionObservation.snapshot(f.worktree)).toEqual(JSON.parse(frozen.find(row => row.sequence === prepared.preparedRevision)!.value!).delivery.receipts.snapshot); };
  return { ...f, prepared, frozen, observe };
}

test("existing preparation automatically binds once across lost responses without source status or provider reads", async () => {
  const f = await preparedFixture();
  f.issue.state = f.states[2]!;
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  let observations = 0;
  const first = await bindPreparedCleanup(f.input, async () => { observations++; await f.observe(); });
  for (const state of [f.states[0]!, f.states[1]!, f.states[2]!, { id: "custom", name: "Owner chose another status", type: "unstarted" }]) {
    f.issue.state = state;
    expect((await bindPreparedCleanup(f.input, async () => { throw new Error("Do not repeat accepted delivery observations"); })).operationRevision).toBe(first.operationRevision);
  }
  expect(observations).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: f.frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(f.frozen);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("waiting");
});

test("cheap checks cannot establish authority, and generic receipts or a bare Done cannot replace real preparation", async () => {
  const f = await fixture(); f.issue.state = f.states[1]!;
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "cleanup", kind: "finalization", purpose: "development", externalId: "claimed", state: "released", metadata: { prepared: true } } });
  await expect(bindPreparedCleanup(f.input, async () => {})).rejects.toThrow("existing preparation");
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("existing preparation");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("pause, contract revocation and retirement revocation cannot be escaped by rebinding or a new request key", async () => {
  const f = await preparedFixture();
  await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("paused");
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("paused");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "delivered-retirement-revoked", key: "explicit-revoke", value: JSON.stringify({ basis: "Owner revoked cleanup" }) } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("explicitly revoked");
  await expect(bindPreparedCleanup({ ...f.input, requestKey: "fresh-key" }, f.observe)).rejects.toThrow("stable finalization");
  await f.revoke();
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("revoked or replaced");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
});

test("an explicit 183 revocation before the first lifecycle binding still prevents cleanup", async () => {
  const f = await preparedFixture();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-retirement-authority", key: "revoke-183", value: JSON.stringify({ version: 1, action: "revoke", input: { basis: "Owner revoked retirement" } }) } });
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("explicitly revoked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("original task pin, resource metadata, added targets and retained-proof drift invalidate the frozen scope", async () => {
  const f = await preparedFixture();
  await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "b".repeat(40) } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("pin changed");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "a".repeat(40) } });
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: { taskId: "other-task" } } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("resource identity");
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: { taskId: f.task.id } } });
  const added = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "other", kind: "docker-volume", purpose: "development", externalId: "new-volume", state: "ready" } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("scope changed");
  await db.prisma.remoteTaskResource.delete({ where: { id: added.id } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "legacy-evidence-retained", key: "new-proof", value: JSON.stringify({ changed: true }) } });
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("retention proof");
});

test("release progress and ordinary annotations keep the same operation; released targets cannot be resurrected", async () => {
  const f = await preparedFixture();
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  const first = await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: { taskId: f.task.id, observed: "already absent", observedAt: new Date().toISOString() } } });
  expect((await assertPreparedCleanup(f.input)).operationRevision).toBe(first.operationRevision);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "ready" } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("terminal state");
});

test("revocation and target mutation during initial observations win the transaction CAS", async () => {
  const f = await preparedFixture();
  await expect(bindPreparedCleanup(f.input, async () => { await f.revoke(); })).rejects.toThrow("revoked or replaced");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("a real database survives restart and 128 local batch checks finish within a provider-read deadline", async () => {
  const f = await preparedFixture();
  await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.$disconnect();
  // This is real SQLite work, without simulated renewal sleeps. The deadline
  // is below one observed 11–12s provider/source/archive renewal in DRA-12.
  const start = performance.now();
  for (let batch = 0; batch < 128; batch++) await assertPreparedCleanup({ ...f.input });
  expect(performance.now() - start).toBeLessThan(10_000);
  const operation = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: CLEANUP_OPERATION } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: operation.runtimeSessionId, source: operation.source, action: operation.action, key: operation.key, value: operation.value } }))).rejects.toThrow();
  expect((await assertPreparedCleanup({ ...f.input })).operationRevision).toBe(operation.sequence);
}, 15_000);

test("actual preparation and confirmation use the original receipt while Linear is unavailable and phase is waiting", async () => {
  const f = await preparedFixture();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const input = { ...f.input, cleanup: true as const };
  const unavailable = { ...f.dependencies, source: async () => { throw new Error("Linear unavailable"); }, completion: async () => { throw new Error("Provider observation must not repeat"); } };
  await expect(prepareTaskFinalization({ ...input, authorityOnly: true }, unavailable)).rejects.toThrow("not bound");
  const bound = await prepareTaskFinalization(input, unavailable);
  expect(bound).toMatchObject(f.prepared);
  expect("cleanup" in bound && bound.cleanup?.operationRevision).toBeGreaterThan(f.prepared.preparedRevision);
  expect(await prepareTaskFinalization({ ...input, authorityOnly: true }, unavailable)).toEqual(bound);
  await expect(confirmTaskFinalization(input, unavailable)).rejects.toThrow("unreleased");
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  f.remove();
  const confirmed = await confirmTaskFinalization(input, unavailable);
  expect(confirmed.preparedRevision).toBe(f.prepared.preparedRevision);
  expect(confirmed.confirmedRevision).toBeDefined();
  expect(await confirmTaskFinalization(input, unavailable)).toEqual(confirmed);
  expect(await prepareTaskFinalization({ ...input, authorityOnly: true }, unavailable)).toEqual(confirmed);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.frozen.find(row => row.sequence === f.prepared.preparedRevision)!.value);
});

test("new cleanup prepares accepted delivery from a waiting/custom-status task without requiring current Merge", async () => {
  const f = await fixture(); f.issue.state = { id: "custom", name: "Owner chose a custom state", type: "unstarted" };
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const bound = await prepareTaskFinalization({ ...f.input, cleanup: true }, f.dependencies);
  expect("cleanup" in bound && bound.cleanup?.operationRevision).toBeGreaterThan(bound.preparedRevision);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  expect(f.issue.state.id).toBe("custom");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("waiting");
});

test("new cleanup uses stored accepted owner source identity when Linear is unavailable and still observes exact delivery", async () => {
  const f = await fixture();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-owner-approval", key: "owner",
    value: JSON.stringify({ actorId: "configured-owner", contractRevision: f.contract.revision, requestKey: "owner", issueId: f.issue.id, issueIdentifier: f.issue.identifier, connectionId: f.task.connectionId }) } });
  let delivered = 0;
  const unavailable = { ...f.dependencies, source: async () => { throw new Error("Linear unavailable"); },
    completion: async (input: Parameters<typeof assertCompletionAllowed>[0]) => { delivered++; return f.dependencies.completion(input); } };
  const first = await prepareTaskFinalization({ ...f.input, cleanup: true }, unavailable);
  expect(delivered).toBe(1);
  expect(await prepareTaskFinalization({ ...f.input, cleanup: true, authorityOnly: true }, unavailable)).toEqual(first);
  expect(delivered).toBe(1);
  await f.revoke();
  await expect(prepareTaskFinalization({ ...f.input, cleanup: true }, unavailable)).rejects.toThrow("revoked or replaced");
});

test("new cleanup cannot replace a differently keyed preparation or escape a prior explicit revocation", async () => {
  const f = await fixture();
  const existing = await prepareTaskFinalization({ ...f.input, requestKey: "original-key" }, f.dependencies);
  await expect(prepareTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).rejects.toThrow("cannot replace");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: existing.preparedRevision } })).not.toBeNull();
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: existing.preparedRevision } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "delivered-retirement-revoked", key: "owner-revoke", value: JSON.stringify({ basis: "Owner revoked retirement" }) } });
  await expect(prepareTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).rejects.toThrow("explicitly revoked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("actual resource routes reject new targets and resurrection while allowing paused stop observations", async () => {
  const f = await preparedFixture(); await bindPreparedCleanup(f.input, f.observe);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/sessions", sessionTaskRoutes);
  const put = (body: unknown) => app.request(`/api/sessions/${f.session.id}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const resource = { key: "data", kind: "docker-volume", purpose: "development", externalId: "exact-owned-volume", state: "ready", metadata: { taskId: f.task.id } };
  expect((await put({ ...resource, key: "new-target", externalId: "other-volume" })).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id } })).toBe(1);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  expect((await put({ ...resource, metadata: { ...resource.metadata, observed: "stopped", observedAt: new Date().toISOString() } })).status).toBe(200);
  expect((await put({ ...resource, state: "released" })).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  expect((await put({ ...resource, state: "released" })).status).toBe(200);
  expect((await put(resource)).status).toBe(409);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "volume" } })).state).toBe("released");
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual control client and server renew 128 batches with retained archive proof without task GET or provider reads", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRoot: f.root, pinnedToolingRoot: f.root } });
  const archive = path.join(directory, "retained");
  await mkdir(archive, { mode: 0o700 });
  const bytes = Buffer.alloc(8 * 1024 * 1024, 7), sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  await writeFile(path.join(archive, "snapshot.bin"), bytes, { mode: 0o600 });
  const manifest = JSON.stringify({ task: f.task.id, issue: f.task.issueIdentifier, mergedCommit: f.remote.pullRequest.mergeCommit.oid, count: 1,
    entries: [{ archivePath: "snapshot.bin", sourcePath: "/historical/snapshot", sha256: sha(bytes), bytes: bytes.length }] });
  await writeFile(path.join(archive, "ARCHIVE-MANIFEST.json"), manifest, { mode: 0o600 });
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "retained", kind: "evidence-archive", purpose: "development", externalId: archive, state: "ready",
    metadata: { archival: true, manifest: { path: "ARCHIVE-MANIFEST.json", sha256: sha(manifest), entries: 1 } } } });
  const original = await prepareTaskFinalization(f.input, f.dependencies);
  expect("archiveRetention" in original && original.archiveRetention).toBeTruthy();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  let taskReads = 0;
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .use("*", async (c, next) => { if (c.req.method === "GET") taskReads++; await next(); }).route("/api/tasks", taskRoutes);
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: app.fetch });
  try {
    const { taskRegistry } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
    let registry = taskRegistry(socket, f.task.id, 1000);
    const request = { requestKey: f.input.requestKey, cleanup: true as const };
    const bound = await registry.prepareFinalization!(request);
    expect(bound).toMatchObject(original);
    expect(bound.cleanup.operationRevision).toBeGreaterThan(original.preparedRevision);
    const before = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
    const start = performance.now();
    for (let batch = 0; batch < 128; batch++) {
      if (batch === 64) { await db.prisma.$disconnect(); registry = taskRegistry(socket, f.task.id, 1000); }
      expect(await registry.prepareFinalization!({ ...request, authorityOnly: true })).toEqual(bound);
    }
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(taskReads).toBe(0);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(before);
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    await expect(registry.prepareFinalization!({ ...request, authorityOnly: true })).rejects.toThrow("original primary");
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    await writeFile(path.join(archive, "snapshot.bin"), "changed retained bytes", { mode: 0o600 });
    await expect(registry.prepareFinalization!(request)).rejects.toThrow();
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
  } finally { await server.stop(true); }
}, 30_000);


test("cleanup progress survives restart but diagnostic success cannot release resources or expand the bound scope", async () => {
  const f = await preparedFixture(), active = await bindPreparedCleanup(f.input, f.observe);
  const operation = { operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation) };
  const progress = { ...operation, requestKey: f.input.requestKey, outcomes: [{ key: "data", outcome: "released", detail: "provider password=do-not-store\n403 " + "x".repeat(2000) }] };
  const input = { ...f.context, progress };
  const first = await recordCleanupProgress(input);
  expect(first.resources).toMatchObject([{ key: "data", state: "ready", outcome: "blocked" }]);
  expect(first.resources[0]!.detail).not.toContain("do-not-store"); expect(first.resources[0]!.detail!.length).toBe(1000);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "volume" } })).state).toBe("ready");
  expect((await recordCleanupProgress(input)).revision).toBe(first.revision);
  await db.prisma.$disconnect();
  expect((await cleanupProgressProjection(db.prisma, f.task, operation)).cleanupProgress?.resources).toEqual(first.resources);
  await expect(recordCleanupProgress({ ...input, progress: { ...progress, outcomes: [{ key: "foreign", outcome: "released" }] } })).rejects.toThrow("unknown or duplicate");
  await expect(recordCleanupProgress({ ...input, progress: { ...progress, operationDigest: "f".repeat(64) } })).rejects.toThrow("operation changed");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(recordCleanupProgress(input)).rejects.toThrow("paused");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  expect((await recordCleanupProgress(input)).resources[0]!.outcome).toBe("released");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_PROGRESS } })).toBe(2);
  await f.revoke();
  await expect(recordCleanupProgress(input)).rejects.toThrow("revoked");
});


test("automatic cleanup candidates exclude pause, changed original ownership and revoked acceptance", async () => {
  const f = await fixture(); f.issue.state.name = "Custom owner status";
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes);
  const candidate = async () => (await (await app.request("/api/tasks?pagination=id")).json()).tasks.find((task: { id: string }) => task.id === f.task.id).finalizationPending;
  expect(await candidate()).toBeTrue();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(0);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } }); expect(await candidate()).toBeFalse();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: f.root } }); expect(await candidate()).toBeFalse();
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: f.worktree } }); expect(await candidate()).toBeTrue();
  await f.revoke(); expect(await candidate()).toBeFalse();
});


test("automatic operation keeps exact turn protection across omitted flags, deferred work, restart and a new serialized attempt", async () => {
  const f = await preparedFixture();
  const capability = async () => ({ receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
    taskToolingRevision: f.task.toolingRevision, capabilityRevision: "b".repeat(40), checkout: "/fixture/immutable", instructions: "/fixture/immutable/cleanup.md", adapter: "/fixture/immutable/src/cli.ts" }, instructions: "Fixture immutable cleanup adapter" });
  const start = async (key: string) => {
    const queued = await enqueueTaskCleanup({ prisma: db.prisma, config: f.config, taskId: f.task.id, requestKey: key }, { capability });
    await db.prisma.runtimeInstruction.update({ where: { id: queued.instructionId }, data: { state: "dispatching", executionRequestId: key } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: key, runtimeSessionId: f.session.id, requestId: key, phase: "started", occurredAt: new Date() } });
    return queued;
  };
  const first = await start("first-cleanup-turn");
  const bound = await bindPreparedCleanup(f.input, f.observe);
  expect(bound.operation.automatic).toEqual({ kind: "primary-inbox", initialInstructionId: first.instructionId });
  await db.prisma.runtimeInstruction.create({ data: { id: "followup", sessionId: f.session.id, text: "Owner follow-up", state: "queued" } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("pending task instructions");
  await expect(prepareTaskFinalization({ ...f.input, authorityOnly: true }, f.dependencies)).rejects.toThrow("pending task instructions");
  await db.prisma.runtimeInstruction.update({ where: { id: first.instructionId }, data: { state: "completed" } });
  await db.prisma.runtimeInstruction.update({ where: { id: "followup" }, data: { state: "completed" } });
  await db.prisma.$disconnect();
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("exact executing");
  await start("later-cleanup-turn");
  expect((await assertPreparedCleanup(f.input)).operation).toEqual(bound.operation);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.frozen.find(event => event.sequence === f.prepared.preparedRevision)!.value);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  f.remove();
  await confirmTaskFinalization({ ...f.input, cleanup: true }, f.dependencies);
  // A follow-up can arrive after confirmed physical removal but before close.
  // It must remain queued, with the original primary open to handle it.
  await db.prisma.runtimeInstruction.create({ data: { id: "after-confirm", sessionId: f.session.id, text: "New request after removal", state: "queued" } });
  const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.worktree, repositoryId: f.task.repositoryId, machineId: f.task.machineId, role: "primary", status: "active" }]);
  runtime.observeSessionActivity = () => ({ state: "executing", requestId: "later-cleanup-turn", observedAt: Date.now() });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient })).route("/api/tasks", taskSupervisionRoutes);
  const response = await app.request("/api/tasks/task/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", cleanup: true }) });
  expect(response.status).toBe(409);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "after-confirm" } })).state).toBe("queued");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).not.toBe("closed");
  expect(runtime.closedSessionIds).toEqual([]);
  const explicitOwner = await app.request("/api/tasks/task/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close" }) });
  expect(explicitOwner.status).toBe(200);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "after-confirm" } })).state).toBe("cancelled");
});
