import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskRoutes } from "../../routes/tasks/index.ts";
import { taskSupervisionRoutes } from "../../routes/tasks/supervision.ts";
import { DeliveredRetirementInput } from "./external-delivery-schema.ts";
import { externalBindingDependencies } from "./external-deliveries.ts";
import { adoptLegacyDelivery, inspectLegacyDelivery, legacyDeliveryDependencies } from "./legacy-delivery.ts";
import { confirmExternalFinalization, prepareExternalFinalization } from "./external-finalization.ts";
import { observeDeliveredScope } from "./delivered-retirement-observation.ts";
import { revokeDeliveredRetirement } from "./delivered-retirement-revocation.ts";
import { assertPreparedCleanup, CLEANUP_OPERATION } from "./cleanup-lifecycle.ts";
import { cleanupReportDelivery, cleanupProjection, publishCleanupReport } from "./cleanup-report.ts";
import { recordCleanupProgress } from "./cleanup-progress.ts";
import { cleanupCandidates } from "./cleanup-candidates.ts";
import { enqueueTaskCleanup, cleanupInstructionAllows } from "./cleanup-inbox.ts";
import { startRuntimeEventProjection } from "../sessions/runtime-events/projection.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "external-cleanup-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function adoptedFixture() {
  const f = await fixture();
  await db.prisma.remoteTaskResource.create({ data: { id: "pr-resource", taskId: "task", key: "accepted-pr", kind: "pull-request", purpose: "development", externalId: "https://github.com/owner/product/pull/4190", state: "ready" } });
  const adopted = await adoptLegacyDelivery({ ...f.context, retirement: await f.request() }, f.dependencies);
  return { ...f, adopted, input: { ...f.finalizer, cleanup: true as const } };
}

test("128 actual control-route renewals stay local, preserve retention, and enforce pause after restart", async () => {
  const f = await adoptedFixture(), bound = await prepareExternalFinalization(f.input, f.dependencies);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  let taskReads = 0;
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .use("*", async (c, next) => { if (c.req.method === "GET") taskReads++; await next(); }).route("/api/tasks", taskRoutes);
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: app.fetch });
  const request = { requestKey: f.input.requestKey, finalizationVersion: 2, cleanup: true, authorityOnly: true };
  const renew = async () => {
    const response = await fetch("http://local/api/tasks/task/prepare-finalization", { unix: socket, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(1000) });
    return { status: response.status, body: await response.json() };
  };
  const compact = async () => {
    const response = await fetch("http://local/api/tasks/task/cleanup-authority", { unix: socket, method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestKey: request.requestKey, finalizationVersion: 2 }), signal: AbortSignal.timeout(1000) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const before = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }), start = performance.now();
    for (let batch = 0; batch < 128; batch++) {
      if (batch === 64) await db.prisma.$disconnect();
      expect(await renew()).toEqual({ status: 200, body: bound });
    }
    const acknowledged = await compact();
    expect(acknowledged).toEqual({ status: 200, body: { version: 1, taskId: bound.taskId, sessionId: bound.sessionId,
      requestKey: bound.requestKey, preparedRevision: bound.preparedRevision, cleanup: bound.cleanup } });
    expect(JSON.stringify(acknowledged.body).length).toBeLessThan(512);
    expect(performance.now() - start).toBeLessThan(10_000); expect(taskReads).toBe(0);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(before);
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    expect((await renew()).status).toBe(409);
    expect((await compact()).status).toBe(409);
  } finally { await server.stop(true); }
}, 30_000);

test("owner pause during full target observation prevents binding the initial local epoch", async () => {
  const f = await adoptedFixture();
  const original = await prepareExternalFinalization(f.finalizer, f.dependencies);
  const dependencies = { ...f.dependencies, assertResources: async (...args: Parameters<typeof f.dependencies.assertResources>) => {
    await f.dependencies.assertResources(...args);
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  } };
  await expect(prepareExternalFinalization(f.input, dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.preparedRevision } })).action).toBe("finalization-prepared");
});

for (const loseConfirmationResponse of [false, true]) test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)(`actual Drafted v2 destroy preserves recorded branch, closes on confirmed cleanup and resumes its report (lost confirmation=${loseConfirmationResponse})`, async () => {
  const f = await adoptedFixture();
  f.issue.state = { id: "custom", name: "Keep this owner status", type: "started" };
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  const savedDependencies = { ...externalBindingDependencies }, savedReport = { ...cleanupReportDelivery };
  const comments = new Map<string, { id: string; issue: { id: string }; body: string }>(); let writes = 0, offline = true;
  Object.assign(externalBindingDependencies, f.dependencies);
  Object.assign(cleanupReportDelivery, { read: async () => { if (offline) throw new Error("Fixture reporting offline"); return f.issue; },
    comment: async (_token: unknown, id: string) => comments.get(id) ?? null,
    create: async (_token: unknown, data: { id?: string; issueId: string; body: string }) => { writes++; comments.set(data.id!, { id: data.id!, issue: { id: data.issueId }, body: data.body }); return { id: data.id }; } });
  const runtime = createFakeAgentRuntime([{ id: "primary", cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine, role: "primary", status: "idle" }]);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient }))
    .route("/api/tasks", taskRoutes).route("/api/tasks", taskSupervisionRoutes);
  let lostResponse = false;
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: async req => {
    const response = await app.fetch(req);
    if (loseConfirmationResponse && !lostResponse && new URL(req.url).pathname.endsWith("confirm-finalization") && response.ok) {
      const value = await response.clone().json() as any;
      if (value.confirmation?.state === "ready") { lostResponse = true; await Bun.sleep(1200); }
    }
    return response;
  } }); await chmod(socket, 0o600);
  // HTTP acknowledges full checks; the existing projection lifecycle owns their
  // execution. Keep its real v1/v2 dispatcher and only fake external providers.
  const stopPreparation = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime }, async () => {});
  try {
    const { taskRegistry } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
    const { finalizeTask } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/finalize.ts"));
    let registry = taskRegistry(socket, "task", loseConfirmationResponse ? 1000 : 20_000);
    const close = async () => {
      const response = await app.request("/api/tasks/task/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", cleanup: true }) });
      if (!response.ok) throw new Error(await response.text());
    };
    if (loseConfirmationResponse) {
      // Confirmation committed and its HTTP reply was lost; interrupt before
      // closure as a separate process continuation boundary.
      await expect(finalizeTask({ registry, close: async () => { throw new Error("fixture interrupted before closure"); }, cleanup: true })).rejects.toThrow("fixture interrupted before closure");
      expect(lostResponse).toBeTrue();
    }
    const first = await finalizeTask({ registry, close, cleanup: true, ...(loseConfirmationResponse ? { runner: async () => { throw new Error("Confirmed continuation must not re-enter removal"); } } : {}) });
    expect(first).toMatchObject({ closed: true, branch: "staging", reporting: { state: "pending" } });
    const attempts = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "finalization-preparation-accepted" } });
    const preparationStates = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "finalization-preparation-status" } });
    expect(attempts.length).toBeGreaterThan(0);
    expect(preparationStates.some(event => JSON.parse(event.value!).state === "failed")).toBeFalse();
    for (const attempt of attempts) {
      expect(JSON.parse(attempt.value!).input.finalizationVersion).toBe(2);
      expect(preparationStates.some(event => event.key === String(attempt.sequence) && JSON.parse(event.value!).state === "ready"
        && JSON.parse(event.value!).result.version === 2)).toBeTrue();
    }
    const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
    expect(task).toMatchObject({ phase: "closed", branchName: "codex/original-task", toolingRevision: "a".repeat(40), primarySessionId: "primary" });
    expect(runtime.closedSessionIds).toEqual(["primary"]); expect(git(f.root, "worktree", "list", "--porcelain")).not.toContain(f.worktree);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "pr-resource" } })).state).toBe("ready");
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
    await db.prisma.$disconnect(); registry = taskRegistry(socket, "task", 20_000); offline = false;
    const retry = await finalizeTask({ registry, close, cleanup: true });
    expect(retry).toMatchObject({ alreadyClosed: true, reporting: { state: "published" } }); expect(writes).toBe(1); expect(f.issue.state.id).toBe("custom");
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
  } finally { await stopPreparation(); await server.stop(true); Object.assign(externalBindingDependencies, savedDependencies); Object.assign(cleanupReportDelivery, savedReport); }
}, 30_000);

test("existing v2 preparation continues in waiting/custom status with one raw receipt and one shared operation", async () => {
  const f = await adoptedFixture();
  const original = await prepareExternalFinalization(f.finalizer, f.dependencies);
  const frozen = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.preparedRevision } });
  f.issue.state = { id: "custom", name: "Owner follow-up status", type: "started" };
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  const dependencies = { ...f.dependencies, source: async () => { throw new Error("No recurring source read"); } };
  const bound = await prepareExternalFinalization(f.input, dependencies);
  expect(bound).toMatchObject(original); expect(bound.cleanup?.operationRevision).toBeGreaterThan(original.preparedRevision);
  await db.prisma.$disconnect();
  const noObservations = { ...dependencies, delivered: async () => { throw new Error("No provider on renewal"); }, assertResources: async () => { throw new Error("No filesystem on renewal"); } };
  expect(await prepareExternalFinalization({ ...f.input, authorityOnly: true }, noObservations)).toEqual(bound);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: frozen.sequence } })).value).toBe(frozen.value);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: ["completion-contract", "completion-verification", "completion-owner-approval"] } } })).toBe(0);
  const progress = await recordCleanupProgress({ ...f.context, progress: { requestKey: f.input.requestKey, ...bound.cleanup!, outcomes: [] } });
  expect(progress.resources).toEqual([{ id: "pr-resource", key: "accepted-pr", state: "ready", outcome: "retained" }]);
  expect(f.issue.state.id).toBe("custom");
});

test("first v2 preparation uses accepted delivery across status change without inventing an original merge", async () => {
  const f = await adoptedFixture();
  f.issue.state = { id: "blocked", name: "Blocked", type: "started" };
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  const result = await prepareExternalFinalization(f.input, { ...f.dependencies, source: async () => { throw new Error("No status authorization"); } });
  expect(result.cleanup).toBeDefined(); expect(result.contractRevision).toBeNull();
  expect(result.branch).toBe("staging"); expect(result.deliveredRetirement?.recordedBranch).toBe("codex/original-task");
  expect(result.delivery.deliveries[0]?.reviewedHead).toBe(f.reviewed);
});

test.each(["pause", "pin", "recorded-branch", "binding", "resource", "revocation"])("v2 local renewals reject changed %s without rebinding", async changed => {
  const f = await adoptedFixture(), prepared = await prepareExternalFinalization(f.input, f.dependencies);
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (changed === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "b".repeat(40) } });
  if (changed === "recorded-branch") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { branchName: "another" } });
  if (changed === "binding") await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.adopted.revision }, data: { value: "{}" } });
  if (changed === "resource") await db.prisma.remoteTaskResource.update({ where: { id: "pr-resource" }, data: { externalId: "https://github.com/foreign/repo/pull/1" } });
  if (changed === "revocation") await revokeDeliveredRetirement({ prisma: db.prisma, taskId: "task", revocation: { requestKey: "stop", expectedRevision: f.adopted.revision, basis: "Owner withdrew cleanup" } });
  await expect(prepareExternalFinalization({ ...f.input, authorityOnly: true }, f.dependencies)).rejects.toThrow();
  await expect(prepareExternalFinalization(f.input, f.dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  expect(prepared.cleanup).toBeDefined();
});

test("confirmation/report transactions retry once, close through the actual route, and report after closure without changing source status", async () => {
  const f = await adoptedFixture(), prepared = await prepareExternalFinalization(f.input, f.dependencies);
  git(f.root, "worktree", "remove", f.worktree);
  await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_report BEFORE INSERT ON RuntimeMetadataEvent WHEN NEW.action = 'finalization-cleanup-report' BEGIN SELECT RAISE(ABORT, 'lost local report acknowledgement'); END");
  await expect(confirmExternalFinalization(f.input, f.dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-resource-proof" } })).toBe(0);
  await db.prisma.$executeRawUnsafe("DROP TRIGGER fail_report");
  const confirmed = await confirmExternalFinalization(f.input, f.dependencies);
  await db.prisma.$disconnect();
  expect(await confirmExternalFinalization(f.input, f.dependencies)).toEqual(confirmed);
  const report = await db.prisma.runtimeIssueUpdate.findFirstOrThrow();
  expect(report.input).not.toHaveProperty("state"); expect(report.input).not.toHaveProperty("expectedState");
  expect((report.input as { body: string }).body).toContain(`reviewed ${f.reviewed}, merged ${f.merge}`);
  const runtime = createFakeAgentRuntime([{ id: "primary", cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine, role: "primary", status: "idle" }]);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient })).route("/api/tasks", taskSupervisionRoutes);
  const response = await app.request("/api/tasks/task/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", cleanup: true }) });
  expect(response.status).toBe(200); expect(runtime.closedSessionIds).toEqual(["primary"]);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("closed");
  const comments = new Map<string, { id: string; issue: { id: string }; body: string }>(); let writes = 0;
  const client = { ...cleanupReportDelivery, read: async () => f.issue, comment: async (_token: unknown, id: string) => comments.get(id) ?? null,
    create: async (_token: unknown, data: { id?: string; issueId: string; body: string }) => { writes++; comments.set(data.id!, { id: data.id!, issue: { id: data.issueId }, body: data.body }); throw new Error("Lost response after publication"); } };
  f.issue.state = { id: "later", name: "Later owner choice", type: "started" };
  const reportInput = { ...f.context, requestKey: f.input.requestKey };
  await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_report_ack BEFORE UPDATE OF published ON RuntimeIssueUpdate BEGIN SELECT RAISE(ABORT, 'lost local acknowledgement'); END");
  await expect(publishCleanupReport(reportInput, client)).rejects.toThrow();
  await db.prisma.$executeRawUnsafe("DROP TRIGGER fail_report_ack"); await db.prisma.$disconnect();
  expect((await publishCleanupReport(reportInput, client)).published).toBe(true); expect(writes).toBe(1); expect(f.issue.state.id).toBe("later");
  expect(await cleanupProjection(db.prisma, f.config, { id: "task", primarySessionId: "primary" })).toMatchObject({ cleanupOperation: { preparedRevision: prepared.preparedRevision, confirmedRevision: confirmed.confirmedRevision, reportingPending: false } });
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: "finalization-resource-proof" } });
  await expect(publishCleanupReport(reportInput, client)).rejects.toThrow("proof is missing");
});

test("external acceptance schedules the existing inbox without a fabricated contract and preserves late human work", async () => {
  const f = await adoptedFixture();
  const task = await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  expect((await cleanupCandidates(db.prisma, f.config, [task])).has(task.id)).toBe(true);
  const capability = async () => ({ receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
    taskToolingRevision: task.toolingRevision, capabilityRevision: "b".repeat(40), checkout: "/immutable", instructions: "/immutable/cleanup.md", adapter: "/immutable/cli.ts" }, instructions: "Fixture cleanup capability" });
  const enqueue = (requestKey: string) => enqueueTaskCleanup({ ...f.context, requestKey }, { capability });
  const first = await enqueue("pass-1"); expect(await enqueue("pass-1")).toEqual(first); expect(await enqueue("pass-2")).toEqual(first);
  await db.prisma.runtimeInstruction.create({ data: { id: "human", sessionId: "primary", text: "New work", state: "queued" } });
  expect(await cleanupInstructionAllows(db.prisma, { id: first.instructionId, sessionId: "primary" })).toBe(false);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "human" } })).state).toBe("queued");
  await db.prisma.runtimeInstruction.update({ where: { id: "human" }, data: { state: "completed" } });
  const second = await enqueue("pass-3"); expect(second.instructionId).not.toBe(first.instructionId);
  await db.prisma.runtimeInstruction.update({ where: { id: second.instructionId }, data: { state: "dispatching", executionRequestId: "cleanup-turn" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "turn-started", runtimeSessionId: "primary", requestId: "cleanup-turn", phase: "started", occurredAt: new Date() } });
  await prepareExternalFinalization(f.input, f.dependencies);
  expect((await assertPreparedCleanup(f.input)).operation.automatic?.initialInstructionId).toBe(second.instructionId);
  await db.prisma.runtimeInstruction.create({ data: { id: "late-human", sessionId: "primary", text: "New work", state: "queued" } });
  await expect(prepareExternalFinalization({ ...f.input, authorityOnly: true }, f.dependencies)).rejects.toThrow("pending task instructions");
  await expect(confirmExternalFinalization(f.input, f.dependencies)).rejects.toThrow("pending task instructions");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "completion-contract" } })).toBe(0);
});
async function fixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  git(root, "remote", "add", "origin", "https://github.com/owner/product.git");
  await writeFile(path.join(root, "README.md"), "accepted PR content\n"); git(root, "add", "."); git(root, "commit", "-m", "reviewed");
  const reviewed = git(root, "rev-parse", "HEAD");
  git(root, "commit", "--allow-empty", "-m", "accepted merge"); const merge = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", "-b", "staging", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-8", primarySessionId: session.id, branchName: "codex/original-task", worktreePath: worktree, toolingRoot: directory, toolingRevision: "a".repeat(40), pinnedToolingRoot: directory, phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-8", relationship: "handles" } });
  const issue = { id: "issue", identifier: "DRA-8", updatedAt: "2026-10-30T04:00:00.000Z", branchName: "codex/original-task", title: "Task", description: "Request", state: { id: "done", name: "Done", type: "completed" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const delivery = { id: "accepted", repository: "owner/product", pullRequest: 4190, branch: "codex/original-task", reviewedHead: reviewed, expectedMergeCommit: merge, baseBranch: "staging", requiredChecks: ["CI / CI Passed"] };
  const context = { prisma: db.prisma, config, taskId: "task" }, finalizer = { ...context, sessionId: session.id, requestKey: "finalize:task", finalizationVersion: 2 as const };
  let fault = "";
  const client = { run: async (_command: string, args: string[]) => {
    const endpoint = args[1] ?? "";
    let value: unknown;
    if (args[0] === "pr") value = fault === "missing required" ? [] : [{ name: "CI / CI Passed", state: "SUCCESS", link: "https://provider.test/check/17" }];
    else if (endpoint.includes("/pulls/")) value = { number: 4190, html_url: "https://github.com/owner/product/pull/4190", state: "closed", draft: false, merged: true, merge_commit_sha: merge, merged_at: "2026-10-28T04:00:00.000Z", head: { sha: reviewed, ref: delivery.branch, repo: { full_name: delivery.repository } }, base: { ref: "staging", repo: { full_name: delivery.repository } } };
    else if (endpoint.includes("/compare/")) value = { status: "identical", merge_base_commit: { sha: fault === "wrong ancestry" ? reviewed : merge } };
    else if (endpoint.includes("/check-runs")) value = { total_count: 1, check_runs: [{ id: 17, name: "CI / CI Passed", head_sha: fault === "wrong head" ? merge : reviewed, status: "completed", conclusion: fault === "failed" ? "failure" : "success", html_url: fault === "wrong app link" ? "https://foreign.test/check" : "https://provider.test/check/17", app: { id: 23 } }] };
    else if (endpoint.includes("/status?")) value = { sha: reviewed, total_count: 0, statuses: [] };
    else value = { sha: merge };
    return { ok: true, stdout: JSON.stringify(value), stderr: "" };
  } };
  const dependencies = { ...legacyDeliveryDependencies, source: async () => ({ session, link, config, issue }), delivered: (input: typeof delivery) => observeDeliveredScope(input, client) };
  const request = async () => { const observed = await inspectLegacyDelivery(context, dependencies); return DeliveredRetirementInput.parse({ version: 1, mode: "legacy-delivery", requestKey: "present-day-retirement", expectedBindingRevision: observed.revision, expectedIdentityDigest: observed.identityDigest, source: observed.source, basis: "Standing owner direction to finish delivered non-workflow work", cleanupSnapshot: observed.cleanupSnapshot, deliveries: [delivery], mergeOrder: [delivery.id], resourceIds: observed.resources.map(resource => resource.id), ownership: { ownedPaths: [] } }); };
  return { root, worktree, reviewed, merge, session, issue, config, context, finalizer, dependencies, delivery, client, request, set providerFault(value: string) { fault = value; } };
}

test("shared cleanup requires independent adapter absence even after a generic Released update", async () => {
  const { prepareFinalizationResources, assertFinalizationResources, finalizationResourceObservation, finalizationResourceIdentity } = await import("./finalization-resources.ts");
  const { CleanupObserverBatchInput, CleanupTarget, cleanupTargetDigest } = await import("./cleanup-observer-schema.ts");
  const f = await fixture();
  const record = await db.prisma.remoteTaskResource.create({ data: { id: "container", taskId: "task", key: "original-container", kind: "docker-container", purpose: "development", externalId: "c".repeat(64), state: "ready", metadata: { image: "owned-image" } } });
  const capability = { version: 1 as const, source: "configured-host" as const, checkout: directory, revision: "b".repeat(40), adapter: path.join(directory, "cleanup.ts"), adapterSha256: "d".repeat(64) };
  let present = true, observations = 0;
  const observation = { ...finalizationResourceObservation, adapters: async ({ request }: { request: unknown }) => {
    observations++;
    const input = CleanupObserverBatchInput.parse(request);
    expect(input.task).toEqual({ id: "task", primarySessionId: "primary", worktreePath: f.worktree, toolingRevision: "a".repeat(40) });
    const rawTargets = input.observations[0]!.expectedTargets ?? [{ kind: "docker-container", id: record.externalId, presentAtPrepare: true, identityDigest: "e".repeat(64), scope: { taskId: "task", purpose: "development" }, identity: { createdAt: "2026-10-30T00:00:00Z", labelsDigest: "f".repeat(64), image: "owned-image", networks: [], volumes: [] } }];
    const targets = rawTargets.map(target => { const value = CleanupTarget.parse(target); return { ...value, identityDigest: cleanupTargetDigest(value) }; });
    return { version: 1, taskId: "task", observations: [{ version: 1, taskId: "task", resourceId: record.id, resourceIdentityDigest: finalizationResourceIdentity(record).identityDigest,
      dependencies: [], stoppedConsumers: [], adapter: "docker", targets, presentTargetDigests: present ? targets.map(target => target.identityDigest) : [], absent: !present }] };
  } };
  const dependencies = { ...f.dependencies, cleanupObserver: async () => capability,
    resources: (input: Parameters<typeof prepareFinalizationResources>[0]) => prepareFinalizationResources(input, observation),
    assertResources: (input: Parameters<typeof assertFinalizationResources>[0]) => assertFinalizationResources(input, observation) };
  const adopted = await adoptLegacyDelivery({ ...f.context, retirement: await f.request() }, dependencies);
  expect(observations).toBe(2);
  expect(adopted.binding.resources[0]).toMatchObject({ id: record.id, disposition: "retire-adapter", observer: { capability }, adapter: "docker" });
  const input = { ...f.finalizer, cleanup: true as const };
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  f.issue.state = { id: "blocked", name: "Blocked", type: "started" };
  const prepared = await prepareExternalFinalization(input, dependencies);
  await db.prisma.remoteTaskResource.update({ where: { id: record.id }, data: { state: "released" } });
  git(f.root, "worktree", "remove", f.worktree);
  await expect(confirmExternalFinalization(input, dependencies)).rejects.toThrow("independently verified");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(0);
  present = false;
  const confirmed = await confirmExternalFinalization(input, dependencies);
  expect(confirmed.preparedRevision).toBe(prepared.preparedRevision);
  expect(await confirmExternalFinalization(input, dependencies)).toEqual(confirmed);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).toolingRevision).toBe("a".repeat(40));
  expect(f.issue.state.name).toBe("Blocked");
});

test("queued external cleanup refresh preserves its accepted binding, preparation and operation bytes", async () => {
  const { createHash } = await import("node:crypto");
  const { refreshQueuedCleanupInstruction, CLEANUP_INSTRUCTION, CLEANUP_SUPERSEDED } = await import("./cleanup-inbox.ts");
  const f = await adoptedFixture();
  const prepared = await prepareExternalFinalization(f.input, f.dependencies);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  f.config.repository.tooling = { root: directory, revision: "b".repeat(40) };
  f.config.repositories = { ...f.config.repositories, [f.config.repository.id]: f.config.repository };
  const capability = async () => {
    const revision = f.config.repository.tooling!.revision;
    const receipt = { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
      taskToolingRevision: "a".repeat(40), capabilityRevision: revision, checkout: `${directory}/${revision}`, instructions: `${directory}/${revision}/cleanup.md`, adapter: `${directory}/${revision}/src/cli.ts` };
    const key = `task:${createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`;
    if (!await db.prisma.runtimeMetadataEvent.findFirst({ where: { action: "tooling-capability", key } })) await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key, value: JSON.stringify(receipt) } });
    return { receipt, instructions: `Reviewed capability ${revision}` };
  };
  const queued = await enqueueTaskCleanup({ ...f.context, requestKey: "original-external-cleanup" }, { capability });
  const marker = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: CLEANUP_INSTRUCTION, key: queued.instructionId } });
  const original = JSON.parse(marker.value!); expect(original.externalBinding).toBeDefined(); expect(original.contractRevision).toBeUndefined();
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { lte: marker.sequence } }, orderBy: { sequence: "asc" } });
  const taskBefore = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  f.config.repository.tooling.revision = "c".repeat(40);
  const runtime = createFakeAgentRuntime([{ id: "primary", cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine, role: "primary", status: "idle" }]);
  expect(await refreshQueuedCleanupInstruction({ prisma: db.prisma, config: f.config, runtime, receipt: { id: queued.instructionId, sessionId: "primary" } }, { capability })).toBe(false);
  const successor = await db.prisma.runtimeInstruction.findFirstOrThrow({ where: { state: "queued" } });
  const current = JSON.parse((await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: CLEANUP_INSTRUCTION, key: successor.id } })).value!);
  expect(current.externalBinding).toEqual(original.externalBinding);
  expect({ ...current, capability: original.capability }).toEqual(original);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { lte: marker.sequence } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).toEqual(taskBefore);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_SUPERSEDED } })).toBe(1);
  expect(await prepareExternalFinalization({ ...f.input, authorityOnly: true }, f.dependencies)).toEqual(prepared);
});
