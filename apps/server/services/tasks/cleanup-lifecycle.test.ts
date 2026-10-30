import { startRuntimeEventProjection } from "../sessions/runtime-events/projection.ts";
import { enqueueTaskCleanup } from "./cleanup-inbox.ts";
import { taskSupervisionRoutes } from "../../routes/tasks/supervision.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

async function legacyPreviewFixture(review = false, change?: (values: any[]) => void) {
  const f = await fixture();
  const purpose = review ? "review" : "development", hostname = `${purpose}.example.test`;
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

test.each(["pause", "revocation", "other-session"])("legacy preview discovery cannot bypass %s after freezing", async guard => {
  const f = await legacyPreviewFixture(), value = f.values.find(value => value.id === "tunnel");
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

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT).each([false, true])("actual legacy preview adapter uses the original operation through discovery/deletion retry (review=%s)", async review => {
  const f = await legacyPreviewFixture(review), root = process.env.DRAFTED_INTEGRATION_ROOT!;
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
      if (route === `/accounts/${f.account}/cfd_tunnel/${f.tunnelId}`) { if (method === "DELETE") { tunnel = false; return null; } return tunnel ? { id: f.tunnelId } : null; }
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
