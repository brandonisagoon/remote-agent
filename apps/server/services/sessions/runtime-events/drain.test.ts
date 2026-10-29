import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import { advanceRuntimeEventCursor, appendRuntimeLifecycleEvent, beginRuntimeSession } from "../runtime-registry.ts";
import { queueDelegateResult } from "../../launches/delegate-supervision.ts";
import { drainRuntimeEventProjection, startRuntimeEventProjection } from "./projection.ts";
import { listRuntimeProjectionRetries, projectionRetryPolicy, retryTaskRuntimeProjection, resolveRuntimeProjectionRetry, runRuntimeProjectionAttempt } from "./projection-retries.ts";
import { createApp } from "../../../app.ts";
import { deliverInstructions } from "../inbox.ts";
import type { AgentSessionRuntime } from "../../../../../types/runtime/index.ts";

let database: TestDatabase | undefined;
afterEach(async () => { await database?.cleanup(); });

async function fixture() {
  database = await createTestDatabase();
  const prisma = database.prisma;
  const config = testConfig();
  const sessions = await Promise.all(["parent", "first", "second"].map((name) => beginRuntimeSession(prisma, {
    sessionKey: name, agent: "codex", cwd: "/task", role: name === "parent" ? "primary" : "delegate",
    repositoryId: config.activeRepositoryId, machineId: config.machine,
  })));
  const [parent, first, second] = sessions;
  for (const child of [first!, second!]) {
    await prisma.runtimeSessionRelation.create({ data: { sourceSessionId: child.id, targetSessionId: parent!.id, relationship: "spawned-by" } });
    await prisma.runtimeSessionRelation.create({ data: {
      sourceSessionId: child.id, targetSessionId: parent!.id, relationship: "notifies-parent",
    } });
  }
  await prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.activeRepositoryId, machineId: config.machine, branchName: "codex/task", worktreePath: "/task", primarySessionId: parent!.id, toolingRoot: "/tooling", toolingRevision: "a".repeat(40) } });
  const events = [];
  for (const [name, session] of [["first-1", first!], ["first-2", first!], ["second-1", second!]] as const) {
    events.push(await appendRuntimeLifecycleEvent(prisma, {
      kind: "turn", id: name, requestId: name, sessionId: session.id,
      createdAt: Date.now(), phase: "completed", output: `Result ${name}`,
    }));
  }
  return { input: { prisma, config, runtime: createFakeAgentRuntime(sessions) }, parent: parent!, first: first!, events };
}

test("one failed result cannot strand another worker; replay preserves one continuation per result", async () => {
  const { input, parent, first } = await fixture();
  const projected: string[] = [];
  const attempted: string[] = [];
  await drainRuntimeEventProjection(input, {
    notify: async (prisma, event) => {
      attempted.push(event.id);
      if (event.sessionId === first.id) throw new Error("simulated result delivery failure");
      await queueDelegateResult(prisma, event);
    },
    project: async (_config, _prisma, _runtime, event) => { projected.push(event.id); },
  }, { now: () => 0 });
  expect(attempted).toEqual(["first-1", "second-1"]);
  expect(projected).toEqual(["second-1"]);
  const waiting = await input.prisma.runtimeInstruction.findMany();
  expect(waiting).toHaveLength(1);
  expect(waiting[0]!.sessionId).toBe(parent.id);
  expect(waiting[0]!.text).toContain("Result second-1");
  expect(await input.prisma.runtimeLifecycleEvent.count()).toBe(3);

  // Simulate reopening the durable journal after a process interruption.
  await input.prisma.$disconnect();
  const delivery = { notify: queueDelegateResult, project: async () => {} };
  await drainRuntimeEventProjection(input, delivery, { now: () => 1_000 });
  await drainRuntimeEventProjection(input, delivery, { now: () => 1_000 });
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
  expect(await input.prisma.runtimeInstruction.count({ where: { sessionId: parent.id, state: "queued" } })).toBe(3);
});

test("a failed Linear projection preserves per-session order without blocking local results or other sessions", async () => {
  const { input } = await fixture();
  const projected: string[] = [];
  await drainRuntimeEventProjection(input, {
    notify: queueDelegateResult,
    project: async (_config, prisma, _runtime, event) => {
      // Every continuation is already durable before touching Linear.
      expect(await prisma.runtimeInstruction.count()).toBe(3);
      projected.push(event.id);
      if (event.id === "first-1") throw new Error("simulated Linear outage");
    },
  }, { now: () => 0 });
  expect(projected).toEqual(["first-1", "second-1"]);
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
  expect(await input.prisma.runtimeLifecycleEvent.count()).toBe(3);
  projected.length = 0;
  await drainRuntimeEventProjection(input, {
    notify: queueDelegateResult,
    project: async (_config, _prisma, _runtime, event) => { projected.push(event.id); },
  }, { now: () => 1_000 });
  // The unrelated successful projection was acknowledged and is not replayed.
  expect(projected).toEqual(["first-1", "first-2"]);
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
});

test.each(["notify", "project"] as const)("%s failures back off durably, exhaust a bounded budget, and preserve unrelated continuations", async (stage) => {
  const { input, first, parent } = await fixture();
  let at = 0, attempts = 0;
  const delivery = {
    notify: async (prisma: typeof input.prisma, event: Parameters<typeof queueDelegateResult>[1]) => {
      if (stage === "notify" && event.id === "first-1") { attempts++; throw new Error("Result enqueue is unavailable"); }
      await queueDelegateResult(prisma, event);
    },
    project: async (_config: typeof input.config, _prisma: typeof input.prisma, _runtime: AgentSessionRuntime, event: Parameters<typeof queueDelegateResult>[1]) => {
      if (stage === "project" && event.id === "first-1") { attempts++; throw new Error("Tracker unavailable"); }
    },
  };
  for (let attempt = 1; attempt <= projectionRetryPolicy.maxAttempts; attempt++) {
    await drainRuntimeEventProjection(input, delivery, { now: () => at });
    expect(attempts).toBe(attempt);
    const failures = await listRuntimeProjectionRetries(input.prisma, [first.id]);
    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    expect(failure).toMatchObject({ eventId: "first-1", stage, attempts: attempt, state: attempt === projectionRetryPolicy.maxAttempts ? "exhausted" : "backoff" });
    const metadataCount = await input.prisma.runtimeMetadataEvent.count();
    if (failure.nextAttemptAt !== null) {
      const delay = Math.min(projectionRetryPolicy.maxDelayMs, projectionRetryPolicy.initialDelayMs * 2 ** (attempt - 1));
      expect(failure.nextAttemptAt).toBe(at + delay);
      await input.prisma.$disconnect(); // Retry budget and delay survive restart.
      await drainRuntimeEventProjection(input, delivery, { now: () => failure.nextAttemptAt! - 1 });
      expect(attempts).toBe(attempt);
      expect(await input.prisma.runtimeMetadataEvent.count()).toBe(metadataCount);
      at = failure.nextAttemptAt;
    }
  }
  await input.prisma.$disconnect();
  await drainRuntimeEventProjection(input, delivery, { now: () => at + 86_400_000 });
  expect(attempts).toBe(projectionRetryPolicy.maxAttempts);
  expect(await input.prisma.runtimeLifecycleEvent.count()).toBe(3);
  expect(await input.prisma.runtimeInstruction.count({ where: { sessionId: parent.id } })).toBe(stage === "notify" ? 1 : 3);
});

test("exhausted task-owned projection is explicitly recoverable without replaying an unknown provider outcome", async () => {
  const { input, first, parent } = await fixture();
  let at = 0;
  const uncertain = { notify: async (prisma: typeof input.prisma, event: Parameters<typeof queueDelegateResult>[1]) => {
    await queueDelegateResult(prisma, event);
    if (event.id === "first-1") throw new Error("Enqueue acknowledgement was lost");
  }, project: async () => {} };
  for (let attempt = 0; attempt < projectionRetryPolicy.maxAttempts; attempt++) {
    await drainRuntimeEventProjection(input, uncertain, { now: () => at });
    at = (await listRuntimeProjectionRetries(input.prisma, [first.id]))[0]?.nextAttemptAt ?? at;
  }
  const instructionId = `delegate-result:${parent.id}:first-1`;
  await input.prisma.runtimeInstruction.update({ where: { id: instructionId }, data: { state: "unknown", detail: "Provider turn was interrupted" } });
  const app = createApp({ config: input.config, prisma: input.prisma, agentRuntime: input.runtime });
  const payload = { sessionId: first.id, eventId: "first-1", stage: "notify", requestKey: "reconcile-result", reason: "Repaired enqueue failure; inspect the original inbox receipt" };
  const retry = (value = payload, auth = true) => app.request("/api/tasks/task/projection-retries", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${input.config.apiKey}` } : {}) }, body: JSON.stringify(value) });
  expect((await retry(payload, false)).status).toBe(401);
  expect((await retry({ ...payload, sessionId: parent.id })).status).toBe(409);
  await input.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
  expect((await retry()).status).toBe(409);
  await input.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "working" } });
  expect((await retry()).status).toBe(202);
  const auditCount = await input.prisma.runtimeMetadataEvent.count();
  expect((await retry()).status).toBe(202);
  expect(await input.prisma.runtimeMetadataEvent.count()).toBe(auditCount);
  expect((await retry({ ...payload, reason: "Different decision" })).status).toBe(409);
  await drainRuntimeEventProjection(input, { notify: queueDelegateResult, project: async () => {} });
  expect(await listRuntimeProjectionRetries(input.prisma, [first.id])).toEqual([]);
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
  expect(await input.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: instructionId } })).toMatchObject({ state: "unknown", detail: "Provider turn was interrupted" });
  expect(input.runtime.sentMessages).toHaveLength(0);
});

test("result retries cannot duplicate busy-parent consumption and a closed parent is never resumed", async () => {
  const { input, parent } = await fixture();
  input.runtime.putSession({ ...parent, status: "active" });
  await drainRuntimeEventProjection(input, { notify: queueDelegateResult, project: async () => {} });
  await deliverInstructions(input.prisma, input.runtime);
  expect(input.runtime.sentMessages).toHaveLength(0);
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
  await input.prisma.$disconnect();
  await drainRuntimeEventProjection(input, { notify: queueDelegateResult, project: async () => {} });
  input.runtime.putSession({ ...parent, status: "idle" });
  for (let attempt = 0; attempt < 100 && await input.prisma.runtimeInstruction.count({ where: { state: "completed" } }) < 3; attempt++) {
    await deliverInstructions(input.prisma, input.runtime);
    await Bun.sleep(5);
  }
  expect(input.runtime.sentMessages).toHaveLength(3);
  expect(new Set(input.runtime.sentMessages.map((message) => message.requestId)).size).toBe(3);
  expect(input.runtime.sentMessages.every((message) => message.sessionId === parent.id)).toBe(true);
  await input.prisma.runtimeSession.update({ where: { id: parent.id }, data: { status: "closed" } });
  input.runtime.putSession({ ...parent, status: "closed" });
  await drainRuntimeEventProjection(input, { notify: queueDelegateResult, project: async () => {} });
  await deliverInstructions(input.prisma, input.runtime);
  expect(input.runtime.sentMessages).toHaveLength(3);
});

test("a lost explicit retry response cannot replenish another exhausted budget, and missing events remain explicit failures", async () => {
  const { input, parent, first } = await fixture();
  let at = 0;
  const failure = { notify: async (_prisma: typeof input.prisma, event: Parameters<typeof queueDelegateResult>[1]) => {
    if (event.id === "first-1") throw new Error("Persistent enqueue failure");
  }, project: async () => {} };
  const exhaust = async () => {
    for (let attempt = 0; attempt < projectionRetryPolicy.maxAttempts; attempt++) {
      await drainRuntimeEventProjection(input, failure, { now: () => at });
      at = (await listRuntimeProjectionRetries(input.prisma, [first.id]))[0]!.nextAttemptAt ?? at;
    }
  };
  await exhaust();
  const decision = { taskId: "task", sessionId: first.id, eventId: "first-1", stage: "notify" as const, requestKey: "one-recovery", reason: "Inspected failed result enqueue" };
  const receipt = await retryTaskRuntimeProjection(input.prisma, decision, () => at);
  await exhaust();
  expect(await retryTaskRuntimeProjection(input.prisma, decision, () => at)).toEqual(receipt);
  expect((await listRuntimeProjectionRetries(input.prisma, [first.id]))[0]).toMatchObject({ state: "exhausted", attempts: projectionRetryPolicy.maxAttempts });
  await input.prisma.runtimeSession.update({ where: { id: parent.id }, data: { status: "closed" } });
  await expect(retryTaskRuntimeProjection(input.prisma, { ...decision, requestKey: "after-close" })).rejects.toThrow("primary is closed");
  await input.prisma.runtimeSession.update({ where: { id: parent.id }, data: { status: "idle" } });
  await input.prisma.runtimeLifecycleEvent.delete({ where: { id: "first-1" } });
  await expect(retryTaskRuntimeProjection(input.prisma, { ...decision, requestKey: "missing-event" })).rejects.toThrow("event is unavailable");
  expect((await listRuntimeProjectionRetries(input.prisma, [first.id]))[0]?.state).toBe("exhausted");
});

test("an observed resolved stall clears exhausted telemetry without sending or replaying anything", async () => {
  const { input, parent } = await fixture();
  const identity = { sessionId: parent.id, eventId: "stall:observed-unknown", stage: "stall" as const };
  let at = 0, attempts = 0;
  for (let attempt = 0; attempt < projectionRetryPolicy.maxAttempts; attempt++) {
    await runRuntimeProjectionAttempt(input.prisma, identity, async () => { attempts++; throw new Error("Diagnostic delivery failed"); }, () => at);
    at = (await listRuntimeProjectionRetries(input.prisma, [parent.id]))[0]!.nextAttemptAt ?? at;
  }
  expect((await listRuntimeProjectionRetries(input.prisma, [parent.id]))[0]?.state).toBe("exhausted");
  await resolveRuntimeProjectionRetry(input.prisma, identity, () => at);
  expect(await listRuntimeProjectionRetries(input.prisma, [parent.id])).toEqual([]);
  const count = await input.prisma.runtimeMetadataEvent.count();
  await resolveRuntimeProjectionRetry(input.prisma, identity, () => at);
  expect(await input.prisma.runtimeMetadataEvent.count()).toBe(count);
  expect(attempts).toBe(projectionRetryPolicy.maxAttempts);
  expect(await input.prisma.runtimeInstruction.count()).toBe(0);
  expect(input.runtime.sentMessages).toHaveLength(0);
});

test("acknowledged journal history is retained without repeating notification or projection after restart", async () => {
  const { input, first } = await fixture();
  await input.prisma.runtimeLifecycleEvent.deleteMany();
  await input.prisma.runtimeLifecycleEvent.createMany({ data: Array.from({ length: 1_500 }, (_, index) => ({
    id: `history-${index}`, runtimeSessionId: first.id, requestId: `history-${index}`, phase: "completed", occurredAt: new Date(), output: "Retained evidence",
  })) });
  const last = await input.prisma.runtimeLifecycleEvent.findFirstOrThrow({ orderBy: { sequence: "desc" } });
  for (const consumer of ["delegate-notification:v1", "linear-projection:v1"]) await advanceRuntimeEventCursor(input.prisma, {
    runtimeSessionId: first.id, consumer, sourceCursor: last.id, generation: BigInt(last.sequence),
  });
  await appendRuntimeLifecycleEvent(input.prisma, { kind: "turn", id: "new-result", sessionId: first.id, requestId: "new-result", phase: "completed", createdAt: Date.now() });
  const notified: string[] = [], projected: string[] = [];
  const delivery = { notify: async (_prisma: typeof input.prisma, event: Parameters<typeof queueDelegateResult>[1]) => { notified.push(event.id); },
    project: async (_config: typeof input.config, _prisma: typeof input.prisma, _runtime: AgentSessionRuntime, event: Parameters<typeof queueDelegateResult>[1]) => { projected.push(event.id); } };
  await drainRuntimeEventProjection(input, delivery);
  await input.prisma.$disconnect();
  await drainRuntimeEventProjection(input, delivery);
  expect(notified).toEqual(["new-result"]);
  expect(projected).toEqual(["new-result"]);
  expect(await input.prisma.runtimeLifecycleEvent.count()).toBe(1_501);
});

test("a missing source acknowledgement stays pending and cannot skip later events in that session", async () => {
  const { input } = await fixture();
  const attempted: string[] = [];
  await drainRuntimeEventProjection(input, { notify: queueDelegateResult, project: async (_config, _prisma, _runtime, event) => {
    attempted.push(event.id); return event.id !== "first-1";
  } });
  expect(attempted).toEqual(["first-1", "second-1"]);
  attempted.length = 0;
  await drainRuntimeEventProjection(input, { notify: queueDelegateResult, project: async (_config, _prisma, _runtime, event) => { attempted.push(event.id); } });
  expect(attempted).toEqual(["first-1", "first-2"]);
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
});

test("a large journal gives real health and task requests time to run before reconciliation finishes", async () => {
  const { input, first } = await fixture();
  await input.prisma.runtimeLifecycleEvent.createMany({ data: Array.from({ length: 500 }, (_, index) => ({
    id: `backfill-${index}`, runtimeSessionId: first.id, requestId: `backfill-${index}`, phase: "completed", occurredAt: new Date(),
  })) });
  const app = createApp({ ...input, agentRuntime: input.runtime, trustLocal: true });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  let done = false, servedWhileDraining = false;
  try {
    const drain = drainRuntimeEventProjection(input, { notify: queueDelegateResult, project: async () => {} }).then(() => { done = true; });
    const requests = (async () => {
      const health = await fetch(new URL("/health", server.url));
      expect(health.status).toBe(200); await health.body?.cancel();
      const task = await fetch(new URL("/api/tasks/task", server.url));
      expect(task.status).toBe(200); expect((await task.json() as { task: { id: string } }).task.id).toBe("task");
      servedWhileDraining = !done;
    })();
    await Promise.all([drain, requests]);
    expect(servedWhileDraining).toBeTrue();
    expect(await input.prisma.runtimeInstruction.count()).toBe(503);
  } finally { await server.stop(true); }
});

test("projection triggers coalesce while work runs instead of queuing one replay per event", async () => {
  const { input } = await fixture();
  let listener: ((event: any) => void | Promise<void>) | undefined;
  input.runtime.subscribeAll = (callback) => { listener = callback; return () => { listener = undefined; }; };
  let release!: () => void, calls = 0;
  const first = new Promise<void>((resolve) => { release = resolve; });
  const stop = startRuntimeEventProjection(input, async () => { calls++; if (calls === 1) await first; });
  for (let index = 0; index < 1_000; index++) await listener?.({ kind: "turn" });
  expect(calls).toBe(1);
  release();
  for (let attempt = 0; attempt < 100 && calls < 2; attempt++) await Bun.sleep(1);
  await stop();
  expect(calls).toBe(2);
});

test("events arriving during notification wait for the next pass without delaying current projection", async () => {
  const { input } = await fixture();
  const notified: string[] = [], projected: string[] = [];
  await drainRuntimeEventProjection(input, {
    notify: async (prisma, event) => {
      notified.push(event.id);
      await appendRuntimeLifecycleEvent(prisma, { ...event, id: `later-${event.id}`, requestId: `later-${event.id}` });
    },
    project: async (_config, _prisma, _runtime, event) => { projected.push(event.id); },
  });
  expect(notified).toEqual(["first-1", "first-2", "second-1"]);
  expect(projected).toEqual(notified);
  expect(await input.prisma.runtimeLifecycleEvent.count()).toBe(6);
});
