import { startRuntimeEventProjection } from "../sessions/runtime-events/projection.ts";
import { enqueueTaskCleanup } from "./cleanup-inbox.ts";
import { taskSupervisionRoutes } from "../../routes/tasks/supervision.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { confirmTaskFinalization, prepareTaskFinalization } from "./finalization.ts";
import { FINALIZATION_PREPARED, FINALIZATION_CONFIRMED } from "./finalization-receipts.ts";
import { CLEANUP_OPERATION, assertPreparedCleanup, bindPreparedCleanup } from "./cleanup-lifecycle.ts";
import { CLEANUP_PROGRESS, recordCleanupProgress, cleanupProgressProjection } from "./cleanup-progress.ts";
import { retirementDigest } from "./retirement-receipts.ts";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskRoutes, sessionTaskRoutes } from "../../routes/tasks/index.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { completeDevelopmentIntent, recordDevelopmentIntent, renewDevelopmentAuthority } from "./development-intent.ts";
import { assertRetirementResourcePreflight } from "./retirement-preview.ts";
import { retainedDevelopmentFixture } from "../../../../test-support/retained-development-fixture.ts";
import { cleanupProjection, cleanupReportDelivery } from "./cleanup-report.ts";
import { cleanupDeliveryRetention } from "./cleanup-delivery-reference.ts";
import { clerkCreationRecord } from "../../../../test-support/clerk-creation-fixture.ts";
import { legacyClerkUserScript, legacyClerkJwksScript } from "./clerk-creation-recipe.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "task-finalization-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture(taskId = "task") {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  git(root, "worktree", "add", "-b", "codex/task", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: taskId, requestKey: taskId, repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: directory, toolingRevision: "a".repeat(40), phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Blocked", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", branchName: "codex/task", title: "Task", description: "Request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const context = { prisma: db.prisma, config, taskId: task.id };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "owner-verified", passed: true, evidence: ["Owner accepted verified content"] } });
  const head = git(worktree, "rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const observer = { ...completionObservation, remote: async () => remote };
  const input = { prisma: db.prisma, config, sessionId: session.id, requestKey: `finalize:${task.id}` };
  const dependencies = { source: async () => ({ session, link, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, observer), snapshot: completionObservation.snapshot };
  const remove = () => git(root, "worktree", "remove", worktree);
  const revoke = () => setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "revoke", expectedRevision: contract.revision, boundary: "revoked", basis: "Owner withdrew delivery" }) });
  return { root, worktree, config, session, task, issue, states, context, contract, remote, observer, input, dependencies, remove, revoke };
}

async function preparedFixture() {
  const f = await fixture();
  await db.prisma.remoteTaskResource.create({ data: { id: "volume", taskId: f.task.id, key: "data", kind: "docker-volume", purpose: "development", externalId: "exact-owned-volume", state: "ready", metadata: { taskId: f.task.id } } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies);
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const observe = async () => { expect(await completionObservation.snapshot(f.worktree)).toEqual(JSON.parse(frozen.find(row => row.sequence === prepared.preparedRevision)!.value!).delivery.receipts.snapshot); };
  return { ...f, prepared, frozen, observe };
}

test("frozen v1 accepted PR history remains Ready through preparation, confirmation retry and closure", async () => {
  const f = await fixture();
  const reference = await db.prisma.remoteTaskResource.create({ data: { id: "accepted-pr", taskId: f.task.id, key: "development-pull-request", kind: "github-pull-request", purpose: "development", externalId: f.remote.pullRequest.url, state: "ready",
    metadata: { draft: true, head: "d".repeat(40), remoteCI: "Queued at publication", acceptance: "Merge not yet authorized at publication" } } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies);
  const active = await bindPreparedCleanup(f.input, async () => {});
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const before = await cleanupProjection(db.prisma, f.config, f.task);
  expect(before).toMatchObject({ finalizationRetention: { version: 1, preparedRevision: prepared.preparedRevision, operationRevision: active.operationRevision } });
  if (!("finalizationRetention" in before) || !before.finalizationRetention) throw new Error("Missing accepted reference projection");
  expect(before.finalizationRetention).not.toHaveProperty("confirmedRevision");
  expect(before.finalizationRetention.resourcePlanDigest).toBe(finalizationDigest(before.finalizationRetention.resources));
  expect(await prepareTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).toMatchObject({ preparedRevision: prepared.preparedRevision, cleanup: { operationRevision: active.operationRevision } });
  expect(await prepareTaskFinalization({ ...f.input, cleanup: true, authorityOnly: true }, f.dependencies)).toMatchObject({ preparedRevision: prepared.preparedRevision });
  const progress = await recordCleanupProgress({ ...f.context, progress: { requestKey: f.input.requestKey, operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation), outcomes: [] } });
  expect(progress.resources).toEqual([{ id: reference.id, key: reference.key, state: "ready", outcome: "retained" }]);
  f.remove();
  const confirmed = await confirmTaskFinalization({ ...f.input, cleanup: true }, f.dependencies);
  expect(confirmed).toMatchObject({ preparedRevision: prepared.preparedRevision, cleanup: { operationRevision: active.operationRevision } });
  expect(await confirmTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).toEqual(confirmed);
  const projected = await cleanupProjection(db.prisma, f.config, f.task);
  expect(projected).toMatchObject({ finalizationRetention: { version: 1, requestKey: f.input.requestKey, taskId: f.task.id, sessionId: f.session.id,
    preparedRevision: prepared.preparedRevision, confirmedRevision: confirmed.confirmedRevision, operationRevision: active.operationRevision,
    operationDigest: retirementDigest(active.operation), resources: [{ ...finalizationResourceIdentity(reference), disposition: "retain-reference",
      reference: { deliveryId: `finalizer:${f.task.id}:${prepared.preparedRevision}`, type: "pull-request", repository: "owner/product", number: 12, reviewedHead: f.remote.remoteHead, mergeCommit: "c".repeat(40) } }] } });
  const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine, role: "primary", status: "idle" }]);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient })).route("/api/tasks", taskSupervisionRoutes);
  const close = await app.request(`/api/tasks/${f.task.id}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", cleanup: true }) });
  expect(close.status).toBe(200); expect(runtime.closedSessionIds).toEqual([f.session.id]);
  const closed = await cleanupProjection(db.prisma, f.config, f.task);
  expect("finalizationRetention" in closed && closed.finalizationRetention).toEqual("finalizationRetention" in projected && projected.finalizationRetention);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: reference.id } })).toEqual(reference);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(event => event.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(1);
});

async function referenceFixture(options: { bound?: boolean; data?: Record<string, unknown>; duplicate?: boolean; physical?: boolean } = {}) {
  const f = await fixture();
  const reference = await db.prisma.remoteTaskResource.create({ data: { id: "accepted-pr", taskId: f.task.id, key: "development-pull-request", kind: "github-pull-request", purpose: "development",
    externalId: f.remote.pullRequest.url, state: "ready", metadata: { draft: true, head: "d".repeat(40) }, ...options.data } });
  if (options.duplicate) await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "alias", kind: "pull-request", purpose: "review", externalId: reference.externalId, state: "ready" } });
  if (options.physical) await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "remaining-store", kind: "docker-volume", purpose: "development", externalId: "exact-store", state: "ready" } });
  await prepareTaskFinalization(f.input, f.dependencies);
  const active = options.bound === false ? undefined : await bindPreparedCleanup(f.input, async () => {});
  return { ...f, reference, active };
}

test.each(["unbound", "duplicate", "other-url", "wrong-kind", "allocated"])("v1 PR retention refuses %s reference history", async shape => {
  const f = await referenceFixture({ bound: shape !== "unbound", duplicate: shape === "duplicate", data: shape === "other-url" ? { externalId: "https://github.com/owner/product/pull/13" }
    : shape === "wrong-kind" ? { kind: "delivery-receipt" } : shape === "allocated" ? { state: "allocated" } : {} });
  expect(await cleanupProjection(db.prisma, f.config, f.task)).not.toHaveProperty("finalizationRetention");
  // Unbound legacy confirmation cannot gain retention from a resource URL.
  f.remove();
  await expect(confirmTaskFinalization(f.input, f.dependencies)).rejects.toThrow();
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.reference.id } })).state).toBe(shape === "allocated" ? "allocated" : "ready");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
});

test.each(["key", "kind", "purpose", "url", "metadata", "expiry", "new-alias", "pause", "revoke"])("v1 PR retention rejects current %s drift before confirmation", async change => {
  const f = await referenceFixture();
  if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  else if (change === "revoke") await f.revoke();
  else if (change === "new-alias") await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "new-alias", kind: "pull-request", purpose: "review", externalId: f.reference.externalId, state: "ready" } });
  else await db.prisma.remoteTaskResource.update({ where: { id: f.reference.id }, data: change === "key" ? { key: "new-key" } : change === "kind" ? { kind: "pull-request" }
    : change === "purpose" ? { purpose: "review" } : change === "url" ? { externalId: "https://github.com/owner/product/pull/13" }
    : change === "expiry" ? { expiresAt: new Date("2030-01-01T00:00:00Z") } : { metadata: { draft: false, head: f.remote.remoteHead } } });
  expect(await cleanupProjection(db.prisma, f.config, f.task)).not.toHaveProperty("finalizationRetention");
  await expect(confirmTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
});

test("v1 PR retention does not exempt an unrelated physical resource or a Released reference", async () => {
  const f = await referenceFixture({ physical: true });
  expect(await cleanupProjection(db.prisma, f.config, f.task)).toHaveProperty("finalizationRetention");
  f.remove();
  await expect(confirmTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).rejects.toThrow("unreleased");
  await db.prisma.remoteTaskResource.update({ where: { id: f.reference.id }, data: { state: "released" } });
  expect(await cleanupProjection(db.prisma, f.config, f.task)).not.toHaveProperty("finalizationRetention");
  await expect(confirmTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).rejects.toThrow("unreleased");
});

test("v1 PR retention derives only from exact immutable accepted delivery, never optimistic registry metadata", async () => {
  const f = await referenceFixture();
  const active = f.active!;
  if (active.kind !== "v1") throw new Error("Wrong fixture version");
  expect(cleanupDeliveryRetention(active)).toBeDefined();
  for (const mutate of [
    (value: typeof active) => { value.prepared.delivery.receipts.merge.merged = false; },
    (value: typeof active) => { value.prepared.delivery.receipts.merge.observed = false; },
    (value: typeof active) => { value.prepared.delivery.receipts.pullRequest.matchesHead = false; },
    (value: typeof active) => { value.prepared.delivery.receipts.pullRequest.observed = false; },
    (value: typeof active) => { value.prepared.delivery.receipts.merge.sha = "invalid"; },
    (value: typeof active) => { value.prepared.delivery.receipts.snapshot.clean = false; },
    (value: typeof active) => { value.prepared.delivery.receipts.pullRequest.url += "?new=1"; },
  ]) {
    // Even an internally self-consistent invalid receipt cannot become an
    // accepted reference; no database event is changed by this parser test.
    const invalid = structuredClone(active); mutate(invalid);
    invalid.preparation.value = JSON.stringify(invalid.prepared);
    invalid.operation.binding.preparedDigest = createHash("sha256").update(invalid.preparation.value).digest("hex");
    expect(cleanupDeliveryRetention(invalid)).toBeUndefined();
  }
  const rawChanged = structuredClone(active); rawChanged.preparation.value += " ";
  expect(cleanupDeliveryRetention(rawChanged)).toBeUndefined();
  const unbound = structuredClone(active); unbound.operation.binding.resources = [];
  expect(cleanupDeliveryRetention(unbound)).toBeUndefined();
});

test.skipIf(!process.env.DRAFTED_REFERENCE_INTEGRATION_ROOT)("actual Drafted v1 reference retention removes the clean worktree and retries lost confirmation with Ready history intact", async () => {
  const f = await referenceFixture(), frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const savedReport = { ...cleanupReportDelivery };
  Object.assign(cleanupReportDelivery, { read: async () => { throw new Error("Fixture reporting offline"); } });
  const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine, role: "primary", status: "idle" }]);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient }))
    .route("/api/tasks", taskRoutes).route("/api/tasks", taskSupervisionRoutes);
  let lostResponse = false;
  const socket = path.join(directory, "reference.sock"), server = Bun.serve({ unix: socket, fetch: async req => {
    const response = await app.fetch(req);
    if (!lostResponse && new URL(req.url).pathname.endsWith("confirm-finalization") && response.ok) {
      const value = await response.clone().json() as { confirmation?: { state?: string } };
      if (value.confirmation?.state === "ready") { lostResponse = true; await Bun.sleep(1200); }
    }
    return response;
  } }); await chmod(socket, 0o600);
  const stopPreparation = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime }, async () => {});
  try {
    const root = process.env.DRAFTED_REFERENCE_INTEGRATION_ROOT!;
    const { taskRegistry } = await import(path.join(root, "src/control.ts"));
    const { finalizeTask } = await import(path.join(root, "src/finalize.ts"));
    let registry = taskRegistry(socket, f.task.id, 1000);
    await expect(finalizeTask({ registry, cleanup: true, close: async () => { throw new Error("fixture interrupted before closure"); } })).rejects.toThrow("fixture interrupted before closure");
    expect(lostResponse).toBeTrue();
    expect(await Bun.file(path.join(f.worktree, "README.md")).exists()).toBeFalse();
    expect(git(f.root, "worktree", "list", "--porcelain")).not.toContain(f.worktree);
    const progress = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: CLEANUP_PROGRESS }, orderBy: { sequence: "desc" } });
    expect(JSON.parse(progress.value!).resources).toEqual([{ id: f.reference.id, key: f.reference.key, state: "ready", outcome: "retained", detail: "Confirmed retained resource" }]);
    await db.prisma.$disconnect(); registry = taskRegistry(socket, f.task.id, 20_000);
    const close = async () => {
      const response = await app.request(`/api/tasks/${f.task.id}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", cleanup: true }) });
      if (!response.ok) throw new Error(await response.text());
    };
    expect(await finalizeTask({ registry, cleanup: true, close, runner: async () => { throw new Error("Confirmed retry cannot remove again"); } })).toMatchObject({ closed: true, reporting: { state: "pending" } });
    expect(runtime.closedSessionIds).toEqual([f.session.id]);
    expect(await finalizeTask({ registry, cleanup: true, close })).toMatchObject({ closed: true, alreadyClosed: true });
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.reference.id } })).toEqual(f.reference);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(event => event.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
    for (const action of [FINALIZATION_PREPARED, CLEANUP_OPERATION, FINALIZATION_CONFIRMED]) expect(await db.prisma.runtimeMetadataEvent.count({ where: { action } })).toBe(1);
  } finally { await stopPreparation(); await server.stop(true); Object.assign(cleanupReportDelivery, savedReport); }
}, 30_000);

test("explicit paused compute stop records Allocated against the original cleanup binding without altering metadata, data or proofs", async () => {
  const f = await fixture();
  const compute = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "development-api", kind: "docker-container", purpose: "development", externalId: "c".repeat(64), state: "ready", metadata: { image: "original" } } });
  const data = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "development-data", kind: "docker-volume", purpose: "development", externalId: "saved-volume", state: "ready" } });
  await prepareTaskFinalization(f.input, f.dependencies); const active = await bindPreparedCleanup(f.input, async () => {});
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: [active.preparation.sequence, active.operationRevision] } }, orderBy: { sequence: "asc" } });
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "idle" } });
  await recordDevelopmentIntent({ ...f.context, request: { action: "pause", development: true, requestKey: "owner-paused-development" } });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/sessions", sessionTaskRoutes);
  const receipt = { key: compute.key, kind: compute.kind, purpose: compute.purpose, externalId: compute.externalId, state: "allocated", metadata: { image: "original", observed: "stopped-data-retained" } };
  const write = (value: unknown) => app.request(`/api/sessions/${f.session.id}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  expect((await write({ ...receipt, metadata: { image: "changed" } })).status).toBe(409);
  expect((await write({ ...receipt, state: "released" })).status).toBe(409);
  expect((await write(receipt)).status).toBe(200); expect((await write(receipt)).status).toBe(200);
  expect(await db.prisma.remoteTaskResource.findUnique({ where: { id: compute.id } })).toMatchObject({ state: "allocated", metadata: receipt.metadata });
  expect(await db.prisma.remoteTaskResource.findUnique({ where: { id: data.id } })).toEqual(data);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
  await db.prisma.remoteTaskResource.update({ where: { id: compute.id }, data: { metadata: { image: "rebound" } } });
  expect((await write({ ...receipt, metadata: { image: "rebound" } })).status).toBe(409);
});

test.each(["docker-container", "task-runtime"])("explicit %s resume after cleanup revocation acknowledges only the original saved compute", async kind => {
  const f = await fixture();
  const progress = { step: "health", detail: "Saved app is ready", state: "complete", updatedAt: "2026-10-30T00:00:00.000Z" };
  const metadata = kind === "task-runtime" ? { recipeHash: "original", containerId: "c".repeat(64), providers: [{ provider: "storage", id: "saved" }], progress } : { image: "original" };
  const compute = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "development-api", kind, purpose: "development", externalId: kind === "task-runtime" ? "/saved-runtime.json" : "c".repeat(64), state: "ready", metadata } });
  const data = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "development-data", kind: "docker-volume", purpose: "development", externalId: "saved-volume", state: "ready" } });
  await prepareTaskFinalization(f.input, f.dependencies); const active = await bindPreparedCleanup(f.input, async () => {});
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: [active.preparation.sequence, active.operationRevision] } }, orderBy: { sequence: "asc" } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const runtime = createFakeAgentRuntime();
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient }))
    .route("/api/tasks", taskSupervisionRoutes).route("/api/sessions", sessionTaskRoutes);
  const change = (action: "pause" | "resume", requestKey: string) => app.request(`/api/tasks/${f.task.id}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, development: true, requestKey }) });
  const receipt = { key: compute.key, kind, purpose: "development", externalId: compute.externalId, state: "allocated", metadata };
  const write = (value: unknown) => app.request(`/api/sessions/${f.session.id}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  expect((await change("pause", "pause-saved")).status).toBe(200); expect((await write(receipt)).status).toBe(200);
  expect((await change("resume", "active-cleanup")).status).toBe(409);
  expect((await write({ ...receipt, state: "ready" })).status).toBe(409);
  await f.revoke();
  expect((await change("resume", "resume-saved")).status).toBe(200);
  const resumed = kind === "task-runtime" ? { ...metadata, progress: { ...progress, step: "credentials", state: "running" } } : metadata;
  if (kind === "task-runtime") {
    expect((await write({ ...receipt, metadata: { ...resumed, progress: { ...resumed.progress, extra: "not progress" } } })).status).toBe(409);
    expect((await write({ ...receipt, metadata: resumed })).status).toBe(200);
    expect((await write({ ...receipt, metadata: { ...resumed, containerId: "d".repeat(64) } })).status).toBe(409);
  }
  expect((await write({ ...receipt, state: "ready", metadata: { ...resumed, unrelated: true } })).status).toBe(409);
  expect((await write({ ...receipt, state: "ready", expiresAt: "2030-01-01T00:00:00.000Z", metadata: resumed })).status).toBe(409);
  expect((await write({ ...receipt, state: "ready", metadata: resumed })).status).toBe(200);
  expect((await write({ ...receipt, state: "ready", metadata: resumed })).status).toBe(200);
  expect((await write({ ...receipt, state: "released", metadata: resumed })).status).toBe(409);
  expect((await change("pause", "stop-again")).status).toBe(200);
  expect((await write({ ...receipt, metadata: resumed })).status).toBe(200);
  expect((await write({ ...receipt, state: "ready", metadata: resumed })).status).toBe(409);
  expect((await change("resume", "resume-again")).status).toBe(200);
  await db.prisma.remoteTaskResource.update({ where: { id: compute.id }, data: { state: "released" } });
  expect((await write({ ...receipt, state: "ready", metadata: resumed })).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.findUnique({ where: { id: data.id } })).toEqual(data);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
});

test("cleanup-bound development acknowledgments exclude protected migration sources and recheck their selection snapshot", async () => {
  const f = await fixture(), retained = await retainedDevelopmentFixture({ taskId: f.task.id, primarySessionId: f.session.id, worktreePath: f.worktree, toolingRevision: f.task.toolingRevision });
  try {
    for (const resource of retained.task.resources) await db.prisma.remoteTaskResource.create({ data: { ...resource, id: resource.id!, taskId: f.task.id, metadata: resource.metadata as any } });
    await prepareTaskFinalization(f.input, f.dependencies); const bound = await bindPreparedCleanup(f.input, async () => {});
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: [bound.preparation.sequence, bound.operationRevision] } }, orderBy: { sequence: "asc" } });
    await recordDevelopmentIntent({ ...f.context, request: { action: "pause", development: true, requestKey: "pause-retained-app" } });
    let lateAlias = false;
    const prisma = new Proxy(db.prisma, { get(target, key) {
      if (key === "$transaction") return async (...args: any[]) => {
        if (lateAlias) {
          lateAlias = false;
          await target.remoteTaskResource.create({ data: { ...retained.mysql, taskId: f.task.id, id: "late-alias", key: "late-alias", purpose: "review" } });
        }
        return (target.$transaction as any)(...args);
      };
      return Reflect.get(target, key);
    } });
    const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/sessions", sessionTaskRoutes);
    const write = (record: typeof retained.app, state: string) => app.request(`/api/sessions/${f.session.id}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: record.key, kind: record.kind, purpose: record.purpose, externalId: record.externalId, metadata: record.metadata, state }) });
    expect((await write(retained.mysql, "allocated")).status).toBe(409);
    lateAlias = true; expect((await write(retained.app, "allocated")).status).toBe(409);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: retained.app.id } })).state).toBe("ready");
    await db.prisma.remoteTaskResource.delete({ where: { id: "late-alias" } });
    expect((await write(retained.app, "allocated")).status).toBe(200);
    await f.revoke(); await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
    await recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "resume-retained-app" } });
    expect((await write(retained.mysql, "ready")).status).toBe(409);
    expect((await write(retained.app, "ready")).status).toBe(200);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
  } finally { await rm(retained.root, { recursive: true, force: true }); }
});

test.each(["resume", "review-handoff"] as const)("a completed %s stays non-actionable when later cleanup changes the resource epoch", async reason => {
  const f = await fixture();
  const compute = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "development-api", kind: "docker-container", purpose: "development", externalId: "c".repeat(64), state: "ready" } });
  const review = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "review-api", kind: "native-app", purpose: "review", externalId: "/separate-review", state: "ready", expiresAt: new Date(Date.now() + 600_000) } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const intent = await recordDevelopmentIntent({ ...f.context, request: reason === "resume" ? { action: "resume", development: true, requestKey: "completed-resume" }
    : { action: "stop-development", requestKey: "completed-handoff", review: { key: review.key, identityDigest: finalizationResourceIdentity(review).identityDigest } } });
  const authority = await renewDevelopmentAuthority({ ...f.context, ...intent, resourceKeys: [compute.key] });
  await completeDevelopmentIntent({ ...f.context, ...intent, resourcesEpoch: authority.resourcesEpoch, resources: authority.resources });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes);
  expect((await (await app.request(`/api/tasks/${f.task.id}`)).json()).task.developmentIntent.state).toBe("complete");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "complete" } });
  await prepareTaskFinalization(f.input, f.dependencies); await bindPreparedCleanup(f.input, async () => {});
  // Cleanup can continue in a non-complete phase, and a partial result changes
  // the development epoch. This must not replay the old resume first.
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  await db.prisma.remoteTaskResource.update({ where: { id: compute.id }, data: { state: "released" } });
  if (reason === "review-handoff") await db.prisma.remoteTaskResource.update({ where: { id: review.id }, data: { expiresAt: new Date(0) } });
  const projection = (await (await app.request(`/api/tasks/${f.task.id}`)).json()).task;
  expect(projection.developmentIntent).toBeUndefined(); expect(projection.developmentBlocked).toContain("cleanup");
  expect(projection.cleanupRequired).toBeTrue();
  await expect(renewDevelopmentAuthority({ ...f.context, ...intent, resourceKeys: [] })).rejects.toThrow(reason === "resume" ? "cleanup authority" : "review ownership");
});

const developmentClient = process.env.DRAFTED_DEVELOPMENT_INTEGRATION_ROOT;
test.skipIf(!developmentClient)("actual saved-runtime client resumes and acknowledges original cleanup-bound compute after revocation", async () => {
  const f = await fixture(); await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const { taskRegistry } = await import(path.join(developmentClient!, "src/control.ts"));
  const { continueDevelopmentIntent } = await import(path.join(developmentClient!, "src/development-intent.ts"));
  const { manageRuntime, manageRuntimeResource } = await import(path.join(developmentClient!, "src/runtime.ts"));
  const { savePrivate } = await import(path.join(developmentClient!, "src/runtime-config.ts"));
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .route("/api/tasks", taskRoutes).route("/api/tasks", taskSupervisionRoutes).route("/api/sessions", sessionTaskRoutes);
  const socket = path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `saved-runtime-${crypto.randomUUID().slice(0, 8)}.sock`);
  const server = Bun.serve({ unix: socket, fetch: app.fetch });
  try {
    const registry = taskRegistry(socket, f.task.id), stateDirectory = path.join(directory, "runtime-state");
    const approved = { CLERK_SECRET_KEY: "sk_test_approved_fixture", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_approved_fixture" };
    const credentialsFile = path.join(directory, "runtime-credentials.json"); await savePrivate(credentialsFile, approved);
    const configFile = path.join(directory, "runtime-recipe.json");
    await writeFile(configFile, JSON.stringify({ version: 1, profile: "platform", image: "fixture:1", credentialsFile, runtimeSecrets: Object.keys(approved),
      planetscale: { organization: "fixture", database: "v2", baseBranch: "main", baseBranchId: "base-id" }, setup: [["bun", "install"]], fixtures: [["bun", "seed-task.ts"]],
      services: { api: { command: ["bun", "api.ts"], port: 8080 } }, checks: [{ service: "api", path: "/health", json: { ready: true }, representative: true }], readyTimeoutSeconds: 1 }));
    let container: any = null, creates = 0, starts = 0, stops = 0, schema = 0, exec = 0, remoteCreates = 0;
    const docker = { preflight: async () => {}, create: async (state: any, root: string, environment: unknown) => {
      creates++; await savePrivate(path.join(root, "app", "environment.json"), environment);
      return container = { id: "a".repeat(64), image: "sha256:fixture", createdAt: "same-container", running: false, labels: { "dev.drafted.task": f.task.id, "dev.drafted.purpose": state.purpose, "dev.drafted.runtime": "1" } };
    }, inspect: async () => container, start: async () => { starts++; container.running = true; }, stop: async () => { stops++; container.running = false; },
      exec: async () => { exec++; }, remove: async () => { throw new Error("Development cannot remove its saved container"); }, releaseDependencies: async () => { throw new Error("Development cannot release saved dependencies"); } };
    const remote = { provider: "planetscale", id: "saved-branch", name: "saved-name" };
    const providers = { preflight: async () => {}, create: async (_provider: unknown, _name: unknown, record: (value: unknown) => Promise<void>) => {
      remoteCreates++; await record(remote); return { DATABASE_URL: "mysql://fixture@task.psdb.cloud/v2" };
    }, inspect: async () => true, schema: async (_receipt: unknown, operation: (environment: unknown) => Promise<void>) => { schema++; await operation({ DATABASE_URL: "mysql://fixture-admin@task.psdb.cloud/v2" }); },
      release: async () => { throw new Error("No remote release"); } };
    const dependencies = { docker, providers: () => providers, clerkCredentials: async () => approved, request: async () => Response.json({ ready: true }), stateDirectory };
    await manageRuntime({ ...dependencies, registry, action: "up", configFile });
    const original = await db.prisma.remoteTaskResource.findFirstOrThrow({ where: { taskId: f.task.id, kind: "task-runtime" } });
    const initial = { creates, schema, exec, remoteCreates };
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "complete" } });
    await prepareTaskFinalization(f.input, f.dependencies); const bound = await bindPreparedCleanup(f.input, async () => {});
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: [bound.preparation.sequence, bound.operationRevision] } }, orderBy: { sequence: "asc" } });
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
    const manage = (input: any) => manageRuntimeResource(input, (request: any) => manageRuntime({ ...request, ...dependencies }));
    await recordDevelopmentIntent({ ...f.context, request: { action: "pause", development: true, requestKey: "stop-runtime" } });
    expect((await continueDevelopmentIntent(registry, manage)).developmentIntent.state).toBe("complete");
    expect(stops).toBe(1); expect(container.running).toBeFalse();
    await expect(recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "still-cleanup" } })).rejects.toThrow("cleanup authority");
    expect(starts).toBe(1); await f.revoke();
    await recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "resume-saved-runtime" } });
    const record = registry.resource; let lost = false;
    registry.resource = async (receipt: any) => { await record(receipt); if (!lost && receipt.state === "ready") { lost = true; throw new Error("Lost Ready acknowledgment"); } };
    await expect(continueDevelopmentIntent(registry, manage)).rejects.toThrow("Lost Ready acknowledgment");
    expect((await continueDevelopmentIntent(registry, manage)).developmentIntent.state).toBe("complete");
    expect(starts).toBe(2); expect(container.running).toBeTrue(); expect({ creates, schema, exec, remoteCreates }).toEqual(initial);
    const current = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: original.id } });
    expect(current.state).toBe("ready"); expect(current.externalId).toBe(original.externalId);
    const { progress: _before, observed: _beforeObserved, ...oldIdentity } = original.metadata as any;
    const { progress: _after, observed: _afterObserved, ...newIdentity } = current.metadata as any;
    expect(newIdentity).toEqual(oldIdentity);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
  } finally { server.stop(true); }
}, 20_000);

async function resourceScopeFixture(kind: "environment" | "clerk" = "environment") {
  const f = await fixture(kind === "clerk" ? "scopetask" : "task");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRoot: f.root } });
  const root = path.join(directory, "environments", f.task.id);
  const values = kind === "environment" ? [
    { id: "env", key: "development-env-directory", kind: "directory", purpose: "development", externalId: root, metadata: { trackedGreenfieldEdits: false } },
    { id: "credentials", key: "development-provider-credentials", kind: "private-env-files", purpose: "development", externalId: root, metadata: { files: { "test.env": "private" } } },
  ] : [{ id: "user", key: "development-clerk-user", kind: "clerk-test-user", purpose: "development", externalId: "user_Exact", metadata: { createdByTask: true, email: "dra80.scopetas+clerk_test@example.com", instance: "Clerk TEST instance ins_Exact (sk_test/pk_test from development credential backup)" } }];
  for (const value of values) await db.prisma.remoteTaskResource.create({ data: { ...value, taskId: f.task.id, state: "ready" } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies);
  const active = await bindPreparedCleanup(f.input, async () => {});
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const keys = values.map(value => value.key);
  const renew = (resourceKeys: string[] | null = keys) => app.request(`/api/tasks/${f.task.id}/cleanup-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: f.input.requestKey, ...(resourceKeys ? { resourceKeys } : {}) }) });
  const put = (value: object) => app.request(`/api/sessions/${f.session.id}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  return { ...f, environment: root, values, prepared, active, app, keys, renew, put };
}

async function originalCreatedClerkFixture() {
  const f = await fixture("scopetask");
  f.config.acpxStateDir = path.join(directory, "acpx");
  const environment = path.join(directory, "environments", f.task.id), email = "dra75.scopetas+clerk_test@example.com", instanceId = "ins_Original";
  await mkdir(path.join(environment, "scripts"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(f.config.acpxStateDir, "sessions"), { recursive: true });
  await writeFile(path.join(environment, "scripts/clerk-user.ts"), legacyClerkUserScript("DRA-75", email), { mode: 0o644 });
  await writeFile(path.join(environment, "scripts/clerk-jwks.ts"), legacyClerkJwksScript, { mode: 0o644 });
  await writeFile(path.join(environment, "clerk-user.json"), JSON.stringify({ userId: "user_Original", email, password: "private-fixture-value" }), { mode: 0o600 });
  await db.prisma.remoteTaskResource.create({ data: { id: "environment", taskId: f.task.id, key: "development-env-directory", kind: "directory", purpose: "development", externalId: environment, state: "ready", metadata: { trackedGreenfieldEdits: false } } });
  const resource = await db.prisma.remoteTaskResource.create({ data: { id: "created-user", taskId: f.task.id, key: "clerk-test-user-development", kind: "clerk-test-user", purpose: "development", externalId: "user_Original", state: "ready",
    metadata: { instance: `Clerk test instance (sk_test/pk_test guarded), kid ${instanceId}`, email, credentialsFile: "<envDirectory>/clerk-user.json (0600)" } } });
  const actor = await db.prisma.runtimeSession.create({ data: { id: "environment-delegate", scopeKey: "environment-delegate", acpxRecordId: "environment-delegate", acpxSessionId: "original-provider-session", role: "delegate", agentCommand: "claude", status: "closed", cwd: f.worktree, repositoryId: f.task.repositoryId, machineId: f.task.machineId } });
  const relation = await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: actor.id, targetSessionId: f.session.id, relationship: "spawned-by", endedAt: new Date() } });
  const record = clerkCreationRecord({ actor: { ...actor, acpxRecordId: actor.acpxRecordId!, acpxSessionId: actor.acpxSessionId! }, taskId: f.task.id, environment, instanceId, email, resource, resourceCreatedAt: resource.createdAt.toISOString() });
  const recordPath = path.join(f.config.acpxStateDir, "sessions", `${actor.acpxRecordId}.json`);
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o644 });
  await prepareTaskFinalization(f.input, f.dependencies); const active = await bindPreparedCleanup(f.input, async () => {});
  const original = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const renew = () => app.request(`/api/tasks/${f.task.id}/cleanup-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: f.input.requestKey, resourceKeys: [resource.key] }) });
  return { ...f, environment, resource, actor, relation, record, recordPath, active, original, app, renew };
}

test("original structured Clerk creation is frozen once outside the unchanged v1 preparation and operation", async () => {
  const f = await originalCreatedClerkFixture(), response = await f.renew();
  expect(response.status).toBe(200); const first: any = await response.json();
  expect(first.clerkCreation).toMatchObject({ taskId: f.task.id, sessionId: f.session.id, resourceId: f.resource.id, userId: f.resource.externalId,
    instanceId: "ins_Original", preparedRevision: f.active.preparation.sequence, operationRevision: f.active.operationRevision, operationDigest: retirementDigest(f.active.operation) });
  const fact = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: first.clerkCreation.evidenceRevision } });
  expect(fact.action).toBe("cleanup-clerk-original-creation"); expect(first.clerkCreation.evidenceDigest).toBe(finalizationDigest(JSON.parse(fact.value!)));
  expect(fact.value).not.toContain("private-fixture-value"); expect(fact.value).not.toContain("CLERK_SECRET_KEY");
  await rm(f.recordPath); await rm(f.environment, { recursive: true });
  expect(await (await f.renew()).json()).toEqual(first);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: f.original.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(f.original);
  expect((await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "cleanup-clerk-original-creation" } })).length).toBe(1);
});

test.each(["missing", "reused", "script", "local-user", "foreign-claim", "pause", "relation"])("original Clerk scoped renewal refuses %s without recording provenance or authority", async change => {
  const f = await originalCreatedClerkFixture();
  if (change === "missing") await rm(f.recordPath);
  if (change === "reused") {
    const result = f.record.messages[0]!.Agent.tool_results["create-exact-user"]! as any;
    result.output = result.output.replace('"created":true', '"created":false'); result.content.Text = result.output;
    await writeFile(f.recordPath, JSON.stringify(f.record));
  }
  if (change === "script") await writeFile(path.join(f.environment, "scripts/clerk-user.ts"), "console.log('created:true')");
  if (change === "local-user") await writeFile(path.join(f.environment, "clerk-user.json"), JSON.stringify({ userId: "user_Other", email: "wrong@example.com", password: "private-fixture-value" }));
  if (change === "foreign-claim") await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "other-purpose-claim", kind: "clerk-test-session", purpose: "review", externalId: "sess_Shared", state: "ready", metadata: { userId: f.resource.externalId } } });
  if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (change === "relation") await db.prisma.runtimeSessionRelation.update({ where: { id: f.relation.id }, data: { relationship: "notifies-parent" } });
  const result = await f.renew(); expect(result.status).toBe(409); const body = await result.text(); expect(body).not.toContain("private-fixture-value");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "cleanup-clerk-original-creation" } })).toBe(0);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
});

async function legacyPreviewFixture(review = false, change?: (values: any[]) => void, uuidFormat = false) {
  const f = await fixture();
  const purpose = review || uuidFormat ? "review" : "development", hostname = `${purpose}.example.test`;
  const tunnelId = "11111111-2222-3333-4444-555555555555", zone = "b".repeat(32), account = "a".repeat(32), dnsId = "c".repeat(32);
  const source = "http://127.0.0.1:4173", environment = path.join(directory, purpose);
  await mkdir(environment, { mode: 0o700 });
  const config = path.join(environment, "cloudflared.yml"), credentials = path.join(environment, "connector.json");
  await writeFile(credentials, JSON.stringify({ TunnelID: tunnelId, AccountTag: account }), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ tunnel: tunnelId, "credentials-file": credentials, ingress: [{ hostname, service: source }, { service: "http_status:404" }] }), { mode: 0o600 });
  const values: any[] = [
    { id: "endpoint", key: `${purpose}-preview-proxy`, kind: "local-http", purpose, externalId: source, state: review ? "released" : "allocated", metadata: { publicUrl: review ? null : `https://${hostname}` } },
    { id: "tunnel", key: `${purpose}-cloudflare-tunnel`, kind: "cloudflare-tunnel", purpose, externalId: `saved-${purpose}-tunnel`, state: review ? "allocated" : "ready", metadata: {
      hostname, tunnelId, zone, account, sourceAddress: source, configPath: review ? "<review env>/cloudflared.yml (saved ingress)" : config,
      credentialsPath: review ? "<review env>/connector.json (0400)" : credentials,
      ...(review ? { connector: "not started" } : { configIngress: `${hostname} -> ${source}; fallback http_status:404` }),
    } },
    { id: "environment", key: `${purpose}-env-directory`, kind: "directory", purpose, externalId: environment, state: "ready", metadata: {} },
  ];
  if (!review) values.push({ id: "dns", key: "development-dns", kind: "cloudflare-dns-record", purpose, externalId: hostname, state: "ready", metadata: {
    hostname, tunnelId, zone, account, type: "CNAME tunnel route", content: `${tunnelId}.cfargotunnel.com`, routeResult: { cname: "new", name: hostname, dnsTag: dnsId },
  } });
  if (uuidFormat) {
    const tunnel = values.find(value => value.id === "tunnel"), endpoint = values.find(value => value.id === "endpoint"), dns = values.find(value => value.id === "dns");
    tunnel.externalId = tunnelId;
    tunnel.metadata = { hostname, name: "drafted-task-review", config, source: "127.0.0.1:4173", sharedTunnelTouched: false };
    endpoint.state = "ready";
    endpoint.metadata = { publicUrl: `https://${hostname}`, sourceAddress: "127.0.0.1:4173", tunnel: { id: tunnelId, hostname, config } };
    delete dns.metadata.hostname;
  }
  change?.(values);
  for (const value of values) await db.prisma.remoteTaskResource.create({ data: { ...value, taskId: f.task.id } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies), active = await bindPreparedCleanup(f.input, async () => {});
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const put = async (id: string, metadata: object, state?: string) => {
    const value = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id } });
    return app.request(`/api/sessions/${f.session.id}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: value.key, kind: value.kind, purpose: value.purpose, externalId: value.externalId, state: state ?? value.state, metadata }) });
  };
  return { ...f, app, put, values, prepared, active, frozen, purpose, hostname, tunnelId, zone, account, dnsId, source, environment, config,
    canonical: { hostname, tunnelId, zoneId: zone, accountId: account, dnsRecordId: review ? null : dnsId } };
}

test.each([false, true])("frozen legacy preview PUT normalizes only recorded discovery and terminal annotations (review=%s)", async review => {
  const f = await legacyPreviewFixture(review);
  expect(() => assertRetirementResourcePreflight(f.active.operation.binding.resources)).toThrow("Reconcile exact public preview");
  for (const value of f.values.filter(value => value.id !== "environment" && value.state !== "released")) {
    const metadata = { ...value.metadata, ...f.canonical };
    expect((await f.put(value.id, metadata)).status).toBe(200);
    expect((await f.put(value.id, metadata)).status).toBe(200); // same operation, lost response
    await assertPreparedCleanup(f.input);
  }
  if (!review) {
    expect((await f.put("endpoint", { ...f.values[0].metadata, ...f.canonical, publicUrl: null, publicPreviewCleanup: { complete: true, hostname: f.hostname, tunnelId: f.tunnelId, sharedTunnelPreserved: false, observedAt: new Date().toISOString() } })).status).toBe(409);
    const dns = f.values.find(value => value.id === "dns");
    expect((await f.put("dns", { ...dns.metadata, ...f.canonical, cleanupObserved: "exact-dns-record-absent" }, "released")).status).toBe(200);
  }
  const tunnel = f.values.find(value => value.id === "tunnel");
  expect((await f.put("tunnel", { ...tunnel.metadata, ...f.canonical, cleanupObserved: "exact-tunnel-absent" }, "released")).status).toBe(200);
  if (!review) expect((await f.put("endpoint", { ...f.values[0].metadata, ...f.canonical, publicUrl: null, publicPreviewCleanup: { complete: true, hostname: f.hostname, tunnelId: f.tunnelId, sharedTunnelPreserved: false, observedAt: new Date().toISOString() } })).status).toBe(200);
  expect((await assertPreparedCleanup(f.input)).operation).toEqual(f.active.operation);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
});

test.each(["hostname", "tunnelId", "zoneId", "accountId", "dnsRecordId", "unrelated-metadata", "source", "shared"]) ("frozen legacy preview refuses changed %s on actual receipt PUT", async field => {
  const f = await legacyPreviewFixture();
  const value = f.values.find(value => value.id === "tunnel"), before = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: value.id } });
  const metadata = { ...value.metadata, ...f.canonical, [field === "source" ? "sourceAddress" : field]: field === "shared" ? true : field === "hostname" ? "foreign.example.test" : field === "tunnelId" ? "99999999-2222-3333-4444-555555555555" : "e".repeat(32) };
  expect((await f.put(value.id, metadata)).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: value.id } })).toEqual(before);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
});

test("frozen preview without a recorded DNS ID cannot add a new deletion target", async () => {
  const f = await legacyPreviewFixture(true), value = f.values.find(value => value.id === "tunnel");
  expect((await f.put(value.id, { ...value.metadata, ...f.canonical, dnsRecordId: f.dnsId })).status).toBe(409);
});

test.each([["pause", false], ["revocation", false], ["other-session", false], ["pause", true], ["revocation", true], ["other-session", true]] as const)("legacy preview discovery cannot bypass %s after freezing (UUID=%s)", async (guard, uuid) => {
  const f = await legacyPreviewFixture(false, undefined, uuid), value = f.values.find(value => value.id === "tunnel");
  const before = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: value.id } });
  if (guard === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (guard === "revocation") await f.revoke();
  let sessionId = f.session.id;
  if (guard === "other-session") {
    sessionId = "foreign";
    await db.prisma.runtimeSession.create({ data: { id: sessionId, scopeKey: sessionId, agentCommand: "codex", status: "idle", role: "delegate", cwd: f.worktree, repositoryId: f.task.repositoryId, machineId: f.task.machineId } });
  }
  const response = await f.app.request(`/api/sessions/${sessionId}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: value.key, kind: value.kind, purpose: value.purpose, externalId: value.externalId, state: value.state, metadata: { ...value.metadata, ...f.canonical } }) });
  expect(response.status).toBe(409);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: value.id } })).toEqual(before);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: [FINALIZATION_PREPARED, CLEANUP_OPERATION] } }, orderBy: { sequence: "asc" } })).toEqual(f.frozen.filter(row => [FINALIZATION_PREPARED, CLEANUP_OPERATION].includes(row.action)));
});

test.each(["purpose", "endpoint", "zone", "account", "dns-target", "duplicate-tunnel", "duplicate-endpoint"]) ("frozen legacy preview refuses conflicting original %s association", async field => {
  const f = await legacyPreviewFixture(false, values => {
    const endpoint = values.find(value => value.id === "endpoint"), dns = values.find(value => value.id === "dns"), tunnel = values.find(value => value.id === "tunnel");
    if (field === "purpose") endpoint.purpose = "review";
    else if (field === "endpoint") endpoint.externalId = "http://127.0.0.1:5173";
    else if (field === "zone" || field === "account") dns.metadata[field] = "e".repeat(32);
    else if (field === "dns-target") dns.metadata.content = "99999999-2222-3333-4444-555555555555.cfargotunnel.com";
    else { const value = field === "duplicate-tunnel" ? tunnel : endpoint; values.push({ ...value, id: "duplicate", key: "duplicate" }); }
  });
  const value = f.values.find(value => value.id === "tunnel");
  expect((await f.put(value.id, { ...value.metadata, ...f.canonical })).status).toBe(409);
});

test("frozen UUID preview accepts only matching discovery and ordered completion without replacing its operation", async () => {
  const f = await legacyPreviewFixture(false, undefined, true);
  expect(() => assertRetirementResourcePreflight(f.active.operation.binding.resources)).toThrow("Reconcile exact public preview");
  for (const value of f.values.filter(value => value.id !== "environment")) {
    expect((await f.put(value.id, { ...value.metadata, ...f.canonical })).status).toBe(200);
    expect((await f.put(value.id, { ...value.metadata, ...f.canonical })).status).toBe(200);
    await assertPreparedCleanup(f.input);
  }
  const endpoint = f.values.find(value => value.id === "endpoint"), dns = f.values.find(value => value.id === "dns"), tunnel = f.values.find(value => value.id === "tunnel");
  const complete = { ...endpoint.metadata, ...f.canonical, publicUrl: null, publicPreviewCleanup: { complete: true, hostname: f.hostname, tunnelId: f.tunnelId, sharedTunnelPreserved: false, observedAt: new Date().toISOString() } };
  expect((await f.put(endpoint.id, complete)).status).toBe(409);
  expect((await f.put(dns.id, { ...dns.metadata, ...f.canonical, cleanupObserved: "exact-dns-record-absent" }, "released")).status).toBe(200);
  expect((await f.put(endpoint.id, complete)).status).toBe(409);
  expect((await f.put(tunnel.id, { ...tunnel.metadata, ...f.canonical, cleanupObserved: "exact-tunnel-absent" }, "released")).status).toBe(200);
  expect((await f.put(endpoint.id, complete)).status).toBe(200);
  expect((await assertPreparedCleanup(f.input)).operation).toEqual(f.active.operation);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
});

test.each(["account", "zone", "tunnel", "config", "source", "dns", "hostname", "purpose", "missing-dns", "duplicate-tunnel", "duplicate-endpoint", "remote-source", "relative-config"])("frozen UUID preview refuses conflicting original %s association", async field => {
  const f = await legacyPreviewFixture(false, values => {
    const endpoint = values.find(value => value.id === "endpoint"), tunnel = values.find(value => value.id === "tunnel"), dns = values.find(value => value.id === "dns");
    if (field === "account" || field === "zone") tunnel.metadata[field] = "e".repeat(32);
    else if (field === "tunnel") endpoint.metadata.tunnel.id = "99999999-2222-3333-4444-555555555555";
    else if (field === "config") endpoint.metadata.tunnel.config += ".foreign";
    else if (field === "source") tunnel.metadata.source = "127.0.0.1:5173";
    else if (field === "dns") dns.metadata.content = "99999999-2222-3333-4444-555555555555.cfargotunnel.com";
    else if (field === "hostname") endpoint.metadata.tunnel.hostname = "foreign.example.test";
    else if (field === "purpose") endpoint.purpose = "development";
    else if (field === "missing-dns") values.splice(values.indexOf(dns), 1);
    else if (field === "remote-source") { tunnel.metadata.source = "foreign.example.test:4173"; endpoint.externalId = "http://foreign.example.test:4173"; endpoint.metadata.sourceAddress = tunnel.metadata.source; }
    else if (field === "relative-config") { tunnel.metadata.config = "relative/cloudflared.yml"; endpoint.metadata.tunnel.config = tunnel.metadata.config; }
    else { const value = field === "duplicate-tunnel" ? tunnel : endpoint; values.push({ ...value, id: "duplicate", key: "duplicate" }); }
  }, true);
  const value = f.values.find(value => value.id === "tunnel"), before = await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
  expect((await f.put(value.id, { ...value.metadata, ...f.canonical })).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
});

test.each(["accountId", "zoneId", "tunnelId", "dnsRecordId", "config", "source", "shared"])("frozen UUID preview refuses changed %s on receipt update", async field => {
  const f = await legacyPreviewFixture(false, undefined, true), value = f.values.find(value => value.id === "tunnel");
  const before = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: value.id } });
  expect((await f.put(value.id, { ...value.metadata, ...f.canonical, [field]: field === "shared" ? true : field === "tunnelId" ? "99999999-2222-3333-4444-555555555555" : "e".repeat(32) })).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: value.id } })).toEqual(before);
});

test("previous frozen layout with UUID externalId and extra config keeps its existing validation", async () => {
  const f = await legacyPreviewFixture(false, values => {
    const tunnel = values.find(value => value.id === "tunnel");
    tunnel.externalId = tunnel.metadata.tunnelId;
    tunnel.metadata.config = tunnel.metadata.configPath;
  });
  const tunnel = f.values.find(value => value.id === "tunnel");
  expect((await f.put(tunnel.id, { ...tunnel.metadata, ...f.canonical })).status).toBe(200);
  expect((await assertPreparedCleanup(f.input)).operation).toEqual(f.active.operation);
});

test("UUID layout accepts equal optional endpoint aliases and explicit dedicated sharing", async () => {
  const f = await legacyPreviewFixture(false, values => {
    const endpoint = values.find(value => value.id === "endpoint"), tunnel = values.find(value => value.id === "tunnel"), dns = values.find(value => value.id === "dns");
    Object.assign(endpoint.metadata.tunnel, { shared: false, tunnelId: tunnel.externalId, account: dns.metadata.account, accountId: dns.metadata.account,
      zone: dns.metadata.zone, zoneId: dns.metadata.zone, dnsRecordId: dns.metadata.routeResult.dnsTag,
      configPath: tunnel.metadata.config, source: endpoint.externalId, sourceAddress: tunnel.metadata.source });
  }, true);
  for (const value of f.values.filter(value => value.id !== "environment")) expect((await f.put(value.id, { ...value.metadata, ...f.canonical })).status).toBe(200);
  expect((await assertPreparedCleanup(f.input)).operation).toEqual(f.active.operation);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
});

const unsupportedUuidAliases = [
  ["shared", true], ["shared", "false"], ["accountId", "e".repeat(32)], ["account", "e".repeat(32)],
  ["zoneId", "e".repeat(32)], ["zone", "e".repeat(32)], ["tunnelId", "99999999-2222-3333-4444-555555555555"],
  ["dnsRecordId", "e".repeat(32)], ["source", "http://127.0.0.1:5173"], ["sourceAddress", "127.0.0.1:5173"], ["configPath", "/foreign/cloudflared.yml"],
] as const;
test.each(unsupportedUuidAliases)("UUID transition refuses unsupported nested %s=%s before receipt acknowledgment", async (field, value) => {
  const f = await legacyPreviewFixture(false, values => { values.find(item => item.id === "endpoint").metadata.tunnel[field] = value; }, true);
  const dns = f.values.find(item => item.id === "dns"), before = await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
  expect((await f.put(dns.id, { ...dns.metadata, ...f.canonical })).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT).each(unsupportedUuidAliases)("actual UUID preview adapter performs zero DELETE for unsupported nested %s=%s", async (field, value) => {
  const f = await legacyPreviewFixture(false, values => { values.find(item => item.id === "endpoint").metadata.tunnel[field] = value; }, true);
  const { taskRegistry } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
  const { releasePublicPreview } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/public-preview.ts"));
  const before = await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } }), calls: string[] = [];
  const socket = path.join(directory, "unsupported-preview.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const provider = { request: async (method: string, route: string) => {
      calls.push(`${method} ${route}`);
      if (method === "GET" && route === `/zones/${f.zone}/dns_records/${f.dnsId}`) return { id: f.dnsId, name: f.hostname, type: "CNAME", content: `${f.tunnelId}.cfargotunnel.com` };
      throw new Error("Unexpected provider effect in rejected association");
    } };
    await expect(releasePublicPreview({ registry: taskRegistry(socket, f.task.id, 3000), key: `${f.purpose}-cloudflare-tunnel`, provider,
      releaseConnector: async () => { throw new Error("Unexpected connector effect"); } })).rejects.toThrow("Frozen UUID preview");
    expect(calls).toEqual([`GET /zones/${f.zone}/dns_records/${f.dnsId}`]);
    expect(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
  } finally { server.stop(true); }
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT).each(["development", "review", "uuid"])("actual legacy preview adapter uses the original operation through discovery/deletion retry (format=%s)", async format => {
  const review = format === "review";
  const f = await legacyPreviewFixture(review, undefined, format === "uuid"), root = process.env.DRAFTED_INTEGRATION_ROOT!;
  const { taskRegistry } = await import(path.join(root, "src/control.ts"));
  const { releasePublicPreview, reconcilePublicPreview } = await import(path.join(root, "src/public-preview.ts"));
  const socket = path.join(directory, "preview.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const registry = taskRegistry(socket, f.task.id, 3000), calls: string[] = [];
    let dns = !review, tunnel = true, lostDelete = !review;
    const provider = { request: async (method: string, route: string) => {
      calls.push(`${method} ${route}`);
      if (route.includes("dns_records")) {
        if (method === "DELETE") { dns = false; if (lostDelete) { lostDelete = false; throw new Error("Lost exact DNS delete response"); } return null; }
        const value = dns ? { id: f.dnsId, name: f.hostname, type: "CNAME", content: `${f.tunnelId}.cfargotunnel.com` } : null;
        return route.includes("?") ? value ? [value] : [] : value;
      }
      if (route === `/accounts/${f.account}/cfd_tunnel/${f.tunnelId}`) { if (method === "DELETE") { tunnel = false; return null; } return tunnel ? { id: f.tunnelId, ...(format === "uuid" ? { name: "drafted-task-review" } : {}) } : null; }
      throw new Error(`Unexpected disposable provider request ${method} ${route}`);
    } };
    const key = `${f.purpose}-cloudflare-tunnel`, input = { registry, key, provider, releaseConnector: async () => { throw new Error("No fixture connector is registered"); } };
    await reconcilePublicPreview(input);
    expect(calls.every(call => call.startsWith("GET"))).toBeTrue();
    if (!review) await expect(releasePublicPreview(input)).rejects.toThrow("Lost exact DNS delete response");
    await releasePublicPreview(input);
    await releasePublicPreview(input);
    expect(tunnel).toBeFalse(); expect(dns).toBeFalse();
    expect(calls.filter(call => call.startsWith("DELETE"))).toHaveLength(review ? 1 : 2);
    expect((await assertPreparedCleanup(f.input)).operation).toEqual(f.active.operation);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(f.frozen);
  } finally { server.stop(true); }
});

test("compact legacy scope binds all exact aliases and preserves old responses and raw preparation/operation on linked receipt retry", async () => {
  const f = await resourceScopeFixture();
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const old = await (await f.renew(null)).json(); expect(old.resources).toBeUndefined();
  const response = await f.renew([...f.keys].reverse()); expect(response.status).toBe(200);
  const scoped = await response.json();
  expect(scoped.resources).toEqual(f.values.map(value => ({ id: value.id, key: value.key, identityDigest: finalizationResourceIdentity({ ...value, state: "ready" }).identityDigest })).sort((a, b) => a.key.localeCompare(b.key)));
  expect(scoped.cleanup).toEqual({ operationRevision: f.active.operationRevision, operationDigest: retirementDigest(f.active.operation) });
  expect((await f.renew([f.keys[0]!])).status).toBe(409);
  expect((await f.renew([f.keys[0]!, f.keys[0]!])).status).toBe(400);
  expect((await f.renew(["unknown"])).status).toBe(409);
  // Existing route semantics record a client-verified effect without changing
  // metadata. A lost acknowledgment can repeat either alias independently.
  for (const value of f.values) {
    const { id: _id, ...receipt } = value;
    expect((await f.put({ ...receipt, state: "released" })).status).toBe(200);
    expect(await (await f.renew()).json()).toEqual(scoped);
    expect((await f.put({ ...receipt, state: "released" })).status).toBe(200);
  }
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
});

test("legacy scope refuses pause, changed task/receipt/operation and completed cleanup without minting another proof", async () => {
  const f = await resourceScopeFixture();
  expect((await f.renew()).status).toBe(200);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  expect((await f.renew()).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false, pinnedToolingRoot: "/changed/pin" } });
  expect((await f.renew()).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: null } });
  await db.prisma.remoteTaskResource.update({ where: { id: "credentials" }, data: { metadata: { changed: true } } });
  expect((await f.renew()).status).toBe(409);
  await db.prisma.remoteTaskResource.update({ where: { id: "credentials" }, data: { metadata: f.values[1]!.metadata } });
  const event = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.active.operationRevision } });
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: event.sequence }, data: { value: JSON.stringify({ ...JSON.parse(event.value!), requestKey: "changed" }) } });
  expect((await f.renew()).status).toBe(409);
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: event.sequence }, data: { value: event.value } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `finalizer:${f.task.id}`, action: FINALIZATION_CONFIRMED, key: f.input.requestKey, value: JSON.stringify({ preparedRevision: f.prepared.preparedRevision }) } });
  expect((await f.renew()).status).toBe(409);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
});

test.each(["ancestor", "descendant", "released-claim", "worktree", "quarantine", "journal"])("legacy scope sees a new cross-task %s claim on the next renewal", async position => {
  const f = await resourceScopeFixture();
  const first = await (await f.renew()).json();
  await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", branchName: "codex/other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: "b".repeat(40), ...(position === "worktree" ? { worktreePath: path.join(f.environment, "worktree") } : {}) } });
  if (position !== "worktree") {
    const token = finalizationDigest({ task: f.task.id, root: f.environment, resources: first.resources });
    const externalId = position === "ancestor" ? path.dirname(f.environment) : position === "quarantine" ? path.join(path.dirname(f.environment), `.drafted-finalization-${token}`, "contents")
      : position === "journal" ? path.join(path.dirname(f.environment), `.drafted-environment-${token}.json`) : path.join(f.environment, "foreign.bin");
    await db.prisma.remoteTaskResource.create({ data: { id: "foreign", taskId: "other", key: "foreign", kind: "private-file", purpose: "development", externalId, state: position === "released-claim" ? "released" : "ready" } });
  }
  expect((await f.renew()).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id, state: "released" } })).toBe(0);
});

test.each(["direct-user", "email-alias", "session"])("legacy user scope reuses the bounded global Clerk %s sharing check", async shape => {
  const f = await resourceScopeFixture("clerk");
  expect((await f.renew()).status).toBe(200);
  await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", branchName: "codex/other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: "b".repeat(40) } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "other", key: "shared", kind: shape === "session" ? "clerk-test-session" : "clerk-test-user", purpose: "development", state: "ready",
    externalId: shape === "direct-user" ? "user_Exact" : shape === "email-alias" ? "other@example.com" : "sess_Exact", metadata: shape === "email-alias" ? { clerkUserId: "user_Exact" } : shape === "session" ? { userId: "user_Exact" } : {} } });
  expect((await f.renew()).status).toBe(409);
});

test.skipIf(!process.env.DRAFTED_ENVIRONMENT_INTEGRATION_ROOT)("actual scoped control client captures one environment and recovers linked receipt loss without new preparation", async () => {
  const f = await resourceScopeFixture();
  await mkdir(f.environment, { recursive: true, mode: 0o700 });
  await writeFile(path.join(f.environment, "test.env"), "PRIVATE_FIXTURE=value\n", { mode: 0o600 });
  const sourceInode = (await lstat(f.environment)).ino;
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const socket = path.join(directory, "scope.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const root = process.env.DRAFTED_ENVIRONMENT_INTEGRATION_ROOT!;
    const { taskRegistry } = await import(path.join(root, "src/control.ts"));
    const { manageLegacyEnvironment } = await import(path.join(root, "src/legacy-environment-resources.ts"));
    const registry = taskRegistry(socket, f.task.id, 3000), scoped = await registry.renewCleanupAuthority({ requestKey: f.input.requestKey, resourceKeys: f.keys });
    const token = finalizationDigest({ task: f.task.id, root: f.environment, resources: scoped.resources });
    const quarantine = path.join(path.dirname(f.environment), `.drafted-finalization-${token}`);
    await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", branchName: "codex/other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: "b".repeat(40) } });
    // Idle-process behavior is covered by the native adapter's real lsof
    // fixture. This pair isolates current server authority at capture time.
    const run = (extra: object = {}) => manageLegacyEnvironment({ registry, key: f.keys[0], action: "release", observation: { pathsIdle: async () => {} }, ...extra });
    await expect(run({ afterPlan: async () => {
      await db.prisma.remoteTaskResource.create({ data: { id: "late-claim", taskId: "other", key: "late-claim", kind: "private-file", purpose: "development", externalId: path.join(quarantine, "contents", "foreign"), state: "ready" } });
    } })).rejects.toThrow("another task");
    expect((await lstat(f.environment)).ino).toBe(sourceInode);
    expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id, state: "released" } })).toBe(0);
    await db.prisma.remoteTaskResource.delete({ where: { id: "late-claim" } });
    let lost = true;
    const resource = registry.resource;
    registry.resource = async (value: unknown) => { await resource(value); if (lost) { lost = false; throw new Error("lost linked acknowledgment"); } };
    await expect(run()).rejects.toThrow("lost linked acknowledgment");
    expect(await Bun.file(path.join(f.environment, "test.env")).exists()).toBeFalse();
    expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id, state: "released" } })).toBe(1);
    const result = await run();
    expect(result.quarantinePath).toBe(path.join(quarantine, "contents"));
    expect((await lstat(result.quarantinePath)).ino).toBe(sourceInode);
    expect(await readFile(path.join(result.quarantinePath, "test.env"), "utf8")).toBe("PRIVATE_FIXTURE=value\n");
    expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id, state: "released" } })).toBe(2);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
    expect(await registry.renewCleanupAuthority({ requestKey: f.input.requestKey, resourceKeys: f.keys })).toEqual(scoped);
  } finally { await server.stop(true); }
}, 30_000);

test.skipIf(!process.env.DRAFTED_CLERK_INTEGRATION_ROOT)("actual scoped control client refuses late shared Clerk ownership and recovers one lost DELETE response", async () => {
  const f = await resourceScopeFixture("clerk");
  const socket = path.join(directory, "clerk.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  try {
    const root = process.env.DRAFTED_CLERK_INTEGRATION_ROOT!;
    const { taskRegistry } = await import(path.join(root, "src/control.ts"));
    const { cleanupClerkProvider } = await import(path.join(root, "src/cleanup-observer-clerk.ts"));
    const { manageLegacyClerkResource } = await import(path.join(root, "src/legacy-clerk-resources.ts"));
    const registry = taskRegistry(socket, f.task.id, 3000);
    let present = true, reads = 0, effects = 0, inject = true, lose = true;
    await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", branchName: "codex/other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: "b".repeat(40) } });
    const provider = cleanupClerkProvider(async (url: string | URL, options: RequestInit) => {
      const route = new URL(String(url)).pathname;
      if (route === "/v1/instance") return Response.json({ id: "ins_Exact", environment_type: "development" });
      if (route !== "/v1/users/user_Exact") throw new Error("Unselected provider target");
      if (options.method === "GET") {
        if (++reads === 2 && inject) await db.prisma.remoteTaskResource.create({ data: { id: "shared-user", taskId: "other", key: "shared-user", kind: "clerk-test-user", purpose: "development", externalId: "user_Exact", state: "ready" } });
        return present ? Response.json({ id: "user_Exact", created_at: 123, email_addresses: [{ email_address: "dra80.scopetas+clerk_test@example.com" }] }) : new Response(null, { status: 404 });
      }
      if (options.method !== "DELETE") throw new Error("Unsupported provider effect");
      effects++; present = false;
      if (lose) { lose = false; throw new Error("lost provider response"); }
      return Response.json({ id: "user_Exact", deleted: true });
    }, async () => ({ descriptor: { backupFile: path.join(directory, "fixed.enc.json"), backupSha256: "a".repeat(64), keyFile: path.join(directory, "fixed.key"), keyId: "b".repeat(64) }, secret: "sk_test_disposable" }));
    const run = () => manageLegacyClerkResource({ registry, key: f.keys[0], action: "release", provider, journalRoot: path.join(directory, "clerk-retry") });
    await expect(run()).rejects.toThrow("shared"); expect(effects).toBe(0);
    inject = false; await db.prisma.remoteTaskResource.delete({ where: { id: "shared-user" } });
    await expect(run()).rejects.toThrow("Clerk cleanup request failed"); expect(effects).toBe(1);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "user" } })).state).toBe("ready");
    await run(); expect(effects).toBe(1);
    const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "user" } });
    expect(resource.state).toBe("released"); expect(resource.metadata).toEqual(f.values[0]!.metadata);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
  } finally { await server.stop(true); }
}, 30_000);

test.skipIf(!process.env.DRAFTED_COMPOSE_INTEGRATION_ROOT).each(["object", "name"])("actual aggregate Compose client retains original v1 preparation and operation through interrupted %s membership", async format => {
  const f = await fixture("compose-task"), purpose = "review", project = `drafted-${f.task.id}-${purpose}`;
  const environment = path.join(directory, "environments", `${f.task.id}-review`), file = path.join(environment, "compose.yml");
  await mkdir(environment, { recursive: true, mode: 0o700 }); await writeFile(file, "name: disposable-owned-group\n", { mode: 0o600 });
  const containerId = "a".repeat(64), networkId = "b".repeat(64), volume = `${project}-data`, networkName = `${project}-default`;
  const metadata = { composeFile: file, containers: { mysql: containerId.slice(0, 12) }, volumes: [volume], network: format === "object" ? { id: networkId.slice(0, 12), name: networkName, subnet: "10.236.71.0/24" } : networkName };
  const receipt = await db.prisma.remoteTaskResource.create({ data: { id: "original-group", taskId: f.task.id, key: "compose-review", kind: "docker-compose-project", purpose, externalId: project, state: "ready", metadata } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies), active = await bindPreparedCleanup(f.input, async () => {});
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const socket = path.join(directory, "compose.sock"), server = Bun.serve({ unix: socket, fetch: app.fetch });
  try {
    const root = process.env.DRAFTED_COMPOSE_INTEGRATION_ROOT!;
    const { taskRegistry } = await import(path.join(root, "src/control.ts"));
    const { manageResource } = await import(path.join(root, "src/resources.ts"));
    const registry = taskRegistry(socket, f.task.id, 3000), labels = { "dev.drafted.task": f.task.id, "dev.drafted.purpose": purpose, "com.docker.compose.project": project };
    const objects = new Map<string, any>([
      [`container:${containerId}`, { id: containerId, createdAt: "original-container", running: true, image: "sha256:original", networks: [networkId], volumes: [volume], labels: { ...labels, "com.docker.compose.service": "mysql", "com.docker.compose.project.config_files": file, "com.docker.compose.project.working_dir": environment } }],
      [`network:${networkId}`, { id: networkId, name: networkName, createdAt: "original-network", subnets: ["10.236.71.0/24"], labels }],
      [`volume:${volume}`, { id: volume, createdAt: "original-volume", labels }],
    ]);
    const effects: string[] = []; let pause = true, loseRemove = true, loseReceipt = true;
    const docker = {
      inspect: async (kind: string, id: string) => structuredClone(objects.get(`${kind}:${id}`) ?? null),
      resolve: async (kind: string, id: string) => { const matches = [...objects].filter(([key]) => key.startsWith(`${kind}:${id}`)); if (matches.length > 1) throw new Error("ambiguous"); return structuredClone(matches[0]?.[1] ?? null); },
      inventory: async (kind: string) => {
        const values = structuredClone([...objects].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value));
        if (pause && kind === "volume") { pause = false; await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } }); }
        return values;
      },
      stop: async (id: string) => { effects.push(`stop:${id}`); objects.get(`container:${id}`)!.running = false; },
      remove: async (kind: string, id: string) => { effects.push(`remove:${kind}:${id}`); objects.delete(`${kind}:${id}`); if (loseRemove) { loseRemove = false; throw new Error("lost exact removal response"); } },
    };
    const run = () => manageResource({ registry, key: receipt.key, action: "release", allowEarlyRelease: true, docker, compose: { journalRoot: path.join(directory, "compose-journal") } });
    await expect(run()).rejects.toThrow("Finalization requires the open complete task's original primary"); expect(effects).toEqual([]);
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).ownerPaused).toBeTrue();
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    await expect(run()).rejects.toThrow("lost exact removal response");
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: receipt.id } })).state).toBe("ready");
    const resource = registry.resource;
    registry.resource = async (value: unknown) => { await resource(value); if (loseReceipt) { loseReceipt = false; throw new Error("lost aggregate receipt response"); } };
    await expect(run()).rejects.toThrow("lost aggregate receipt response");
    expect(await run()).toMatchObject({ state: "released" });
    expect(effects).toEqual([`stop:${containerId}`, `remove:container:${containerId}`, `remove:network:${networkId}`, `remove:volume:${volume}`]);
    const released = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(released.metadata).toEqual(metadata); expect(released.externalId).toBe(receipt.externalId);
    expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id } })).toBe(1);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
    expect((await assertPreparedCleanup(f.input)).operation).toEqual(active.operation);
    expect((await registry.task()).cleanupOperation.preparedRevision).toBe(prepared.preparedRevision);
  } finally { await server.stop(true); }
}, 30_000);

test("existing preparation automatically binds once across lost responses without source status or provider reads", async () => {
  const f = await preparedFixture();
  f.issue.state = f.states[2]!;
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  let observations = 0;
  const first = await bindPreparedCleanup(f.input, async () => { observations++; await f.observe(); });
  for (const state of [f.states[0]!, f.states[1]!, f.states[2]!, { id: "custom", name: "Owner chose another status", type: "unstarted" }]) {
    f.issue.state = state;
    expect((await bindPreparedCleanup(f.input, async () => { throw new Error("Do not repeat accepted delivery observations"); })).operationRevision).toBe(first.operationRevision);
  }
  expect(observations).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: f.frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(f.frozen);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("waiting");
});

test("cheap checks cannot establish authority, and generic receipts or a bare Done cannot replace real preparation", async () => {
  const f = await fixture(); f.issue.state = f.states[1]!;
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "cleanup", kind: "finalization", purpose: "development", externalId: "claimed", state: "released", metadata: { prepared: true } } });
  await expect(bindPreparedCleanup(f.input, async () => {})).rejects.toThrow("existing preparation");
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("existing preparation");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("pause, contract revocation and retirement revocation cannot be escaped by rebinding or a new request key", async () => {
  const f = await preparedFixture();
  await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("paused");
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("paused");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "delivered-retirement-revoked", key: "explicit-revoke", value: JSON.stringify({ basis: "Owner revoked cleanup" }) } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("explicitly revoked");
  await expect(bindPreparedCleanup({ ...f.input, requestKey: "fresh-key" }, f.observe)).rejects.toThrow("stable finalization");
  await f.revoke();
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("revoked or replaced");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
});

test("an explicit 183 revocation before the first lifecycle binding still prevents cleanup", async () => {
  const f = await preparedFixture();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-retirement-authority", key: "revoke-183", value: JSON.stringify({ version: 1, action: "revoke", input: { basis: "Owner revoked retirement" } }) } });
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("explicitly revoked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("original task pin, resource metadata, added targets and retained-proof drift invalidate the frozen scope", async () => {
  const f = await preparedFixture();
  await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "b".repeat(40) } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("pin changed");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "a".repeat(40) } });
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: { taskId: "other-task" } } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("resource identity");
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: { taskId: f.task.id } } });
  const added = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "other", kind: "docker-volume", purpose: "development", externalId: "new-volume", state: "ready" } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("scope changed");
  await db.prisma.remoteTaskResource.delete({ where: { id: added.id } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "legacy-evidence-retained", key: "new-proof", value: JSON.stringify({ changed: true }) } });
  await expect(bindPreparedCleanup(f.input, f.observe)).rejects.toThrow("retention proof");
});

test("release progress and ordinary annotations keep the same operation; released targets cannot be resurrected", async () => {
  const f = await preparedFixture();
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  const first = await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: { taskId: f.task.id, observed: "already absent", observedAt: new Date().toISOString() } } });
  expect((await assertPreparedCleanup(f.input)).operationRevision).toBe(first.operationRevision);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "ready" } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("terminal state");
});

test("revocation and target mutation during initial observations win the transaction CAS", async () => {
  const f = await preparedFixture();
  await expect(bindPreparedCleanup(f.input, async () => { await f.revoke(); })).rejects.toThrow("revoked or replaced");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("a real database survives restart and 128 local batch checks finish within a provider-read deadline", async () => {
  const f = await preparedFixture();
  await bindPreparedCleanup(f.input, f.observe);
  await db.prisma.$disconnect();
  // This is real SQLite work, without simulated renewal sleeps. The deadline
  // is below one observed 11–12s provider/source/archive renewal in DRA-12.
  const start = performance.now();
  for (let batch = 0; batch < 128; batch++) await assertPreparedCleanup({ ...f.input });
  expect(performance.now() - start).toBeLessThan(10_000);
  const operation = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: CLEANUP_OPERATION } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: operation.runtimeSessionId, source: operation.source, action: operation.action, key: operation.key, value: operation.value } }))).rejects.toThrow();
  expect((await assertPreparedCleanup({ ...f.input })).operationRevision).toBe(operation.sequence);
}, 15_000);

test("actual preparation and confirmation use the original receipt while Linear is unavailable and phase is waiting", async () => {
  const f = await preparedFixture();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const input = { ...f.input, cleanup: true as const };
  const unavailable = { ...f.dependencies, source: async () => { throw new Error("Linear unavailable"); }, completion: async () => { throw new Error("Provider observation must not repeat"); } };
  await expect(prepareTaskFinalization({ ...input, authorityOnly: true }, unavailable)).rejects.toThrow("not bound");
  const bound = await prepareTaskFinalization(input, unavailable);
  expect(bound).toMatchObject(f.prepared);
  expect("cleanup" in bound && bound.cleanup?.operationRevision).toBeGreaterThan(f.prepared.preparedRevision);
  expect(await prepareTaskFinalization({ ...input, authorityOnly: true }, unavailable)).toEqual(bound);
  await expect(confirmTaskFinalization(input, unavailable)).rejects.toThrow("unreleased");
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  f.remove();
  const confirmed = await confirmTaskFinalization(input, unavailable);
  expect(confirmed.preparedRevision).toBe(f.prepared.preparedRevision);
  expect(confirmed.confirmedRevision).toBeDefined();
  expect(await confirmTaskFinalization(input, unavailable)).toEqual(confirmed);
  expect(await prepareTaskFinalization({ ...input, authorityOnly: true }, unavailable)).toEqual(confirmed);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.frozen.find(row => row.sequence === f.prepared.preparedRevision)!.value);
});

test("new cleanup prepares accepted delivery from a waiting/custom-status task without requiring current Merge", async () => {
  const f = await fixture(); f.issue.state = { id: "custom", name: "Owner chose a custom state", type: "unstarted" };
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const bound = await prepareTaskFinalization({ ...f.input, cleanup: true }, f.dependencies);
  expect("cleanup" in bound && bound.cleanup?.operationRevision).toBeGreaterThan(bound.preparedRevision);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  expect(f.issue.state.id).toBe("custom");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("waiting");
});

test("new cleanup uses stored accepted owner source identity when Linear is unavailable and still observes exact delivery", async () => {
  const f = await fixture();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-owner-approval", key: "owner",
    value: JSON.stringify({ actorId: "configured-owner", contractRevision: f.contract.revision, requestKey: "owner", issueId: f.issue.id, issueIdentifier: f.issue.identifier, connectionId: f.task.connectionId }) } });
  let delivered = 0;
  const unavailable = { ...f.dependencies, source: async () => { throw new Error("Linear unavailable"); },
    completion: async (input: Parameters<typeof assertCompletionAllowed>[0]) => { delivered++; return f.dependencies.completion(input); } };
  const first = await prepareTaskFinalization({ ...f.input, cleanup: true }, unavailable);
  expect(delivered).toBe(1);
  expect(await prepareTaskFinalization({ ...f.input, cleanup: true, authorityOnly: true }, unavailable)).toEqual(first);
  expect(delivered).toBe(1);
  await f.revoke();
  await expect(prepareTaskFinalization({ ...f.input, cleanup: true }, unavailable)).rejects.toThrow("revoked or replaced");
});

test("new cleanup cannot replace a differently keyed preparation or escape a prior explicit revocation", async () => {
  const f = await fixture();
  const existing = await prepareTaskFinalization({ ...f.input, requestKey: "original-key" }, f.dependencies);
  await expect(prepareTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).rejects.toThrow("cannot replace");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: existing.preparedRevision } })).not.toBeNull();
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: existing.preparedRevision } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "delivered-retirement-revoked", key: "owner-revoke", value: JSON.stringify({ basis: "Owner revoked retirement" }) } });
  await expect(prepareTaskFinalization({ ...f.input, cleanup: true }, f.dependencies)).rejects.toThrow("explicitly revoked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(0);
});

test("actual resource routes reject new targets and resurrection while allowing paused stop observations", async () => {
  const f = await preparedFixture(); await bindPreparedCleanup(f.input, f.observe);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/sessions", sessionTaskRoutes);
  const put = (body: unknown) => app.request(`/api/sessions/${f.session.id}/task/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const resource = { key: "data", kind: "docker-volume", purpose: "development", externalId: "exact-owned-volume", state: "ready", metadata: { taskId: f.task.id } };
  expect((await put({ ...resource, key: "new-target", externalId: "other-volume" })).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id } })).toBe(1);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  expect((await put({ ...resource, metadata: { ...resource.metadata, observed: "stopped", observedAt: new Date().toISOString() } })).status).toBe(200);
  expect((await put({ ...resource, state: "released" })).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  expect((await put({ ...resource, state: "released" })).status).toBe(200);
  expect((await put(resource)).status).toBe(409);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "volume" } })).state).toBe("released");
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual control client and server renew 128 batches with retained archive proof without task GET or provider reads", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRoot: f.root, pinnedToolingRoot: f.root } });
  const archive = path.join(directory, "retained");
  await mkdir(archive, { mode: 0o700 });
  const bytes = Buffer.alloc(8 * 1024 * 1024, 7), sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  await writeFile(path.join(archive, "snapshot.bin"), bytes, { mode: 0o600 });
  const manifest = JSON.stringify({ task: f.task.id, issue: f.task.issueIdentifier, mergedCommit: f.remote.pullRequest.mergeCommit.oid, count: 1,
    entries: [{ archivePath: "snapshot.bin", sourcePath: "/historical/snapshot", sha256: sha(bytes), bytes: bytes.length }] });
  await writeFile(path.join(archive, "ARCHIVE-MANIFEST.json"), manifest, { mode: 0o600 });
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "retained", kind: "evidence-archive", purpose: "development", externalId: archive, state: "ready",
    metadata: { archival: true, manifest: { path: "ARCHIVE-MANIFEST.json", sha256: sha(manifest), entries: 1 } } } });
  const original = await prepareTaskFinalization(f.input, f.dependencies);
  expect("archiveRetention" in original && original.archiveRetention).toBeTruthy();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  let taskReads = 0;
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .use("*", async (c, next) => { if (c.req.method === "GET") taskReads++; await next(); }).route("/api/tasks", taskRoutes);
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: app.fetch });
  const stopPreparation = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime: createFakeAgentRuntime() }, async () => {}, { prepareFinalization: input => prepareTaskFinalization(input, f.dependencies) });
  try {
    const { taskRegistry } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
    let registry = taskRegistry(socket, f.task.id, 1000);
    const request = { requestKey: f.input.requestKey, cleanup: true as const };
    const bound = await registry.prepareFinalization!(request);
    expect(bound).toMatchObject(original);
    expect(bound.cleanup.operationRevision).toBeGreaterThan(original.preparedRevision);
    const before = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
    const start = performance.now();
    for (let batch = 0; batch < 128; batch++) {
      if (batch === 64) { await db.prisma.$disconnect(); registry = taskRegistry(socket, f.task.id, 1000); }
      expect(await registry.prepareFinalization!({ ...request, authorityOnly: true })).toEqual(bound);
    }
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(taskReads).toBe(0);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(before);
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    await expect(registry.prepareFinalization!({ ...request, authorityOnly: true })).rejects.toThrow("original primary");
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    await writeFile(path.join(archive, "snapshot.bin"), "changed retained bytes", { mode: 0o600 });
    await expect(registry.prepareFinalization!(request)).rejects.toThrow();
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
  } finally { await stopPreparation(); await server.stop(true); }
}, 30_000);


test("cleanup progress survives restart but diagnostic success cannot release resources or expand the bound scope", async () => {
  const f = await preparedFixture(), active = await bindPreparedCleanup(f.input, f.observe);
  const operation = { operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation) };
  const progress = { ...operation, requestKey: f.input.requestKey, outcomes: [{ key: "data", outcome: "released", detail: "provider password=do-not-store\n403 " + "x".repeat(2000) }] };
  const input = { ...f.context, progress };
  const first = await recordCleanupProgress(input);
  expect(first.resources).toMatchObject([{ key: "data", state: "ready", outcome: "blocked" }]);
  expect(first.resources[0]!.detail).not.toContain("do-not-store"); expect(first.resources[0]!.detail!.length).toBe(1000);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "volume" } })).state).toBe("ready");
  expect((await recordCleanupProgress(input)).revision).toBe(first.revision);
  await db.prisma.$disconnect();
  expect((await cleanupProgressProjection(db.prisma, f.task, operation)).cleanupProgress?.resources).toEqual(first.resources);
  await expect(recordCleanupProgress({ ...input, progress: { ...progress, outcomes: [{ key: "foreign", outcome: "released" }] } })).rejects.toThrow("unknown or duplicate");
  await expect(recordCleanupProgress({ ...input, progress: { ...progress, operationDigest: "f".repeat(64) } })).rejects.toThrow("operation changed");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(recordCleanupProgress(input)).rejects.toThrow("paused");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  expect((await recordCleanupProgress(input)).resources[0]!.outcome).toBe("released");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_PROGRESS } })).toBe(2);
  await f.revoke();
  await expect(recordCleanupProgress(input)).rejects.toThrow("revoked");
});


test("automatic cleanup candidates exclude pause, changed original ownership and revoked acceptance", async () => {
  const f = await fixture(); f.issue.state.name = "Custom owner status";
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes);
  const candidate = async () => (await (await app.request("/api/tasks?pagination=id")).json()).tasks.find((task: { id: string }) => task.id === f.task.id).finalizationPending;
  expect(await candidate()).toBeTrue();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(0);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } }); expect(await candidate()).toBeFalse();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: f.root } }); expect(await candidate()).toBeFalse();
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: f.worktree } }); expect(await candidate()).toBeTrue();
  await f.revoke(); expect(await candidate()).toBeFalse();
});


test("automatic operation keeps exact turn protection across omitted flags, deferred work, restart and a new serialized attempt", async () => {
  const f = await preparedFixture();
  const capability = async () => ({ receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
    taskToolingRevision: f.task.toolingRevision, capabilityRevision: "b".repeat(40), checkout: "/fixture/immutable", instructions: "/fixture/immutable/cleanup.md", adapter: "/fixture/immutable/src/cli.ts" }, instructions: "Fixture immutable cleanup adapter" });
  const start = async (key: string) => {
    const queued = await enqueueTaskCleanup({ prisma: db.prisma, config: f.config, taskId: f.task.id, requestKey: key }, { capability });
    await db.prisma.runtimeInstruction.update({ where: { id: queued.instructionId }, data: { state: "dispatching", executionRequestId: key } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: key, runtimeSessionId: f.session.id, requestId: key, phase: "started", occurredAt: new Date() } });
    return queued;
  };
  const first = await start("first-cleanup-turn");
  const bound = await bindPreparedCleanup(f.input, f.observe);
  expect(bound.operation.automatic).toEqual({ kind: "primary-inbox", initialInstructionId: first.instructionId });
  await db.prisma.runtimeInstruction.create({ data: { id: "followup", sessionId: f.session.id, text: "Owner follow-up", state: "queued" } });
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("pending task instructions");
  await expect(prepareTaskFinalization({ ...f.input, authorityOnly: true }, f.dependencies)).rejects.toThrow("pending task instructions");
  await db.prisma.runtimeInstruction.update({ where: { id: first.instructionId }, data: { state: "completed" } });
  await db.prisma.runtimeInstruction.update({ where: { id: "followup" }, data: { state: "completed" } });
  await db.prisma.$disconnect();
  await expect(assertPreparedCleanup(f.input)).rejects.toThrow("exact executing");
  await start("later-cleanup-turn");
  expect((await assertPreparedCleanup(f.input)).operation).toEqual(bound.operation);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.frozen.find(event => event.sequence === f.prepared.preparedRevision)!.value);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  f.remove();
  await confirmTaskFinalization({ ...f.input, cleanup: true }, f.dependencies);
  // A follow-up can arrive after confirmed physical removal but before close.
  // It must remain queued, with the original primary open to handle it.
  await db.prisma.runtimeInstruction.create({ data: { id: "after-confirm", sessionId: f.session.id, text: "New request after removal", state: "queued" } });
  const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.worktree, repositoryId: f.task.repositoryId, machineId: f.task.machineId, role: "primary", status: "active" }]);
  runtime.observeSessionActivity = () => ({ state: "executing", requestId: "later-cleanup-turn", observedAt: Date.now() });
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient })).route("/api/tasks", taskSupervisionRoutes);
  const response = await app.request("/api/tasks/task/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", cleanup: true }) });
  expect(response.status).toBe(409);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "after-confirm" } })).state).toBe("queued");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).not.toBe("closed");
  expect(runtime.closedSessionIds).toEqual([]);
  const explicitOwner = await app.request("/api/tasks/task/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close" }) });
  expect(explicitOwner.status).toBe(200);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "after-confirm" } })).state).toBe("cancelled");
});

for (const partial of [false, true]) test.skipIf(process.platform !== "darwin" || !process.env.DRAFTED_PROXY_INTEGRATION_ROOT)(`actual whole finalizer reconciles bound Compose groups and retired proxy aliases without changing original proofs${partial ? " with retained spatial partition" : ""}`, async () => {
  const f = await fixture("whole-proxy-task"), client = process.env.DRAFTED_PROXY_INTEGRATION_ROOT!;
  const { homedir } = await import("node:os");
  const { taskRegistry } = await import(path.join(client, "src/control.ts"));
  const { finalizeTask } = await import(path.join(client, "src/finalize.ts"));
  const { manageResource } = await import(path.join(client, "src/resources.ts"));
  const { legacyNativeLink } = await import(path.join(client, "src/legacy-native.ts"));
  const { inspectHostProcess } = await import(path.join(client, "src/runtime-transfer-host.ts"));
  const { terminateHostProcess } = await import(path.join(client, "src/runtime-transfer-signal.ts"));
  const environment = path.join(directory, "environments", f.task.id), script = path.join(environment, "scripts/preview-proxy.ts"), pidFile = path.join(environment, "proxy.pid");
  await mkdir(path.dirname(script), { recursive: true });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = reservation.port!; reservation.stop(true);
  await writeFile(script, `Bun.serve({hostname:'127.0.0.1',port:${port},fetch:()=>new Response('existing data')});\n`);
  await writeFile(path.join(environment, "run.sh"), `#!/bin/bash\nW="${f.worktree}"\nD="${environment}"\nexport PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="${homedir()}" REMOTE_AGENT_TASK_ID=${f.task.id} TZ=UTC\ncase "$1" in\n  proxy) exec bun --no-env-file run "$D/scripts/preview-proxy.ts" ;;\nesac\n`, { mode: 0o700 });
  const saved = path.join(environment, "retained-data"); await writeFile(saved, "original PostGIS bytes", { mode: 0o600 });
  const objects = new Map<string, any>(), effects: string[] = [];
  const addGroup = async (purpose: "development" | "review", id: string, network: string) => {
    const project = `drafted-${f.task.id}-${purpose}`, env = path.join(directory, "environments", `${f.task.id}${purpose === "review" ? "-review" : ""}`), file = path.join(env, "compose.yml"), volume = `${project}-data`, service = purpose === "development" ? "spatial" : "mysql";
    await mkdir(env, { recursive: true }); await writeFile(file, "name: exact-owned\n", { mode: 0o600 });
    const labels = { "dev.drafted.task": f.task.id, "dev.drafted.purpose": purpose, "com.docker.compose.project": project };
    objects.set(`container:${id}`, { id, createdAt: "original-container", image: `sha256:${service}`, running: purpose === "review", networks: [network], volumes: [volume], labels: { ...labels, "com.docker.compose.service": service, "com.docker.compose.project.config_files": file, "com.docker.compose.project.working_dir": env } });
    objects.set(`network:${network}`, { id: network, name: `${project}-default`, createdAt: "original-network", labels });
    objects.set(`volume:${volume}`, { id: volume, createdAt: "original-volume", labels });
    const resource = await db.prisma.remoteTaskResource.create({ data: { id: `${purpose}-group`, taskId: f.task.id, key: purpose === "development" ? "compose-development-r2" : "compose-review", kind: "docker-compose-project", purpose, externalId: project, state: "ready",
      metadata: { composeFile: file, containers: { [service]: id.slice(0, 12) }, volumes: [volume], network: `${project}-default`, ...(purpose === "development" ? { supersedes: "compose-development (released)" } : {}) } } });
    return { resource, id, network, volume, file };
  };
  const development = await addGroup("development", "a".repeat(64), "b".repeat(64)), review = await addGroup("review", "c".repeat(64), "d".repeat(64));
  await db.prisma.remoteTaskResource.create({ data: { id: "historical-group", taskId: f.task.id, key: "compose-development", kind: "docker-compose-project", purpose: "development", externalId: development.resource.externalId, state: "released", metadata: { composeFile: development.file } } });
  await db.prisma.remoteTaskResource.create({ data: { id: "retained-neon", taskId: f.task.id, key: "retained-neon", kind: "neon-branch-database", purpose: "development", externalId: "branch/task_spatial", state: "ready", metadata: { cutoverReceipt: path.join(environment, "retained-cutover.json"), supersedes: "local PostGIS in compose-development-r2 (stopped by owner cutover; volume retained; not restarted)" } } });
  if (partial) {
    const cutoverDirectory = path.join(directory, "cutovers", development.resource.externalId), cutoverReceipt = path.join(cutoverDirectory, "receipt.private.json");
    await mkdir(cutoverDirectory, { recursive: true, mode: 0o700 });
    await writeFile(cutoverReceipt, JSON.stringify({ project: development.resource.externalId, branchId: "br-original", state: "migrated", startedAt: "2026-10-29T00:00:00Z", completedAt: "2026-10-29T00:01:00Z",
      files: [development.file, path.join(environment, "spatial.env")].map((file, index) => ({ file, backup: path.join(cutoverDirectory, `file-${index}.backup`) })) }), { mode: 0o600 });
    await db.prisma.remoteTaskResource.update({ where: { id: "retained-neon" }, data: { externalId: "br-original/task_spatial", metadata: { cutoverReceipt, runtimeDatabase: "task_spatial", supersedes: "local PostGIS in compose-development-r2 (stopped by owner cutover; volume retained; not restarted)" } } });
    const metadata = structuredClone(development.resource.metadata) as any;
    for (const [index, service] of ["mysql", "redis", "redis-http", "minio"].entries()) {
      const id = String(index + 1).repeat(64), template = objects.get(`container:${development.id}`), volume = `${development.resource.externalId}-${service}`;
      metadata.containers[service] = id;
      objects.set(`container:${id}`, { ...structuredClone(template), id, labels: { ...template.labels, "com.docker.compose.service": service }, image: `sha256:${service}`, running: true, volumes: service === "redis-http" ? [] : [volume] });
      if (service !== "redis-http") { metadata.volumes.push(volume); objects.set(`volume:${volume}`, { ...structuredClone(objects.get(`volume:${development.volume}`)), id: volume }); }
    }
    await db.prisma.remoteTaskResource.update({ where: { id: development.resource.id }, data: { metadata } });
  }
  const child = Bun.spawn(["bun", "--no-env-file", "run", script], { cwd: f.worktree, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await writeFile(pidFile, `${child.pid}\n`);
  let server: ReturnType<typeof Bun.serve> | undefined, stopPreparation: (() => Promise<void>) | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)) { if (Date.now() > deadline) throw Error("Fixture proxy did not start"); await Bun.sleep(20); }
    for (const generation of [2, 3, 4]) await db.prisma.remoteTaskResource.create({ data: { id: `endpoint-${generation}`, taskId: f.task.id, key: generation === 4 ? "proxy-development-r4" : `local-http-development-r${generation}`, kind: "local-http", purpose: "development", externalId: `http://${generation === 4 ? "127.0.0.1" : "localhost"}:${port}`, state: "allocated",
      metadata: generation === 4 ? { pid: child.pid, pidFile, script, supersedesProxyPid: 123, observed: "historical unchanged" } : generation === 2 ? { processes: { proxy: { pid: 123 } } } : { supersedes: "local-http-development-r2" } } });
    const prepared = await prepareTaskFinalization(f.input, f.dependencies), active = await bindPreparedCleanup(f.input, async () => {});
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }), original = await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id }, orderBy: { id: "asc" } });
    const preserved = JSON.stringify([...objects].filter(([key]) => [`container:${development.id}`, `network:${development.network}`, `volume:${development.volume}`].includes(key)));
    const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine, role: "primary", status: "idle" }]);
    const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient })).route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
    const socket = path.join(directory, "whole-proxy.sock"); server = Bun.serve({ unix: socket, fetch: app.fetch }); await chmod(socket, 0o600);
    stopPreparation = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime }, async () => {});
    const registry = taskRegistry(socket, f.task.id, 10_000), signals: number[] = []; let loseRemoval = true, loseReceipt = true, proofFile: string | undefined;
    const provider = { inspect: inspectHostProcess, managers: async () => [], processes: async () => await inspectHostProcess(child.pid) ? [{ pid: child.pid, ppid: process.pid, pgid: child.pid, uid: process.getuid!(), cwd: f.worktree }] : [],
      terminate: async (value: any) => { signals.push(value.pid); await terminateHostProcess(value, inspectHostProcess); } };
    const docker = {
      inspect: async (kind: string, id: string) => structuredClone(objects.get(`${kind}:${id}`) ?? null),
      resolve: async (kind: string, id: string) => structuredClone([...objects].find(([key]) => key.startsWith(`${kind}:${id}`))?.[1] ?? null),
      inventory: async (kind: string) => structuredClone([...objects].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value)),
      stop: async (id: string) => { effects.push(`stop:${id}`); objects.get(`container:${id}`).running = false; },
      remove: async (kind: string, id: string) => { effects.push(`remove:${kind}:${id}`); objects.delete(`${kind}:${id}`); if (loseRemoval && id === (partial ? "1".repeat(64) : review.id)) { loseRemoval = false; throw Error("lost exact member removal"); } },
    };
    const resource = registry.resource; registry.resource = async (value: any) => { const result = await resource(value); const link = legacyNativeLink(value.metadata); if (link) proofFile = link.file; if (value.key === review.resource.key && value.state === "released" && loseReceipt) { loseReceipt = false; throw Error("lost Released acknowledgment"); } return result; };
    const proofDirectory = path.join(directory, "native-proofs"), journalRoot = path.join(directory, "compose-journal");
    const run = () => finalizeTask({ registry, cleanup: true, nativeReconciliation: { provider, proofDirectory }, manage: (input: any) => manageResource({ ...input, docker, compose: { journalRoot }, serviceStop: { provider, proofDirectory } }), close: async () => { throw Error("Retained source forbids closure"); } });
    await expect(run()).rejects.toThrow("Cleanup preserved task resources");
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: review.resource.id } })).state).toBe(partial ? "released" : "ready");
    expect(await inspectHostProcess(child.pid)).toBeNull(); expect(signals).toEqual([child.pid]);
    const journalFile = path.join(journalRoot, `${finalizationDigest({ taskId: f.task.id, resourceId: review.resource.id })}.json`);
    if (!proofFile) throw Error("Fixture never recorded its native proof");
    const proofBytes = await readFile(proofFile), journalBytes = await readFile(journalFile), journalInode = (await lstat(journalFile)).ino;
    const retainedJournalFile = path.join(journalRoot, `${finalizationDigest({ taskId: f.task.id, resourceId: development.resource.id })}.json`);
    const retainedJournalBytes = partial ? await readFile(retainedJournalFile) : undefined, retainedJournalInode = partial ? (await lstat(retainedJournalFile)).ino : undefined;
    await expect(run()).rejects.toThrow("Cleanup preserved task resources");
    await expect(run()).rejects.toThrow("Cleanup preserved task resources");
    const current = await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id }, orderBy: { id: "asc" } });
    expect(current.filter(row => row.kind === "local-http").map(row => row.state)).toEqual(["released", "released", "released"]);
    expect(current.find(row => row.id === review.resource.id)!.state).toBe("released"); expect(current.find(row => row.id === development.resource.id)!.state).toBe("ready");
    expect(current.map(finalizationResourceIdentity)).toEqual(original.map(finalizationResourceIdentity));
    if (partial) {
      expect(effects.filter(effect => effect.startsWith("remove:"))).toHaveLength(10); expect(effects.filter(effect => effect.startsWith("stop:"))).toHaveLength(5);
      expect(new Set(effects).size).toBe(effects.length);
      expect(await readFile(retainedJournalFile)).toEqual(retainedJournalBytes!); expect((await lstat(retainedJournalFile)).ino).toBe(retainedJournalInode!);
      expect(JSON.parse(retainedJournalBytes!.toString()).retained.memberKeys).toHaveLength(3);
    } else expect(effects).toEqual([`stop:${review.id}`, `remove:container:${review.id}`, `remove:network:${review.network}`, `remove:volume:${review.volume}`]);
    expect(JSON.stringify([...objects])).toBe(preserved); expect(await readFile(saved, "utf8")).toBe("original PostGIS bytes"); expect(signals).toEqual([child.pid]);
    expect(await readFile(proofFile)).toEqual(proofBytes); expect(await readFile(journalFile)).toEqual(journalBytes); expect((await lstat(journalFile)).ino).toBe(journalInode);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
    expect((await assertPreparedCleanup(f.input)).operation).toEqual(active.operation); expect((await registry.task()).cleanupOperation.preparedRevision).toBe(prepared.preparedRevision);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
    expect(await readFile(path.join(f.worktree, "README.md"), "utf8")).toBe("accepted content\n"); expect(git(f.root, "worktree", "list", "--porcelain")).toContain(f.worktree);
    const progress = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: CLEANUP_PROGRESS }, orderBy: { sequence: "desc" } });
    const developmentProgress = JSON.parse(progress.value!).resources.find((row: any) => row.key === development.resource.key);
    // Partial physical cleanup does not grant a new v1 retained disposition.
    if (partial) expect(developmentProgress).toMatchObject({ state: "ready", outcome: "blocked" });
    else expect(developmentProgress.detail).toBe("Compose group contains an explicitly retained migration source; preserve its data");
  } finally { const current = await inspectHostProcess(child.pid); if (current?.cwd === f.worktree) await terminateHostProcess(current, inspectHostProcess); await child.exited; await stopPreparation?.(); await server?.stop(true); }
}, 30_000);

test.skipIf(process.platform !== "darwin" || !process.env.DRAFTED_PROXY_INTEGRATION_ROOT)("actual recorded proxy stop preserves bound preparation and operation through late pause and lost signal", async () => {
  const f = await fixture("proxy-task"), client = process.env.DRAFTED_PROXY_INTEGRATION_ROOT!;
  const { homedir } = await import("node:os");
  const { taskRegistry } = await import(path.join(client, "src/control.ts"));
  const { manageResource } = await import(path.join(client, "src/resources.ts"));
  const { reconcileLegacyNativeResources, legacyNativeLink } = await import(path.join(client, "src/legacy-native.ts"));
  const { inspectHostProcess } = await import(path.join(client, "src/runtime-transfer-host.ts"));
  const { terminateHostProcess } = await import(path.join(client, "src/runtime-transfer-signal.ts"));
  const environment = path.join(directory, "environments", f.task.id), script = path.join(environment, "scripts/preview-proxy.ts"), pidFile = path.join(environment, "proxy.pid");
  await mkdir(path.dirname(script), { recursive: true });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = reservation.port!; reservation.stop(true);
  await writeFile(script, `Bun.serve({hostname:'127.0.0.1',port:${port},fetch:()=>new Response('existing data')});\n`);
  await writeFile(path.join(environment, "run.sh"), `#!/bin/bash\nW="${f.worktree}"\nD="${environment}"\nexport PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="${homedir()}" REMOTE_AGENT_TASK_ID=${f.task.id} TZ=UTC\ncase "$1" in\n  proxy) exec bun --no-env-file run "$D/scripts/preview-proxy.ts" ;;\nesac\n`, { mode: 0o700 });
  await writeFile(path.join(environment, "compose.yml"), "name: exact-original\n", { mode: 0o600 });
  const saved = path.join(environment, "retained-data"); await writeFile(saved, "original PostGIS bytes", { mode: 0o600 });
  const child = Bun.spawn(["bun", "--no-env-file", "run", script], { cwd: f.worktree, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await writeFile(pidFile, `${child.pid}\n`);
  const until = async (check: () => Promise<boolean>) => { const deadline = Date.now() + 5000; do { if (await check()) return; await Bun.sleep(20); } while (Date.now() < deadline); throw Error("Proxy fixture did not settle"); };
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await until(async () => fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false));
    const metadata = { pid: child.pid, pidFile, script, supersedesProxyPid: 123, observed: "historical unchanged" };
    const proxy = await db.prisma.remoteTaskResource.create({ data: { id: "original-proxy", taskId: f.task.id, key: "proxy-development-r4", kind: "local-http", purpose: "development", externalId: `http://127.0.0.1:${port}`, state: "allocated", metadata } });
    const group = await db.prisma.remoteTaskResource.create({ data: { id: "original-compose", taskId: f.task.id, key: "compose-development-r2", kind: "docker-compose-project", purpose: "development", externalId: `drafted-${f.task.id}-development`, state: "ready", metadata: { composeFile: path.join(environment, "compose.yml") } } });
    const prepared = await prepareTaskFinalization(f.input, f.dependencies), active = await bindPreparedCleanup(f.input, async () => {}), frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
    const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
    const socket = path.join(directory, "proxy.sock"); server = Bun.serve({ unix: socket, fetch: app.fetch });
    const registry = taskRegistry(socket, f.task.id, 3000), effects: number[] = []; let pause = false, loseSignal = true;
    const provider = { inspect: inspectHostProcess, managers: async () => [], processes: async () => {
      const rows = await inspectHostProcess(child.pid) ? [{ pid: child.pid, ppid: process.pid, pgid: child.pid, uid: process.getuid!(), cwd: f.worktree }] : [];
      if (pause) { pause = false; await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } }); } return rows;
    }, terminate: async (value: any) => { effects.push(value.pid); await terminateHostProcess(value, inspectHostProcess); } };
    const proofDirectory = path.join(directory, "native-proof");
    expect((await reconcileLegacyNativeResources({ registry, key: proxy.key, provider, proofDirectory })).results[0]).toMatchObject({ reconciled: true });
    const link = legacyNativeLink((await registry.task()).resources.find((r: any) => r.id === proxy.id).metadata), proof = await readFile(link.file);
    const stop = () => manageResource({ registry, key: proxy.key, action: "stop", serviceStop: { provider, proofDirectory, afterSignal: async () => { if (loseSignal) { loseSignal = false; throw Error("lost signal response"); } } } });
    pause = true; await expect(stop()).rejects.toThrow(); expect(effects).toEqual([]); expect(await inspectHostProcess(child.pid)).not.toBeNull();
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    await expect(stop()).rejects.toThrow("lost signal response"); await child.exited;
    expect(await stop()).toMatchObject({ observed: "stopped-process-family" }); expect(effects).toEqual([child.pid]);
    const current = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: proxy.id } });
    expect(current.state).toBe("allocated"); expect(finalizationResourceIdentity(current)).toEqual(finalizationResourceIdentity(proxy));
    expect(legacyNativeLink(current.metadata)).toEqual(link); expect(await readFile(link.file)).toEqual(proof);
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: group.id } })).toEqual(group);
    expect(await readFile(saved, "utf8")).toBe("original PostGIS bytes");
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
    expect((await assertPreparedCleanup(f.input)).operation).toEqual(active.operation);
    expect((await registry.task()).cleanupOperation.preparedRevision).toBe(prepared.preparedRevision);
  } finally { const current = await inspectHostProcess(child.pid); if (current?.cwd === f.worktree) await terminateHostProcess(current, inspectHostProcess); await child.exited; await server?.stop(true); }
}, 30000);

async function neonScopeFixture() {
  const f = await fixture("original71");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRoot: f.root } });
  const values = [
    { id: "development-db", key: "spatial-neon-development", kind: "neon-branch-database", purpose: "development", externalId: "br-original/task_spatial", state: "ready", metadata: { runtimeDatabase: "task_spatial", cutoverReceipt: path.join(directory, "migration", "cutovers", `drafted-${f.task.id}-development`, "receipt.private.json") } },
    { id: "review-db", key: "spatial-neon-review", kind: "neon-branch-database", purpose: "review", externalId: "br-original/review_spatial", state: "ready", metadata: { database: "review_spatial", owner: "drafted_runtime", env: `${path.join(directory, "environments", `${f.task.id}-review`, "spatial.env")} (0600)`, release: "DROP DATABASE review_spatial after review services stop" } },
    { id: "review-service", key: "review-service", kind: "local-http", purpose: "review", externalId: "http://127.0.0.1:8080", state: "released", metadata: {} },
  ];
  for (const value of values) await db.prisma.remoteTaskResource.create({ data: { ...value, taskId: f.task.id } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies), active = await bindPreparedCleanup(f.input, async () => {});
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const renew = (keys = ["spatial-neon-review"]) => app.request(`/api/tasks/${f.task.id}/cleanup-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: f.input.requestKey, resourceKeys: keys }) });
  return { ...f, values, prepared, active, app, renew };
}

test("Neon compact scope preserves the original operation and witnesses only its disposable review database", async () => {
  const f = await neonScopeFixture(), frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const response = await f.renew(); expect(response.status).toBe(200);
  const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "review-db" } });
  expect(await response.json()).toMatchObject({ preparedRevision: f.prepared.preparedRevision, cleanup: { operationRevision: f.active.operationRevision }, resources: [{ id: resource.id, key: resource.key, identityDigest: finalizationResourceIdentity(resource).identityDigest }] });
  expect((await f.renew(["spatial-neon-development"])).status).toBe(409);
  expect((await f.renew(["spatial-neon-development", "spatial-neon-review"])).status).toBe(409);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
});

test.each(["database-claim", "branch-claim", "runtime-claim", "resource-drift", "consumer", "pause", "revoke"])("Neon compact scope rejects current %s without a new preparation", async change => {
  const f = await neonScopeFixture();
  if (change.endsWith("claim")) {
    await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", branchName: "codex/other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: "b".repeat(40) } });
    await db.prisma.remoteTaskResource.create({ data: { taskId: "other", key: "foreign", kind: change === "database-claim" ? "neon-branch-database" : change === "branch-claim" ? "neon-branch" : "task-runtime", purpose: "review", state: "ready",
      externalId: change === "database-claim" ? "br-original/review_spatial" : change === "branch-claim" ? "br-original" : "other-runtime", metadata: change === "runtime-claim" ? { providers: [{ provider: "neon", id: "br-original" }] } : {} } });
  } else if (change === "resource-drift") await db.prisma.remoteTaskResource.update({ where: { id: "review-db" }, data: { externalId: "br-other/review_spatial" } });
  else if (change === "consumer") await db.prisma.remoteTaskResource.update({ where: { id: "review-service" }, data: { state: "ready" } });
  else if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  else await f.revoke();
  expect((await f.renew()).status).toBe(409);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: CLEANUP_OPERATION } })).toBe(1);
});

test.skipIf(!process.env.DRAFTED_NEON_INTEGRATION_ROOT)("actual Neon provider and Unix control preserve original proofs across late ownership, pause and lost DELETE response", async () => {
  const f = await fixture("original71");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRoot: f.root } });
  const clientRoot = process.env.DRAFTED_NEON_INTEGRATION_ROOT!;
  const { neonDatabaseFixture } = await import(path.join(clientRoot, "test/support/neon-database.ts"));
  const { taskRegistry } = await import(path.join(clientRoot, "src/control.ts"));
  const { manageResource } = await import(path.join(clientRoot, "src/resources.ts"));
  const client = await neonDatabaseFixture();
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    for (const value of client.task.resources) await db.prisma.remoteTaskResource.create({ data: { ...value, taskId: f.task.id } });
    await prepareTaskFinalization(f.input, f.dependencies); await bindPreparedCleanup(f.input, async () => {});
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }), resources = await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id }, orderBy: { id: "asc" } });
    const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
      .route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
    const socket = path.join(directory, "neon.sock"); server = Bun.serve({ unix: socket, fetch: app.fetch });
    const registry = taskRegistry(socket, f.task.id, 5000);
    const run = () => manageResource({ registry, key: client.resource.key, action: "release", neon: { provider: client.provider, journalRoot: client.journalRoot } });
    await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", branchName: "codex/other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: "b".repeat(40) } });
    const originalObserve = client.provider.observe;
    let inject: "claim" | "pause" | undefined = "claim";
    client.provider.observe = async (...args: any[]) => {
      const result = await originalObserve(...args);
      if (inject === "claim") await db.prisma.remoteTaskResource.create({ data: { id: "late-shared", taskId: "other", key: "shared", kind: "neon-branch-database", purpose: "review", externalId: client.resource.externalId, state: "ready" } });
      else if (inject === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
      inject = undefined; return result;
    };
    await expect(run()).rejects.toThrow("shared"); expect(client.effects).toHaveLength(0);
    await db.prisma.remoteTaskResource.delete({ where: { id: "late-shared" } });
    inject = "pause"; await expect(run()).rejects.toThrow(); expect(client.effects).toHaveLength(0);
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    client.state.loseDelete = true; await expect(run()).rejects.toThrow("request failed"); expect(client.effects).toHaveLength(1);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: client.resource.id } })).state).toBe("ready");
    await run(); await run(); expect(client.effects).toHaveLength(1);
    const final = await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id }, orderBy: { id: "asc" } });
    for (const before of resources) {
      const now = final.find(value => value.id === before.id)!;
      expect(finalizationResourceIdentity(now)).toEqual(finalizationResourceIdentity(before));
      expect(now.state).toBe(before.id === client.resource.id ? "released" : before.state);
    }
    expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
    expect(client.state.siblings.map((value: { name: string }) => value.name)).toEqual(["task_spatial", "studio_spatial", "studio_spatial_test"]);
    expect(client.state.roles.map((value: { name: string }) => value.name)).toEqual(["drafted_runtime", "studio_spatial_owner"]);
  } finally { await server?.stop(true); await client.cleanup(); }
}, 30_000);

async function privateExportScopeFixture() {
  const f = await fixture(), environment = path.join(directory, "environments", f.task.id), pinned = path.join(directory, "original-tooling");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: pinned, toolingRoot: f.root } });
  const values = [
    { id: "private-export", key: "credentials-export-development", kind: "private-file", purpose: "development", externalId: path.join(environment, "provider.src.env"), metadata: {
      source: "pinned tooling credentials/development.enc.json (createdAt 2026-10-26T22:34:30Z), authenticated", fields: ["OPENAI_API_KEY"],
      derivedFiles: ["clerk.env", "provider.env", "web-provider.env", "terrain.src.env", "api.env", "web.env", "spatial.env", "test.env"],
    } },
    { id: "original-compose", key: "compose-development-r2", kind: "docker-compose-project", purpose: "development", externalId: `drafted-${f.task.id}-development`, metadata: { envDirectory: environment, composeFile: path.join(environment, "compose.yml") } },
  ];
  for (const value of values) await db.prisma.remoteTaskResource.create({ data: { ...value, state: "ready", taskId: f.task.id } });
  await prepareTaskFinalization(f.input, f.dependencies); const active = await bindPreparedCleanup(f.input, async () => {});
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const renew = () => app.request(`/api/tasks/${f.task.id}/cleanup-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: f.input.requestKey, resourceKeys: [values[0]!.key] }) });
  const { legacyPrivateExportScope } = await import("./private-export-scope.ts");
  const scope = legacyPrivateExportScope({ ...f.task, worktreePath: f.worktree, pinnedToolingRoot: pinned, resources: values.map(value => ({ ...value, state: "ready" })) }, values[0]!.key);
  return { ...f, active, values, app, renew, scope };
}

test("private export selected scope uses only original v1 identity and preserves raw preparation/operation", async () => {
  const f = await privateExportScopeFixture(), frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const response = await f.renew(); expect(response.status).toBe(200);
  const witness = await response.json(); expect(witness.resources).toEqual([{ id: f.values[0]!.id, key: f.values[0]!.key, identityDigest: finalizationResourceIdentity({ ...f.values[0]!, state: "ready" }).identityDigest }]);
  expect(witness.cleanup).toEqual({ operationRevision: f.active.operationRevision, operationDigest: retirementDigest(f.active.operation) });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } }); expect((await f.renew()).status).toBe(409);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
});

test.each(["source", "storage", "journal", "capture", "source-ancestor", "storage-worktree", "own-parent", "wrong-recipe", "missing-environment"])("private export scope refuses %s without any resource/proof mutation", async change => {
  const f = await privateExportScopeFixture(), frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  expect((await f.renew()).status).toBe(200);
  if (change === "wrong-recipe") await db.prisma.remoteTaskResource.update({ where: { id: f.values[0]!.id }, data: { metadata: { ...f.values[0]!.metadata, source: "arbitrary credentials" } } });
  else if (change === "missing-environment") await db.prisma.remoteTaskResource.update({ where: { id: f.values[1]!.id }, data: { externalId: "other-project" } });
  else if (change === "own-parent") await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "parent", kind: "directory", purpose: "development", state: "ready", externalId: path.dirname(f.scope.environment) } });
  else {
    await db.prisma.remoteTask.create({ data: { id: "foreign", requestKey: "foreign", branchName: "foreign", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: f.task.toolingRevision, ...(change === "storage-worktree" ? { worktreePath: path.join(f.scope.storage, "source") } : {}) } });
    if (change !== "storage-worktree") await db.prisma.remoteTaskResource.create({ data: { taskId: "foreign", key: "claim", kind: "private-file", purpose: "development", state: "ready",
      externalId: change === "source" ? f.scope.source : change === "storage" ? f.scope.storage : change === "journal" ? f.scope.plan : change === "capture" ? f.scope.quarantine.path : f.scope.environment } });
  }
  expect((await f.renew()).status).toBe(409); expect(await db.prisma.remoteTaskResource.count({ where: { taskId: f.task.id, state: "released" } })).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(frozen);
});

test.skipIf(!process.env.DRAFTED_PRIVATE_EXPORT_INTEGRATION_ROOT)("actual private export through Unix scoped authority refuses late claims then retains native inode across lost acknowledgment", async () => {
  const f = await fixture(), root = process.env.DRAFTED_PRIVATE_EXPORT_INTEGRATION_ROOT!;
  const { privateExportFixture } = await import(path.join(root, "test/fixtures/private-export.ts"));
  const localRoot = path.join(directory, "export-fixture"); await mkdir(localRoot, { mode: 0o700 });
  const p = await privateExportFixture({ root: localRoot, taskId: f.task.id, seedComposeJournal: false });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: p.task.pinnedToolingRoot, toolingRevision: p.task.toolingRevision, toolingRoot: f.root } });
  for (const resource of p.task.resources) await db.prisma.remoteTaskResource.create({ data: { ...resource, taskId: f.task.id } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies), active = await bindPreparedCleanup(f.input, async () => {});
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }), original = await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id }, orderBy: { id: "asc" } });
  const runtime = createFakeAgentRuntime([{ id: f.session.id, cwd: f.worktree, repositoryId: f.config.repository.id, machineId: f.config.machine, role: "primary", status: "idle" }]);
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient })).route("/api/tasks", taskRoutes).route("/api/sessions", sessionTaskRoutes);
  const socket = path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `private-export-${crypto.randomUUID().slice(0, 8)}.sock`), server = Bun.serve({ unix: socket, fetch: app.fetch });
  const stopPreparation = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime }, async () => {});
  try {
    const { finalizeTask } = await import(path.join(root, "src/finalize.ts"));
    const { taskRegistry } = await import(path.join(root, "src/control.ts")), { manageResource } = await import(path.join(root, "src/resources.ts"));
    const base = taskRegistry(socket, f.task.id, 3000); let loseWrite = true, writes = 0, captures = 0, lateClaimAfterTask = false;
    const registry = { ...base, task: async () => {
      const observed = await base.task();
      if (lateClaimAfterTask) { lateClaimAfterTask = false; await db.prisma.remoteTaskResource.create({ data: { id: "late-final-task", taskId: "foreign", key: "late-final-task", kind: "private-file", purpose: "development", state: "ready", externalId: p.scope.quarantine.path } }); }
      return observed;
    }, resource: async (value: unknown) => { await base.resource(value); writes++; if (loseWrite) { loseWrite = false; throw Error("Lost applied Released acknowledgment"); } } };
    const before = await lstat(p.file), bytes = await readFile(p.file), backup = await readFile(p.backupFile), key = await readFile(p.keyFile);
    await db.prisma.remoteTask.create({ data: { id: "foreign", requestKey: "foreign", branchName: "foreign", repositoryId: f.task.repositoryId, machineId: f.task.machineId, toolingRoot: f.root, toolingRevision: f.task.toolingRevision } });
    const run = (extra = {}) => manageResource({ registry, key: p.resource.key, action: "release", docker: p.docker, privateExport: { keyFile: p.keyFile, observation: p.input.observation, composeJournalRoot: p.input.composeJournalRoot,
      captureHooks: { afterCapture: () => { captures++; } }, ...extra } });
    await expect(run({ afterPlan: async () => { await db.prisma.remoteTaskResource.create({ data: { id: "late", taskId: "foreign", key: "claim", kind: "private-file", purpose: "development", state: "ready", externalId: p.scope.quarantine.path } }); } })).rejects.toThrow();
    expect((await lstat(p.file)).ino).toBe(before.ino); expect(captures).toBe(0); expect(writes).toBe(0);
    await db.prisma.remoteTaskResource.delete({ where: { id: "late" } });
    let insideCapture = false;
    p.state.onIdle = () => { if (insideCapture) { lateClaimAfterTask = true; p.state.onIdle = undefined; } };
    await expect(run({ captureHooks: { beforeCapture: () => { insideCapture = true; }, afterCapture: () => { captures++; } } })).rejects.toThrow();
    expect((await lstat(p.file)).ino).toBe(before.ino); expect(captures).toBe(0); expect(writes).toBe(0);
    expect(await db.prisma.remoteTaskResource.count({ where: { id: "late-final-task" } })).toBe(1);
    await db.prisma.remoteTaskResource.delete({ where: { id: "late-final-task" } });
    const finalize = () => finalizeTask({ registry, cleanup: true, manage: (input: any) => manageResource({ ...input, docker: p.docker, compose: { journalRoot: p.input.composeJournalRoot },
      privateExport: { keyFile: p.keyFile, observation: p.input.observation, composeJournalRoot: p.input.composeJournalRoot, captureHooks: { afterCapture: () => { captures++; } } } }), close: async () => { throw Error("Retained source must not close"); } });
    await expect(finalize()).rejects.toThrow("Cleanup preserved task resources"); expect(captures).toBe(1);
    const journal = await readFile(p.scope.plan), native = await readFile(p.scope.quarantine.journal); await run();
    await expect(finalize()).rejects.toThrow("Cleanup preserved task resources");
    expect(captures).toBe(1); expect(writes).toBe(1); expect((await lstat(p.scope.quarantine.path)).ino).toBe(before.ino); expect(await readFile(p.scope.quarantine.path)).toEqual(bytes);
    expect(await readFile(p.scope.plan)).toEqual(journal); expect(await readFile(p.scope.quarantine.journal)).toEqual(native); expect(await readFile(p.backupFile)).toEqual(backup); expect(await readFile(p.keyFile)).toEqual(key);
    expect(p.effects).toEqual([]);
    const after = await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id }, orderBy: { id: "asc" } });
    expect(after.map(value => finalizationResourceIdentity(value))).toEqual(original.map(value => finalizationResourceIdentity(value))); expect(after.filter(value => value.state === "released").map(value => value.id)).toEqual([p.resource.id]);
    expect((await assertPreparedCleanup(f.input)).operationRevision).toBe(active.operationRevision); expect((await assertPreparedCleanup(f.input)).binding.preparedRevision).toBe(prepared.preparedRevision);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
  } finally { await stopPreparation(); server.stop(true); }
}, 20_000);
