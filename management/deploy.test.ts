import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase } from "../test-support/db.ts";
import { testConfig } from "../test-support/config.ts";
import { deployLocked, type DeployContext } from "./deploy.ts";
import { installLayout } from "./paths.ts";
import { runOrThrow } from "./run.ts";
import { syncTree } from "./sync-tree.ts";
import { readToolingDeploymentState } from "./tooling-deployment.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(failure: "build" | "health" | "restart", hooks: { beforeBuildFailure?: () => Promise<void> } = {}) {
  const db = await createTestDatabase();
  const root = mkdtempSync(path.join(tmpdir(), "deploy-recovery-"));
  cleanups.push(async () => { await db.cleanup(); rmSync(root, { recursive: true, force: true }); });
  const layout = installLayout(root);
  mkdirSync(path.join(layout.repo, "lib"), { recursive: true });
  mkdirSync(layout.state, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", layout.repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(layout.repo, "lib/tooling-server-protocol.json"), JSON.stringify({ contract: "remote-agent.server-tooling/v1", selectionVersion: 1, operationProtocol: { min: 1, max: 1 } }));
  writeFileSync(path.join(layout.repo, "candidate.txt"), "previous");
  git("add", "."); git("commit", "-qm", "previous"); const previous = git("rev-parse", "HEAD");
  writeFileSync(path.join(layout.repo, "candidate.txt"), "target");
  git("add", "."); git("commit", "-qm", "target"); const target = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", target); git("reset", "--hard", "-q", previous);
  // Real committed migrations and Prisma JSON serialization, not a table stub.
  await db.prisma.toolingRelease.create({ data: { id: "release", repositoryId: "repo", revision: "a".repeat(40), tree: "b".repeat(40), policyBlob: "c".repeat(40), checkout: path.join(root, "tooling"), manifest: { serverProtocol: { min: 1, max: 1 } }, lockfileDigest: "digest", bunVersion: "test" } });
  await db.prisma.toolingSelection.create({ data: { repositoryId: "repo", generation: 1, releaseId: "release", activatedAt: new Date() } });
  await db.prisma.$disconnect();
  // Synchronous bun:sqlite closes immediately, so fixture reads never leave
  // a connection open that the deploy's quiescence proof would (rightly) see.
  const sql = async (query: string) => {
    const connection = new Database(db.databaseUrl.slice(5));
    try {
      const statement = connection.query(query);
      return { rows: /^\s*select/i.test(query) ? statement.all() : (statement.run(), []) };
    } finally { connection.close(); }
  };
  const events: string[] = [], logs: string[] = [];
  const context: DeployContext = {
    config: testConfig({ installRoot: root, databaseUrl: db.databaseUrl, serviceName: "isolated-deploy-fixture" }),
    layout, branch: "main", health: "http://127.0.0.1:1/unused", bun: "synthetic-bun",
    databasePath: db.databaseUrl.slice(5), snapshot: null, serverStartedSinceSnapshot: false, databaseBusyTimeoutMs: 2_000,
    definition: { label: "isolated-deploy-fixture", command: [], workingDirectory: layout.app, environment: {}, logFile: layout.serviceLog },
    log: line => logs.push(line),
    effects: {
      run: async (exe, args, options) => {
        if (exe === "git") return args.includes("fetch") ? "" : runOrThrow(exe, args, options);
        // The SQLite helper always runs as a real Bun child process.
        if (args[1]?.endsWith(`${path.sep}management${path.sep}sqlite-snapshot.ts`)) { events.push(`sqlite:${args[2]}`); return runOrThrow(process.execPath, args, options); }
        const candidate = readFileSync(path.join(layout.app, "candidate.txt"), "utf8");
        if (args.includes("migrate")) {
          events.push(`migrate:${candidate}`);
          if (candidate === "target") await sql('CREATE TABLE CandidateMigration (value TEXT)');
          else expect((await sql("SELECT name FROM sqlite_master WHERE name = 'CandidateMigration'")).rows).toHaveLength(0);
        }
        if (candidate === "target" && args.includes("tsc") && failure === "build") { await hooks.beforeBuildFailure?.(); throw new Error("synthetic build failure"); }
        return "";
      },
      sync: syncTree,
      settle: async () => {},
      supervisor: () => ({
        install: async () => { throw new Error("unexpected install"); }, uninstall: async () => { throw new Error("unexpected uninstall"); }, registered: async () => false,
        stop: async () => { events.push("stop"); },
        restart: async () => {
          events.push(`restart:${readFileSync(path.join(layout.app, "candidate.txt"), "utf8")}`);
          if (failure !== "build") {
            await sql('UPDATE ToolingSelection SET generation = 2');
            if (failure === "restart") throw new Error("restart acknowledgement lost");
          }
        },
      }),
      health: async () => failure === "build",
    },
  };
  return { context, events, logs, db, sql, previous, target, git, root, layout };
}

test("a pre-start build failure restores a selected database and restarts the previous compatible server", async () => {
  const f = await fixture("build");
  expect(await deployLocked(f.context, true)).toBe("failed");
  expect(f.events.filter(event => !event.startsWith("sqlite:"))).toEqual(["stop", "migrate:target", "stop", "stop", "migrate:previous", "restart:previous"]);
  expect(f.git("rev-parse", "HEAD")).toBe(f.previous);
  expect((await readToolingDeploymentState(f.db.databaseUrl)).selections[0]?.generation).toBe(1);
  expect(f.logs.some(line => line.includes(`restored ${f.previous}`))).toBe(true);
}, 60_000);

for (const failure of ["health", "restart"] as const) test(`${failure} failure after startup preserves admitted history and reports rollback refusal`, async () => {
  const f = await fixture(failure);
  expect(await deployLocked(f.context, true)).toBe("failed");
  expect(f.events.filter(event => !event.startsWith("sqlite:"))).toEqual(["stop", "migrate:target", "restart:target"]);
  expect(f.git("rev-parse", "HEAD")).toBe(f.target);
  expect((await readToolingDeploymentState(f.db.databaseUrl)).selections[0]?.generation).toBe(2);
  expect((await f.sql("SELECT name FROM sqlite_master WHERE name = 'CandidateMigration'")).rows).toHaveLength(1);
  expect(f.logs.some(line => line.includes("ROLLBACK REFUSED") && line.includes("candidate server was started") && line.includes("manual coordinated recovery"))).toBe(true);
}, 60_000);

/** Tables visible through SQLite (including a live database's WAL). */
const tablesIn = (file: string) => {
  const db = new Database(file, { readwrite: true, create: false });
  try { return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name); } finally { db.close(); }
};
/** A WAL-mode writer commits and is killed before any checkpoint, as a
 * crashed or force-stopped server can leave its database. */
async function commitInWal(f: Awaited<ReturnType<typeof fixture>>) {
  const file = f.db.databaseUrl.slice(5), script = path.join(f.root, "killed-writer.ts");
  writeFileSync(script, `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]);
db.exec("PRAGMA journal_mode = WAL"); db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE WalEvidence (value TEXT)"); db.exec("INSERT INTO WalEvidence VALUES ('committed before deploy')");
process.kill(process.pid, "SIGKILL");
`);
  Bun.spawnSync([process.execPath, script, file], { env: { PATH: process.env.PATH ?? "" } });
  expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
  // A raw copy of the main file alone would lose the committed row.
  const raw = path.join(f.root, "raw-copy.sqlite");
  copyFileSync(file, raw);
  expect(tablesIn(raw)).not.toContain("WalEvidence");
  return file;
}

test("a pre-start failure restores a snapshot that includes committed WAL data and keeps the replaced database", async () => {
  const f = await fixture("build");
  const file = await commitInWal(f);
  expect(await deployLocked(f.context, true)).toBe("failed");
  expect(f.events.filter(event => !event.startsWith("sqlite:"))).toEqual(["stop", "migrate:target", "stop", "stop", "migrate:previous", "restart:previous"]);
  expect(f.events.filter(event => event.startsWith("sqlite:"))).toEqual(["sqlite:snapshot", "sqlite:restore"]);
  expect(tablesIn(file)).toContain("WalEvidence");
  expect(tablesIn(file)).not.toContain("CandidateMigration");
  const backups = readdirSync(f.layout.backups);
  const snapshot = backups.find(name => name.endsWith(`-${f.target}.sqlite`))!, evidence = backups.find(name => name.endsWith("-pre-restore.sqlite"))!;
  expect(tablesIn(path.join(f.layout.backups, snapshot))).toContain("WalEvidence");
  expect(tablesIn(path.join(f.layout.backups, evidence))).toEqual(expect.arrayContaining(["WalEvidence", "CandidateMigration"]));
  expect(existsSync(path.join(f.layout.backups, `${evidence}-wal`))).toBe(false);
  expect((await readToolingDeploymentState(f.db.databaseUrl)).selections[0]?.generation).toBe(1);
}, 60_000);

/** Another process (POSIX locks are per process) holding the database open,
 * as a server that has not actually stopped would. */
async function holdOpen(f: Awaited<ReturnType<typeof fixture>>, mode: "idle" | "writing" = "idle") {
  const script = path.join(f.root, `holder-${crypto.randomUUID()}.ts`);
  writeFileSync(script, `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]); db.query("SELECT count(*) FROM sqlite_master").get();
if (process.argv[3] === "writing") db.exec("BEGIN IMMEDIATE");
console.log("ready"); await Bun.sleep(120_000); db.close();
`);
  const child = Bun.spawn([process.execPath, script, f.context.databasePath!, mode], { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "" } });
  cleanups.unshift(async () => { child.kill("SIGKILL"); await child.exited; });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("ready");
  return child;
}

test("a connection that is still open refuses the snapshot before any migration", async () => {
  const f = await fixture("build");
  const file = await commitInWal(f);
  await holdOpen(f);
  expect(await deployLocked(f.context, true)).toBe("failed");
  expect(f.events.filter(event => event.startsWith("migrate"))).toEqual([]);
  expect(f.logs.some(line => line.includes("not proven stopped"))).toBe(true);
  expect(statSync(`${file}-wal`).size).toBeGreaterThan(0); // Untouched while the connection is live.
  expect(existsSync(f.layout.backups) ? readdirSync(f.layout.backups).filter(name => name.endsWith(".sqlite")) : []).toEqual([]);
  expect(tablesIn(file)).toContain("WalEvidence");
}, 60_000);

// After the snapshot the database is in rollback-journal mode, where an
// active writer (not an idle reader) is what SQLite locks can prove.
test("a restore with an active writer is refused and reports the stopped service", async () => {
  const f = await fixture("build", { beforeBuildFailure: async () => { await holdOpen(f, "writing"); } });
  await commitInWal(f); // The server's WAL mode, where an idle connection is provable.
  expect(await deployLocked(f.context, true)).toBe("failed");
  expect(f.events.filter(event => !event.startsWith("sqlite:"))).toEqual(["stop", "migrate:target", "stop"]);
  expect(f.logs.some(line => line.includes("ROLLBACK REFUSED — the service is STOPPED") && line.includes("not proven stopped"))).toBe(true);
  expect(tablesIn(f.context.databasePath!)).toContain("CandidateMigration");
  expect(readdirSync(f.layout.backups).filter(name => name.endsWith("-pre-restore.sqlite") || name.includes(".restore-"))).toEqual([]);
  expect(readdirSync(path.dirname(f.context.databasePath!)).filter(name => name.includes(".restore-"))).toEqual([]);
}, 60_000);

test("deploy reaches bun:sqlite only through an explicit Bun child", async () => {
  const source = readFileSync(path.join(import.meta.dir, "deploy.ts"), "utf8");
  expect(source).not.toMatch(/from\s+["'](?:bun:sqlite|\.\/sqlite-snapshot(?:\.ts)?)["']/);
  expect(source).not.toMatch(/import\(\s*["'](?:bun:sqlite|\.\/sqlite-snapshot(?:\.ts)?)["']/);
  const usage = Bun.spawnSync([process.execPath, "--no-env-file", path.join(import.meta.dir, "sqlite-snapshot.ts"), "unknown", "0"], { stdout: "pipe", stderr: "pipe" });
  expect(usage.exitCode).toBe(1);
  expect(usage.stderr.toString()).toContain("Use snapshot");
});
