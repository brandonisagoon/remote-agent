import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { createTestDatabase } from "../test-support/db.ts";
import { testConfig } from "../test-support/config.ts";
import { deployLocked, type DeployContext } from "./deploy.ts";
import { installLayout } from "./paths.ts";
import { runOrThrow } from "./run.ts";
import { syncTree } from "./sync-tree.ts";
import { readToolingDeploymentState } from "./tooling-deployment.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(failure: "build" | "health" | "restart") {
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
  const sql = async (query: string) => {
    const client = createClient({ url: db.databaseUrl });
    try { return await client.execute(query); } finally { client.close(); }
  };
  const events: string[] = [], logs: string[] = [];
  const context: DeployContext = {
    config: testConfig({ installRoot: root, databaseUrl: db.databaseUrl, serviceName: "isolated-deploy-fixture" }),
    layout, branch: "main", health: "http://127.0.0.1:1/unused", bun: "synthetic-bun",
    databasePath: db.databaseUrl.slice(5), snapshot: null, serverStartedSinceSnapshot: false,
    definition: { label: "isolated-deploy-fixture", command: [], workingDirectory: layout.app, environment: {}, logFile: layout.serviceLog },
    log: line => logs.push(line),
    effects: {
      run: async (exe, args, options) => {
        if (exe === "git") return args.includes("fetch") ? "" : runOrThrow(exe, args, options);
        const candidate = readFileSync(path.join(layout.app, "candidate.txt"), "utf8");
        if (args.includes("migrate")) {
          events.push(`migrate:${candidate}`);
          if (candidate === "target") await sql('CREATE TABLE CandidateMigration (value TEXT)');
          else expect((await sql("SELECT name FROM sqlite_master WHERE name = 'CandidateMigration'")).rows).toHaveLength(0);
        }
        if (candidate === "target" && args.includes("tsc") && failure === "build") throw new Error("synthetic build failure");
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
  return { context, events, logs, db, sql, previous, target, git };
}

test("a pre-start build failure restores a selected database and restarts the previous compatible server", async () => {
  const f = await fixture("build");
  expect(await deployLocked(f.context, true)).toBe("failed");
  expect(f.events).toEqual(["stop", "migrate:target", "stop", "stop", "migrate:previous", "restart:previous"]);
  expect(f.git("rev-parse", "HEAD")).toBe(f.previous);
  expect((await readToolingDeploymentState(f.db.databaseUrl)).selections[0]?.generation).toBe(1);
  expect(f.logs.some(line => line.includes(`restored ${f.previous}`))).toBe(true);
}, 60_000);

for (const failure of ["health", "restart"] as const) test(`${failure} failure after startup preserves admitted history and reports rollback refusal`, async () => {
  const f = await fixture(failure);
  expect(await deployLocked(f.context, true)).toBe("failed");
  expect(f.events).toEqual(["stop", "migrate:target", "restart:target"]);
  expect(f.git("rev-parse", "HEAD")).toBe(f.target);
  expect((await readToolingDeploymentState(f.db.databaseUrl)).selections[0]?.generation).toBe(2);
  expect((await f.sql("SELECT name FROM sqlite_master WHERE name = 'CandidateMigration'")).rows).toHaveLength(1);
  expect(f.logs.some(line => line.includes("ROLLBACK REFUSED") && line.includes("manual coordinated recovery"))).toBe(true);
}, 60_000);
