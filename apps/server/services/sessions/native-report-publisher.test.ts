import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp } from "../../app.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { issueUpdateDelivery } from "./issue-updates.ts";
import { inspectNativeReportPublisher, publishNativeReport } from "./native-report-publisher.ts";
import { NATIVE_REPORT_ORIGIN, readNativeReportOrigin } from "./native-report-origin.ts";
import { handleCommentWebhook } from "../../integrations/linear/webhooks/comment/handler.ts";
import { LinearCommentWebhookSchema, type LinearCommentWebhook } from "../../integrations/linear/webhook-types/comment.ts";
import { withRequestLifetime } from "../../request-lifetime.ts";

let db: TestDatabase;
const originalFetch = globalThis.fetch;
const originalDelivery = { ...issueUpdateDelivery };
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { globalThis.fetch = originalFetch; Object.assign(issueUpdateDelivery, originalDelivery); await db.cleanup(); });

async function fixture() {
  const prisma = db.prisma; const config = testConfig(); const runtime = createFakeAgentRuntime();
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
  const session = await beginRuntimeSession(prisma, { sessionKey: "native-publisher", agent: "codex", role: "primary", cwd: "/tmp/native-publisher", repositoryId: config.activeRepositoryId, machineId: config.machine });
  await prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "idle" } });
  runtime.putSession({ ...session, agent: "codex", status: "idle" });
  const task = await prisma.remoteTask.create({ data: { requestKey: "native-report-task", primarySessionId: session.id, repositoryId: config.activeRepositoryId, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-98", worktreePath: session.cwd, branchName: "codex/original", toolingRoot: "/original-tools", toolingRevision: "a".repeat(40), phase: "waiting" } });
  const link = await prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", relationship: "handles", externalId: "DRA-98" } });
  const issue = { id: "issue-98", identifier: "DRA-98", branchName: "codex/original", title: "Original", description: "Original", state: { id: "done", name: "Done", type: "completed" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const comments = new Map<string, any>(); let writes = 0; let beforeCreate: (() => Promise<void>) | undefined;
  let onRead: (() => Promise<void>) | undefined;
  const receive = (webhook: LinearCommentWebhook, deliveryId = crypto.randomUUID()) => handleCommentWebhook({ prisma, config, agentRuntime: runtime, deliveryId, webhook });
  const event = (comment: any, action: "create" | "update" = "create", actor = "owner"): LinearCommentWebhook => ({ type: "Comment", action, actor: { id: actor }, webhookTimestamp: Date.now(), data: { id: comment.id, body: comment.body, issue: comment.issue, userId: comment.user.id, createdAt: comment.createdAt, updatedAt: comment.updatedAt } });
  const client = { ...issueUpdateDelivery,
    source: async () => ({ session: await prisma.runtimeSession.findUniqueOrThrow({ where: { id: session.id } }), link, config, issue }),
    read: async () => { await onRead?.(); return issue; },
    update: async () => { throw new Error("No source-state writes allowed"); },
    create: async (_key: unknown, value: { id?: string; issueId: string; body: string }) => {
      await beforeCreate?.(); writes++;
      expect(await readNativeReportOrigin(prisma, config.activeConnectionId, value.id!)).not.toBeNull();
      expect(await prisma.runtimeLifecycleEvent.count()).toBe(0);
      if (!comments.has(value.id!)) comments.set(value.id!, { id: value.id!, body: value.body, issue: { id: issue.id, identifier: issue.identifier }, parentId: null, user: { id: "owner" }, createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.010Z" });
      expect(await receive(event(comments.get(value.id!)))).toMatchObject({ kind: "ignored", reason: "native_report_publication" });
      return { id: value.id! };
    },
    comment: async (_key: unknown, id: string) => comments.get(id) ?? null,
  };
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.includes("DeliveryComment")) return Response.json({ data: { comment: comments.get(body.variables.id) ?? null } });
    throw new Error(`Unexpected provider request ${body.query}`);
  }) as typeof fetch;
  const inspection = await inspectNativeReportPublisher({ prisma, config, taskId: task.id });
  const request = { requestKey: "native-turn-report", body: "Inspection finished. No cleanup ran.", ownershipDigest: inspection.ownershipDigest, owner: { kind: "native-codex-chat" as const, hostId: "local", threadId: "native-coordinator", turnId: "native-turn-1" } };
  const input = { prisma, config, taskId: task.id, request };
  const publish = (override: typeof issueUpdateDelivery = client) => publishNativeReport(input, override);
  const app = createApp({ prisma, config, agentRuntime: runtime, trustLocal: true });
  return { prisma, config, runtime, task, session, link, issue, comments, client, input, publish, event, receive, app, writes: () => writes, setBeforeCreate: (value: typeof beforeCreate) => { beforeCreate = value; }, setOnRead: (value: typeof onRead) => { onRead = value; } };
}

test("native publication registers provenance before webhook ingress, without a managed execution", async () => {
  const f = await fixture(); const result = await f.publish();
  expect(result.published).toBe(true); expect(f.writes()).toBe(1);
  expect(await f.prisma.runtimeSourceMessage.count()).toBe(0);
  expect(await f.prisma.runtimeInstruction.count()).toBe(0);
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(0);
  expect(f.runtime.sentMessages).toEqual([]);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: NATIVE_REPORT_ORIGIN } })).toBe(1);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "issue-update-published" } })).toBe(1);
  expect(f.issue.state.name).toBe("Done");
});

test("lost publication acknowledgment and restart reuse the exact outbox and native origin", async () => {
  const f = await fixture(); let unavailable = true;
  const delivery = { ...f.client, create: async (...args: Parameters<typeof f.client.create>) => { await f.client.create(...args); return null; }, comment: async (...args: Parameters<typeof f.client.comment>) => { if (unavailable) throw new Error("Read unavailable"); return f.client.comment(...args); } };
  await expect(f.publish(delivery)).rejects.toThrow("Read unavailable");
  const before = await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: NATIVE_REPORT_ORIGIN } });
  await f.prisma.$disconnect(); unavailable = false;
  const result = await f.publish(delivery); expect(result.published).toBe(true);
  expect(f.comments.size).toBe(1); expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
  expect(await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: NATIVE_REPORT_ORIGIN } })).toEqual(before);
  expect(await f.prisma.runtimeInstruction.count()).toBe(0);
  const writes = f.writes(); expect(await f.publish()).toEqual(result); expect(f.writes()).toBe(writes);
});

test.each(["pause", "pin", "source-owner", "origin"])("%s during final source lookup refuses publication and preserves its pending outbox", async kind => {
  const f = await fixture(); let reads = 0;
  f.setOnRead(async () => {
    if (++reads !== 2) return;
    if (kind === "pause") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (kind === "pin") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "b".repeat(40) } });
    if (kind === "source-owner") await f.prisma.runtimeSessionResourceLink.update({ where: { id: f.link.id }, data: { endedAt: new Date() } });
    if (kind === "origin") await f.prisma.runtimeMetadataEvent.updateMany({ where: { action: NATIVE_REPORT_ORIGIN }, data: { value: "{}" } });
  });
  await expect(f.publish()).rejects.toThrow(); expect(f.writes()).toBe(0);
  expect((await f.prisma.runtimeIssueUpdate.findFirstOrThrow()).commentPosted).toBe(false);
});

test("real request cancellation after a late provider read cannot reach publication", async () => {
  const f = await fixture(); const controller = new AbortController(); let reads = 0;
  let entered!: () => void; const atRead = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.setOnRead(async () => { if (++reads === 2) { entered(); await gate; } });
  let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
  const run = withRequestLifetime({ timeoutMs: 2000, signal: controller.signal }, async () => { try { return await f.publish(); } finally { finished(); } });
  await atRead; controller.abort(); await expect(run).rejects.toThrow("disconnected"); release(); await done;
  expect(f.writes()).toBe(0); expect((await f.prisma.runtimeIssueUpdate.findFirstOrThrow()).commentPosted).toBe(false);
  f.setOnRead(undefined); expect((await f.publish()).published).toBe(true); expect(f.writes()).toBe(1);
});

test("concurrent retries reserve one origin and reuse the existing serialized publisher", async () => {
  const f = await fixture();
  const results = await Promise.all([f.publish(), f.publish(), f.publish()]);
  expect(new Set(results.map(row => row.commentId)).size).toBe(1);
  expect(f.writes()).toBe(1); expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: NATIVE_REPORT_ORIGIN } })).toBe(1);
});

test("same request key cannot replace native origin, body, owner or source identity", async () => {
  const f = await fixture(); await f.publish();
  for (const request of [ { ...f.input.request, body: "New owner instruction" }, { ...f.input.request, owner: { ...f.input.request.owner, turnId: "other-turn" } }, { ...f.input.request, ownershipDigest: "f".repeat(64) } ]) {
    await expect(publishNativeReport({ ...f.input, request }, f.client)).rejects.toThrow();
  }
  expect(f.writes()).toBe(1); expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
});

test("owner-only HTTP publication uses the real outbox and denies session IPC provenance", async () => {
  const f = await fixture(); Object.assign(issueUpdateDelivery, f.client);
  const url = `/api/tasks/${f.task.id}/native-reports`;
  expect((await f.app.request(url)).status).toBe(401);
  expect((await f.app.request(url, { method: "POST", body: JSON.stringify(f.input.request), headers: { "content-type": "application/json" } })).status).toBe(401);
  const headers = { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" };
  expect((await f.app.request(url, { headers })).status).toBe(200);
  const response = await f.app.request(url, { method: "POST", headers, body: JSON.stringify(f.input.request) });
  expect(response.status).toBe(200); expect((await response.json()).published).toBe(true);
  expect(await f.prisma.runtimeInstruction.count()).toBe(0);
});

test.each([false, true])("managed HTTP replay cannot publish a reserved native report (paused=%s)", async paused => {
  const f = await fixture();
  f.setOnRead(async () => { throw new Error("publication observation interrupted"); });
  await expect(f.publish()).rejects.toThrow("publication observation interrupted");
  f.setOnRead(undefined); Object.assign(issueUpdateDelivery, f.client);
  if (paused) await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  const receipt = await f.prisma.runtimeIssueUpdate.findFirstOrThrow();
  const origin = await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: NATIVE_REPORT_ORIGIN } });
  const response = await f.app.request(`/api/sessions/${f.session.id}/issue-update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt.input) });
  expect(response.status).toBe(409); expect((await response.json()).error).toContain(paused ? "paused or closed" : "owner-authenticated publisher");
  expect(f.writes()).toBe(0); expect(await f.prisma.runtimeIssueUpdate.findFirstOrThrow()).toEqual(receipt);
  expect(await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: NATIVE_REPORT_ORIGIN } })).toEqual(origin);
  if (!paused) expect((await f.publish()).published).toBe(true);
});

test.each(["owner", "app"])("signed %s-created native publication cannot enter the inbox before its acknowledgment", async author => {
  const f = await fixture();
  f.client.create = async (_key, value) => {
    expect(await readNativeReportOrigin(f.prisma, f.config.activeConnectionId, value.id!)).not.toBeNull();
    const comment = { id: value.id!, body: value.body, issue: { id: f.issue.id, identifier: f.issue.identifier }, parentId: null, user: { id: author === "app" ? f.config.agentUserId : "owner" }, createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.010Z" };
    const body = JSON.stringify(f.event(comment, "create", comment.user.id));
    const secret = f.config.webhooks[f.config.activeWebhookId]!.webhookSecret;
    const response = await f.app.request(`/webhooks/${f.config.activeWebhookId}`, { method: "POST", headers: { "content-type": "application/json", "linear-delivery": `signed-${author}-create`, "linear-signature": createHmac("sha256", secret).update(body).digest("hex") }, body });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true, reason: author === "app" ? "outside_subscription" : "native_report_publication" });
    expect(await f.prisma.runtimeSourceMessage.count()).toBe(0); expect(await f.prisma.runtimeInstruction.count()).toBe(0);
    expect((await f.prisma.runtimeIssueUpdate.findFirstOrThrow()).commentPosted).toBe(false);
    return { id: value.id! };
  };
  expect((await f.publish()).published).toBe(true);
});

test("later human A→B→A and same-body edits retain exact provider generations", async () => {
  const f = await fixture(); const result = await f.publish(); const comment = f.comments.get(result.commentId)!;
  const original = comment.body;
  for (const [seconds, body] of [[1, "Please continue with this correction"], [2, original], [3, original]] as const) {
    comment.body = body; comment.updatedAt = `2026-10-29T12:00:0${seconds}.000Z`;
    expect(await f.receive(f.event(comment, "update"))).toMatchObject({ kind: "accepted" });
  }
  const sources = await f.prisma.runtimeSourceMessage.findMany({ orderBy: { sequence: "asc" } });
  expect(sources.map(row => row.body)).toEqual(["Please continue with this correction", original, original]);
  expect(new Set(sources.map(row => row.id)).size).toBe(3);
  expect(sources.every(row => row.id.includes(":revision:"))).toBe(true);
  const webhook = f.event(comment, "update"); await f.receive(webhook); expect(await f.prisma.runtimeInstruction.count()).toBe(3);
});

test("human edit delivered before the initial create is preserved when create arrives later", async () => {
  const f = await fixture();
  f.client.create = async (_key, value) => {
    const original = { id: value.id!, body: value.body, issue: { id: f.issue.id, identifier: f.issue.identifier }, parentId: null, user: { id: "owner" }, createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.010Z" };
    const edited = { ...original, body: "Please address the new owner request", updatedAt: "2026-10-29T12:01:00.000Z" };
    f.comments.set(value.id!, edited);
    expect(await f.receive(f.event(edited, "update"))).toMatchObject({ kind: "accepted" });
    expect(await f.receive(f.event(original))).toMatchObject({ kind: "ignored", reason: "native_report_publication" });
    return { id: value.id! };
  };
  await f.publish();
  expect(await f.prisma.runtimeSourceMessage.count()).toBe(1);
  expect((await f.prisma.runtimeSourceMessage.findFirstOrThrow()).body).toBe("Please address the new owner request");
});

test("ordinary human comments with identical report text have no inferred native origin", async () => {
  const f = await fixture(); const result = await f.publish();
  const ordinary = { ...f.comments.get(result.commentId), id: "genuine-human-comment" };
  expect(await f.receive(f.event(ordinary))).toMatchObject({ kind: "accepted" });
  expect((await f.prisma.runtimeSourceMessage.findFirstOrThrow()).commentId).toBe(ordinary.id);
});

test.each(["same-version", "older-version", "changed-creation", "unknown-actor", "wrong-source", "forged-create"])("%s cannot masquerade as a new human generation or native publication", async kind => {
  const f = await fixture(); const result = await f.publish(); const comment = f.comments.get(result.commentId)!;
  let webhook = f.event(comment, "update");
  if (kind === "same-version") { comment.body = "Different body"; webhook = f.event(comment, "update"); }
  if (kind === "older-version") { comment.updatedAt = "2026-10-29T11:59:59.000Z"; webhook = f.event(comment, "update"); }
  if (kind === "changed-creation") { comment.createdAt = "2026-10-29T11:59:59.000Z"; comment.updatedAt = "2026-10-29T12:01:00.000Z"; webhook = f.event(comment, "update"); }
  if (kind === "unknown-actor") { comment.updatedAt = "2026-10-29T12:01:00.000Z"; webhook = f.event(comment, "update", "stranger"); }
  if (kind === "wrong-source") webhook.data.issue = { id: "another", identifier: "DRA-99" };
  if (kind === "forged-create") { webhook = f.event(comment); webhook.data.body = "Not the reserved publication"; }
  await expect(f.receive(webhook)).rejects.toThrow(); expect(await f.prisma.runtimeInstruction.count()).toBe(0);
});

test("signed owner edit of an app-created native report routes by its actor, not the old creator", async () => {
  const f = await fixture();
  const create = f.client.create;
  f.client.create = async (key, value) => {
    f.comments.set(value.id!, { id: value.id!, body: value.body, issue: { id: f.issue.id, identifier: f.issue.identifier }, parentId: null, user: { id: f.config.agentUserId }, createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.010Z" });
    return create(key, value);
  };
  const result = await f.publish(); const comment = f.comments.get(result.commentId)!;
  comment.body = "Human edit to the native report"; comment.updatedAt = "2026-10-29T12:01:00.000Z";
  const webhook = f.event(comment, "update", "owner");
  expect(LinearCommentWebhookSchema.parse(webhook).actor?.id).toBe("owner");
  const body = JSON.stringify(webhook); const secret = f.config.webhooks[f.config.activeWebhookId]!.webhookSecret;
  const response = await f.app.request(`/webhooks/${f.config.activeWebhookId}`, { method: "POST", headers: { "content-type": "application/json", "linear-delivery": "signed-owner-edit", "linear-signature": createHmac("sha256", secret).update(body).digest("hex") }, body });
  expect(response.status).toBe(202);
  const source = await f.prisma.runtimeSourceMessage.findFirstOrThrow();
  expect(source.authorId).toBe("owner"); expect(source.body).toBe(comment.body);
  expect(await f.prisma.runtimeInstruction.count()).toBe(1);
});
