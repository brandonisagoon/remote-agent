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

test("human control keeps queued instructions durable until explicit handback", async () => {
  const runtime = createFakeAgentRuntime([{ id: "session", cwd: "/task" }]);
  await db.prisma.remoteTask.create({ data: { requestKey: "task", repositoryId: "repo", machineId: "air", branchName: "codex/test", worktreePath: "/task", toolingRoot: "/tools", toolingRevision: "a".repeat(40), controlMode: "human" } });
  await queueInstruction(db.prisma, { sessionId: "session", requestId: "paused", text: "wait" });
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "paused" } })).state).toBe("queued");
  await db.prisma.remoteTask.updateMany({ data: { controlMode: "agent" } });
  await deliverInstructions(db.prisma, runtime);
  for (let i = 0; i < 50 && await db.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 1; i++) await Bun.sleep(5);
  expect(runtime.sentMessages).toHaveLength(1);
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
