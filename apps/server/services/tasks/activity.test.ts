import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../sessions/runtime-registry.ts";
import { deriveSessionActivity, readTaskActivity } from "./activity.ts";
import { runRuntimeProjectionAttempt } from "../sessions/runtime-events/projection-retries.ts";

const now = new Date("2026-10-27T12:00:00Z").getTime();
const before = (seconds: number) => new Date(now - seconds * 1000);
const task = { id: "task", phase: "working", controlMode: "agent", recoveryDetail: null };
const session = { id: "primary", status: "idle", closedAt: null, recoveryDetail: null };
const instruction = (state: string, id = state) => ({ id, state, detail: null, createdAt: before(90), updatedAt: before(30), sequence: 1 });
const derive = (input: Partial<Parameters<typeof deriveSessionActivity>[0]> = {}) => deriveSessionActivity({ task, session, now, pending: [], questions: [], latestTurn: null, ...input });

test("executing requires a current runtime observation; stale active and claimed delivery stay uncertain", () => {
  expect(derive({ session: { ...session, status: "active" } })).toMatchObject({ state: "unknown", execution: { state: "unknown", persistedStatus: "active" } });
  expect(derive({ pending: [instruction("dispatching")] })).toMatchObject({ state: "unknown", durationMs: 30_000 });
  expect(derive({ session: { ...session, status: "active" }, observation: { state: "executing", observedAt: now } })).toMatchObject({ state: "executing", durationMs: null, execution: { observedAt: new Date(now).toISOString() } });
  const latestTurn = { id: "started", requestId: "current", phase: "started", occurredAt: before(20), sequence: 1 };
  expect(derive({ latestTurn, observation: { state: "executing", observedAt: now, requestId: "current" } }).durationMs).toBe(20_000);
  expect(derive({ latestTurn, observation: { state: "executing", observedAt: now, requestId: "new-turn" } }).durationMs).toBeNull();
});

test("queued capacity/session waits are not executing or failed delivery", () => {
  const pending = [instruction("queued")];
  expect(derive({ pending })).toMatchObject({ state: "queued", durationMs: 30_000, delivery: { counts: { queued: 1, unknown: 0 } } });
  const waiting = derive({ pending, observation: { state: "queued", observedAt: now } });
  expect(waiting.state).toBe("queued");
  expect(waiting.cause).toContain("capacity or session queue cause is not confirmed");
  expect(waiting.execution.state).toBe("queued");
  expect(derive({ pending: [instruction("unknown"), ...pending] })).toMatchObject({ state: "stalled", durationMs: 30_000, delivery: { counts: { unknown: 1, queued: 1 } } });
});

test("control and unanswered questions are independent from execution and queue receipts", () => {
  const pending = [instruction("queued")];
  expect(derive({ task: { ...task, controlMode: "paused" }, pending })).toMatchObject({ state: "paused", durationMs: null, delivery: { counts: { queued: 1 } } });
  expect(derive({ task: { ...task, controlMode: "draining" }, pending, observation: { state: "executing", observedAt: now } })).toMatchObject({ state: "executing", control: { mode: "draining" } });
  const question = { id: "question", state: "posted", createdAt: before(90), updatedAt: before(20) };
  expect(derive({ questions: [question] })).toMatchObject({ state: "waiting-owner", durationMs: 20_000 });
  expect(derive({ questions: [{ ...question, state: "unknown" }] }).state).toBe("stalled");
  expect(derive({ questions: [{ ...question, state: "answered" }] }).state).toBe("idle");
});

test("a completed turn does not fabricate task completion and closed tasks retain queued telemetry", () => {
  const latestTurn = { id: "event", requestId: "request", phase: "completed", occurredAt: before(10), sequence: 1 };
  expect(derive({ latestTurn })).toMatchObject({ state: "idle", control: { reportedPhase: "working" }, latestTurn: { phase: "completed", ageMs: 10_000 } });
  expect(derive({ task: { ...task, phase: "closed" }, pending: [instruction("queued")], latestTurn })).toMatchObject({ state: "closed", delivery: { counts: { queued: 1 } }, latestTurn: { phase: "completed" } });
  expect(derive({ session: { ...session, status: "closed", closedAt: before(5) } })).toMatchObject({ state: "closed", durationMs: 5000 });
});

let db: TestDatabase | undefined;
afterEach(async () => { await db?.cleanup(); db = undefined; });

async function fixture() {
  db = await createTestDatabase();
  const prisma = db.prisma;
  const primary = await beginRuntimeSession(prisma, { sessionKey: "primary", agent: "codex", cwd: "/task", repositoryId: "repo", machineId: "machine" });
  const child = await beginRuntimeSession(prisma, { sessionKey: "child", agent: "codex", cwd: "/task", repositoryId: "repo", machineId: "machine", role: "delegate" });
  await prisma.runtimeSession.updateMany({ data: { status: "idle" } });
  await prisma.runtimeSessionRelation.createMany({ data: ["spawned-by", "notifies-parent"].map((relationship) => ({ sourceSessionId: child.id, targetSessionId: primary.id, relationship })) });
  const task = await prisma.remoteTask.create({ data: { requestKey: "task", repositoryId: "repo", machineId: "machine", branchName: "codex/task", toolingRoot: "/tooling", toolingRevision: "pin", worktreePath: "/task", primarySessionId: primary.id, phase: "working" } });
  const runtime = createFakeAgentRuntime([{ ...primary, status: "idle" }, { ...child, status: "idle" }]);
  const read = () => readTaskActivity(prisma, runtime, task.id, now);
  return { prisma, primary, child, task, runtime, read };
}

test("an active delegate is waiting-active-work; its terminal result becomes delivery telemetry rather than pending execution", async () => {
  const f = await fixture();
  f.runtime.observeSessionActivity = (id) => ({ state: id === f.child.id ? "executing" : "unknown", observedAt: now });
  expect((await f.read())!.activity).toMatchObject({ state: "waiting-active-work", activeDelegateSessionIds: [f.child.id] });
  f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: now });
  const event = await f.prisma.runtimeLifecycleEvent.create({ data: { id: "worker-done", runtimeSessionId: f.child.id, requestId: "worker-turn", phase: "completed", occurredAt: before(45), output: "Full result" } });
  const expectedId = "delegate-result:" + f.primary.id + ":" + event.id;
  const missing = (await f.read())!;
  expect(missing.activity).toMatchObject({ state: "stalled", durationMs: 45_000, activeDelegateSessionIds: [], pendingDelegateResults: [{ sessionId: f.child.id, eventId: event.id, requestId: "worker-turn", phase: "completed", instructionId: expectedId, deliveryState: "not-enqueued" }] });
  expect(missing.delegates[0]!.activity).toMatchObject({ state: "idle", latestTurn: { phase: "completed" } });
  await f.prisma.runtimeInstruction.create({ data: { id: expectedId, sessionId: f.primary.id, text: "Worker finished", createdAt: before(40), updatedAt: before(40) } });
  expect((await f.read())!.activity).toMatchObject({ state: "queued", pendingDelegateResults: [{ deliveryState: "queued" }] });
  await f.prisma.runtimeInstruction.update({ where: { id: expectedId }, data: { state: "unknown", detail: "Delivery was interrupted" } });
  expect((await f.read())!.activity).toMatchObject({ state: "stalled", pendingDelegateResults: [{ deliveryState: "unknown", cause: "Delivery was interrupted" }] });
  await f.prisma.runtimeInstruction.update({ where: { id: expectedId }, data: { state: "completed" } });
  expect((await f.read())!.activity).toMatchObject({ state: "idle", pendingDelegateResults: [] });
});

test("old unknown delivery cannot disappear behind a full recent-instruction history page", async () => {
  const f = await fixture();
  await f.prisma.runtimeInstruction.create({ data: { id: "old-unknown", sessionId: f.primary.id, state: "unknown", text: "Interrupted", createdAt: before(90), updatedAt: before(30) } });
  await f.prisma.runtimeInstruction.createMany({ data: Array.from({ length: 110 }, (_, index) => ({ id: "complete-" + index, sessionId: f.primary.id, state: "completed", text: "Settled" })) });
  const result = (await f.read())!;
  expect(result.instructions).toHaveLength(100);
  expect(result.activity).toMatchObject({ state: "stalled", durationMs: 30_000, correlation: { instructionId: "old-unknown" }, delivery: { counts: { unknown: 1 } } });
  expect(await f.prisma.runtimeInstruction.count({ where: { state: "unknown" } })).toBe(1);
  expect(f.runtime.sentMessages).toHaveLength(0);
});

test("task activity excludes delegates outside its owner relationship, worktree, repository or machine", async () => {
  const f = await fixture();
  for (const [index, overrides] of [{ cwd: "/foreign" }, { repositoryId: "foreign" }, { machineId: "foreign" }, {}].entries()) {
    const outsider = await beginRuntimeSession(f.prisma, { sessionKey: "outside-" + index, agent: "codex", cwd: "/task", repositoryId: "repo", machineId: "machine", role: "delegate", ...overrides });
    f.runtime.putSession(outsider);
    if (index !== 3) await f.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: outsider.id, targetSessionId: f.primary.id, relationship: "spawned-by" } });
    await f.prisma.runtimeInstruction.create({ data: { id: "foreign-" + index, sessionId: outsider.id, text: "Private foreign work", state: "unknown" } });
  }
  const result = (await f.read())!;
  expect(result.delegates.map((delegate) => delegate.session?.id)).toEqual([f.child.id]);
  expect(result.activity.state).toBe("idle");
  expect(await f.prisma.runtimeInstruction.count({ where: { state: "unknown" } })).toBe(4);
  await f.prisma.runtimeSession.update({ where: { id: f.primary.id }, data: { machineId: "foreign" } });
  const mismatch = (await f.read())!;
  expect(mismatch.session).toBeNull();
  expect(mismatch.instructions).toEqual([]);
  expect(mismatch.delegates).toEqual([]);
  expect(mismatch.activity.state).toBe("unknown");
});

test("unavailable runtime reads expose uncertainty without changing work or hiding persisted receipts", async () => {
  const f = await fixture();
  f.runtime.getSession = async () => { throw new Error("offline"); };
  f.runtime.history = async () => { throw new Error("offline"); };
  f.runtime.observeSessionActivity = () => { throw new Error("offline"); };
  const result = (await f.read())!;
  expect(result.activity.state).toBe("unknown");
  expect(result.activity.execution.state).toBe("unknown");
  expect(result.activity.readErrors).toHaveLength(3);
  expect(await f.prisma.runtimeSession.count({ where: { status: "idle" } })).toBe(2);
  expect(f.runtime.sentMessages).toHaveLength(0);
  expect(f.runtime.cancelledSessionIds).toHaveLength(0);
});

test("exhausted delivery retries expose bounded recovery without fabricating or overriding provider execution", async () => {
  const f = await fixture();
  const identity = { sessionId: f.child.id, eventId: "failed-notify", stage: "notify" as const };
  for (let attempt = 0; attempt < 5; attempt++) {
    await runRuntimeProjectionAttempt(f.prisma, identity, async () => { throw new Error("inbox unavailable"); }, () => now + attempt * 60_000);
  }
  expect((await f.read())!.activity).toMatchObject({ state: "stalled", projectionRetries: [{ ...identity, state: "exhausted", attempts: 5 }], cause: "Delegate-result notification exhausted its automatic delivery attempts; explicit projection recovery is required" });
  f.runtime.observeSessionActivity = () => ({ state: "executing", observedAt: now });
  expect((await f.read())!.activity.state).toBe("executing");
  f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: now });
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { controlMode: "paused" } });
  expect((await f.read())!.activity.state).toBe("paused");
});
