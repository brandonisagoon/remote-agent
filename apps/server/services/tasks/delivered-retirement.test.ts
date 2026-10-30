import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskCompletionRoutes } from "../../routes/tasks/completion.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { prepareTaskFinalization, confirmTaskFinalization } from "./finalization.ts";
import { FINALIZATION_PREPARED } from "./finalization-receipts.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "done-retirement-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

import { adoptDoneRetirement, inspectDoneRetirement, DoneRetirementInput, DONE_RETIREMENT } from "./delivered-retirement.ts";

test("Done supplement preserves original v1 preparation, contract, verification and legacy proof across lost acknowledgment", async () => {
  const f = await fixture();
  await expect(prepareTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("current owner Merge");
  const legacy = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "owner:task", action: "legacy-evidence-retention", key: "proof515", value: JSON.stringify({ original: "immutable fixture evidence" }) } });
  const original = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const request = await f.request();
  const adopted = await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  // The caller lost the success response; replay only reads the saved authority.
  expect(await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies)).toEqual(adopted);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: original.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(original);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: legacy.sequence } })).value).toBe(legacy.value);
  const replay = await prepareTaskFinalization(f.finalizer, f.finalization);
  expect(replay).toMatchObject({ ...f.prepared, retirement: { authorityRevision: adopted.revision, doneHandoff: { expectedState: "Done", state: "Done" } } });
  await expect(confirmTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("unreleased");
  await db.prisma.remoteTaskResource.updateMany({ data: { state: "released" } });
  git(f.root, "worktree", "remove", f.worktree);
  const confirmed = await confirmTaskFinalization(f.finalizer, f.finalization);
  expect(confirmed).toMatchObject({ ...replay, confirmedRevision: expect.any(Number) });
  expect(await confirmTaskFinalization(f.finalizer, f.finalization)).toEqual(confirmed);
  expect(f.issue.state.name).toBe("Done");
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.preparation.value);
});

test("an interrupted waiting primary continues the same preparation only after the authenticated supplement commits", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  const request = await f.request();
  await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("complete");
  expect((await prepareTaskFinalization(f.finalizer, f.finalization)).preparedRevision).toBe(f.prepared.preparedRevision);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.preparation.value);
});

test.each(["pause", "branch", "pin", "contract", "verification", "preparation", "resource"])("%s change invalidates the supplement without rewriting historical proof", async changed => {
  const f = await fixture(), request = await f.request();
  await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (changed === "branch") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { branchName: "foreign" } });
  if (changed === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
  if (changed === "contract") await setCompletionContract({ ...f.context, contract: CompletionContractInput.parse({ requestKey: "revoked", expectedRevision: f.contract.revision, boundary: "revoked", basis: "Owner stopped" }) });
  if (changed === "verification") await recordCompletionVerification({ ...f.context, verification: { requestKey: "new", passed: true, evidence: ["new verification"] } });
  if (changed === "preparation") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key: "another", value: f.preparation.value } });
  if (changed === "resource") await db.prisma.remoteTaskResource.updateMany({ data: { metadata: { root: "/foreign/archive" } } });
  await expect(prepareTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow();
  await expect(adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies)).rejects.toThrow();
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.preparation.value);
});

test.each(["Blocked", "same Done newer version", "dirty original"])("%s during provider observation refuses adoption", async changed => {
  const f = await fixture(), request = await f.request();
  await expect(adoptDoneRetirement({ ...f.context, retirement: request }, { ...f.dependencies, remote: async (...args) => {
    if (changed === "Blocked") f.issue.state = { id: "blocked", name: "Blocked", type: "started" };
    if (changed === "same Done newer version") f.issue.updatedAt = "2026-10-30T11:00:00.000Z";
    if (changed === "dirty original") await writeFile(path.join(f.worktree, "README.md"), "new owner bytes");
    return f.dependencies.remote();
  } })).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(0);
});

test("owner API requires bearer even on the trusted control socket", async () => {
  const f = await fixture();
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskCompletionRoutes);
  expect((await app.request("/api/tasks/task/completion/delivered-retirement", { method: "PUT", body: JSON.stringify(await f.request()), headers: { "Content-Type": "application/json" } })).status).toBe(401);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(0);
});
async function fixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture"); git(root, "worktree", "add", "-b", "codex/task", worktree);
  const repository = testConfig().repository;
  const config = testConfig({ repository: { ...repository, root, workflows: { ...repository.workflows, merge: { ...repository.workflows.review!, id: "merge", when: [{ "issue.state": ["Merge"] }] } } } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: directory, toolingRevision: "a".repeat(40), pinnedToolingRoot: directory, phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "unresolved-clerk", kind: "clerk-session", purpose: "development", externalId: "fixture-only-clerk", state: "ready" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "blocked", name: "Blocked", type: "started" }, { id: "review", name: "Manual Review", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", updatedAt: "2026-10-30T04:00:00.000Z", branchName: "codex/task", title: "Task", description: "Request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const context = { prisma: db.prisma, config, taskId: "task" };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "original-owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "original-verified", passed: true, evidence: ["Accepted original content"] } });
  const head = git(worktree, "rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const finalizer = { prisma: db.prisma, config, sessionId: session.id, requestKey: "finalize:task" };
  const finalizationDependencies = { source: async () => ({ session, link, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, { ...completionObservation, remote: async () => remote }), snapshot: completionObservation.snapshot };
  const prepared = await prepareTaskFinalization(finalizer, finalizationDependencies);
  const preparation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.preparedRevision } });

  issue.state = { id: "done", name: "Done", type: "completed" };
  const remoteObservation = async () => ({ id: "retirement", repository: "owner/product", pullRequest: 12, url: remote.pullRequest.url, reviewedHead: head, mergeCommit: remote.pullRequest.mergeCommit.oid, mergedAt: new Date(0).toISOString(), baseHead: remote.remoteBase, ci: [] });
  const dependencies = { source: finalizationDependencies.source, snapshot: completionObservation.snapshot, remote: remoteObservation };
  const finalization = { ...finalizationDependencies, retirementRemote: remoteObservation };
  const request = async () => { const observed = await inspectDoneRetirement(context, dependencies); return DoneRetirementInput.parse({ version: 1, mode: "existing-preparation", requestKey: "done-retirement:fixture", expectedRevision: observed.revision, expectedBindingDigest: observed.bindingDigest, preparedRevision: observed.preparedRevision, preparedDigest: observed.preparedDigest, source: observed.source, basis: "Human standing authorization: finish delivered tasks and cleanup" }); };
  return { root, worktree, config, link, session, issue, context, contract, finalizer, finalization, prepared, preparation, dependencies, request };
}
