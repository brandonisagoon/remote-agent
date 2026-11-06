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
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import {
  FINALIZATION_PREPARED_ACTION, TOOLING_CALLBACKS, TOOLING_CALLBACK_CLASSIFICATION, TOOLING_OPERATION_HEADER, TOOLING_OPERATION_KINDS, beginSessionToolingOperation,
  StateWriteOutcomeUnknown, admitToolingCallback, afterBoundCallback, beforeBoundCallback, type CallbackAdmission, currentToolingOperation, runWithToolingOperation, toolingProcessContext, bindServerContinuation, boundCode, inventoryLegacyToolingConsumers, registerOperationStateWrite, resolveEnvironmentConsumers, resolveFinishedLegacyConsumers, matchToolingCallback, producerOperationId, readSessionToolingOperation, resourceGroupCode,
} from "./tooling-operations.ts";
import { canonicalDigest, confirmToolingConsumer, readToolingOperation, registerToolingStateWrite, retainToolingConsumer, transitionToolingOperation } from "./tooling-releases.ts";
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

test("server continuation derives a command fence from the group's retained reader and keeps its release after activation", async () => {
  const { config } = await fixture();
  await environment("legacy-env"); await environment("env-a");
  await bootstrap([["compute-environment", "legacy-env"]]);
  const request = (requestKey: string) => ({ requestKey, inputDigest: canonicalDigest({ command: "compute continue", requestKey }) });
  expect(await bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "legacy-env", request: request("legacy") }))
    .toEqual({ binding: null, code: { repositoryId: "repo", revision: LEGACY, checkout: `/install/tooling/repo/${LEGACY}` } });
  // Producer A confirmed the group and its retained reader.
  const producer = (await begin(config, { requestKey: "start-a", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key: "producer:compute-environment:env-a",
    value: JSON.stringify({ version: 1, operationId: producer.operationId, role: "producer", state: "confirmed" }) } });
  await expect(bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "env-a", request: request("no-reader") })).rejects.toThrow(/no confirmed retained reader/);
  const reader = await retainToolingConsumer({ prisma: db.prisma, operationId: producer.operationId, consumerKind: "compute-environment", consumerId: "env-a", scopeKey: "task" });
  await confirmToolingConsumer({ prisma: db.prisma, id: reader.id, evidence: { kind: "compute-bind", reference: "offer-a" } });
  await activate("release-b", 2);
  // Both a retry and a fresh continuation after B activates run A, as a command fence.
  const continued = await bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "env-a", request: request("continue-1") });
  expect(continued.binding).toMatchObject({ kind: "adapter-command", release: { revision: A }, retainedConsumerId: reader.id, parentOperationId: null });
  expect((await bindServerContinuation({ prisma: db.prisma, config, task: await task(), environmentId: "env-a", request: request("continue-1") })).binding!.operationId).toBe(continued.binding!.operationId);
  // Its child callbacks inherit A.
  const child = (await begin(config, { requestKey: "continue-1:authority", inputDigest: canonicalDigest({ intentRevision: 1, intentDigest: "a".repeat(64) }), kind: "compute-admission", parentOperationId: continued.binding!.operationId })).binding;
  expect(child.release.revision).toBe(A);
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

test("a completed producer's live resource keeps deferring incompatible writes for its own state until stopped proof", async () => {
  const { config } = await fixture();
  await environment("env-1", computeBody.key); await bootstrap([]);
  // Producer A (v1-only reader) starts the group; its callback operation completes.
  const producer = (await begin(config, { requestKey: "start-a", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  const { call } = app(config);
  expect((await call("/api/tasks/task/compute-request", computeBody, producer.operationId)).status).toBe(200);
  await offer("offer-1", "env-1");
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-1" }, producer.operationId)).status).toBe(200);
  expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, producer.operationId)).status).toBe(200);
  expect((await readToolingOperation({ prisma: db.prisma, operationId: producer.operationId }))!.status).toBe("completed");
  // B migrates drafted.runtime to version 2.
  await db.prisma.toolingRelease.create({ data: { id: "release-v2", repositoryId: "repo", revision: "2".repeat(40), tree: "3".repeat(40), policyBlob: "f".repeat(40), checkout: "/install/v2",
    manifest: { ...manifest, stateFormats: { "drafted.runtime": { read: [1, 2], write: 2, preservesUnknown: true } } }, lockfileDigest: "0".repeat(64), bunVersion: "1.3.0" } });
  await activate("release-v2", 2);
  const migrate = async (taskSession: string, key: string) => {
    const op = (await begin(config, { requestKey: key, inputDigest: canonicalDigest({ argv: ["migrate"] }), kind: "adapter-command" }, taskSession)).binding;
    return { op, write: () => call(`/api/sessions/${taskSession}/tooling-operations/${op.operationId}/state-writes`, { family: "drafted.runtime", scopeKey: "task", version: 2 }, op.operationId) };
  };
  const mine = await migrate("primary", "migrate-task");
  const deferred = await mine.write();
  expect(deferred.status).toBe(409);
  expect(await deferred.json()).toMatchObject({ code: "deferred" });
  const evidence = await (await call(`/api/sessions/primary/tooling-operations/${mine.op.operationId}/state?family=drafted.runtime&scopeKey=task`, undefined, mine.op.operationId, "GET")).json();
  expect(evidence.consumers).toContainEqual({ operationId: producer.operationId, format: manifest.stateFormats["drafted.runtime"] });
  // Only the affected task's state is deferred.
  expect((await (await migrate("other-primary", "migrate-other")).write()).status).toBe(200);
  // Stopped proof ends the reader; the same migration now registers.
  expect(await resolveEnvironmentConsumers(db.prisma, "env-1", { kind: "stopped", reference: "env-1" })).toBe(1);
  expect((await mine.write()).status).toBe(200);
});

test("settlement echoes the exact command, replays the same outcome and never declares unknown effects successful", async () => {
  const { config } = await fixture(); await bootstrap([]);
  const { call } = app(config);
  const fence = async (key: string) => (await begin(config, { requestKey: key, inputDigest: canonicalDigest({ argv: [key] }), kind: "adapter-command", resourceKey: "runtime" })).binding;
  const settle = (operationId: string, body: Record<string, unknown>, header: string | null = operationId) => call(`/api/sessions/primary/tooling-operations/${operationId}/settlement`, body, header ?? undefined);
  const body = (binding: { requestKey: string; inputDigest: string }, outcome: string) => ({ requestKey: binding.requestKey, inputDigest: binding.inputDigest, outcome });
  // A read-only command abandons with no effect, and the same settlement replays.
  const idle = await fence("status");
  expect((await settle(idle.operationId, body(idle, "no-effect"), null)).status).toBe(428);
  expect((await settle(idle.operationId, { ...body(idle, "no-effect"), requestKey: "other" })).status).toBe(409);
  const first = await settle(idle.operationId, body(idle, "no-effect"));
  expect(first.status).toBe(200);
  const settled = await first.json();
  expect(settled).toMatchObject({ outcome: "no-effect", binding: { operationId: idle.operationId, requestKey: idle.requestKey, inputDigest: idle.inputDigest, status: "completed" } });
  expect(await (await settle(idle.operationId, body(idle, "no-effect"))).json()).toEqual(settled);
  expect((await settle(idle.operationId, body(idle, "completed"))).status).toBe(409); // changed outcome
  // A command with children cannot claim no effect; an unknown child blocks success.
  const command = await fence("configure");
  const child = (await begin(config, { requestKey: "configure:request", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: command.operationId })).binding;
  expect((await settle(command.operationId, body(command, "no-effect"))).status).toBe(400);
  await transitionToolingOperation({ prisma: db.prisma, operationId: child.operationId, from: "bound", to: "running" });
  await transitionToolingOperation({ prisma: db.prisma, operationId: child.operationId, from: "running", to: "unknown" });
  expect((await settle(command.operationId, body(command, "completed"))).status).toBe(409);
  // Once reconciled, success settles; a retained reader of its child survives completion.
  await transitionToolingOperation({ prisma: db.prisma, operationId: child.operationId, from: "unknown", to: "completed", evidence: { kind: "compute-bind", reference: "offer" } });
  await environment("env-1");
  const reader = await db.prisma.toolingRetainedConsumer.create({ data: { id: "reader", operationId: child.operationId, repositoryId: "repo", taskId: "task", consumerKind: "compute-environment", consumerId: "env-1", scopeKey: "runtime",
    releaseId: child.release.id, generation: child.generation, protocol: 1, status: "confirmed", evidence: { kind: "compute-bind", reference: "offer" } } });
  expect(await (await settle(command.operationId, body(command, "completed"))).json()).toMatchObject({ outcome: "completed", binding: { status: "completed" } });
  expect((await db.prisma.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: reader.id } })).status).toBe("confirmed");
  await expect(begin(config, { requestKey: "configure:late", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: command.operationId })).rejects.toThrow(/completed/);
});

test("state scopes follow the fence, pause withholds receipts, and post-registration uncertainty is unknown (503), never a refusal", async () => {
  const { config } = await fixture(); await bootstrap([]);
  const { call } = app(config);
  const fence = async (key: string, resourceKey?: string, session = "primary") => (await begin(config, { requestKey: key, inputDigest: canonicalDigest({ argv: [key] }), kind: "adapter-command", ...(resourceKey ? { resourceKey } : {}) }, session)).binding;
  const write = (session: string, operationId: string, scopeKey: string) => call(`/api/sessions/${session}/tooling-operations/${operationId}/state-writes`, { family: "drafted.runtime", scopeKey, version: 1 }, operationId);
  const taskWide = await fence("task-wide");
  expect((await write("primary", taskWide.operationId, "runtime-development")).status).toBe(200);
  const review = await fence("review", "review");
  expect((await write("primary", review.operationId, "runtime-development")).status).toBe(400);
  expect((await write("primary", review.operationId, "review")).status).toBe(200);
  const foreign = await fence("foreign", undefined, "other-primary");
  expect((await write("primary", foreign.operationId, "task")).status).toBe(409);
  expect((await write("primary", taskWide.operationId, "../runtime")).status).toBe(400); // never a path
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  expect((await write("primary", taskWide.operationId, "runtime-development")).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  // Registration records, then the owner pauses before the receipt: unknown.
  const records = () => db.prisma.toolingStateWrite.count({ where: { operationId: taskWide.operationId, scopeKey: "runtime-other" } });
  const outcome = await registerOperationStateWrite({ prisma: db.prisma, config, sessionId: "primary", operationId: taskWide.operationId, header: taskWide.operationId, body: { family: "drafted.runtime", scopeKey: "runtime-other", version: 1 } },
    { read: readToolingOperation, register: async args => { const receipt = await registerToolingStateWrite(args); await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } }); return receipt; } }).catch(error => error);
  expect(outcome).toBeInstanceOf(StateWriteOutcomeUnknown);
  expect(outcome.code).toBe("state-write-outcome-unknown");
  expect(await records()).toBe(1);
});

test("an HTTP refusal never resolves a producing reader; only exact never-claimed proof does", async () => {
  const { config } = await fixture();
  await environment("env-1", computeBody.key); await bootstrap([]);
  await db.prisma.toolingRelease.create({ data: { id: "release-v2", repositoryId: "repo", revision: "2".repeat(40), tree: "3".repeat(40), policyBlob: "f".repeat(40), checkout: "/install/v2",
    manifest: { ...manifest, stateFormats: { "drafted.runtime": { read: [1, 2], write: 2, preservesUnknown: true } } }, lockfileDigest: "0".repeat(64), bunVersion: "1.3.0" } });
  const readers = (status?: string) => db.prisma.toolingRetainedConsumer.findMany({ where: { consumerId: "env-1", ...(status ? { status } : {}) } });
  let bindStatus = 409;
  const { call } = app(config, pathname => pathname.endsWith("compute-bind") ? { status: bindStatus } : pathname.endsWith("compute-claim") ? { status: 409 } : {});
  // A claim refused while its offer was never claimed and is withdrawn: no start authority existed.
  const refused = (await begin(config, { requestKey: "refused", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  expect((await call("/api/tasks/task/compute-request", computeBody, refused.operationId)).status).toBe(200);
  await offer("withdrawn", "env-1"); await db.prisma.computeOffer.update({ where: { id: "withdrawn" }, data: { state: "expired" } });
  expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "withdrawn" }, refused.operationId)).status).toBe(409);
  expect((await readers()).map(row => [row.status, (row.resolution as { kind?: string } | null)?.kind])).toEqual([["resolved", "claim-not-granted"]]);
  // A real start: the claim's reader is pending before the physical effect.
  const producer = (await begin(config, { requestKey: "start", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).binding;
  expect((await call("/api/tasks/task/compute-request", computeBody, producer.operationId)).status).toBe(200);
  await offer("offer-1", "env-1");
  await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-1" }, producer.operationId); // handler refused after its claim committed
  await db.prisma.computeOffer.update({ where: { id: "offer-1" }, data: { state: "claimed", claimedAt: new Date() } });
  // The adapter started the resource; bind then returns 409 (or its reply is lost).
  expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, producer.operationId)).status).toBe(409);
  expect((await readers("pending")).map(row => row.operationId)).toEqual([producer.operationId]);
  await activate("release-v2", 2);
  const migration = (await begin(config, { requestKey: "migrate", inputDigest: canonicalDigest({ argv: ["migrate"] }), kind: "adapter-command" })).binding;
  const migrate = () => call(`/api/sessions/primary/tooling-operations/${migration.operationId}/state-writes`, { family: "drafted.runtime", scopeKey: "task", version: 2 }, migration.operationId);
  expect(await (await migrate()).json()).toMatchObject({ code: "deferred" });
  // A verified bind retry confirms; only stopped proof releases the migration.
  bindStatus = 200;
  expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, producer.operationId)).status).toBe(200);
  expect((await readers("confirmed")).map(row => row.operationId)).toEqual([producer.operationId]);
  expect((await migrate()).status).toBe(409);
  await resolveEnvironmentConsumers(db.prisma, "env-1", { kind: "stopped", reference: "env-1" });
  // The refused claim's own operation is still an unfinished A reader.
  expect(await (await migrate()).json()).toMatchObject({ code: "deferred", error: expect.stringContaining(refused.operationId) });
  await transitionToolingOperation({ prisma: db.prisma, operationId: refused.operationId, from: "running", to: "completed", evidence: { kind: "compute-decline", reference: "withdrawn" } });
  expect((await migrate()).status).toBe(200);
});

test("settlement completes only acknowledged callbacks atomically and cannot race a new child", async () => {
  const { config } = await fixture(); await bootstrap([]);
  let status = 200;
  const { call } = app(config, () => ({ status }));
  const fence = async (key: string) => (await begin(config, { requestKey: key, inputDigest: canonicalDigest({ argv: [key] }), kind: "adapter-command" })).binding;
  const child = (parent: string, key: string) => begin(config, { requestKey: key, inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: parent });
  const settle = (binding: { operationId: string; requestKey: string; inputDigest: string }, outcome: string) => call(`/api/sessions/primary/tooling-operations/${binding.operationId}/settlement`,
    { requestKey: binding.requestKey, inputDigest: binding.inputDigest, outcome }, binding.operationId);
  const read = (id: string) => readToolingOperation({ prisma: db.prisma, operationId: id });
  // Race: a no-effect settlement and a child begin never both succeed.
  const racing = await fence("race");
  const [settled, begun] = await Promise.allSettled([settle(racing, "no-effect"), child(racing.operationId, "race:child")]);
  const settledOk = settled.status === "fulfilled" && settled.value.status === 200, childOk = begun.status === "fulfilled";
  expect(settledOk && childOk).toBe(false);
  expect(settledOk || childOk).toBe(true);
  // A running child whose callback was refused has no confirmed outcome: success is refused and nothing commits.
  const refused = await fence("refused");
  const noAck = (await child(refused.operationId, "refused:request")).binding;
  status = 409;
  expect((await call("/api/tasks/task/compute-request", computeBody, noAck.operationId)).status).toBe(409);
  expect((await read(noAck.operationId))!.status).toBe("running");
  expect((await settle(refused, "completed")).status).toBe(409);
  expect((await read(refused.operationId))!.status).toBe("bound");
  expect((await read(noAck.operationId))!.status).toBe("running");
  // An acknowledged callback completes with the command; its reader survives.
  const done = await fence("done");
  const acked = (await child(done.operationId, "done:request")).binding;
  status = 200;
  expect((await call("/api/tasks/task/compute-request", computeBody, acked.operationId)).status).toBe(200);
  await environment("env-r");
  const reader = await retainToolingConsumer({ prisma: db.prisma, operationId: acked.operationId, consumerKind: "compute-environment", consumerId: "env-r", scopeKey: "task" });
  await confirmToolingConsumer({ prisma: db.prisma, id: reader.id, evidence: { kind: "compute-bind", reference: "offer-r" } });
  expect(await (await settle(done, "completed")).json()).toMatchObject({ outcome: "completed", binding: { operationId: done.operationId, status: "completed" } });
  expect((await read(acked.operationId))!.status).toBe("completed");
  expect((await db.prisma.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: reader.id } })).status).toBe("confirmed");
});

describe("review of 5eb3b2c", () => {
  test("runtime renewals repeat claim and bind within one command; settlement completes the child and later replays are refused", async () => {
    const { config } = await fixture(); await environment("env-1", computeBody.key); await bootstrap([]);
    const { call } = app(config);
    const fence = (await begin(config, { requestKey: "runtime-up", inputDigest: canonicalDigest({ argv: ["runtime", "up"] }), kind: "adapter-command" })).binding;
    const admissionChild = (await begin(config, { requestKey: "runtime-up/compute-admission", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: fence.operationId })).binding;
    expect((await call("/api/tasks/task/compute-request", computeBody, admissionChild.operationId)).status).toBe(200);
    await offer("offer-1", "env-1");
    for (let save = 0; save < 2; save++) {
      expect((await call("/api/tasks/task/compute-claim", { ...computeBody, offerId: "offer-1" }, admissionChild.operationId)).status).toBe(200);
      expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, admissionChild.operationId)).status).toBe(200);
      expect((await readToolingOperation({ prisma: db.prisma, operationId: admissionChild.operationId }))!.status).toBe("running");
    }
    expect(await producerOperationId(db.prisma, await task(), "env-1")).toBe(admissionChild.operationId);
    expect(await db.prisma.toolingRetainedConsumer.count({ where: { consumerId: "env-1", status: "confirmed" } })).toBe(1);
    const settled = await call(`/api/sessions/primary/tooling-operations/${fence.operationId}/settlement`, { requestKey: fence.requestKey, inputDigest: fence.inputDigest, outcome: "completed" }, fence.operationId);
    expect(settled.status).toBe(200);
    expect((await readToolingOperation({ prisma: db.prisma, operationId: admissionChild.operationId }))!.status).toBe("completed");
    expect((await call("/api/tasks/task/compute-bind", { offerId: "offer-1", resourceKey: "runtime" }, admissionChild.operationId)).status).toBe(409);
    expect(await db.prisma.toolingRetainedConsumer.count({ where: { consumerId: "env-1", status: "confirmed" } })).toBe(1);
  });

  test("bound observers receive operation, socket, task and session context; unbound ones receive none", async () => {
    const { config } = await fixture(); await bootstrap([]);
    const binding = (await begin(config, { requestKey: "observe", inputDigest: canonicalDigest({}), kind: "adapter-command" })).binding;
    const expected = { REMOTE_AGENT_TOOLING_OPERATION: binding.operationId, REMOTE_AGENT_SOCKET: "/tmp/control.sock", REMOTE_AGENT_TASK_ID: "task", REMOTE_AGENT_SESSION_ID: "primary" };
    expect(toolingProcessContext(binding, "/tmp/control.sock")).toEqual(expected);
    expect(await runWithToolingOperation(binding, async () => toolingProcessContext(currentToolingOperation()), "/tmp/control.sock")).toEqual(expected);
    expect(() => toolingProcessContext(binding)).toThrow("no control socket");
    expect(toolingProcessContext(null)).toEqual({});
  });

  test("a closed task continues only its own exact cleanup lineage; other commands get no authority", async () => {
    const { config } = await fixture(); await bootstrap([]);
    const closedAt = new Date();
    await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed", closedAt } });
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed", connectionId: config.activeConnectionId, issueIdentifier: "DRA-1" } });
    const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: "primary", provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-1", relationship: "handles", endedAt: closedAt } });
    const fence = (key: string, extra: Record<string, unknown> = {}) => begin(config, { requestKey: key, inputDigest: canonicalDigest({ argv: [key] }), kind: "adapter-command", ...extra });
    const cleanup = { existingOperationId: "finalize:task" };
    await expect(fence("destroy", cleanup)).rejects.toThrow(/original operation recorded before settled primary closure/);
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: "finalization-cleanup-started", key: "finalize:task", value: "{}", occurredAt: new Date(closedAt.getTime() - 1000) } });
    // runtime up / migrate-state on a closed task: no fence, so no effect or state authority.
    await expect(fence("runtime-up")).rejects.toThrow(/must name its cleanup operation/);
    await expect(fence("migrate-state", { resourceKey: "runtime" })).rejects.toThrow(/must name its cleanup operation/);
    await expect(begin(config, { requestKey: "new-compute", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).rejects.toThrow(/Task is closed/);
    // The exact cleanup command and its finalization continue.
    const destroy = (await fence("destroy", cleanup)).binding;
    expect((await begin(config, { requestKey: "destroy/finalization", inputDigest: canonicalDigest({ requestKey: "finalize:task" }), kind: "finalization", parentOperationId: destroy.operationId })).binding.kind).toBe("finalization");
    await expect(begin(config, { requestKey: "destroy/other", inputDigest: canonicalDigest({ requestKey: "finalize:other" }), kind: "finalization", parentOperationId: destroy.operationId })).rejects.toThrow(/only continues finalization finalize:task/);
    const { call } = app(config);
    const evidence = () => call(`/api/sessions/primary/tooling-operations/${destroy.operationId}/state?family=drafted.runtime&scopeKey=task`, undefined, destroy.operationId, "GET");
    expect((await evidence()).status).toBe(200);
    // Shared ownership still binds: pause, revocation, unconfigured repository.
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    expect((await evidence()).status).toBe(409);
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
    await db.prisma.runtimeSessionResourceLink.delete({ where: { id: link.id } });
    expect((await evidence()).status).toBe(409);
    await expect(fence("destroy-2", cleanup)).rejects.toThrow(/revoked/);
  });

  test("the task read names its exact latest prepared finalization key", async () => {
    const { config } = await fixture();
    const server = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const read = async () => (await (await server.request("http://localhost/api/tasks/task")).json() as { task: { latestFinalizationKey: string | null } }).task.latestFinalizationKey;
    expect(await read()).toBeNull();
    for (const key of ["finalize:task", "finalize:task:2"]) await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key, value: "{}" } });
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "other-primary", source: "finalizer:other", action: FINALIZATION_PREPARED, key: "finalize:other", value: "{}" } });
    expect(await read()).toBe("finalize:task:2");
  });
});

test("settlement trusts only the latest callback attempt's own acknowledgment", async () => {
  const { config } = await fixture(); await bootstrap([]);
  const fence = (await begin(config, { requestKey: "runtime-up", inputDigest: canonicalDigest({ argv: ["runtime", "up"] }), kind: "adapter-command" })).binding;
  const child = (await begin(config, { requestKey: "runtime-up/request", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: fence.operationId })).binding;
  const admit = async () => (await admitToolingCallback({ prisma: db.prisma, config, method: "POST", pathname: "/api/tasks/task/compute-request", header: child.operationId, body: computeBody })) as Extract<CallbackAdmission, { mode: "bound" }>;
  const { call } = app(config);
  const settle = () => call(`/api/sessions/primary/tooling-operations/${fence.operationId}/settlement`, { requestKey: fence.requestKey, inputDigest: fence.inputDigest, outcome: "completed" }, fence.operationId);
  // Attempt 1 acknowledged; attempt 2 starts (non-producing callback) and is still in flight.
  const one = await admit(), first = await beforeBoundCallback(db.prisma, config, one); await afterBoundCallback(db.prisma, one, first, 200);
  const two = await admit(), second = await beforeBoundCallback(db.prisma, config, two);
  expect((await settle()).status).toBe(409);
  // Attempt 3 starts; attempt 2's slower acknowledgment cannot cover it.
  const three = await admit(), third = await beforeBoundCallback(db.prisma, config, three);
  await afterBoundCallback(db.prisma, two, second, 200);
  expect((await settle()).status).toBe(409);
  expect((await readToolingOperation({ prisma: db.prisma, operationId: fence.operationId }))!.status).toBe("bound");
  await afterBoundCallback(db.prisma, three, third, 200);
  expect((await settle()).status).toBe(200);
  expect((await readToolingOperation({ prisma: db.prisma, operationId: child.operationId }))!.status).toBe("completed");
});

describe("settlement concurrency (review of f38d564)", () => {
  async function command() {
    const { config } = await fixture(); await bootstrap([]);
    const fence = (await begin(config, { requestKey: "runtime-up", inputDigest: canonicalDigest({ argv: ["runtime", "up"] }), kind: "adapter-command" })).binding;
    const child = (await begin(config, { requestKey: "runtime-up/request", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: fence.operationId })).binding;
    const admit = async () => (await admitToolingCallback({ prisma: db.prisma, config, method: "POST", pathname: "/api/tasks/task/compute-request", header: child.operationId, body: computeBody })) as Extract<CallbackAdmission, { mode: "bound" }>;
    const { call } = app(config);
    const settle = () => call(`/api/sessions/primary/tooling-operations/${fence.operationId}/settlement`, { requestKey: fence.requestKey, inputDigest: fence.inputDigest, outcome: "completed" }, fence.operationId);
    return { config, fence, child, admit, settle };
  }

  test("A: an older in-flight or unknown attempt cannot hide behind a newer acknowledgment", async () => {
    const { config, admit, settle } = await command();
    const a = await admit(), older = await beforeBoundCallback(db.prisma, config, a); // in flight
    const b = await admit(), newer = await beforeBoundCallback(db.prisma, config, b);
    await afterBoundCallback(db.prisma, b, newer, 200);
    expect((await settle()).status).toBe(409);
    await afterBoundCallback(db.prisma, a, older, "exception"); // unknown outcome
    const c = await admit(), latest = await beforeBoundCallback(db.prisma, config, c); await afterBoundCallback(db.prisma, c, latest, 200);
    expect((await settle()).status).toBe(409); // unknown older attempt still outstanding
  });

  test("A: every attempt definite and the latest acknowledged settles", async () => {
    const { config, child, admit, settle } = await command();
    const a = await admit(), older = await beforeBoundCallback(db.prisma, config, a);
    const b = await admit(), newer = await beforeBoundCallback(db.prisma, config, b);
    await afterBoundCallback(db.prisma, b, newer, 200);
    await afterBoundCallback(db.prisma, a, older, 200);
    expect((await settle()).status).toBe(200);
    expect((await readToolingOperation({ prisma: db.prisma, operationId: child.operationId }))!.status).toBe("completed");
  });

  test("B: a callback admitted before settlement cannot start after it", async () => {
    const { config, child, admit, settle } = await command();
    const done = await admit(), first = await beforeBoundCallback(db.prisma, config, done); await afterBoundCallback(db.prisma, done, first, 200);
    const stale = await admit(); // read before settlement
    expect((await settle()).status).toBe(200);
    await expect(beforeBoundCallback(db.prisma, config, stale)).rejects.toThrow(/completed/);
    const intents = (await db.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${child.operationId}` } })).map(event => JSON.parse(event.value!).state);
    expect(intents.filter(state => state === "intent")).toHaveLength(1); // the refused attempt left no intent
  });

  test("B: a callback whose intent is recorded first blocks settlement until it is definite", async () => {
    const { config, admit, settle } = await command();
    const running = await admit(), attempt = await beforeBoundCallback(db.prisma, config, running);
    expect((await settle()).status).toBe(409);
    await afterBoundCallback(db.prisma, running, attempt, 200);
    expect((await settle()).status).toBe(200);
  });
});
