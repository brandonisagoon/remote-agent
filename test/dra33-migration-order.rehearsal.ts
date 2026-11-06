/** Explicit disposable Prisma deployment rehearsal. No server or live DB.
 * bun test ./test/dra33-migration-order.rehearsal.ts
 * Recreates the deployed ledger ordering through Prisma itself, then adds
 * the earlier-named tooling migration without rewriting any history. */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const root = path.resolve(import.meta.dir, "..");
const migrationName = "20261105200000_tooling_release";
const indexName = "20261105203000_metadata_polling_indexes";
const indexChecksum = "08bac435f8a88df49d790230a7e6624adb767319ea20090b6b17b6dc70c6519b";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("Prisma deploy adds an older pending migration without changing the later applied ledger or data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dra33-migration-order-"));
  const migrations = path.join(directory, "migrations");
  const database = path.join(directory, "control.sqlite");
  const config = path.join(directory, "prisma.config.ts");
  const evidence: Record<string, unknown> = { directory, sourceHead: "", migrationName, indexName, indexChecksum, commands: [], passed: false };
  await mkdir(migrations);
  const committed = path.join(root, "prisma", "migrations");
  for (const name of await readdir(committed)) {
    if (name !== migrationName) await cp(path.join(committed, name), path.join(migrations, name), { recursive: true });
  }
  expect(sha(await readFile(path.join(migrations, indexName, "migration.sql")))).toBe(indexChecksum);
  await writeFile(config, `import { defineConfig } from ${JSON.stringify(path.join(root, "node_modules/prisma/config.js"))};\nexport default defineConfig(${JSON.stringify({ schema: path.join(root, "prisma/schema"), migrations: { path: migrations }, datasource: { url: `file:${database}` } })});\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REMOTE_AGENT_") && key !== "DATABASE_URL"));
  const git = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  evidence.sourceHead = (await new Response(git.stdout).text()).trim();
  expect(await git.exited).toBe(0);
  const sourceDigests = async () => Object.fromEntries(await Promise.all([
    "test/dra33-migration-order.rehearsal.ts", "prisma/schema/runtime-session.prisma",
    `prisma/migrations/${migrationName}/migration.sql`, `prisma/migrations/${indexName}/migration.sql`,
    "package.json", "bun.lock",
  ].map(async name => [name, sha(await readFile(path.join(root, name)))])));
  evidence.sourceDigests = await sourceDigests();
  const deploy = async (label: string) => {
    const args = ["node", path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", config];
    const child = Bun.spawn(args, { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      await writeFile(path.join(directory, `${label}.log`), stdout + stderr);
      (evidence.commands as unknown[]).push({ label, args, code });
      expect(code).toBe(0);
    } finally { clearTimeout(timer); }
  };
  // This private fixture connection must be able to initialize WAL files after
  // Prisma closes its last writer; read-only SQLite cannot recreate a missing WAL.
  const query = (sql: string) => { const db = new Database(database); try { return db.query(sql).all(); } finally { db.close(); } };
  try {
    await deploy("before-tooling");
    const before = query('SELECT * FROM "_prisma_migrations" ORDER BY migration_name');
    const index = before.find((row: any) => row.migration_name === indexName) as any;
    expect(index.checksum).toBe(indexChecksum);
    expect(index.finished_at).not.toBeNull();
    expect(before.some((row: any) => row.migration_name === migrationName)).toBe(false);
    const db = new Database(database);
    try {
      expect(db.query('PRAGMA journal_mode=WAL').get()).toEqual({ journal_mode: "wal" });
      db.exec('CREATE TABLE "Dra33PreservedFixture" (id TEXT PRIMARY KEY, value TEXT NOT NULL)'); db.query('INSERT INTO "Dra33PreservedFixture" VALUES (?, ?)').run("retained", "preserve exact data"); } finally { db.close(); }
    await cp(path.join(committed, migrationName), path.join(migrations, migrationName), { recursive: true });
    await deploy("add-earlier-tooling");
    const after = query('SELECT * FROM "_prisma_migrations" ORDER BY migration_name');
    expect(after.filter((row: any) => row.migration_name !== migrationName)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((row: any) => row.migration_name === migrationName) as any;
    expect(added.checksum).toBe(sha(await readFile(path.join(committed, migrationName, "migration.sql"))));
    expect(added.finished_at).not.toBeNull();
    expect(added.rolled_back_at).toBeNull();
    expect(query('SELECT * FROM "Dra33PreservedFixture"')).toEqual([{ id: "retained", value: "preserve exact data" }]);
    const indexes = query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('RuntimeMetadataEvent_action_source_key_sequence_idx', 'finalization_preparation_terminal_state') ORDER BY name");
    expect(indexes).toHaveLength(2);
    expect(query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'Tooling%'" )).toHaveLength(8);
    await deploy("idempotent-replay");
    expect(query('SELECT * FROM "_prisma_migrations" ORDER BY migration_name')).toEqual(after);
    expect(query("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(query("PRAGMA foreign_key_check")).toEqual([]);
    expect(await sourceDigests()).toEqual(evidence.sourceDigests);
    Object.assign(evidence, { passed: true, before, after, indexes, journalMode: "wal", integrityChecked: true, dataPreserved: true, replayUnchanged: true });
  } finally {
    await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ evidence: path.join(directory, "evidence.json"), passed: evidence.passed }));
  }
}, 180_000);
