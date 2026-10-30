import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { prepareTaskFinalization } from "./finalization.ts";
import { assertPreparedCleanup, bindPreparedCleanup } from "./cleanup-lifecycle.ts";
import { Hono } from "hono";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskRoutes, sessionTaskRoutes } from "../../routes/tasks/index.ts";
import { enqueueTaskCleanup } from "./cleanup-inbox.ts";
import { recordCleanupProgress } from "./cleanup-progress.ts";
import { retirementDigest } from "./retirement-receipts.ts";

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
  await writeFile(path.join(root, "README.md"), "accepted content\n"); await writeFile(path.join(root, ".gitignore"), "node_modules/\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
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

async function progressFixture() {
  const f = await fixture();
  const dependency = path.join(f.worktree, "node_modules");
  await mkdir(dependency); await writeFile(path.join(dependency, "saved.js"), "preserve this disposable fixture");
  await db.prisma.remoteTaskResource.createMany({ data: [
    { id: "evidence", taskId: f.task.id, key: "evidence", kind: "evidence", purpose: "browser", externalId: path.join(directory, "evidence.png"), state: "ready", metadata: { sha256: "a".repeat(64), bytes: 4 } },
    { id: "clerk", taskId: f.task.id, key: "clerk-instance", kind: "clerk-instance", purpose: "development", externalId: "fixture-instance", state: "unknown" },
    { id: "dependency", taskId: f.task.id, key: "dependencies", kind: "dependency-install", purpose: "development", externalId: dependency, state: "ready", metadata: { trackedChanges: false } },
  ] });
  await prepareTaskFinalization(f.input, f.dependencies);
  const queued = await enqueueTaskCleanup({ ...f.context, requestKey: "upkeep-pass" }, { capability: async () => ({ receipt: {
    contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const, taskToolingRevision: f.task.toolingRevision,
    capabilityRevision: "b".repeat(40), checkout: directory, instructions: path.join(directory, "cleanup.md"), adapter: path.join(directory, "cli.ts"),
  }, instructions: "Disposable cleanup capability fixture" }) });
  await db.prisma.runtimeInstruction.update({ where: { id: queued.instructionId }, data: { state: "dispatching", executionRequestId: "cleanup-turn" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: f.session.id, requestId: "cleanup-turn", phase: "started", occurredAt: new Date() } });
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "active" } });
  const active = await bindPreparedCleanup(f.input, async () => {});
  await db.prisma.remoteTaskResource.update({ where: { id: "evidence" }, data: { state: "released" } });
  const progressInput = { ...f.context, progress: { requestKey: f.input.requestKey, operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation),
    outcomes: [{ key: "clerk-instance", outcome: "blocked", detail: "Provider ownership is unresolved" }] } };
  const progress = await recordCleanupProgress(progressInput);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const get = async (url = `/api/tasks/${f.task.id}`) => {
    const response = await app.request(url); expect(response.status).toBe(200);
    const body = await response.json(); return body.task ?? body.tasks.find((task: { id: string }) => task.id === f.task.id);
  };
  const idle = async () => {
    await db.prisma.runtimeInstruction.update({ where: { id: queued.instructionId }, data: { state: "completed" } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: "completed", runtimeSessionId: f.session.id, requestId: "cleanup-turn", phase: "completed", occurredAt: new Date() } });
    await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "idle" } });
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "blocked" } });
  };
  const state = async () => ({
    events: await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }),
    instructions: await db.prisma.runtimeInstruction.findMany({ orderBy: { sequence: "asc" } }),
    resources: await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } }),
  });
  return { ...f, active, progress, progressInput, app, get, idle, state, dependency };
}

test("real task, list and session routes retain saved progress after the automatic turn ends without exposing effect authority", async () => {
  const f = await progressFixture();
  const active = await f.get();
  expect(active.cleanupOperation.operationRevision).toBe(f.active.operationRevision);
  expect(active.cleanupBlocked).toBeUndefined();
  await f.idle(); await db.prisma.$disconnect();
  const before = await f.state();
  for (const url of ["/api/tasks/task", "/api/tasks", "/api/tasks?pagination=id", "/api/sessions/primary/task"]) {
    const task = await f.get(url);
    expect(task.cleanupHistory).toMatchObject({ readOnly: true, operationRevision: f.active.operationRevision, preparedRevision: f.active.preparation.sequence, originalSessionId: "primary" });
    expect(task.cleanupHistory.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "evidence", identity: "matched", state: "released" }),
      expect.objectContaining({ key: "clerk-instance", identity: "matched", state: "unknown" }),
    ]));
    expect(task.cleanupProgress).toEqual(f.progress);
    expect(task.cleanupRequired).toBe(true); expect(task.cleanupOperation).toBeUndefined();
    expect(task.cleanupBlocked).toContain("exact executing original-primary instruction");
  }
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("exact executing");
  await expect(recordCleanupProgress(f.progressInput)).rejects.toThrow("exact executing");
  expect(await f.state()).toEqual(before);
});

test("paused and revoked operations keep history while every execution guard still refuses continuation", async () => {
  const f = await progressFixture(); await f.idle();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  const paused = await f.get();
  expect(paused.cleanupHistory.operationRevision).toBe(f.active.operationRevision); expect(paused.cleanupProgress).toEqual(f.progress);
  expect(paused.cleanupOperation).toBeUndefined(); expect(paused.cleanupBlocked).toContain("paused");
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("paused");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await f.revoke();
  const revoked = await f.get();
  expect(revoked.cleanupHistory).toEqual(paused.cleanupHistory); expect(revoked.cleanupProgress).toEqual(f.progress);
  expect(revoked.cleanupOperation).toBeUndefined(); expect(revoked.cleanupBlocked).toContain("revoked");
  await expect(recordCleanupProgress(f.progressInput)).rejects.toThrow("revoked");
});

test("changed primary and resource identities are explicit and cannot turn newer receipts into confirmed removals", async () => {
  const f = await progressFixture(); await f.idle();
  await db.prisma.remoteTaskResource.update({ where: { id: "evidence" }, data: { externalId: "/another/owner/file", state: "released" } });
  const changed = await f.get();
  expect(changed.cleanupHistory.resources.find((resource: { id: string }) => resource.id === "evidence")).toMatchObject({ identity: "changed", state: "unknown" });
  expect(changed.cleanupProgress.resources.find((resource: { id: string }) => resource.id === "evidence")).toMatchObject({ state: "unknown", outcome: "pending" });
  expect(changed.cleanupOperation).toBeUndefined(); expect(changed.cleanupBlocked).toContain("identity");
  await db.prisma.runtimeSession.create({ data: { id: "replacement", scopeKey: "replacement", agentCommand: "codex", status: "idle", role: "primary", cwd: f.worktree, repositoryId: f.task.repositoryId, machineId: f.task.machineId } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { primarySessionId: "replacement" } });
  const moved = await f.get();
  expect(moved.cleanupHistory.originalSessionId).toBe("primary"); expect(moved.cleanupProgress.revision).toBe(f.progress.revision);
  expect(moved.cleanupOperation).toBeUndefined(); expect(moved.cleanupBlocked).toContain("original primary identity changed");
});

test("missing progress remains missing, and foreign or modified saved preparation links never become history", async () => {
  const f = await progressFixture(); await f.idle();
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: f.progress.revision } });
  const noProgress = await f.get();
  expect(noProgress.cleanupProgress).toBeUndefined(); expect(noProgress.cleanupHistory.resources).toHaveLength(3);
  const preparation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.active.preparation.sequence } });
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: preparation.sequence }, data: { value: preparation.value + " " } });
  const changed = await f.get();
  expect(changed.cleanupHistory).toBeUndefined(); expect(changed.cleanupOperation).toBeUndefined(); expect(changed.cleanupBlocked).toContain("bytes changed");
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: preparation.sequence }, data: { value: preparation.value } });
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.active.operationRevision }, data: { value: JSON.stringify({ ...f.active.operation, binding: { ...f.active.operation.binding, taskId: "another" } }) } });
  const foreign = await f.get();
  expect(foreign.cleanupHistory).toBeUndefined(); expect(foreign.cleanupOperation).toBeUndefined(); expect(foreign.cleanupBlocked).toContain("another task");
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual existing Drafted dependency adapter cannot use idle or paused history as cleanup authority", async () => {
  const f = await progressFixture(); await f.idle();
  const socket = path.join(directory, "read-only.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const { taskRegistry } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
    const { manageDependencyResource } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/dependency-resources.ts"));
    const registry = taskRegistry(socket, f.task.id), before = await f.state();
    const request = { registry, key: "dependencies", action: "release", journalRoot: path.join(directory, "dependency-journal") };
    await expect(manageDependencyResource(request)).rejects.toThrow("existing active finalization");
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    await expect(manageDependencyResource(request)).rejects.toThrow("existing active finalization");
    expect(await Bun.file(path.join(f.dependency, "saved.js")).text()).toBe("preserve this disposable fixture");
    expect(await f.state()).toEqual(before);
  } finally { await server.stop(true); }
});
