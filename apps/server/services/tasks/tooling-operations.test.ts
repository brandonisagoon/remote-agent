import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import type { AppEnv } from "../../middleware/context.ts";
import type { ToolingReleaseRecord } from "../../../../types/tooling-release.ts";
import { toolingOperationGuard, toolingOperationRoutes } from "../../routes/tasks/tooling-operations.ts";
import {
  FINALIZATION_PREPARED_ACTION, TOOLING_CALLBACKS, TOOLING_OPERATION_HEADER, TOOLING_OPERATION_KINDS, beginSessionToolingOperation, bindServerToolingOperation, currentToolingOperation,
  inLegacyContinuation, matchToolingCallback, producingToolingOperation, readSessionToolingOperation, runAsLegacyContinuation, runWithToolingOperation,
} from "./tooling-operations.ts";
import { canonicalDigest } from "./tooling-releases.ts";
import { selectCapabilityRelease } from "./tooling-capabilities.ts";
import { resolveToolingCompatibility } from "./tooling-compatibility.ts";
import { cleanupObserverRelease } from "./cleanup-resource-observer.ts";
import { FINALIZATION_PREPARED } from "./finalization-receipts.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = mkdtempSync(path.join(tmpdir(), "tooling-operations-")); });
afterEach(async () => { await db.cleanup(); rmSync(directory, { recursive: true, force: true }); });

const A = "a".repeat(40), B = "b".repeat(40);
const manifest = { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 1 }, stateFormats: { "drafted.runtime": { read: [1], write: 1, preservesUnknown: true } } };
const computeBody = { key: "runtime-development", purpose: "development", revision: "c".repeat(40), recipeDigest: "d".repeat(64) };

async function fixture() {
  const base = testConfig({ machine: "host" });
  const repository = { ...base.repository, id: "repo", tooling: { root: "/fixture/tooling-source", revision: A } };
  const config = { ...base, repository, repositories: { repo: repository } };
  for (const id of ["primary", "other-primary"]) await db.prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: `/fixture/${id}`, status: "idle" } });
  await db.prisma.runtimeSession.create({ data: { id: "delegate", scopeKey: "delegate", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "delegate", cwd: "/fixture/primary", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: "/fixture/primary", toolingRoot: "/fixture/tooling-source", toolingRevision: A, primarySessionId: "primary", phase: "working" } });
  await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", repositoryId: "repo", machineId: "host", branchName: "codex/other", worktreePath: "/fixture/other-primary", toolingRoot: "/fixture/tooling-source", toolingRevision: A, primarySessionId: "other-primary", phase: "working" } });
  for (const [id, revision] of [["release-a", A], ["release-b", B]] as const) await db.prisma.toolingRelease.create({ data: { id, repositoryId: "repo", revision, tree: revision.replace(/./g, "e"),
    policyBlob: "f".repeat(40), checkout: `/install/tooling/repo/${revision}`, manifest, lockfileDigest: "0".repeat(64), bunVersion: "1.3.0" } });
  return { config };
}
const activate = (releaseId: string, generation: number, activatedAt = new Date()) => db.prisma.toolingSelection.upsert({ where: { repositoryId: "repo" },
  create: { repositoryId: "repo", generation, releaseId, activatedAt }, update: { generation, releaseId, activatedAt } });
const environment = (id: string, createdAt = new Date()) => db.prisma.computeEnvironment.create({ data: { id, taskId: "task", primarySessionId: "primary", machineId: "host", key: `key-${id}`,
  purpose: "development", revision: "c".repeat(40), recipeDigest: "d".repeat(64), taskIdentity: "9".repeat(64), createdAt } });
const offer = (id: string, environmentId: string, createdAt = new Date()) => db.prisma.computeOffer.create({ data: { id, environmentId, machineId: "host", instructionId: `instruction-${id}`, dispatchDeadline: new Date(), createdAt } });

/** The guard in front of stand-in handlers that report what an inner consumer
 * observes, so the scope and association behavior are tested in isolation. */
function app(config: Awaited<ReturnType<typeof fixture>>["config"], response: (pathname: string) => Record<string, unknown> = () => ({})) {
  const seen: Array<{ path: string; release: string | null; legacy: boolean }> = [];
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  server.use("/api/*", toolingOperationGuard());
  server.route("/api/sessions", toolingOperationRoutes);
  server.all("/api/*", async c => {
    await c.req.json().catch(() => undefined); // The handler can still read the cached body.
    seen.push({ path: c.req.path, release: currentToolingOperation()?.release.revision ?? null, legacy: inLegacyContinuation() });
    return c.json(response(c.req.path), 200);
  });
  const call = (route: string, body: unknown, operationId?: string, method = "POST") => server.request(route, { method,
    headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { server, seen, call };
}
const begin = (config: Awaited<ReturnType<typeof fixture>>["config"], request: Record<string, unknown>, sessionId = "primary") =>
  beginSessionToolingOperation({ prisma: db.prisma, config, sessionId, request });

test("the callback inventory is exhaustive for Drafted effect callbacks and excludes owner, scheduling and session-tool routes", () => {
  const effects = ["compute-request", "compute-claim", "compute-decline", "compute-bind", "compute-configure", "compute-enroll", "development-authority", "development-complete",
    "prepare-finalization", "confirm-finalization", "cleanup-authority", "cleanup-progress", "cleanup-status", "cleanup-report", "cleanup-inventory-ownership"];
  for (const route of effects) expect(matchToolingCallback("POST", `/api/tasks/task/${route}`)).not.toBeNull();
  for (const route of ["prepare-finalization", "confirm-finalization", "browser-stop-authority", "archive-retention", "legacy-evidence", "local-service-stop-authority"]) expect(matchToolingCallback("POST", `/api/sessions/primary/${route}`)).not.toBeNull();
  expect(matchToolingCallback("POST", "/api/sessions/primary/local-service-stop-authority", { key: "k", development: { intentRevision: 1, intentDigest: "a".repeat(64) } })!.callback.kind).toBe("development-intent");
  expect(matchToolingCallback("POST", "/api/sessions/primary/local-service-stop-authority", { key: "k" })!.callback.kind).toBe("finalization");
  for (const excluded of ["/api/tasks/task/automation", "/api/tasks/task/cleanup-request", "/api/sessions/primary/issue-update", "/api/sessions/primary/tooling-capability", "/api/sessions/primary/tooling-operations"]) expect(matchToolingCallback("POST", excluded)).toBeNull();
  expect(matchToolingCallback("GET", "/api/tasks/task/compute-enroll")).toBeNull();
  expect(FINALIZATION_PREPARED_ACTION).toBe(FINALIZATION_PREPARED);
  // Every kind is a valid DRA-28 kind and is reachable from some callback.
  for (const kind of TOOLING_OPERATION_KINDS) { expect(kind).toMatch(/^[a-z][a-z0-9-]{0,63}$/); expect(TOOLING_CALLBACKS.some(callback => callback.kind === kind)).toBe(true); }
});

test("pre-protocol repositories keep their callbacks; an active generation refuses a missing header even with compute disabled", async () => {
  const { config } = await fixture();
  expect(config.compute?.enabled).not.toBe(true);
  const { call, seen } = app(config);
  expect((await call("/api/tasks/task/compute-request", computeBody)).status).toBe(200);
  expect(seen).toEqual([{ path: "/api/tasks/task/compute-request", release: null, legacy: false }]);
  await activate("release-a", 4);
  const refused = await call("/api/tasks/task/compute-request", computeBody);
  expect(refused.status).toBe(428);
  expect(await refused.json()).toMatchObject({ code: "operation-required", error: expect.stringContaining("POST /api/sessions/:sessionId/tooling-operations") });
  expect(seen).toHaveLength(1);
});

test("a binding is stable for retries across activation; the next independent operation binds the new generation", async () => {
  const { config } = await fixture();
  await expect(begin(config, { requestKey: "op-1", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).rejects.toThrow(/no release-aware active/);
  await activate("release-a", 4);
  const first = (await begin(config, { requestKey: "op-1", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  expect(first).toMatchObject({ generation: 4, taskId: "task", sessionId: "primary", kind: "compute-admission", release: { revision: A } });
  await activate("release-b", 5);
  expect((await begin(config, { requestKey: "op-1", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding).toEqual(first);
  await expect(begin(config, { requestKey: "op-1", inputDigest: canonicalDigest({ other: true }), kind: "compute-admission" })).rejects.toThrow();
  const second = (await begin(config, { requestKey: "op-2", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  expect(second).toMatchObject({ generation: 5, release: { revision: B } });
  // Unknown kinds, executable paths and release IDs are not accepted inputs.
  await expect(begin(config, { requestKey: "op-3", inputDigest: canonicalDigest(computeBody), kind: "anything" })).rejects.toThrow();
  await expect(begin(config, { requestKey: "op-3", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", releaseId: "release-a" })).rejects.toThrow();
  // Only the owning primary; a paused task starts no new operation.
  await expect(begin(config, { requestKey: "op-3", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" }, "delegate")).rejects.toThrow(/open owning task primary/);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  await expect(begin(config, { requestKey: "op-4", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).rejects.toThrow(/paused/);
  // Existing operation IDs must name this task's durable receipts.
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  await expect(begin(config, { requestKey: "op-5", inputDigest: canonicalDigest({}), kind: "compute-configure", existingOperationId: crypto.randomUUID() })).rejects.toThrow(/does not belong/);
  expect(await readSessionToolingOperation({ prisma: db.prisma, sessionId: "primary", operationId: first.operationId })).toEqual({ binding: first });
  expect(await readSessionToolingOperation({ prisma: db.prisma, sessionId: "other-primary", operationId: first.operationId })).toBeNull();
});

test("bound callbacks validate task, session, kind, input and association, then expose only that binding to inner consumers", async () => {
  const { config } = await fixture();
  await activate("release-a", 4);
  const { call, seen } = app(config, pathname => pathname.endsWith("compute-request") ? { enabled: true, environment: { id: "env-1" }, allocationId: "offer-1" } : {});
  const { binding } = await begin(config, { requestKey: "op-1", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" });
  await activate("release-b", 5);
  // Wrong input digest, kind, task or unknown operation never reach the handler.
  expect((await call("/api/tasks/task/compute-request", { ...computeBody, purpose: "review" }, binding.operationId)).status).toBe(400);
  expect((await call("/api/tasks/task/compute-configure", { offerId: crypto.randomUUID() }, binding.operationId)).status).toBe(409);
  expect((await call("/api/tasks/other/compute-request", computeBody, binding.operationId)).status).toBe(409);
  expect((await call("/api/tasks/task/compute-request", computeBody, crypto.randomUUID())).status).toBe(409);
  expect(seen).toHaveLength(0);
  // The retained A process continues on A after B became active.
  await environment("env-1"); await offer("offer-1", "env-1");
  expect((await call("/api/tasks/task/compute-request", computeBody, binding.operationId)).status).toBe(200);
  expect(seen.at(-1)).toMatchObject({ release: A, legacy: false });
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  expect(await producingToolingOperation({ prisma: db.prisma, task, reference: { type: "compute-environment", id: "env-1" } })).toEqual(binding);
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-1" }, binding.operationId)).status).toBe(200);
  expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, binding.operationId)).status).toBe(200);
  // An offer this operation did not produce cannot be continued with it.
  await environment("env-2"); await offer("offer-2", "env-2");
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-2" }, binding.operationId)).status).toBe(409);
  expect(seen.map(entry => entry.release)).toEqual([A, A, A]);
});

test("only an unassociated receipt recorded before activation may continue without a header", async () => {
  const { config } = await fixture();
  const before = new Date(Date.now() - 60_000);
  await environment("legacy-env", before); await offer("legacy-offer", "legacy-env", before);
  await activate("release-a", 4);
  await environment("new-env"); await offer("new-offer", "new-env", new Date(Date.now() + 1000));
  const { call, seen } = app(config);
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "legacy-offer" })).status).toBe(200);
  expect(seen.at(-1)).toMatchObject({ release: null, legacy: true });
  expect((await call("/api/tasks/task/compute-bind", { offerId: "new-offer", resourceKey: "runtime" })).status).toBe(428);
  expect((await call("/api/tasks/task/compute-request", computeBody)).status).toBe(428);
  // Once a bound operation continues the receipt, the legacy path closes.
  const { binding } = await begin(config, { requestKey: "configure", inputDigest: canonicalDigest({ offerId: "legacy-offer" }), kind: "compute-configure", existingOperationId: "legacy-offer" });
  const bound = app(config, () => ({ environmentId: "legacy-env" }));
  expect((await bound.call("/api/tasks/task/compute-configure", { offerId: "legacy-offer" }, binding.operationId)).status).toBe(200);
  expect((await call("/api/tasks/task/compute-decline", { offerId: "legacy-offer" })).status).toBe(428);
  // Finalization: an exact pre-transition preparation continues; a new key does not.
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key: "finalize:task", value: "{}", occurredAt: before } });
  expect((await call("/api/tasks/task/cleanup-authority", { requestKey: "finalize:task" })).status).toBe(200);
  expect((await call("/api/sessions/primary/browser-stop-authority", { key: "browser" })).status).toBe(200);
  expect((await call("/api/tasks/task/prepare-finalization", { requestKey: "finalize:new" })).status).toBe(428);
});

test("inner consumers take the explicit or scoped binding and never re-read the active selection", async () => {
  const { config } = await fixture();
  await activate("release-b", 5);
  const release = (id: string) => ({ id } as ToolingReleaseRecord);
  const active = async () => { throw new Error("inner consumer read the active selection"); };
  expect(await selectCapabilityRelease({ prisma: db.prisma, config, repositoryId: "repo", release: release("explicit") }, active)).toEqual(release("explicit"));
  expect(await runAsLegacyContinuation({ type: "compute-offer", id: "o" }, () => selectCapabilityRelease({ prisma: db.prisma, config, repositoryId: "repo" }, active))).toBeNull();
  const { binding } = await bindServerToolingOperationFor(config);
  expect(await runWithToolingOperation(binding, () => selectCapabilityRelease({ prisma: db.prisma, config, repositoryId: "repo" }, active))).toEqual(binding.release);
  // Only an outer, independent boundary selects the active generation.
  expect((await selectCapabilityRelease({ prisma: db.prisma, config, repositoryId: "repo" }))!.revision).toBe(B);
  // Cleanup proofs keep the operation that prepared the accepted finalization.
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key: "finalize:task", value: "{}" } });
  expect(await cleanupObserverRelease({ task, prisma: db.prisma })).toBeNull();
  const finalization = (await begin(config, { requestKey: "finalize", inputDigest: canonicalDigest({ requestKey: "finalize:task" }), kind: "finalization" })).binding;
  const { call } = app(config);
  expect((await call("/api/tasks/task/prepare-finalization", { requestKey: "finalize:task", cleanup: true }, finalization.operationId)).status).toBe(200);
  await activate("release-a", 6);
  expect(await cleanupObserverRelease({ task, prisma: db.prisma })).toEqual(finalization.release);
});
async function bindServerToolingOperationFor(config: Awaited<ReturnType<typeof fixture>>["config"]) {
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  const request = { requestKey: "compute-continue:env:7", inputDigest: canonicalDigest({ intentRevision: 7, intentDigest: "a".repeat(64) }), kind: "development-intent" as const, existingOperationId: "7" };
  const binding = await bindServerToolingOperation({ prisma: db.prisma, config, task, request });
  return { binding: binding!, request, task };
}

test("server-initiated continuation reuses its original binding after a later activation", async () => {
  const { config } = await fixture();
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  expect(await bindServerToolingOperation({ prisma: db.prisma, config, task, request: { requestKey: "compute-continue:env:7", inputDigest: canonicalDigest({}), kind: "development-intent", existingOperationId: "7" } })).toBeNull();
  await activate("release-a", 4);
  const { binding, request } = await bindServerToolingOperationFor(config);
  await activate("release-b", 5);
  expect(await bindServerToolingOperation({ prisma: db.prisma, config, task, request })).toEqual(binding);
  expect(binding.release.revision).toBe(A);
});

test("compatibility uses an explicit release checkout and never installs for bound or observer resolution", async () => {
  const { config } = await fixture();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const source = path.join(directory, "source"); mkdirSync(source);
  git(source, "init"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.com");
  writeFileSync(path.join(source, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "cli.ts" } } }));
  writeFileSync(path.join(source, "runtime.md"), "Runtime instructions"); writeFileSync(path.join(source, "cli.ts"), "// adapter");
  git(source, "add", "."); git(source, "commit", "-m", "release"); const revision = git(source, "rev-parse", "HEAD");
  const checkout = path.join(directory, "install", "tooling", "repo", revision);
  mkdirSync(path.dirname(checkout), { recursive: true }); git(source, "worktree", "add", "--detach", checkout, revision);
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  const repository = { ...config.repositories.repo, tooling: { root: source, revision: A } };
  const base = { task, repository, installRoot: path.join(directory, "install"), capability: "runtime" as const, worktreePath: "/fixture/primary", seed: "observe" };
  const bound = await resolveToolingCompatibility({ ...base, release: { id: "r", repositoryId: "repo", revision, tree: "t", policyBlob: "p", checkout, manifest: manifest as ToolingReleaseRecord["manifest"] } });
  expect(bound.receipt).toMatchObject({ capabilityRevision: revision, checkout: realpathSync(checkout), adapter: realpathSync(path.join(checkout, "cli.ts")), source: "configured-host" });
  // The receipt keeps its strict version-1 shape: no binding fields leak in.
  expect(Object.keys(bound.receipt).sort()).toEqual(["adapter", "capability", "capabilityRevision", "checkout", "contract", "instructions", "source", "taskToolingRevision"]);
  await expect(resolveToolingCompatibility({ ...base, release: { id: "r", repositoryId: "repo", revision: B, tree: "t", policyBlob: "p", checkout, manifest: manifest as ToolingReleaseRecord["manifest"] } })).rejects.toThrow(/not its bound revision/);
  await expect(resolveToolingCompatibility({ ...base, install: false })).rejects.toThrow(/never install/);
});
