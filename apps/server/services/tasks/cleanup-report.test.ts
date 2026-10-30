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
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskRoutes } from "../../routes/tasks/index.ts";
import { taskSupervisionRoutes } from "../../routes/tasks/supervision.ts";
import { CLEANUP_REPORT, cleanupReportDelivery, publishCleanupReport } from "./cleanup-report.ts";

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

async function completedFixture(confirm = true) {
  const f = await fixture();
  const prepared = await prepareTaskFinalization(f.input, f.dependencies);
  const input = { ...f.input, cleanup: true as const };
  await prepareTaskFinalization(input, f.dependencies);
  f.remove();
  if (confirm) await confirmTaskFinalization(input, f.dependencies);
  const context = { ...f.context, requestKey: f.input.requestKey };
  const close = async () => {
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
    await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
  };
  const comments = new Map<string, { id: string; issue: { id: string }; body: string }>();
  let creates = 0;
  const client = { ...cleanupReportDelivery, read: async () => f.issue, comment: async (_credential: unknown, id: string) => comments.get(id) ?? null,
    create: async (_credential: unknown, data: { id?: string; issueId: string; body: string }) => {
      creates++; if (!data.id) throw new Error("Missing durable comment identity");
      comments.set(data.id, { id: data.id, issue: { id: data.issueId }, body: data.body }); return { id: data.id };
    } };
  return { ...f, prepared, input, context, close, client, comments, creates: () => creates };
}

test("confirmation queues an exact comment before networking; closure and status changes do not discard pending reporting", async () => {
  const f = await completedFixture();
  const receipt = await db.prisma.runtimeIssueUpdate.findFirstOrThrow();
  expect(receipt).toMatchObject({ runtimeSessionId: f.session.id, connectionId: f.task.connectionId, issueId: f.issue.id, requestKey: "finalize:task:cleanup-report", published: false });
  expect(receipt.input).not.toHaveProperty("state");
  expect(receipt.input).not.toHaveProperty("expectedState");
  await f.close();
  f.issue.state = f.states[2]!;
  await expect(publishCleanupReport(f.context, { ...f.client, read: async () => { throw new Error("Linear unavailable"); } })).rejects.toThrow("Linear unavailable");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("closed");
  expect((await db.prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: receipt.id } })).published).toBe(false);
  expect((await publishCleanupReport(f.context, f.client)).published).toBe(true);
  f.issue.state = { id: "later", name: "Owner selected later state", type: "started" };
  expect((await publishCleanupReport(f.context, { ...f.client, read: async () => { throw new Error("Published retries need no source read"); } })).published).toBe(true);
  expect(f.creates()).toBe(1); expect(f.issue.state.id).toBe("later");
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).action).toBe(FINALIZATION_PREPARED);
});

test("a lost provider response and failed local acknowledgement resume the same comment after restart", async () => {
  const f = await completedFixture(); await f.close();
  let afterCreate = false;
  const client = { ...f.client, create: async (...args: Parameters<typeof f.client.create>) => { await f.client.create(...args); afterCreate = true; throw new Error("Lost provider response"); },
    comment: async (...args: Parameters<typeof f.client.comment>) => { if (afterCreate) throw new Error("Read acknowledgement unavailable"); return f.client.comment(...args); } };
  await expect(publishCleanupReport(f.context, client)).rejects.toThrow("acknowledgement unavailable");
  expect(f.creates()).toBe(1);
  await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_cleanup_report_ack BEFORE UPDATE OF published ON RuntimeIssueUpdate BEGIN SELECT RAISE(ABORT, 'fixture acknowledgement failure'); END");
  await expect(publishCleanupReport(f.context, f.client)).rejects.toThrow();
  await db.prisma.$executeRawUnsafe("DROP TRIGGER fail_cleanup_report_ack");
  await db.prisma.$disconnect();
  const result = await publishCleanupReport(f.context, f.client);
  expect(result.published).toBe(true); expect(f.creates()).toBe(1); expect(f.comments.size).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_REPORT } })).toBe(1);
});

test("a report queue failure rolls back confirmation and replays without repeating cleanup", async () => {
  const f = await completedFixture(false);
  await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_cleanup_report_queue BEFORE INSERT ON RuntimeMetadataEvent WHEN NEW.action = 'finalization-cleanup-report' BEGIN SELECT RAISE(ABORT, 'fixture report queue failure'); END");
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
  expect(await db.prisma.runtimeIssueUpdate.count()).toBe(0);
  await db.prisma.$executeRawUnsafe("DROP TRIGGER fail_cleanup_report_queue");
  const confirmed = await confirmTaskFinalization(f.input, f.dependencies);
  expect(confirmed.confirmedRevision).toBeDefined();
  expect(await confirmTaskFinalization(f.input, f.dependencies)).toEqual(confirmed);
  expect(await db.prisma.runtimeIssueUpdate.count()).toBe(1);
});

test("closed reporting refuses changed body, foreign comment, wrong key and pause before any new effect", async () => {
  const f = await completedFixture(); await f.close();
  const receipt = await db.prisma.runtimeIssueUpdate.findFirstOrThrow();
  await db.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { input: { ...(receipt.input as object), body: "arbitrary closed-session message" } } });
  await expect(publishCleanupReport(f.context, f.client)).rejects.toThrow("payload or comment identity");
  await db.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { input: receipt.input as object } });
  f.comments.set(receipt.id, { id: receipt.id, issue: { id: "different-issue" }, body: String((receipt.input as { body: string }).body) });
  await expect(publishCleanupReport(f.context, f.client)).rejects.toThrow("comment identity or body");
  f.comments.clear();
  await expect(publishCleanupReport({ ...f.context, requestKey: "arbitrary-key" }, f.client)).rejects.toThrow("stable finalization");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(publishCleanupReport(f.context, f.client)).rejects.toThrow("paused");
  expect(f.creates()).toBe(0);
});

test("the task route cannot accept arbitrary report content or publish from an unconfirmed closed task", async () => {
  const f = await completedFixture(false); await f.close();
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes);
  const post = (body: unknown) => app.request(`/api/tasks/${f.task.id}/cleanup-report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post({ requestKey: f.input.requestKey, body: "arbitrary" })).status).toBe(400);
  const response = await post({ requestKey: f.input.requestKey });
  expect(response.status).toBe(409); expect(await response.text()).toContain("exact confirmed preparation");
  expect(await db.prisma.runtimeIssueUpdate.count()).toBe(0);
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual finalizer closes after confirmed cleanup despite reporting outage and retries closed reporting without repeating effects", async () => {
  const f = await fixture();
  const original = await prepareTaskFinalization(f.input, f.dependencies);
  const preparation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.preparedRevision } });
  f.issue.state = f.states[2]!;
  const comments = new Map<string, { id: string; issue: { id: string }; body: string }>();
  let creates = 0, offline = true, lostClose = true, closures = 0;
  const identity = { cwd: f.worktree, repositoryId: f.task.repositoryId, machineId: f.task.machineId, status: "idle" as const };
  const runtime = createFakeAgentRuntime([{ id: f.session.id, ...identity, role: "primary" }, { id: "delegate", ...identity, role: "delegate" }, { id: "unrelated", ...identity, cwd: f.root }]);
  await db.prisma.runtimeInstruction.createMany({ data: [f.session.id, "delegate"].map(sessionId => ({ id: `pending-${sessionId}`, sessionId, text: "Pending fixture instruction", state: "queued" })) });
  const client = { ...cleanupReportDelivery, read: async () => { if (offline) throw new Error("Linear unavailable"); return f.issue; },
    comment: async (_credential: unknown, id: string) => comments.get(id) ?? null,
    create: async (_credential: unknown, data: { id?: string; issueId: string; body: string }) => { creates++; comments.set(data.id!, { id: data.id!, issue: { id: data.issueId }, body: data.body }); return { id: data.id! }; } };
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient }))
    .use("/api/tasks/task/automation", async (c, next) => {
      expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(1);
      expect(await db.prisma.runtimeIssueUpdate.count({ where: { published: false } })).toBe(1);
      await next();
      expect(c.res.status).toBe(200);
      closures++;
      if (lostClose) { lostClose = false; c.res = Response.json({ error: "Close acknowledgement lost" }, { status: 503 }); }
    }).post("/api/tasks/task/cleanup-report", async c => {
      expect(await c.req.json<unknown>()).toEqual({ requestKey: f.input.requestKey });
      expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("closed");
      try { return c.json(await publishCleanupReport({ ...f.context, requestKey: f.input.requestKey }, client)); }
      catch (error) { return c.json({ error: (error as Error).message }, 409); }
    }).route("/api/tasks", taskRoutes).route("/api/tasks", taskSupervisionRoutes);
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: app.fetch });
  try {
    const { taskRegistry, closeTask } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
    const { finalizeTask } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/finalize.ts"));
    const registry = taskRegistry(socket, f.task.id), close = () => closeTask(socket, f.task.id);
    await expect(finalizeTask({ registry, close, cleanup: true })).rejects.toThrow("Close acknowledgement lost");
    const noEffects = async () => { throw new Error("Closed reporting must not repeat Git cleanup"); };
    expect(await finalizeTask({ registry, close, cleanup: true, runner: noEffects })).toMatchObject({ closed: true, alreadyClosed: true, reporting: { state: "pending" } });
    offline = false;
    expect(await finalizeTask({ registry, close, cleanup: true, runner: noEffects })).toMatchObject({ closed: true, alreadyClosed: true, reporting: { state: "published" } });
    expect(creates).toBe(1); expect(comments.size).toBe(1); expect(closures).toBe(3);
    expect(runtime.closedSessionIds.sort()).toEqual(["delegate", f.session.id]);
    expect(runtime.sessions.get("unrelated")?.status).toBe("idle");
    expect(await db.prisma.runtimeInstruction.count({ where: { state: "cancelled" } })).toBe(2);
    expect(f.issue.state.name).toBe("Blocked");
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.preparedRevision } })).value).toBe(preparation.value);
  } finally { await server.stop(true); }
}, 30_000);
