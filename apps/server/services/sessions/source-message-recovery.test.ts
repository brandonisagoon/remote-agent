import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApp } from "../../app.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { recordSourceMessage, projectSourceReply, replyToSource, bindSourceTurn, recordSourceLifecycle } from "./source-messages.ts";
import { inspectSourceMessage, retrySourceMessage, recordExternalSourceDisposition } from "./source-message-recovery.ts";
import { deliverInstructions } from "./inbox.ts";
import { publishSourceReply, reconcileSourceMessages, projectMessageReactions } from "../../integrations/linear/message-delivery.ts";
import { handleCommentWebhook } from "../../integrations/linear/webhooks/comment/handler.ts";
import { registerThread } from "./threads.ts";
import type { AgentRuntimeStatus } from "../../../../types/runtime/index.ts";

let db: TestDatabase;
let config: ReturnType<typeof testConfig>;
let runtime: ReturnType<typeof createFakeAgentRuntime>;
const originalFetch = globalThis.fetch;
type Comment = { id: string; body: string; parentId: string | null; issue: { id: string; identifier: string }; user: { id: string }; documentContent: null };
let comments: Map<string, Comment>;
let creates: Array<{ id: string; body: string; parentId: string; issueId: string }>;
let onCreate: (() => Promise<void>) | undefined;
let onReaction: (() => Promise<void>) | undefined;
let reactions: Array<{ id: string; emoji: string; user: { id: string } }>;

beforeEach(async () => {
  db = await createTestDatabase(); config = testConfig(); runtime = createFakeAgentRuntime();
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
  comments = new Map(); creates = []; onCreate = undefined; onReaction = undefined; reactions = [];
  globalThis.fetch = (async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SourceIssueParent")) return Response.json({ data: { issue: { id: "issue-164", identifier: "DRA-164", parent: null } } });
    if (query.includes("QuestionComment")) return Response.json({ data: { comment: comments.get(variables.commentId) ?? null } });
    if (query.includes("DeliveryComment")) return Response.json({ data: { comment: comments.get(variables.id) ?? null } });
    if (query.includes("CreateThreadedIssueComment")) {
      await onCreate?.();
      const input = variables.input;
      if (!comments.has(input.id)) {
        creates.push(input);
        comments.set(input.id, { id: input.id, body: input.body, parentId: input.parentId,
          issue: { id: input.issueId, identifier: "DRA-164" }, user: { id: config.agentUserId }, documentContent: null });
      }
      return Response.json({ data: { commentCreate: { success: true, comment: { id: input.id } } } });
    }
    if (query.includes("DeliveryReactions")) return Response.json({ data: { comment: { reactions: [...reactions] } } });
    if (query.includes("RemoveDeliveryReaction")) {
      reactions = reactions.filter(row => row.id !== variables.id);
      return Response.json({ data: { reactionDelete: { success: true } } });
    }
    if (query.includes("DeliveryReaction")) {
      await onReaction?.();
      reactions.push({ id: `reaction-${crypto.randomUUID()}`, emoji: variables.input.emoji, user: { id: config.agentUserId } });
      return Response.json({ data: { reactionCreate: { success: true } } });
    }
    throw new Error(`Unexpected query: ${query}`);
  }) as typeof fetch;
});
afterEach(async () => { globalThis.fetch = originalFetch; await db.cleanup(); });

async function source(options: { commentId?: string; parentId?: string; body?: string; posted?: boolean } = {}) {
  const commentId = options.commentId ?? "retained-comment";
  const body = options.body ?? "Please fix the workflow delivery gap";
  const rootId = options.parentId ?? commentId;
  const issue = { id: "issue-164", identifier: "DRA-164" };
  comments.set(rootId, { id: rootId, body: "Original question/evidence", parentId: null, issue, user: { id: "owner" }, documentContent: null });
  comments.set(commentId, { id: commentId, body, parentId: options.parentId ?? null, issue, user: { id: "owner" }, documentContent: null });
  const row = await recordSourceMessage(db.prisma, { provider: "linear", connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine, resourceId: issue.id, resourceIdentifier: issue.identifier,
    commentId, threadRootId: rootId, authorId: "owner", body, presentation: {} });
  return db.prisma.runtimeSourceMessage.update({ where: { id: row.id }, data: { state: "unrouted", detail: "No eligible owner",
    replyBody: "I couldn't deliver this comment. No new task was started.", replyPosted: options.posted ?? true } });
}
async function owner(key = "recovery-primary", options: { paused?: boolean; task?: boolean; status?: AgentRuntimeStatus } = {}) {
  const session = await beginRuntimeSession(db.prisma, { sessionKey: key, agent: "codex", cwd: `/tmp/${key}`,
    repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
  await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: options.status ?? "active" } });
  runtime.putSession({ ...session, agent: "codex", status: options.status ?? "active" });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId,
    resourceType: "issue-identifier", externalId: "DRA-164", relationship: "handles" } });
  const task = options.task ? await db.prisma.remoteTask.create({ data: { requestKey: key, primarySessionId: session.id,
    repositoryId: config.activeRepositoryId, machineId: config.machine, connectionId: config.activeConnectionId,
    issueIdentifier: "DRA-164", branchName: `codex/${key}`, worktreePath: session.cwd, toolingRoot: "/tools", toolingRevision: "a".repeat(40),
    phase: "working", ownerPaused: options.paused ?? false } }) : null;
  return { session, task };
}
const retryRequest = (row: Awaited<ReturnType<typeof source>>, sessionId: string, requestKey = "explicit-retry") => ({
  requestKey, sessionId, expectedUpdatedAt: row.updatedAt.toISOString(), reason: "Existing managed owner now attached; human explicitly requested this action", authorityRef: "codex://threads/human-authorization",
});
const dispositionRequest = (row: Awaited<ReturnType<typeof source>>, outcome: "handled" | "assigned" | "informational" | "needs-action" = "handled", requestKey = "external-disposition") => ({
  requestKey, expectedUpdatedAt: row.updatedAt.toISOString(), reason: "Verified in the original native coordination chat",
  owner: { kind: "native-codex-chat" as const, threadId: "actual-native-chat", hostId: "local" }, outcome,
  evidence: ["codex://threads/actual-native-chat?turn=verified-report"],
});
const retry = (row: Awaited<ReturnType<typeof source>>, sessionId: string, requestKey?: string) => retrySourceMessage({ prisma: db.prisma, config, runtime, id: row.id, request: retryRequest(row, sessionId, requestKey) });
async function waitForCompleted(id: string) {
  for (let i = 0; i < 100; i++) {
    if ((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id } })).state === "completed") return;
    await Bun.sleep(5);
  }
  throw new Error("Recovered instruction did not complete");
}
function app() { return createApp({ config, prisma: db.prisma, agentRuntime: runtime }); }
const headers = () => ({ authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" });

test("operator inspection and paginated listing preserve server facts and require bearer authentication", async () => {
  const first = await source(); const second = await source({ commentId: "second-comment" });
  const api = app();
  expect((await api.request("/api/source-messages")).status).toBe(401);
  expect((await api.request(`/api/source-messages/${encodeURIComponent(first.id)}/retry`, { method: "POST", body: "{}" })).status).toBe(401);
  const page = await (await api.request("/api/source-messages?limit=1", { headers: headers() })).json();
  expect(page.messages.map((row: { id: string }) => row.id)).toEqual([first.id]);
  expect(page.messages[0].body).toBeUndefined();
  expect(page.nextAfterSequence).toBe(first.sequence);
  const next = await (await api.request(`/api/source-messages?afterSequence=${page.nextAfterSequence}`, { headers: headers() })).json();
  expect(next.messages.map((row: { id: string }) => row.id)).toEqual([second.id]);
  const inspection = await (await api.request(`/api/source-messages/${encodeURIComponent(first.id)}`, { headers: headers() })).json();
  expect(inspection.source.body).toBe(first.body); expect(inspection.source.sessionId).toBeNull();
  expect(inspection.managedOwners).toEqual([]); expect(inspection.publicationOrigin).toBeNull();
  expect(inspection.nativeCodexChatTransport).toBe("unsupported");
  expect((await api.request("/api/source-messages?limit=101", { headers: headers() })).status).toBe(400);
  expect((await api.request("/api/source-messages/not-found", { headers: headers() })).status).toBe(404);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("external native-chat disposition is idempotent evidence, never managed delivery or automatic work", async () => {
  const row = await source({ body: "Audit status: this issue is already handled" });
  const request = dispositionRequest(row);
  const first = await recordExternalSourceDisposition({ prisma: db.prisma, config, id: row.id, request });
  const same = await recordExternalSourceDisposition({ prisma: db.prisma, config, id: row.id, request });
  expect(same.replayed).toBe(true); expect(same.receipt.id).toBe(first.receipt.id);
  const inspection = await inspectSourceMessage(db.prisma, config, row.id);
  expect(inspection.externalDisposition?.externalOwner).toEqual(request.owner);
  expect(inspection.externalDisposition?.evidence).toEqual(request.evidence);
  expect(inspection.publicationOrigin).toBeNull(); // Prose and shared author are not trusted origin evidence.
  expect(inspection.source.state).toBe("unrouted"); expect(inspection.source.sessionId).toBeNull(); expect(inspection.source.requestId).toBeNull();
  expect(inspection.source.replyId).toBe(row.replyId); expect(inspection.source.replyBody).toBe(row.replyBody); expect(inspection.source.replyPosted).toBe(true);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0); expect(runtime.ensureInputs).toEqual([]); expect(runtime.sentMessages).toEqual([]);
  expect(await db.prisma.runtimeSession.count()).toBe(0);
  await expect(recordExternalSourceDisposition({ prisma: db.prisma, config, id: row.id, request: { ...request, outcome: "assigned" } })).rejects.toThrow("different request");
  const { session } = await owner();
  await expect(retry(first.source, session.id)).rejects.toThrow("External handling is already recorded");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("an unchanged retained comment stays unrouted after attachment until an explicit recovery is accepted once", async () => {
  const row = await source({ parentId: "original-root" });
  await expect(retry(row, "actual-native-chat")).rejects.toThrow("unique eligible existing ACP primary");
  const { session } = await owner();
  // The normal handler records the new ingress receipt but must not replay the
  // already-retained content just because an owner has since appeared.
  await registerThread(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, threadRootCommentId: row.threadRootId, runtimeSessionId: session.id });
  const unchanged = await handleCommentWebhook({ prisma: db.prisma, config, agentRuntime: runtime, deliveryId: "same-comment-again",
    webhook: { type: "Comment", action: "create", webhookTimestamp: Date.now(), data: { id: row.commentId, body: row.body,
      parentId: row.threadRootId, userId: row.authorId, issue: { id: row.resourceId, identifier: row.resourceIdentifier } } } });
  expect(unchanged.kind).toBe("duplicate"); expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  const request = retryRequest(row, session.id);
  const results = await Promise.all([retrySourceMessage({ prisma: db.prisma, config, runtime, id: row.id, request }), retrySourceMessage({ prisma: db.prisma, config, runtime, id: row.id, request })]);
  expect(results[0]!.receipt.id).toBe(results[1]!.receipt.id);
  expect(results.filter(result => !result.replayed)).toHaveLength(1);
  const queued = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: row.id } });
  expect(queued.state).toBe("queued"); expect(queued.sessionId).toBe(session.id); expect(queued.requestId).toBeNull();
  expect(queued.replyId).not.toBe(row.replyId); expect(queued.replyBody).toBeNull(); expect(queued.replyPosted).toBe(false);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1); expect(runtime.sentMessages).toEqual([]);
  expect(results[0]!.receipt.priorReplyId).toBe(row.replyId); expect(results[0]!.receipt.priorReplyPosted).toBe(true);
  await expect(retry(queued, session.id, "different-retry")).rejects.toThrow("unbound unrouted");
  // Shared durable inbox, not a second delivery mechanism.
  runtime.putSession({ ...session, agent: "codex", status: "idle" });
  await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "idle" } });
  await deliverInstructions(db.prisma, runtime, config); await waitForCompleted(row.id);
  expect(runtime.sentMessages).toHaveLength(1); expect(runtime.sentMessages[0]!.text).toContain(row.body);
  expect(runtime.sentMessages[0]!.text).toContain(`sourceMessageId "${row.id}"`);
  await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "active" } });
  runtime.observeSessionActivity = () => ({ state: "executing", requestId: row.id, observedAt: Date.now() });
  await replyToSource({ prisma: db.prisma, config, runtime, sessionId: session.id, sourceMessageId: row.id, requestKey: "answer", body: "Recovery handled in its original thread" });
  await projectSourceReply(config, db.prisma, { kind: "turn", id: "finish", sessionId: session.id, requestId: row.id, phase: "completed", output: "Same answer again", createdAt: Date.now() });
  expect(creates).toEqual([{ id: queued.replyId, issueId: row.resourceId, parentId: row.threadRootId, body: "Recovery handled in its original thread" }]);
  await db.prisma.$disconnect(); await deliverInstructions(db.prisma, runtime, config); await reconcileSourceMessages(config, db.prisma);
  expect(runtime.sentMessages).toHaveLength(1); expect(creates).toHaveLength(1);
  expect((await retrySourceMessage({ prisma: db.prisma, config, runtime, id: row.id, request })).replayed).toBe(true);
});

test("needs-action disposition can authorize later managed retry while replaying old disposition reports current server state", async () => {
  const row = await source(); const request = dispositionRequest(row, "needs-action");
  const external = await recordExternalSourceDisposition({ prisma: db.prisma, config, id: row.id, request });
  const { session } = await owner(); await retry(external.source, session.id);
  const replay = await recordExternalSourceDisposition({ prisma: db.prisma, config, id: row.id, request });
  expect(replay.source.state).toBe("queued"); expect(replay.source.sessionId).toBe(session.id);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(2);
});

test("operator routes validate explicit recovery and external evidence without claiming native delivery", async () => {
  const row = await source(); const api = app();
  const url = `/api/source-messages/${encodeURIComponent(row.id)}`;
  expect((await api.request(`${url}/external-disposition`, { method: "POST", headers: headers(), body: "{" })).status).toBe(400);
  expect((await api.request(`${url}/retry`, { method: "POST", headers: headers(), body: JSON.stringify({ requestKey: "missing-authority" }) })).status).toBe(400);
  const request = dispositionRequest(row, "needs-action");
  const disposition = await api.request(`${url}/external-disposition`, { method: "POST", headers: headers(), body: JSON.stringify(request) });
  expect(disposition.status).toBe(200);
  const external = await disposition.json();
  expect(external.source.state).toBe("unrouted"); expect(external.source.sessionId).toBeNull();
  const { session } = await owner();
  const recovery = { ...retryRequest(row, session.id), expectedUpdatedAt: external.source.updatedAt };
  expect((await api.request(`${url}/retry`, { method: "POST", headers: headers(), body: JSON.stringify(recovery) })).status).toBe(202);
  expect((await api.request(`${url}/retry`, { method: "POST", headers: headers(), body: JSON.stringify(recovery) })).status).toBe(200);
  expect((await api.request(`${url}/retry`, { method: "POST", headers: headers(), body: JSON.stringify({ ...recovery, reason: "Changed authority" }) })).status).toBe(409);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1); expect(runtime.sentMessages).toHaveLength(0);
});

test("current question framing is preserved through explicit recovery and thread registration", async () => {
  const row = await source({ parentId: "question-root" }); const { session } = await owner();
  await db.prisma.runtimeQuestion.create({ data: { id: row.threadRootId, runtimeSessionId: session.id,
    connectionId: row.connectionId, issueId: row.resourceId, body: "Which behavior should we use?", requestKey: "question", state: "posted" } });
  await registerThread(db.prisma, { provider: "linear", connectionId: row.connectionId, threadRootCommentId: row.threadRootId, runtimeSessionId: session.id, relationship: "question" });
  await retry(row, session.id);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: row.id } })).text).toContain("This answers your earlier question in this thread.\nQuestion: Which behavior should we use?");
  expect((await db.prisma.runtimeQuestion.findUniqueOrThrow({ where: { id: row.threadRootId } })).state).toBe("answered");
  expect(await db.prisma.runtimeSessionResourceLink.count({ where: { runtimeSessionId: session.id, resourceType: "comment-thread", relationship: "question", endedAt: null } })).toBe(0);
});

test("paused owner accepts a durable queue without changing pause, tooling pin or starting execution", async () => {
  const row = await source(); const { session, task } = await owner("paused-primary", { task: true, paused: true, status: "idle" });
  await retry(row, session.id); await deliverInstructions(db.prisma, runtime, config);
  expect(runtime.sentMessages).toEqual([]);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("queued");
  const current = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task!.id } });
  expect(current.ownerPaused).toBe(true); expect(current.toolingRevision).toBe(task!.toolingRevision); expect(current.primarySessionId).toBe(session.id);
});

test("ambiguous, closed, wrong-repository and native IDs are never recovery targets", async () => {
  const row = await source(); const { session: first } = await owner(); const { session: second } = await owner("other-primary");
  await expect(retry(row, first.id)).rejects.toThrow("unique eligible existing ACP primary");
  await db.prisma.runtimeSession.update({ where: { id: second.id }, data: { status: "closed" } });
  await expect(retry(row, "native-chat-id")).rejects.toThrow("unique eligible existing ACP primary");
  await db.prisma.runtimeSession.update({ where: { id: first.id }, data: { repositoryId: "other-repo" } });
  await expect(retry(row, first.id)).rejects.toThrow("unique eligible existing ACP primary");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0); expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
});

test("current subscription, thread ownership, source revision and existing uncertain instruction guard recovery", async () => {
  const row = await source({ parentId: "shared-root" }); const { session } = await owner();
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["different-owner"] }] };
  await expect(retry(row, session.id)).rejects.toThrow("no longer subscribed");
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
  const other = await beginRuntimeSession(db.prisma, { sessionKey: "thread-owner", agent: "codex", cwd: "/tmp/thread-owner", repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
  await registerThread(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, threadRootCommentId: row.threadRootId, runtimeSessionId: other.id });
  await expect(retry(row, session.id)).rejects.toThrow("thread still belongs");
  await db.prisma.runtimeSession.update({ where: { id: other.id }, data: { status: "closed" } });
  await db.prisma.runtimeSourceMessage.update({ where: { id: row.id }, data: { detail: "New observation", updatedAt: new Date(row.updatedAt.getTime() + 10) } });
  await expect(retry(row, session.id)).rejects.toThrow("Source message changed");
  const current = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: row.id } });
  await db.prisma.runtimeInstruction.create({ data: { id: "already-uncertain", sessionId: session.id, sourceMessageId: row.id, text: row.body, state: "unknown" } });
  await expect(retry(current, session.id)).rejects.toThrow("already has an instruction");
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
});

test("changed or removed Linear content cannot replay a stale retained body", async () => {
  const old = await source(); const { session } = await owner();
  await source({ body: "Updated owner instruction" });
  await expect(retry(old, session.id)).rejects.toThrow("changed, removed or moved");
  comments.delete(old.commentId);
  await expect(retry(old, session.id)).rejects.toThrow("Original reply thread is unavailable");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test("a late obsolete edit cannot prevent recovery of the canonical current comment", async () => {
  const current = await source({ body: "Canonical current instruction A" });
  const obsolete = await source({ body: "Obsolete instruction B delivered late" });
  comments.set(current.commentId, { ...comments.get(current.commentId)!, body: current.body });
  const { session } = await owner();
  await expect(retry(obsolete, session.id)).rejects.toThrow("changed, removed or moved");
  const result = await retry(current, session.id);
  expect(result.source.state).toBe("queued");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: current.id } })).text).toContain(current.body);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("canonical recovery projects its queue, active and reply reactions despite a late obsolete edit", async () => {
  const first = await source({ body: "Canonical current instruction" });
  await source({ body: "Obsolete late instruction" });
  const current = await db.prisma.runtimeSourceMessage.update({ where: { id: first.id }, data: { presentation: { queued: "⏳", processing: "👀", replied: "💬", attention: "⚠️" } } });
  comments.set(current.commentId, { ...comments.get(current.commentId)!, body: current.body });
  const { session } = await owner(); await retry(current, session.id);
  await reconcileSourceMessages(config, db.prisma);
  expect(reactions.map(row => row.emoji)).toEqual(["⏳"]);
  await bindSourceTurn(db.prisma, current.id, session.id, current.id);
  await recordSourceLifecycle(db.prisma, { kind: "turn", id: "start", sessionId: session.id, requestId: current.id, phase: "started", createdAt: Date.now() });
  await reconcileSourceMessages(config, db.prisma);
  expect(reactions.map(row => row.emoji)).toEqual(["👀"]);
  await projectSourceReply(config, db.prisma, { kind: "turn", id: "finish", sessionId: session.id, requestId: current.id, phase: "completed", output: "Canonical answer", createdAt: Date.now() });
  await reconcileSourceMessages(config, db.prisma);
  expect(reactions.map(row => row.emoji)).toEqual(["💬"]);
  const newer = await source({ body: "Actual new input after recovery" });
  await db.prisma.runtimeSourceMessage.update({ where: { id: newer.id }, data: { presentation: { attention: "⚠️" }, replyBody: null, replyPosted: false } });
  await reconcileSourceMessages(config, db.prisma);
  expect(reactions.map(row => row.emoji)).toEqual(["⚠️"]);
});

test("a stale reaction write schedules current truth even after a newer projection already finished", async () => {
  const first = await source();
  const queued = await db.prisma.runtimeSourceMessage.update({ where: { id: first.id }, data: { state: "queued", replyBody: null, replyPosted: false,
    presentation: { queued: "⏳", processing: "👀" } } });
  let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  onReaction = async () => { onReaction = undefined; entered(); await gate; };
  const stale = projectMessageReactions(config, db.prisma, queued);
  try {
    await pending;
    const active = await db.prisma.runtimeSourceMessage.update({ where: { id: first.id }, data: { state: "processing" } });
    await projectMessageReactions(config, db.prisma, active);
    await db.prisma.runtimeSourceMessage.update({ where: { id: first.id }, data: { projectionPending: false } });
    release(); expect(await stale).toBe(false);
    expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: first.id } })).projectionPending).toBe(true);
    await reconcileSourceMessages(config, db.prisma);
    expect(reactions.map(row => row.emoji)).toEqual(["👀"]);
  } finally { release(); await stale; }
});

test("a stale reaction CAS reschedules the authoritative newer revision rather than the superseded row", async () => {
  const first = await source();
  const queued = await db.prisma.runtimeSourceMessage.update({ where: { id: first.id }, data: { state: "queued", replyBody: null, replyPosted: false,
    presentation: { queued: "⏳", processing: "👀" } } });
  let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  onReaction = async () => { onReaction = undefined; entered(); await gate; };
  const stale = projectMessageReactions(config, db.prisma, queued);
  try {
    await pending;
    const revision = await source({ body: "Newer owner input" });
    const active = await db.prisma.runtimeSourceMessage.update({ where: { id: revision.id }, data: { state: "processing", replyBody: null, replyPosted: false,
      presentation: { queued: "⏳", processing: "👀" } } });
    await projectMessageReactions(config, db.prisma, active);
    await db.prisma.runtimeSourceMessage.update({ where: { id: active.id }, data: { projectionPending: false } });
    await db.prisma.runtimeSourceMessage.update({ where: { id: queued.id }, data: { detail: "Old receipt changed concurrently" } });
    release(); expect(await stale).toBe(false);
    expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: active.id } })).projectionPending).toBe(true);
    await reconcileSourceMessages(config, db.prisma);
    expect(reactions.map(row => row.emoji)).toEqual(["👀"]);
  } finally { release(); await stale; }
});

test("a new content revision arriving during canonical validation requires reinspection before retry", async () => {
  const row = await source(); const { session } = await owner();
  const previousFetch = globalThis.fetch; let changed = false;
  globalThis.fetch = (async (url, init) => {
    const result = await previousFetch(url, init);
    if (!changed) { changed = true; await source({ body: "Another revision arrived concurrently" }); }
    return result;
  }) as typeof fetch;
  await expect(retry(row, session.id)).rejects.toThrow("Comment revisions changed during validation");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0); expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
});

test("ownership and thread changes during remote validation are rechecked before the atomic queue commit", async () => {
  const row = await source(); const { session } = await owner();
  const previousFetch = globalThis.fetch;
  let revoke = true;
  globalThis.fetch = (async (url, init) => {
    if (revoke) { revoke = false;
      await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: session.id, relationship: "handles" }, data: { endedAt: new Date() } });
    }
    return previousFetch(url, init);
  }) as typeof fetch;
  await expect(retry(row, session.id)).rejects.toThrow("Source ownership changed");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0); expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: row.id } })).replyId).toBe(row.replyId);
});

test("server publication receipts establish origin across shared author identity; native chat report prose does not", async () => {
  const { session } = await owner();
  const update = await db.prisma.runtimeIssueUpdate.create({ data: { runtimeSessionId: session.id, requestKey: "status-update",
    connectionId: config.activeConnectionId, issueId: "issue-164", input: { body: "Report" }, evidence: [], commentPosted: true } });
  const row = await source({ commentId: update.id, body: "Report" });
  const inspection = await inspectSourceMessage(db.prisma, config, row.id);
  expect(inspection.publicationOrigin).toEqual({ kind: "issue-update", receiptId: update.id, confirmed: true });
  await expect(retry(row, session.id)).rejects.toThrow("server publication receipt");
  const human = await source({ commentId: "human-request", body: "Audit status: this looks like a report but please handle it" });
  expect((await inspectSourceMessage(db.prisma, config, human.id)).publicationOrigin).toBeNull();
  await retry(human, session.id);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("an old in-flight failure reply only confirms the archived receipt, never the recovered answer", async () => {
  const row = await source({ posted: false }); const { session } = await owner();
  let entered!: () => void; const publishing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  onCreate = async () => { entered(); await gate; };
  const oldPublish = publishSourceReply(config, db.prisma, row.id);
  try {
    await publishing;
    const accepted = await retry(row, session.id);
    expect(accepted.receipt.priorReplyPosted).toBe(false);
    await db.prisma.runtimeSourceMessage.update({ where: { id: row.id }, data: { replyBody: "Actual recovered answer" } });
    release(); await oldPublish;
    const current = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(current.replyPosted).toBe(false); expect(current.replyId).not.toBe(row.replyId);
    expect((await db.prisma.runtimeSourceMessageResolution.findUniqueOrThrow({ where: { id: accepted.receipt.id } })).priorReplyPosted).toBe(true);
    onCreate = undefined; await publishSourceReply(config, db.prisma, row.id);
    expect(creates.map(input => [input.id, input.body])).toEqual([[row.replyId, row.replyBody!], [current.replyId, "Actual recovered answer"]]);
    expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: row.id } })).replyPosted).toBe(true);
  } finally { release(); await oldPublish; }
});
