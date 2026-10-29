import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testConfig } from "../../../../../../test-support/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../../../../services/sessions/runtime-registry.ts";
import { deliverInstructions } from "../../../../services/sessions/inbox.ts";
import { registerThread } from "../../../../services/sessions/threads.ts";
import * as dispatcher from "../../../../services/dispatcher/index.ts";
import * as graphs from "../../session-store/source-issue/work-graph.ts";
import * as issueReads from "../../session-store/source-issue/read.ts";
import * as inbox from "../../../../services/sessions/inbox.ts";
import { handleCommentWebhook } from "./handler.ts";
import type { LinearCommentWebhook } from "../../webhook-types/comment.ts";

let db: TestDatabase;
let dispatch: ReturnType<typeof spyOn<typeof dispatcher, "dispatchEvent">>;
let graph: ReturnType<typeof spyOn<typeof graphs, "getIssueWorkGraph">>;
let parentRead: ReturnType<typeof spyOn<typeof issueReads, "getSourceIssueParent">>;
const config = testConfig();
config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
let runtime: ReturnType<typeof createFakeAgentRuntime>;
beforeEach(async () => {
  db = await createTestDatabase();
  runtime = createFakeAgentRuntime();
  dispatch = spyOn(dispatcher, "dispatchEvent").mockResolvedValue();
  parentRead = spyOn(issueReads, "getSourceIssueParent").mockResolvedValue(null);
  graph = spyOn(graphs, "getIssueWorkGraph").mockResolvedValue({ id: "issue", identifier: "DRA-28", states: [], children: [{
    id: "child-issue", identifier: "DRA-29", title: "Child scope", url: "https://linear.app/issue/DRA-29", completedAt: null,
    state: { id: "todo", name: "Todo", type: "unstarted" }, parent: { id: "issue", identifier: "DRA-28" }, blockedBy: [], blocks: [],
  }] });
});
afterEach(async () => { dispatch.mockRestore(); graph.mockRestore(); parentRead.mockRestore(); await db.cleanup(); });

function comment(overrides: Partial<LinearCommentWebhook["data"]> = {}): LinearCommentWebhook {
  return { type: "Comment", action: "create", webhookTimestamp: Date.now(), data: {
    id: "comment", body: "The repair is verified. Continue the existing task.", userId: "owner",
    issue: { id: "issue", identifier: "DRA-28" }, ...overrides,
  } };
}
function receive(webhook = comment(), deliveryId = "delivery", scopedConfig = config) {
  return handleCommentWebhook({ prisma: db.prisma, config: scopedConfig, agentRuntime: runtime, webhook, deliveryId });
}
async function primary(key = "one", overrides: { connectionId?: string; repositoryId?: string; machineId?: string; role?: string; status?: "active" | "idle" | "closed"; phase?: string } = {}) {
  const repositoryId = overrides.repositoryId ?? config.activeRepositoryId;
  const machineId = overrides.machineId ?? config.machine;
  const connectionId = overrides.connectionId ?? config.activeConnectionId;
  const session = await beginRuntimeSession(db.prisma, { sessionKey: key, agent: "codex", cwd: `/tmp/owner-comment-${key}`, repositoryId, machineId, role: overrides.role ?? "primary" });
  await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: overrides.status ?? "active" } });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId, resourceType: "issue-identifier", relationship: "handles", externalId: "DRA-28" } });
  const task = await db.prisma.remoteTask.create({ data: { requestKey: key, repositoryId, machineId, connectionId, issueIdentifier: "DRA-28", branchName: key, worktreePath: session.cwd, toolingRoot: "/tmp/tooling", toolingRevision: "pinned", primarySessionId: session.id, phase: overrides.phase ?? "working" } });
  runtime.putSession({ ...session, agent: "codex", status: overrides.status ?? "active" });
  return { session, task };
}

test("owner top-level comment queues the sole existing primary without semantic routing", async () => {
  const { session } = await primary();
  expect(await receive()).toMatchObject({ kind: "accepted" });
  expect(dispatch).not.toHaveBeenCalled();
  const instruction = await db.prisma.runtimeInstruction.findFirstOrThrow();
  expect(instruction).toMatchObject({ sessionId: session.id, state: "queued" });
  expect(instruction.text).toContain(comment().data.body);
  expect((await db.prisma.webhookReceipt.findFirstOrThrow()).detail).toBe(`instruction:${instruction.id}`);
  expect(runtime.sentMessages).toHaveLength(0);
  expect(await db.prisma.remoteTask.count()).toBe(1);
  expect(await db.prisma.runtimeSession.count()).toBe(1);
});

test("lost response and redelivery with new delivery ID retain one instruction across restart", async () => {
  const { session } = await primary();
  await receive();
  expect(await receive()).toEqual({ kind: "duplicate" });
  await db.prisma.$disconnect();
  await receive(comment(), "redelivery");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  runtime.putSession({ ...session, agent: "codex", status: "idle" });
  await deliverInstructions(db.prisma, runtime);
  await waitForCompletion();
  await receive(comment(), "after-completion");
  expect(runtime.sentMessages).toHaveLength(1);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("edits are new instructions while identical repeated bodies deduplicate", async () => {
  await primary();
  await receive();
  await receive({ ...comment({ body: "Use the corrected acceptance criterion." }), action: "update" }, "edit");
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
});


test.each([
  { connectionId: "other" }, { repositoryId: "other" }, { machineId: "other" },
  { role: "delegate" }, { status: "closed" }, { phase: "closed" },
] as const)("does not route to an out-of-scope or closed owner: %j", async (overrides) => {
  await primary("one", overrides);
  expect(await receive()).toMatchObject({ kind: "ignored" });
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("ambiguous primary ownership is never resolved by picking the latest session", async () => {
  await primary("one"); await primary("two");
  expect(await receive()).toMatchObject({ kind: "ignored", reason: "ambiguous_source_primary" });
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("a stale source link is reported without routing to its old primary", async () => {
  await primary();
  await db.prisma.runtimeSessionResourceLink.updateMany({ data: { endedAt: new Date() } });
  expect(await receive()).toMatchObject({ kind: "ignored", reason: "source_primary_unavailable" });
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("an uncertain prior delivery is preserved and blocks later instructions", async () => {
  const { session } = await primary();
  await receive();
  await db.prisma.runtimeInstruction.updateMany({ data: { state: "unknown" } });
  runtime.putSession({ ...session, agent: "codex", status: "idle" });
  await receive(comment({ id: "followup", body: "Continue after checking the last outcome." }), "followup");
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeInstruction.findMany({ orderBy: { sequence: "asc" } })).map((instruction) => instruction.state)).toEqual(["unknown", "queued"]);
});

test("a missing runtime destination records the exact durable delivery failure", async () => {
  const { session } = await primary();
  await receive();
  runtime.sessions.delete(session.id);
  await waitForCompletion("failed");
  expect(await db.prisma.runtimeInstruction.findFirstOrThrow()).toMatchObject({ state: "failed", detail: "Session is unavailable or closed" });
});

test("missing actor, another actor, self-authored comments and wildcard subscriptions confer no owner authority", async () => {
  await primary();
  for (const actor of [null, "other", config.agentUserId]) {
    expect(await receive(comment({ userId: actor }), `actor-${actor}`)).toMatchObject({ kind: "ignored" });
  }
  expect(await receive(comment(), "wildcard", testConfig())).toMatchObject({ kind: "ignored" });
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("unmanaged registered questions and explicit mentions retain their existing routing semantics", async () => {
  const session = await beginRuntimeSession(db.prisma, { sessionKey: "unmanaged", agent: "codex", cwd: "/tmp/unmanaged-owner" });
  await registerThread(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, runtimeSessionId: session.id, threadRootCommentId: "question", relationship: "question" });
  await receive(comment({ parentId: "question" }));
  expect(dispatch.mock.calls[0]?.[0].event).toMatchObject({ routedSessionId: session.id, threadRelationship: "question" });
  await receive(comment({ id: "mention", body: "@cubic-agent continue" }), "mention");
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("managed source question replies and mentions share the durable owner inbox", async () => {
  const { session } = await primary();
  const question = await db.prisma.runtimeQuestion.create({ data: { runtimeSessionId: session.id, requestKey: "source-question", connectionId: config.activeConnectionId, issueId: "issue", body: "Which scope is approved?", state: "posted" } });
  await registerThread(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, runtimeSessionId: session.id, threadRootCommentId: question.id, relationship: "question" });
  const answer = comment({ parentId: question.id, body: "@cubic-agent use the accepted scope." });
  await receive(answer);
  await receive(answer, "answer-retry");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).text).toContain(question.body);
  expect(await db.prisma.runtimeQuestion.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ state: "answered" });
  expect(dispatch).not.toHaveBeenCalled();
});

test("owner continuations receive pinned policy and retry the accepted payload if the pin becomes unavailable", async () => {
  const { task } = await primary();
  const pinned = mkdtempSync(path.join(tmpdir(), "owner-comment-pinned-"));
  const mutable = mkdtempSync(path.join(tmpdir(), "owner-comment-mutable-"));
  try {
    writeFileSync(path.join(pinned, "AGENTS.md"), "The owner authorizes task-owned headless verification.");
    writeFileSync(path.join(mutable, "AGENTS.md"), "Do not use this mutable policy.");
    await db.prisma.remoteTask.update({ where: { id: task.id }, data: { pinnedToolingRoot: pinned, toolingRoot: mutable } });
    await receive();
    const first = await db.prisma.runtimeInstruction.findFirstOrThrow();
    expect(first.text).toContain("The owner authorizes task-owned headless verification.");
    expect(first.text).not.toContain("Do not use this mutable policy.");
    rmSync(path.join(pinned, "AGENTS.md"));
    await receive(comment(), "policy-retry");
    expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).text).toBe(first.text);
    expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  } finally { rmSync(pinned, { recursive: true }); rmSync(mutable, { recursive: true }); }
});

test("receipt and instruction persist atomically when enqueue fails", async () => {
  await primary();
  const queue = spyOn(inbox, "queueInstruction").mockRejectedValueOnce(new Error("storage failure"));
  try { await expect(receive()).rejects.toThrow("storage failure"); }
  finally { queue.mockRestore(); }
  expect(await db.prisma.webhookReceipt.count()).toBe(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect(await receive()).toMatchObject({ kind: "accepted" });
});

function childComment(overrides: Partial<LinearCommentWebhook["data"]> = {}) {
  return comment({ issue: { id: "child-issue", identifier: "DRA-29" }, ...overrides });
}
async function bindChild(sessionId: string) {
  return db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: sessionId, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", relationship: "child", externalId: "DRA-29" } });
}

test("a direct child comment wakes the parent's existing primary once", async () => {
  const { session } = await primary();
  await bindChild(session.id);
  await receive(childComment());
  await receive(childComment(), "redelivery");
  expect(graph).toHaveBeenCalledWith(config, { id: "DRA-28" });
  expect(dispatch).not.toHaveBeenCalled();
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect(await db.prisma.runtimeInstruction.findFirstOrThrow()).toMatchObject({ sessionId: session.id, state: "queued" });
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).text).toContain("DRA-29 — direct child of DRA-28");
  expect(await db.prisma.remoteTask.count()).toBe(1);
  expect(await db.prisma.runtimeSession.count()).toBe(1);
});

test("a newly created child routes without a prior primary graph read and resumes exactly once", async () => {
  const { session } = await primary("one", { status: "idle" });
  parentRead.mockResolvedValue({ id: "child-issue", identifier: "DRA-29", parent: { id: "issue", identifier: "DRA-28" } });
  expect(await receive(childComment())).toMatchObject({ kind: "accepted" });
  await deliverInstructions(db.prisma, runtime);
  await waitForCompletion();
  await receive(childComment(), "redelivery");
  expect(parentRead).toHaveBeenCalledTimes(1);
  expect(runtime.sentMessages).toHaveLength(1);
  expect(runtime.sentMessages[0]?.sessionId).toBe(session.id);
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).text).toContain("DRA-29 — direct child of DRA-28");
  expect(await db.prisma.remoteTask.count()).toBe(1);
  expect(await db.prisma.runtimeSession.count()).toBe(1);
  expect(dispatch).not.toHaveBeenCalled();
});

test("new child discovery verifies current parent and leaves failed reads retryable", async () => {
  await primary();
  parentRead.mockRejectedValueOnce(new Error("parent lookup unavailable"));
  await expect(receive(childComment())).rejects.toThrow("parent lookup unavailable");
  expect(await db.prisma.webhookReceipt.count()).toBe(0);
  parentRead.mockResolvedValue({ id: "child-issue", identifier: "DRA-29", parent: { id: "wrong-parent", identifier: "DRA-28" } });
  expect(await receive(childComment())).toEqual({ kind: "ignored", reason: "child_no_longer_owned" });
  expect(await db.prisma.runtimeSessionResourceLink.count({ where: { relationship: "child" } })).toBe(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("new child discovery does not query unauthorized actors or replace a closed parent", async () => {
  await primary("one", { phase: "closed", status: "closed" });
  await receive(childComment({ userId: "other" }), "other");
  expect(parentRead).not.toHaveBeenCalled();
  parentRead.mockResolvedValue({ id: "child-issue", identifier: "DRA-29", parent: { id: "issue", identifier: "DRA-28" } });
  expect(await receive(childComment({ body: "@cubic-agent continue" }))).toEqual({ kind: "ignored", reason: "source_primary_unavailable" });
  expect(dispatch).not.toHaveBeenCalled();
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("a child acquiring its own task during discovery cannot be bound or delivered to the parent", async () => {
  await primary();
  parentRead.mockResolvedValue({ id: "child-issue", identifier: "DRA-29", parent: { id: "issue", identifier: "DRA-28" } });
  graph.mockImplementationOnce(async () => {
    const own = await primary("child-task");
    await db.prisma.remoteTask.update({ where: { id: own.task.id }, data: { issueIdentifier: "DRA-29" } });
    await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: own.session.id }, data: { externalId: "DRA-29" } });
    return { id: "issue", identifier: "DRA-28", states: [], children: [{ id: "child-issue", identifier: "DRA-29", title: "New own task", url: "https://linear.app/issue/DRA-29", completedAt: null,
      state: { id: "todo", name: "Todo", type: "unstarted" }, parent: { id: "issue", identifier: "DRA-28" }, blockedBy: [], blocks: [] }] };
  });
  await expect(receive(childComment())).rejects.toThrow("Child acquired its own task");
  expect(await db.prisma.runtimeSessionResourceLink.count({ where: { relationship: "child" } })).toBe(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect(await db.prisma.webhookReceipt.count()).toBe(0);
  expect(await receive(childComment(), "retry")).toMatchObject({ kind: "accepted" });
  const childTask = await db.prisma.remoteTask.findFirstOrThrow({ where: { issueIdentifier: "DRA-29" } });
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).sessionId).toBe(childTask.primarySessionId!);
});

test("a persisted child link cannot steal owner replies after the child acquires its own task", async () => {
  const parent = await primary();
  await bindChild(parent.session.id);
  const own = await primary("child-task");
  await db.prisma.remoteTask.update({ where: { id: own.task.id }, data: { issueIdentifier: "DRA-29" } });
  await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: own.session.id }, data: { externalId: "DRA-29" } });
  await receive(childComment());
  await receive(childComment(), "redelivery");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).sessionId).toBe(own.session.id);
  expect(graph).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

test("registered child answers retain question context across uncertain response and retry", async () => {
  const { session } = await primary();
  await bindChild(session.id);
  const question = await db.prisma.runtimeQuestion.create({ data: { runtimeSessionId: session.id, requestKey: "question", connectionId: config.activeConnectionId, issueId: "child-issue", body: "Which accepted scope should this child use?", state: "posted" } });
  await registerThread(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, runtimeSessionId: session.id, threadRootCommentId: question.id, relationship: "question" });
  const reply = childComment({ parentId: question.id, body: "Use the previously accepted scope." });
  await receive(reply);
  await db.prisma.$disconnect();
  await receive(reply, "retry");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).text).toContain(`Question: ${question.body}`);
  expect(await db.prisma.runtimeQuestion.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ state: "answered" });
  expect(dispatch).not.toHaveBeenCalled();
});

test("reparented children reject even registered question replies and explicit mentions", async () => {
  const { session } = await primary();
  await bindChild(session.id);
  await registerThread(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, runtimeSessionId: session.id, threadRootCommentId: "old-child-thread", relationship: "question" });
  graph.mockResolvedValue({ id: "issue", identifier: "DRA-28", states: [], children: [] });
  expect(await receive(childComment({ parentId: "old-child-thread", body: "@cubic-agent continue" }))).toEqual({ kind: "ignored", reason: "child_no_longer_owned" });
  expect(dispatch).not.toHaveBeenCalled();
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("unconfirmed child membership remains retryable without reserving a receipt", async () => {
  const { session } = await primary();
  await bindChild(session.id);
  graph.mockRejectedValueOnce(new Error("Linear temporarily unavailable"));
  await expect(receive(childComment())).rejects.toThrow("Linear temporarily unavailable");
  expect(await db.prisma.webhookReceipt.count()).toBe(0);
  expect(await receive(childComment())).toMatchObject({ kind: "accepted" });
});

test("child routing never bypasses actor identity or chooses another thread owner", async () => {
  const { session } = await primary();
  await bindChild(session.id);
  expect(await receive(childComment({ userId: "other", body: "@cubic-agent continue" }))).toEqual({ kind: "ignored", reason: "unauthorized_child_comment" });
  const other = await beginRuntimeSession(db.prisma, { sessionKey: "other-thread", agent: "codex", cwd: "/tmp/other-thread" });
  await registerThread(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, runtimeSessionId: other.id, threadRootCommentId: "other-thread", relationship: "question" });
  expect(await receive(childComment({ parentId: "other-thread" }), "other-thread")).toEqual({ kind: "ignored", reason: "child_thread_owner_mismatch" });
  expect(graph).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

test.each(["closed", "stale-link"])("a %s child ownership cannot fall through to mention routing", async (condition) => {
  const { session } = await primary();
  const link = await bindChild(session.id);
  if (condition === "closed") await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "closed" } });
  else await db.prisma.runtimeSessionResourceLink.update({ where: { id: link.id }, data: { endedAt: new Date() } });
  expect(await receive(childComment({ body: "@cubic-agent continue" }))).toEqual({ kind: "ignored", reason: "child_primary_unavailable" });
  expect(dispatch).not.toHaveBeenCalled();
});

async function waitForCompletion(state = "completed") {
  for (let attempt = 0; attempt < 50; attempt++) {
    await deliverInstructions(db.prisma, runtime);
    if ((await db.prisma.runtimeInstruction.findFirst())?.state === state) return;
    await Bun.sleep(5);
  }
  throw new Error("Instruction did not complete");
}


test("owner comments remain queued on the same task until its explicit owner pause is resumed", async () => {
  const { session, task } = await primary("paused-owner", { status: "idle" });
  await db.prisma.remoteTask.update({ where: { id: task.id }, data: { ownerPaused: true } });
  await receive();
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeInstruction.findFirstOrThrow()).state).toBe("queued");
  await db.prisma.remoteTask.update({ where: { id: task.id }, data: { ownerPaused: false } });
  await deliverInstructions(db.prisma, runtime);
  await waitForCompletion();
  expect(runtime.sentMessages[0]?.sessionId).toBe(session.id);
});
