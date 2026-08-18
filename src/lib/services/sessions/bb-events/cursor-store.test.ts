import { afterEach, describe, expect, test } from "bun:test";

import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { advanceBbEventCursor, getBbEventCursor } from "./cursor-store.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

describe("bb event cursor", () => {
  test("advances monotonically and rejects replay", async () => {
    database = await createTestDatabase();
    expect(await getBbEventCursor(database.prisma, "thr_1")).toBe(0);
    expect(
      await advanceBbEventCursor(database.prisma, {
        bbThreadId: "thr_1",
        seq: 3,
      }),
    ).toBeTrue();
    expect(
      await advanceBbEventCursor(database.prisma, {
        bbThreadId: "thr_1",
        seq: 2,
      }),
    ).toBeFalse();
    expect(await getBbEventCursor(database.prisma, "thr_1")).toBe(3);
  });
});
