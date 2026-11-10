import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { requestCompute, bindComputeResource, offerNextCompute, confirmComputeDelivery, claimCompute } from "./compute-admission.ts";
import type { readConfiguredComputeObservation } from "./compute-observer.ts";
import { beginTraffic } from "../../../../lib/compute-telemetry.ts";
import { ComputeConfigurationFailure, configureCompute } from "./compute-configuration.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { admitToolingCallback, afterBoundCallback, beforeBoundCallback, beginSessionToolingOperation, resolveEnvironmentConsumers, runWithToolingOperation, settleToolingCommand } from "./tooling-operations.ts";
import { canonicalDigest } from "./tooling-releases.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import { computeRoutes } from "../../routes/tasks/compute.ts";
import { toolingOperationGuard } from "../../routes/tasks/tooling-operations.ts";

let db: TestDatabase;
const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
const revision = "a".repeat(40), oldHash = "b".repeat(64), nextHash = "c".repeat(64);
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

async function boundConfiguration(f: Awaited<ReturnType<typeof fixture>>, parented = false, legacyPid?: number) {
  const repository = { ...config.repository, id: "repo", tooling: { root: "/fixture/tooling", revision: "d".repeat(40) } };
  const guardedConfig = { ...config, repository, repositories: { repo: repository } };
  await db.prisma.toolingRelease.create({ data: { id: "configuration-release", repositoryId: "repo", revision: "d".repeat(40), tree: "e".repeat(40), policyBlob: "f".repeat(40), checkout: "/install/tooling/configuration",
    manifest: { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 1 }, stateFormats: { "drafted.runtime": { read: [1], write: 1, preservesUnknown: true } } }, lockfileDigest: "0".repeat(64), bunVersion: "1.3.0" } });
  await db.prisma.toolingLegacyBoundary.create({ data: { repositoryId: "repo", activationRequestKey: "first", legacyRevision: "d".repeat(40), recordedAt: new Date() } });
  await db.prisma.toolingSelection.create({ data: { repositoryId: "repo", generation: 1, releaseId: "configuration-release", activatedAt: new Date() } });
  const { lockPid: _pid, ...stable } = f.input.request;
  const parent = parented ? (await beginSessionToolingOperation({ prisma: db.prisma, config: guardedConfig, sessionId: "primary", request: {
    requestKey: "original-command", kind: "adapter-command", inputDigest: canonicalDigest({ action: "runtime-configure", change: "web-memory", settings: "original" }) } })).binding : undefined;
  const begin = async (requestKey: string, legacyPid?: number) => (await beginSessionToolingOperation({ prisma: db.prisma, config: guardedConfig, sessionId: "primary", request: {
    requestKey, kind: "compute-configure", existingOperationId: f.offer.id, parentOperationId: parent?.operationId,
    inputDigest: canonicalDigest(legacyPid ? { ...f.input.request, lockPid: legacyPid } : stable) } })).binding;
  const binding = await begin("configure", legacyPid);
  const prepare = async (lockPid = 123, target = binding) => {
    const body = { ...f.input.request, lockPid };
    const admission = await admitToolingCallback({ prisma: db.prisma, config: guardedConfig, method: "POST", pathname: "/api/tasks/task/compute-configure", header: target.operationId, body });
    if (!admission || admission.mode !== "bound") throw new Error("Expected bound configuration");
    const state = await beforeBoundCallback(db.prisma, guardedConfig, admission);
    const run = () => runWithToolingOperation(state.binding, () => configureCompute({ ...f.input, config: guardedConfig, request: body }, f.read, f.head, f.observe), guardedConfig.controlIpcPath,
      { route: admission.callback.route, attemptId: state.attemptId, body });
    const acknowledge = (status: number | "exception" = 200) => afterBoundCallback(db.prisma, admission, state, status);
    return { run, acknowledge, state };
  };
  const settle = () => {
    if (!parent) throw new Error("Expected original command");
    return settleToolingCommand({ prisma: db.prisma, config: guardedConfig, sessionId: "primary", operationId: parent.operationId, header: parent.operationId,
      body: { requestKey: parent.requestKey, inputDigest: parent.inputDigest, outcome: "completed" } });
  };
  return { prepare, binding, parent, begin, settle, config: guardedConfig };
}
async function fixture(projected = false) {
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "task", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/task", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: "/fixture/task", toolingRoot: "/fixture/tooling", toolingRevision: "d".repeat(40), primarySessionId: "primary", phase: "working" } });
  const context = { prisma: db.prisma, config, machineId: "host", policy: config.compute! };
  const environment = await requestCompute({ ...context, taskId: "task", request: { key: "runtime-development", purpose: "development", revision, recipeDigest: oldHash } });
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: environment.key, kind: "task-runtime", purpose: "development", externalId: "/private/runtime.json", state: "failed", metadata: { recipeHash: projected ? nextHash : oldHash, revision, containerId: "original-container", compute: { configurationSha256: "e".repeat(64) } } } });
  const offer = await db.prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: environment.id, machineId: "host", instructionId: "original-offer", dispatchDeadline: new Date(), state: "claimed", claimedAt: new Date() } });
  await db.prisma.computeSlot.create({ data: { id: "host:0", ordinal: 0, machineId: "host", allocationId: offer.id } });
  await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { state: "starting", resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest, observation: { old: "coverage must not survive" } } });
  await db.prisma.computeTraffic.create({ data: { routeId: "old-route", taskId: "task", environmentId: environment.id, epoch: "epoch", state: {} } });
  const compute = { configurationFile: "/private/staged-next.json", configurationSha256: "f".repeat(64) };
  const request = { offerId: offer.id, resourceKey: environment.key, previousRecipeHash: oldHash, recipeHash: nextHash, baselineFile: "/private/baseline.json", lockPid: 123,
    coverage: { previousFile: "/private/immutable-before.json", next: compute } };
  const input = { prisma: db.prisma, config, taskId: "task", request };
  const proof = { version: 1 as const, taskId: "task", primarySessionId: "primary", environmentId: environment.id, resourceId: resource.id, offerId: offer.id, revision, previousRecipeHash: oldHash, recipeHash: nextHash, receiptSha256: "1".repeat(64), baselineSha256: "2".repeat(64), lockSha256: "3".repeat(64), stopped: true as const, compute };
  const observe: typeof readConfiguredComputeObservation = async (_input, _task, env, target) => ({ observation: {
    version: 1, taskId: env.taskId, primarySessionId: env.primarySessionId, environmentId: env.id, purpose: "development", revision: env.revision, sourceRevision: env.revision,
    recipeDigest: env.recipeDigest, resourceId: target.id, resourceIdentity: finalizationResourceIdentity(target).identityDigest, observedAt: Date.now(), state: "stopped",
    coverage: "incomplete", configurationDigest: compute.configurationSha256, routes: [], operations: { coverage: "incomplete", active: 0, generation: "1".repeat(64) },
  }, traffic: [] });
  return { context, input, proof, environment, resource, offer, read: async () => proof, head: async () => revision, observe };
}
test.each([false, true])("atomic transition recovers partial projection=%s, preserves claim and replays lost acknowledgment", async projected => {
  const f = await fixture(projected), slot = await db.prisma.computeSlot.findMany(), offer = await db.prisma.computeOffer.findMany();
  const result = await configureCompute(f.input, f.read, f.head, f.observe);
  expect(result.recipeHash).toBe(nextHash);
  const env = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } });
  expect(env).toMatchObject({ id: f.environment.id, recipeDigest: nextHash, state: "starting", resourceId: resource.id });
  expect(env.observation).toMatchObject({ state: "stopped", recipeDigest: nextHash, configurationDigest: f.proof.compute.configurationSha256 });
  expect(env.resourceIdentity).toBe(finalizationResourceIdentity(resource).identityDigest);
  expect(resource.metadata).toEqual({ ...(f.resource.metadata as object), recipeHash: nextHash, compute: f.proof.compute });
  expect(await db.prisma.computeTraffic.count()).toBe(0);
  expect(await db.prisma.computeSlot.findMany()).toEqual(slot); expect(await db.prisma.computeOffer.findMany()).toEqual(offer);
  expect(await configureCompute(f.input, f.read, f.head, f.observe)).toEqual(result);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration" } })).toBe(1);
  await bindComputeResource({ ...f.context, taskId: "task", offerId: f.offer.id, resourceKey: f.resource.key });
});
test.each(["pause", "pin", "primary", "slot", "offer", "intent", "resource", "digest", "proof", "head", "evidence"])("refuses %s drift without changing either recipe or freeing capacity", async fault => {
  const f = await fixture(true); let calls = 0;
  const read = async () => {
    calls++;
    if (calls === 1) {
      if (fault === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
      if (fault === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
      if (fault === "primary") await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { role: "delegate" } });
      if (fault === "slot") await db.prisma.computeSlot.update({ where: { id: "host:0" }, data: { allocationId: null } });
      if (fault === "offer") await db.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { state: "stopped", completedAt: new Date() } });
      if (fault === "intent") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: "stop", value: JSON.stringify({ version: 1, action: "stop" }) } });
      if (fault === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { externalId: "/changed/runtime.json" } });
      if (fault === "digest") await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { recipeDigest: "f".repeat(64) } });
    }
    return { ...f.proof, ...(fault === "proof" ? { offerId: crypto.randomUUID() } : {}), ...(fault === "evidence" && calls === 2 ? { receiptSha256: "f".repeat(64) } : {}) };
  };
  await expect(configureCompute(f.input, read, async () => fault === "head" ? "e".repeat(40) : revision, f.observe)).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).not.toBe(nextHash);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration" } })).toBe(0);
  expect(await db.prisma.computeTraffic.count()).toBe(1);
});
test("no durable transition means matching new digest alone cannot authorize retry", async () => {
  const f = await fixture(true);
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { recipeDigest: nextHash } });
  await expect(configureCompute(f.input, f.read, f.head, f.observe)).rejects.toThrow("durable acknowledgment");
});

test("collector telemetry refresh does not invalidate unchanged configuration authority", async () => {
  const f = await fixture();
  let reads = 0;
  const read = async () => {
    if (++reads === 2) {
      await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { observation: { collector: "new completed observation" } } });
      await db.prisma.computeTraffic.update({ where: { routeId: "old-route" }, data: { sequence: 1, state: { collector: "refreshed" } } });
    }
    return f.proof;
  };
  expect(await configureCompute(f.input, read, f.head, f.observe)).toMatchObject({ recipeHash: nextHash });
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration" } })).toBe(1);
});

test.each(["progress", "container", "coverage"])("crash after resource publication before bind reconciles only journaled progress: %s", async changed => {
  const f = await fixture(); await configureCompute(f.input, f.read, f.head, f.observe);
  const saved = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } });
  const metadata = { ...(saved.metadata as Record<string, unknown>), ...(changed === "progress" ? { progress: { step: "configuration", state: "failed", updatedAt: new Date().toISOString() } }
    : changed === "container" ? { containerId: "replacement" } : { compute: { configurationSha256: "9".repeat(64) } }) };
  const published = await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "failed", metadata } });
  const identity = finalizationResourceIdentity(published).identityDigest;
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).resourceIdentity).not.toBe(identity);
  if (changed === "progress") {
    await configureCompute(f.input, f.read, f.head, f.observe);
    expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).resourceIdentity).toBe(identity);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration-projection" } })).toBe(1);
    await configureCompute(f.input, f.read, f.head, f.observe);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration-projection" } })).toBe(1);
  } else await expect(configureCompute(f.input, f.read, f.head, f.observe)).rejects.toThrow("physical or configuration identity");
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("claimed");
  expect((await db.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
});

test("verified stopped terminal offer is retained as history; configuration grants no allocation and normal admission queues afresh", async () => {
  const f = await fixture(true);
  await db.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { state: "stopped", completedAt: new Date() } });
  await db.prisma.computeSlot.update({ where: { id: "host:0" }, data: { allocationId: null } });
  await db.prisma.computeWait.deleteMany({ where: { environmentId: f.environment.id } });
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { state: "suspended" } });
  const history = await db.prisma.computeOffer.findMany(), slots = await db.prisma.computeSlot.findMany();
  await configureCompute(f.input, f.read, f.head, f.observe);
  await configureCompute(f.input, f.read, f.head, f.observe);
  expect(await db.prisma.computeOffer.findMany()).toEqual(history); expect(await db.prisma.computeSlot.findMany()).toEqual(slots);
  expect(await db.prisma.computeWait.count()).toBe(0);
  await requestCompute({ ...f.context, taskId: "task", request: { key: f.resource.key, purpose: "development", revision, recipeDigest: nextHash } });
  expect(await db.prisma.computeWait.count()).toBe(1); expect(await db.prisma.computeOffer.findMany()).toEqual(history);
  expect(await db.prisma.computeSlot.findMany()).toEqual(slots);
  // A stopped resource must not consume the only slot and block itself.
  // Exercise real selection/delivery/claim, not just queue insertion.
  const fresh = await offerNextCompute(f.context);
  expect(fresh).not.toBeNull(); expect(fresh!.id).not.toBe(f.offer.id);
  const now = new Date();
  await db.prisma.runtimeInstruction.update({ where: { id: fresh!.instructionId }, data: { state: "dispatching", executionRequestId: fresh!.instructionId } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: crypto.randomUUID(), runtimeSessionId: "primary", requestId: fresh!.instructionId, phase: "started", occurredAt: now } });
  await confirmComputeDelivery({ ...f.context, now, sessionId: "primary", requestId: fresh!.instructionId });
  const claimed = await claimCompute({ ...f.context, taskId: "task", offerId: fresh!.id, request: { key: f.resource.key, purpose: "development", revision, recipeDigest: nextHash } });
  expect(claimed.offer.id).toBe(fresh!.id); expect(claimed.resumed).toBe(false);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("stopped");
  expect((await db.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(fresh!.id);
});

test.each(["unexplained-slot", "another-offer", "not-suspended", "no-completion", "pause"])("terminal reconciliation refuses %s", async fault => {
  const f = await fixture(true);
  await db.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { state: "stopped", completedAt: fault === "no-completion" ? null : new Date() } });
  if (fault !== "unexplained-slot") await db.prisma.computeSlot.update({ where: { id: "host:0" }, data: { allocationId: null } });
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { state: fault === "not-suspended" ? "starting" : "suspended" } });
  if (fault === "another-offer") await db.prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: f.environment.id, machineId: "host", instructionId: "other-offer", dispatchDeadline: new Date(), state: "offered" } });
  if (fault === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  await expect(configureCompute(f.input, f.read, f.head, f.observe)).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
});

test.each(["running", "identity", "stale", "manifest"])("invalid independently observed stopped accounting %s rolls back the configuration", async fault => {
  const f = await fixture(true);
  const observe: typeof readConfiguredComputeObservation = async (...args) => {
    const output = await f.observe(...args);
    if (fault === "running") output.observation.state = "running";
    if (fault === "identity") output.observation.resourceIdentity = "9".repeat(64);
    if (fault === "stale") output.observation.observedAt -= 60_000;
    if (fault === "manifest") output.observation.configurationDigest = "9".repeat(64);
    return output;
  };
  await expect(configureCompute(f.input, f.read, f.head, observe)).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration" } })).toBe(0);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("claimed");
});

test("fresh stopped route evidence replaces the old generation with the new configuration", async () => {
  const f = await fixture(true);
  const observe: typeof readConfiguredComputeObservation = async (...args) => {
    const output = await f.observe(...args), observation = output.observation;
    const route = { id: "new-route", taskId: "task", primarySessionId: "primary", environmentId: f.environment.id, resourceId: f.resource.id,
      resourceIdentity: observation.resourceIdentity, purpose: "development" as const, service: "api", revision, proxyId: "original-proxy", configurationDigest: f.proof.compute.configurationSha256 };
    observation.coverage = "complete"; observation.routes = [route];
    return { observation, traffic: [beginTraffic(route, "epoch", Date.now(), false)] };
  };
  await configureCompute(f.input, f.read, f.head, observe);
  expect(await db.prisma.computeTraffic.findUnique({ where: { routeId: "old-route" } })).toBeNull();
  const current = await db.prisma.computeTraffic.findUniqueOrThrow({ where: { routeId: "new-route" } });
  expect(current.environmentId).toBe(f.environment.id);
  expect((current.state as any).route.configurationDigest).toBe(f.proof.compute.configurationSha256);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).observation).toMatchObject({ state: "stopped", coverage: "complete" });
});

test("staged route collision preserves the other environment and rolls back the recipe", async () => {
  const f = await fixture(true);
  const other = await db.prisma.computeEnvironment.create({ data: { ...f.environment, id: crypto.randomUUID(), key: "other", configuration: undefined, observation: undefined } });
  await db.prisma.computeTraffic.create({ data: { routeId: "foreign-route", taskId: "task", environmentId: other.id, epoch: "foreign", state: { preserved: true } } });
  const observe: typeof readConfiguredComputeObservation = async (...args) => {
    const output = await f.observe(...args), observation = output.observation;
    const route = { id: "foreign-route", taskId: "task", primarySessionId: "primary", environmentId: f.environment.id, resourceId: f.resource.id,
      resourceIdentity: observation.resourceIdentity, purpose: "development" as const, service: "api", revision, proxyId: "original-proxy", configurationDigest: f.proof.compute.configurationSha256 };
    observation.routes = [route];
    return { observation, traffic: [beginTraffic(route, "epoch", Date.now(), false)] };
  };
  await expect(configureCompute(f.input, f.read, f.head, observe)).rejects.toThrow("already owned");
  expect((await db.prisma.computeTraffic.findUniqueOrThrow({ where: { routeId: "foreign-route" } })).environmentId).toBe(other.id);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
});

test.each(["before-commit", "after-commit"])('configuration acknowledgment survives reader retirement %s without reactivation', async timing => {
  const f = await fixture(), operation = await boundConfiguration(f), attempt = await operation.prepare();
  const retire = () => resolveEnvironmentConsumers(db.prisma, f.environment.id, { kind: "stopped", reference: f.environment.id });
  if (timing === "before-commit") await retire();
  await attempt.run();
  if (timing === "after-commit") await retire();
  const reader = await db.prisma.toolingRetainedConsumer.findFirstOrThrow({ where: { operationId: operation.binding.operationId } });
  expect(reader).toMatchObject({ status: "resolved", evidence: { kind: "compute-configure", reference: f.offer.id }, resolution: { kind: "stopped", reference: f.environment.id } });
  expect(reader.confirmedAt).not.toBeNull();
  // Model a lost response: keep the original operation running, replay with
  // the new process lock, then run the actual callback settlement hook.
  const replay = await operation.prepare(456);
  await replay.run(); await replay.acknowledge();
  expect(await db.prisma.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: reader.id } })).toEqual(reader);
  expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: operation.binding.operationId } })).status).toBe("completed");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "configuration-reader-acknowledged" } })).toBe(1);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("claimed");
  expect(await db.prisma.computeSlot.count()).toBe(1);
});

test.each(["foreign-retirement", "superseded", "foreign-reader", "running-proof"])('configuration acknowledgment refuses %s and rolls back the transition', async fault => {
  const f = await fixture(), operation = await boundConfiguration(f), attempt = await operation.prepare();
  const reader = await db.prisma.toolingRetainedConsumer.findFirstOrThrow({ where: { operationId: operation.binding.operationId } });
  if (fault === "foreign-reader") await db.prisma.toolingRetainedConsumer.update({ where: { id: reader.id }, data: { generation: 9 } });
  else if (fault === "running-proof") {
    const original = f.observe; f.observe = async (...args) => { const observed = await original(...args); observed.observation.state = "running"; return observed; };
  } else await db.prisma.toolingRetainedConsumer.update({ where: { id: reader.id }, data: { status: "resolved", resolvedAt: new Date(), resolution: {
    kind: fault === "superseded" ? "superseded" : "stopped", reference: fault === "superseded" ? "other-reader" : "foreign-environment" } } });
  const before = await db.prisma.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: reader.id } });
  await expect(attempt.run()).rejects.toThrow();
  expect(await db.prisma.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: reader.id } })).toEqual(before);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: ["compute-runtime-configuration", "configuration-reader-acknowledged"] } } })).toBe(0);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
});

async function stoppedConfiguration() {
  const f = await fixture();
  await db.prisma.computeSlot.deleteMany();
  await db.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { state: "stopped", completedAt: new Date() } });
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { state: "suspended" } });
  return f;
}

test("a committed but unknown configure replay settles the original command without inventing an earlier callback success", async () => {
  const f = await stoppedConfiguration(), operation = await boundConfiguration(f, true), original = await operation.prepare();
  await original.run(); await original.acknowledge("exception");
  const outcomes = await db.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${operation.binding.operationId}` }, orderBy: { sequence: "asc" } });
  await resolveEnvironmentConsumers(db.prisma, f.environment.id, { kind: "stopped", reference: f.environment.id });
  const replay = await operation.prepare(456); await replay.run(); await replay.acknowledge();
  expect((await operation.settle()).outcome).toBe("completed");
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: outcomes.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(outcomes);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "configuration-command-recovery" } })).toBe(1);
  expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: operation.binding.operationId } })).completionEvidence).toMatchObject({ kind: "callback-acknowledged" });
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("stopped");
  expect(await db.prisma.computeSlot.count()).toBe(0);
  expect((await operation.settle()).outcome).toBe("completed");
});

test("three same-parent configure children recover legacy PID digests through a verified replacement, preserving every original request and error", async () => {
  const f = await stoppedConfiguration(), operation = await boundConfiguration(f, true, 123), first = await operation.prepare();
  await first.acknowledge("exception");
  await expect(operation.prepare(456)).rejects.toThrow("input differs from the bound operation");
  const secondBinding = await operation.begin("legacy-retry", 456), second = await operation.prepare(456, secondBinding);
  await second.acknowledge(409);
  const originals = await db.prisma.toolingOperation.findMany({ where: { parentOperationId: operation.parent!.operationId } });
  const history = await db.prisma.runtimeMetadataEvent.findMany({ where: { key: { in: originals.map(row => `outcome:${row.id}`) } }, orderBy: { sequence: "asc" } });
  const replacementBinding = await operation.begin("supported-replay"), replacement = await operation.prepare(789, replacementBinding);
  const unused = await operation.begin("begun-but-never-attempted");
  await replacement.run(); await replacement.acknowledge();
  expect((await operation.settle()).outcome).toBe("completed");
  expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: unused.operationId } })).completionEvidence).toMatchObject({ kind: "never-attempted" });
  for (const row of originals) {
    const current = await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: row.id } });
    expect(current).toMatchObject({ status: "completed", inputDigest: row.inputDigest, requestKey: row.requestKey, releaseId: row.releaseId, parentOperationId: row.parentOperationId,
      completionEvidence: { kind: "verified-configuration-transition", reference: `${replacementBinding.operationId}:${replacement.state.attemptId}` } });
  }
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: history.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(history);
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { operationId: { in: originals.map(row => row.id) }, status: "resolved" } })).toBe(2);
  expect(await db.prisma.computeSlot.count()).toBe(0);
});

test("a verified callback remains replayable after a lost response while the original claim is retained", async () => {
  const f = await fixture(), operation = await boundConfiguration(f, true), original = await operation.prepare();
  await original.run(); await original.acknowledge("exception");
  const replay = await operation.prepare(456); await replay.run(); await replay.acknowledge();
  expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: operation.binding.operationId } })).status).toBe("running");
  const retry = await operation.prepare(789); await retry.run(); await retry.acknowledge();
  expect((await operation.settle()).outcome).toBe("completed");
  expect((await db.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("claimed");
});

test.each(["new-unknown", "changed-audit"])("historical verified configuration cannot hide %s during command settlement", async fault => {
  const f = await stoppedConfiguration(), operation = await boundConfiguration(f, true), original = await operation.prepare();
  await original.run(); await original.acknowledge("exception");
  const replay = await operation.prepare(456); await replay.run(); await replay.acknowledge();
  if (fault === "new-unknown") {
    const later = await operation.prepare(789); await later.run(); await later.acknowledge("exception");
  } else {
    const audit = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "configuration-command-recovery" } });
    const value = JSON.parse(audit.value!); value.history[0].inputDigest = "f".repeat(64);
    await db.prisma.runtimeMetadataEvent.update({ where: { sequence: audit.sequence }, data: { value: JSON.stringify(value) } });
  }
  await expect(operation.settle()).rejects.toThrow("without a confirmed latest callback outcome");
  expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: operation.parent!.operationId } })).status).not.toBe("completed");
});

test.each(["in-flight", "pause", "running", "stale", "resource", "separate-write", "foreign-release", "parent-release", "missing-commit", "foreign-retirement", "new-offer"])('configure recovery keeps the original command open on %s', async fault => {
  const f = await stoppedConfiguration(), operation = await boundConfiguration(f, true, 123), first = await operation.prepare();
  if (fault !== "in-flight") await first.acknowledge("exception");
  const replacementBinding = await operation.begin("supported-replay"), replacement = await operation.prepare(456, replacementBinding);
  await replacement.run();
  if (fault === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (fault === "running" || fault === "stale") {
    const env = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
    await db.prisma.computeEnvironment.update({ where: { id: env.id }, data: { observation: { ...(env.observation as object), ...(fault === "running" ? { state: "running" } : { observedAt: Date.now() - 20_000 }) } } });
  }
  if (fault === "resource") {
    const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } });
    await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: { ...(resource.metadata as object), containerId: "replacement" } } });
  }
  if (fault === "foreign-release") await db.prisma.toolingOperation.update({ where: { id: operation.binding.operationId }, data: { generation: 9 } });
  if (fault === "parent-release") await db.prisma.toolingOperation.update({ where: { id: operation.parent!.operationId }, data: { generation: 9 } });
  if (fault === "missing-commit") await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: "configuration-attempt-committed" } });
  if (fault === "foreign-retirement") await db.prisma.toolingRetainedConsumer.updateMany({ where: { operationId: operation.binding.operationId }, data: { status: "resolved", resolvedAt: new Date(), resolution: { kind: "stopped", reference: "foreign-environment" } } });
  if (fault === "new-offer") await db.prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: f.environment.id, machineId: "host", instructionId: "new-offer", dispatchDeadline: new Date(), state: "queued" } });
  if (fault === "separate-write") await db.prisma.toolingStateWrite.create({ data: { operationId: operation.binding.operationId, repositoryId: "repo", releaseId: "configuration-release", preservesUnknown: true,
    taskId: "task", family: "drafted.runtime", scopeKey: "task", version: 1 } });
  await replacement.acknowledge();
  await expect(operation.settle()).rejects.toThrow();
  expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: operation.binding.operationId } })).status).toBe(fault === "in-flight" ? "running" : "unknown");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "configuration-command-recovery" } })).toBe(0);
  expect(await db.prisma.computeSlot.count()).toBe(0);
});

test("configuration diagnostics retain the guarded attempt and stage without observer output or secrets", async () => {
  const f = await fixture(), operation = await boundConfiguration(f), attempt = await operation.prepare();
  const secret = "private-observer-stderr-".repeat(10000);
  f.read = async () => { throw new Error(secret); };
  const failure = await attempt.run().catch(error => error);
  expect(failure).toBeInstanceOf(ComputeConfigurationFailure);
  expect(failure).toMatchObject({ code: "configuration-observation-failed", stage: "configuration-observation", attemptId: attempt.state.attemptId });
  const record = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-configuration-failure" } });
  expect(JSON.parse(record.value!)).toEqual({ version: 1, code: failure.code, stage: failure.stage, attemptId: attempt.state.attemptId, operationId: operation.binding.operationId });
  expect(record.value!.length).toBeLessThan(350);
  expect(record.value).not.toContain("private-observer-stderr");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration" } })).toBe(0);
});

test("the actual configure route reports a bounded source failure and its durable attempt instead of an opaque 409", async () => {
  const f = await fixture(), operation = await boundConfiguration(f);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", operation.config); await next(); });
  app.use("/api/*", toolingOperationGuard()); app.route("/api/tasks", computeRoutes);
  const response = await app.request("/api/tasks/task/compute-configure", { method: "POST", headers: { "content-type": "application/json", "x-remote-agent-operation": operation.binding.operationId }, body: JSON.stringify(f.input.request) });
  expect(response.status).toBe(409);
  const body = await response.json() as { code: string; stage: string; attemptId: string };
  expect(body).toMatchObject({ code: "configuration-source-failed", stage: "source", attemptId: expect.any(String) });
  expect(JSON.stringify(body)).not.toContain("/fixture/task");
  expect(JSON.stringify(body).length).toBeLessThan(350);
  const stored = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-configuration-failure", key: body.attemptId } });
  expect(JSON.parse(stored.value!)).toMatchObject({ code: body.code, stage: body.stage, attemptId: body.attemptId, operationId: operation.binding.operationId });
  const attempt = await db.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${operation.binding.operationId}` } });
  expect(attempt.map(row => JSON.parse(row.value!))).toEqual(expect.arrayContaining([expect.objectContaining({ attemptId: body.attemptId, state: "refused", status: 409 })]));
});
