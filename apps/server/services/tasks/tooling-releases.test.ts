import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, type ServerConfig } from "../../../../lib/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { acquirePreparationLock, prepareToolingRelease, verifyPreparedToolingRelease, type PrepareToolingReleaseInput } from "./tooling.ts";
import { activateToolingRelease, assertBootToolingPolicy, bindToolingOperation, bootToolingSelections, canonicalDigest, getActiveToolingRelease, readToolingOperation } from "./tooling-releases.ts";

const REPO = "your-repository";
let db: TestDatabase, root: string, source: string, config: ServerConfig;
const revisions: Record<string, string> = {};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fakeInstall = async (checkout: string) => {
  mkdirSync(path.join(checkout, "node_modules", "local-dep"), { recursive: true });
  writeFileSync(path.join(checkout, "node_modules", "local-dep", "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0" }));
};
const prepare = (input: PrepareToolingReleaseInput) => prepareToolingRelease(input, fakeInstall);
const release = (formats: object = { "drafted.runtime": { read: [1], write: 1, preservesUnknown: false } }, protocol = { min: 1, max: 1 }) =>
  JSON.stringify({ contract: "remote-agent.tooling-release/v1", serverProtocol: protocol, stateFormats: formats });

function commit(name: string, files: Record<string, string | null>) {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) rmSync(path.join(source, file));
    else { mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); writeFileSync(path.join(source, file), content); }
  }
  git(source, "add", "-A"); git(source, "commit", "-qm", name);
  revisions[name] = git(source, "rev-parse", "HEAD");
}

beforeEach(async () => {
  db = await createTestDatabase();
  root = mkdtempSync(path.join(tmpdir(), "tooling-release-"));
  source = path.join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main"); git(source, "config", "user.email", "t@example.com"); git(source, "config", "user.name", "T");
  commit("A", { ".gitignore": "node_modules\n", "bun.lock": "{\"lockfileVersion\":1}\n", "package.json": "{\"name\":\"tooling\"}\n",
    ".remote-agent.config.json": "{}\n", ".remote-agent-capabilities.json": JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "cli.ts" } } }),
    "runtime.md": "runtime\n", "cli.ts": "console.log('a')\n", ".remote-agent-release.json": release() });
  commit("B", { "cli.ts": "console.log('b')\n" });
  commit("C", { ".remote-agent.config.json": "{\"preparation\":\"agent\"}\n" });
  git(source, "checkout", "-q", revisions.B!);
  commit("legacy", { ".remote-agent-release.json": null });
  git(source, "checkout", "-q", revisions.B!);
  commit("protocol2", { ".remote-agent-release.json": release(undefined, { min: 2, max: 2 }) });
  git(source, "checkout", "-q", revisions.B!);
  commit("v2", { ".remote-agent-release.json": release({ "drafted.runtime": { read: [1, 2], write: 2, preservesUnknown: true } }) });
  git(source, "checkout", "-q", revisions.B!);
  commit("v2only", { ".remote-agent-release.json": release({ "drafted.runtime": { read: [2], write: 2, preservesUnknown: true } }) });
  git(source, "checkout", "-q", "main");
  const base = testConfig();
  const repository = { ...base.repositories[base.activeRepositoryId]!, id: REPO, tooling: { root: source, revision: revisions.A!, policyBlob: git(source, "rev-parse", `${revisions.A}:.remote-agent.config.json`) } };
  config = testConfig({ installRoot: path.join(root, "install"), repository, repositories: { [REPO]: repository }, activeRepositoryId: REPO });
});
afterEach(async () => { await db.cleanup(); rmSync(root, { recursive: true, force: true }); });

const activate = (requestKey: string, name: string, expectedGeneration: number) =>
  activateToolingRelease({ prisma: db.prisma, config, repositoryId: REPO, requestKey, revision: revisions[name]!, expectedGeneration }, { prepare });

async function ownedTask(id = "task-1") {
  await db.prisma.runtimeSession.create({ data: { id: `${id}-primary`, scopeKey: `${id}-scope`, agentCommand: "codex", repositoryId: REPO, machineId: config.machine, role: "primary", cwd: `/tmp/${id}`, status: "idle" } });
  return db.prisma.remoteTask.create({ data: { id, requestKey: id, repositoryId: REPO, machineId: config.machine, branchName: id, toolingRoot: source, toolingRevision: revisions.A!, primarySessionId: `${id}-primary`, worktreePath: `/tmp/${id}` } });
}

test("activation is idempotent per request key, survives lost acknowledgement and rejects reuse", async () => {
  const first = await activate("k1", "A", 0);
  expect(first.generation).toBe(1);
  expect(first.release.revision).toBe(revisions.A!);
  expect(first.release.checkout).toBe(path.join(config.installRoot, "tooling", REPO, revisions.A!).replace(/^\/var\//, "/private/var/"));
  expect(git(source, "worktree", "list", "--porcelain")).toContain("locked remote-agent tooling release");
  expect((await activate("k2", "B", 1)).generation).toBe(2);
  // Acknowledgement of k1 was lost: its retry returns the original result.
  expect(await activate("k1", "A", 0)).toEqual(first);
  await expect(activate("k1", "B", 0)).rejects.toMatchObject({ code: "request-conflict" });
  await expect(activate("k3", "A", 1)).rejects.toMatchObject({ code: "generation-conflict" });
  expect((await getActiveToolingRelease({ prisma: db.prisma, config, repositoryId: REPO }))?.generation).toBe(2);
});

test("two different requests for the same expected generation cannot both win", async () => {
  const results = await Promise.allSettled([activate("race-a", "A", 0), activate("race-b", "B", 0)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const selection = await getActiveToolingRelease({ prisma: db.prisma, config, repositoryId: REPO });
  expect(selection?.generation).toBe(1);
  expect(await db.prisma.toolingActivation.count()).toBe(1);
});

test("failed candidates leave the active selection unchanged", async () => {
  const active = await activate("k1", "A", 0);
  await expect(activate("legacy", "legacy", 1)).rejects.toMatchObject({ code: "preparation-failed" });
  await expect(activate("protocol", "protocol2", 1)).rejects.toMatchObject({ code: "preparation-failed" });
  await expect(activateToolingRelease({ prisma: db.prisma, config, repositoryId: REPO, requestKey: "ref", revision: "main", expectedGeneration: 1 }, { prepare })).rejects.toMatchObject({ code: "invalid-request" });
  await prepare({ repositoryId: REPO, toolingRoot: source, installRoot: config.installRoot, revision: revisions.B! });
  writeFileSync(path.join(config.installRoot, "tooling", REPO, revisions.B!, "cli.ts"), "tampered\n");
  await expect(activate("dirty", "B", 1)).rejects.toMatchObject({ code: "preparation-failed" });
  await expect(activateToolingRelease({ prisma: db.prisma, config, repositoryId: REPO, requestKey: "install", revision: revisions.v2!, expectedGeneration: 1 },
    { prepare: input => prepareToolingRelease(input, async () => { throw new Error("install failed"); }) })).rejects.toMatchObject({ code: "preparation-failed" });
  expect(existsSync(path.join(config.installRoot, "tooling", REPO, `${revisions.v2}.lock`))).toBeFalse();
  expect(await getActiveToolingRelease({ prisma: db.prisma, config, repositoryId: REPO })).toEqual(active);
  expect(await db.prisma.toolingActivation.count()).toBe(1);
});

test("install integrity is verified against its receipt", async () => {
  const prepared = await prepare({ repositoryId: REPO, toolingRoot: source, installRoot: config.installRoot, revision: revisions.A! });
  await verifyPreparedToolingRelease(prepared);
  writeFileSync(path.join(prepared.checkout, "node_modules", "local-dep", "package.json"), JSON.stringify({ name: "local-dep", version: "6.6.6" }));
  await expect(verifyPreparedToolingRelease(prepared)).rejects.toThrow("dependencies changed");
  await expect(prepare({ repositoryId: REPO, toolingRoot: source, installRoot: config.installRoot, revision: revisions.A! })).rejects.toThrow("dependencies changed");
});

test("policy changes require restart and boot promotes them from the exact commit, not the moving ref", async () => {
  await activate("k1", "A", 0);
  await expect(activate("policy", "C", 1)).rejects.toMatchObject({ code: "restart-required", detail: { generation: 2 } });
  await expect(activate("policy", "C", 1)).rejects.toMatchObject({ code: "restart-required" });
  await expect(activate("other", "B", 1)).rejects.toMatchObject({ code: "pending-restart" });
  expect((await getActiveToolingRelease({ prisma: db.prisma, config, repositoryId: REPO }))?.release.revision).toBe(revisions.A!);

  const selected = await bootToolingSelections({ prisma: db.prisma, configuredRepositoryIds: [REPO] });
  expect(selected).toEqual({ [REPO]: revisions.C! });
  expect((await activate("policy", "C", 1)).generation).toBe(2);

  // Restart: the configured ref no longer resolves, yet policy comes from C.
  const file = path.join(root, "remote-agent.config.json");
  const example = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../remote-agent.config.example.json"), "utf8"));
  example.repositories[REPO] = { ...example.repositories[REPO], root: path.join(root, "product"), tooling: { root: source, ref: "refs/heads/does-not-exist" } };
  writeFileSync(file, JSON.stringify(example));
  const restarted = readConfig(file, { toolingRevisions: selected });
  expect(restarted.repositories[REPO]!.tooling?.revision).toBe(revisions.C!);
  expect(restarted.repositories[REPO]!.preparation).toBe("agent");
  await assertBootToolingPolicy({ prisma: db.prisma, config: restarted });
  expect(() => readConfig(file)).toThrow();
});

test("a pending activation whose checkout no longer verifies stays pending", async () => {
  await activate("k1", "A", 0);
  await expect(activate("policy", "C", 1)).rejects.toMatchObject({ code: "restart-required" });
  writeFileSync(path.join(config.installRoot, "tooling", REPO, revisions.C!, "runtime.md"), "tampered\n");
  const logs: string[] = [];
  expect(await bootToolingSelections({ prisma: db.prisma, configuredRepositoryIds: [REPO], log: message => logs.push(message) })).toEqual({ [REPO]: revisions.A! });
  expect(logs.join("\n")).toContain("remains pending");
  expect(await db.prisma.toolingPendingActivation.count()).toBe(1);
});

test("operation bindings persist before effects and retries keep their original release", async () => {
  const task = await ownedTask();
  const request = { requestKey: "op-1", inputDigest: canonicalDigest({ b: 2, a: 1 }), kind: "compute-start", existingOperationId: "offer-1" };
  expect(canonicalDigest({ a: 1, b: 2 })).toBe(request.inputDigest);
  const bind = (overrides: object = {}) => bindToolingOperation({ prisma: db.prisma, config, taskId: task.id, sessionId: task.primarySessionId!, turnId: "turn-1", request: { ...request, ...overrides } });
  await expect(bind()).rejects.toMatchObject({ code: "no-active-release" });
  await activate("k1", "A", 0);
  const first = await bind();
  expect(first).toMatchObject({ contract: "remote-agent.tooling-operation/v1", generation: 1, status: "bound", turnId: "turn-1", existingOperationId: "offer-1", release: { revision: revisions.A } });
  await activate("k2", "B", 1);
  expect(await bind()).toEqual(first);
  expect(await readToolingOperation({ prisma: db.prisma, operationId: first.operationId })).toEqual(first);
  await expect(bind({ inputDigest: canonicalDigest({ other: true }) })).rejects.toMatchObject({ code: "request-conflict" });
  const second = await bind({ requestKey: "op-2" });
  expect(second).toMatchObject({ generation: 2, release: { revision: revisions.B } });
  const concurrent = await Promise.all([bind({ requestKey: "op-3" }), bind({ requestKey: "op-3" })]);
  expect(concurrent[0].operationId).toBe(concurrent[1].operationId);
  await ownedTask("task-2");
  await expect(bindToolingOperation({ prisma: db.prisma, config, taskId: task.id, sessionId: "task-2-primary", turnId: null, request })).rejects.toMatchObject({ code: "ownership" });
  expect(await readToolingOperation({ prisma: db.prisma, operationId: "missing" })).toBeNull();
});

test("state formats are checked against durable retained consumers", async () => {
  const task = await ownedTask();
  await activate("k1", "A", 0);
  const operation = await bindToolingOperation({ prisma: db.prisma, config, taskId: task.id, sessionId: task.primarySessionId!, turnId: null, request: { requestKey: "op", inputDigest: "a".repeat(64), kind: "runtime-up" } });
  await expect(activate("v2only", "v2only", 1)).rejects.toMatchObject({ code: "state-format-incompatible" });
  await expect(activate("v2", "v2", 1)).rejects.toMatchObject({ code: "state-format-incompatible" });
  await db.prisma.toolingOperation.update({ where: { id: operation.operationId }, data: { status: "completed" } });
  await expect(activate("v2only-again", "v2only", 1)).rejects.toMatchObject({ code: "state-format-incompatible" });
  expect((await activate("v2-again", "v2", 1)).generation).toBe(2);
});

test("preparation locks are recovered only from provably exited owners", () => {
  const destination = path.join(root, "install", "tooling", REPO, "x");
  mkdirSync(path.dirname(destination), { recursive: true });
  mkdirSync(`${destination}.lock`);
  expect(() => acquirePreparationLock(destination)).toThrow("live or unproven");
  writeFileSync(path.join(`${destination}.lock`, "owner.json"), JSON.stringify({ version: 1, pid: 999_999, attempt: crypto.randomUUID(), startedAt: "then" }));
  expect(() => acquirePreparationLock(destination, () => true)).toThrow("live or unproven");
  const release = acquirePreparationLock(destination, () => false);
  expect(readdirSync(path.dirname(destination)).some(name => name.startsWith("x.lock-abandoned-"))).toBeTrue();
  expect(() => acquirePreparationLock(destination)).toThrow("live or unproven");
  release();
  expect(existsSync(`${destination}.lock`)).toBeFalse();
});
