import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { deliverInstructions, queueInstruction } from "../sessions/inbox.ts";
import * as inbox from "./cleanup-inbox.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let db: TestDatabase, root: string;
const originalCapability = inbox.cleanupInboxDependencies.capability;
beforeEach(async () => { db = await createTestDatabase(); root = await realpath(await mkdtemp(path.join(tmpdir(), "dra214-"))); });
afterEach(async () => { inbox.cleanupInboxDependencies.capability = originalCapability; await db.cleanup(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const source = path.join(root, "source"), state = path.join(root, "state"); await mkdir(source); await mkdir(state);
  const config = testConfig({ installRoot: root, acpxStateDir: state });
  const repository = { ...config.repository, tooling: { root: path.join(root, "policy"), revision: "b".repeat(40) } };
  config.repository = repository; config.repositories = { [repository.id]: repository };
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: source, repositoryId: repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "original", requestKey: "original", repositoryId: repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-159", primarySessionId: session.id, branchName: "codex/original", worktreePath: source, toolingRoot: "/old", toolingRevision: "a".repeat(40), pinnedToolingRoot: "/old/pin", phase: "waiting" } });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier!, relationship: "handles" } });
  const contract = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: `owner:${task.id}`, action: "completion-contract", key: "accepted", value: JSON.stringify({ boundary: "merge", verificationRequired: false }) } });
  const immutable = await Promise.all(["finalization-prepared", "finalization-cleanup-started"].map(action => db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: `finalizer:${task.id}`, action, key: "original", value: JSON.stringify({ preserved: action }) } })));
  const runtime = createFakeAgentRuntime([{ id: session.id, cwd: source, repositoryId: repository.id, machineId: config.machine, status: "idle", role: "primary", agent: "codex" }]) as ReturnType<typeof createFakeAgentRuntime> & AgentSessionRuntime;
  let releases = 0, resolves = 0, afterResolve: (() => Promise<void>) | undefined;
  runtime.releaseIdleTransports = async input => { releases++; await input.check(); await input.commit(); };
  const capability: typeof originalCapability = async () => {
    resolves++;
    const revision = repository.tooling.revision, checkout = path.join(root, `tooling-${revision}`);
    const receipt = { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
      taskToolingRevision: task.toolingRevision, capabilityRevision: revision, checkout, instructions: `${checkout}/cleanup.md`, adapter: `${checkout}/src/cli.ts` };
    const key = `${task.id}:${hash(JSON.stringify(receipt))}`;
    if (!await db.prisma.runtimeMetadataEvent.findFirst({ where: { action: "tooling-capability", key } })) await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: `task:${task.id}`, action: "tooling-capability", key, value: JSON.stringify(receipt) } });
    await afterResolve?.(); return { receipt, instructions: `Reviewed cleanup ${revision}` };
  };
  inbox.cleanupInboxDependencies.capability = capability;
  const enqueue = (requestKey = "original-request") => inbox.enqueueTaskCleanup({ prisma: db.prisma, config, taskId: task.id, requestKey }, { capability });
  const queued = await enqueue(), instruction = await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: queued.instructionId } });
  const marker = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: inbox.CLEANUP_INSTRUCTION, key: instruction.id } });
  const requests = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: inbox.CLEANUP_REQUEST } });
  const input = { prisma: db.prisma, config, runtime, receipt: { id: instruction.id, sessionId: session.id } };
  return { task, session, repository, config, runtime, contract, immutable, instruction, marker, requests, input, enqueue,
    upgrade: () => { repository.tooling.revision = "c".repeat(40); }, onResolve: (fn: () => Promise<void>) => { afterResolve = fn; },
    stats: () => ({ releases, resolves }), refresh: () => inbox.refreshQueuedCleanupInstruction(input) };
}
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await Bun.sleep(5); } throw new Error("Expected inbox progress"); }

test("queued cleanup refreshes before opening its provider and preserves original authority", async () => {
  const f = await fixture(); f.upgrade();
  expect(await inbox.prepareQueuedCleanupTransport(f.input)).toBe(false);
  expect(f.stats().releases).toBe(0);
  const items = await db.prisma.runtimeInstruction.findMany({ orderBy: { sequence: "asc" } });
  expect(items).toHaveLength(2); expect(items[0]).toMatchObject({ id: f.instruction.id, state: "cancelled", text: f.instruction.text });
  expect(items[0]!.detail).toContain(items[1]!.id); expect(items[1]!.text).toContain("tooling-" + "c".repeat(40));
  expect(items[1]!.text).toContain(`finalize:${f.task.id}`); expect(items[1]!.text).not.toContain("tooling-" + "b".repeat(40));
  expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.marker.sequence } })).toEqual(f.marker);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { action: inbox.CLEANUP_REQUEST } })).toEqual(f.requests);
  for (const old of f.immutable) expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: old.sequence } })).toEqual(old);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(f.task);
  const next = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: inbox.CLEANUP_INSTRUCTION, key: items[1]!.id } });
  const oldValue = JSON.parse(f.marker.value!), nextValue = JSON.parse(next.value!);
  expect({ ...nextValue, capability: oldValue.capability }).toEqual(oldValue);
  const link = JSON.parse((await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: inbox.CLEANUP_SUPERSEDED } })).value!);
  expect(link.previous).toEqual({ instructionId: f.instruction.id, instructionSha256: hash(JSON.stringify(f.instruction)), markerRevision: f.marker.sequence, markerSha256: hash(f.marker.value!) });
  expect(link.successor).toMatchObject({ instructionId: items[1]!.id, textSha256: hash(items[1]!.text), markerSha256: hash(next.value!) });
  await deliverInstructions(db.prisma, f.runtime, f.config); await until(async () => f.runtime.sentMessages.length === 1);
  expect(f.runtime.sentMessages[0]!.text).toBe(items[1]!.text); expect(f.stats().releases).toBe(1);
});

test("unchanged capability keeps the exact queued command and creates no supersession", async () => {
  const f = await fixture(); expect(await f.refresh()).toBe(true);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(f.instruction);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: inbox.CLEANUP_SUPERSEDED } })).toBe(0);
  expect(f.stats().releases).toBe(0);
});

test("lost acknowledgment and concurrent retries create one successor; request replay keeps old history", async () => {
  const f = await fixture(); f.upgrade(); let lose = true;
  const prisma = new Proxy(db.prisma, { get(target, name) { if (name !== "$transaction") return Reflect.get(target, name); return async (work: any) => { const result = await target.$transaction(work); if (lose) { lose = false; throw new Error("lost acknowledgment"); } return result; }; } });
  await expect(inbox.refreshQueuedCleanupInstruction({ ...f.input, prisma: prisma as PrismaClient })).rejects.toThrow("lost acknowledgment");
  await Promise.all([f.refresh(), f.refresh()]);
  expect(await db.prisma.runtimeInstruction.count()).toBe(2); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: inbox.CLEANUP_SUPERSEDED } })).toBe(1);
  expect(await f.enqueue()).toMatchObject({ instructionId: f.instruction.id, state: "cancelled" });
  const successor = await db.prisma.runtimeInstruction.findFirstOrThrow({ where: { state: "queued" } });
  expect(await f.enqueue("later-tick")).toMatchObject({ instructionId: successor.id, state: "queued" });
});

test.each(["pause", "work", "acceptance", "capability", "marker", "text", "source"])("%s changing during resolution refuses supersession", async changed => {
  const f = await fixture(); f.upgrade();
  f.onResolve(async () => {
    if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (changed === "work") await queueInstruction(db.prisma, { sessionId: f.session.id, requestId: "user-work", text: "Keep my actual request" });
    if (changed === "acceptance") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-contract", key: "new", value: JSON.stringify({ boundary: "merge", verificationRequired: false }) } });
    if (changed === "capability") f.repository.tooling.revision = "d".repeat(40);
    if (changed === "marker") await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.marker.sequence }, data: { value: f.marker.value! + " " } });
    if (changed === "text") await db.prisma.runtimeInstruction.update({ where: { id: f.instruction.id }, data: { text: "Changed old command" } });
    if (changed === "source") await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: f.session.id }, data: { endedAt: new Date() } });
  });
  await expect(f.refresh()).rejects.toThrow();
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).state).toBe("queued");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: inbox.CLEANUP_SUPERSEDED } })).toBe(0);
});

test.each(["dispatching", "unknown", "completed"])("%s cleanup and ordinary commands are never replaced", async state => {
  const f = await fixture(); f.upgrade();
  await db.prisma.runtimeInstruction.update({ where: { id: f.instruction.id }, data: { state } });
  const before = await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } });
  expect(await f.refresh()).toBe(false); expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(before);
  const ordinary = await queueInstruction(db.prisma, { sessionId: f.session.id, requestId: "human", text: "ordinary" });
  expect(await inbox.refreshQueuedCleanupInstruction({ ...f.input, receipt: { id: ordinary.id, sessionId: f.session.id } })).toBe(true);
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
});

test("failed refresh does not stall unrelated inbox work or fabricate terminal cleanup state", async () => {
  const f = await fixture(); f.upgrade();
  inbox.cleanupInboxDependencies.capability = async () => { throw new Error("Current capability unavailable"); };
  const other = await db.prisma.runtimeSession.create({ data: { id: "other", scopeKey: "other", agentCommand: "codex", status: "idle", role: "primary", cwd: "/unrelated", repositoryId: f.repository.id, machineId: f.config.machine } });
  f.runtime.putSession({ id: other.id, status: "idle", role: "primary", cwd: other.cwd, repositoryId: other.repositoryId, machineId: other.machineId, agent: "codex" });
  await queueInstruction(db.prisma, { sessionId: other.id, requestId: "other-work", text: "Independent owner work" });
  await deliverInstructions(db.prisma, f.runtime, f.config); await until(async () => f.runtime.sentMessages.length === 1);
  expect(f.runtime.sentMessages[0]!.sessionId).toBe(other.id);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(f.instruction);
  expect(f.stats().releases).toBe(0);
});


test.each(["pause", "work", "marker"])("unchanged capability still rejects %s during resolution", async changed => {
  const f = await fixture();
  f.onResolve(async () => {
    if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (changed === "work") await queueInstruction(db.prisma, { sessionId: f.session.id, requestId: "later-user-work", text: "Keep this request" });
    if (changed === "marker") await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.marker.sequence }, data: { value: f.marker.value! + " " } });
  });
  await expect(f.refresh()).rejects.toThrow();
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.instruction.id } })).toEqual(f.instruction);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: inbox.CLEANUP_SUPERSEDED } })).toBe(0);
});
