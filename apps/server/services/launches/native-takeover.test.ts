import { createWorkflowWorker } from "../../workers/product/workflow/worker.ts";
import { DispatchEventType, type WorkerContext } from "../../../../types/dispatcher/index.ts";
import type { SourceIssueWithAgentIssues } from "../../integrations/linear/session-store/source-issue/types.ts";
import { dispatchPlacements } from "../tasks/routing.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { findRuntimeSession, listRuntimeSessions, updateRuntimeSessionState } from "../sessions/runtime-registry.ts";
import { queueInstruction, deliverInstructions } from "../sessions/inbox.ts";
import { beginTask } from "../tasks/store.ts";
import { createApp } from "../../app.ts";
import { spawnAgentThread } from "./spawn.ts";
import { withNativeLaunchWork, assertNativeLaunch, assertNativeSession, bindNativeLaunchSession, freshReactionNativeLaunch, grantNativeLaunch, inspectNativeTakeover, takeNativeOwnership } from "./native-takeover.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
function fixture() {
  const config = testConfig();
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.repository.id] = { when: [{ "linear.userId": ["owner"] }] };
  // The owner's rocket selects an execution workflow configured for that reaction.
  config.repository = { ...config.repository, workflows: { ...config.repository.workflows, implement: { ...config.repository.workflows.plan!, id: "implement", on: "issue.reaction", when: [{ "reaction.emoji": ["rocket"] }] } } };
  config.repositories = { ...config.repositories, [config.repository.id]: config.repository };
  const runtime = createFakeAgentRuntime();
  runtime.getSession = id => findRuntimeSession(db.prisma, id);
  runtime.listSessions = () => listRuntimeSessions(db.prisma);
  runtime.cancel = async id => { runtime.cancelledSessionIds.push(id); await updateRuntimeSessionState(db.prisma, id, { status: "idle" }); };
  const source = { connectionId: config.activeConnectionId, repositoryId: config.repository.id, issueId: "issue-id", issueIdentifier: "DRA-299" };
  const input = { source, requestKey: "native-intent", expectedRevision: 0, nativeChat: { threadId: "native-owner", hostId: "local" } };
  return { config, runtime, source, input, context: { prisma: db.prisma, config, runtime } };
}
async function family(f: ReturnType<typeof fixture>) {
  const cwd = `${f.config.repository.root}/native-case`;
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "old-launch",
    repositoryId: f.source.repositoryId, connectionId: f.source.connectionId, issueIdentifier: f.source.issueIdentifier,
    machineId: f.config.machine, branchName: "codex/original", phase: "working", primarySessionId: "primary", worktreePath: cwd,
    toolingRoot: "/tooling", toolingRevision: "a".repeat(40), pinnedToolingRoot: "/tooling/pin" } });
  for (const id of ["primary", "delegate"]) {
    await db.prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", role: id === "primary" ? "primary" : "delegate", status: "active", cwd, repositoryId: task.repositoryId, machineId: task.machineId } });
    await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: id, provider: "linear", connectionId: f.source.connectionId, resourceType: "issue-identifier", externalId: f.source.issueIdentifier, relationship: "handles" } });
  }
  await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "delegate", targetSessionId: "primary", relationship: "spawned-by" } });
  await queueInstruction(db.prisma, { sessionId: "primary", requestId: "saved-result", text: "Preserve this queued delegate result" });
  return task;
}

test("pending accepted work is durably withdrawn without needing a task or deleting its receipt", async () => {
  const f = fixture();
  const receipt = await db.prisma.webhookReceipt.create({ data: { id: "receipt", webhookId: f.config.activeWebhookId, deliveryId: "old-delivery", provider: "linear", eventType: "reaction", resourceId: f.source.issueIdentifier, status: "accepted", connectionId: f.source.connectionId, repositoryId: f.source.repositoryId } });
  const run = await db.prisma.workerRun.create({ data: { receiptId: receipt.id, workerKey: "product.workflow:implement", status: "pending" } });
  expect((await takeNativeOwnership(f.context, f.input)).state).toBe("native");
  expect(await db.prisma.remoteTask.count()).toBe(0);
  await expect(assertNativeLaunch(db.prisma, f.source, run.id)).rejects.toThrow("withdrawn");
  const repository = { ...f.config.repository, tooling: { root: "/tooling", revision: "a".repeat(40) } };
  await expect(beginTask(db.prisma, { repository, requestKey: run.id, machineId: f.config.machine, connectionId: f.source.connectionId, issueIdentifier: f.source.issueIdentifier, branchName: "codex/old" })).rejects.toThrow("withdrawn");
  await db.prisma.workerRun.update({ where: { id: run.id }, data: { status: "pending", attempts: { increment: 1 } } });
  await db.prisma.$disconnect();
  await expect(assertNativeLaunch(db.prisma, f.source, "late-unknown-delivery")).rejects.toThrow("withdrawn");
  expect(await db.prisma.webhookReceipt.findUnique({ where: { id: receipt.id } })).toEqual(receipt);
  const event = await db.prisma.nativeTakeoverEvent.findFirstOrThrow({ where: { kind: "native" } });
  expect(JSON.stringify(event.value)).toContain(run.id);
});

test("family cancellation remains pending on failure and preserves original source, pins and queued work", async () => {
  const f = fixture(), task = await family(f); let fail = true;
  f.runtime.cancel = async id => { f.runtime.cancelledSessionIds.push(id); if (id === "primary" && fail) throw new Error("provider still working"); await updateRuntimeSessionState(db.prisma, id, { status: "idle" }); };
  expect((await takeNativeOwnership(f.context, f.input)).state).toBe("pending");
  expect(f.runtime.cancelledSessionIds.sort()).toEqual(["delegate", "primary"]);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).ownerPaused).toBe(true);
  await deliverInstructions(db.prisma, f.runtime); expect(f.runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "saved-result" } })).state).toBe("queued");
  await expect(grantNativeLaunch(f.context, f.source, "too-soon", 1)).rejects.toThrow("not settled");
  fail = false;
  expect((await takeNativeOwnership(f.context, f.input)).state).toBe("native");
  const after = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
  expect({ ...after, ownerPaused: task.ownerPaused, updatedAt: task.updatedAt }).toEqual(task);
  expect(await db.prisma.nativeTakeoverEvent.count({ where: { kind: "native" } })).toBe(1);
});

test("owner control auth is required even on the managed control socket, and keys/revisions cannot be substituted", async () => {
  const f = fixture(), app = createApp({ ...f.context, agentRuntime: f.runtime, trustLocal: true });
  const post = (body: unknown, authorization?: string) => app.request("/api/launches/native-takeover", { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
  expect((await app.request(`/api/launches/native-takeover?${new URLSearchParams(f.source)}`)).status).toBe(401);
  expect((await post(f.input)).status).toBe(401);
  expect(await db.prisma.nativeTakeover.count()).toBe(0);
  expect((await post(f.input, `Bearer ${f.config.apiKey}`)).status).toBe(200);
  await expect(takeNativeOwnership(f.context, { ...f.input, nativeChat: { threadId: "substitute", hostId: "local" } })).rejects.toThrow("different input");
  await expect(takeNativeOwnership(f.context, { ...f.input, requestKey: "new-key" })).rejects.toThrow("revision changed");
  await expect(inspectNativeTakeover(f.context, { ...f.source, issueId: "different-source" })).rejects.toThrow("source");
});

test("a launch crossing session creation is fenced before enqueue and its existing work is not removed", async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), resume = new Promise<void>(resolve => release = resolve);
  const ensure = f.runtime.ensureSession;
  f.runtime.ensureSession = async input => { entered(); await resume; return ensure(input); };
  const launch = spawnAgentThread({ config: f.config, prisma: db.prisma, agentRuntime: f.runtime, launchKey: "old-launch", issueIdentifier: f.source.issueIdentifier,
    provider: "codex", prompt: "old work", machine: f.config.machine, worktreePath: `${f.config.repository.root}/old`, lifecycle: "persistent", role: "primary" });
  await waiting;
  try { expect((await takeNativeOwnership(f.context, f.input)).state).toBe("native"); } finally { release(); }
  await expect(launch).rejects.toThrow("withdrawn");
  expect(f.runtime.sentMessages).toHaveLength(0);
  expect(f.runtime.closedSessionIds).toHaveLength(1);
  expect(await db.prisma.nativeTakeover.count()).toBe(1);
});

test("new owner launch waits for in-flight cancellation and old takeover retries cannot cancel it", async () => {
  const f = fixture(); await family(f);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), resume = new Promise<void>(resolve => release = resolve);
  f.runtime.cancel = async id => { if (id === "primary") { entered(); await resume; } await updateRuntimeSessionState(db.prisma, id, { status: "idle" }); };
  const takeover = takeNativeOwnership(f.context, f.input); await waiting;
  let granted = false;
  const grant = grantNativeLaunch(f.context, f.source, "fresh-owner", 1).then(value => { granted = true; return value; });
  try { await Bun.sleep(10); expect(granted).toBe(false); } finally { release(); }
  await takeover; await grant;
  await bindNativeLaunchSession(db.prisma, f.source, "fresh-owner", "primary");
  await expect(assertNativeLaunch(db.prisma, f.source, "old-launch")).rejects.toThrow("withdrawn");
  await expect(assertNativeSession(db.prisma, "primary")).resolves.toBeUndefined();
  await expect(assertNativeSession(db.prisma, "delegate")).resolves.toBeUndefined();
  const replay = await takeNativeOwnership(f.context, f.input);
  expect(replay).toMatchObject({ state: "managed", superseded: true });
  expect((await inspectNativeTakeover(f.context, f.source)).revision).toBe(2);
  await expect(grantNativeLaunch(f.context, f.source, "different-new-launch", 1)).rejects.toThrow("revision changed");
});

test("unknown or old reaction time cannot lift native ownership; a provably fresh configured owner reaction continues the original family once", async () => {
  const f = fixture(); await family(f); await takeNativeOwnership(f.context, f.input);
  const pending = { id: "reaction", userId: "owner" };
  expect(await freshReactionNativeLaunch(f.context, f.source, "delayed-run", pending, async () => "never")).toBeNull();
  expect(await freshReactionNativeLaunch(f.context, f.source, "old-run", { ...pending, createdAt: new Date(0).toISOString() }, async () => "never")).toBeNull();
  expect(await freshReactionNativeLaunch(f.context, f.source, "wrong-actor", { ...pending, userId: "other", createdAt: new Date().toISOString() }, async () => "never")).toBeNull();
  await Bun.sleep(3);
  const reaction = { ...pending, createdAt: new Date().toISOString() };
  expect(await freshReactionNativeLaunch(f.context, f.source, "fresh-run", reaction, async () => "Continue the same task")).toBe("primary");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
  expect(await db.prisma.runtimeSession.count({ where: { role: "primary" } })).toBe(1);
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
  expect(await freshReactionNativeLaunch(f.context, f.source, "duplicate-new-delivery", reaction, async () => "never")).toBeNull();
  await expect(assertNativeLaunch(db.prisma, f.source, "duplicate-new-delivery")).rejects.toThrow("withdrawn");
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
});

test("the explicit existing owner launch resumes one original family and binds immutable launch content", async () => {
  const f = fixture(), task = await family(f); await takeNativeOwnership(f.context, f.input);
  const app = createApp({ ...f.context, agentRuntime: f.runtime, trustLocal: true });
  const body = { issueIdentifier: f.source.issueIdentifier, repositoryId: f.source.repositoryId, connectionId: f.source.connectionId,
    harness: "codex", prompt: "Owner requested continuation", machine: f.config.machine, worktreePath: task.worktreePath, branchName: task.branchName,
    lifecycle: "persistent", role: "primary", launchKey: "explicit-owner-return", nativeGrant: { issueId: f.source.issueId, expectedRevision: 1 } };
  const post = (value: unknown, bearer = true) => app.request("/api/launches", { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${f.config.apiKey}` } : {}) }, body: JSON.stringify(value) });
  expect((await post(body, false)).status).toBe(401);
  expect((await post(body)).status).toBe(200);
  expect((await post(body)).status).toBe(200);
  expect((await post({ ...body, prompt: "Different content under the old key" })).status).toBe(409);
  expect(await db.prisma.remoteTask.count()).toBe(1);
  expect(await db.prisma.runtimeSession.count({ where: { role: "primary" } })).toBe(1);
  expect(await db.prisma.runtimeInstruction.count({ where: { id: "native-return:explicit-owner-return" } })).toBe(1);
  expect(await db.prisma.nativeTakeoverEvent.count({ where: { kind: "managed" } })).toBe(1);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).toolingRevision).toBe(task.toolingRevision);
});

test("a task creation racing takeover is either refused or preserved owner-paused", async () => {
  const f = fixture(), repository = { ...f.config.repository, tooling: { root: "/tooling", revision: "a".repeat(40) } };
  const outcomes = await Promise.allSettled([
    beginTask(db.prisma, { repository, requestKey: "racing-launch", machineId: f.config.machine, connectionId: f.source.connectionId, issueIdentifier: f.source.issueIdentifier, branchName: "codex/race" }),
    takeNativeOwnership(f.context, f.input),
  ]);
  expect(outcomes[1]!.status).toBe("fulfilled");
  const tasks = await db.prisma.remoteTask.findMany();
  expect(tasks.length).toBeLessThanOrEqual(1);
  expect(tasks.every(task => task.ownerPaused)).toBe(true);
  await expect(assertNativeLaunch(db.prisma, f.source, "racing-launch")).rejects.toThrow("withdrawn");
});

test("unresolved independently owned descendants are not cancelled or misreported as stopped", async () => {
  const f = fixture(); await family(f);
  await db.prisma.runtimeSession.update({ where: { id: "delegate" }, data: { cwd: "/independently-owned", repositoryId: f.source.repositoryId } });
  const result = await takeNativeOwnership(f.context, f.input);
  expect(result.state).toBe("pending");
  expect(f.runtime.cancelledSessionIds).toEqual(["primary"]);
  expect((await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "delegate" } })).status).toBe("active");
  const event = await db.prisma.nativeTakeoverEvent.findFirstOrThrow({ where: { kind: "reconciled" } });
  expect(JSON.stringify(event.value)).toContain("delegate");
  await expect(grantNativeLaunch(f.context, f.source, "unsafe-return", 1)).rejects.toThrow("not settled");
});

test("last-mile execution is fenced for old sessions and only the newly granted original lineage may run", async () => {
  const f = fixture(); await family(f); await takeNativeOwnership(f.context, f.input);
  await expect(assertNativeSession(db.prisma, "primary")).rejects.toThrow("prevents managed execution");
  await grantNativeLaunch(f.context, f.source, "fresh", 1);
  await expect(assertNativeSession(db.prisma, "primary")).rejects.toThrow("prevents managed execution");
  await bindNativeLaunchSession(db.prisma, f.source, "fresh", "primary");
  await expect(assertNativeSession(db.prisma, "delegate")).resolves.toBeUndefined();
  await db.prisma.runtimeSessionRelation.deleteMany();
  await expect(assertNativeSession(db.prisma, "delegate")).rejects.toThrow("outside the current owner launch grant");
});


test("withdrawn launch delivery is acknowledged and does not wedge the following ordinary comment", async () => {
  const f = fixture();
  const placement = await db.prisma.taskPlacement.create({ data: { sourceKey: `linear:${f.source.connectionId}:${f.source.issueId}`, machineId: f.config.machine, repositoryId: f.source.repositoryId } });
  for (const [id, type] of [["old-launch-delivery", "Reaction"], ["ordinary-comment", "Comment"]]) await db.prisma.taskDelivery.create({ data: { id, requestKey: id!, placementId: placement.id, kind: "linear", payload: { webhookId: f.config.activeWebhookId, deliveryId: id!, webhook: { type: type!, data: { issueId: f.source.issueId } } } } });
  await takeNativeOwnership(f.context, f.input);
  const seen: string[] = [];
  const request = async (_machine: string, _method: string, _route: string, body?: unknown) => {
    const value = body as { type: string };
    seen.push(value.type);
    if (value.type === "Reaction") { await expect(assertNativeLaunch(db.prisma, f.source, "old-launch")).rejects.toThrow("withdrawn"); return Response.json({ kind: "ignored", reason: "native ownership" }); }
    return Response.json({ kind: "delivered" });
  };
  await dispatchPlacements(db.prisma, request); await dispatchPlacements(db.prisma, request);
  expect(seen).toEqual(["Reaction", "Comment"]);
  expect(await db.prisma.taskDelivery.count({ where: { state: "acknowledged" } })).toBe(2);
  expect(await db.prisma.taskDelivery.count()).toBe(2);
});


test("accepted cancellation is pending until the actual family is inactive", async () => {
  const f = fixture(); await family(f);
  f.runtime.cancel = async id => { f.runtime.cancelledSessionIds.push(id); };
  expect((await takeNativeOwnership(f.context, f.input)).state).toBe("pending");
  expect(f.runtime.cancelledSessionIds.sort()).toEqual(["delegate", "primary"]);
  for (const id of ["primary", "delegate"]) await updateRuntimeSessionState(db.prisma, id, { status: "idle" });
  expect((await takeNativeOwnership(f.context, f.input)).state).toBe("native");
  expect(f.runtime.cancelledSessionIds).toHaveLength(2);
});


test("a partially applied fresh reaction grant resumes with the same immutable decision after a lost response", async () => {
  const f = fixture(); await family(f); await takeNativeOwnership(f.context, f.input); await Bun.sleep(3);
  const reaction = { id: "fresh", userId: "owner", createdAt: new Date().toISOString() }, text = "Same original instruction";
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(JSON.stringify({ reaction, text })).digest("hex");
  await grantNativeLaunch(f.context, f.source, "fresh-run", 1, digest);
  expect((await inspectNativeTakeover(f.context, f.source)).state).toBe("launch-pending");
  expect(await freshReactionNativeLaunch(f.context, f.source, "fresh-run", reaction, async () => text)).toBe("primary");
  await updateRuntimeSessionState(db.prisma, "primary", { status: "active" });
  expect(await freshReactionNativeLaunch(f.context, f.source, "fresh-run", reaction, async () => { throw new Error("Replay must not compose again"); })).toBe("primary");
  expect(await db.prisma.nativeTakeoverEvent.count({ where: { kind: "managed" } })).toBe(1);
  expect(await db.prisma.runtimeInstruction.count({ where: { id: "native-reaction:fresh" } })).toBe(1);
});


test("duplicate live attempts under one durable run stay pending until both existing spans exit", async () => {
  const f = fixture(); let first!: () => void, second!: () => void;
  const a = new Promise<void>(resolve => first = resolve), b = new Promise<void>(resolve => second = resolve);
  const source = { connectionId: f.source.connectionId, repositoryId: f.source.repositoryId, issue: f.source.issueIdentifier };
  const one = withNativeLaunchWork(db.prisma, source, "same-run", () => a);
  const two = withNativeLaunchWork(db.prisma, source, "same-run", () => b);
  try {
    expect((await takeNativeOwnership(f.context, f.input)).state).toBe("pending");
    first(); await one;
    expect((await takeNativeOwnership(f.context, f.input)).state).toBe("pending");
    second(); await two;
    expect((await takeNativeOwnership(f.context, f.input)).state).toBe("native");
  } finally { first(); second(); await Promise.all([one, two]); }
});


test("a pending worker from an earlier process remains unverified instead of being declared dead", async () => {
  const f = fixture();
  const receipt = await db.prisma.webhookReceipt.create({ data: { webhookId: f.config.activeWebhookId, deliveryId: "old-process", eventType: "reaction", status: "accepted", connectionId: f.source.connectionId, repositoryId: f.source.repositoryId, resourceId: f.source.issueIdentifier } });
  const run = await db.prisma.workerRun.create({ data: { receiptId: receipt.id, workerKey: "product.workflow:plan", status: "pending", createdAt: new Date(0) } });
  const state = await takeNativeOwnership(f.context, f.input);
  expect(state.state).toBe("pending"); expect(state).toMatchObject({ activeWorkerRunIds: [], unverifiedWorkerRunIds: [run.id] });
  await expect(grantNativeLaunch(f.context, f.source, "cannot-infer-death", 1)).rejects.toThrow("not settled");
  expect((await db.prisma.workerRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("pending");
});


async function freshActualWorker(f: ReturnType<typeof fixture>, runId: string) {
  await Bun.sleep(3);
  const issue = { id: f.source.issueId, identifier: f.source.issueIdentifier, title: "Owner continuation", description: "Continue existing task", branchName: "codex/original", state: { name: "Implementing" }, labels: { nodes: [] }, agentIssues: [] } as unknown as SourceIssueWithAgentIssues;
  const worker = createWorkflowWorker({ getIssue: async () => issue, react: async () => true, postWorktreeComment: async () => "posted", compose: async () => "Owner requested the existing workflow", readComments: async () => [] });
  const context: WorkerContext = { prisma: db.prisma, config: f.config, agentRuntime: f.runtime, runId, commandClient: { run: async () => ({ ok: true, stdout: "", stderr: "" }) } };
  return worker.execute({ type: DispatchEventType.TrackerWorkflowTriggered, workflowId: "implement", webhook: { type: "Reaction", action: "create", webhookTimestamp: Date.now(), data: { id: `reaction-${runId}`, createdAt: new Date().toISOString(), emoji: "🚀", userId: "owner", issueId: f.source.issueId, issue: { id: f.source.issueId, identifier: f.source.issueIdentifier } } } }, context);
}

test("the actual fresh owner worker does not block its own authenticated grant", async () => {
  const f = fixture(); await family(f); await takeNativeOwnership(f.context, f.input);
  expect((await freshActualWorker(f, "actual-fresh-run")).status).toBe("delivered");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
  expect(await db.prisma.runtimeInstruction.count({ where: { id: "native-reaction:reaction-actual-fresh-run" } })).toBe(1);
  expect(await db.prisma.runtimeSession.count({ where: { role: "primary" } })).toBe(1);
});

test.each(["foreign", "duplicate"] as const)("the actual fresh worker cannot ignore a %s active span", async kind => {
  const f = fixture(); await family(f); await takeNativeOwnership(f.context, f.input);
  let release!: () => void; const wait = new Promise<void>(resolve => release = resolve);
  const held = withNativeLaunchWork(db.prisma, { connectionId: f.source.connectionId, repositoryId: f.source.repositoryId, issue: f.source.issueIdentifier }, kind === "duplicate" ? "actual-fresh-run" : "older-worker", () => wait);
  try {
    await expect(freshActualWorker(f, "actual-fresh-run")).rejects.toThrow("not settled");
    expect((await db.prisma.nativeTakeover.findFirstOrThrow()).mode).toBe("native");
    expect(await db.prisma.runtimeInstruction.count({ where: { id: "native-reaction:reaction-actual-fresh-run" } })).toBe(0);
  } finally { release(); await held; }
});


test("the actual fresh actor cannot erase its same-ID unverified older-process receipt", async () => {
  const f = fixture(); await family(f); await takeNativeOwnership(f.context, f.input);
  const receipt = await db.prisma.webhookReceipt.create({ data: { webhookId: f.config.activeWebhookId, deliveryId: "prior-process-current-id", eventType: "reaction", status: "accepted", connectionId: f.source.connectionId, repositoryId: f.source.repositoryId, resourceId: f.source.issueIdentifier } });
  await db.prisma.workerRun.create({ data: { id: "actual-fresh-run", receiptId: receipt.id, workerKey: "product.workflow:plan", status: "pending", createdAt: new Date(0) } });
  await expect(freshActualWorker(f, "actual-fresh-run")).rejects.toThrow("not settled");
  expect((await db.prisma.nativeTakeover.findFirstOrThrow()).mode).toBe("native");
  expect((await db.prisma.workerRun.findUniqueOrThrow({ where: { id: "actual-fresh-run" } })).status).toBe("pending");
});
