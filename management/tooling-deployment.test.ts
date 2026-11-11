import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createClient } from "@libsql/client";
import { assertToolingServerCompatibility, assertToolingSnapshotRestoreSafe, readToolingDeploymentState } from "./tooling-deployment.ts";
import { toolingSelectionCheck } from "./checks.ts";
import type { ServerConfig } from "../lib/config.ts";
import { SERVER_DATA_CONTRACTS } from "../lib/server-data-contracts.ts";
import { SERVER_TOOLING_PROTOCOL } from "../apps/server/services/tasks/tooling.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "tooling-deployment-")); roots.push(root);
  const databaseUrl = `file:${root}/test.sqlite`, client = createClient({ url: databaseUrl });
  await client.batch([
    "CREATE TABLE ToolingSelection (repositoryId TEXT PRIMARY KEY, generation INTEGER, releaseId TEXT)",
    "CREATE TABLE ToolingRelease (id TEXT PRIMARY KEY, revision TEXT, manifest TEXT)",
    "CREATE TABLE ToolingOperation (id TEXT PRIMARY KEY, protocol INTEGER, status TEXT)",
    { sql: "INSERT INTO ToolingRelease VALUES (?, ?, ?)", args: ["a", "a".repeat(40), JSON.stringify({ serverProtocol: { min: 1, max: 1 } })] },
  ]);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "legacy");
  const old = git("rev-parse", "HEAD");
  mkdirSync(path.join(root, "lib"));
  writeFileSync(path.join(root, "lib/tooling-server-protocol.json"), JSON.stringify({ contract: "remote-agent.server-tooling/v1", selectionVersion: 1, operationProtocol: { min: 1, max: 1 } }));
  git("add", "lib/tooling-server-protocol.json"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "release-aware");
  return { root, databaseUrl, client, old, current: git("rev-parse", "HEAD") };
}

test("no-selection databases allow old servers; selected databases refuse old rollback without changing rows", async () => {
  const f = await fixture();
  try {
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.old });
    await f.client.execute("INSERT INTO ToolingSelection VALUES ('repo', 2, 'a')");
    const before = await readToolingDeploymentState(f.databaseUrl);
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.old })).rejects.toThrow("cannot preserve durable tooling selection");
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current });
    await expect(assertToolingSnapshotRestoreSafe(f.databaseUrl)).rejects.toThrow("database rewind refused");
    expect(await readToolingDeploymentState(f.databaseUrl)).toEqual(before);
  } finally { f.client.close(); }
});

test("unfinished operations keep their protocol requirement even without an active selection", async () => {
  const f = await fixture();
  try {
    await f.client.execute("INSERT INTO ToolingOperation VALUES ('uncertain', 2, 'unknown')");
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current })).rejects.toThrow("retained tooling operation protocol");
    await expect(assertToolingSnapshotRestoreSafe(f.databaseUrl)).rejects.toThrow("database rewind refused");
  } finally { f.client.close(); }
});

test("doctor reports differing config refs without changing the durable selection", async () => {
  const f = await fixture();
  try {
    await f.client.execute("INSERT INTO ToolingSelection VALUES ('repo', 3, 'a')");
    const config = { databaseUrl: f.databaseUrl, repositories: { repo: { tooling: { revision: "b".repeat(40) } } } } as unknown as ServerConfig;
    const result = await toolingSelectionCheck(config);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("active generation 3");
    expect((await readToolingDeploymentState(f.databaseUrl)).selections[0]?.revision).toBe("a".repeat(40));
  } finally { f.client.close(); }
});

test("a consumer retains its protocol after its producer completes until physical resolution", async () => {
  const f = await fixture();
  try {
    await f.client.execute("CREATE TABLE ToolingRetainedConsumer (id TEXT PRIMARY KEY, protocol INTEGER, status TEXT)");
    await f.client.execute("INSERT INTO ToolingOperation VALUES ('producer', 2, 'completed')");
    await f.client.execute("INSERT INTO ToolingRetainedConsumer VALUES ('resource', 2, 'pending')");
    expect((await readToolingDeploymentState(f.databaseUrl)).retainedProtocols).toEqual([2]);
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current })).rejects.toThrow("retained tooling operation protocol");
    await f.client.execute("UPDATE ToolingRetainedConsumer SET status = 'confirmed'");
    await expect(assertToolingSnapshotRestoreSafe(f.databaseUrl)).rejects.toThrow("database rewind refused");
    await f.client.execute("UPDATE ToolingRetainedConsumer SET status = 'resolved'");
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current });
    expect((await readToolingDeploymentState(f.databaseUrl)).retainedProtocols).toEqual([]);
  } finally { f.client.close(); }
});

test("missing database is never created and corrupt selection fails closed", async () => {
  const f = await fixture();
  try {
    const absent = path.join(f.root, "absent.sqlite");
    expect(await readToolingDeploymentState(`file:${absent}`)).toEqual({ selections: [], retainedProtocols: [], serverContracts: [] });
    expect(existsSync(absent)).toBe(false);
    await f.client.execute("INSERT INTO ToolingSelection VALUES ('repo', 1, 'missing')");
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current })).rejects.toThrow();
  } finally { f.client.close(); }
});

test("compatibility reads close their WAL connection before the stopped-database snapshot", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tooling-close-")); roots.push(root);
  const databaseUrl = `file:${root}/test.sqlite`;
  // Initialization exits before the read so fixture-library handles cannot
  // masquerade as a leak in the management reader.
  const init = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE ToolingSelection (repositoryId TEXT, generation INTEGER, releaseId TEXT); CREATE TABLE ToolingRelease (id TEXT, revision TEXT, manifest TEXT); CREATE TABLE ToolingOperation (protocol INTEGER, status TEXT)");
    db.query("INSERT INTO ToolingRelease VALUES (?, ?, ?)").run("release", "a".repeat(40), JSON.stringify({serverProtocol:{min:1,max:1}}));
    db.exec("INSERT INTO ToolingSelection VALUES ('repo', 1, 'release')"); db.close();
  `, databaseUrl.slice(5)], { stdout: "pipe", stderr: "pipe" });
  expect(init.exitCode, init.stderr.toString()).toBe(0);
  expect((await readToolingDeploymentState(databaseUrl)).selections).toHaveLength(1);
  const snapshot = path.join(root, "snapshot.sqlite");
  // A separate process is necessary: POSIX database locks are process-wide.
  // No forced collection or wait may stand in for deterministic close.
  const child = Bun.spawnSync([process.execPath, "--no-env-file", path.join(import.meta.dir, "sqlite-snapshot.ts"), "snapshot", databaseUrl.slice(5), snapshot, "0"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(existsSync(snapshot)).toBeTrue();
});

test("committed deployment protocol describes the server's implemented range", () => {
  const marker = JSON.parse(readFileSync(new URL("../lib/tooling-server-protocol.json", import.meta.url), "utf8"));
  expect(marker.operationProtocol).toEqual(SERVER_TOOLING_PROTOCOL);
  expect(marker.serverContracts).toEqual(SERVER_DATA_CONTRACTS);
});

function compatibleReader(f: { root: string }, contracts: string[]) {
  writeFileSync(path.join(f.root, "lib/tooling-server-protocol.json"), JSON.stringify({ contract: "remote-agent.server-tooling/v1", selectionVersion: 1, operationProtocol: { min: 1, max: 3 }, serverContracts: contracts }));
  execFileSync("git", ["-C", f.root, "add", "lib/tooling-server-protocol.json"]);
  execFileSync("git", ["-C", f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "compatible saved-data reader"]);
  return execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

for (const published of [0, 1]) test("typed publication protects pending and delivered retry inputs on rollback: " + published, async () => {
  const f = await fixture();
  try {
    await f.client.execute("CREATE TABLE RuntimeIssueUpdate (input TEXT, published INTEGER)");
    const input = JSON.stringify({ requestKey: "original", body: "original report", publication: { category: "blocker", subject: "operation:original", version: "original-version", code: "PROVIDER_UNAVAILABLE" } });
    await f.client.execute({ sql: "INSERT INTO RuntimeIssueUpdate VALUES (?, ?)", args: [input, published] });
    const before = await readToolingDeploymentState(f.databaseUrl);
    expect(before.serverContracts).toEqual(["task-publication/v1"]);
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current })).rejects.toThrow("cannot read preserved data contracts task-publication/v1");
    const revision = compatibleReader(f, ["task-publication/v1"]);
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision });
    await expect(assertToolingSnapshotRestoreSafe(f.databaseUrl)).rejects.toThrow("database rewind refused");
    expect(await readToolingDeploymentState(f.databaseUrl)).toEqual(before);
    expect((await f.client.execute("SELECT input, published FROM RuntimeIssueUpdate")).rows.map(row => ({ input: row.input, published: row.published }))).toEqual([{ input, published }]);
  } finally { f.client.close(); }
});

for (const kind of ["clerk-assignment", "configuration-completion/v1", "configuration-contract", "runtime-health", "tooling-capability-resolution"] as const) test("saved " + kind + " requires a compatible reader even without selected tooling", async () => {
  const f = await fixture();
  try {
    await f.client.execute("CREATE TABLE RuntimeMetadataEvent (action TEXT, value TEXT)");
    const value = kind === "configuration-contract" ? { boundary: "configuration-only" } : { resources: [{ targets: [{ kind }] }] };
    await f.client.execute({ sql: "INSERT INTO RuntimeMetadataEvent VALUES (?, ?)", args: [kind === "configuration-contract" ? "completion-contract" : ["runtime-health", "tooling-capability-resolution"].includes(kind) ? kind : "finalization-prepared", JSON.stringify(value)] });
    const expected = kind === "clerk-assignment" ? "clerk-assignment/v1" : kind === "runtime-health" ? "runtime-health/v1" : kind === "tooling-capability-resolution" ? "capability-publication/v1" : "configuration-completion/v1";
    expect((await readToolingDeploymentState(f.databaseUrl)).serverContracts).toEqual([expected]);
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current })).rejects.toThrow(expected);
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: compatibleReader(f, [expected]) });
  } finally { f.client.close(); }
});

for (const published of [0, 1]) test(`capability report protects its reader before and after delivery: ${published}`, async () => {
  const f = await fixture();
  try {
    await f.client.execute("CREATE TABLE RuntimeIssueUpdate (input TEXT, published INTEGER)");
    const input = JSON.stringify({ publication: { category: "blocker", subject: { kind: "capability", id: "runtime" }, code: "tooling-capability-unavailable" } });
    await f.client.execute({ sql: "INSERT INTO RuntimeIssueUpdate VALUES (?, ?)", args: [input, published] });
    expect((await readToolingDeploymentState(f.databaseUrl)).serverContracts).toEqual(["capability-publication/v1", "task-publication/v1"]);
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: compatibleReader(f, ["task-publication/v1"]) })).rejects.toThrow("capability-publication/v1");
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: compatibleReader(f, ["task-publication/v1", "capability-publication/v1"]) });
    expect((await f.client.execute("SELECT input FROM RuntimeIssueUpdate")).rows[0]!.input).toBe(input);
  } finally { f.client.close(); }
});

test("registered inactive tooling preserves its declared reader requirement before any new operation", async () => {
  const f = await fixture();
  try {
    await f.client.execute({ sql: "UPDATE ToolingRelease SET manifest = ? WHERE id = 'a'", args: [JSON.stringify({ serverProtocol: { min: 1, max: 1 }, serverContracts: ["clerk-assignment/v1"] })] });
    expect((await readToolingDeploymentState(f.databaseUrl)).serverContracts).toEqual(["clerk-assignment/v1"]);
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current })).rejects.toThrow("clerk-assignment/v1");
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: compatibleReader(f, ["clerk-assignment/v1"]) });
  } finally { f.client.close(); }
});

test("ordinary report text does not claim a typed contract and corrupt inputs fail closed", async () => {
  const f = await fixture();
  try {
    await f.client.execute("CREATE TABLE RuntimeIssueUpdate (input TEXT)");
    await f.client.execute({ sql: "INSERT INTO RuntimeIssueUpdate VALUES (?)", args: [JSON.stringify({ body: "publication: clerk-assignment configuration-completion/v1" })] });
    expect((await readToolingDeploymentState(f.databaseUrl)).serverContracts).toEqual([]);
    await assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.old });
    await f.client.execute("UPDATE RuntimeIssueUpdate SET input = '{broken'");
    await expect(readToolingDeploymentState(f.databaseUrl)).rejects.toThrow();
  } finally { f.client.close(); }
});
