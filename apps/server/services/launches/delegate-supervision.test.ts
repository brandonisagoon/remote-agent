import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../sessions/runtime-registry.ts";
import { deliverInstructions } from "../sessions/inbox.ts";
import { inspectDelegates, instructDelegate, queueDelegateResult } from "./delegate-supervision.ts";
import { createApp } from "../../app.ts";
import { testConfig } from "../../../../test-support/config.ts";

let db: TestDatabase | undefined;
afterEach(async () => { await db?.cleanup(); });

async function fixture(notify = true) {
  db = await createTestDatabase();
  const parent = await beginRuntimeSession(db.prisma, { sessionKey: "astra", agent: "codex", cwd: "/task", repositoryId: "test-repository", machineId: "macbook-air" });
  const child = await beginRuntimeSession(db.prisma, { sessionKey: "opus", agent: "claude", cwd: "/task", repositoryId: "test-repository", machineId: "macbook-air", relations: [{ relationship: "spawned-by", targetSessionId: parent.id }, ...(notify ? [{ relationship: "notifies-parent", targetSessionId: parent.id }] : [])] });
  const runtime = createFakeAgentRuntime([{ ...parent, status: "idle" }, { ...child, status: "idle" }]);
  return { prisma: db.prisma, parent, child, runtime };
}

test("terminal results survive replay, remain queued during human control, and return to the original parent", async () => {
  const { prisma, parent, child, runtime } = await fixture();
  await prisma.remoteTask.create({ data: { id: "task-one", requestKey: "task-one", repositoryId: "test-repository", machineId: "macbook-air", branchName: "codex/task", toolingRoot: "/tooling", toolingRevision: "a".repeat(40), worktreePath: "/task", primarySessionId: parent.id, controlMode: "paused" } });
  const event = { kind: "turn" as const, id: "child-completed", sessionId: child.id, requestId: "work-1", createdAt: Date.now(), phase: "completed" as const, output: "Implementation result" };
  await queueDelegateResult(prisma, event);
  await prisma.$disconnect();
  await queueDelegateResult(prisma, event);
  expect(await prisma.runtimeInstruction.count()).toBe(1);
  const receipt = await prisma.runtimeInstruction.findFirstOrThrow();
  expect(receipt.sessionId).toBe(parent.id);
  expect(receipt.text).toContain("Implementation result");
  await deliverInstructions(prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  await prisma.remoteTask.update({ where: { id: "task-one" }, data: { controlMode: "agent" } });
  await deliverInstructions(prisma, runtime);
  // Delivery continues in the background; settle its receipt before closing SQLite.
  for (let i = 0; i < 50 && await prisma.runtimeInstruction.count({ where: { id: receipt.id, state: "completed" } }) < 1; i++) await Bun.sleep(5);
  expect((await prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } })).state).toBe("completed");
  expect(runtime.sentMessages).toHaveLength(1);
  expect(runtime.sentMessages[0]!.sessionId).toBe(parent.id);
});

test("failures return once, started events and existing non-opted-in delegates do not wake a parent", async () => {
  const { prisma, parent, child } = await fixture(false);
  const event = { kind: "turn" as const, id: "child-failed", sessionId: child.id, requestId: "work-1", createdAt: Date.now(), phase: "failed" as const, error: "Provider capacity unavailable" };
  await queueDelegateResult(prisma, event);
  expect(await prisma.runtimeInstruction.count()).toBe(0);
  await prisma.runtimeSessionRelation.create({ data: { sourceSessionId: child.id, targetSessionId: parent.id, relationship: "notifies-parent" } });
  await queueDelegateResult(prisma, { ...event, id: "started", phase: "started" });
  expect(await prisma.runtimeInstruction.count()).toBe(0);
  await queueDelegateResult(prisma, event);
  await queueDelegateResult(prisma, event);
  expect(await prisma.runtimeInstruction.count()).toBe(1);
  expect((await prisma.runtimeInstruction.findFirstOrThrow()).text).toContain("Provider capacity unavailable");
  await prisma.runtimeSession.update({ where: { id: parent.id }, data: { status: "closed" } });
  await queueDelegateResult(prisma, { ...event, id: "after-close" });
  expect(await prisma.runtimeInstruction.count()).toBe(1);
});

test("only the recorded parent can inspect and continue a worker, with idempotent follow-ups", async () => {
  const { prisma, parent, child, runtime } = await fixture();
  runtime.history = async () => [{ role: "agent", text: "Existing worker result" }];
  expect((await inspectDelegates(prisma, runtime, parent.id, child.id))[0]!.history[0]!.text).toBe("Existing worker result");
  await expect(inspectDelegates(prisma, runtime, "unrelated", child.id)).rejects.toThrow("not this parent's delegate");
  const input = { parentSessionId: parent.id, sessionId: child.id, requestKey: "fix-1", text: "Fix the browser failure" };
  const receipt = await instructDelegate(prisma, runtime, input);
  expect((await instructDelegate(prisma, runtime, input)).id).toBe(receipt.id);
  await expect(instructDelegate(prisma, runtime, { ...input, text: "Changed request" })).rejects.toThrow("another instruction");
  await expect(instructDelegate(prisma, runtime, { ...input, parentSessionId: "unrelated" })).rejects.toThrow("not this parent's delegate");
  const config = testConfig();
  const app = createApp({ config, prisma, agentRuntime: runtime });
  const route = `/api/sessions/${parent.id}/delegates?delegateId=${child.id}`;
  expect((await app.request(route)).status).toBe(401);
  expect((await app.request(route, { headers: { authorization: `Bearer ${config.apiKey}` } })).status).toBe(200);
  runtime.putSession({ ...child, status: "closed" });
  await expect(instructDelegate(prisma, runtime, { ...input, requestKey: "fix-2" })).rejects.toThrow("closed");
});
