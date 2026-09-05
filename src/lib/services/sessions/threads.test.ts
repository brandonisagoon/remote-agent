import { afterEach, describe, expect, test } from "bun:test";

import {
  createTestDatabase,
  type TestDatabase,
} from "../../../test-support/db.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import {
  findThreadSession,
  registerThread,
  resolveQuestionThread,
  unregisterThread,
} from "./threads.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

const KEY = {
  provider: "linear",
  connectionId: "linear-test",
  threadRootCommentId: "comment-root-1",
};

async function session(prisma: TestDatabase["prisma"], sessionKey: string) {
  return beginRuntimeSession(prisma, {
    sessionKey,
    agent: "codex",
    cwd: "/tmp/thread-repo",
    repositoryId: "test-repository",
    machineId: "macbook-air",
  });
}

describe("thread registry", () => {
  test("registers, resolves, and hands a thread to exactly one session", async () => {
    database = await createTestDatabase();
    const first = await session(database.prisma, "thread-a");
    const second = await session(database.prisma, "thread-b");

    await registerThread(database.prisma, { ...KEY, runtimeSessionId: first.id });
    expect(await findThreadSession(database.prisma, KEY)).toEqual({
      runtimeSessionId: first.id,
      relationship: "thread",
    });

    // Re-registration to another session ends the previous ownership.
    await registerThread(database.prisma, { ...KEY, runtimeSessionId: second.id });
    expect(await findThreadSession(database.prisma, KEY)).toEqual({
      runtimeSessionId: second.id,
      relationship: "thread",
    });

    await unregisterThread(database.prisma, { ...KEY, runtimeSessionId: second.id });
    expect(await findThreadSession(database.prisma, KEY)).toBeNull();
  });

  test("question threads resolve to plain threads once answered", async () => {
    database = await createTestDatabase();
    const owner = await session(database.prisma, "thread-question");
    await registerThread(database.prisma, {
      ...KEY,
      runtimeSessionId: owner.id,
      relationship: "question",
    });
    expect((await findThreadSession(database.prisma, KEY))?.relationship).toBe("question");

    await resolveQuestionThread(database.prisma, { ...KEY, runtimeSessionId: owner.id });
    expect(await findThreadSession(database.prisma, KEY)).toEqual({
      runtimeSessionId: owner.id,
      relationship: "thread",
    });
  });

  test("ignores registrations owned by closed sessions", async () => {
    database = await createTestDatabase();
    const owner = await session(database.prisma, "thread-closed");
    await registerThread(database.prisma, { ...KEY, runtimeSessionId: owner.id });
    await database.prisma.runtimeSession.update({
      where: { id: owner.id },
      data: { status: "closed" },
    });
    expect(await findThreadSession(database.prisma, KEY)).toBeNull();
  });

  test("registration is idempotent", async () => {
    database = await createTestDatabase();
    const owner = await session(database.prisma, "thread-idempotent");
    await registerThread(database.prisma, { ...KEY, runtimeSessionId: owner.id });
    await registerThread(database.prisma, { ...KEY, runtimeSessionId: owner.id });
    const links = await database.prisma.runtimeSessionResourceLink.findMany({
      where: { externalId: KEY.threadRootCommentId, endedAt: null },
    });
    expect(links).toHaveLength(1);
  });
});
