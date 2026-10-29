import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaLibSql } from "@prisma/adapter-libsql";

import { PrismaClient } from "../../generated/prisma/client.ts";
import { applyPragmas, createPrismaClient } from "./prisma.ts";

let directory: string;
let databaseFile: string;
let prisma: PrismaClient;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "remote-agent-transactions-"));
  databaseFile = path.join(directory, "test.sqlite");
  prisma = createPrismaClient(`file:${databaseFile}`);
  await applyPragmas(prisma);
  await prisma.$executeRawUnsafe("CREATE TABLE Probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
});

afterEach(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

function databaseHandles(): number {
  const names = process.platform === "darwin"
    ? execFileSync("lsof", ["-a", "-p", String(process.pid), "-Fn"], { encoding: "utf8" })
      .split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1))
    : readdirSync("/proc/self/fd").flatMap((fd) => {
      try { return [readlinkSync(`/proc/self/fd/${fd}`)]; }
      catch { return []; } // The descriptor listing itself can close during enumeration.
    });
  return names.filter((name) => [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`].some((file) => name.endsWith(file))).length;
}

test.skipIf(!["darwin", "linux"].includes(process.platform)).each(["import", "require"] as const)(
  "%s adapter keeps database handles bounded across committed and rolled-back transactions without GC",
  async (entrypoint) => {
    if (entrypoint === "require") {
      await prisma.$disconnect();
      const { PrismaLibSql } = createRequire(import.meta.url)("@prisma/adapter-libsql") as typeof import("@prisma/adapter-libsql");
      prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${databaseFile}` }) });
      await applyPragmas(prisma);
    }
    const rollback = new Error("intentional rollback");
    let committed = 0;
    const samples: number[] = [];
    for (let index = 0; index < 200; index++) {
      if (index % 2 === 0) {
        await prisma.$transaction([prisma.$executeRawUnsafe("INSERT INTO Probe (value) VALUES (?)", String(index))]);
        committed++;
      } else {
        await expect(prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("INSERT INTO Probe (value) VALUES (?)", String(index));
          throw rollback;
        })).rejects.toBe(rollback);
      }
      if ([0, 9, 49, 99, 199].includes(index)) samples.push(databaseHandles());
    }
    expect(samples[0]).toBeGreaterThan(0);
    expect(Math.max(...samples) - samples[0]!).toBeLessThanOrEqual(2);
    expect(await prisma.$queryRawUnsafe<{ count: number }[]>("SELECT COUNT(*) AS count FROM Probe")).toEqual([{ count: committed }]);
  },
);

test("outside queries wait for rollback and connection pragmas survive subsequent transactions", async () => {
  const inserted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rollback = new Error("roll back before reading");
  const transaction = prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("INSERT INTO Probe (value) VALUES ('uncommitted')");
    inserted.resolve();
    await release.promise;
    throw rollback;
  });
  const rolledBack = transaction.then(
    () => { throw new Error("Transaction unexpectedly committed"); },
    (error) => { expect(error).toBe(rollback); },
  );
  await inserted.promise;
  let outsideFinished = false;
  const outside = prisma.$queryRawUnsafe("SELECT * FROM Probe").then((rows) => {
    outsideFinished = true;
    return rows;
  });
  try {
    await Bun.sleep(20);
    expect(outsideFinished).toBe(false);
  } finally { release.resolve(); }
  await rolledBack;
  expect(await outside).toEqual([]);
  await prisma.$transaction(async (tx) => { await tx.$queryRawUnsafe("SELECT 1"); });
  expect(await prisma.$queryRawUnsafe<{ foreign_keys: number }[]>("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  expect(await prisma.$queryRawUnsafe<{ timeout: number }[]>("PRAGMA busy_timeout")).toEqual([{ timeout: 5000 }]);
});

test("a failed deferred-constraint commit rolls back before the next transaction uses the connection", async () => {
  await prisma.$executeRawUnsafe("CREATE TABLE Child (parentId INTEGER REFERENCES Probe(id) DEFERRABLE INITIALLY DEFERRED)");
  await expect(prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("INSERT INTO Child VALUES (42)");
  })).rejects.toThrow();
  expect(await prisma.$queryRawUnsafe<{ parentId: number }[]>("SELECT * FROM Child")).toEqual([]);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("INSERT INTO Probe (id, value) VALUES (42, 'valid')");
    await tx.$executeRawUnsafe("INSERT INTO Child VALUES (42)");
  });
  expect(await prisma.$queryRawUnsafe<{ parentId: number }[]>("SELECT * FROM Child")).toEqual([{ parentId: 42 }]);
});

test("an expired transaction releases the connection for later writes", async () => {
  await expect(prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("INSERT INTO Probe (value) VALUES ('expired')");
    await Bun.sleep(60);
  }, { timeout: 20 })).rejects.toThrow();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("INSERT INTO Probe (value) VALUES ('next')");
  });
  expect(await prisma.$queryRawUnsafe<{ value: string }[]>("SELECT value FROM Probe")).toEqual([{ value: "next" }]);
});

test("late calls on a finished transaction cannot change the next transaction", async () => {
  const adapter = await new PrismaLibSql({ url: `file:${databaseFile}` }).connect();
  try {
    const finished = await adapter.startTransaction();
    await finished.commit();
    const next = await adapter.startTransaction();
    try {
      await expect(finished.executeRaw({ sql: "INSERT INTO Probe (value) VALUES ('late')", args: [], argTypes: [] })).rejects.toThrow("closed");
      await finished.rollback();
      await next.executeRaw({ sql: "INSERT INTO Probe (value) VALUES ('next')", args: [], argTypes: [] });
      await next.commit();
    } catch (error) {
      await next.rollback();
      throw error;
    }
  } finally { await adapter.dispose(); }
  expect(await prisma.$queryRawUnsafe<{ value: string }[]>("SELECT value FROM Probe")).toEqual([{ value: "next" }]);
});
