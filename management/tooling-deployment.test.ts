import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createClient } from "@libsql/client";
import { assertToolingServerCompatibility, assertToolingSnapshotRestoreSafe, readToolingDeploymentState } from "./tooling-deployment.ts";
import { toolingSelectionCheck } from "./checks.ts";
import type { ServerConfig } from "../lib/config.ts";
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

test("missing database is never created and corrupt selection fails closed", async () => {
  const f = await fixture();
  try {
    const absent = path.join(f.root, "absent.sqlite");
    expect(await readToolingDeploymentState(`file:${absent}`)).toEqual({ selections: [], retainedProtocols: [] });
    expect(existsSync(absent)).toBe(false);
    await f.client.execute("INSERT INTO ToolingSelection VALUES ('repo', 1, 'missing')");
    await expect(assertToolingServerCompatibility({ databaseUrl: f.databaseUrl, repository: f.root, revision: f.current })).rejects.toThrow();
  } finally { f.client.close(); }
});

test("committed deployment protocol describes the server's implemented range", () => {
  const marker = JSON.parse(readFileSync(new URL("../lib/tooling-server-protocol.json", import.meta.url), "utf8"));
  expect(marker.operationProtocol).toEqual(SERVER_TOOLING_PROTOCOL);
});
