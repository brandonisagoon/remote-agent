import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { deliverInstructions, queueInstruction } from "../sessions/inbox.ts";
import { recordSourceMessage } from "../sessions/source-messages.ts";
import { automaticCleanupTurn, cleanupInstructionAllows, enqueueTaskCleanup, CLEANUP_INSTRUCTION } from "./cleanup-inbox.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function fixture() {
  const config = testConfig();
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: "/owned/task", repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-194", primarySessionId: session.id, branchName: "codex/task", worktreePath: session.cwd, toolingRoot: "/old", toolingRevision: "a".repeat(40), pinnedToolingRoot: "/old/pin", phase: "waiting" } });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier!, relationship: "handles" } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: "owner:task", action: "completion-contract", key: "accepted", value: JSON.stringify({ boundary: "merge", verificationRequired: false }) } });
  const runtime = createFakeAgentRuntime([{ id: session.id, cwd: session.cwd, repositoryId: session.repositoryId, machineId: session.machineId, status: "idle", role: "primary", agent: "codex" }]);
  let resolves = 0;
  const dependencies = { capability: async () => { resolves++; return { receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const, taskToolingRevision: task.toolingRevision, capabilityRevision: "b".repeat(40), checkout: "/immutable/new pin", instructions: "/immutable/new pin/cleanup.md", adapter: "/immutable/new pin/src/cli.ts" }, instructions: "Use the verified cleanup capability." }; } };
  const enqueue = (requestKey = "tick-1") => enqueueTaskCleanup({ prisma: db.prisma, config, taskId: task.id, requestKey }, dependencies);
  return { config, task, session, runtime, enqueue, resolves: () => resolves };
}

test("automatic maintenance only queues the current primary, pins the capability, and deduplicates lost responses and pending ticks", async () => {
  const f = await fixture();
  f.runtime.sessions.get(f.session.id)!.status = "active";
  const first = await f.enqueue(); await db.prisma.$disconnect();
  expect(await f.enqueue()).toEqual(first);
  expect(await f.enqueue("tick-2")).toEqual(first);
  await deliverInstructions(db.prisma, f.runtime, f.config);
  expect(f.runtime.sentMessages).toEqual([]);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_INSTRUCTION } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(0);
  const instruction = await db.prisma.runtimeInstruction.findFirstOrThrow();
  expect(instruction.text).toContain("'/immutable/new pin/src/cli.ts' task destroy --task 'task'");
  expect(instruction.text).toContain(f.config.controlIpcPath);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).pinnedToolingRoot).toBe("/old/pin");
  expect(f.resolves()).toBe(2);
});

test("queued human source work takes precedence without being cancelled, acknowledged, or marked handled", async () => {
  const f = await fixture(), cleanup = await f.enqueue();
  const source = await recordSourceMessage(db.prisma, { provider: "linear", connectionId: f.config.activeConnectionId, repositoryId: f.task.repositoryId, machineId: f.task.machineId, resourceId: "issue", resourceIdentifier: "DRA-194", commentId: "human-followup", threadRootId: "human-followup", authorId: "owner", body: "Preserve this real follow-up", presentation: {} });
  await db.prisma.$transaction(tx => queueInstruction(tx, { sessionId: f.session.id, requestId: "human", sourceMessageId: source.id, text: source.body }));
  const before = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id } });
  expect(await cleanupInstructionAllows(db.prisma, { id: cleanup.instructionId, sessionId: f.session.id })).toBeFalse();
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: cleanup.instructionId } })).state).toBe("cancelled");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "human" } })).state).toBe("queued");
  expect(await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id } })).toEqual(before);
  expect(await f.enqueue()).toMatchObject({ instructionId: cleanup.instructionId, state: "cancelled" });
  await db.prisma.runtimeInstruction.update({ where: { id: "human" }, data: { state: "completed" } });
  const later = await f.enqueue("next-pass-after-real-work");
  expect(later.instructionId).not.toBe(cleanup.instructionId);
  expect((await f.enqueue("another-concurrent-pass")).instructionId).toBe(later.instructionId);
});

test("the actual inbox beforeStart race cancels only synthetic cleanup and preserves the arriving instruction", async () => {
  const f = await fixture(), cleanup = await f.enqueue();
  const start = f.runtime.startTurn.bind(f.runtime);
  f.runtime.startTurn = input => start({ ...input, beforeStart: async () => {
    await queueInstruction(db.prisma, { sessionId: f.session.id, requestId: "late-followup", text: "New owner work" });
    return input.beforeStart!();
  } });
  await deliverInstructions(db.prisma, f.runtime, f.config);
  for (let i = 0; i < 100 && (await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: cleanup.instructionId } })).state === "queued"; i++) await Bun.sleep(5);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: cleanup.instructionId } })).state).toBe("cancelled");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "late-followup" } })).state).toBe("queued");
});

test("active delegates, changed authority and terminal/wrong execution correlation never authorize automatic cleanup", async () => {
  const f = await fixture(), cleanup = await f.enqueue();
  const child = await db.prisma.runtimeSession.create({ data: { id: "child", scopeKey: "child", role: "delegate", status: "active", agentCommand: "codex", cwd: f.session.cwd, repositoryId: f.task.repositoryId, machineId: f.task.machineId } });
  expect(await cleanupInstructionAllows(db.prisma, { id: cleanup.instructionId, sessionId: f.session.id })).toBeFalse();
  await db.prisma.runtimeSession.update({ where: { id: child.id }, data: { status: "idle" } });
  await db.prisma.runtimeInstruction.update({ where: { id: cleanup.instructionId }, data: { state: "dispatching", executionRequestId: "turn" } });
  await expect(automaticCleanupTurn(db.prisma, f.task, true)).rejects.toThrow("correlation");
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: f.session.id, requestId: "turn", phase: "started", occurredAt: new Date() } });
  expect(await automaticCleanupTurn(db.prisma, f.task, true, { observeSessionActivity: id => id === f.session.id ? ({ state: "executing", requestId: "turn", observedAt: Date.now() }) : ({ state: "unknown", observedAt: Date.now() }) })).toMatchObject({ initialInstructionId: cleanup.instructionId });
  await expect(automaticCleanupTurn(db.prisma, f.task, true, { observeSessionActivity: () => ({ state: "executing", requestId: "foreign", observedAt: Date.now() }) })).rejects.toThrow("current executing");
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "completed", runtimeSessionId: f.session.id, requestId: "turn", phase: "completed", occurredAt: new Date() } });
  await expect(automaticCleanupTurn(db.prisma, f.task, true)).rejects.toThrow("terminal");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(f.enqueue("tick-paused")).rejects.toThrow("candidate");
});


test("delegate inbox claims wait for the running automatic primary and remain queued", async () => {
  const f = await fixture(), cleanup = await f.enqueue();
  await db.prisma.runtimeInstruction.update({ where: { id: cleanup.instructionId }, data: { state: "dispatching", executionRequestId: "cleanup-turn" } });
  const child = await db.prisma.runtimeSession.create({ data: { id: "child", scopeKey: "child", role: "delegate", status: "idle", agentCommand: "codex", cwd: f.session.cwd, repositoryId: f.task.repositoryId, machineId: f.task.machineId } });
  const instruction = await queueInstruction(db.prisma, { sessionId: child.id, requestId: "delegate-work", text: "Retain this request" });
  expect(await db.prisma.$transaction(tx => cleanupInstructionAllows(tx, { id: instruction.id, sessionId: child.id }))).toBeFalse();
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } })).state).toBe("queued");
  await db.prisma.runtimeInstruction.update({ where: { id: cleanup.instructionId }, data: { state: "completed" } });
  expect(await cleanupInstructionAllows(db.prisma, { id: instruction.id, sessionId: child.id })).toBeTrue();
});
