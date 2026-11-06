import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, type ServerConfig } from "../../../../lib/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { acquirePreparationLock, prepareToolingRelease, verifyPreparedToolingRelease, type PrepareToolingReleaseInput } from "./tooling.ts";
import { activateToolingRelease, assertBootToolingPolicy, assertToolingStateReadable, bindToolingOperation, bootToolingSelections, canonicalDigest, getActiveToolingRelease, readToolingLegacyBoundary,
  readToolingLegacyConsumer, readToolingOperation, readToolingStateVersion, registerToolingStateWrite, resolveToolingLegacyConsumer, transitionToolingOperation,
  type ToolingLegacyConsumerInput } from "./tooling-releases.ts";

// Real Git repositories and SQLite fixtures; keep hooks reliable on a loaded host.
setDefaultTimeout(120_000);
const REPO = "your-repository";
let db: TestDatabase, root: string, source: string, config: ServerConfig, legacy: ToolingLegacyConsumerInput[];
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
  git(source, "checkout", "-q", revisions.B!);
  commit("noformats", { ".remote-agent-release.json": release({}) });
  git(source, "checkout", "-q", "main");
  legacy = [];
  const base = testConfig();
  const repository = { ...base.repositories[base.activeRepositoryId]!, id: REPO, tooling: { root: source, revision: revisions.A!, policyBlob: git(source, "rev-parse", `${revisions.A}:.remote-agent.config.json`) } };
  config = testConfig({ installRoot: path.join(root, "install"), repository, repositories: { [REPO]: repository }, activeRepositoryId: REPO });
});
afterEach(async () => { await db.cleanup(); rmSync(root, { recursive: true, force: true }); });

const activate = (requestKey: string, name: string, expectedGeneration: number) =>
  activateToolingRelease({ prisma: db.prisma, config, repositoryId: REPO, requestKey, revision: revisions[name]!, expectedGeneration }, { prepare, inventoryLegacyConsumers: async () => legacy });
const evidence = { kind: "compute-claim", reference: "offer-1" };

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

test("a policy change is rejected without queuing, and restart never activates it", async () => {
  await activate("k1", "A", 0);
  await expect(activate("policy", "C", 1)).rejects.toMatchObject({ code: "restart-required", detail: { generation: 1 } });
  await expect(activate("policy", "C", 1)).rejects.toMatchObject({ code: "restart-required" });
  await expect(activate("policy", "B", 1)).rejects.toMatchObject({ code: "request-conflict" });
  expect((await activate("k2", "B", 1)).generation).toBe(2);
  const before = await db.prisma.toolingSelection.findMany();
  const selected = await bootToolingSelections({ prisma: db.prisma, configuredRepositoryIds: [REPO] });
  expect(selected).toEqual({ [REPO]: revisions.B! });
  expect(await db.prisma.toolingSelection.findMany()).toEqual(before);

  // Restart: the configured ref no longer resolves; policy comes from B.
  const file = path.join(root, "remote-agent.config.json");
  const example = JSON.parse(readFileSync(path.join(import.meta.dir, "../../../../remote-agent.config.example.json"), "utf8"));
  example.repositories[REPO] = { ...example.repositories[REPO], root: path.join(root, "product"), tooling: { root: source, ref: "refs/heads/does-not-exist" } };
  writeFileSync(file, JSON.stringify(example));
  const restarted = readConfig(file, { toolingRevisions: selected });
  expect(restarted.repositories[REPO]!.tooling?.revision).toBe(revisions.B!);
  expect(restarted.repositories[REPO]!.preparation).not.toBe("agent");
  await assertBootToolingPolicy({ prisma: db.prisma, config: restarted });
  expect(() => readConfig(file)).toThrow();
  await expect(activate("policy", "C", 1)).rejects.toMatchObject({ code: "restart-required" });
});

test("boot is read-only and refuses a selected checkout that no longer verifies", async () => {
  await activate("k1", "A", 0);
  writeFileSync(path.join(config.installRoot, "tooling", REPO, revisions.A!, "runtime.md"), "tampered\n");
  const before = await db.prisma.toolingSelection.findMany();
  await expect(bootToolingSelections({ prisma: db.prisma, configuredRepositoryIds: [REPO] })).rejects.toThrow("failed verification");
  expect(await db.prisma.toolingSelection.findMany()).toEqual(before);
  expect(await bootToolingSelections({ prisma: db.prisma, configuredRepositoryIds: [] })).toEqual({});
});

test("first activation atomically records a stable boundary and exact legacy inventory", async () => {
  await expect(activateToolingRelease({ prisma: db.prisma, config, repositoryId: REPO, requestKey: "k0", revision: revisions.A!, expectedGeneration: 0 }, { prepare }))
    .rejects.toMatchObject({ code: "legacy-inventory-unavailable" });
  legacy = [{ taskId: "task-1", consumerKind: "compute-environment", consumerId: "env-1", provenance: { revision: revisions.A!, checkout: "/old/checkout", receipt: { adapterSha256: "x" } } },
    { taskId: "task-1", consumerKind: "compute-environment", consumerId: "env-1", provenance: { unavailable: "dup" } }];
  await expect(activate("k0", "A", 0)).rejects.toMatchObject({ code: "invalid-request" });
  expect(await db.prisma.toolingLegacyBoundary.count() + await db.prisma.toolingLegacyConsumer.count() + await db.prisma.toolingSelection.count()).toBe(0);
  legacy = [legacy[0]!, { taskId: "task-2", consumerKind: "cleanup-instruction", consumerId: "cleanup:1", provenance: { unavailable: "No recorded executable receipt" } }];
  await activate("k1", "A", 0);
  const boundary = await readToolingLegacyBoundary({ prisma: db.prisma, repositoryId: REPO });
  expect(boundary).toMatchObject({ activationRequestKey: "k1", legacyRevision: revisions.A });
  legacy = [{ taskId: "task-3", consumerKind: "compute-environment", consumerId: "env-late", provenance: { unavailable: "must not be recorded" } }];
  await activate("k2", "B", 1);
  await activate("k3", "A", 2);
  expect(await readToolingLegacyBoundary({ prisma: db.prisma, repositoryId: REPO })).toEqual(boundary);
  const read = (consumerKind: string, consumerId: string) => readToolingLegacyConsumer({ prisma: db.prisma, repositoryId: REPO, consumerKind, consumerId });
  const exact = await read("compute-environment", "env-1");
  expect(exact).toMatchObject({ status: "legacy", taskId: "task-1", revision: revisions.A, checkout: "/old/checkout", receipt: { adapterSha256: "x" } });
  expect(await read("cleanup-instruction", "cleanup:1")).toMatchObject({ status: "unavailable", detail: "No recorded executable receipt" });
  expect(await read("compute-environment", "env-late")).toEqual({ status: "not-legacy", boundaryRequestKey: "k1" });
  expect(await readToolingLegacyConsumer({ prisma: db.prisma, repositoryId: "other", consumerKind: "compute-environment", consumerId: "env-1" })).toEqual({ status: "no-boundary" });
  await expect(resolveToolingLegacyConsumer({ prisma: db.prisma, id: (exact as { id: string }).id, evidence: { kind: "", reference: "" } })).rejects.toMatchObject({ code: "evidence-required" });
  await resolveToolingLegacyConsumer({ prisma: db.prisma, id: (exact as { id: string }).id, evidence });
  expect(await read("compute-environment", "env-1")).toMatchObject({ status: "resolved", resolution: evidence });
  await expect(resolveToolingLegacyConsumer({ prisma: db.prisma, id: (exact as { id: string }).id, evidence })).rejects.toMatchObject({ code: "transition-conflict" });
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

test("operation lifecycle transitions are explicit compare-and-swap changes", async () => {
  const task = await ownedTask();
  await activate("k1", "A", 0);
  const op = await bindToolingOperation({ prisma: db.prisma, config, taskId: task.id, sessionId: task.primarySessionId!, turnId: null, request: { requestKey: "op", inputDigest: "a".repeat(64), kind: "runtime-up" } });
  const move = (from: "bound" | "running" | "unknown" | "completed", to: "bound" | "running" | "unknown" | "completed", proof?: typeof evidence) => transitionToolingOperation({ prisma: db.prisma, operationId: op.operationId, from, to, ...(proof ? { evidence: proof } : {}) });
  await expect(move("bound", "unknown")).rejects.toMatchObject({ code: "invalid-transition" });
  expect((await move("bound", "running")).status).toBe("running");
  await expect(move("bound", "running")).rejects.toMatchObject({ code: "transition-conflict" });
  expect((await move("running", "unknown")).status).toBe("unknown");
  await expect(move("unknown", "running")).rejects.toMatchObject({ code: "invalid-transition" });
  await expect(move("unknown", "completed")).rejects.toMatchObject({ code: "evidence-required" });
  expect((await move("unknown", "completed", evidence)).status).toBe("completed");
  await expect(move("completed", "running")).rejects.toMatchObject({ code: "invalid-transition" });
  expect(await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: op.operationId } })).toMatchObject({ status: "completed", completionEvidence: evidence });
  await expect(transitionToolingOperation({ prisma: db.prisma, operationId: "missing", from: "bound", to: "running" })).rejects.toMatchObject({ code: "not-found" });
});

test("actual written formats outlive completed operations and block rollback readers", async () => {
  const task = await ownedTask();
  await activate("k1", "A", 0);
  expect((await activate("k2", "v2", 1)).generation).toBe(2);
  const op = await bindToolingOperation({ prisma: db.prisma, config, taskId: task.id, sessionId: task.primarySessionId!, turnId: null, request: { requestKey: "op", inputDigest: "a".repeat(64), kind: "runtime-up" } });
  const write = (version: number, operationId = op.operationId, scopeKey = "runtime:development") => registerToolingStateWrite({ prisma: db.prisma, operationId, family: "drafted.runtime", scopeKey, version });
  await expect(write(1)).rejects.toMatchObject({ code: "wrong-write-version" });
  await expect(registerToolingStateWrite({ prisma: db.prisma, operationId: op.operationId, family: "drafted.other", scopeKey: "x", version: 1 })).rejects.toMatchObject({ code: "undeclared-format" });
  const written = await write(2);
  expect(await write(2)).toEqual(written);
  expect(await readToolingStateVersion({ prisma: db.prisma, taskId: task.id, family: "drafted.runtime", scopeKey: "runtime:development" })).toMatchObject({ version: 2, preservesUnknown: true });
  await transitionToolingOperation({ prisma: db.prisma, operationId: op.operationId, from: "bound", to: "completed", evidence });
  await expect(write(2, op.operationId, "runtime:review")).rejects.toMatchObject({ code: "operation-closed" });
  // A(v1) -> v2 writes -> B(v1 only) must not roll back after the writer completed.
  await expect(activate("rollback", "B", 2)).rejects.toMatchObject({ code: "state-format-incompatible" });
  await expect(activate("missing", "noformats", 2)).rejects.toMatchObject({ code: "state-format-incompatible" });
  expect((await getActiveToolingRelease({ prisma: db.prisma, config, repositoryId: REPO }))?.release.revision).toBe(revisions.v2!);
  expect((await activate("forward", "v2only", 2)).generation).toBe(3);
  const later = await bindToolingOperation({ prisma: db.prisma, config, taskId: task.id, sessionId: task.primarySessionId!, turnId: null, request: { requestKey: "later", inputDigest: "b".repeat(64), kind: "runtime-up" } });
  expect(await assertToolingStateReadable({ prisma: db.prisma, operationId: later.operationId, family: "drafted.runtime", scopeKey: "runtime:development" })).toEqual({ version: 2, source: "recorded" });
  // Untouched pre-protocol state is assumed legacy v1, which v2only cannot read.
  await expect(assertToolingStateReadable({ prisma: db.prisma, operationId: later.operationId, family: "drafted.runtime", scopeKey: "runtime:review" })).rejects.toMatchObject({ code: "unreadable-state" });
});

test("incompatible writes are deferred only for the affected task state", async () => {
  const first = await ownedTask(), second = await ownedTask("task-2");
  legacy = [{ taskId: first.id, consumerKind: "compute-environment", consumerId: "env-1", provenance: { revision: revisions.A!, checkout: "/old", receipt: null } }];
  await activate("k1", "A", 0);
  const old = await bindToolingOperation({ prisma: db.prisma, config, taskId: second.id, sessionId: second.primarySessionId!, turnId: null, request: { requestKey: "old", inputDigest: "c".repeat(64), kind: "runtime-up", resourceKey: "runtime:review" } });
  await expect(activate("v2only", "v2only", 1)).rejects.toMatchObject({ code: "state-format-incompatible" });
  expect((await activate("k2", "v2", 1)).generation).toBe(2);
  const bind = (task: typeof first, requestKey: string) => bindToolingOperation({ prisma: db.prisma, config, taskId: task.id, sessionId: task.primarySessionId!, turnId: null, request: { requestKey, inputDigest: "d".repeat(64), kind: "runtime-up" } });
  const onFirst = await bind(first, "new"), onSecond = await bind(second, "new");
  const write = (operationId: string, scopeKey: string) => registerToolingStateWrite({ prisma: db.prisma, operationId, family: "drafted.runtime", scopeKey, version: 2 });
  await expect(write(onFirst.operationId, "runtime:development")).rejects.toMatchObject({ code: "deferred" });
  expect((await write(onSecond.operationId, "runtime:development")).version).toBe(2);
  await expect(write(onSecond.operationId, "runtime:review")).rejects.toMatchObject({ code: "deferred" });
  await transitionToolingOperation({ prisma: db.prisma, operationId: old.operationId, from: "bound", to: "completed", evidence });
  expect((await write(onSecond.operationId, "runtime:review")).version).toBe(2);
  const consumer = await readToolingLegacyConsumer({ prisma: db.prisma, repositoryId: REPO, consumerKind: "compute-environment", consumerId: "env-1" });
  await resolveToolingLegacyConsumer({ prisma: db.prisma, id: (consumer as { id: string }).id, evidence });
  expect((await write(onFirst.operationId, "runtime:development")).version).toBe(2);
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
