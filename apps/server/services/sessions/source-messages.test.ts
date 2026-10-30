import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { queueInstruction, deliverInstructions } from "./inbox.ts";
import { recordSourceMessage, recordSourceLifecycle, prepareSourceReply, projectSourceReply, replyToSource, readReplyContext, bindSourceTurn } from "./source-messages.ts";
import { reconcileSourceMessages, reconcileControlNotices } from "../../integrations/linear/message-delivery.ts";
import { deliverMessageControls } from "./message-controls.ts";
import { handleReactionWebhook } from "../../integrations/linear/webhooks/reaction/handler.ts";
import { handleCommentWebhook } from "../../integrations/linear/webhooks/comment/handler.ts";

const config = testConfig();
const presentation = { queued: "⏳", processing: "👀", replied: "💬", attention: "⚠️", failed: "❌" };
const originalFetch = globalThis.fetch;
let db: TestDatabase;
let sessionId: string;
let runtime: ReturnType<typeof createFakeAgentRuntime>;
let activeRequestId = "turn-one";
let loseCreateResponse = false;
let failReactions = false;
type Comment = { id: string; body: string; parentId: string | null; issue: { id: string; identifier: string } | null; user: { id: string }; documentContent: { issue: { id: string; identifier: string } | null } | null };
let comments: Map<string, Comment>;
let creates: Array<{ id: string; issueId: string; parentId: string; body: string }>;
let reactions: Array<{ id: string; commentId: string; emoji: string; user: { id: string } }>;

beforeEach(async () => {
  db = await createTestDatabase();
  const session = await beginRuntimeSession(db.prisma, { sessionKey: "reply-tests", agent: "codex", cwd: "/tmp/source-replies",
    repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
  sessionId = session.id;
  await db.prisma.runtimeSession.update({ where: { id: sessionId }, data: { status: "active" } });
  runtime = createFakeAgentRuntime([{ ...session, agent: "codex", status: "active" }]);
  activeRequestId = "turn-one";
  runtime.observeSessionActivity = () => ({ state: "executing", requestId: activeRequestId, observedAt: Date.now() });
  comments = new Map(); creates = []; reactions = []; loseCreateResponse = false; failReactions = false;
  globalThis.fetch = (async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("QuestionComment")) return Response.json({ data: { comment: comments.get(variables.commentId) ?? null } });
    if (query.includes("DeliveryComment")) return Response.json({ data: { comment: comments.get(variables.id) ?? null } });
    if (query.includes("CreateThreadedIssueComment")) {
      const input = variables.input;
      if (!comments.has(input.id)) {
        creates.push(input);
        comments.set(input.id, { ...input, parentId: input.parentId, issue: { id: input.issueId, identifier: input.issueId }, user: { id: config.agentUserId }, documentContent: null });
      }
      if (loseCreateResponse) { loseCreateResponse = false; throw new Error("Lost response after server commit"); }
      return Response.json({ data: { commentCreate: { success: true, comment: { id: input.id } } } });
    }
    if (query.includes("DeliveryReactions")) return Response.json({ data: { comment: { reactions: reactions.filter((reaction) => reaction.commentId === variables.id) } } });
    if (query.includes("RemoveDeliveryReaction")) {
      reactions = reactions.filter((reaction) => reaction.id !== variables.id);
      return Response.json({ data: { reactionDelete: { success: true } } });
    }
    if (query.includes("DeliveryReaction")) {
      if (failReactions) throw new Error("Reaction API offline");
      const input = variables.input;
      reactions.push({ ...input, id: `reaction-${reactions.length}`, user: { id: config.agentUserId } });
      return Response.json({ data: { reactionCreate: { success: true } } });
    }
    throw new Error(`Unexpected test query: ${query}`);
  }) as typeof fetch;
});
afterEach(async () => { globalThis.fetch = originalFetch; await db.cleanup(); });

async function source(commentId = "comment-one", issueId = "issue-one", parentId: string | null = null) {
  const threadRootId = parentId ?? commentId;
  comments.set(threadRootId, { id: threadRootId, body: "Original evidence ![image](https://uploads.linear.app/example)", parentId: null,
    issue: { id: issueId, identifier: issueId }, user: { id: "owner" }, documentContent: null });
  const message = await recordSourceMessage(db.prisma, { provider: "linear", connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine, resourceId: issueId, resourceIdentifier: issueId,
    commentId, threadRootId, authorId: "owner", body: `Feedback on ${commentId}`, presentation });
  await queueInstruction(db.prisma, { requestId: message.id, sessionId, sourceMessageId: message.id, text: message.body });
  return db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } });
}

async function bind(id: string, requestId = activeRequestId) {
  await db.prisma.runtimeSourceMessage.update({ where: { id }, data: { requestId } });
}
function event(requestId: string, phase: "started" | "completed" | "failed" = "completed", output = "Answer") {
  return { kind: "turn" as const, id: `${requestId}:${phase}`, sessionId, requestId, phase, output, createdAt: Date.now() };
}
const emoji = (id: string) => reactions.filter((reaction) => reaction.commentId === id && reaction.user.id === config.agentUserId).map((reaction) => reaction.emoji).sort();

test("queued and active comments have different reactions, then only confirmed publication gets replied", async () => {
  const first = await source(); const second = await source("comment-two", "issue-two");
  reactions.push({ id: "human-eyes", commentId: first.commentId, emoji: "👀", user: { id: "owner" } });
  await reconcileSourceMessages(config, db.prisma);
  expect(emoji(first.commentId)).toEqual(["⏳"]); expect(emoji(second.commentId)).toEqual(["⏳"]);
  await bind(first.id); await recordSourceLifecycle(db.prisma, event(activeRequestId, "started"));
  await reconcileSourceMessages(config, db.prisma);
  expect(emoji(first.commentId)).toEqual(["👀"]); expect(emoji(second.commentId)).toEqual(["⏳"]);
  await recordSourceLifecycle(db.prisma, event(activeRequestId));
  await reconcileSourceMessages(config, db.prisma);
  expect(emoji(first.commentId)).toEqual([]); // Finishing a turn is not a reply receipt.
  await projectSourceReply(config, db.prisma, event(activeRequestId));
  await db.prisma.$disconnect(); await reconcileSourceMessages(config, db.prisma);
  expect(emoji(first.commentId)).toEqual(["💬"]); expect(emoji(second.commentId)).toEqual(["⏳"]);
  expect(reactions.some((reaction) => reaction.id === "human-eyes")).toBe(true);
});

test("one primary answers two threads on their original issues across restart", async () => {
  const first = await source(); const second = await source("comment-two", "child-issue", "child-root");
  await bind(first.id, "one"); await bind(second.id, "two");
  await projectSourceReply(config, db.prisma, event("one", "completed", "First answer"));
  await db.prisma.$disconnect();
  await projectSourceReply(config, db.prisma, event("two", "completed", "Child answer"));
  expect(creates.map(({ issueId, parentId, body }) => ({ issueId, parentId, body }))).toEqual([
    { issueId: "issue-one", parentId: "comment-one", body: "First answer" },
    { issueId: "child-issue", parentId: "child-root", body: "Child answer" },
  ]);
});

test("description-anchored roots support context, control notices and the same durable reply destination", async () => {
  const message = await source(); await bind(message.id);
  const root = comments.get(message.threadRootId)!;
  comments.set(root.id, { ...root, issue: null, documentContent: { issue: { id: message.resourceId, identifier: message.resourceIdentifier } } });
  const context = await readReplyContext({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id });
  expect(context.threadRoot.body).toContain("![image]");
  await control(); await deliverMessageControls(db.prisma, runtime); await reconcileControlNotices(config, db.prisma);
  await replyToSource({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id, requestKey: "anchored", body: "Anchored answer" });
  expect(creates).toHaveLength(2);
  expect(creates.every((reply) => reply.issueId === message.resourceId && reply.parentId === root.id)).toBe(true);
  expect(creates[1]!.body).toBe("Anchored answer");
  comments.set(root.id, { ...root, issue: null, documentContent: { issue: { id: "another-issue", identifier: "ANOTHER-1" } } });
  await expect(readReplyContext({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id })).rejects.toThrow("Original reply thread is unavailable");
});

test("explicit reply suppresses different automatic prose and reconciles a lost create response", async () => {
  const message = await source(); await bind(message.id); loseCreateResponse = true;
  await replyToSource({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id, requestKey: "answer", body: "Explicit answer" });
  await projectSourceReply(config, db.prisma, event(activeRequestId, "completed", "Different final summary"));
  expect(creates).toHaveLength(1); expect(creates[0]!.body).toBe("Explicit answer");
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } })).replyPosted).toBe(true);
});

test("late tools cannot reply to a different turn or reconstruct an arbitrary destination", async () => {
  const message = await source(); await bind(message.id, "old-turn");
  await expect(replyToSource({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id, requestKey: "late", body: "Late reply" })).rejects.toThrow("missing or ambiguous");
  expect(creates).toHaveLength(0);
  await bind(message.id);
  const context = await readReplyContext({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id });
  expect(context.threadRoot.body).toContain("![image]");
  runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await expect(readReplyContext({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id })).rejects.toThrow("No confirmed executing turn");
});

test("reaction outages retry projection without re-executing the instruction", async () => {
  const message = await source(); failReactions = true;
  await reconcileSourceMessages(config, db.prisma);
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } })).projectionPending).toBe(true);
  failReactions = false; await db.prisma.$disconnect(); await reconcileSourceMessages(config, db.prisma);
  expect(emoji(message.commentId)).toEqual(["⏳"]); expect(runtime.sentMessages).toHaveLength(0);
});

test("an unavailable owner fails the source receipt and replaces its queued reaction", async () => {
  const message = await source(); await reconcileSourceMessages(config, db.prisma);
  expect(emoji(message.commentId)).toEqual(["⏳"]);
  runtime.putSession({ ...runtime.sessions.get(sessionId)!, status: "closed" });
  await deliverInstructions(db.prisma, runtime, config); await reconcileSourceMessages(config, db.prisma);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("failed");
  const failed = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } });
  expect(failed.state).toBe("failed"); expect(failed.detail).toContain("unavailable or closed");
  expect(emoji(message.commentId)).toEqual(["❌"]); expect(runtime.sentMessages).toHaveLength(0);
});

test("a stale unavailable-session observation cannot overwrite an instruction already promoted to steering", async () => {
  const message = await source();
  runtime.getSession = async () => {
    await db.prisma.runtimeInstruction.update({ where: { id: message.id }, data: { state: "steered" } });
    await db.prisma.runtimeSourceMessage.update({ where: { id: message.id }, data: { state: "processing" } });
    return null;
  };
  await deliverInstructions(db.prisma, runtime, config);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("steered");
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("processing");
});

test("old started events cannot restore active reactions after a completed turn", async () => {
  const message = await source(); await bind(message.id);
  await recordSourceLifecycle(db.prisma, event(activeRequestId));
  await recordSourceLifecycle(db.prisma, event(activeRequestId, "started"));
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("handled");
});

test("a real reply outbox draft survives publication failure and is not replaced by automatic output", async () => {
  const message = await source(); await bind(message.id);
  await prepareSourceReply(db.prisma, message.id, "Pinned explicit answer", false, "key");
  await projectSourceReply(config, db.prisma, event(activeRequestId, "completed", "Other output"));
  await expect(replyToSource({ prisma: db.prisma, config, runtime, sessionId, sourceMessageId: message.id, requestKey: "changed", body: "Changed answer" })).rejects.toThrow("immutable reply");
  expect(creates).toHaveLength(1); expect(creates[0]!.body).toBe("Pinned explicit answer");
});

async function control(commentId = "comment-one") {
  return db.prisma.runtimeMessageControl.create({ data: { id: "control", provider: "linear", connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine, authorId: "owner", commentId } });
}

test("unsupported steering keeps the original instruction queued and posts a separate explanation", async () => {
  const message = await source(); await control();
  reactions.push({ id: "owner-compass", commentId: message.commentId, emoji: "🧭", user: { id: "owner" } });
  await deliverMessageControls(db.prisma, runtime);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("queued");
  expect((await db.prisma.runtimeMessageControl.findUniqueOrThrow({ where: { id: "control" } })).state).toBe("unsupported");
  await reconcileControlNotices(config, db.prisma); await reconcileSourceMessages(config, db.prisma);
  expect(creates[0]!.body).toContain("remains queued"); expect(creates[0]!.parentId).toBe(message.threadRootId);
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } })).replyPosted).toBe(false);
  expect(reactions.some((reaction) => reaction.id === "owner-compass")).toBe(true);
});

test("a page of undeliverable control notices cannot starve a later eligible notice", async () => {
  const message = await source();
  await db.prisma.runtimeMessageControl.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    id: `blocked-notice-${index}`, provider: "linear", connectionId: config.activeConnectionId, repositoryId: config.activeRepositoryId,
    machineId: config.machine, authorId: "owner", commentId: `missing-comment-${index}`, sourceMessageId: "missing-source",
    state: "unsupported", noticeBody: "Unresolved notice", createdAt: new Date(0),
  })) });
  const ready = await control();
  await db.prisma.runtimeMessageControl.update({ where: { id: ready.id }, data: { state: "unsupported", sourceMessageId: message.id, noticeBody: "Ready notice" } });
  await reconcileControlNotices(config, db.prisma);
  expect((await db.prisma.runtimeMessageControl.findUniqueOrThrow({ where: { id: ready.id } })).noticePosted).toBe(true);
  expect(creates.map((reply) => reply.body)).toEqual(["Ready notice"]);
});

test("a capable runtime atomically promotes the same queued instruction without a later duplicate", async () => {
  const message = await source(); await control(); let sends = 0;
  runtime.steer = async (input) => { expect(input.targetRequestId).toBe(activeRequestId); expect(await input.beforeSend()).toBe(true); sends++; return { status: "applied" }; };
  await deliverMessageControls(db.prisma, runtime); await deliverMessageControls(db.prisma, runtime);
  expect(sends).toBe(1);
  runtime.putSession({ ...runtime.sessions.get(sessionId)!, status: "idle" });
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("steered");
});

test("an uncertain native steer blocks automatic queued replay after restart", async () => {
  const message = await source(); await control();
  runtime.steer = async (input) => { await input.beforeSend(); throw new Error("Acknowledgment lost"); };
  await deliverMessageControls(db.prisma, runtime);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("unknown");
  const restarted = createFakeAgentRuntime([{ ...runtime.sessions.get(sessionId)!, status: "idle" }]);
  await db.prisma.$disconnect(); await deliverMessageControls(db.prisma, restarted); await deliverInstructions(db.prisma, restarted);
  expect(restarted.sentMessages).toHaveLength(0);
});

test("owner pause retains the comment and control until the same task resumes", async () => {
  const message = await source(); await control(); let sends = 0;
  const task = await db.prisma.remoteTask.create({ data: { requestKey: "paused-owner", repositoryId: config.activeRepositoryId,
    machineId: config.machine, connectionId: config.activeConnectionId, branchName: "codex/paused-owner", worktreePath: "/tmp/source-replies",
    toolingRoot: "/tools", toolingRevision: "a".repeat(40), issueIdentifier: message.resourceIdentifier,
    primarySessionId: sessionId, phase: "working", ownerPaused: true } });
  runtime.steer = async (input) => { sends++; expect(await input.beforeSend()).toBe(true); return { status: "applied" }; };
  await deliverMessageControls(db.prisma, runtime);
  expect(sends).toBe(0);
  expect((await db.prisma.runtimeMessageControl.findUniqueOrThrow({ where: { id: "control" } })).state).toBe("pending");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("queued");
  await db.prisma.remoteTask.update({ where: { id: task.id }, data: { ownerPaused: false } });
  await deliverMessageControls(db.prisma, runtime);
  expect(sends).toBe(1);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("steered");
});

test("a pause between steering preparation and claim prevents native delivery", async () => {
  const message = await source(); await control();
  const task = await db.prisma.remoteTask.create({ data: { requestKey: "pause-race", repositoryId: config.activeRepositoryId,
    machineId: config.machine, connectionId: config.activeConnectionId, branchName: "codex/pause-race", worktreePath: "/tmp/source-replies",
    toolingRoot: "/tools", toolingRevision: "a".repeat(40), issueIdentifier: message.resourceIdentifier,
    primarySessionId: sessionId, phase: "working" } });
  runtime.steer = async (input) => {
    await db.prisma.remoteTask.update({ where: { id: task.id }, data: { ownerPaused: true } });
    expect(await input.beforeSend()).toBe(false);
    return { status: "idle" };
  };
  await deliverMessageControls(db.prisma, runtime);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("queued");
  const saved = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } });
  expect(saved.targetRequestId).toBeNull(); expect(saved.state).toBe("queued");
});

test("control-before-comment ordering remains pending until its source arrives", async () => {
  await control(); await deliverMessageControls(db.prisma, runtime);
  expect((await db.prisma.runtimeMessageControl.findUniqueOrThrow({ where: { id: "control" } })).state).toBe("pending");
  await source(); await deliverMessageControls(db.prisma, runtime);
  expect((await db.prisma.runtimeMessageControl.findUniqueOrThrow({ where: { id: "control" } })).state).toBe("unsupported");
});

test("late terminal output from an explicitly replaced attempt never falls through to a checkpoint", async () => {
  const message = await source();
  await bindSourceTurn(db.prisma, message.id, sessionId, "attempt-one");
  await bindSourceTurn(db.prisma, message.id, sessionId, "attempt-two");
  expect(await projectSourceReply(config, db.prisma, event("attempt-one", "completed", "Obsolete answer"))).toBe(true);
  expect(creates).toHaveLength(0);
  await projectSourceReply(config, db.prisma, event("attempt-two", "completed", "Current answer"));
  expect(creates.map((comment) => comment.body)).toEqual(["Current answer"]);
});

test("a new content revision replaces obsolete integration reactions even when presentation changes", async () => {
  const old = await source();
  await reconcileSourceMessages(config, db.prisma);
  expect(emoji(old.commentId)).toEqual(["⏳"]);
  const next = await recordSourceMessage(db.prisma, { provider: "linear", connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine, resourceId: old.resourceId, resourceIdentifier: old.resourceIdentifier,
    commentId: old.commentId, threadRootId: old.threadRootId, authorId: old.authorId, body: "Edited feedback", presentation: { queued: "new_queue" } });
  await queueInstruction(db.prisma, { requestId: next.id, sessionId, sourceMessageId: next.id, text: next.body });
  await reconcileSourceMessages(config, db.prisma);
  expect(emoji(old.commentId)).toEqual(["new_queue"]);
});

async function ownerControlPolicy() {
  const policy = testConfig();
  policy.webhooks[policy.activeWebhookId]!.repositoryRouting[policy.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
  Object.assign(policy.repository.workflows, { steer: { id: "steer", connectionId: null, on: "comment.reaction", when: [{ "reaction.emoji": ["🧭"] }],
    skill: { skillset: "", flags: [] }, deliver: "steer-session", providerId: null, model: null, plan: null } });
  await db.prisma.remoteTask.create({ data: { requestKey: "owner-task", repositoryId: policy.activeRepositoryId, machineId: policy.machine,
    branchName: "codex/owner", worktreePath: "/tmp/source-replies", connectionId: policy.activeConnectionId, toolingRoot: "/tools", toolingRevision: "a".repeat(40),
    issueIdentifier: "ISSUE-1", primarySessionId: sessionId, phase: "working" } });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: sessionId, provider: "linear", connectionId: policy.activeConnectionId,
    resourceType: "issue-identifier", externalId: "ISSUE-1", relationship: "handles" } });
  return policy;
}

test("an authorized compass webhook arriving first converges with its ordinary comment onto one instruction", async () => {
  const policy = await ownerControlPolicy();
  comments.set("feedback", { id: "feedback", body: "Change direction", parentId: null, issue: { id: "issue-one", identifier: "ISSUE-1" }, user: { id: "owner" }, documentContent: null });
  const webhook = { type: "Reaction" as const, action: "create", webhookTimestamp: Date.now(), data: { id: "owner-reaction", emoji: "compass", commentId: "feedback", userId: "owner" } };
  expect(await handleReactionWebhook({ prisma: db.prisma, config: policy, agentRuntime: runtime, deliveryId: "control-first", webhook })).toMatchObject({ kind: "triggered" });
  await handleCommentWebhook({ prisma: db.prisma, config: policy, agentRuntime: runtime, deliveryId: "comment-second", webhook: {
    type: "Comment", action: "create", webhookTimestamp: Date.now(), data: { id: "feedback", body: "Change direction", userId: "owner", issue: { id: "issue-one", identifier: "ISSUE-1" } },
  } });
  await handleReactionWebhook({ prisma: db.prisma, config: policy, agentRuntime: runtime, deliveryId: "control-retry", webhook });
  expect(await db.prisma.runtimeInstruction.count()).toBe(1); expect(await db.prisma.runtimeSourceMessage.count()).toBe(1);
  expect(await db.prisma.runtimeMessageControl.count()).toBe(1); expect(runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeMessageControl.findFirstOrThrow()).state).toBe("unsupported");
});

test("a steering reaction binds the canonical content revision despite a late older edit webhook", async () => {
  const policy = await ownerControlPolicy();
  const issue = { id: "issue-one", identifier: "ISSUE-1" };
  comments.set("feedback", { id: "feedback", body: "Current edit", parentId: null, issue, user: { id: "owner" }, documentContent: null });
  for (const body of ["Current edit", "Older edit received late"]) await handleCommentWebhook({
    prisma: db.prisma, config: policy, agentRuntime: runtime, deliveryId: `revision:${body}`, webhook: {
      type: "Comment", action: "update", webhookTimestamp: Date.now(), data: { id: "feedback", body, userId: "owner", issue },
    },
  });
  const current = await db.prisma.runtimeSourceMessage.findFirstOrThrow({ where: { body: "Current edit" } });
  const older = await db.prisma.runtimeSourceMessage.findFirstOrThrow({ where: { body: "Older edit received late" } });
  const injected: string[] = [];
  runtime.steer = async (input) => { expect(await input.beforeSend()).toBe(true); injected.push(input.text); return { status: "applied" }; };
  await handleReactionWebhook({ prisma: db.prisma, config: policy, agentRuntime: runtime, deliveryId: "revision-control", webhook: {
    type: "Reaction", action: "create", webhookTimestamp: Date.now(), data: { id: "revision-reaction", emoji: "compass", commentId: "feedback", userId: "owner" },
  } });
  expect(injected).toHaveLength(1); expect(injected[0]).toContain("Current edit");
  expect(injected[0]).not.toContain("Older edit received late");
  expect((await db.prisma.runtimeMessageControl.findFirstOrThrow()).sourceMessageId).toBe(current.id);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: current.id } })).state).toBe("steered");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: older.id } })).state).toBe("queued");
});

test("a target turn finishing is not proof that an uncertain steering input was applied", async () => {
  const message = await source(); await control();
  runtime.steer = async (input) => { await input.beforeSend(); throw new Error("Steering result unknown"); };
  await deliverMessageControls(db.prisma, runtime);
  await recordSourceLifecycle(db.prisma, event(activeRequestId));
  await projectSourceReply(config, db.prisma, event(activeRequestId, "completed", "Output that might not include the steer"));
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("unknown");
  expect(creates).toHaveLength(0);
});

test("daemon loss after confirmed steer clears active status without replaying it", async () => {
  const message = await source(); await control();
  runtime.steer = async (input) => { await input.beforeSend(); return { status: "applied" }; };
  await deliverMessageControls(db.prisma, runtime);
  const restarted = createFakeAgentRuntime([{ ...runtime.sessions.get(sessionId)!, status: "idle" }]);
  await deliverMessageControls(db.prisma, restarted);
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("unknown");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: message.id } })).state).toBe("unknown");
  await deliverInstructions(db.prisma, restarted); expect(restarted.sentMessages).toHaveLength(0);
});

test("a page of controls awaiting absent comments cannot starve a ready steering request", async () => {
  const at = new Date(Date.now() - 1000);
  await db.prisma.runtimeMessageControl.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ id: `missing-${index}`, provider: "linear", connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine, authorId: "owner", commentId: `absent-${index}`, createdAt: at })) });
  await source(); await control(); await deliverMessageControls(db.prisma, runtime);
  expect((await db.prisma.runtimeMessageControl.findUniqueOrThrow({ where: { id: "control" } })).state).toBe("unsupported");
});
