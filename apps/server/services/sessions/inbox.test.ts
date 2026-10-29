import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { queueInstruction, deliverInstructions } from "./inbox.ts";
import { TurnCapacity } from "./turn-capacity.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

test("inbox persists while busy, deduplicates uncertain client responses, and preserves message order", async () => {
  const runtime = createFakeAgentRuntime([{ id: "session", status: "active" }]);
  const first = { sessionId: "session", requestId: "request-one", text: "first" };
  await queueInstruction(db.prisma, first);
  await queueInstruction(db.prisma, first);
  await queueInstruction(db.prisma, { ...first, requestId: "request-two", text: "second" });
  await expect(queueInstruction(db.prisma, { ...first, text: "different" })).rejects.toThrow("another instruction");
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  await db.prisma.$disconnect();
  runtime.putSession({ id: "session", status: "idle" });
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 1; i++) await Bun.sleep(5);
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 2; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map((message) => message.text)).toEqual(["first", "second"]);
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
});

test("unknown prior delivery blocks later instructions after restart instead of replaying", async () => {
  const runtime = createFakeAgentRuntime([{ id: "session" }]);
  await db.prisma.runtimeInstruction.create({ data: { id: "uncertain", sessionId: "session", text: "may have run", state: "dispatching" } });
  await queueInstruction(db.prisma, { sessionId: "session", requestId: "later", text: "next" });
  await deliverInstructions(db.prisma, runtime);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "uncertain" } })).state).toBe("unknown");
  expect(runtime.sentMessages).toHaveLength(0);
  await db.prisma.runtimeInstruction.update({ where: { id: "uncertain" }, data: { state: "acknowledged", detail: "Owner verified history" } });
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 1; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map((message) => message.text)).toEqual(["next"]);
});


test("capacity waits stay queued across daemon loss and dispatch once on recovery", async () => {
  const runtime = createFakeAgentRuntime([{ id: "one" }, { id: "two" }]);
  const capacity = new TurnCapacity(1);
  const releaseBusy = await capacity.acquire(new AbortController().signal);
  const admitted: string[] = [];
  runtime.startTurn = (input) => ({
    requestId: input.requestId!,
    events: { async *[Symbol.asyncIterator]() {} },
    result: (async () => {
      const release = await capacity.acquire(new AbortController().signal);
      try {
        if (!(await input.beforeStart?.())) throw new Error("claim failed");
        admitted.push(input.requestId!);
        return { status: "completed" as const };
      } finally { release(); }
    })(),
    cancel: async () => {},
  });
  await queueInstruction(db.prisma, { sessionId: "one", requestId: "first", text: "first" });
  await queueInstruction(db.prisma, { sessionId: "two", requestId: "second", text: "second" });
  await deliverInstructions(db.prisma, runtime);
  await deliverInstructions(db.prisma, runtime);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "queued" } })).toBe(2);
  expect(admitted).toEqual([]);
  capacity.stop();
  releaseBusy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await db.prisma.$disconnect();
  const recovered = createFakeAgentRuntime([{ id: "one" }, { id: "two" }]);
  await deliverInstructions(db.prisma, recovered);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 2; i++) await Bun.sleep(5);
  expect(recovered.sentMessages.map((message) => message.requestId)).toEqual(["first", "second"]);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "completed" } })).toBe(2);
});

test("a page of busy-session backlog cannot starve another owner's instruction", async () => {
  const runtime = createFakeAgentRuntime([{ id: "busy", status: "active" }, { id: "ready" }]);
  await db.prisma.runtimeInstruction.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
    id: `busy-${index}`, sessionId: "busy", text: `queued-${index}`,
  })) });
  await queueInstruction(db.prisma, { sessionId: "ready", requestId: "owner-ready", text: "owner correction" });
  await queueInstruction(db.prisma, { sessionId: "ready", requestId: "owner-later", text: "later" });
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 1; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map(({ requestId }) => requestId)).toEqual(["owner-ready"]);
  expect(await db.prisma.runtimeInstruction.count({ where: { sessionId: "busy", state: "queued" } })).toBe(105);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "owner-later" } })).state).toBe("queued");
});

test("paging preserves unknown, preparing and owner-pause guards without blocking other sessions", async () => {
  const runtime = createFakeAgentRuntime([
    { id: "uncertain" }, { id: "preparing" }, { id: "paused", cwd: "/paused-task" }, { id: "ready" },
  ]);
  await db.prisma.remoteTask.create({ data: {
    requestKey: "paused-task", repositoryId: "repo", machineId: "air", branchName: "codex/paused",
    worktreePath: "/paused-task", toolingRoot: "/tools", toolingRevision: "a".repeat(40), ownerPaused: true,
  } });
  await db.prisma.runtimeInstruction.createMany({ data: [
    { id: "unknown", sessionId: "uncertain", text: "uncertain work", state: "unknown" },
    { id: "preparation", sessionId: "preparing", text: "setup", state: "preparing" },
    ...["uncertain", "preparing", "paused"].flatMap((sessionId) => Array.from({ length: 105 }, (_, index) => ({
      id: `${sessionId}-${index}`, sessionId, text: `queued-${index}`, state: "queued",
    }))),
  ] });
  await queueInstruction(db.prisma, { sessionId: "ready", requestId: "ready", text: "run" });
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 1; i++) await Bun.sleep(5);
  expect(runtime.sentMessages.map(({ sessionId }) => sessionId)).toEqual(["ready"]);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "queued" } })).toBe(315);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "unknown" } })).state).toBe("unknown");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "preparation" } })).state).toBe("preparing");
});

test("a concurrent owner resolution cannot be overwritten by a stale reconciliation scan", async () => {
  const runtime = createFakeAgentRuntime([{ id: "session", status: "active" }]);
  await db.prisma.runtimeInstruction.create({ data: { id: "unknown", sessionId: "session", text: "may have run", state: "unknown" } });
  const store = new Proxy(db.prisma, { get(target, property) {
    if (property === "runtimeLifecycleEvent") return { findFirst: async () => {
      await db.prisma.runtimeInstruction.update({ where: { id: "unknown" }, data: { state: "acknowledged", detail: "Owner verified the effect" } });
      return { phase: "completed", error: null };
    } };
    return Reflect.get(target, property);
  } });
  await deliverInstructions(store, runtime);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "unknown" } })).toMatchObject({ state: "acknowledged", detail: "Owner verified the effect" });
});

test("repeated unknown reconciliation preserves the original stalled timestamp and evidence", async () => {
  const runtime = createFakeAgentRuntime([{ id: "session", status: "active" }]);
  const since = new Date("2026-01-01T00:00:00Z");
  await db.prisma.runtimeInstruction.create({ data: { id: "unknown", sessionId: "session", text: "possibly ran", state: "unknown", detail: "Original uncertain provider outcome", updatedAt: since } });
  await deliverInstructions(db.prisma, runtime);
  await deliverInstructions(db.prisma, runtime);
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "unknown" } })).toMatchObject({ updatedAt: since, detail: "Original uncertain provider outcome" });
});

test("owner pause while waiting for capacity keeps the original queued instruction", async () => {
  const runtime = createFakeAgentRuntime([{ id: "session", cwd: "/handoff" }]);
  await db.prisma.remoteTask.create({ data: { requestKey: "handoff", repositoryId: "repo", machineId: "air", branchName: "codex/handoff", worktreePath: "/handoff", toolingRoot: "/tools", toolingRevision: "a".repeat(40) } });
  let claim: (() => Promise<boolean>) | undefined;
  let finish!: () => void;
  runtime.startTurn = (input) => ({
    requestId: input.requestId!,
    events: { async *[Symbol.asyncIterator]() {} },
    result: new Promise<{ status: "cancelled" }>((resolve) => { claim = input.beforeStart; finish = () => resolve({ status: "cancelled" }); }),
    cancel: async () => {},
  });
  await queueInstruction(db.prisma, { sessionId: "session", requestId: "waiting", text: "wait" });
  await deliverInstructions(db.prisma, runtime);
  await db.prisma.remoteTask.updateMany({ data: { ownerPaused: true } });
  expect(await claim!()).toBe(false);
  finish();
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "waiting" } })).state).toBe("queued");
});

test.each([undefined, 1])("owner cleanup progresses on its original primary with managed-turn limit %s", async (limit) => {
  const runtime = createFakeAgentRuntime([
    { id: "busy", status: "active" },
    { id: "primary", cwd: "/cleanup-task" },
    ...["other-one", "other-two", "other-three"].map((id) => ({ id })),
  ]);
  const task = await db.prisma.remoteTask.create({ data: {
    requestKey: "cleanup-task", primarySessionId: "primary", repositoryId: "repo", machineId: "air",
    branchName: "codex/cleanup", worktreePath: "/cleanup-task", toolingRoot: "/tools", toolingRevision: "a".repeat(40),
  } });
  await db.prisma.runtimeInstruction.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
    id: `busy-${index}`, sessionId: "busy", text: "Unrelated queued work",
  })) });
  await queueInstruction(db.prisma, { sessionId: "primary", requestId: "owner-cleanup", text: "Complete the authorized cleanup" });
  for (const id of ["other-one", "other-two", "other-three"]) await queueInstruction(db.prisma, { sessionId: id, requestId: id, text: "Independent work" });
  const capacity = new TurnCapacity(limit);
  const admitted: string[] = [];
  const finishers = new Map<string, () => void>();
  const pending: Promise<unknown>[] = [];
  let ending = false;
  runtime.startTurn = (input) => {
    const result = (async () => {
      const release = await capacity.acquire(new AbortController().signal);
      try {
        if (!(await input.beforeStart?.())) return { status: "cancelled" as const };
        admitted.push(input.requestId!);
        if (!ending) await new Promise<void>((resolve) => { finishers.set(input.requestId!, resolve); });
        return { status: "completed" as const };
      } finally { release(); }
    })();
    pending.push(result);
    return { requestId: input.requestId!, events: { async *[Symbol.asyncIterator]() {} }, result, cancel: async () => {} };
  };
  const waitFor = async (predicate: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error("Managed-turn admission did not settle");
  };
  try {
    await deliverInstructions(db.prisma, runtime);
    await waitFor(async () => admitted.length === (limit === undefined ? 4 : 1));
    expect(admitted[0]).toBe("owner-cleanup");
    expect(await db.prisma.runtimeInstruction.count({ where: { state: "dispatching" } })).toBe(limit === undefined ? 4 : 1);
    expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "owner-cleanup" } })).sessionId).toBe("primary");
    if (limit === 1) {
      expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "other-one" } })).state).toBe("queued");
      finishers.get("owner-cleanup")!();
      await waitFor(async () => admitted.length === 2);
      expect(admitted).toEqual(["owner-cleanup", "other-one"]);
    }
  } finally {
    ending = true;
    for (const finish of finishers.values()) finish();
    await Promise.allSettled(pending);
    await waitFor(async () => await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) === 4);
  }
  expect(await db.prisma.runtimeInstruction.count({ where: { sessionId: "busy", state: "queued" } })).toBe(105);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
    primarySessionId: "primary", worktreePath: "/cleanup-task", toolingRevision: "a".repeat(40),
  });
  expect(await db.prisma.remoteTask.count()).toBe(1);
});


test("explicit owner pause survives restart and holds primary and delegate messages until resume", async () => {
  const cwd = "/task/owner-paused";
  const runtime = createFakeAgentRuntime([{ id: "primary", cwd, status: "idle" }, { id: "delegate", cwd, status: "idle" }]);
  await db.prisma.remoteTask.create({ data: { id: "paused-task", requestKey: "paused-task", repositoryId: "repo", machineId: "machine", branchName: "codex/task", worktreePath: cwd, toolingRoot: "/tooling", toolingRevision: "pinned", primarySessionId: "primary", phase: "review", ownerPaused: true } });
  for (const sessionId of ["primary", "delegate"]) await queueInstruction(db.prisma, { sessionId, requestId: `paused-${sessionId}`, text: sessionId });
  await db.prisma.$disconnect();
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toEqual([]);
  expect(await db.prisma.runtimeInstruction.count({ where: { state: "queued" } })).toBe(2);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "paused-task" } })).phase).toBe("review");
  await db.prisma.remoteTask.update({ where: { id: "paused-task" }, data: { ownerPaused: false } });
  await deliverInstructions(db.prisma, runtime);
  for (let attempt = 0; attempt < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 2; attempt++) await Bun.sleep(5);
  expect(runtime.sentMessages.map((message) => message.text).sort()).toEqual(["delegate", "primary"]);
});
