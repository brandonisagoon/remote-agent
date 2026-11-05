import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { requestCompute, bindComputeResource, offerNextCompute, confirmComputeDelivery, claimCompute } from "./compute-admission.ts";
import type { readConfiguredComputeObservation } from "./compute-observer.ts";
import { beginTraffic } from "../../../../lib/compute-telemetry.ts";
import { configureCompute } from "./compute-configuration.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";

let db: TestDatabase;
const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
const revision = "a".repeat(40), oldHash = "b".repeat(64), nextHash = "c".repeat(64);
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
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

test("fresh stopped route evidence replaces old generation without accepting another environment's route", async () => {
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
