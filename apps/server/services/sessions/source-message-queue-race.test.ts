import { expect, test } from "bun:test";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { createAcpxSessionRuntime } from "../../transports/acpx/session-runtime.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { recordSourceMessage } from "./source-messages.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(prisma: PrismaClient) {
  const config = testConfig();
  const sessions = await Promise.all(["first", "second"].map(async (key) => {
    const session = await beginRuntimeSession(prisma, { sessionKey: `queue-race-${key}`, agent: "codex",
      cwd: `/tmp/queue-race-${key}`, repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
    // enqueue must run through its real path, but no provider may be started.
    await prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "active" } });
    return session;
  }));
  const source = await recordSourceMessage(prisma, { provider: "linear", connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine, resourceId: "issue-one", resourceIdentifier: "ISSUE-1",
    commentId: "queue-race-comment", threadRootId: "queue-race-comment", authorId: "owner", body: "Owner feedback", presentation: {} });
  return { config, first: sessions[0]!, second: sessions[1]!, source };
}

test("competing routing failure cannot unroute a comment between instruction creation and source association", async () => {
  const db = await createTestDatabase();
  const inserted = gate(); const release = gate();
  let blockSourceRead = true;
  try {
    const { config, first, second, source } = await setup(db.prisma);
    // The barrier exposes the original interleaving after the instruction has
    // persisted but before queueInstruction has read/associated its source.
    // Wrap transaction delegates too, so the real production atomic boundary
    // rather than a test-only transaction determines what the competitor sees.
    const wrap = <T extends object>(client: T): T => new Proxy(client, {
      get(target, key, receiver) {
        if (key === "$transaction") return (callback: (tx: unknown) => unknown, options: unknown) =>
          db.prisma.$transaction((tx) => callback(wrap(tx)) as Promise<unknown>, options as never);
        const value = Reflect.get(target, key, receiver);
        if (key === "runtimeSourceMessage") return new Proxy(value as object, {
          get(delegate, operation, delegateReceiver) {
            const method = Reflect.get(delegate, operation, delegateReceiver);
            if (operation === "findUniqueOrThrow") return async (...args: unknown[]) => {
              if (blockSourceRead) { blockSourceRead = false; inserted.resolve(); await release.promise; }
              return method.apply(delegate, args);
            };
            return typeof method === "function" ? method.bind(delegate) : method;
          },
        });
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = createAcpxSessionRuntime(wrap(db.prisma), config);
    const input = { requestId: source.id, sourceMessageId: source.id, text: source.body };
    const firstDelivery = runtime.enqueue({ ...input, sessionId: first.id });
    await inserted.promise;
    const competitor = runtime.enqueue({ ...input, sessionId: second.id }).then(
      () => { throw new Error("Competing primary unexpectedly acquired the same instruction"); },
      async (error) => {
        expect(String(error)).toContain("another instruction");
        // This is the failed-router feedback update used by the comment worker.
        await db.prisma.runtimeSourceMessage.updateMany({ where: { id: source.id, state: "routing", sessionId: null },
          data: { state: "unrouted", replyBody: "No owning session", projectionPending: true } });
      },
    );
    // Before the fix the competing enqueue and failure update finish while A
    // is blocked. With the production transaction they wait for A's commit.
    await Promise.race([competitor, Bun.sleep(100)]);
    release.resolve();
    expect(await firstDelivery).toBe(source.id);
    await competitor;
    expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: source.id },
      select: { sessionId: true, state: true } })).toEqual({ sessionId: first.id, state: "queued" });
    expect(await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id },
      select: { sessionId: true, state: true, replyBody: true } })).toEqual({ sessionId: first.id, state: "queued", replyBody: null });
    await runtime.shutdown();
  } finally { release.resolve(); await db.cleanup(); }
});

test("production enqueue cannot attach a new instruction to an already unrouted source", async () => {
  const db = await createTestDatabase();
  try {
    const { config, first, source } = await setup(db.prisma);
    await db.prisma.runtimeSourceMessage.update({ where: { id: source.id }, data: { state: "unrouted", replyBody: "No owning session" } });
    const runtime = createAcpxSessionRuntime(db.prisma, config);
    await expect(runtime.enqueue({ sessionId: first.id, requestId: source.id, sourceMessageId: source.id, text: source.body })).rejects.toThrow();
    expect(await db.prisma.runtimeInstruction.count({ where: { id: source.id } })).toBe(0);
    expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id } })).sessionId).toBeNull();
    await runtime.shutdown();
  } finally { await db.cleanup(); }
});
