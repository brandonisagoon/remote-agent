import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  FINALIZATION_PREPARED_ACTION, TOOLING_CALLBACKS, TOOLING_CALLBACK_CLASSIFICATION, TOOLING_OPERATION_HEADER, TOOLING_OPERATION_KINDS, beginSessionToolingOperation,
  bindServerContinuation, boundCode, inventoryLegacyToolingConsumers, resolveFinishedLegacyConsumers, matchToolingCallback, producerOperationId, readSessionToolingOperation, resourceGroupCode,
} from "./tooling-operations.ts";
import { canonicalDigest, readToolingOperation, transitionToolingOperation } from "./tooling-releases.ts";
import { selectCapabilityRelease } from "./tooling-capabilities.ts";
import { resolveToolingCompatibility } from "./tooling-compatibility.ts";
import { cleanupObserverRelease } from "./cleanup-resource-observer.ts";
import { FINALIZATION_PREPARED } from "./finalization-receipts.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = mkdtempSync(path.join(tmpdir(), "tooling-operations-")); });
afterEach(async () => { await db.cleanup(); rmSync(directory, { recursive: true, force: true }); });

const LEGACY = "1".repeat(40), A = "a".repeat(40), B = "b".repeat(40);
const manifest = { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 1 }, stateFormats: { "drafted.runtime": { read: [1], write: 1, preservesUnknown: true } } };
const computeBody = { key: "runtime-development", purpose: "development", revision: "c".repeat(40), recipeDigest: "d".repeat(64) };
type Config = Awaited<ReturnType<typeof fixture>>["config"];

async function fixture() {
  const base = testConfig({ machine: "host" });
  const repository = { ...base.repository, id: "repo", tooling: { root: "/fixture/tooling-source", revision: B } };
  const config = { ...base, repository, repositories: { repo: repository } };
  for (const id of ["primary", "other-primary"]) await db.prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: `/fixture/${id}`, status: "idle" } });
  await db.prisma.runtimeSession.create({ data: { id: "delegate", scopeKey: "delegate", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "delegate", cwd: "/fixture/primary", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: "/fixture/primary", toolingRoot: "/fixture/tooling-source", toolingRevision: LEGACY, primarySessionId: "primary", phase: "working" } });
  await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", repositoryId: "repo", machineId: "host", branchName: "codex/other", worktreePath: "/fixture/other-primary", toolingRoot: "/fixture/tooling-source", toolingRevision: LEGACY, primarySessionId: "other-primary", phase: "working" } });
  for (const [id, revision] of [["release-a", A], ["release-b", B]] as const) await db.prisma.toolingRelease.create({ data: { id, repositoryId: "repo", revision, tree: revision.replace(/./g, "e"),
    policyBlob: "f".repeat(40), checkout: `/install/tooling/repo/${revision}`, manifest, lockfileDigest: "0".repeat(64), bunVersion: "1.3.0" } });
  return { config };
}
const activate = (releaseId: string, generation: number) => db.prisma.toolingSelection.upsert({ where: { repositoryId: "repo" },
  create: { repositoryId: "repo", generation, releaseId, activatedAt: new Date() }, update: { generation, releaseId, activatedAt: new Date() } });
/** First bootstrap: boundary plus exact legacy snapshots (DRA-28 rows). */
async function bootstrap(consumers: Array<[kind: string, id: string]>, at = new Date(Date.now() - 1000)) {
  await db.prisma.toolingLegacyBoundary.create({ data: { repositoryId: "repo", activationRequestKey: "first", legacyRevision: LEGACY, recordedAt: at } });
  for (const [consumerKind, consumerId] of consumers) await db.prisma.toolingLegacyConsumer.create({ data: { id: crypto.randomUUID(), repositoryId: "repo", taskId: "task", consumerKind, consumerId,
    provenance: "exact", revision: LEGACY, checkout: `/install/tooling/repo/${LEGACY}` } });
  await activate("release-a", 1);
}
const environment = (id: string, key = `key-${id}`) => db.prisma.computeEnvironment.create({ data: { id, taskId: "task", primarySessionId: "primary", machineId: "host", key,
  purpose: "development", revision: "c".repeat(40), recipeDigest: "d".repeat(64), taskIdentity: "9".repeat(64) } });
const offer = (id: string, environmentId: string) => db.prisma.computeOffer.create({ data: { id, environmentId, machineId: "host", instructionId: `instruction-${id}`, dispatchDeadline: new Date() } });
const task = () => db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });

/** The guard in front of stand-in handlers that record the code an inner
 * consumer would select, so scope, lifecycle and association are isolated. */
function app(config: Config, respond: (pathname: string) => { status?: number; body?: Record<string, unknown> } = () => ({})) {
  const seen: Array<{ path: string; code: string | null | undefined }> = [];
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  server.use("/api/*", toolingOperationGuard());
  server.route("/api/sessions", toolingOperationRoutes);
  server.all("/api/*", async c => {
    await c.req.json().catch(() => undefined); // The handler can still read the cached body.
    const code = boundCode();
    seen.push({ path: c.req.path, code: code === undefined ? undefined : code?.revision ?? null });
    const reply = respond(c.req.path);
    return c.json(reply.body ?? {}, (reply.status ?? 200) as 200);
  });
  const call = (route: string, body: unknown, operationId?: string, method = "POST") => server.request(route, { method,
    headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: JSON.stringify(body) });
  return { seen, call };
}
const begin = (config: Config, request: Record<string, unknown>, sessionId = "primary") => beginSessionToolingOperation({ prisma: db.prisma, config, sessionId, request });

test("every adapter callback is classified: effects are bound, owner controls and evidence are justified", () => {
  // The paired Drafted control client (src/control.ts taskRegistry) surface.
  const drafted = ["POST /api/tasks/:taskId/compute-request", "POST /api/tasks/:taskId/compute-claim", "POST /api/tasks/:taskId/compute-bind", "POST /api/tasks/:taskId/compute-configure",
    "POST /api/tasks/:taskId/prepare-finalization", "POST /api/sessions/:sessionId/prepare-finalization", "POST /api/tasks/:taskId/cleanup-authority", "POST /api/tasks/:taskId/cleanup-inventory-ownership",
    "POST /api/tasks/:taskId/automation", "POST /api/tasks/:taskId/development-authority", "POST /api/tasks/:taskId/development-complete", "POST /api/tasks/:taskId/confirm-finalization",
    "POST /api/sessions/:sessionId/confirm-finalization", "POST /api/tasks/:taskId/cleanup-progress", "POST /api/tasks/:taskId/cleanup-status", "POST /api/tasks/:taskId/cleanup-report",
    "POST /api/sessions/:sessionId/legacy-evidence", "POST /api/sessions/:sessionId/local-service-stop-authority", "POST /api/sessions/:sessionId/browser-stop-authority",
    "POST /api/sessions/:sessionId/archive-retention", "PUT /api/sessions/:sessionId/task/resources", "POST /api/tasks/:taskId/cleanup-request", "POST /api/sessions/:sessionId/tooling-capability"];
  const classified = new Map<string, (typeof TOOLING_CALLBACK_CLASSIFICATION)[number]>(TOOLING_CALLBACK_CLASSIFICATION.map(row => [row.route, row]));
  for (const route of drafted) expect(classified.has(route)).toBe(true);
  for (const row of TOOLING_CALLBACK_CLASSIFICATION) if (row.rule !== "operation") expect("reason" in row && row.reason.length > 20).toBe(true);
  expect(classified.get("POST /api/tasks/:taskId/cleanup-request")!.rule).toBe("operation");
  expect(matchToolingCallback("POST", "/api/sessions/primary/local-service-stop-authority", { key: "k", development: { intentRevision: 1, intentDigest: "a".repeat(64) } })!.callback.kind).toBe("development-intent");
  expect(matchToolingCallback("POST", "/api/sessions/primary/local-service-stop-authority", { key: "k" })!.callback.kind).toBe("finalization");
  for (const excluded of ["/api/tasks/task/automation", "/api/sessions/primary/issue-update", "/api/sessions/primary/tooling-capability"]) expect(matchToolingCallback("POST", excluded)).toBeNull();
  for (const kind of TOOLING_OPERATION_KINDS) { expect(kind).toMatch(/^[a-z][a-z0-9-]{0,63}$/); expect(TOOLING_CALLBACKS.some(callback => callback.kind === kind)).toBe(true); }
  expect(FINALIZATION_PREPARED_ACTION).toBe(FINALIZATION_PREPARED);
});

test("pre-protocol callbacks are unchanged; an active generation refuses a missing header even with compute disabled", async () => {
  const { config } = await fixture();
  expect(config.compute?.enabled).not.toBe(true);
  const { call, seen } = app(config);
  expect((await call("/api/tasks/task/compute-request", computeBody)).status).toBe(200);
  expect(seen).toEqual([{ path: "/api/tasks/task/compute-request", code: undefined }]);
  await bootstrap([]);
  const refused = await call("/api/tasks/task/compute-request", computeBody);
  expect(refused.status).toBe(428);
  expect(await refused.json()).toMatchObject({ code: "operation-required", error: expect.stringContaining("POST /api/sessions/:sessionId/tooling-operations") });
  expect((await call("/api/tasks/task/cleanup-request", { requestKey: "maintenance" })).status).toBe(428);
  // Ordinary evidence registration is never blocked.
  expect((await call("/api/sessions/primary/task/resources", { key: "evidence" }, undefined, "PUT")).status).toBe(200);
  expect(seen).toHaveLength(2);
});

test("legacy eligibility is the exact first-bootstrap snapshot, never activation time, and survives B -> C", async () => {
  const { config } = await fixture();
  await environment("legacy-env"); await offer("legacy-offer", "legacy-env");
  await bootstrap([["compute-environment", "legacy-env"], ["compute-offer", "legacy-offer"]]);
  // Created after the boundary while A was active, never bound.
  await environment("post-env"); await offer("post-offer", "post-env");
  await activate("release-b", 2);
  const { call, seen } = app(config);
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "legacy-offer" })).status).toBe(200);
  expect(seen.at(-1)!.code).toBe(LEGACY); // the recorded snapshot, not the boot/active revision
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "post-offer" })).status).toBe(428);
  // Observers of the legacy group use its snapshot; the post-boundary unbound group fails closed.
  expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-environment", id: "legacy-env" } })).code!.revision).toBe(LEGACY);
  await expect(resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-environment", id: "post-env" } })).rejects.toThrow(/no bound producer/);
  // A release-aware operation cannot take over the uncertain legacy offer.
  await expect(begin(config, { requestKey: "takeover", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", existingOperationId: "legacy-offer" })).rejects.toThrow(/legacy consumer/);
});

test("a binding is stable across activation, and continuing an existing operation finds it under a fresh request key", async () => {
  const { config } = await fixture();
  await expect(begin(config, { requestKey: "op-1", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).rejects.toThrow(/no release-aware active/);
  await bootstrap([]);
  const first = (await begin(config, { requestKey: "op-1", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  expect(first).toMatchObject({ generation: 1, release: { revision: A } });
  const { call } = app(config, () => ({ body: { enabled: true } }));
  expect((await call("/api/tasks/task/compute-request", computeBody, first.operationId)).status).toBe(200);
  await environment("env-1", computeBody.key); await offer("offer-1", "env-1");
  await activate("release-b", 2);
  expect((await begin(config, { requestKey: "op-1", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding).toMatchObject({ operationId: first.operationId, generation: 1, release: { revision: A } });
  // Uncertain claim retried by a caller that minted a new key: original A binding.
  expect((await begin(config, { requestKey: "fresh-key", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", existingOperationId: "offer-1" })).binding.operationId).toBe(first.operationId);
  await expect(begin(config, { requestKey: "fresh-2", inputDigest: canonicalDigest({ other: 1 }), kind: "compute-admission", existingOperationId: "offer-1" })).rejects.toThrow(/continue that operation/);
  expect((await begin(config, { requestKey: "op-2", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding).toMatchObject({ generation: 2, release: { revision: B } });
  await expect(begin(config, { requestKey: "op-3", inputDigest: canonicalDigest(computeBody), kind: "anything" })).rejects.toThrow();
  await expect(begin(config, { requestKey: "op-3", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", releaseId: "release-a" })).rejects.toThrow();
  await expect(begin(config, { requestKey: "op-3", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" }, "delegate")).rejects.toThrow(/open owning task primary/);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  await expect(begin(config, { requestKey: "op-4", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).rejects.toThrow(/paused/);
  expect(await readSessionToolingOperation({ prisma: db.prisma, sessionId: "primary", operationId: first.operationId })).toMatchObject({ binding: { operationId: first.operationId } });
  expect(await readSessionToolingOperation({ prisma: db.prisma, sessionId: "other-primary", operationId: first.operationId })).toBeNull();
});

test("admission never moves the producer; a confirmed start does, and an unknown start fails closed until retried", async () => {
  const { config } = await fixture();
  await environment("env-1", computeBody.key);
  await bootstrap([["compute-environment", "env-1"]]);
  await activate("release-b", 2);
  const { binding } = await begin(config, { requestKey: "start", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" });
  let bindStatus = 500;
  const { call, seen } = app(config, pathname => pathname.endsWith("compute-bind") ? { status: bindStatus } : {});
  // Wrong input, kind or task never reach a handler.
  expect((await call("/api/tasks/task/compute-request", { ...computeBody, purpose: "review" }, binding.operationId)).status).toBe(400);
  expect((await call("/api/tasks/task/compute-configure", { offerId: crypto.randomUUID() }, binding.operationId)).status).toBe(409);
  expect((await call("/api/tasks/other/compute-request", computeBody, binding.operationId)).status).toBe(409);
  expect((await call("/api/tasks/task/compute-request", computeBody, crypto.randomUUID())).status).toBe(409);
  expect(seen).toHaveLength(0);
  expect((await call("/api/tasks/task/compute-request", computeBody, binding.operationId)).status).toBe(200);
  await offer("offer-1", "env-1");
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-1" }, binding.operationId)).status).toBe(200);
  // Still the legacy producer: admission and a claimed offer change nothing.
  expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-environment", id: "env-1" } })).code!.revision).toBe(LEGACY);
  expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, binding.operationId)).status).toBe(500);
  await expect(producerOperationId(db.prisma, await task(), "env-1")).rejects.toThrow(/unconfirmed producer change/);
  expect((await readToolingOperation({ prisma: db.prisma, operationId: binding.operationId }))!.status).toBe("unknown");
  bindStatus = 200;
  expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, binding.operationId)).status).toBe(200);
  expect(await producerOperationId(db.prisma, await task(), "env-1")).toBe(binding.operationId);
  expect((await readToolingOperation({ prisma: db.prisma, operationId: binding.operationId }))!.status).toBe("completed");
  // A completed operation replays its completing callback but authorizes nothing new.
  expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, binding.operationId)).status).toBe(200);
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-1" }, binding.operationId)).status).toBe(409);
  expect(seen.map(entry => entry.code)).toEqual([B, B, B, B, B]);
});

test("server continuation runs the group's own code and never rebinds a producer onto a newer release", async () => {
  const { config } = await fixture();
  await environment("legacy-env"); await environment("env-a");
  await bootstrap([["compute-environment", "legacy-env"]]);
  const intent = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: "intent", value: "{}" } });
  const request = (requestKey: string) => ({ requestKey, inputDigest: canonicalDigest({ intentRevision: intent.sequence, intentDigest: "a".repeat(64) }), kind: "development-intent" as const, existingOperationId: String(intent.sequence) });
  expect(await bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "legacy-env", request: request("legacy") }))
    .toEqual({ binding: null, code: { repositoryId: "repo", revision: LEGACY, checkout: `/install/tooling/repo/${LEGACY}` } });
  const producer = (await begin(config, { requestKey: "start-a", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key: "producer:compute-environment:env-a",
    value: JSON.stringify({ version: 1, operationId: producer.operationId, role: "producer", state: "confirmed" }) } });
  const continued = await bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "env-a", request: request("continue-a") });
  expect(continued.code!.revision).toBe(A);
  await activate("release-b", 2);
  // Retry after activation: same A binding, found via the intent's owner.
  expect((await bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "env-a", request: request("continue-a") })).binding!.operationId).toBe(continued.binding!.operationId);
  // A fresh continuation of the A group would need a retained-release binding.
  const second = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: "intent-2", value: "{}" } });
  await expect(bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "env-a",
    request: { ...request("continue-b"), existingOperationId: String(second.sequence) } })).rejects.toThrow(/retained-release binding/);
});

test("inner consumers use explicit or scoped code; cleanup proofs follow the accepted finalization and fail closed", async () => {
  const { config } = await fixture();
  await bootstrap([["finalization", "task:finalize:legacy"]]);
  await activate("release-b", 2);
  const active = async () => { throw new Error("inner consumer read the active selection"); };
  const code = { repositoryId: "repo", revision: "e".repeat(40), checkout: "/explicit" };
  expect(await selectCapabilityRelease({ prisma: db.prisma, config, repositoryId: "repo", release: code }, active)).toEqual(code);
  expect((await selectCapabilityRelease({ prisma: db.prisma, config, repositoryId: "repo" }))!.revision).toBe(B); // outer independent boundary only
  // No finalization yet: an independent resolution of the active release.
  expect((await cleanupObserverRelease({ task: await task(), config, prisma: db.prisma }))!.revision).toBe(B);
  const prepare = (key: string) => db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key, value: "{}" } });
  await prepare("finalize:legacy");
  expect((await cleanupObserverRelease({ task: await task(), config, prisma: db.prisma }))!.revision).toBe(LEGACY);
  await prepare("finalize:unbound");
  await expect(cleanupObserverRelease({ task: await task(), config, prisma: db.prisma })).rejects.toThrow(/no bound producer/);
  const finalization = (await begin(config, { requestKey: "finalize", inputDigest: canonicalDigest({ requestKey: "finalize:task" }), kind: "finalization" })).binding;
  const { call } = app(config);
  expect((await call("/api/tasks/task/prepare-finalization", { requestKey: "finalize:task", cleanup: true }, finalization.operationId)).status).toBe(200);
  await prepare("finalize:task");
  await activate("release-a", 3);
  expect((await cleanupObserverRelease({ task: await task(), config, prisma: db.prisma }))!.revision).toBe(B);
  // A bound operation cannot take over the retained legacy finalization.
  const takeover = (await begin(config, { requestKey: "legacy-takeover", inputDigest: canonicalDigest({ requestKey: "finalize:legacy" }), kind: "finalization" })).binding;
  expect((await call("/api/tasks/task/cleanup-authority", { requestKey: "finalize:legacy" }, takeover.operationId)).status).toBe(409);
});

test("the legacy inventory snapshots exact recorded executables and never infers them from configuration", async () => {
  await fixture();
  await environment("env-1"); await offer("offer-1", "env-1");
  const receipt = { contract: "remote-agent.tooling-capability/v1", capability: "runtime", source: "configured-host", taskToolingRevision: LEGACY, capabilityRevision: LEGACY, checkout: "/install/tooling/repo/legacy", instructions: "/i", adapter: "/a" };
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key: "k", value: JSON.stringify(receipt) } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key: "finalize:task", value: "{}" } });
  const consumers = await db.prisma.$transaction(tx => inventoryLegacyToolingConsumers(tx, { repositoryId: "repo", legacyRevision: B }));
  expect(consumers).toContainEqual({ taskId: "task", consumerKind: "compute-environment", consumerId: "env-1", provenance: { revision: LEGACY, checkout: receipt.checkout, receipt } });
  expect(consumers).toContainEqual({ taskId: "task", consumerKind: "compute-offer", consumerId: "offer-1", provenance: { revision: LEGACY, checkout: receipt.checkout, receipt } });
  expect(consumers.find(value => value.consumerKind === "finalization")).toMatchObject({ consumerId: "task:finalize:task", provenance: { unavailable: expect.stringContaining("cleanup") } });
});

test("compatibility uses an explicit code identity and never installs for bound or observer resolution", async () => {
  const { config } = await fixture();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const source = path.join(directory, "source"); mkdirSync(source);
  git(source, "init"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.com");
  writeFileSync(path.join(source, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "cli.ts" } } }));
  writeFileSync(path.join(source, "runtime.md"), "Runtime instructions"); writeFileSync(path.join(source, "cli.ts"), "// adapter");
  git(source, "add", "."); git(source, "commit", "-m", "release"); const revision = git(source, "rev-parse", "HEAD");
  const checkout = path.join(directory, "install", "tooling", "repo", revision);
  mkdirSync(path.dirname(checkout), { recursive: true }); git(source, "worktree", "add", "--detach", checkout, revision);
  const repository = { ...config.repositories.repo, tooling: { root: source, revision: A } };
  const base = { task: await task(), repository, installRoot: path.join(directory, "install"), capability: "runtime" as const, worktreePath: "/fixture/primary", seed: "observe" };
  const bound = await resolveToolingCompatibility({ ...base, release: { repositoryId: "repo", revision, checkout } });
  expect(bound.receipt).toMatchObject({ capabilityRevision: revision, checkout: realpathSync(checkout), adapter: realpathSync(path.join(checkout, "cli.ts")), source: "configured-host" });
  expect(Object.keys(bound.receipt).sort()).toEqual(["adapter", "capability", "capabilityRevision", "checkout", "contract", "instructions", "source", "taskToolingRevision"]);
  await expect(resolveToolingCompatibility({ ...base, release: { repositoryId: "repo", revision: B, checkout } as ToolingReleaseRecord })).rejects.toThrow(/not its bound revision/);
  await expect(resolveToolingCompatibility({ ...base, install: false })).rejects.toThrow(/never install/);
});

test("activating B after command fence A but before its FIRST callback keeps every callback of A on A", async () => {
  const { config } = await fixture();
  await environment("env-1", computeBody.key); await bootstrap([]);
  const fence = (await begin(config, { requestKey: "cmd-a", inputDigest: canonicalDigest({ argv: ["runtime", "start"] }), kind: "adapter-command" })).binding;
  expect(fence).toMatchObject({ kind: "adapter-command", release: { revision: A }, parentOperationId: null });
  await activate("release-b", 2);
  // First callback after activation: inherits A from its parent, not active B.
  const request = (await begin(config, { requestKey: "cmd-a:request", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: fence.operationId })).binding;
  expect(request).toMatchObject({ release: { revision: A }, generation: 1, parentOperationId: fence.operationId });
  const { call, seen } = app(config);
  expect((await call("/api/tasks/task/compute-request", computeBody, request.operationId)).status).toBe(200);
  await offer("offer-1", "env-1");
  // A sibling callback of the same command continues the admission it made.
  const claim = (await begin(config, { requestKey: "cmd-a:claim", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: fence.operationId })).binding;
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-1" }, claim.operationId)).status).toBe(200);
  expect(seen.map(entry => entry.code)).toEqual([A, A]);
  // The next independent command selects B.
  const next = (await begin(config, { requestKey: "cmd-b", inputDigest: canonicalDigest({ argv: ["runtime", "status"] }), kind: "adapter-command" })).binding;
  expect(next.release.revision).toBe(B);
  // A command fence is a root; parents must be this primary's open command.
  await expect(begin(config, { requestKey: "nested", inputDigest: canonicalDigest({}), kind: "adapter-command", parentOperationId: fence.operationId })).rejects.toThrow();
  await expect(begin(config, { requestKey: "foreign", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: request.operationId })).rejects.toThrow(/adapter-command/);
  await transitionToolingOperation({ prisma: db.prisma, operationId: fence.operationId, from: "bound", to: "completed", evidence: { kind: "adapter-command", reference: "exit-0" } });
  await expect(begin(config, { requestKey: "cmd-a:late", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: fence.operationId })).rejects.toThrow(/completed/);
});

test("prepared-finalization callbacks derive their exact key from the command lineage and keep digest validation", async () => {
  const { config } = await fixture(); await bootstrap([]);
  const fence = (await begin(config, { requestKey: "destroy", inputDigest: canonicalDigest({ argv: ["task", "destroy"] }), kind: "adapter-command" })).binding;
  const child = (key: string, digestKey: string) => begin(config, { requestKey: `destroy:${key}`, inputDigest: canonicalDigest({ requestKey: digestKey }), kind: "finalization", parentOperationId: fence.operationId });
  const prepare = (await child("prepare", "finalize:task")).binding;
  const { call } = app(config);
  expect((await call("/api/tasks/task/prepare-finalization", { requestKey: "finalize:task", cleanup: true }, prepare.operationId)).status).toBe(200);
  for (const key of ["finalize:task", "finalize:newer"]) await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key, value: "{}" } });
  // The adapter has no request key in this body; the server derives the
  // lineage's own finalization (not the newer one) and checks the digest.
  const stop = (await child("browser-stop", "finalize:task")).binding;
  expect((await call("/api/sessions/primary/browser-stop-authority", { key: "browser" }, stop.operationId)).status).toBe(200);
  const wrong = (await child("browser-stop-wrong", "finalize:newer")).binding;
  expect((await call("/api/sessions/primary/browser-stop-authority", { key: "browser" }, wrong.operationId)).status).toBe(400);
  // A sibling continues the finalization its command prepared.
  const authority = (await child("authority", "finalize:task")).binding;
  expect((await call("/api/tasks/task/cleanup-authority", { requestKey: "finalize:task" }, authority.operationId)).status).toBe(200);
});

test("state evidence and write registration are guarded by the owning operation and refuse unknown provenance", async () => {
  const { config } = await fixture(); await bootstrap([]);
  const op = (await begin(config, { requestKey: "cmd-state", inputDigest: canonicalDigest({ argv: ["runtime", "configure"] }), kind: "adapter-command", resourceKey: "runtime" })).binding;
  const { call } = app(config);
  const state = (query: string, operationId = op.operationId, header: string | null = op.operationId, session = "primary") =>
    call(`/api/sessions/${session}/tooling-operations/${operationId}/state?${query}`, undefined, header ?? undefined, "GET");
  const write = (body: unknown, header: string | undefined = op.operationId) => call(`/api/sessions/primary/tooling-operations/${op.operationId}/state-writes`, body, header);
  expect((await state("family=drafted.runtime&scopeKey=runtime", op.operationId, null)).status).toBe(428);
  expect((await state("family=drafted.runtime&scopeKey=runtime", op.operationId, op.operationId, "other-primary")).status).toBe(409);
  expect((await state("family=drafted.runtime&scopeKey=/tmp/arbitrary")).status).toBe(400); // no arbitrary path scopes
  const before = await state("family=drafted.runtime&scopeKey=runtime");
  expect(before.status).toBe(200);
  expect(await before.json()).toEqual({ operationId: op.operationId, taskId: "task", family: "drafted.runtime", scopeKey: "runtime", version: 1, source: "legacy-assumed",
    consumers: [{ operationId: op.operationId, format: manifest.stateFormats["drafted.runtime"] }] });
  const registered = await write({ family: "drafted.runtime", scopeKey: "runtime", version: 1 });
  expect(registered.status).toBe(200);
  expect(await registered.json()).toMatchObject({ operationId: op.operationId, taskId: "task", family: "drafted.runtime", scopeKey: "runtime", write: { version: 1, operationId: op.operationId, releaseId: "release-a" } });
  expect((await write({ family: "drafted.runtime", scopeKey: "runtime", version: 1, taskId: "other" })).status).toBe(400); // no caller-chosen task
  expect((await write({ family: "drafted.runtime", scopeKey: "runtime", version: 2 })).status).toBe(409); // undeclared write version
  expect(await (await state("family=drafted.runtime&scopeKey=runtime")).json()).toMatchObject({ version: 1, source: "recorded" });
  // Unknown first-bootstrap provenance refuses rather than returning an empty inventory.
  await environment("env-x"); await db.prisma.computeEnvironment.update({ where: { id: "env-x" }, data: { state: "running" } }); // a live consumer
  await db.prisma.toolingLegacyConsumer.create({ data: { id: "legacy-unknown", repositoryId: "repo", taskId: "task", consumerKind: "compute-environment", consumerId: "env-x", provenance: "unavailable", detail: "no receipt" } });
  expect((await state("family=drafted.runtime&scopeKey=runtime")).status).toBe(409);
  await db.prisma.toolingLegacyConsumer.update({ where: { id: "legacy-unknown" }, data: { provenance: "exact", revision: LEGACY, checkout: "/install/legacy", detail: null } });
  expect((await (await state("family=drafted.runtime&scopeKey=runtime")).json()).consumers).toContainEqual({ operationId: "legacy:legacy-unknown", format: null });
  // Lifecycle and current authority are rechecked.
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
  expect((await state("family=drafted.runtime&scopeKey=runtime")).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "working" } });
  await transitionToolingOperation({ prisma: db.prisma, operationId: op.operationId, from: "bound", to: "completed", evidence: { kind: "adapter-command", reference: "exit-0" } });
  expect((await write({ family: "drafted.runtime", scopeKey: "runtime", version: 1 })).status).toBe(409);
});

describe("review of 73ab07f", () => {
  const receipt = (revision: string, checkout: string) => JSON.stringify({ contract: "remote-agent.tooling-capability/v1", capability: "runtime", source: "configured-host", taskToolingRevision: LEGACY, capabilityRevision: revision, checkout, instructions: "/i", adapter: "/a" });
  const inventory = () => db.prisma.$transaction(tx => inventoryLegacyToolingConsumers(tx, { repositoryId: "repo", legacyRevision: B }));

  test("closed tasks and resources without a baseline row are inventoried, and a closed task's group keeps its snapshot", async () => {
    await fixture();
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key: "r", value: receipt(LEGACY, "/install/legacy") } });
    await environment("closed-env"); await db.prisma.computeEnvironment.update({ where: { id: "closed-env" }, data: { state: "running" } });
    await db.prisma.remoteTaskResource.create({ data: { id: "orphan", taskId: "task", key: "orphan", kind: "docker-container", purpose: "development", externalId: "orphan", state: "ready" } });
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
    const consumers = await inventory();
    expect(consumers).toContainEqual(expect.objectContaining({ consumerKind: "compute-environment", consumerId: "closed-env", provenance: expect.objectContaining({ revision: LEGACY }) }));
    expect(consumers).toContainEqual(expect.objectContaining({ consumerKind: "compute-baseline", consumerId: "task:development" }));
    await bootstrap(consumers.map(value => [value.consumerKind, value.consumerId]));
    expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-environment", id: "closed-env" } })).code!.revision).toBe(LEGACY);
  });

  test("several distinct recorded executables are ambiguous, never the newest", async () => {
    await fixture(); await environment("env-1"); await db.prisma.computeEnvironment.update({ where: { id: "env-1" }, data: { state: "running" } });
    for (const [key, revision] of [["old", LEGACY], ["new", A]] as const) await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key, value: receipt(revision, `/install/${key}`) } });
    expect((await inventory()).find(value => value.consumerId === "env-1")!.provenance).toEqual({ unavailable: expect.stringContaining("ambiguous: 2") });
  });

  test("finished consumers are not retained, overflow fails activation, and retained consumers resolve when they finish", async () => {
    await fixture();
    const intent = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: "pause-1", value: "{}" } });
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-complete", key: "pause-1", value: "{}" } });
    for (const action of [FINALIZATION_PREPARED, "finalization-confirmed"]) await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action, key: "finalize:task", value: "{}" } });
    await environment("done-env"); // waiting, no resource, no offers: nothing to account
    expect(await inventory()).toEqual([]);
    // A consumer retained at bootstrap is resolved once its evidence shows it finished.
    await bootstrap([["development-intent", String(intent.sequence)]]);
    expect(await resolveFinishedLegacyConsumers({ prisma: db.prisma, repositoryId: "repo" })).toEqual({ resolved: 1 });
    expect((await db.prisma.toolingLegacyConsumer.findFirstOrThrow()).status).toBe("resolved");
    // Overflow is a failure, not a silent truncation.
    await db.prisma.computeOffer.createMany({ data: Array.from({ length: 1001 }, (_, index) => ({ id: `o-${index}`, environmentId: "done-env", machineId: "host", instructionId: `i-${index}`, dispatchDeadline: new Date() })) });
    await expect(inventory()).rejects.toThrow("exceeds its bound");
  });

  test("two operations racing for one existing record: exactly one reaches effects", async () => {
    const { config } = await fixture(); await bootstrap([]);
    const first = (await begin(config, { requestKey: "f1", inputDigest: canonicalDigest({ requestKey: "finalize:task" }), kind: "finalization" })).binding;
    await activate("release-b", 2);
    const second = (await begin(config, { requestKey: "f2", inputDigest: canonicalDigest({ requestKey: "finalize:task" }), kind: "finalization" })).binding;
    const { call, seen } = app(config);
    const results = await Promise.all([call("/api/tasks/task/cleanup-authority", { requestKey: "finalize:task" }, first.operationId), call("/api/tasks/task/cleanup-authority", { requestKey: "finalize:task" }, second.operationId)]);
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    expect(seen).toHaveLength(1);
  });
});
