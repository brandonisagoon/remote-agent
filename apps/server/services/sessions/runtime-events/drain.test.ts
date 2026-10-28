import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import { appendRuntimeLifecycleEvent, beginRuntimeSession } from "../runtime-registry.ts";
import { queueDelegateResult } from "../../launches/delegate-supervision.ts";
import { drainRuntimeEventProjection } from "./projection.ts";

let database: TestDatabase | undefined;
afterEach(async () => { await database?.cleanup(); });

async function fixture() {
  database = await createTestDatabase();
  const prisma = database.prisma;
  const config = testConfig();
  const sessions = await Promise.all(["parent", "first", "second"].map((name) => beginRuntimeSession(prisma, {
    sessionKey: name, agent: "codex", cwd: `/task/${name}`,
    repositoryId: config.activeRepositoryId, machineId: config.machine,
  })));
  const [parent, first, second] = sessions;
  for (const child of [first!, second!]) {
    await prisma.runtimeSessionRelation.create({ data: {
      sourceSessionId: child.id, targetSessionId: parent!.id, relationship: "notifies-parent",
    } });
  }
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
  });
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
  await drainRuntimeEventProjection(input, delivery);
  await drainRuntimeEventProjection(input, delivery);
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
  });
  expect(projected).toEqual(["first-1", "second-1"]);
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
  expect(await input.prisma.runtimeLifecycleEvent.count()).toBe(3);
  projected.length = 0;
  await drainRuntimeEventProjection(input, {
    notify: queueDelegateResult,
    project: async (_config, _prisma, _runtime, event) => { projected.push(event.id); },
  });
  expect(projected).toEqual(["first-1", "first-2", "second-1"]);
  expect(await input.prisma.runtimeInstruction.count()).toBe(3);
});
