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
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";

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

test("successful delivery is sealed before cleanup, confirmed from Git absence, then permits Done and idempotent close retry", async () => {
  const f = await fixture();
  const prepared = await prepareTaskFinalization(f.input, f.dependencies);
  expect(prepared).toMatchObject({ taskId: "task", sessionId: "primary", worktree: f.worktree, branch: "codex/task", revision: git(f.worktree, "rev-parse", "HEAD") });
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow("still exists");
  f.remove();
  expect(await prepareTaskFinalization(f.input, f.dependencies)).toEqual(prepared);
  await expect(assertCompletionAllowed(f.input, f.observer)).rejects.toThrow("without a confirmed");
  const confirmed = await confirmTaskFinalization(f.input, f.dependencies);
  expect(confirmed.preparedRevision).toBe(prepared.preparedRevision);
  expect(confirmed.confirmedRevision).toBeGreaterThan(prepared.preparedRevision);
  expect(await confirmTaskFinalization(f.input, f.dependencies)).toEqual(confirmed);
  expect((await assertCompletionAllowed(f.input, f.observer)).receipts.merge.merged).toBe(true);
  let comments = 0;
  const client = { ...issueUpdateDelivery, source: f.dependencies.source, read: async () => f.issue,
    graph: async () => ({ id: f.issue.id, identifier: f.issue.identifier, children: [], states: f.states }),
    create: async (_config: unknown, input: { id?: string }) => { comments++; return { id: input.id! }; },
    update: async (_config: unknown, _query: unknown, input: { stateId?: string }) => { f.issue.state = f.states.find((state) => state.id === input.stateId)!; },
  };
  const update = { ...f.input, requestKey: `${f.input.requestKey}:done`, state: "Done", expectedState: "Merge", body: "Merged and verified cleanup. Coding session is about to close.", evidence: [] };
  expect((await publishSessionIssueUpdate(update, client)).published).toBe(true);
  expect(f.issue.state.name).toBe("Done");
  // Simulate the adapter's close request failing after successful publication.
  expect(await prepareTaskFinalization(f.input, f.dependencies)).toEqual(confirmed);
  expect(await confirmTaskFinalization(f.input, f.dependencies)).toEqual(confirmed);
  expect((await publishSessionIssueUpdate(update, client)).published).toBe(true);
  expect(comments).toBe(1);
  expect((await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "primary" } })).status).toBe("idle");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("complete");
});

test("failed merge verification and generic resource claims never create finalization authority", async () => {
  const f = await fixture();
  f.remote.pullRequest.state = "OPEN";
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("not been merged");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(0);
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "finalization-confirmed", purpose: "review", kind: "merge", externalId: "claimed", state: "released", metadata: { merged: true, cleanup: true } } });
  f.remove();
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow("not prepared");
  await expect(assertCompletionAllowed(f.input, f.observer)).rejects.toThrow("without a confirmed");
});

test("cleanup confirmation rejects retained resources and stale Git registrations", async () => {
  const f = await fixture();
  await prepareTaskFinalization(f.input, f.dependencies);
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "preview", purpose: "review", kind: "http", externalId: "http://localhost:3000", state: "unknown" } });
  await rm(f.worktree, { recursive: true });
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow("unreleased");
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { state: "released" } });
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow("registered");
  git(f.root, "worktree", "prune", "--expire", "now");
  expect((await confirmTaskFinalization(f.input, f.dependencies)).confirmedRevision).toBeDefined();
});

test("owner contract revocation after removal blocks confirmation and missing-worktree completion", async () => {
  const f = await fixture();
  await prepareTaskFinalization(f.input, f.dependencies); f.remove(); await f.revoke();
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow("revoked or replaced");
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("revoked or replaced");
  await expect(assertCompletionAllowed(f.input, f.observer)).rejects.toThrow("unknown or revoked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
});

test("Task closure and source-state changes invalidate preparation without replaying cleanup", async () => {
  const f = await fixture();
  await prepareTaskFinalization(f.input, f.dependencies);
  f.issue.state = f.states[2]!;
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("current owner Merge");
  f.issue.state = f.states[0]!;
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("open complete task");
  f.remove();
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow("open complete task");
});

test("prepare retries never refresh accepted bytes and arbitrary Done is not cleanup authority", async () => {
  const f = await fixture();
  await prepareTaskFinalization(f.input, f.dependencies);
  await writeFile(path.join(f.worktree, "README.md"), "new unverified code\n");
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("Worktree changed");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  f.issue.state = f.states[1]!;
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("current owner Merge");
});

test("confirmed receipts do not authorize recreated worktrees, new resources or closed primaries", async () => {
  const f = await fixture();
  await prepareTaskFinalization(f.input, f.dependencies); f.remove(); await confirmTaskFinalization(f.input, f.dependencies);
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "new-preview", purpose: "review", kind: "http", externalId: "http://localhost:4000", state: "ready" } });
  await expect(assertCompletionAllowed(f.input, f.observer)).rejects.toThrow("unreleased");
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("unreleased");
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { state: "released" } });
  await mkdir(f.worktree);
  await expect(prepareTaskFinalization(f.input, f.dependencies)).rejects.toThrow("still exists");
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow("still exists");
  await expect(assertCompletionAllowed(f.input, f.observer)).rejects.toThrow();
  await rm(f.worktree, { recursive: true });
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed" } });
  await expect(assertCompletionAllowed(f.input, f.observer)).rejects.toThrow("closed");
});

test("delegate identity and unprepared request keys cannot consume a primary's finalization receipt", async () => {
  const f = await fixture();
  await prepareTaskFinalization(f.input, f.dependencies); f.remove();
  await expect(confirmTaskFinalization({ ...f.input, requestKey: "different" }, f.dependencies)).rejects.toThrow("not prepared");
  await db.prisma.runtimeSession.create({ data: { id: "delegate", scopeKey: "delegate", agentCommand: "codex", status: "idle", role: "delegate", cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine } });
  await expect(confirmTaskFinalization({ ...f.input, sessionId: "delegate" }, f.dependencies)).rejects.toThrow("original primary");
});
