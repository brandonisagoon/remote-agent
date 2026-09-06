import { afterEach, describe, expect, test } from "bun:test";

import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import {
  findSessionMirrorBySessionKey,
  updateSessionMirror,
  upsertSessionMirror,
} from "./session-mirror.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

describe("SessionMirror", () => {
  test("records and refreshes a canonical session mirror", async () => {
    database = await createTestDatabase();
    await upsertSessionMirror(database.prisma, {
      sessionKey: "session-1",
      externalId: "linear-1",
      externalRef: "AGENT-1",
      machineId: "macbook-air",
    });
    await updateSessionMirror(database.prisma, {
      sessionKey: "session-1",
      machineId: "macbook-air",
      lastEventId: "event-2",
      lastGeneration: 2,
    });

    expect(
      await findSessionMirrorBySessionKey(database.prisma, {
        sessionKey: "session-1",
      }),
    ).toMatchObject({
      externalId: "linear-1",
      externalRef: "AGENT-1",
      lastEventId: "event-2",
      lastGeneration: 2n,
    });
  });

  test("concurrent claims keep one canonical mirror resource", async () => {
    database = await createTestDatabase();
    const claims = await Promise.all([
      upsertSessionMirror(database.prisma, {
        sessionKey: "session-1",
        externalId: "linear-a",
      }),
      upsertSessionMirror(database.prisma, {
        sessionKey: "session-1",
        externalId: "linear-b",
      }),
    ]);
    expect(new Set(claims.map((claim) => claim.externalId)).size).toBe(1);
  });

  test("subagent mirrors deliberately carry no machine locator", async () => {
    database = await createTestDatabase();
    await upsertSessionMirror(database.prisma, {
      sessionKey: "root:delegate",
      externalId: "linear-subagent",
      machineId: null,
    });
    expect(
      await findSessionMirrorBySessionKey(database.prisma, {
        sessionKey: "root:delegate",
      }),
    ).toMatchObject({ machineId: null });
  });
});
