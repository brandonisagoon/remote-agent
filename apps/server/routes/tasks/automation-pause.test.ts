import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { appendRuntimeLifecycleEvent, findRuntimeSession, listRuntimeSessions, updateRuntimeSessionState } from "../../services/sessions/runtime-registry.ts";
import { deliverInstructions } from "../../services/sessions/inbox.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

async function fixture() {
  const config = testConfig();
  const task = await db.prisma.remoteTask.create({ data: {
    id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine,
    branchName: "codex/existing", phase: "working", primarySessionId: "primary", worktreePath: "/owned-task",
    toolingRoot: "/tooling", toolingRevision: "old-pin", pinnedToolingRoot: "/tooling/old-pin",
  } });
  const identity = { cwd: task.worktreePath!, repositoryId: task.repositoryId, machineId: task.machineId };
  await db.prisma.runtimeSession.createMany({ data: [
    { id: "primary", status: "active", role: "primary", ...identity },
    { id: "delegate", status: "active", role: "delegate", ...identity },
    { id: "idle", status: "idle", role: "delegate", ...identity },
    { id: "other-repository", status: "active", ...identity, repositoryId: "another-repository" },
    { id: "other-machine", status: "active", ...identity, machineId: "another-machine" },
    { id: "other-directory", status: "active", ...identity, cwd: "/another-task" },
  ].map(session => ({ ...session, scopeKey: session.id, agentCommand: "codex" })) });
  await db.prisma.runtimeInstruction.createMany({ data: ["primary", "delegate"].map(sessionId => ({ id: `queued-${sessionId}`, sessionId, text: `Preserve ${sessionId} instructions` })) });
  const runtime = createFakeAgentRuntime();
  runtime.getSession = id => findRuntimeSession(db.prisma, id);
  // Like the production adapter, a cwd lookup may return other worktrees in
  // the repository. The route must enforce all three ownership coordinates.
  runtime.listSessions = () => listRuntimeSessions(db.prisma);
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const pause = () => app.request(`/api/tasks/${task.id}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) });
  return { task, runtime, pause };
}

test("pause attempts every owned live session after a primary cancellation failure and retries only the remainder", async () => {
  const { task, runtime, pause } = await fixture();
  const attempted: string[] = [];
  let failPrimary = true;
  runtime.cancel = async id => {
    attempted.push(id);
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).ownerPaused).toBeTrue();
    if (id === "primary" && failPrimary) throw new Error("Provider cancellation failed");
    await updateRuntimeSessionState(db.prisma, id, { status: "idle" });
  };
  const response = await pause();
  expect(attempted.sort()).toEqual(["delegate", "primary"]);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    task: { id: task.id, ownerPaused: true, controlMode: "paused", controllerId: `task-supervisor:${task.id}`, resources: [] },
    pause: { state: "pending", pendingSessionIds: ["primary"], failures: [{ sessionId: "primary", error: "Provider cancellation failed" }] },
  });
  const paused = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toEqual([]);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "queued" } })).toBe(2);
  failPrimary = false;
  attempted.length = 0;
  const retry = await pause();
  expect(retry.status).toBe(200);
  expect(attempted).toEqual(["primary"]);
  expect(await retry.json()).toMatchObject({ task: { ownerPaused: true }, pause: { state: "paused", pendingSessionIds: [], failures: [] } });
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).toEqual(paused);
  expect(await db.prisma.runtimeSession.count()).toBe(6);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "queued" } })).toBe(2);
});

test("pause reports accepted cancellation as pending until the terminal receipt arrives", async () => {
  const { task, runtime, pause } = await fixture();
  await updateRuntimeSessionState(db.prisma, "delegate", { status: "idle" });
  const attempted: string[] = [];
  runtime.cancel = async id => { attempted.push(id); };
  const response = await pause();
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    task: { id: task.id, ownerPaused: true, toolingRevision: "old-pin", controlMode: "paused", controllerId: `task-supervisor:${task.id}`, resources: [] },
    pause: { state: "pending", attemptedSessionIds: ["primary"], pendingSessionIds: ["primary"], failures: [] },
  });
  await appendRuntimeLifecycleEvent(db.prisma, { kind: "turn", id: "delayed-cancel", sessionId: "primary", requestId: "prior-turn", phase: "cancelled", createdAt: Date.now() });
  await updateRuntimeSessionState(db.prisma, "primary", { status: "idle" });
  await db.prisma.$disconnect();
  const retry = await pause();
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ task: { ownerPaused: true }, pause: { state: "paused", attemptedSessionIds: [], pendingSessionIds: [] } });
  expect(attempted).toEqual(["primary"]);
  expect(await db.prisma.runtimeLifecycleEvent.count()).toBe(1);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "queued" } })).toBe(2);
});

test("a slow primary cancellation does not delay the delegate cancellation attempt and all failures are reported", async () => {
  const { runtime, pause } = await fixture();
  const delegateAttempt = Promise.withResolvers<void>();
  runtime.cancel = async id => {
    if (id === "primary") { await delegateAttempt.promise; throw new Error("Primary cancellation failed"); }
    delegateAttempt.resolve();
    throw new Error("Delegate cancellation failed");
  };
  const response = await pause();
  expect(response.status).toBe(409);
  const data = await response.json() as { pause: { pendingSessionIds: string[]; failures: Array<{ sessionId: string; error: string }> } };
  expect(data.pause.pendingSessionIds.sort()).toEqual(["delegate", "primary"]);
  expect(data.pause.failures.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
    { sessionId: "delegate", error: "Delegate cancellation failed" }, { sessionId: "primary", error: "Primary cancellation failed" },
  ]);
});

test("pause cancels provisioning and process-observed queued work without cancelling settled idle sessions", async () => {
  const { runtime, pause } = await fixture();
  await updateRuntimeSessionState(db.prisma, "primary", { status: "idle" });
  await updateRuntimeSessionState(db.prisma, "delegate", { status: "provisioning" });
  const queued = new Set(["primary"]);
  runtime.observeSessionActivity = id => ({ state: queued.has(id) ? "queued" : "unknown", observedAt: Date.now() });
  const attempted: string[] = [];
  runtime.cancel = async id => { attempted.push(id); queued.delete(id); await updateRuntimeSessionState(db.prisma, id, { status: "idle" }); };
  const response = await pause();
  expect(response.status).toBe(200);
  expect(attempted.sort()).toEqual(["delegate", "primary"]);
  expect(await response.json()).toMatchObject({ pause: { state: "paused", pendingSessionIds: [], failures: [] } });
});
