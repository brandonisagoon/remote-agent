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
import { cleanupResumeDependencies, inspectCleanupResume, resumePreparedCleanup } from "./cleanup-resume.ts";
import { CLEANUP_RESUME, CLEANUP_RESUME_CONFIRMED, CleanupResumeInput } from "./cleanup-resume-schema.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";
import { handleIssueWebhook } from "../../integrations/linear/webhooks/issue/handler.ts";
import { isCleanupResumeWebhook } from "./cleanup-resume-webhook.ts";
import type { LinearIssueWebhook } from "../../integrations/linear/webhook-types/index.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "cleanup-resume-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("existing agent publication cannot resume cleanup; owner continuation preserves the exact preparation and unresolved resources", async () => {
  const f = await fixture();
  await expect(prepareTaskFinalization(f.finalizer, f.finalizationDependencies)).rejects.toThrow("current owner Merge");
  await expect(publishSessionIssueUpdate({ ...f.finalizer, requestKey: "agent-resume", body: "Resume cleanup", state: "Merge", expectedState: "Blocked", evidence: [] }, { ...issueUpdateDelivery, source: f.finalizationDependencies.source, read: async () => f.issue })).rejects.toThrow("agents cannot select it");
  expect(f.writes()).toBe(0);
  const original = await f.identities();
  const result = await resumePreparedCleanup({ ...f.context, resume: await f.request() }, f.dependencies);
  expect(result).toMatchObject({ alreadyCompleted: false, phase: "complete", sourceState: "Merge", preparedRevision: f.prepared.preparedRevision });
  expect(await prepareTaskFinalization(f.finalizer, f.finalizationDependencies)).toEqual(f.prepared);
  expect(await f.identities()).toEqual(original);
  expect(f.writes()).toBe(1);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: "unresolved-clerk" } } })).state).toBe("ready");
  await expect(confirmTaskFinalization(f.finalizer, f.finalizationDependencies)).rejects.toThrow("unreleased task resources");
});

test.each(["lost response", "confirmation transaction"])("same request recovers %s without a second source write", async failure => {
  const f = await fixture(), request = await f.request();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "blocked" } });
  let failed = false;
  if (failure === "confirmation transaction") await db.prisma.$executeRawUnsafe(`CREATE TRIGGER fail_cleanup_confirmation BEFORE INSERT ON RuntimeMetadataEvent WHEN NEW.action = '${CLEANUP_RESUME_CONFIRMED}' BEGIN SELECT RAISE(ABORT, 'confirmation unavailable'); END`);
  const dependencies = { ...f.dependencies, update: async (...args: Parameters<typeof f.dependencies.update>) => { await f.dependencies.update(...args); if (failure === "lost response" && !failed) { failed = true; throw new Error("Lost source response"); } } };
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, dependencies)).rejects.toThrow();
  expect(f.issue.state.name).toBe("Merge"); expect(f.writes()).toBe(1);
  const recovered = await inspectCleanupResume(f.context, f.dependencies);
  expect(recovered.request).toEqual(request); expect(recovered.requestKey).toBe(request.requestKey);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("blocked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_RESUME } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_RESUME_CONFIRMED } })).toBe(0);
  if (failure === "confirmation transaction") await db.prisma.$executeRawUnsafe("DROP TRIGGER fail_cleanup_confirmation");
  const resumed = await resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies);
  const replay = await resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies);
  expect(replay).toEqual({ ...resumed, alreadyCompleted: true });
  expect(f.writes()).toBe(1);
  expect(await prepareTaskFinalization(f.finalizer, f.finalizationDependencies)).toEqual(f.prepared);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_RESUME_CONFIRMED } })).toBe(1);
  // Durable uniqueness comes from the real migration, not just an in-memory queue.
  const saved = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: CLEANUP_RESUME } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: saved.runtimeSessionId, source: saved.source, key: saved.key, action: saved.action, value: saved.value } }))).rejects.toThrow();
});

test("concurrent same-key retries finish once and cannot overwrite a later owner state", async () => {
  const f = await fixture(), request = await f.request();
  const results = await Promise.all([1, 2, 3].map(() => resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies)));
  expect(new Set(results.map(result => result.confirmedRevision)).size).toBe(1); expect(f.writes()).toBe(1);
  f.issue.state = f.states[1]!; f.issue.updatedAt = "2026-10-30T10:00:00.000Z";
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "blocked" } });
  expect(await resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies)).toMatchObject({ alreadyCompleted: true, sourceState: "Blocked", phase: "blocked" });
  expect(f.writes()).toBe(1);
});

test("a new Blocked revision resumes the same preparation after a second blocker without reviving the old attempt", async () => {
  const f = await fixture(), first = await f.request(), original = await f.identities();
  const resumed = await resumePreparedCleanup({ ...f.context, resume: first }, f.dependencies);
  f.issue.state = f.states[1]!; f.issue.updatedAt = "2026-10-30T11:00:00.000Z";
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "blocked" } });
  expect(await resumePreparedCleanup({ ...f.context, resume: first }, f.dependencies)).toMatchObject({ alreadyCompleted: true, phase: "blocked", sourceState: "Blocked" });
  expect(f.writes()).toBe(1);
  const second = await f.request();
  expect(second.requestKey).not.toBe(first.requestKey);
  expect(second.preparedRevision).toBe(first.preparedRevision);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  await expect(resumePreparedCleanup({ ...f.context, resume: first }, f.dependencies)).rejects.toThrow("unpaused");
  await expect(resumePreparedCleanup({ ...f.context, resume: second }, f.dependencies)).rejects.toThrow("unpaused");
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  const continued = await resumePreparedCleanup({ ...f.context, resume: second }, f.dependencies);
  expect(continued.confirmedRevision).not.toBe(resumed.confirmedRevision);
  expect(f.writes()).toBe(2);
  expect(await f.identities()).toEqual(original);
  expect(await prepareTaskFinalization(f.finalizer, f.finalizationDependencies)).toEqual(f.prepared);
  expect((await resumePreparedCleanup({ ...f.context, resume: second }, f.dependencies)).alreadyCompleted).toBeTrue();
  expect(f.writes()).toBe(2);
});

test("a pending request cannot adopt a later attempt's Merge transition", async () => {
  const f = await fixture(), first = await f.request();
  await expect(resumePreparedCleanup({ ...f.context, resume: first }, { ...f.dependencies, update: async () => { throw new Error("No effect"); } })).rejects.toThrow("No effect");
  f.issue.updatedAt = "2026-10-30T11:00:00.000Z";
  const second = await f.request();
  await resumePreparedCleanup({ ...f.context, resume: second }, f.dependencies);
  await expect(resumePreparedCleanup({ ...f.context, resume: first }, f.dependencies)).rejects.toThrow("superseded");
  expect(f.writes()).toBe(1);
});

test.each(["pause", "closed", "pin", "contract", "verification", "preparation", "source link"])("changed %s prevents a pending resume from publishing", async changed => {
  const f = await fixture(), request = await f.request();
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, update: async () => { throw new Error("Before publication"); } })).rejects.toThrow("Before publication");
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (changed === "closed") await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed" } });
  if (changed === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "d".repeat(40) } });
  if (changed === "contract") await setCompletionContract({ ...f.context, contract: CompletionContractInput.parse({ requestKey: "revoked", expectedRevision: f.contract.revision, boundary: "revoked", basis: "Owner stopped" }) });
  if (changed === "verification") await recordCompletionVerification({ ...f.context, verification: { requestKey: "new-check", passed: true, evidence: ["New owner check"] } });
  if (changed === "preparation") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key: "another", value: f.preparation.value } });
  if (changed === "source link") await db.prisma.runtimeSessionResourceLink.update({ where: { id: f.link.id }, data: { endedAt: new Date() } });
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies)).rejects.toThrow();
  expect(f.writes()).toBe(0); expect(f.issue.state.name).toBe("Blocked");
});

test.each(["owner state", "same state newer revision", "pause", "dirty bytes"])("%s during observation refuses publication", async changed => {
  const f = await fixture(), request = await f.request();
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, remote: async (...args) => {
    if (changed === "owner state") f.issue.state = f.states[2]!;
    if (changed === "same state newer revision") f.issue.updatedAt = "2026-10-30T10:00:00.000Z";
    if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    if (changed === "dirty bytes") await writeFile(path.join(f.worktree, "README.md"), "new original work\n");
    return f.dependencies.remote(...args);
  } })).rejects.toThrow();
  expect(f.writes()).toBe(0);
});

test("a failed pending request cannot overwrite a later Blocked revision or adopt another service actor", async () => {
  const f = await fixture(), request = await f.request();
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, update: async () => { throw new Error("Transport unavailable"); } })).rejects.toThrow();
  f.issue.updatedAt = "2026-10-30T10:00:00.000Z";
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies)).rejects.toThrow("later owner decision");
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, source: async () => ({ viewer: { id: "human" }, issue: structuredClone(f.issue) }) })).rejects.toThrow("service actor");
  expect(f.writes()).toBe(0);
});

test("partial cleanup resumes only when missing original paths are independently unregistered", async () => {
  const f = await fixture(), request = await f.request();
  await rm(f.worktree, { recursive: true });
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies)).rejects.toThrow("remains registered");
  expect(f.writes()).toBe(0);
  git(f.root, "worktree", "remove", f.worktree);
  await resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies);
  expect(await prepareTaskFinalization(f.finalizer, f.finalizationDependencies)).toEqual(f.prepared);
  await expect(confirmTaskFinalization(f.finalizer, f.finalizationDependencies)).rejects.toThrow("unreleased task resources");
});

test("owner pause after the provider effect prevents phase recovery until the same task is unpaused", async () => {
  const f = await fixture(), request = await f.request();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "blocked" } });
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, update: async (...args) => {
    await f.dependencies.update(...args);
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  } })).rejects.toThrow("unpaused");
  expect(f.writes()).toBe(1);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("blocked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_RESUME_CONFIRMED } })).toBe(0);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  await resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies);
  expect(f.writes()).toBe(1);
});

test("a human credential or service subscribed as an approving owner cannot issue cleanup resume", async () => {
  const f = await fixture(), request = await f.request();
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, source: async () => ({ viewer: { id: "human" }, issue: structuredClone(f.issue) }) })).rejects.toThrow("service actor");
  const webhook = f.config.webhooks[f.config.activeWebhookId]!;
  const config = { ...f.config, webhooks: { ...f.config.webhooks, [webhook.id]: { ...webhook, repositoryRouting: { [f.config.activeRepositoryId]: { when: [{ "linear.userId": [f.config.agentUserId] }] } } } } };
  await expect(resumePreparedCleanup({ ...f.context, config, resume: request }, f.dependencies)).rejects.toThrow("service actor");
  // An owner API request has no webhook envelope. Its default webhook need not
  // be the one which subscribes to this task's connection and repository.
  const another = { ...f.config, webhooks: { ...f.config.webhooks, "other-subscription": { ...config.webhooks[webhook.id]!, id: "other-subscription" } } };
  await expect(resumePreparedCleanup({ ...f.context, config: another, resume: request }, f.dependencies)).rejects.toThrow("service actor");
  expect(f.writes()).toBe(0);
});

test("missing delivery ancestry and malformed or changed request keys never publish", async () => {
  const f = await fixture(), request = await f.request();
  await expect(resumePreparedCleanup({ ...f.context, resume: { ...request, requestKey: "other" } }, f.dependencies)).rejects.toThrow("stable request");
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, remote: async () => { throw new Error("Merge absent from current base"); } })).rejects.toThrow("current base");
  expect(f.writes()).toBe(0);
  await resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies);
  await expect(resumePreparedCleanup({ ...f.context, resume: { ...request, basis: "changed" } }, f.dependencies)).rejects.toThrow("immutable authority");
});

test("owner endpoint remains bearer-only on trusted IPC and rejects malformed requests", async () => {
  const f = await fixture(), app = new Hono<AppEnv>();
  app.use("*", contextMiddleware({ config: f.config, prisma: db.prisma, commandClient: bunCommandClient, agentRuntime: createFakeAgentRuntime() }));
  app.route("/api/tasks", taskCompletionRoutes);
  for (const method of ["GET", "POST"]) for (const authorization of [undefined, "Bearer session-key"]) {
    expect((await app.request("/api/tasks/task/completion/cleanup-resume", { method, headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })).status).toBe(401);
  }
  expect((await app.request("/api/tasks/task/completion/cleanup-resume", { method: "POST", headers: { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_RESUME } })).toBe(0);
  const original = { ...cleanupResumeDependencies };
  Object.assign(cleanupResumeDependencies, f.dependencies);
  try {
    const headers = { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" };
    const inspection = await app.request("/api/tasks/task/completion/cleanup-resume", { headers });
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toMatchObject({ eligible: true, preparedRevision: f.prepared.preparedRevision });
    const resumed = await app.request("/api/tasks/task/completion/cleanup-resume", { method: "POST", headers, body: JSON.stringify(await f.request()) });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ phase: "complete", sourceState: "Merge" });
  } finally { Object.assign(cleanupResumeDependencies, original); }
});

test("exact pending and confirmed service webhooks never enqueue Merge again; other actors and sources remain ordinary", async () => {
  const f = await fixture(), request = await f.request();
  await expect(resumePreparedCleanup({ ...f.context, resume: request }, { ...f.dependencies, update: async (...args) => { await f.dependencies.update(...args); throw new Error("Lost acknowledgment"); } })).rejects.toThrow();
  const webhook: LinearIssueWebhook = { type: "Issue", action: "update", actor: { id: f.config.agentUserId }, webhookTimestamp: Date.now(), data: { id: f.issue.id, identifier: f.issue.identifier, state: f.issue.state }, updatedFrom: { stateId: "blocked" } };
  const original = await f.identities();
  const invoke = () => handleIssueWebhook({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), deliveryId: "service-cleanup", webhook });
  expect(await invoke()).toEqual({ kind: "ignored" });
  await resumePreparedCleanup({ ...f.context, resume: request }, f.dependencies);
  expect(await invoke()).toEqual({ kind: "ignored" });
  expect(await db.prisma.webhookReceipt.count()).toBe(0); expect(await db.prisma.workerRun.count()).toBe(0);
  expect(await f.identities()).toEqual(original);
  for (const other of [{ ...webhook, actor: { id: "human-owner" } }, { ...webhook, data: { ...webhook.data, id: "another-issue" } }, { ...webhook, data: { ...webhook.data, state: { ...f.issue.state, id: "different-merge" } } }, { ...webhook, updatedFrom: { stateId: "other-state" } }, { ...webhook, webhookTimestamp: 0 }]) expect(await isCleanupResumeWebhook(db.prisma, f.config, other)).toBeFalse();
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
  issue.state = states[1]!;
  let writes = 0;
  const dependencies: typeof cleanupResumeDependencies = { ...cleanupResumeDependencies, source: async () => ({ viewer: { id: config.agentUserId }, issue: structuredClone(issue) }),
    update: async (_config, query, value) => { expect(query.id).toBe(issue.id); expect(value).toEqual({ stateId: "merge" }); writes++; issue.state = states[0]!; issue.updatedAt = "2026-10-30T05:00:00.000Z"; },
    remote: async () => ({ id: "retirement", repository: "owner/product", pullRequest: 12, url: remote.pullRequest.url, reviewedHead: head, mergeCommit: remote.pullRequest.mergeCommit.oid, mergedAt: new Date(0).toISOString(), baseHead: remote.remoteBase, ci: [] }) };
  const request = async () => { const inspected = await inspectCleanupResume(context, dependencies); return CleanupResumeInput.parse({ requestKey: inspected.requestKey, preparedRevision: inspected.preparedRevision, expectedBindingDigest: inspected.bindingDigest, expectedState: "Blocked", expectedStateId: inspected.expectedStateId, expectedUpdatedAt: inspected.expectedUpdatedAt, basis: "Continue only the existing approved cleanup" }); };
  const identities = async () => ({ events: await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["completion-contract", "completion-verification", FINALIZATION_PREPARED] } }, orderBy: { sequence: "asc" } }), resources: await db.prisma.remoteTaskResource.findMany(), task: { ...await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } }), updatedAt: undefined } });
  return { root, worktree, config, link, session, issue, states, context, contract, finalizer, finalizationDependencies, prepared, preparation, dependencies, request, identities, writes: () => writes };
}
