import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { applyTraffic, beginTraffic, type TrafficEnvelope, type TrafficState } from "../../../../lib/compute-telemetry.ts";
import { classifyCompute } from "./compute-decision.ts";
import { assertComputeEvidence, collectComputeEvidence, recordComputeObservation, type ComputeObservation } from "./compute-observation.ts";
import { considerComputeSuspension } from "./compute-suspension.ts";
import { assertComputeStartIntent, completeDevelopmentIntent, developmentProjection, recordDevelopmentIntent, renewDevelopmentAuthority, supersedeRuntimeSuspension } from "./development-intent.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";

let db: TestDatabase;
const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: true, slots: 1, quietPeriodSeconds: 30, decisionApiKey: "test-secret" }) });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

async function fixture(kind = "task-runtime") {
  const primary = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "task", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/task", status: "idle" } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: primary.cwd, toolingRoot: "/fixture/tooling", toolingRevision: "c".repeat(40), primarySessionId: primary.id, phase: "working" } });
  const resource = await db.prisma.remoteTaskResource.create({ data: { id: "runtime", taskId: task.id, key: "app", kind, purpose: "development", externalId: "/fixture/runtime.json", state: "ready", metadata: { container: "original-container", recipe: "saved" } } });
  const { requestCompute } = await import("./compute-admission.ts");
  const requested = await requestCompute({ prisma: db.prisma, machineId: "host", policy: config.compute!, taskId: task.id, request: { key: "development", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  const environment = await db.prisma.computeEnvironment.update({ where: { id: requested.id }, data: { state: "running", resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest } });
  // This fixture represents enrolled incumbent compute, not an outstanding
  // request to start it. Stopping must not manufacture a new start request.
  await db.prisma.computeWait.deleteMany({ where: { environmentId: environment.id } });
  const route = { id: "api", taskId: task.id, primarySessionId: primary.id, environmentId: environment.id, resourceId: resource.id, resourceIdentity: environment.resourceIdentity!, purpose: "development" as const, service: "api", revision: environment.revision, proxyId: "proxy", configurationDigest: "e".repeat(64) };
  let traffic = beginTraffic(route, "epoch-one", Date.now() - 60_000, true);
  const observation: ComputeObservation = { version: 1, environmentId: environment.id, taskId: task.id, primarySessionId: primary.id, purpose: "development", revision: environment.revision, recipeDigest: environment.recipeDigest, resourceId: resource.id, resourceIdentity: environment.resourceIdentity!, observedAt: Date.now(), state: "running", coverage: "complete", configurationDigest: route.configurationDigest, routes: [route], operations: { coverage: "complete", active: 0, generation: "f".repeat(64) } };
  const runtime = { history: async () => [{ role: "user" as const, text: "Leave my saved work available for later.\nDATABASE_URL=postgres://private" }], observeSessionActivity: undefined };
  const input = { prisma: db.prisma, config, runtime, environmentId: environment.id, requestKey: "quiet-one" };
  const context = { prisma: db.prisma, config, runtime, taskId: task.id };
  async function event(event: TrafficEnvelope["event"]) {
    const at = Date.now(); traffic = applyTraffic(traffic, { version: 1, routeId: route.id, epoch: traffic.epoch, sequence: traffic.sequence + 1, observedAt: at, event }, at);
    await db.prisma.computeTraffic.upsert({ where: { routeId: route.id }, create: { routeId: route.id, environmentId: environment.id, taskId: task.id, epoch: traffic.epoch, sequence: traffic.sequence, state: traffic }, update: { epoch: traffic.epoch, sequence: traffic.sequence, state: traffic } });
  }
  async function refresh() {
    observation.observedAt = Date.now(); await event({ kind: "heartbeat" });
    return recordComputeObservation({ ...input, observation });
  }
  await refresh();
  let classifications = 0;
  const classify: typeof classifyCompute = async (evidence, settings) => {
    classifications++;
    return classifyCompute(evidence, { ...settings, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "suspend-compute", confidence: 0.92 }] }) });
  };
  return { input, context: { ...context, refreshCompute: refresh }, resource, environment, route, observation, refresh, event, classify, classifications: () => classifications,
    traffic: () => structuredClone(traffic), setTraffic: async (value: TrafficState) => { traffic = value; await db.prisma.computeTraffic.update({ where: { routeId: route.id }, data: { state: traffic } }); } };
}

test("a measured idle decision records one selected stop without owner pause or closure; restart replay is inert", async () => {
  const f = await fixture();
  const result = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  expect(result.outcome).toBe("suspension-recorded"); expect(result.result?.confidence).toBe(0.92);
  expect(result.evidence.conversation[0]?.text).not.toContain("postgres://private");
  expect(result.intent).toBeDefined();
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).toMatchObject({ ownerPaused: false, phase: "working" });
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).state).toBe("ready");
  expect(await db.prisma.runtimeInstruction.count()).toBe(0); expect(await db.prisma.computeSlot.count()).toBe(0);
  await db.prisma.$disconnect();
  const replay = await considerComputeSuspension(f.input, { refresh: async () => { throw new Error("replay must not observe"); }, classify: f.classify });
  expect(replay).toEqual({ ...result, replayed: true }); expect(f.classifications()).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(1);
  const authority = await renewDevelopmentAuthority({ ...f.context, ...result.intent!, resourceKeys: [f.resource.key] });
  expect(authority.intent.reason).toBe("runtime-suspended"); expect(authority.resources.map(value => value.id)).toEqual([f.resource.id]);
});

test("explicit owner resume queues after automatic suspension and cannot authorize an effect before the real claim", async () => {
  const f = await fixture();
  await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  f.observation.state = "stopped"; await f.refresh();
  const { reconcileObservedCompute, requestCompute, offerNextCompute, confirmComputeDelivery, claimCompute } = await import("./compute-admission.ts");
  const admission = { prisma: db.prisma, machineId: "host", policy: config.compute! };
  await reconcileObservedCompute({ ...admission, environmentId: f.environment.id, runtime: {} });
  const resume = await recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "owner-return" } });
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
  await expect(renewDevelopmentAuthority({ ...f.context, ...resume, resourceKeys: [f.resource.key] })).rejects.toThrow("waiting for its exact compute claim");
  await requestCompute({ ...admission, taskId: "task", request: { key: f.environment.key, purpose: "development", revision: f.environment.revision, recipeDigest: f.environment.recipeDigest } });
  const offer = (await offerNextCompute(admission))!; expect(offer).toBeDefined();
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: `${offer.id}:started`, runtimeSessionId: "primary", requestId: offer.instructionId, phase: "started", occurredAt: new Date() } });
  await confirmComputeDelivery({ ...admission, sessionId: "primary", requestId: offer.instructionId });
  await claimCompute({ ...admission, taskId: "task", offerId: offer.id, request: { key: f.environment.key, purpose: "development", revision: f.environment.revision, recipeDigest: f.environment.recipeDigest } });
  const authority = await renewDevelopmentAuthority({ ...f.context, ...resume, resourceKeys: [f.resource.key] });
  expect(authority.resources.map(value => value.id)).toEqual([f.resource.id]);
  expect(authority.intent.reason).toBe("owner-resume");
});

test.each(["leave-running", "eligible-for-authorized-closure", "insufficient-evidence"])("%s stays advisory and cannot pause, close or enqueue", async choice => {
  const f = await fixture();
  const result = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: (evidence, settings) => classifyCompute(evidence, { ...settings, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice, confidence: 1 }] }) }) });
  expect(result.outcome).toBe("advisory"); expect(result.intent).toBeUndefined();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("working");
});

test.each(["queued-work", "pause", "review", "operation", "stream", "gap"])("new %s during classification invalidates the exact snapshot", async changed => {
  const f = await fixture();
  const result = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: async (evidence, settings) => {
    if (changed === "queued-work") await db.prisma.runtimeInstruction.create({ data: { id: "new-work", sessionId: "primary", text: "continue", state: "queued" } });
    if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    if (changed === "review") await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "review", kind: "task-runtime", purpose: "review", externalId: "other", state: "ready" } });
    if (changed === "operation") f.observation.operations.active = 1;
    if (changed === "stream") { await f.event({ kind: "start", requestId: "request", classification: "meaningful" }); await f.event({ kind: "stream", requestId: "request" }); }
    if (changed === "gap") await f.event({ kind: "gap", reason: "collector-failure" });
    return f.classify(evidence, settings);
  } });
  expect(result.outcome).toBe("stale"); expect(result.intent).toBeUndefined();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
});

test("existing incomplete coverage skips classification and retains a truthful decision receipt", async () => {
  const f = await fixture(); await f.event({ kind: "gap", reason: "restart" });
  const result = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  expect(result.outcome).toBe("not-eligible"); expect(result.result).toBeNull(); expect(f.classifications()).toBe(0);
});

test("an unavailable post-decision physical observation records stale and never uses its old snapshot", async () => {
  const f = await fixture(); let calls = 0;
  const result = await considerComputeSuspension(f.input, { classify: f.classify, refresh: async () => {
    if (++calls === 2) throw new Error("private provider detail"); return f.refresh();
  } });
  expect(result.outcome).toBe("stale"); expect(result.result?.choice).toBe("suspend-compute");
  expect(JSON.stringify(result)).not.toContain("private provider detail");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
});

test("a later independently quiet snapshot may replace invalidated automatic intent, never pending owner work", async () => {
  const f = await fixture(), first = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  await db.prisma.runtimeInstruction.create({ data: { id: "later-owner", sessionId: "primary", text: "finish the follow-up", state: "completed" } });
  await expect(renewDevelopmentAuthority({ ...f.context, ...first.intent!, resourceKeys: [f.resource.key] })).rejects.toThrow("evidence changed");
  const next = await considerComputeSuspension({ ...f.input, requestKey: "quiet-two" }, { refresh: f.refresh, classify: f.classify });
  expect(next.outcome).toBe("suspension-recorded"); expect(next.intent?.intentRevision).toBeGreaterThan(first.intent!.intentRevision);
  await expect(renewDevelopmentAuthority({ ...f.context, ...first.intent!, resourceKeys: [f.resource.key] })).rejects.toThrow("intent or original");
  const stop = await recordDevelopmentIntent({ ...f.context, request: { action: "pause", development: true, requestKey: "owner-pause" } });
  // Maintenance unpause never completes the owner's explicit pending work.
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  const protectedOwner = await considerComputeSuspension({ ...f.input, requestKey: "quiet-three" }, { refresh: f.refresh, classify: f.classify });
  expect(protectedOwner.outcome).toBe("stale");
  expect((await developmentProjection(f.context)).developmentIntent?.revision).toBe(stop.intentRevision);
});

test("a second environment cannot overwrite another valid pending stop, but invalidated evidence permits progress", async () => {
  const f = await fixture();
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "second-app", kind: "task-runtime", purpose: "development", externalId: "/fixture/second.json", state: "ready" } });
  const identity = finalizationResourceIdentity(resource).identityDigest;
  const env = await db.prisma.computeEnvironment.create({ data: { ...f.environment, id: "second-environment", key: "second", resourceId: resource.id, resourceIdentity: identity, observation: undefined, configuration: undefined } });
  const route = { ...f.route, id: "second-api", environmentId: env.id, resourceId: resource.id, resourceIdentity: identity };
  let traffic = beginTraffic(route, "second-epoch", Date.now() - 60_000, true);
  const observation = { ...f.observation, environmentId: env.id, resourceId: resource.id, resourceIdentity: identity, routes: [route] };
  const secondInput = { ...f.input, environmentId: env.id, requestKey: "second-quiet" };
  const refresh = async () => {
    const now = Date.now(); traffic = applyTraffic(traffic, { version: 1, routeId: route.id, epoch: traffic.epoch, sequence: traffic.sequence + 1, observedAt: now, event: { kind: "heartbeat" } }, now);
    await db.prisma.computeTraffic.upsert({ where: { routeId: route.id }, create: { routeId: route.id, environmentId: env.id, taskId: "task", epoch: traffic.epoch, sequence: traffic.sequence, state: traffic }, update: { sequence: traffic.sequence, state: traffic } });
    observation.observedAt = now; return recordComputeObservation({ ...secondInput, observation });
  };
  await refresh();
  const first = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  const second = await considerComputeSuspension(secondInput, { refresh, classify: f.classify });
  expect(first.outcome).toBe("suspension-recorded"); expect(second.outcome).toBe("stale");
  expect((await developmentProjection(f.context)).developmentIntent?.revision).toBe(first.intent!.intentRevision);
  await renewDevelopmentAuthority({ ...f.context, ...first.intent!, resourceKeys: [f.resource.key] });
  let inspectionFailures = 0;
  const failedRead = new Proxy(db.prisma, { get(target, property) {
    if (property !== "$transaction") return Reflect.get(target, property);
    return (callback: (tx: any) => Promise<unknown>) => target.$transaction(tx => callback(new Proxy(tx, { get(store, field) {
      if (field !== "computeEnvironment") return Reflect.get(store, field);
      return new Proxy(store.computeEnvironment, { get(delegate, method) {
        if (method !== "findUniqueOrThrow") return Reflect.get(delegate, method);
        return (args: { where: { id: string } }) => { if (args.where.id === f.environment.id) { inspectionFailures++; throw new Error("one-shot unavailable database read"); } return delegate.findUniqueOrThrow(args); };
      } });
    } })));
  } });
  const failed = await considerComputeSuspension({ ...secondInput, prisma: failedRead, requestKey: "second-read-failure" }, { refresh, classify: f.classify });
  expect(inspectionFailures).toBe(1); expect(failed.outcome).toBe("stale");
  expect((await developmentProjection(f.context)).developmentIntent?.revision).toBe(first.intent!.intentRevision);
  await f.event({ kind: "start", classification: "meaningful", requestId: "new-first-environment-use" });
  const recovered = await considerComputeSuspension({ ...secondInput, requestKey: "second-after-invalidation" }, { refresh, classify: f.classify });
  expect(recovered.outcome).toBe("suspension-recorded");
  expect((await developmentProjection(f.context)).developmentIntent?.suspension?.environmentId).toBe(env.id);
});

test("active cleanup authority refuses automatic suspension without rewriting the cleanup record", async () => {
  const f = await fixture();
  const operation = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: "finalization-cleanup-started", key: "finalize:task", value: JSON.stringify({ original: "opaque operation" }) } });
  await expect(considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify })).rejects.toThrow("cleanup authority remains active");
  expect(f.classifications()).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: operation.sequence } })).toEqual(operation);
});

test("heartbeat refreshes preserve the snapshot; actual activity, replacement and owner work do not", async () => {
  const f = await fixture(), original = await collectComputeEvidence(f.input);
  await f.refresh(); expect((await collectComputeEvidence(f.input)).snapshotDigest).toBe(original.snapshotDigest);
  await f.event({ kind: "start", requestId: "health", classification: "health" });
  await f.event({ kind: "end", requestId: "health", status: 200, durationMs: 1, cancelled: false });
  await f.event({ kind: "access", requestId: "health", status: 200, durationMs: 1 });
  expect((await collectComputeEvidence(f.input)).snapshotDigest).toBe(original.snapshotDigest);
  await f.event({ kind: "start", requestId: "unknown", classification: "unknown" });
  await expect(assertComputeEvidence({ ...f.input, snapshotDigest: original.snapshotDigest })).rejects.toThrow("incomplete");
  await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { externalId: "/fixture/replacement.json" } });
  await expect(collectComputeEvidence(f.input)).rejects.toThrow("resource identity changed");
});

test("completion requires exact physical stopped state and Ready-to-Allocated changes only", async () => {
  const f = await fixture(), decision = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  const reference = decision.intent!;
  const ready = await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
  await expect(completeDevelopmentIntent({ ...f.context, ...reference, resourcesEpoch: ready.resourcesEpoch, resources: ready.resources })).rejects.toThrow("physically stopped");
  await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "allocated" } }); f.observation.state = "stopped";
  const stopped = await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
  const complete = await completeDevelopmentIntent({ ...f.context, ...reference, resourcesEpoch: stopped.resourcesEpoch, resources: stopped.resources });
  expect(complete.state).toBe("complete"); expect((await developmentProjection(f.context)).developmentIntent?.state).toBe("complete");
  expect(await db.prisma.computeSlot.count()).toBe(0);
  await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "released" } });
  await expect(renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] })).rejects.toThrow();
});

test("selected renewal rejects other compute and new work before any stop callback", async () => {
  const f = await fixture();
  const other = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "other-app", kind: "docker-container", purpose: "development", externalId: "other", state: "ready" } });
  const result = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  await expect(renewDevelopmentAuthority({ ...f.context, ...result.intent!, resourceKeys: [other.key] })).rejects.toThrow("exact current");
  let effects = 0;
  const stop = async () => { await renewDevelopmentAuthority({ ...f.context, ...result.intent!, resourceKeys: [f.resource.key], refreshCompute: async () => { await f.refresh(); await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } }); return f.observation; } }); effects++; };
  await expect(stop()).rejects.toThrow(); expect(effects).toBe(0);
});

test("legacy Compose keeps exact suspension scope and participates in explicit owner compute stop", async () => {
  const f = await fixture("docker-compose-project");
  const result = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  const authority = await renewDevelopmentAuthority({ ...f.context, ...result.intent!, resourceKeys: [f.resource.key] });
  expect(authority.resources.map(value => value.id)).toEqual([f.resource.id]);
  const owner = await recordDevelopmentIntent({ ...f.context, request: { action: "pause", development: true, requestKey: "owner" } });
  expect((await renewDevelopmentAuthority({ ...f.context, ...owner, resourceKeys: [f.resource.key] })).resources.map(value => value.id)).toEqual([f.resource.id]);
});

test("a suspension can only be superseded by its exact allocated compute claim", async () => {
  const f = await fixture(), decision = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  await expect(supersedeRuntimeSuspension(db.prisma, "task", f.environment.id, "missing")).rejects.toThrow("allocated claim");
  await db.prisma.computeOffer.create({ data: { id: "offer", environmentId: f.environment.id, machineId: "host", instructionId: "offered-work", state: "claimed", dispatchDeadline: new Date(), claimedAt: new Date() } });
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { state: "starting" } });
  await expect(supersedeRuntimeSuspension(db.prisma, "task", f.environment.id, "offer")).rejects.toThrow("allocated claim");
  await db.prisma.computeSlot.create({ data: { id: "slot", machineId: "host", ordinal: 0, allocationId: "offer" } });
  await db.prisma.$transaction(tx => supersedeRuntimeSuspension(tx, "task", f.environment.id, "offer"));
  await db.prisma.$transaction(tx => supersedeRuntimeSuspension(tx, "task", f.environment.id, "offer"));
  await assertComputeStartIntent(db.prisma, "task", f.environment.id, "offer");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-superseded" } })).toBe(1);
  expect(await developmentProjection(f.context)).toEqual({});
  await expect(renewDevelopmentAuthority({ ...f.context, ...decision.intent!, resourceKeys: [f.resource.key] })).rejects.toThrow("superseded");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
  const review = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "review", kind: "task-runtime", purpose: "review", state: "ready", externalId: "/fixture/review.json", expiresAt: new Date(Date.now() + 60_000) } });
  await recordDevelopmentIntent({ ...f.context, request: { action: "stop-development", requestKey: "later-handoff", review: { key: review.key, identityDigest: finalizationResourceIdentity(review).identityDigest } } });
  await expect(assertComputeStartIntent(db.prisma, "task", f.environment.id, "offer")).rejects.toThrow("development stop");
  await recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "later-work" } });
  await assertComputeStartIntent(db.prisma, "task", f.environment.id, "offer");
  await db.prisma.computeSlot.update({ where: { id: "slot" }, data: { allocationId: "another-claim" } });
  await expect(assertComputeStartIntent(db.prisma, "task", f.environment.id, "offer")).rejects.toThrow("allocated claim");
});

test("the production collector tick reaches the same intent renewal and stopped completion without owner pause", async () => {
  const { tickCompute } = await import("./compute-worker.ts");
  const f = await fixture(); let stops = 0;
  const result = await tickCompute({ prisma: db.prisma, config, runtime: f.input.runtime as never }, {
    refresh: f.refresh,
    consider: input => considerComputeSuspension(input, { refresh: f.refresh, classify: f.classify }),
    continue: async input => {
      const reference = { intentRevision: input.intentRevision, intentDigest: input.intentDigest };
      await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
      stops++; f.observation.state = "stopped"; await f.refresh();
      await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "allocated" } });
      const authority = await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
      await completeDevelopmentIntent({ ...f.context, ...reference, resourcesEpoch: authority.resourcesEpoch, resources: authority.resources });
    },
  });
  expect(result).toEqual({ observed: 1, unavailable: 0 }); expect(stops).toBe(1);
  expect((await developmentProjection(f.context)).developmentIntent?.state).toBe("complete");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).state).toBe("allocated");
});
