import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../sessions/runtime-registry.ts";
import { deriveSessionActivity, readTaskActivity } from "./activity.ts";
import { runRuntimeProjectionAttempt } from "../sessions/runtime-events/projection-retries.ts";

const now = new Date("2026-10-27T12:00:00Z").getTime();
const before = (seconds: number) => new Date(now - seconds * 1000);
const task = { id: "task", ownerPaused: false, phase: "working", recoveryDetail: null };
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

test("unanswered questions are independent from execution and queue receipts", () => {
  const question = { id: "question", state: "posted", createdAt: before(90), updatedAt: before(20) };
  expect(derive({ questions: [question] })).toMatchObject({ state: "waiting-owner", durationMs: 20_000 });
  expect(derive({ questions: [{ ...question, state: "unknown" }] }).state).toBe("stalled");
  expect(derive({ questions: [{ ...question, state: "answered" }] }).state).toBe("idle");
});

test("a completed turn does not fabricate task completion and closed tasks retain queued telemetry", () => {
  const latestTurn = { id: "event", requestId: "request", phase: "completed", occurredAt: before(10), sequence: 1 };
  expect(derive({ latestTurn })).toMatchObject({ state: "idle", progress: { reportedPhase: "working" }, latestTurn: { phase: "completed", ageMs: 10_000 } });
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
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  expect((await f.read())!.activity.state).toBe("closed");
});

async function reviewFixture() {
  const f = await fixture();
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { connectionId: "connection", issueIdentifier: "DRA-57", phase: "review" } });
  await f.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: f.primary.id, provider: "linear", connectionId: "connection", resourceType: "issue-identifier", externalId: "DRA-57", relationship: "handles" } });
  const publish = async (key: string, options: { identifier?: string; state?: string; published?: boolean; commentPosted?: boolean; observed?: boolean; connectionId?: string } = {}) => {
    const identifier = options.identifier ?? "DRA-57", state = options.state ?? "Manual Review", connectionId = options.connectionId ?? "connection";
    const receipt = await f.prisma.runtimeIssueUpdate.create({ data: { runtimeSessionId: f.primary.id, requestKey: key, issueId: `uuid:${identifier}`, connectionId, input: { state }, evidence: [], published: options.published ?? true, commentPosted: options.commentPosted ?? true, createdAt: before(40), updatedAt: before(30) } });
    if (options.observed !== false) await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.primary.id, action: "issue-update-published", source: "issue-update-observer", key: receipt.id, occurredAt: before(30), value: JSON.stringify({ connectionId, issueIdentifier: identifier, issueId: receipt.issueId, state }) } });
    return receipt;
  };
  return { ...f, publish };
}

test("published source review waits for the owner without a question, survives reconnect, and later owner Merge supersedes it", async () => {
  const f = await reviewFixture();
  expect((await f.read())!.activity.state).toBe("idle"); // reported phase is not evidence
  const receipt = await f.publish("review");
  await f.prisma.$disconnect();
  expect((await f.read())!.activity).toMatchObject({ state: "waiting-owner", durationMs: 30_000, ownerQuestions: [], reviewHandoff: { receiptId: receipt.id, issueIdentifier: "DRA-57", issueId: "uuid:DRA-57", publishedAt: before(30).toISOString() } });
  await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.primary.id, action: "completion-contract", source: `owner:${f.task.id}`, key: "owner-merge", occurredAt: before(20), value: JSON.stringify({ boundary: "merge" }) } });
  expect((await f.read())!.activity).toMatchObject({ state: "idle", reviewHandoff: null, progress: { reportedPhase: "review" } });
  expect(f.runtime.sentMessages).toHaveLength(0);
});

test("child, foreign connection, unconfirmed and legacy ambiguous review receipts cannot imply source owner wait", async () => {
  const f = await reviewFixture();
  await f.publish("legacy", { observed: false });
  await f.publish("child", { identifier: "DRA-CHILD" });
  await f.publish("other-connection", { connectionId: "foreign" });
  expect((await f.read())!.activity.state).toBe("idle");
  await f.publish("unknown", { published: false });
  expect((await f.read())!.activity.state).toBe("idle");
  await f.publish("missing-comment", { commentPosted: false });
  expect((await f.read())!.activity.state).toBe("idle");
  await f.publish("confirmed");
  expect((await f.read())!.activity.state).toBe("waiting-owner");
  await f.publish("working", { state: "On Course" });
  expect((await f.read())!.activity.state).toBe("idle");
});

test("review handoff never hides executing, queued, active delegate, stalled, unknown or closed evidence", async () => {
  const f = await reviewFixture();
  await f.publish("review");
  f.runtime.observeSessionActivity = () => ({ state: "executing", observedAt: now });
  expect((await f.read())!.activity.state).toBe("executing");
  f.runtime.observeSessionActivity = (id) => ({ state: id === f.child.id ? "executing" : "unknown", observedAt: now });
  expect((await f.read())!.activity.state).toBe("waiting-active-work");
  f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: now });
  const receipt = await f.prisma.runtimeInstruction.create({ data: { id: "review-followup", sessionId: f.primary.id, text: "Followup", state: "queued" } });
  expect((await f.read())!.activity.state).toBe("queued");
  await f.prisma.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "unknown" } });
  expect((await f.read())!.activity.state).toBe("stalled");
  await f.prisma.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "completed" } });
  await f.prisma.runtimeSession.update({ where: { id: f.primary.id }, data: { status: "active" } });
  expect((await f.read())!.activity.state).toBe("unknown");
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  expect((await f.read())!.activity.state).toBe("closed");
});

test("owner Merge racing review publication acknowledgement suppresses stale owner wait", async () => {
  const f = await reviewFixture();
  await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.primary.id, action: "completion-contract", source: `owner:${f.task.id}`, key: "racing-merge", occurredAt: before(35), value: JSON.stringify({ boundary: "merge" }) } });
  await f.publish("review");
  expect((await f.read())!.activity.state).toBe("idle");
});

test("explicit blocked or waiting progress exposes an unconfirmed dependency without inventing its duration or owner", async () => {
  const f = await fixture();
  const detail = "Cloudflare operation returned 403; authorization is needed before retry.";
  for (const phase of ["blocked", "waiting"]) {
    await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase, recoveryDetail: detail, updatedAt: before(90) } });
    await f.prisma.$disconnect();
    expect((await f.read())!.activity).toMatchObject({ state: "waiting-dependency", cause: `Task reports a dependency; not independently confirmed: ${detail}`, since: null, durationMs: null, ownerQuestions: [], progress: { reportedPhase: phase, reportedDetail: detail } });
  }
  for (const recoveryDetail of [null, "", "  \n "]) {
    await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "blocked", recoveryDetail } });
    expect((await f.read())!.activity.state).toBe("idle");
  }
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working", recoveryDetail: detail } });
  expect((await f.read())!.activity.state).toBe("idle");
  expect(f.runtime.sentMessages).toHaveLength(0);
});

test("reported dependency cannot override active work, queue, unknown result, or task closure", async () => {
  const f = await fixture();
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "blocked", recoveryDetail: "Awaiting dependency" } });
  f.runtime.observeSessionActivity = () => ({ state: "executing", observedAt: now });
  expect((await f.read())!.activity.state).toBe("executing");
  f.runtime.observeSessionActivity = (id) => ({ state: id === f.child.id ? "executing" : "unknown", observedAt: now });
  expect((await f.read())!.activity.state).toBe("waiting-active-work");
  f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: now });
  const event = await f.prisma.runtimeLifecycleEvent.create({ data: { id: "dependency-worker-done", runtimeSessionId: f.child.id, requestId: "worker-turn", phase: "completed", occurredAt: before(30) } });
  expect((await f.read())!.activity).toMatchObject({ state: "stalled", pendingDelegateResults: [{ deliveryState: "not-enqueued" }] });
  const id = `delegate-result:${f.primary.id}:${event.id}`;
  await f.prisma.runtimeInstruction.create({ data: { id, sessionId: f.primary.id, text: "Terminal worker result", state: "queued" } });
  expect((await f.read())!.activity.state).toBe("queued");
  await f.prisma.runtimeInstruction.update({ where: { id }, data: { state: "unknown" } });
  expect((await f.read())!.activity).toMatchObject({ state: "stalled", pendingDelegateResults: [{ deliveryState: "unknown" }] });
  await f.prisma.runtimeInstruction.update({ where: { id }, data: { state: "completed" } });
  expect((await f.read())!.activity.state).toBe("waiting-dependency");
  await f.prisma.runtimeSession.update({ where: { id: f.primary.id }, data: { status: "active" } });
  expect((await f.read())!.activity.state).toBe("unknown");
  await f.prisma.runtimeSession.update({ where: { id: f.primary.id }, data: { status: "idle" } });
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  expect((await f.read())!.activity.state).toBe("closed");
});

test("confirmed review handoff retains precedence over reported dependency", async () => {
  const f = await reviewFixture();
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting", recoveryDetail: "Review requested" } });
  await f.publish("review");
  expect((await f.read())!.activity).toMatchObject({ state: "waiting-owner", durationMs: 30_000 });
});
