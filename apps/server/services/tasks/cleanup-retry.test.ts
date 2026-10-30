import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { enqueueTaskCleanup, cleanupInboxDependencies, automaticCleanupTurn } from "./cleanup-inbox.ts";
import { CLEANUP_RETRY_INPUT, CleanupRetryDeferred } from "./cleanup-retry.ts";
import { recordSourceMessage } from "../sessions/source-messages.ts";
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let db: TestDatabase;
const capability = cleanupInboxDependencies.capability;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { cleanupInboxDependencies.capability = capability; await db.cleanup(); });
async function fixture() {
  const config = testConfig();
  config.repository.tooling = { root: "/configured", revision: "b".repeat(40) };
  config.repositories = { ...config.repositories, [config.repository.id]: config.repository };
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: "/owned/task", repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: session.repositoryId!, machineId: session.machineId!, connectionId: config.activeConnectionId, issueIdentifier: "DRA-166", primarySessionId: session.id, branchName: "codex/task", worktreePath: session.cwd, toolingRoot: "/old", toolingRevision: "a".repeat(40), pinnedToolingRoot: "/old/pin", phase: "complete" } });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier!, relationship: "handles" } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: "owner:task", action: "completion-contract", key: "accepted", value: JSON.stringify({ boundary: "merge", verificationRequired: false }) } });
  let resolves = 0, now = Date.now(), onResolve: (() => Promise<void>) | undefined;
  const dependencies = { now: () => now, capability: async () => { resolves++; await onResolve?.(); return { receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const, taskToolingRevision: task.toolingRevision, capabilityRevision: config.repository.tooling!.revision, checkout: "/immutable", instructions: "/immutable/cleanup.md", adapter: "/immutable/src/cli.ts" }, instructions: "Use verified cleanup." }; } };
  const enqueue = (requestKey: string, retry?: "now") => enqueueTaskCleanup({ prisma: db.prisma, config, taskId: task.id, requestKey, retry }, dependencies);
  const finish = (id: string) => db.prisma.runtimeInstruction.update({ where: { id }, data: { state: "completed", executionRequestId: id, updatedAt: new Date(now) } });
  const resource = () => db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "owned", kind: "docker-container", purpose: "development", externalId: "exact-container", state: "ready", metadata: { identity: "frozen", observed: { time: 1 } } } });
  return { config, task, session, enqueue, finish, resource, dependencies, resolves: () => resolves, now: () => now, advance: (ms: number) => { now += ms; }, onResolve: (fn: () => Promise<void>) => { onResolve = fn; } };
}

test("a fresh upkeep key cannot immediately repeat an unchanged executed cleanup", async () => {
  const f = await fixture(), first = await f.enqueue("upkeep:first");
  await f.finish(first.instructionId);
  await expect(f.enqueue("upkeep:second")).rejects.toThrow("Cleanup retry deferred until");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect(f.resolves()).toBe(1);
});

test("backoff survives reconnect, increases from terminal time and caps at two hours", async () => {
  const f = await fixture();
  let attempt = await f.enqueue("one");
  for (const [index, minutes] of [30, 60, 120, 120].entries()) {
    f.advance(20 * 60_000); // Time spent executing does not consume the delay.
    await f.finish(attempt.instructionId); await db.prisma.$disconnect();
    f.advance(minutes * 60_000 - 1);
    await expect(f.enqueue(`early-${index}`)).rejects.toBeInstanceOf(CleanupRetryDeferred);
    f.advance(1); attempt = await f.enqueue(`due-${index}`);
  }
  expect(await db.prisma.runtimeInstruction.count()).toBe(5);
});

test("same-key replay, explicit retry and unknown/pending dedup preserve one original instruction", async () => {
  const f = await fixture(), first = await f.enqueue("one"); await f.finish(first.instructionId);
  expect(await f.enqueue("one", "now")).toMatchObject({ instructionId: first.instructionId, state: "completed" });
  const next = await f.enqueue("repair", "now");
  for (const state of ["queued", "dispatching", "unknown"] as const) {
    await db.prisma.runtimeInstruction.update({ where: { id: next.instructionId }, data: { state } });
    for (const retry of [undefined, "now"] as const) expect(await f.enqueue(`${state}:${retry}`, retry)).toMatchObject({ instructionId: next.instructionId, state });
  }
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_RETRY_INPUT } })).toBe(2);
  await expect(automaticCleanupTurn(db.prisma, f.task, true)).rejects.toThrow();
});

test("unstarted cancellation costs no delay and old immutable markers receive one snapshot attempt", async () => {
  const f = await fixture(), old = await f.enqueue("old");
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: CLEANUP_RETRY_INPUT } }); // Disposable pre-upgrade database.
  await f.finish(old.instructionId);
  const first = await f.enqueue("upgrade");
  await db.prisma.runtimeInstruction.update({ where: { id: first.instructionId }, data: { state: "cancelled", detail: "Deferred to owner work" } });
  const afterOwner = await f.enqueue("after-owner");
  await f.finish(afterOwner.instructionId);
  await expect(f.enqueue("unchanged")).rejects.toBeInstanceOf(CleanupRetryDeferred);
});

test.each(["resource", "proof", "capability", "native-proof"] as const)("a relevant %s change permits immediate retry and restarts the bounded delay", async kind => {
  const f = await fixture(), resource = await f.resource(), first = await f.enqueue("first"); await f.finish(first.instructionId);
  if (kind === "resource") await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { state: "released" } });
  if (kind === "proof") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: "finalizer-archives:task", action: "finalization-archive-retention", key: "finalize:task", value: '{"exact":"new-retained-proof"}' } });
  if (kind === "capability") f.config.repository.tooling!.revision = "c".repeat(40);
  if (kind === "native-proof") await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: { identity: "frozen", observed: { legacyNative: { proof: "immutable-proof", digest: "c".repeat(64) } } } } });
  const next = await f.enqueue("changed"); await f.finish(next.instructionId);
  f.advance(30 * 60_000); expect(await f.enqueue("due")).toMatchObject({ queued: true });
});

test("diagnostic/progress timestamps and routine observations never reset a failed attempt", async () => {
  const f = await fixture(), resource = await f.resource(), first = await f.enqueue("first"); await f.finish(first.instructionId);
  for (const action of ["finalization-cleanup-progress", "finalization-preparation-status", "finalization-preparation-accepted", "tooling-capability"]) await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: "finalizer:task", action, key: "fresh", value: '{"error":"same failure","timestamp":123}' } });
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: { identity: "frozen", observedAt: "changed", observed: { time: 2 } } } });
  await expect(f.enqueue("unchanged")).rejects.toBeInstanceOf(CleanupRetryDeferred);
});

test("only subscribed delivered owner work resets delay; informational native reports do not", async () => {
  const f = await fixture();
  f.config.webhooks = { ...f.config.webhooks, "linear-test": { ...f.config.webhooks["linear-test"]!, repositoryRouting: { [f.task.repositoryId]: { when: [{ "linear.userId": ["owner"] }] } } } };
  const first = await f.enqueue("first"); await f.finish(first.instructionId);
  const input = { provider: "linear", connectionId: f.task.connectionId!, repositoryId: f.task.repositoryId, machineId: f.task.machineId, resourceId: "issue", resourceIdentifier: f.task.issueIdentifier!, commentId: "native", threadRootId: "native", authorId: "owner", body: "Informational report", presentation: {} };
  const report = await recordSourceMessage(db.prisma, input);
  await db.prisma.runtimeSourceMessage.update({ where: { id: report.id }, data: { sessionId: f.session.id, state: "handled" } });
  await expect(f.enqueue("report")).rejects.toBeInstanceOf(CleanupRetryDeferred);
  // Even historical rows with request correlation cannot turn a separately
  // attested informational disposition into fresh owner input.
  await db.prisma.runtimeSourceMessage.update({ where: { id: report.id }, data: { requestId: "historical" } });
  await db.prisma.runtimeInstruction.create({ data: { id: "historical", sessionId: f.session.id, sourceMessageId: report.id, state: "completed", executionRequestId: "historical", text: report.body } });
  await db.prisma.runtimeSourceMessageResolution.create({ data: { sourceMessageId: report.id, requestKey: "native", fingerprint: "a".repeat(64), action: "record-native-report", reason: "Exact native report", outcome: "informational", evidence: {} } });
  await expect(f.enqueue("attested-report")).rejects.toBeInstanceOf(CleanupRetryDeferred);
  const owner = await recordSourceMessage(db.prisma, { ...input, commentId: "repair", threadRootId: "repair", body: "The credential was repaired" });
  await db.prisma.runtimeSourceMessage.update({ where: { id: owner.id }, data: { sessionId: f.session.id, state: "handled", requestId: "owner-turn" } });
  await db.prisma.runtimeInstruction.create({ data: { id: "owner-input", sessionId: f.session.id, sourceMessageId: owner.id, executionRequestId: "owner-turn", state: "completed", text: owner.body } });
  expect(await f.enqueue("after-owner")).toMatchObject({ queued: true });
});

test("the acceptance and pause guards still refuse an explicit retry", async () => {
  const f = await fixture(), first = await f.enqueue("first"); await f.finish(first.instructionId);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(f.enqueue("paused", "now")).rejects.toThrow("candidate");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: "owner:task", action: "completion-contract", key: "replaced", value: '{"boundary":"review"}' } });
  await expect(f.enqueue("revoked", "now")).rejects.toThrow("candidate");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("a terminal attempt arriving during resolution is rechecked before transport or enqueue", async () => {
  const f = await fixture(), first = await f.enqueue("first");
  f.onResolve(async () => { await f.finish(first.instructionId); });
  await expect(f.enqueue("racing-tick")).rejects.toBeInstanceOf(CleanupRetryDeferred);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("concurrent scheduling requests and explicit repair retries share one pending instruction", async () => {
  const f = await fixture(), first = await f.enqueue("first"); await f.finish(first.instructionId);
  const results = await Promise.all([f.enqueue("repair-a", "now"), f.enqueue("repair-b", "now")]);
  expect(results[0]!.instructionId).toBe(results[1]!.instructionId);
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
});

test("the authenticated route preserves the old success shape and rejects cooldown without dispatch", async () => {
  const f = await fixture(), first = await f.enqueue("first"); await f.finish(first.instructionId);
  cleanupInboxDependencies.capability = f.dependencies.capability;
  const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.session.cwd, repositoryId: f.task.repositoryId, machineId: f.task.machineId, status: "active", role: "primary", agent: "codex" }]);
  const app = createApp({ config: f.config, prisma: db.prisma, agentRuntime: runtime });
  const request = (body: unknown, authorized = true) => app.request("/api/tasks/task/cleanup-request", { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${f.config.apiKey}` } : {}) }, body: JSON.stringify(body) });
  expect((await request({ requestKey: "no-auth", retry: "now" }, false)).status).toBe(401);
  const blocked = await request({ requestKey: "upkeep:new" }); expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("Cleanup retry deferred until") });
  const repair = await request({ requestKey: "concrete-repair", retry: "now" }); expect(repair.status).toBe(202);
  const receipt = await repair.json(); expect(Object.keys(receipt).sort()).toEqual(["instructionId", "queued", "sessionId", "state", "taskId"]);
  expect(await (await request({ requestKey: "another-tick" })).json()).toEqual(receipt);
  expect(runtime.sentMessages).toEqual([]);
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("released Drafted strict client receives deferred error and replays the original receipt over Unix HTTP", async () => {
  const f = await fixture(), first = await f.enqueue("first"); await f.finish(first.instructionId);
  cleanupInboxDependencies.capability = f.dependencies.capability;
  const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.session.cwd, repositoryId: f.task.repositoryId, machineId: f.task.machineId, status: "active", role: "primary", agent: "codex" }]);
  const app = createApp({ config: f.config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const directory = await mkdtemp(path.join(tmpdir(), "retry-pair-")), socket = path.join(directory, "control.sock");
  const server = Bun.serve({ unix: socket, fetch: app.fetch });
  try {
    const { requestTaskCleanup } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
    await expect(requestTaskCleanup(socket, f.task.id, "automatic-tick")).rejects.toThrow("Cleanup retry deferred until");
    expect(await requestTaskCleanup(socket, f.task.id, "first")).toMatchObject({ instructionId: first.instructionId, state: "completed", queued: true });
    expect(await db.prisma.runtimeInstruction.count()).toBe(1); expect(runtime.sentMessages).toEqual([]);
  } finally { await server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
