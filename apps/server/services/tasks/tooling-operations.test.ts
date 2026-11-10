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
import { configurationAttemptCode } from "./tooling-operations.ts";

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

test("guarded configuration observes its own pending producer and replays across lock PIDs; ordinary collectors refuse it", async () => {
  const { config } = await fixture();
  await bootstrap([]); await environment("configure-env"); await offer("configure-offer", "configure-env");
  const body = { offerId: "configure-offer", resourceKey: "runtime-development", recipeHash: "next", lockPid: 123 };
  const { lockPid: _pid, ...stable } = body;
  const { binding } = await begin(config, { requestKey: "configure", kind: "compute-configure", existingOperationId: body.offerId, inputDigest: canonicalDigest(stable) });
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  server.use("/api/*", toolingOperationGuard());
  let runs = 0;
  server.post("/api/tasks/task/compute-configure", async c => {
    const owner = await task(), request = await c.req.json();
    if (++runs === 1) await expect(producerOperationId(db.prisma, owner, "configure-env")).rejects.toThrow("unconfirmed producer");
    const selected = await configurationAttemptCode(db.prisma, owner, "configure-env", request);
    expect(selected?.binding.operationId).toBe(binding.operationId);
    expect(selected?.code.revision).toBe(A);
    await expect(configurationAttemptCode(db.prisma, owner, "configure-env", { ...request, recipeHash: "foreign" })).rejects.toThrow("exact guarded attempt");
    await expect(configurationAttemptCode(db.prisma, owner, "other-environment", request)).rejects.toThrow("another allocation");
    return c.json({ verified: true });
  });
  for (const lockPid of [123, 456]) {
    const response = await server.request("/api/tasks/task/compute-configure", { method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: binding.operationId }, body: JSON.stringify({ ...body, lockPid }) });
    expect(response.status).toBe(200);
  }
  expect(runs).toBe(2);
  expect(await configurationAttemptCode(db.prisma, await task(), "configure-env", body)).toBeUndefined();
  expect(await producerOperationId(db.prisma, await task(), "configure-env")).toBe(binding.operationId);
});

test("a declined standalone admission can re-admit its exact request under a new operation", async () => {
  const { config } = await fixture();
  const { ComputePolicy } = await import("../../../../lib/compute-policy.ts");
  config.compute = ComputePolicy.parse({ enabled: true, slots: 1 });
  await bootstrap([]);
  const runtime = createFakeAgentRuntime([{ id: "primary", status: "idle", role: "primary", cwd: "/fixture/primary", repositoryId: "repo", machineId: "host" }]);
  const server = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const call = (suffix: string, body: unknown, operationId: string) => server.request(`/api/tasks/task/${suffix}`, {
    method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: operationId }, body: JSON.stringify(body),
  });
  const { scheduleComputeOffers } = await import("./compute-admission.ts");
  const context = { prisma: db.prisma, config, machineId: config.machine, policy: config.compute, runtime };
  const first = (await begin(config, { requestKey: "first-command", kind: "compute-admission", inputDigest: canonicalDigest(computeBody) })).binding;
  expect((await call("compute-request", computeBody, first.operationId)).status).toBe(202);
  await scheduleComputeOffers(context);
  const original = await db.prisma.computeOffer.findFirstOrThrow();
  expect((await call("compute-decline", { offerId: original.id }, first.operationId)).status).toBe(200);
  const completed = await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: first.operationId } });
  expect(completed.status).toBe("completed");
  const originalAfter = await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: original.id } });
  expect(originalAfter.state).toBe("declined");
  await scheduleComputeOffers(context);
  const next = await db.prisma.computeOffer.findFirstOrThrow({ where: { environmentId: original.environmentId, state: "queued" } });
  const environmentBefore = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: original.environmentId } });
  expect(next.id).not.toBe(original.id);
  const closed = await call("compute-decline", { offerId: next.id }, first.operationId);
  expect(closed.status).toBe(409);
  expect(await closed.json()).toMatchObject({ code: "operation-closed" });
  await expect(begin(config, { requestKey: "decline-existing-offer", kind: "compute-admission", existingOperationId: next.id,
    inputDigest: canonicalDigest({ existingOperationId: next.id }) })).rejects.toThrow(/belongs to operation/);

  // A fresh request, not adoption or replay of the completed operation, is
  // the supported same-release boundary. The exact recipe stays unchanged.
  const second = (await begin(config, { requestKey: "next-command", kind: "compute-admission", inputDigest: canonicalDigest(computeBody) })).binding;
  expect(second.operationId).not.toBe(first.operationId);
  expect((await call("compute-request", computeBody, second.operationId)).status).toBe(202);
  expect(await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: original.environmentId } })).toEqual(environmentBefore);
  expect((await call("compute-decline", { offerId: next.id }, second.operationId)).status).toBe(200);
  expect(await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: first.operationId } })).toEqual(completed);
  expect(await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: original.id } })).toEqual(originalAfter);
  expect(await db.prisma.computeOffer.count({ where: { claimedAt: { not: null } } })).toBe(0);
  expect(await db.prisma.computeSlot.count({ where: { allocationId: next.id } })).toBe(0);
}, 30_000);

test("every adapter callback is classified: effects are bound, owner controls and evidence are justified", () => {
  // The paired Drafted control client (src/control.ts taskRegistry) surface.
  const drafted = ["POST /api/tasks/:taskId/compute-request", "POST /api/tasks/:taskId/compute-claim", "POST /api/tasks/:taskId/compute-bind", "POST /api/tasks/:taskId/compute-configure", "POST /api/tasks/:taskId/compute-neon-recovery",
    "POST /api/tasks/:taskId/prepare-finalization", "POST /api/sessions/:sessionId/prepare-finalization", "POST /api/tasks/:taskId/cleanup-authority", "POST /api/tasks/:taskId/cleanup-inventory-ownership",
    "POST /api/tasks/:taskId/automation", "POST /api/tasks/:taskId/development-authority", "POST /api/tasks/:taskId/development-complete", "POST /api/tasks/:taskId/confirm-finalization",
    "POST /api/sessions/:sessionId/confirm-finalization", "POST /api/tasks/:taskId/cleanup-progress", "POST /api/tasks/:taskId/cleanup-status", "POST /api/tasks/:taskId/cleanup-report",
    "POST /api/sessions/:sessionId/legacy-evidence", "POST /api/sessions/:sessionId/local-service-stop-authority", "POST /api/sessions/:sessionId/browser-stop-authority",
    "POST /api/sessions/:sessionId/archive-retention", "PUT /api/sessions/:sessionId/task/resources", "POST /api/sessions/:sessionId/task/runtime-health", "POST /api/tasks/:taskId/cleanup-request", "POST /api/sessions/:sessionId/tooling-capability"];
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

/** Real routes and guard across activation; physical observation and turn
 * delivery are explicit fixtures, not physical adapter acceptance. */
test.each(["same-command", "later-command", "unknown-before-claim", "expired-adoption", "expired-adoption-claimed", "expired-adoption-unknown-route", "expired-adoption-confirmed-reader", "expired-adoption-producer"])("active-release saved admission %s confirms a producer only after guarded bind", async mode => {
  const { config } = await fixture();
  const { ComputePolicy } = await import("../../../../lib/compute-policy.ts");
  const { savedComputeDigest } = await import("./compute-saved-resource.ts");
  const { finalizationResourceIdentity } = await import("./finalization-resources.ts");
  const { environmentCode } = await import("./compute-observer.ts");
  const { recordComputeObservation } = await import("./compute-observation.ts");
  const { scheduleComputeOffers, confirmComputeDelivery, reconcileObservedCompute } = await import("./compute-admission.ts");
  config.compute = ComputePolicy.parse({ enabled: true, slots: 1 });
  await bootstrap([]);
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "saved-container", kind: "docker-container", purpose: "development",
    externalId: "e".repeat(64), state: "allocated", metadata: { image: `sha256:${"f".repeat(64)}` } } });
  const saved = { resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest };
  const request = { ...computeBody, key: resource.key, saved, recipeDigest: savedComputeDigest(saved) };
  const runtime = createFakeAgentRuntime([{ id: "primary", status: "idle", role: "primary", cwd: "/fixture/primary", repositoryId: "repo", machineId: "host" }]);
  const server = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const call = (suffix: string, body: unknown, operationId: string) => server.request(`/api/tasks/task/${suffix}`, {
    method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: operationId }, body: JSON.stringify(body),
  });
  let command = (await begin(config, { requestKey: "saved-command-a", kind: "adapter-command", inputDigest: canonicalDigest({ action: "resume", key: request.key }) })).binding;
  let operation = (await begin(config, { requestKey: "saved-request", kind: "compute-admission", parentOperationId: command.operationId, inputDigest: canonicalDigest(request) })).binding;
  const settle = () => server.request(`/api/sessions/primary/tooling-operations/${command.operationId}/settlement`, {
    method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: command.operationId }, body: JSON.stringify({ requestKey: command.requestKey, inputDigest: command.inputDigest, outcome: "completed" }),
  });
  expect((await call("compute-request", request, operation.operationId)).status).toBe(202);
  const env = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: resource.key } } });
  if (mode === "unknown-before-claim") await db.prisma.computeEnvironment.update({ where: { id: env.id }, data: { state: "unknown" } });
  if ((mode === "later-command" || mode.startsWith("expired-adoption"))) expect((await settle()).status).toBe(200);
  await activate("release-b", 2);
  const taskRow = await task(), code = () => environmentCode(db.prisma, taskRow, env);
  expect(currentToolingOperation()).toBeUndefined();
  expect((await code()).binding?.operationId).toBe(operation.operationId);
  expect((await code()).code?.revision).toBe(A);
  expect(await producerOperationId(db.prisma, taskRow, env.id)).toBeNull();
  expect(await db.prisma.toolingRetainedConsumer.count()).toBe(0);
  // Neither a changed request nor changed physical identity can borrow A or B.
  await db.prisma.computeEnvironment.update({ where: { id: env.id }, data: { revision: B } });
  await expect(code()).rejects.toThrow(/unclaimed admission/);
  await db.prisma.computeEnvironment.update({ where: { id: env.id }, data: { revision: env.revision } });
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { externalId: "1".repeat(64) } });
  await expect(code()).rejects.toThrow(/resource ownership changed/);
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { externalId: resource.externalId, updatedAt: resource.updatedAt } });
  const context = { prisma: db.prisma, config, machineId: config.machine, policy: config.compute, runtime };
  await scheduleComputeOffers(context);
  expect(await db.prisma.computeOffer.count()).toBe(0); // provenance is not stopped proof
  await recordComputeObservation({ prisma: db.prisma, config, environmentId: env.id, observation: {
    version: 1, environmentId: env.id, taskId: "task", primarySessionId: "primary", purpose: "development", revision: request.revision,
    recipeDigest: request.recipeDigest, resourceId: resource.id, resourceIdentity: saved.resourceIdentity, configurationDigest: request.recipeDigest,
    state: "stopped", observedAt: Date.now(), coverage: "incomplete", routes: [], operations: { coverage: "incomplete", active: 0, generation: "0".repeat(64) },
  } });
  if (mode === "unknown-before-claim") {
    expect(await reconcileObservedCompute({ ...context, environmentId: env.id })).toEqual({ released: true });
    expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: env.id } })).state).toBe("suspended");
    expect((await code()).code?.revision).toBe(A); // collection can keep refreshing while capacity is unavailable
  }
  await scheduleComputeOffers(context);
  const assignment = await db.prisma.computeOffer.findFirstOrThrow();
  await db.prisma.runtimeInstruction.update({ where: { id: assignment.instructionId }, data: { state: "dispatching", executionRequestId: assignment.instructionId } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "saved-delivery", runtimeSessionId: "primary", requestId: assignment.instructionId, phase: "started", occurredAt: new Date() } });
  await confirmComputeDelivery({ ...context, sessionId: "primary", requestId: assignment.instructionId });
  if ((mode === "later-command" || mode.startsWith("expired-adoption"))) {
    command = (await begin(config, { requestKey: "saved-command-b", kind: "adapter-command", inputDigest: canonicalDigest({ action: "resume", key: request.key, offer: assignment.id }) })).binding;
    operation = (await begin(config, { requestKey: "saved-claim-b", kind: "compute-admission", parentOperationId: command.operationId,
      existingOperationId: assignment.id, inputDigest: canonicalDigest(request) })).binding;
  }
  if (mode.startsWith("expired-adoption")) {
    config.compute.slots = 0; // The real guarded claim retains validation when capacity disappears.
    const refused = await call("compute-claim", { ...request, offerId: assignment.id }, operation.operationId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "compute_capacity_blocked" });
    await expect(code()).rejects.toThrow(/unclaimed admission/);
    expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "pending" } })).toBe(1);
    const failed = await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(failed.state).toBe("validating");
    expect(failed.claimedAt).toBeNull();
    const { reconcileWithdrawnComputeClaims } = await import("./tooling-operations.ts");
    await reconcileWithdrawnComputeClaims(db.prisma, "host");
    expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "pending" } })).toBe(1); // validating is never no-effect proof
    const claimCommand = command, claimOperation = operation;
    const originalAttempts = await db.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${operation.operationId}` }, orderBy: { sequence: "asc" } });
    if (mode === "expired-adoption-claimed") await db.prisma.computeOffer.update({ where: { id: assignment.id }, data: { claimedAt: new Date() } });
    if (mode === "expired-adoption-unknown-route") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key: `outcome:${operation.operationId}`,
      value: JSON.stringify({ operationId: operation.operationId, inputDigest: operation.inputDigest, state: "unknown", attemptId: "other", route: "POST /api/tasks/:taskId/compute-bind" }) } });
    if (mode === "expired-adoption-confirmed-reader") await db.prisma.toolingRetainedConsumer.updateMany({ where: { operationId: operation.operationId }, data: { status: "confirmed", confirmedAt: new Date(), evidence: { kind: "compute-bind", reference: assignment.id } } });
    if (mode === "expired-adoption-producer") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key: `producer:compute-environment:${env.id}`,
      value: JSON.stringify({ version: 1, role: "producer", state: "intent", operationId: operation.operationId }) } });
    const { reconcileComputeOffers } = await import("./compute-admission.ts");
    await reconcileComputeOffers({ ...context, now: new Date(failed.validationExpiresAt!.getTime() + 1) });
    expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: assignment.id } })).state).toBe("expired");
    if (mode !== "expired-adoption") {
      expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: operation.operationId } })).status).toBe("running");
      expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "resolved" } })).toBe(0);
      await expect(code()).rejects.toThrow();
      return;
    }
    expect((await code()).code?.revision).toBe(A);
    expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "pending" } })).toBe(0);
    expect(await producerOperationId(db.prisma, taskRow, env.id)).toBeNull();
    expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: operation.operationId } })).completionEvidence).toEqual({ kind: "compute-claim-not-granted", reference: assignment.id });
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${operation.operationId}` }, orderBy: { sequence: "asc" } })).toEqual(originalAttempts);
    const count = await db.prisma.runtimeMetadataEvent.count();
    await reconcileWithdrawnComputeClaims(db.prisma, "host");
    expect(await db.prisma.runtimeMetadataEvent.count()).toBe(count); // repeat/restart is idempotent
    expect((await settle()).status).toBe(200); // parent records completion only through its normal endpoint
    expect((await call("compute-claim", { ...request, offerId: assignment.id }, operation.operationId)).status).toBe(409);
    config.compute.slots = 1;
    await db.prisma.runtimeInstruction.update({ where: { id: assignment.instructionId }, data: { state: "completed" } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: "saved-failed-turn-ended", runtimeSessionId: "primary", requestId: assignment.instructionId, phase: "completed", occurredAt: new Date() } });
    // The earlier simulated expiry was in the future; restore only fixture time.
    await db.prisma.computeWait.update({ where: { environmentId: env.id }, data: { eligibleAt: new Date(0) } });
    await scheduleComputeOffers(context);
    const next = await db.prisma.computeOffer.findFirstOrThrow({ where: { state: "queued" } });
    await db.prisma.runtimeInstruction.update({ where: { id: next.instructionId }, data: { state: "dispatching", executionRequestId: next.instructionId } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: "saved-next-delivery", runtimeSessionId: "primary", requestId: next.instructionId, phase: "started", occurredAt: new Date() } });
    await confirmComputeDelivery({ ...context, sessionId: "primary", requestId: next.instructionId });
    command = (await begin(config, { requestKey: "saved-command-retry", kind: "adapter-command", inputDigest: canonicalDigest({ offer: next.id }) })).binding;
    operation = (await begin(config, { requestKey: "saved-claim-retry", kind: "compute-admission", parentOperationId: command.operationId, existingOperationId: next.id, inputDigest: canonicalDigest(request) })).binding;
    expect((await call("compute-claim", { ...request, offerId: next.id }, operation.operationId)).status).toBe(200);
    expect((await call("compute-bind", { offerId: next.id, resourceKey: resource.key }, operation.operationId)).status).toBe(200);
    expect((await code()).code?.revision).toBe(B);
    expect((await settle()).status).toBe(200);
    expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: claimCommand.operationId } })).status).toBe("completed");
    expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: claimOperation.operationId } })).completionEvidence).toEqual({ kind: "compute-claim-not-granted", reference: assignment.id });
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
    return;
  }
  const claim = await call("compute-claim", { ...request, offerId: assignment.id }, operation.operationId);
  expect(await claim.clone().json()).not.toHaveProperty("error");
  expect(claim.status).toBe(200);
  expect(await producerOperationId(db.prisma, taskRow, env.id)).toBeNull();
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "pending" } })).toBe(1);
  await expect(code()).rejects.toThrow(/unclaimed admission/);
  expect((await settle()).status).toBe(409); // a claimed pending reader cannot be settled as completed
  const wrong = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "other-container", kind: "docker-container", purpose: "development", externalId: "1".repeat(64), state: "allocated" } });
  expect((await call("compute-bind", { offerId: assignment.id, resourceKey: wrong.key }, operation.operationId)).status).toBe(409);
  expect(await producerOperationId(db.prisma, taskRow, env.id)).toBeNull();
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "pending" } })).toBe(1);
  const bound = await call("compute-bind", { offerId: assignment.id, resourceKey: resource.key }, operation.operationId);
  expect(bound.status).toBe(200);
  expect(await bound.json()).toMatchObject({ environmentId: env.id, resourceId: resource.id, resourceIdentity: saved.resourceIdentity });
  expect(await producerOperationId(db.prisma, taskRow, env.id)).toBe(operation.operationId);
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "pending" } })).toBe(0);
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { status: "confirmed" } })).toBe(1);
  expect((await code()).code?.revision).toBe(mode === "later-command" ? B : A);
  expect((await settle()).status).toBe(200);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
});

test.each(["admission-unknown", "callback-unknown", "producer-unknown", "claimed-history", "uncertain-grant", "task-pin"])("saved collector refuses %s instead of borrowing the active release", async changed => {
  const { config } = await fixture();
  const { ComputePolicy } = await import("../../../../lib/compute-policy.ts");
  const { savedComputeDigest } = await import("./compute-saved-resource.ts");
  const { finalizationResourceIdentity } = await import("./finalization-resources.ts");
  const { environmentCode } = await import("./compute-observer.ts");
  config.compute = ComputePolicy.parse({ enabled: true, slots: 1 }); await bootstrap([]);
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "saved", kind: "docker-container", purpose: "development", externalId: "e".repeat(64), state: "allocated" } });
  const saved = { resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest };
  const request = { ...computeBody, key: resource.key, saved, recipeDigest: savedComputeDigest(saved) };
  const operation = (await begin(config, { requestKey: "request", kind: "compute-admission", inputDigest: canonicalDigest(request) })).binding;
  const server = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  expect((await server.request("/api/tasks/task/compute-request", { method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: operation.operationId }, body: JSON.stringify(request) })).status).toBe(202);
  const env = await db.prisma.computeEnvironment.findFirstOrThrow();
  await activate("release-b", 2);
  if (changed === "admission-unknown" || changed === "producer-unknown") {
    const role = changed === "admission-unknown" ? "admission" : "producer";
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association",
      key: role === "admission" ? "admission:environment-key:saved" : `producer:compute-environment:${env.id}`,
      value: JSON.stringify({ version: 1, operationId: operation.operationId, role, state: "intent" }) } });
  }
  if (changed === "callback-unknown") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key: `outcome:${operation.operationId}`,
    value: JSON.stringify({ version: 1, operationId: operation.operationId, role: "outcome", state: "intent", attemptId: "lost", route: "POST /api/tasks/:taskId/compute-request", inputDigest: operation.inputDigest }) } });
  if (changed === "claimed-history") await db.prisma.computeOffer.create({ data: { id: "old-claim", environmentId: env.id, machineId: "host", instructionId: "old-claim", dispatchDeadline: new Date(), claimedAt: new Date(), state: "stopped", completedAt: new Date() } });
  if (changed === "uncertain-grant") {
    await db.prisma.computeEnvironment.update({ where: { id: env.id }, data: { state: "unknown" } });
    await db.prisma.computeOffer.create({ data: { id: "uncertain", environmentId: env.id, machineId: "host", instructionId: "uncertain", dispatchDeadline: new Date(), state: "unknown" } });
  }
  if (changed === "task-pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: B } });
  await expect(environmentCode(db.prisma, await task(), env)).rejects.toThrow();
  expect(await db.prisma.toolingRetainedConsumer.count()).toBe(0);
});

test("measured Studio resume binds only its exact acknowledged enrollment across activation", async () => {
  const { config } = await fixture();
  const { ComputePolicy } = await import("../../../../lib/compute-policy.ts");
  const { savedComputeDigest } = await import("./compute-saved-resource.ts");
  const { finalizationResourceIdentity } = await import("./finalization-resources.ts");
  const { enrollCompute, ComputeEnrollment } = await import("./compute-enrollment.ts");
  const { scheduleComputeOffers, confirmComputeDelivery } = await import("./compute-admission.ts");
  config.compute = ComputePolicy.parse({ enabled: true, slots: 1 }); await bootstrap([]);
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "studio", kind: "docker-compose-project", purpose: "development", externalId: "task-owned-studio", state: "allocated" } });
  const identity = finalizationResourceIdentity(resource).identityDigest;
  const saved = { resourceId: resource.id, resourceIdentity: identity };
  const runtime = createFakeAgentRuntime([{ id: "primary", status: "idle", role: "primary", cwd: "/fixture/primary", repositoryId: "repo", machineId: "host" }]);
  const server = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const call = (suffix: string, body: unknown, operationId: string) => server.request(`/api/tasks/task/${suffix}`, {
    method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: operationId }, body: JSON.stringify(body),
  });
  const initial = { ...computeBody, key: resource.key, saved, recipeDigest: savedComputeDigest(saved) };
  const requested = (await begin(config, { requestKey: "studio-initial", kind: "compute-admission", inputDigest: canonicalDigest(initial) })).binding;
  expect((await call("compute-request", initial, requested.operationId)).status).toBe(202);
  const env = await db.prisma.computeEnvironment.findFirstOrThrow();
  const enrolled = { ...computeBody, key: resource.key, environmentId: env.id, resourceIdentity: identity,
    configuration: { configurationFile: "/fixture/studio-coverage.json", configurationSha256: "5".repeat(64) } };
  const enrollment = (await begin(config, { requestKey: "studio-enroll", kind: "compute-enroll", existingOperationId: env.id, inputDigest: canonicalDigest(enrolled) })).binding;
  // The real guarded enrollment transaction, with only its physical reader
  // replaced by an explicit fixture. No source/claim/bind handler is replaced.
  const enrollmentApp = new Hono<AppEnv>();
  enrollmentApp.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  enrollmentApp.use("/api/*", toolingOperationGuard());
  enrollmentApp.post("/api/tasks/task/compute-enroll", async c => c.json(await enrollCompute({ prisma: db.prisma, config, taskId: "task", request: ComputeEnrollment.parse(await c.req.json()) }, async () => ({
    observation: { version: 1, environmentId: env.id, taskId: "task", primarySessionId: "primary", purpose: "development", revision: enrolled.revision,
      recipeDigest: enrolled.recipeDigest, resourceId: resource.id, resourceIdentity: identity, configurationDigest: enrolled.configuration.configurationSha256,
      state: "stopped", observedAt: Date.now(), coverage: "incomplete", routes: [], operations: { coverage: "incomplete", active: 0, generation: "0".repeat(64) } }, traffic: [],
  }))));
  expect((await enrollmentApp.request("/api/tasks/task/compute-enroll", { method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: enrollment.operationId }, body: JSON.stringify(enrolled) })).status).toBe(200);
  expect(await producerOperationId(db.prisma, await task(), env.id)).toBe(enrollment.operationId);
  // Actual enrolled client shape: revision/recipe, deliberately NO saved field.
  const request = { key: resource.key, purpose: enrolled.purpose, revision: enrolled.revision, recipeDigest: enrolled.recipeDigest };
  const resume = (await begin(config, { requestKey: "studio-resume", kind: "compute-admission", inputDigest: canonicalDigest(request) })).binding;
  expect((await call("compute-request", request, resume.operationId)).status).toBe(202);
  await activate("release-b", 2);
  const context = { prisma: db.prisma, config, machineId: config.machine, policy: config.compute, runtime };
  await scheduleComputeOffers(context);
  const assignment = await db.prisma.computeOffer.findFirstOrThrow();
  await db.prisma.runtimeInstruction.update({ where: { id: assignment.instructionId }, data: { state: "dispatching", executionRequestId: assignment.instructionId } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "studio-delivery", runtimeSessionId: "primary", requestId: assignment.instructionId, phase: "started", occurredAt: new Date() } });
  await confirmComputeDelivery({ ...context, sessionId: "primary", requestId: assignment.instructionId });
  expect((await call("compute-claim", { ...request, offerId: assignment.id }, resume.operationId)).status).toBe(200);
  const bind = () => call("compute-bind", { offerId: assignment.id, resourceKey: resource.key }, resume.operationId);
  for (const configuration of [{ ...enrolled.configuration, configurationSha256: "6".repeat(64) }, { ...enrolled.configuration, configurationFile: "/fixture/different.json" }]) {
    await db.prisma.computeEnvironment.update({ where: { id: env.id }, data: { configuration } });
    expect((await bind()).status).toBe(409);
    expect(await producerOperationId(db.prisma, await task(), env.id)).toBe(enrollment.operationId);
  }
  await db.prisma.computeEnvironment.update({ where: { id: env.id }, data: { configuration: enrolled.configuration } });
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { externalId: "other-studio" } });
  expect((await bind()).status).toBe(409);
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { externalId: resource.externalId, updatedAt: resource.updatedAt } });
  const confirmed = await bind();
  expect(await confirmed.clone().json()).not.toHaveProperty("error");
  expect(confirmed.status).toBe(200);
  expect(await producerOperationId(db.prisma, await task(), env.id)).toBe(resume.operationId);
  expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-environment", id: env.id } })).code?.revision).toBe(A);
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { operationId: resume.operationId, status: "confirmed" } })).toBe(1);
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { operationId: resume.operationId, status: "pending" } })).toBe(0);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
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
  // Only the exact request returns its stored binding: a caller that minted a
  // new key for A's live, unsettled admission is refused, never handed A's
  // binding under another identity.
  await expect(begin(config, { requestKey: "fresh-key", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", existingOperationId: "offer-1" })).rejects.toThrow(/continue that operation/);
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

// Baseline evidence (pre-protocol 6f972beb vs this head, probe
// /tmp/dra29-probe/closed-sweep.probe.test.ts): for a never-finalized closed
// task the release guard blocks no previously accepted callback. Resource
// receipts stay accepted header-less; closed browser/local stops stay refused.
test("closed-task sweep callbacks keep their pre-protocol outcomes after activation", async () => {
  const { config } = await fixture(); await bootstrap([]);
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed", closedAt: new Date() } });
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
  const resource = { key: "container", kind: "docker-container", purpose: "development", externalId: "c".repeat(64) };
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", state: "ready", ...resource } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", state: "ready", key: "browser", kind: "browser-profile", purpose: "browser", externalId: "/fixture/profile" } });
  const server = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const send = (method: string, route: string, body: unknown) => server.request(`http://localhost${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await send("PUT", "/api/sessions/primary/task/resources", { ...resource, state: "released" })).status).toBe(200);
  expect((await send("POST", "/api/sessions/primary/browser-stop-authority", { key: "browser" })).status).toBe(428);
  expect((await send("POST", "/api/sessions/primary/local-service-stop-authority", { key: "container" })).status).toBe(428);
  // The command fence itself is what a closed sweep without cleanup lineage lacks.
  await expect(begin(config, { requestKey: "upkeep-closed", inputDigest: canonicalDigest({ argv: ["upkeep", "closed"] }), kind: "adapter-command" })).rejects.toThrow(/original operation recorded before settled primary closure/);
});

describe("closed legacy resource release (contract 7a6fe03)", () => {
  async function closedLegacyTask() {
    const { config } = await fixture(); await bootstrap([]);
    await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed", closedAt: new Date() } });
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
    const runtime = { key: "runtime-development", kind: "task-runtime", purpose: "development", externalId: "/fixture/runtime.json", metadata: { recipeHash: "b".repeat(64), revision: "a".repeat(40) } };
    await db.prisma.remoteTaskResource.create({ data: { taskId: "task", state: "ready", ...runtime } });
    await db.prisma.remoteTaskResource.create({ data: { taskId: "task", state: "ready", key: "container", kind: "docker-container", purpose: "development", externalId: "c".repeat(64) } });
    const server = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const send = (method: string, route: string, body: unknown, operationId?: string) => server.request(`http://localhost${route}`, { method,
      headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    const release = (action: string, key = runtime.key, extra: Record<string, unknown> = {}) =>
      begin(config, { requestKey: `release:${key}:${action}`, inputDigest: canonicalDigest({ key, action }), kind: "closed-resource-release", resourceKey: key, ...extra });
    return { config, runtime, send, release };
  }

  test("an eligible closed legacy task releases exactly one existing resource at its recorded format, then settles", async () => {
    const { runtime, send, release } = await closedLegacyTask();
    const binding = (await release("release")).binding;
    expect(binding).toMatchObject({ kind: "closed-resource-release", resourceKey: runtime.key, release: { revision: A }, parentOperationId: null, existingOperationId: null });
    expect((await send("PUT", "/api/sessions/primary/task/resources", { ...runtime, state: "released" }, binding.operationId)).status).toBe(200);
    const base = `/api/sessions/primary/tooling-operations/${binding.operationId}`;
    expect(await (await send("GET", `${base}/state?family=drafted.runtime&scopeKey=${runtime.key}`, undefined, binding.operationId)).json()).toMatchObject({ version: 1, source: "legacy-assumed" });
    expect((await send("POST", `${base}/state-writes`, { family: "drafted.runtime", scopeKey: runtime.key, version: 1 }, binding.operationId)).status).toBe(200);
    expect((await send("POST", `${base}/state-writes`, { family: "drafted.runtime", scopeKey: runtime.key, version: 2 }, binding.operationId)).status).toBe(400); // never raised
    expect((await send("GET", `${base}/state?family=drafted.runtime&scopeKey=task`, undefined, binding.operationId)).status).toBe(400); // no task scope
    expect(await (await send("POST", `${base}/settlement`, { requestKey: binding.requestKey, inputDigest: binding.inputDigest, outcome: "completed" }, binding.operationId)).json()).toMatchObject({ outcome: "completed", binding: { status: "completed" } });
  });

  test("it grants nothing beyond its own receipt: other resources, actions, parents, children and new work are refused", async () => {
    const { config, runtime, send, release } = await closedLegacyTask();
    const binding = (await release("stop")).binding;
    expect((await send("PUT", "/api/sessions/primary/task/resources", { key: "container", kind: "docker-container", purpose: "development", externalId: "c".repeat(64), state: "released" }, binding.operationId)).status).toBe(409);
    await expect(release("resume")).rejects.toThrow(/not a reconcile, stop or release/);
    await expect(release("release", runtime.key, { parentOperationId: binding.operationId })).rejects.toThrow();
    await expect(release("release", runtime.key, { existingOperationId: "finalize:task" })).rejects.toThrow();
    await expect(begin(config, { requestKey: "child", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: binding.operationId })).rejects.toThrow();
    await expect(begin(config, { requestKey: "new-work", inputDigest: canonicalDigest(computeBody), kind: "compute-admission" })).rejects.toThrow(/Task is closed/);
    expect((await send("POST", "/api/sessions/primary/browser-stop-authority", { key: runtime.key }, binding.operationId)).status).toBe(409);
    await expect(release("release", "missing")).rejects.toThrow(/no unreleased resource/);
  });

  test("pause, an unsettled family, finalization history and retention keep it finalize-only or refused", async () => {
    const { release } = await closedLegacyTask();
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    await expect(release("release")).rejects.toThrow(/paused/);
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
    const pending = await db.prisma.runtimeInstruction.create({ data: { id: "pending", sessionId: "primary", text: "queued work" } });
    await expect(release("release")).rejects.toThrow(/unresolved task-family instructions/);
    await db.prisma.runtimeInstruction.update({ where: { id: pending.id }, data: { state: "completed" } });
    const retention = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "archive:task", action: "finalization-archive-retention", key: "archive", value: "{}" } });
    await expect(release("release")).rejects.toThrow(/retains resources/);
    await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: retention.sequence } });
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key: "finalize:task", value: "{}" } });
    await expect(release("release")).rejects.toThrow(/finalization history/);
  });
});

describe("closed legacy resource release replay and receipt limits (review of 482d71b)", () => {
  async function setup() {
    const { config } = await fixture(); await bootstrap([]);
    await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed", closedAt: new Date() } });
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
    const runtime = { key: "runtime-development", kind: "task-runtime", purpose: "development", externalId: "/fixture/runtime.json", metadata: { recipeHash: "b".repeat(64), revision: "a".repeat(40) } };
    await db.prisma.remoteTaskResource.create({ data: { taskId: "task", state: "ready", ...runtime } });
    const server = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const send = (method: string, route: string, body: unknown, operationId?: string) => server.request(`http://localhost${route}`, { method,
      headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: JSON.stringify(body) });
    const beginRoute = (requestKey: string) => send("POST", "/api/sessions/primary/tooling-operations", { requestKey, inputDigest: canonicalDigest({ key: runtime.key, action: "release" }), kind: "closed-resource-release", resourceKey: runtime.key });
    const state = async () => (await db.prisma.remoteTaskResource.findFirstOrThrow({ where: { key: runtime.key } })).state;
    return { runtime, send, beginRoute, state };
  }

  test("an exact retry after release returns the original binding; a fresh request for the released resource is refused", async () => {
    const { runtime, send, beginRoute } = await setup();
    const first = await beginRoute("release-1");
    expect(first.status).toBe(200);
    const { binding } = await first.json() as { binding: { operationId: string; requestKey: string; inputDigest: string } };
    expect((await send("PUT", "/api/sessions/primary/task/resources", { ...runtime, state: "released" }, binding.operationId)).status).toBe(200);
    // Crash before settlement: the adapter re-begins the same key.
    const retry = await beginRoute("release-1");
    expect(retry.status).toBe(200);
    expect((await retry.json() as { binding: { operationId: string } }).binding.operationId).toBe(binding.operationId);
    expect((await beginRoute("release-2")).status).toBe(409);
    // Lost settlement acknowledgment: settle, then the same key still returns it.
    expect((await send("POST", `/api/sessions/primary/tooling-operations/${binding.operationId}/settlement`, { requestKey: binding.requestKey, inputDigest: binding.inputDigest, outcome: "completed" }, binding.operationId)).status).toBe(200);
    expect((await (await beginRoute("release-1")).json() as { binding: { operationId: string; status: string } }).binding).toMatchObject({ operationId: binding.operationId, status: "completed" });
  });

  test("the keyed binding cannot resurrect its released receipt or drift its identity", async () => {
    const { runtime, send, beginRoute, state } = await setup();
    const { binding } = await (await beginRoute("release-1")).json() as { binding: { operationId: string } };
    const put = (body: Record<string, unknown>) => send("PUT", "/api/sessions/primary/task/resources", { ...runtime, ...body }, binding.operationId);
    expect((await put({ state: "ready", metadata: { ...runtime.metadata, recipeHash: "d".repeat(64) } })).status).toBe(409); // cleanup-sensitive metadata
    expect((await put({ state: "ready", expiresAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(409); // expiry
    expect((await put({ state: "released", metadata: { ...runtime.metadata, observed: "absent", observedAt: new Date().toISOString() } })).status).toBe(200); // observation only
    expect((await put({ state: "ready" })).status).toBe(409); // resurrection
    expect(await state()).toBe("released");
  });
});

test("closed runtime receipts accept the runtime writer's monotonic cleanup progress and nothing else", async () => {
  const { config } = await fixture(); await bootstrap([]);
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed", closedAt: new Date() } });
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
  const providers = [{ provider: "neon", id: "neon-1", name: "db", createdAt: "2030-01-01T00:00:00Z", released: false }, { provider: "redis", id: "redis-1", name: "cache", released: false }];
  const identity = { recipeHash: "b".repeat(64), revision: "a".repeat(40), containerId: "c".repeat(64), dependencyVolume: "deps", network: { id: "n".repeat(64), createdAt: "x" } };
  const runtime = { key: "runtime-development", kind: "task-runtime", purpose: "development", externalId: "/fixture/runtime.json" };
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", state: "ready", ...runtime, metadata: { ...identity, providers, observed: "ready", progress: null } } });
  const server = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const binding = (await begin(config, { requestKey: "release-runtime", inputDigest: canonicalDigest({ key: runtime.key, action: "release" }), kind: "closed-resource-release", resourceKey: runtime.key })).binding;
  const put = (state: string, metadata: Record<string, unknown>) => server.request("http://localhost/api/sessions/primary/task/resources", { method: "PUT",
    headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: binding.operationId }, body: JSON.stringify({ ...runtime, state, metadata }) });
  const progress = { step: "release", detail: "Releasing providers", state: "running", updatedAt: new Date().toISOString() };
  const released = (index: number) => providers.map((provider, at) => at <= index ? { ...provider, released: true } : provider);
  // Each provider released in reverse order, with progress, as runtime.ts save() writes it.
  expect((await put("allocated", { ...identity, providers: providers.map((provider, at) => at === 1 ? { ...provider, released: true } : provider), observed: "releasing", progress })).status).toBe(200);
  expect((await put("allocated", { ...identity, providers: released(1), observed: "releasing", progress })).status).toBe(200);
  // Refused: un-releasing, provider identity drift, dropped providers, identity drift, non-string observation, foreign progress shape.
  expect((await put("allocated", { ...identity, providers, observed: "releasing", progress })).status).toBe(409);
  expect((await put("allocated", { ...identity, providers: released(1).map(provider => ({ ...provider, id: `${provider.id}-other` })), observed: "releasing", progress })).status).toBe(409);
  expect((await put("allocated", { ...identity, observed: "releasing", progress })).status).toBe(409);
  expect((await put("allocated", { ...identity, containerId: "d".repeat(64), providers: released(1), observed: "releasing", progress })).status).toBe(409);
  expect((await put("allocated", { ...identity, providers: released(1), observed: { arbitrary: true }, progress })).status).toBe(409);
  expect((await put("allocated", { ...identity, providers: released(1), observed: "releasing", progress: { ...progress, extra: "x" } })).status).toBe(409);
  // The final release and no resurrection.
  expect((await put("released", { ...identity, providers: released(1), observed: "released", progress: { ...progress, state: "complete" } })).status).toBe(200);
  expect((await put("ready", { ...identity, providers: released(1), observed: "ready", progress })).status).toBe(409);
});

test("closed public-preview receipts accept the preview writer's exact discovery and completion and nothing else", async () => {
  const { config } = await fixture(); await bootstrap([]);
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed", closedAt: new Date() } });
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
  const hostname = "task.example.test", tunnelId = "0f0e0d0c-0b0a-4908-8706-050403020100", zoneId = "a".repeat(32), accountId = "b".repeat(32), dnsRecordId = "c".repeat(32);
  const resources = {
    preview: { key: "preview", kind: "local-http", purpose: "review", externalId: "http://localhost:3000", metadata: { publicUrl: `https://${hostname}` } },
    dns: { key: "dns", kind: "cloudflare-dns-record", purpose: "review", externalId: hostname, metadata: { zone: zoneId, routeResult: { dnsTag: dnsRecordId } } },
    tunnel: { key: "tunnel", kind: "cloudflare-tunnel", purpose: "review", externalId: "task-preview", metadata: { tunnelId, accountId, zoneId, hostname } },
    connector: { key: "connector", kind: "launch-agent", purpose: "review", externalId: "ai.drafted.task.task-preview.cloudflare", metadata: { tunnelId } },
  };
  for (const resource of Object.values(resources)) await db.prisma.remoteTaskResource.create({ data: { taskId: "task", state: "ready", ...resource } });
  const server = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const put = async (name: keyof typeof resources, state: string, metadata: Record<string, unknown>) => {
    const resource = resources[name];
    const { binding } = await begin(config, { requestKey: `release-${name}`, inputDigest: canonicalDigest({ key: resource.key, action: "release" }), kind: "closed-resource-release", resourceKey: resource.key });
    return (await server.request("http://localhost/api/sessions/primary/task/resources", { method: "PUT",
      headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: binding.operationId }, body: JSON.stringify({ ...resource, state, metadata }) })).status;
  };
  const discovered = { hostname, tunnelId, zoneId, dnsRecordId };
  // Discovery consistent with each receipt's existing identity.
  expect(await put("dns", "ready", { ...resources.dns.metadata, ...discovered })).toBe(200);
  expect(await put("tunnel", "ready", { ...resources.tunnel.metadata, dnsRecordId, connectorKeys: ["connector"] })).toBe(200);
  // Refused: discoveries contradicting existing identity, changing a known identity, foreign shapes, unknown connectors.
  expect(await put("dns", "ready", { ...resources.dns.metadata, ...discovered, dnsRecordId: "d".repeat(32) })).toBe(409);
  expect(await put("dns", "ready", { ...resources.dns.metadata, ...discovered, hostname: "other.example.test" })).toBe(409);
  expect(await put("tunnel", "ready", { ...resources.tunnel.metadata, tunnelId: "1f0e0d0c-0b0a-4908-8706-050403020100", dnsRecordId, connectorKeys: ["connector"] })).toBe(409);
  expect(await put("preview", "ready", { ...resources.preview.metadata, tunnelId: "not-a-uuid" })).toBe(409);
  expect(await put("tunnel", "ready", { ...resources.tunnel.metadata, dnsRecordId, connectorKeys: ["connector", "missing"] })).toBe(409);
  expect(await put("tunnel", "ready", { ...resources.tunnel.metadata, dnsRecordId, connectorKeys: [] })).toBe(409);
  expect(await put("preview", "ready", { ...resources.preview.metadata, arbitrary: true })).toBe(409);
  // The observed absence only on release; publicUrl cleared only with its own completed cleanup.
  expect(await put("dns", "ready", { ...resources.dns.metadata, ...discovered, cleanupObserved: "exact-dns-record-absent" })).toBe(409);
  expect(await put("dns", "released", { ...resources.dns.metadata, ...discovered, cleanupObserved: "anything" })).toBe(409);
  expect(await put("dns", "released", { ...resources.dns.metadata, ...discovered, cleanupObserved: "exact-dns-record-absent" })).toBe(200);
  const observedAt = new Date().toISOString();
  expect(await put("preview", "ready", { publicUrl: null })).toBe(409);
  expect(await put("preview", "ready", { publicUrl: null, publicPreviewCleanup: { complete: true, hostname: "other.example.test", observedAt } })).toBe(409);
  expect(await put("preview", "ready", { ...discovered, publicUrl: null, publicPreviewCleanup: { complete: true, hostname, tunnelId, sharedTunnelPreserved: false, observedAt } })).toBe(200);
  // Completed cleanup is final: no rewrite, no restored URL, no resurrection of the released DNS receipt.
  expect(await put("preview", "ready", { ...discovered, publicUrl: `https://${hostname}`, publicPreviewCleanup: { complete: true, hostname, tunnelId, sharedTunnelPreserved: false, observedAt } })).toBe(409);
  expect(await put("preview", "ready", { ...discovered, publicUrl: null, publicPreviewCleanup: { complete: true, hostname, tunnelId, sharedTunnelPreserved: true, observedAt } })).toBe(409);
  expect(await put("dns", "ready", { ...resources.dns.metadata, ...discovered, cleanupObserved: "exact-dns-record-absent" })).toBe(409);
});

test("RA-33 runtime health uses its bound original owner, deduplicates notification and never rewinds later readiness", async () => {
  const { config } = await fixture(); await bootstrap([]);
  const { binding } = await begin(config, { requestKey: "health-sweep", kind: "adapter-command", inputDigest: "6".repeat(64) });
  const app = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const body = { requestKey: "recovered-original", resourceKey: "runtime-development", state: "recovered", detail: "Original application recovered", notify: true };
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: body.resourceKey, kind: "task-runtime", purpose: "development", externalId: "/original/runtime.json", state: "ready", metadata: { progress: { step: "launcher-recovery", detail: body.detail } } } });
  const send = (value = body, operationId: string | undefined = binding.operationId, sessionId = "primary") => app.request(`/api/sessions/${sessionId}/task/runtime-health`, { method: "POST", headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: JSON.stringify(value) });
  expect((await send(body, "")).status).toBe(428); expect((await send(body, binding.operationId, "other-primary")).status).toBe(409);
  const first = await send(); expect(first.status).toBe(200); const receipt = await first.json();
  expect((await task()).environmentStatus).toBe("ready"); expect(await db.prisma.runtimeInstruction.count({ where: { sessionId: "primary" } })).toBe(1);
  await db.prisma.$disconnect(); await db.prisma.remoteTask.update({ where: { id: "task" }, data: { environmentStatus: "stopped" } });
  expect(await (await send()).json()).toEqual(receipt); expect((await task()).environmentStatus).toBe("stopped");
  expect(await db.prisma.runtimeInstruction.count({ where: { sessionId: "primary" } })).toBe(1);
  expect((await send({ ...body, detail: "Changed payload" })).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  expect((await send()).status).toBe(409);
});

test("RA-33 native takeover, closed task and mismatched runtime evidence refuse health publication", async () => {
  const { config } = await fixture(); await bootstrap([]);
  const { binding } = await begin(config, { requestKey: "health-sweep", kind: "adapter-command", inputDigest: "6".repeat(64) });
  const app = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const body = { requestKey: "failed-original", resourceKey: "runtime-development", state: "failed", detail: "Recovery exhausted", notify: true };
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: body.resourceKey, kind: "task-runtime", purpose: "development", externalId: "/original/runtime.json", state: "ready", metadata: { progress: { step: "launcher-recovery", detail: body.detail } } } });
  const send = () => app.request("/api/sessions/primary/task/runtime-health", { method: "POST", headers: { "content-type": "application/json", [TOOLING_OPERATION_HEADER]: binding.operationId }, body: JSON.stringify(body) });
  expect((await send()).status).toBe(409);
  await db.prisma.remoteTaskResource.updateMany({ where: { taskId: "task" }, data: { state: "failed" } });
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { connectionId: "connection", issueIdentifier: "DRA-health" } });
  await db.prisma.nativeTakeover.create({ data: { sourceKey: "health-source", repositoryId: "repo", machineId: "host", connectionId: "connection", issueId: "issue", issueIdentifier: "DRA-health", revision: 1, mode: "native", settled: true, decidedAt: new Date() } });
  expect((await send()).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } }); expect((await send()).status).toBe(409);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "runtime-health" } })).toBe(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});
