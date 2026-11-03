import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabaseDiagnostic } from "./database-diagnostic.ts";

test("a synchronous start survives an operation that never returns; SQL and values stay private", () => {
  const lines: string[] = [];
  const run = createDatabaseDiagnostic("60", (line) => { lines.push(line); });
  void run("execute", "SELECT 'literal-secret' WHERE token = ?", 1, () => {
    expect(lines).toHaveLength(1);
    return new Promise<never>(() => {});
  });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ phase: "start", argumentCount: 1, operation: "execute" });
  expect(JSON.parse(lines[0]!).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(lines.join("")).not.toContain("literal-secret");
  expect(lines.join("")).not.toContain("SELECT");
});

test("off by default and invalid windows do not emit; results and exact errors survive", async () => {
  const lines: string[] = [];
  for (const setting of [undefined, "0", "301", "-1", "1.5", "true"]) {
    const run = createDatabaseDiagnostic(setting, (line) => { lines.push(line); });
    expect(await run("execute", "secret", 0, async () => 42)).toBe(42);
  }
  expect(lines).toEqual([]);
  const run = createDatabaseDiagnostic("1", (line) => { lines.push(line); });
  const failure = new Error("private failure detail");
  await expect(run("execute", "secret", 0, async () => { throw failure; })).rejects.toBe(failure);
  expect(() => run("execute", "secret", 0, () => { throw failure; })).toThrow(failure);
  expect(lines.map((line) => JSON.parse(line).outcome).filter(Boolean)).toEqual(["error", "error"]);
  expect(lines.join("")).not.toContain("private failure detail");
  const brokenSink = createDatabaseDiagnostic("1", () => { throw new Error("sink failed"); });
  await expect(brokenSink("execute", "secret", 0, async () => { throw failure; })).rejects.toBe(failure);
});

test("record/byte limits and the finite window bound output even while operations continue", async () => {
  const lines: string[] = [];
  let time = 0;
  const run = createDatabaseDiagnostic("1", (line) => { lines.push(line); }, () => time);
  let calls = 0;
  for (let index = 0; index < 3_000; index++) {
    await run("execute", "SELECT ?", 1, async () => { calls++; });
  }
  expect(calls).toBe(3_000);
  expect(lines.length).toBeLessThanOrEqual(2_000);
  expect(Buffer.byteLength(lines.join(""))).toBeLessThanOrEqual(512 * 1024);
  const before = lines.length;
  time = 1_000;
  await run("execute", "SELECT ?", 1, async () => { calls++; });
  expect(lines).toHaveLength(before);
  const expiringLines: string[] = [];
  time = 0;
  const expiring = createDatabaseDiagnostic("1", (line) => { expiringLines.push(line); }, () => time);
  await expiring("execute", "SELECT ?", 1, async () => { time = 1_000; });
  expect(expiringLines.map((line) => JSON.parse(line).phase)).toEqual(["start"]);
});

test("the actual Prisma file adapter records queries and BEGIN/COMMIT/ROLLBACK without values", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "db-diagnostic-"));
  try {
    const result = spawnSync(process.execPath, ["-e", `
      import { createPrismaClient } from ${JSON.stringify(path.join(import.meta.dir, "prisma.ts"))};
      const db = createPrismaClient(process.env.DIAGNOSTIC_TEST_DB);
      await db.$executeRawUnsafe("CREATE TABLE Probe (value TEXT)");
      await db.$transaction(async tx => { await tx.$executeRawUnsafe("INSERT INTO Probe VALUES (?)", "parameter-secret"); });
      try { await db.$transaction(async tx => { await tx.$queryRawUnsafe("SELECT 'literal-secret'"); throw new Error("rollback-secret"); }); } catch {}
      console.log(JSON.stringify(await db.$queryRawUnsafe("SELECT COUNT(*) AS count FROM Probe")));
      await db.$disconnect();
    `], {
      env: { ...process.env, REMOTE_AGENT_DB_DIAGNOSTIC_SECONDS: "60", DIAGNOSTIC_TEST_DB: `file:${path.join(directory, "test.sqlite")}` },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[{"count":1}]');
    const events = result.stderr.trim().split("\n").map((line) => JSON.parse(line));
    const starts = events.filter((event) => event.phase === "start");
    expect(starts.length).toBeGreaterThanOrEqual(8);
    for (const sql of ["BEGIN DEFERRED", "COMMIT", "ROLLBACK"]) {
      expect(starts.some((event) => event.fingerprint === createHash("sha256").update(sql).digest("hex"))).toBe(true);
    }
    expect(events.filter((event) => event.phase === "finish")).toHaveLength(starts.length);
    expect(result.stderr).not.toMatch(/parameter-secret|literal-secret|rollback-secret|SELECT|INSERT|Probe/);
    expect(starts.some((event) => event.argumentCount === 1)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("diagnostic file client preserves positional array and named execute arguments", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "db-diagnostic-overloads-"));
  try {
    const result = spawnSync(process.execPath, ["-e", `
      import { DiagnosticPrismaLibSql } from ${JSON.stringify(path.join(import.meta.dir, "database-diagnostic.ts"))};
      const client = new DiagnosticPrismaLibSql({ url: process.env.DIAGNOSTIC_TEST_DB }).createClient({ url: process.env.DIAGNOSTIC_TEST_DB });
      const array = await client.execute("SELECT ? AS value, ? AS other", ["array-secret", 42]);
      const named = await client.execute("SELECT $value AS value", { value: "named-secret" });
      console.log(JSON.stringify([array.rows[0].value === "array-secret", array.rows[0].other === 42, named.rows[0].value === "named-secret"]));
      client.close();
    `], {
      env: { ...process.env, REMOTE_AGENT_DB_DIAGNOSTIC_SECONDS: "60", DIAGNOSTIC_TEST_DB: `file:${path.join(directory, "test.sqlite")}` },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("[true,true,true]");
    const events = result.stderr.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.phase === "start").map((event) => event.argumentCount)).toEqual([2, 1]);
    expect(events.filter((event) => event.phase === "finish").map((event) => event.outcome)).toEqual(["ok", "ok"]);
    expect(result.stderr).not.toMatch(/array-secret|named-secret|SELECT|value|other/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
