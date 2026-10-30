import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp } from "../../app.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { recordSourceMessage } from "./source-messages.ts";
import { queueInstruction, deliverInstructions } from "./inbox.ts";
import { cleanupInboxDependencies } from "../tasks/cleanup-inbox.ts";
import { handleCommentWebhook } from "../../integrations/linear/webhooks/comment/handler.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let db: TestDatabase;
let config: ReturnType<typeof testConfig>;
let runtime: ReturnType<typeof createFakeAgentRuntime>;
const originalFetch = globalThis.fetch;
const originalCapability = cleanupInboxDependencies.capability;
let onRead: (() => Promise<void>) | undefined;
let comment: any;
beforeEach(async () => {
  db = await createTestDatabase(); config = testConfig(); runtime = createFakeAgentRuntime(); onRead = undefined;
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
  globalThis.fetch = (async (_url, init) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("DeliveryComment")) { expect(query).toContain("editedAt"); await onRead?.(); return Response.json({ data: { comment } }); }
    throw new Error(`Unexpected provider request: ${query}`);
  }) as typeof fetch;
});
afterEach(async () => { globalThis.fetch = originalFetch; cleanupInboxDependencies.capability = originalCapability; await db.cleanup(); });
async function fixture() {
  const session = await beginRuntimeSession(db.prisma, { sessionKey: "report-primary", agent: "codex", cwd: "/tmp/report-primary", repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
  await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "idle" } });
  runtime.putSession({ ...session, agent: "codex", status: "idle" });
  const task = await db.prisma.remoteTask.create({ data: { requestKey: "report-task", primarySessionId: session.id, repositoryId: session.repositoryId, machineId: session.machineId, connectionId: config.activeConnectionId, issueIdentifier: "DRA-98", branchName: "codex/original", worktreePath: session.cwd, toolingRoot: "/tools", toolingRevision: "a".repeat(40), pinnedToolingRoot: "/pinned/original", phase: "waiting" } });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-98", relationship: "handles" } });
  comment = { id: "native-report", body: "Inspection completed; no cleanup ran.", parentId: null, issue: { id: "issue-98", identifier: "DRA-98" }, user: { id: "owner" }, documentContent: null, createdAt: "2026-10-29T12:51:03.780Z", updatedAt: "2026-10-29T12:51:05.412Z", editedAt: null };
  const source = await recordSourceMessage(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, repositoryId: session.repositoryId, machineId: session.machineId, resourceId: comment.issue.id, resourceIdentifier: comment.issue.identifier, commentId: comment.id, threadRootId: comment.id, authorId: "owner", body: comment.body, presentation: {} });
  const instruction = await queueInstruction(db.prisma, { sessionId: session.id, requestId: source.id, sourceMessageId: source.id, text: `Pinned instructions\n${comment.body}` });
  const current = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id } });
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const url = `/api/source-messages/${encodeURIComponent(source.id)}`;
  const inspect = await (await app.request(url)).json();
  const request = { requestKey: "exact-native-report-v1", expectedUpdatedAt: current.updatedAt.toISOString(), reason: "Owner verified the original native publication receipt", owner: { kind: "native-codex-chat", threadId: "native-coordinator", hostId: "local" }, outcome: "informational", evidence: ["codex://threads/native-coordinator"], queuedReport: { version: 1, ...(inspect.queuedReport?.binding ?? { sourceSequence: source.sequence, taskId: task.id, ownershipDigest: "a".repeat(64), bodySha256: sha(source.body), instruction: { id: instruction.id, sequence: instruction.sequence, updatedAt: instruction.updatedAt.toISOString(), textSha256: sha(instruction.text) } }), publication: { provider: "linear", connectionId: source.connectionId, issueId: source.resourceId, commentId: source.commentId, threadRootId: source.threadRootId, authorId: source.authorId, bodySha256: sha(source.body), createdAt: comment.createdAt, updatedAt: comment.updatedAt }, nativeReceipt: { tool: "linear.save_comment", toolCallId: "native-tool-call", turnId: "native-turn", reference: "codex://threads/native-coordinator?turn=native-turn", sha256: "b".repeat(64) } } };
  const post = (body: any = request, authenticated = true) => app.request(`${url}/external-disposition`, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify(body) });
  return { session, task, source: current, instruction, app, url, request, post };
}

test("owner-attested native report settles only the never-started queue item and replays after lost response", async () => {
  const f = await fixture();
  const response = await f.post();
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.receipt.action).toBe("record-native-report");
  expect(body.source.state).toBe("handled");
  expect(body.source.requestId).toBeNull();
  expect(body.source.replyPosted).toBe(false);
  const current = await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } });
  expect(current.state).toBe("acknowledged");
  expect(current.detail).toContain("External informational report");
  expect(current.text).toBe(f.instruction.text); expect(current.executionRequestId).toBeNull();
  expect(await db.prisma.runtimeLifecycleEvent.count()).toBe(0);
  const retry = await (await f.post()).json();
  expect(retry.replayed).toBe(true); expect(retry.receipt.id).toBe(body.receipt.id);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(1);
  expect(runtime.sentMessages).toEqual([]);
});

test("trusted local IPC cannot attest native authorship without the owner's credential", async () => {
  const f = await fixture();
  expect((await f.post(f.request, false)).status).toBe(401);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(f.instruction);
});

test.each(["preparing", "dispatching", "unknown", "completed", "failed"])("a %s instruction is never retrospectively treated as an external report", async state => {
  const f = await fixture();
  await db.prisma.runtimeInstruction.update({ where: { id: f.instruction.id }, data: { state } });
  expect((await f.post()).status).toBe(409);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
});

test.each(["execution", "lifecycle", "source-turn", "control", "retry", "source-request", "target-request"])("queued state cannot hide prior %s evidence", async kind => {
  const f = await fixture();
  if (kind === "execution") await db.prisma.runtimeInstruction.update({ where: { id: f.instruction.id }, data: { executionRequestId: f.instruction.id } });
  if (kind === "lifecycle") await db.prisma.runtimeLifecycleEvent.create({ data: { id: "past-lifecycle", runtimeSessionId: f.session.id, requestId: `${f.instruction.id}:retry:1`, phase: "started", occurredAt: new Date() } });
  if (kind === "source-turn") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, action: "source-message-turn", source: "comment-delivery", key: "different-turn", value: f.source.id } });
  if (kind === "retry") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, action: "instruction-resolved", source: "owner", key: f.source.id, value: "retry" } });
  if (kind === "control") await db.prisma.runtimeMessageControl.create({ data: { id: "owner-steer", provider: f.source.provider, connectionId: f.source.connectionId, repositoryId: f.source.repositoryId, machineId: f.source.machineId, commentId: f.source.commentId, authorId: "owner", sourceMessageId: f.source.id } });
  if (kind === "source-request") await db.prisma.runtimeSourceMessage.update({ where: { id: f.source.id }, data: { requestId: "past-turn" } });
  if (kind === "target-request") await db.prisma.runtimeSourceMessage.update({ where: { id: f.source.id }, data: { targetRequestId: "past-steer" } });
  expect((await f.post()).status).toBe(409); expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
});

test.each(["pause", "pin", "owner", "instruction", "new-edit", "publication-body", "publication-version"])("a %s race during provider verification preserves the queue", async kind => {
  const f = await fixture(); let reads = 0;
  onRead = async () => {
    if (++reads !== 2) return;
    if (kind === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (kind === "pin") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: "/changed/pin" } });
    if (kind === "owner") await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: f.session.id }, data: { endedAt: new Date() } });
    if (kind === "instruction") await db.prisma.runtimeInstruction.update({ where: { id: f.instruction.id }, data: { text: "Actual owner instruction" } });
    if (kind === "publication-body") comment.body = "Owner edited this report into a new request";
    if (kind === "publication-version") comment.updatedAt = "2026-10-29T12:52:00.000Z";
    if (kind === "new-edit") await recordSourceMessage(db.prisma, { provider: f.source.provider, connectionId: f.source.connectionId, repositoryId: f.source.repositoryId, machineId: f.source.machineId, resourceId: f.source.resourceId, resourceIdentifier: f.source.resourceIdentifier, commentId: f.source.commentId, threadRootId: f.source.threadRootId, authorId: f.source.authorId, body: "New human edit", presentation: {} });
  };
  expect((await f.post()).status).toBe(409); expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).state).toBe("queued");
});

test("mismatched or incomplete receipt attestations and conflicting retry keys are rejected", async () => {
  const f = await fixture();
  for (const body of [
    { ...f.request, queuedReport: { ...f.request.queuedReport, nativeReceipt: undefined } },
    { ...f.request, queuedReport: { ...f.request.queuedReport, nativeReceipt: { ...f.request.queuedReport.nativeReceipt, sha256: "not-a-digest" } } },
    { ...f.request, queuedReport: { ...f.request.queuedReport, bodySha256: "c".repeat(64) } },
    { ...f.request, queuedReport: { ...f.request.queuedReport, publication: { ...f.request.queuedReport.publication, commentId: "another-comment" } } },
    { ...f.request, outcome: "handled" },
  ]) expect([400, 409]).toContain((await f.post(body)).status);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
  expect((await f.post()).status).toBe(200);
  expect((await f.post({ ...f.request, reason: "different attestation" })).status).toBe(409);
});

async function webhook(f: Awaited<ReturnType<typeof fixture>>, body: string, deliveryId: string) {
  return handleCommentWebhook({ prisma: db.prisma, config, agentRuntime: runtime, deliveryId, webhook: { action: "create", type: "Comment", data: { id: f.source.commentId, body, userId: "owner", user: { id: "owner" }, issue: { id: f.source.resourceId, identifier: f.source.resourceIdentifier }, parentId: null } } as any });
}

test("duplicate ingress preserves the external outcome while a real human edit remains new owner input", async () => {
  const f = await fixture(); expect((await f.post()).status).toBe(200);
  const before = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: f.source.id } });
  const instruction = await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } });
  // Hold real new work without starting a fixture provider turn.
  runtime.putSession({ ...f.session, status: "active" });
  expect((await webhook(f, f.source.body, "duplicate-report")).kind).toBe("duplicate");
  expect(await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: f.source.id } })).toEqual(before);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(instruction);
  comment.body = "Please change the original behavior"; comment.editedAt = comment.updatedAt = "2026-10-29T12:52:00.000Z";
  expect((await webhook(f, comment.body, "human-edit")).kind).toBe("accepted");
  const rows = await db.prisma.runtimeInstruction.findMany({ orderBy: { sequence: "asc" } });
  expect(rows.map(row => row.state)).toEqual(["acknowledged", "queued"]);
  expect(rows[1]!.text).toContain("Please change the original behavior");
  expect(await db.prisma.runtimeLifecycleEvent.count()).toBe(0);
  const inspection = await (await f.app.request(f.url)).json();
  expect(inspection.publicationOrigin.kind).toBe("native-report-attestation");
});

test("same-key concurrent requests converge on one external receipt without managed execution", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.post(), f.post()]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  const results = await Promise.all(responses.map(response => response.json()));
  expect(results[0].receipt.id).toBe(results[1].receipt.id);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(1);
  expect(runtime.sentMessages).toEqual([]);
});

test("a held self-report blocks its cleanup only until truthful disposition, while another owner still progresses", async () => {
  const f = await fixture();
  config.repository.tooling = { root: "/configured", revision: "b".repeat(40) };
  config.repositories = { ...config.repositories, [config.repository.id]: config.repository };
  const capability = { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const, taskToolingRevision: f.task.toolingRevision, capabilityRevision: "b".repeat(40), checkout: "/immutable/current", adapter: "/immutable/current/src/cli.ts", instructions: "/immutable/current/cleanup.md" };
  cleanupInboxDependencies.capability = async () => ({ receipt: capability, instructions: "Existing immutable cleanup instructions" });
  const contract = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-contract", key: "original", value: JSON.stringify({ boundary: "merge", verificationRequired: false }) } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: "runtime", action: "cleanup-provider-transport", key: "original-transport", value: JSON.stringify({ version: 1, mode: "cleanup", identityDigest: "frozen", sessionId: f.session.id, cwd: f.session.cwd, sourceDev: 1, sourceIno: 2, executionCwd: "/private/cleanup", dev: 1, ino: 3, previousRevision: 0 }) } });
  const cleanup = await queueInstruction(db.prisma, { sessionId: f.session.id, requestId: "synthetic-cleanup", text: "Continue original cleanup" });
  const marker = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: "cleanup-inbox", action: "finalization-cleanup-instruction", key: cleanup.id, value: JSON.stringify({ version: 1, taskId: f.task.id, sessionId: f.session.id, requestKey: `finalize:${f.task.id}`, worktree: f.task.worktreePath, repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRevision: f.task.toolingRevision, pinnedToolingRoot: f.task.pinnedToolingRoot, contractRevision: contract.sequence, contractDigest: sha(contract.value!), capability }) } });
  const other = await beginRuntimeSession(db.prisma, { sessionKey: "other-owner", agent: "codex", cwd: "/tmp/other-owner", repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
  await db.prisma.runtimeSession.update({ where: { id: other.id }, data: { status: "idle" } });
  runtime.putSession({ ...other, status: "idle" });
  await queueInstruction(db.prisma, { sessionId: other.id, requestId: "real-other-work", text: "Do independent owner work" });
  await deliverInstructions(db.prisma, runtime, config);
  for (let i = 0; i < 100 && (await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "real-other-work" } })).state !== "completed"; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map(row => row.requestId)).toEqual(["real-other-work"]);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: cleanup.id } })).toEqual(cleanup);
  expect((await f.post()).status).toBe(200);
  await deliverInstructions(db.prisma, runtime, config);
  for (let i = 0; i < 100 && (await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: cleanup.id } })).state !== "completed"; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map(row => row.requestId)).toEqual(["real-other-work", "synthetic-cleanup"]);
  expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: marker.sequence } })).toEqual(marker);
  expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: contract.sequence } })).toEqual(contract);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).executionRequestId).toBeNull();
});

test("cancelled HTTP cannot accept a provider observation that finishes later", async () => {
  const f = await fixture(); const controller = new AbortController();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  onRead = async () => { enter(); await held; };
  const pending = f.app.request(new Request(`http://local${f.url}/external-disposition`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(f.request), signal: controller.signal }));
  await entered; controller.abort();
  const response = await pending; expect(response.status).toBe(504);
  release(); await Bun.sleep(20);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(f.instruction);
  expect(await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: f.source.id } })).toEqual(f.source);
});

test("human edits of an attested report keep distinct provider generations even when body returns to the original", async () => {
  const f = await fixture(); expect((await f.post()).status).toBe(200);
  runtime.putSession({ ...f.session, status: "active" });
  const original = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: f.source.id } });
  comment.body = "New actual owner instruction"; comment.editedAt = comment.updatedAt = "2026-10-29T12:53:00.000Z";
  expect((await webhook(f, comment.body, "edit-b")).kind).toBe("accepted");
  comment.body = original.body; comment.editedAt = comment.updatedAt = "2026-10-29T12:54:00.000Z";
  expect((await webhook(f, comment.body, "edit-back-to-a")).kind).toBe("accepted");
  await webhook(f, comment.body, "duplicate-edited-a");
  comment.editedAt = comment.updatedAt = "2026-10-29T12:55:00.000Z";
  expect((await webhook(f, comment.body, "later-same-body")).kind).toBe("accepted");
  const rows = await db.prisma.runtimeSourceMessage.findMany({ orderBy: { sequence: "asc" } });
  expect(rows.map(row => row.body)).toEqual([original.body, "New actual owner instruction", original.body, original.body]);
  expect(rows.map(row => row.state)).toEqual(["handled", "queued", "queued", "queued"]);
  expect(new Set(rows.map(row => row.id)).size).toBe(4);
  expect(rows[0]).toEqual(original);
  expect(await db.prisma.runtimeInstruction.count()).toBe(4);
});

test("stale native-report webhook cannot suppress a changed canonical human comment", async () => {
  const f = await fixture(); expect((await f.post()).status).toBe(200);
  comment.body = "Changed human instruction"; comment.editedAt = comment.updatedAt = "2026-10-29T12:54:00.000Z";
  await expect(webhook(f, f.source.body, "stale-original")).rejects.toThrow("generation changed");
  expect(await db.prisma.runtimeSourceMessage.count()).toBe(1);
});

test.each(["older-update", "changed-creation", "changed-body-same-version"])("%s cannot become a new owner instruction for an attested publication", async kind => {
  const f = await fixture(); expect((await f.post()).status).toBe(200);
  runtime.putSession({ ...f.session, status: "active" });
  if (kind === "older-update") comment.updatedAt = "2026-10-29T12:51:04.000Z";
  if (kind === "changed-creation") { comment.createdAt = "2026-10-29T12:52:00.000Z"; comment.updatedAt = "2026-10-29T12:53:00.000Z"; }
  if (kind === "changed-body-same-version") comment.body = "Different content under an unchanged version";
  await expect(webhook(f, comment.body, `invalid-${kind}`)).rejects.toThrow("not a later generation");
  expect(await db.prisma.runtimeSourceMessage.count()).toBe(1);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});


test("unedited provider metadata update preserves the native receipt and settles the original report once", async () => {
  const f = await fixture();
  comment.editedAt = null;
  f.request.queuedReport.publication.updatedAt = "2026-10-29T12:51:03.758Z";
  const attestation = structuredClone(f.request.queuedReport);
  const response = await f.post();
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.receipt.evidence.attestation).toEqual(attestation);
  expect(result.receipt.evidence.providerGeneration).toEqual({ version: 1, kind: "linear-author-edit", createdAt: comment.createdAt, updatedAt: comment.updatedAt, editedAt: null });
  const retry = await (await f.post()).json();
  expect(retry.receipt).toEqual(result.receipt);
  expect(retry.replayed).toBe(true);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(1);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(f.task);
  expect(await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).toMatchObject({ status: "idle", cwd: f.session.cwd });
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).text).toBe(f.instruction.text);
  expect(runtime.sentMessages).toEqual([]);
});


test.each(["edited-back", "missing-edit-fact", "malformed-edit-fact", "regressed-version", "changed-author", "changed-parent"])("%s cannot bridge a native creation receipt", async kind => {
  const f = await fixture();
  f.request.queuedReport.publication.updatedAt = "2026-10-29T12:51:03.758Z";
  if (kind === "edited-back") comment.editedAt = "2026-10-29T12:51:04.000Z";
  if (kind === "missing-edit-fact") delete comment.editedAt;
  if (kind === "malformed-edit-fact") comment.editedAt = "unknown";
  if (kind === "regressed-version") comment.updatedAt = "2026-10-29T12:51:03.700Z";
  if (kind === "changed-author") comment.user.id = "another-owner";
  if (kind === "changed-parent") comment.parentId = "another-thread";
  expect((await f.post()).status).toBe(409);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(f.instruction);
  expect(await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: f.source.id } })).toEqual(f.source);
});

test.each(["author-edit", "metadata-update", "edit-fact-disappears"])("a second-read %s keeps the original report queued", async kind => {
  const f = await fixture(); let reads = 0;
  f.request.queuedReport.publication.updatedAt = "2026-10-29T12:51:03.758Z";
  onRead = async () => {
    if (++reads !== 2) return;
    if (kind === "author-edit") comment.editedAt = "2026-10-29T12:51:05.000Z";
    if (kind === "metadata-update") comment.updatedAt = "2026-10-29T12:51:06.000Z";
    if (kind === "edit-fact-disappears") delete comment.editedAt;
  };
  expect((await f.post()).status).toBe(409);
  expect(await db.prisma.runtimeSourceMessageResolution.count()).toBe(0);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(f.instruction);
});

test("later metadata updates do not create owner work, while edit A→B→A and edited duplicates remain distinct", async () => {
  const f = await fixture();
  f.request.queuedReport.publication.updatedAt = "2026-10-29T12:51:03.758Z";
  expect((await f.post()).status).toBe(200);
  runtime.putSession({ ...f.session, status: "active" });
  const original = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: f.source.id } });
  comment.updatedAt = "2026-10-29T12:52:00.000Z";
  expect((await webhook(f, comment.body, "metadata-only")).kind).toBe("duplicate");
  expect(await db.prisma.runtimeSourceMessage.count()).toBe(1);
  comment.body = "New owner input"; comment.editedAt = comment.updatedAt = "2026-10-29T12:53:00.000Z";
  expect((await webhook(f, comment.body, "actual-edit-b")).kind).toBe("accepted");
  comment.updatedAt = "2026-10-29T12:53:01.000Z";
  await webhook(f, comment.body, "edited-metadata-only");
  expect(await db.prisma.runtimeSourceMessage.count()).toBe(2);
  comment.body = original.body; comment.editedAt = comment.updatedAt = "2026-10-29T12:54:00.000Z";
  expect((await webhook(f, comment.body, "actual-edit-a")).kind).toBe("accepted");
  comment.updatedAt = "2026-10-29T12:54:01.000Z";
  await webhook(f, comment.body, "back-to-a-metadata-only");
  const rows = await db.prisma.runtimeSourceMessage.findMany({ orderBy: { sequence: "asc" } });
  expect(rows.map(row => row.body)).toEqual([original.body, "New owner input", original.body]);
  expect(rows[0]).toEqual(original);
  expect(await db.prisma.runtimeInstruction.count()).toBe(3);
});

test.each([undefined, "invalid", "2026-10-29T12:50:00.000Z"])("missing or impossible editedAt %s never becomes informational input", async editedAt => {
  const f = await fixture(); expect((await f.post()).status).toBe(200);
  comment.editedAt = editedAt;
  comment.updatedAt = "2026-10-29T12:53:00.000Z";
  await expect(webhook(f, comment.body, "unknown-generation")).rejects.toThrow();
  expect(await db.prisma.runtimeSourceMessage.count()).toBe(1);
});

test("historical attestation without a provider edit observation keeps its old exact version contract", async () => {
  const f = await fixture(); const result = await (await f.post()).json();
  const { providerGeneration: _generation, ...oldEvidence } = result.receipt.evidence;
  await db.prisma.runtimeSourceMessageResolution.update({ where: { id: result.receipt.id }, data: { evidence: oldEvidence } });
  runtime.putSession({ ...f.session, status: "active" });
  expect((await webhook(f, comment.body, "old-duplicate")).kind).toBe("duplicate");
  comment.updatedAt = "2026-10-29T12:53:00.000Z";
  expect((await webhook(f, comment.body, "old-later-generation")).kind).toBe("accepted");
  expect(await db.prisma.runtimeSourceMessage.count()).toBe(2);
  expect((await db.prisma.runtimeSourceMessageResolution.findUniqueOrThrow({ where: { id: result.receipt.id } })).evidence).toEqual(oldEvidence);
});
