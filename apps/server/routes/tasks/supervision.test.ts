import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createAcpxSessionRuntime } from "../../transports/acpx/session-runtime.ts";
import { createApp } from "../../app.ts";
import { deliverInstructions, queueInstruction } from "../../services/sessions/inbox.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await mkdtemp(path.join(tmpdir(), "task-recovery-")); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const config = { ...testConfig(), acpxStateDir: directory };
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  const store = createRuntimeStore({ stateDir: directory });
  for (const id of ["primary", "delegate", "unrelated"]) {
    await db.prisma.runtimeSession.create({ data: {
      id, scopeKey: id, agentCommand: "codex", cwd: directory, repositoryId: "repo", machineId: "air",
      status: "active", role: id === "primary" ? "primary" : "delegate", acpxRecordId: `record-${id}`, acpxSessionId: `provider-${id}`,
    } });
    const now = new Date().toISOString();
    const record: AcpSessionRecord = {
      schema: "acpx.session.v1", acpxRecordId: `record-${id}`, acpSessionId: `provider-${id}`, agentCommand: "codex", cwd: directory,
      createdAt: now, lastUsedAt: now, lastSeq: 0, pid: child.pid,
      eventLog: { active_path: `${id}.events.jsonl`, segment_count: 1, max_segment_bytes: 1_048_576, max_segments: 5 },
      messages: [], updated_at: now, cumulative_token_usage: {}, request_token_usage: {},
    };
    await store.save(record);
  }
  await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "delegate", targetSessionId: "primary", relationship: "spawned-by" } });
  await db.prisma.remoteTask.create({ data: {
    id: "task", requestKey: "task", repositoryId: "repo", machineId: "air", worktreePath: directory,
    primarySessionId: "primary", branchName: "codex/task", toolingRoot: directory, toolingRevision: "a".repeat(40),
  } });
  const real = createAcpxSessionRuntime(db.prisma, config);
  const runtime = createFakeAgentRuntime();
  runtime.getSession = real.getSession.bind(real);
  runtime.reconcileInterruptedSession = real.reconcileInterruptedSession!.bind(real);
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime });
  const resolve = (id: string, action = "acknowledge", requestKey?: string, taskId = "task") => app.request(`/api/tasks/${taskId}/instructions/${id}/resolve`, {
    method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ action, reason: "Inspected provider history and worktree", ...(requestKey ? { requestKey } : {}) }),
  });
  const uncertain = (id: string, sessionId = "delegate") => db.prisma.runtimeInstruction.create({ data: { id, sessionId, text: id, state: "unknown" } });
  return { runtime, resolve, uncertain, app, config, store };
}

test("task owner can inspect and reconcile primary and delegate after restart without SQL", async () => {
  const { resolve, uncertain, app, config } = await fixture();
  await uncertain("primary-work", "primary");
  await uncertain("delegate-work");
  const response = await app.request("/api/tasks/task/activity", { headers: { authorization: `Bearer ${config.apiKey}` } });
  const activity = await response.json() as { delegates: Array<{ session: { id: string }; instructions: Array<{ id: string }> }> };
  expect(activity.delegates.map(({ session }) => session.id)).toEqual(["delegate"]);
  expect(activity.delegates[0]?.instructions[0]?.id).toBe("delegate-work");
  expect((await resolve("primary-work")).status).toBe(200);
  expect((await resolve("delegate-work")).status).toBe(200);
  expect(await db.prisma.runtimeSession.count({ where: { id: { in: ["primary", "delegate"] }, status: "idle" } })).toBe(2);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "acknowledged" } })).toBe(2);
  expect((await resolve("delegate-work")).status).toBe(200);
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(2);
  expect((await resolve("delegate-work", "cancel")).status).toBe(409);
});

test("task, session identity, role, and live parent relation guard resolution", async () => {
  const { resolve, uncertain } = await fixture();
  await uncertain("unrelated-work", "unrelated");
  expect((await resolve("unrelated-work")).status).toBe(409);
  await uncertain("delegate-work");
  expect((await resolve("delegate-work", "acknowledge", undefined, "other-task")).status).toBe(409);
  for (const change of [{ repositoryId: "other-repo" }, { machineId: "other-machine" }, { cwd: "/other-task" }, { role: "primary" }]) {
    await db.prisma.runtimeSession.update({ where: { id: "delegate" }, data: change });
    expect((await resolve("delegate-work")).status).toBe(409);
    await db.prisma.runtimeSession.update({ where: { id: "delegate" }, data: { repositoryId: "repo", machineId: "air", cwd: directory, role: "delegate" } });
  }
  await db.prisma.runtimeSessionRelation.updateMany({ data: { endedAt: new Date() } });
  expect((await resolve("delegate-work")).status).toBe(409);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "delegate-work" } })).state).toBe("unknown");
});

test("retry preserves original queue order, uses a new attempt identity, and cannot repeat after a lost response", async () => {
  const { runtime, resolve, uncertain } = await fixture();
  const original = await uncertain("first");
  await queueInstruction(db.prisma, { sessionId: "delegate", requestId: "later", text: "later" });
  expect((await resolve("first", "retry", "decision-one")).status).toBe(200);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "first" } })).sequence).toBe(original.sequence);
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 1; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map(({ text }) => text)).toEqual(["first"]);
  expect(runtime.sentMessages[0]?.requestId).toMatch(/^first:retry:\d+$/);
  expect((await resolve("first", "retry", "decision-one")).status).toBe(200);
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(1);
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 2; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map(({ text }) => text)).toEqual(["first", "later"]);
});

test("old terminal events cannot resolve an interrupted explicit retry", async () => {
  const { runtime, resolve, uncertain } = await fixture();
  await uncertain("first");
  expect((await resolve("first", "retry", "attempt-one")).status).toBe(200);
  await db.prisma.runtimeInstruction.update({ where: { id: "first" }, data: { state: "dispatching" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "old-completed", runtimeSessionId: "delegate", requestId: "first", phase: "completed", occurredAt: new Date() } });
  await deliverInstructions(db.prisma, runtime);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "first" } })).state).toBe("unknown");
  expect((await resolve("first", "retry", "attempt-one")).status).toBe(200);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "first" } })).state).toBe("unknown");
  expect((await resolve("first", "retry", "attempt-two")).status).toBe(200);
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(2);
});

test("live provider blocks resolution and paused, human-controlled or closed tasks never resume implicitly", async () => {
  const { runtime, resolve, uncertain, store } = await fixture();
  await uncertain("first");
  const record = (await store.load("record-delegate"))!;
  await store.save({ ...record, pid: process.pid });
  expect((await resolve("first")).status).toBe(409);
  expect((await runtime.getSession("delegate"))?.status).toBe("active");
  await store.save(record);
  for (const controlMode of ["human", "paused", "draining"]) {
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { controlMode } });
    expect((await resolve("first", "retry")).status).toBe(409);
  }
  expect((await resolve("first", "cancel")).status).toBe(200);
  await queueInstruction(db.prisma, { sessionId: "delegate", requestId: "later", text: "later" });
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { controlMode: "agent", phase: "closed" } });
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  await uncertain("closed-work");
  expect((await resolve("closed-work")).status).toBe(409);
});
