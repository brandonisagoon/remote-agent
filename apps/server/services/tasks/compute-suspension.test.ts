import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { applyTraffic, beginTraffic, type TrafficEnvelope, type TrafficState } from "../../../../lib/compute-telemetry.ts";
import { classifyCompute } from "./compute-decision.ts";
import { assertComputeEvidence, collectComputeEvidence, recordComputeObservation, type ComputeObservation } from "./compute-observation.ts";
import { considerComputeSuspension, considerIdleComputeSuspension } from "./compute-suspension.ts";
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

for (const [mode, consider] of [["exact-request", considerComputeSuspension], ["automatic", considerIdleComputeSuspension]] as const) {
test.each(["queued-work", "pause", "review", "operation", "stream", "gap", "source-revision", "runtime-executing", "runtime-queued"])(`new %s during ${mode} classification invalidates the exact snapshot`, async changed => {
  const f = await fixture(); let runtimeState: "executing" | "queued" | "unknown" = "unknown";
  const runtime = { ...f.input.runtime, observeSessionActivity: () => ({ state: runtimeState, observedAt: Date.now() }) };
  const result = await consider({ ...f.input, runtime }, { refresh: f.refresh, classify: async (evidence, settings) => {
    if (changed === "queued-work") await db.prisma.runtimeInstruction.create({ data: { id: "new-work", sessionId: "primary", text: "continue", state: "queued" } });
    if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    if (changed === "review") await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "review", kind: "task-runtime", purpose: "review", externalId: "other", state: "ready" } });
    if (changed === "operation") f.observation.operations.active = 1;
    if (changed === "stream") { await f.event({ kind: "start", requestId: "request", classification: "meaningful" }); await f.event({ kind: "stream", requestId: "request" }); }
    if (changed === "gap") await f.event({ kind: "gap", reason: "collector-failure" });
    if (changed === "runtime-executing" || changed === "runtime-queued") {
      runtimeState = changed === "runtime-executing" ? "executing" : "queued";
      expect((await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "primary" } })).status).toBe("idle");
      expect(await db.prisma.runtimeInstruction.count({ where: { state: "queued" } })).toBe(0);
    }
    if (changed === "source-revision") Object.assign(f.observation, { sourceRevision: "0".repeat(40) });
    return f.classify(evidence, settings);
  } });
  expect(result?.outcome).toBe("stale"); expect(result?.intent).toBeUndefined();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
});}

test("development source evidence changes independently of immutable launch provenance", async () => {
  const f = await fixture(), initial = await collectComputeEvidence(f.input), launch = f.environment.revision;
  Object.assign(f.observation, { sourceRevision: "0".repeat(40) }); await f.refresh();
  const next = await collectComputeEvidence(f.input);
  expect(next.evidence.task.revision).toBe("0".repeat(40)); expect(next.snapshotDigest).not.toBe(initial.snapshotDigest);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(launch);
  expect(f.traffic().route.revision).toBe(launch);
  await f.refresh(); expect((await collectComputeEvidence(f.input)).snapshotDigest).toBe(next.snapshotDigest);
  const decision = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  Object.assign(f.observation, { sourceRevision: "1".repeat(40) });
  await expect(renewDevelopmentAuthority({ ...f.context, ...decision.intent!, resourceKeys: [f.resource.key] })).rejects.toThrow("evidence changed");
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

async function partialStudio() {
  const f = await fixture("docker-compose-project");
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { configuration: { configurationFile: "/fixture/coverage.json", configurationSha256: f.observation.configurationDigest } } });
  Object.assign(f.observation, { application: { containerId: "1".repeat(64), image: `sha256:${"2".repeat(64)}`, createdAt: "2030-01-01T00:00:00Z", startedAt: "2030-01-01T00:01:00Z", stopped: false } });
  await f.refresh();
  const decision = await considerComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  expect(decision.outcome).toBe("suspension-recorded");
  Object.assign(f.observation.application!, { stopped: true }); f.observation.coverage = "incomplete";
  await f.setTraffic({ ...f.traffic(), coverage: "incomplete", reason: "stopped-legacy-studio", lastReceivedAt: Date.now() - 60_000 });
  const refresh = async () => { f.observation.observedAt = Date.now(); return recordComputeObservation({ ...f.input, observation: f.observation }); };
  await refresh();
  return { ...f, decision, context: { ...f.context, refreshCompute: refresh }, refresh };
}
test("an existing suspension can finish exact aggregate members after its app stops, without new idle authority", async () => {
  const f = await partialStudio();
  expect((await collectComputeEvidence(f.input)).eligible).toBe(false);
  const authority = await renewDevelopmentAuthority({ ...f.context, ...f.decision.intent!, resourceKeys: [f.resource.key] });
  await expect(completeDevelopmentIntent({ ...f.context, ...f.decision.intent!, resourcesEpoch: authority.resourcesEpoch, resources: authority.resources })).rejects.toThrow("physically stopped");
  f.observation.state = "stopped"; await f.refresh();
  const renewed = await renewDevelopmentAuthority({ ...f.context, ...f.decision.intent!, resourceKeys: [f.resource.key] });
  expect((await completeDevelopmentIntent({ ...f.context, ...f.decision.intent!, resourcesEpoch: renewed.resourcesEpoch, resources: renewed.resources })).state).toBe("complete");
});
test.each(["restart", "source", "gap", "operation", "pause", "resource"])("partial stop cannot normalize %s drift", async changed => {
  const f = await partialStudio();
  if (changed === "restart") f.observation.application!.startedAt = "2030-01-01T00:02:00Z";
  if (changed === "source") f.observation.sourceRevision = "9".repeat(40);
  if (changed === "gap") await f.setTraffic({ ...f.traffic(), reason: "sequence-gap" });
  if (changed === "operation") f.observation.operations.generation = "0".repeat(64);
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (changed === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { replaced: true } } });
  await expect(renewDevelopmentAuthority({ ...f.context, ...f.decision.intent!, resourceKeys: [f.resource.key] })).rejects.toThrow();
});


// Reuse the owned-compute fixture above; no extra service or live classifier.
test("automatic uncertainty has a finite persisted budget, fresh evidence, and no heartbeat paid loop", async () => {
  const { computeIdleAttemptStatus, IDLE_FIRST_BACKOFF_MS, IDLE_SECOND_BACKOFF_MS } = await import("./compute-idle-attempt.ts");
  const f = await fixture(); let now = Date.now(), calls = 0;
  const observedEvidence: Parameters<typeof classifyCompute>[0][] = [];
  const dependencies = { refresh: f.refresh, now: () => now, classify: async (evidence: Parameters<typeof classifyCompute>[0], options: Parameters<typeof classifyCompute>[1]) => {
    calls++; observedEvidence.push(evidence);
    return classifyCompute(evidence, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "insufficient-evidence", confidence: 0.67 }] }) });
  } };
  const first = (await considerIdleComputeSuspension(f.input, dependencies))!;
  const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: first.revision } });
  expect(first.outcome).toBe("advisory"); expect(calls).toBe(1);
  const snapshot = first.snapshotDigest;
  for (const elapsed of [0, 1_000, IDLE_FIRST_BACKOFF_MS - 1]) {
    now = JSON.parse((await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-idle-attempt" }, orderBy: { sequence: "desc" } })).value!).lastAttemptAt + elapsed;
    await f.refresh(); await considerIdleComputeSuspension(f.input, dependencies);
    expect(calls).toBe(1);
  }
  now++;
  f.input.runtime.history = async () => [{ role: "user", text: "The app remains saved for later; no work is running now." }];
  const second = (await considerIdleComputeSuspension({ ...f.input, requestKey: "a-different-key-cannot-reset-the-budget" }, dependencies))!;
  expect(calls).toBe(2); expect(second.snapshotDigest).toBe(snapshot);
  expect(second.evidence.conversation[0]?.text).toContain("no work");
  expect(observedEvidence[1]!.observedAt).toBeGreaterThanOrEqual(observedEvidence[0]!.observedAt);
  await db.prisma.$disconnect();
  now += IDLE_SECOND_BACKOFF_MS - 1;
  await considerIdleComputeSuspension(f.input, dependencies); expect(calls).toBe(2);
  now++;
  expect((await considerIdleComputeSuspension(f.input, dependencies))!.outcome).toBe("advisory"); expect(calls).toBe(3);
  now += 24 * 60 * 60_000;
  // Coverage/operation generations and heartbeats change snapshots, not useful work.
  f.observation.operations.generation = "9".repeat(64); await f.refresh();
  for (let tick = 0; tick < 3; tick++) await considerIdleComputeSuspension(f.input, dependencies);
  const status = await computeIdleAttemptStatus({ ...f.input, observed: await collectComputeEvidence(f.input), now });
  expect(status).toMatchObject({ status: "attention", attempts: 3, maxAttempts: 3, nextEligibleAt: null, originalDecisionRevision: first.revision });
  expect(calls).toBe(3);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-attempt" } })).toBe(7);
  expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: first.revision } })).toEqual(original);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
});

test("an existing real-format advisory is attempt one and its later consideration preserves all original bytes", async () => {
  const { IDLE_FIRST_BACKOFF_MS } = await import("./compute-idle-attempt.ts");
  const f = await fixture(), evidence = await collectComputeEvidence(f.input);
  const initial = await considerComputeSuspension({ ...f.input, requestKey: `idle:${evidence.snapshotDigest}` }, { refresh: f.refresh,
    classify: (value, options) => classifyCompute(value, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "insufficient-evidence", confidence: 0.67 }] }) }) });
  const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: initial.revision } });
  const now = Math.max(original.occurredAt.getTime(), initial.evidence.observedAt) + IDLE_FIRST_BACKOFF_MS;
  const reconsidered = (await considerIdleComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify, now: () => now }))!;
  expect(reconsidered.outcome).toBe("suspension-recorded"); expect(f.classifications()).toBe(1);
  expect(reconsidered.requestKey).toBe(`${initial.requestKey}:attempt:2`);
  expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: initial.revision } })).toEqual(original);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
});

test.each(["pause", "review", "queued-work", "operation", "stream", "gap", "cleanup", "owner-resume", "unowned-allocation"])("automatic %s cannot acquire a paid-attempt claim", async changed => {
  const f = await fixture();
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (changed === "review") await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "held-review", kind: "task-runtime", purpose: "review", externalId: "other", state: "ready" } });
  if (changed === "queued-work") await db.prisma.runtimeInstruction.create({ data: { id: "queued-owner-work", sessionId: "primary", text: "new useful work", state: "queued" } });
  if (changed === "operation") { f.observation.operations.active = 1; await f.refresh(); }
  if (changed === "stream") { await f.event({ kind: "start", requestId: "stream", classification: "meaningful" }); await f.event({ kind: "stream", requestId: "stream" }); }
  if (changed === "gap") await f.event({ kind: "gap", reason: "collector-failure" });
  if (changed === "unowned-allocation") await db.prisma.computeOffer.create({ data: { id: "orphan", environmentId: f.environment.id, machineId: "host", instructionId: "orphan-instruction", state: "running", claimedAt: new Date(), dispatchDeadline: new Date() } });
  if (changed === "cleanup") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: "finalization-cleanup-started", key: "finalize:task", value: "{}" } });
  if (changed === "owner-resume") await recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "pending-owner-resume" } });
  await considerIdleComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify }).catch(() => undefined);
  expect(f.classifications()).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-attempt" } })).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-decision" } })).toBe(0);
});

test("two actual database clients can commit only one idle dispatch claim", async () => {
  const { createPrismaClient, applyPragmas } = await import("../../prisma.ts");
  const f = await fixture();
  const database = (await db.prisma.$queryRawUnsafe<{ name: string; file: string }[]>("PRAGMA database_list")).find(row => row.name === "main")!;
  await applyPragmas(db.prisma);
  const second = createPrismaClient(`file:${database.file}`); await applyPragmas(second);
  let calls = 0, collectors = 0, releaseCollectors!: () => void;
  const collected = new Promise<void>(resolve => { releaseCollectors = resolve; });
  const collect: typeof collectComputeEvidence = async input => {
    const result = await collectComputeEvidence(input);
    if (++collectors === 2) releaseCollectors();
    await collected; return result;
  };
  const classify: typeof classifyCompute = async (evidence, options) => {
    calls++; await Bun.sleep(20);
    return classifyCompute(evidence, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "insufficient-evidence", confidence: 0.67 }] }) });
  };
  try {
    const results = await Promise.allSettled([considerIdleComputeSuspension(f.input, { refresh: f.refresh, collect, classify }),
      considerIdleComputeSuspension({ ...f.input, prisma: second, requestKey: "another-worker-key" }, { refresh: f.refresh, collect, classify })]);
    expect(results.some(result => result.status === "fulfilled" && result.value)).toBe(true);
    expect(calls).toBe(1);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-attempt" } })).toBe(2);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-decision" } })).toBe(1);
  } finally { await second.$disconnect(); }
});

test("restart consumes an expired unknown attempt and a late suspend result cannot stop or replace a newer attempt", async () => {
  const { IDLE_CLAIM_MS, IDLE_FIRST_BACKOFF_MS } = await import("./compute-idle-attempt.ts");
  const f = await fixture(); let now = Date.now(), entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = considerIdleComputeSuspension(f.input, { refresh: f.refresh, now: () => now, classify: async (evidence, options) => {
    entered(); await held; return f.classify(evidence, options);
  } });
  await started;
  try {
    await considerIdleComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify, now: () => now }); expect(f.classifications()).toBe(0);
    await db.prisma.$disconnect(); now += IDLE_CLAIM_MS;
    await considerIdleComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify, now: () => now }); expect(f.classifications()).toBe(0);
    now += IDLE_FIRST_BACKOFF_MS;
    const next = (await considerIdleComputeSuspension(f.input, { refresh: f.refresh, now: () => now,
      classify: (evidence, options) => classifyCompute(evidence, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "insufficient-evidence", confidence: 0.67 }] }) }) }))!;
    release(); const late = (await original)!;
    expect(late.outcome).toBe("stale"); expect(late.intent).toBeUndefined();
    const state = JSON.parse((await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-idle-attempt" }, orderBy: { sequence: "desc" } })).value!);
    expect(state).toMatchObject({ attempt: 2, phase: "completed", decisionRevision: next.revision });
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
  } finally { release(); await original; }
});

test.each(["pause", "review", "operation", "queued-work", "runtime-busy", "owner-resume"])("a late %s at the claim boundary still creates no paid reservation", async changed => {
  const f = await fixture(); let busy = false, inspected = false;
  const runtime = { ...f.input.runtime, observeSessionActivity: () => ({ state: busy ? "executing" as const : "unknown" as const, observedAt: Date.now() }) };
  await considerIdleComputeSuspension({ ...f.input, runtime }, { refresh: f.refresh, classify: f.classify, collect: async input => {
    const fresh = await collectComputeEvidence(input); inspected = true;
    if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    if (changed === "review") await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "late-review", kind: "task-runtime", purpose: "review", externalId: "held", state: "ready" } });
    if (changed === "operation") { f.observation.operations.active = 1; await f.refresh(); }
    if (changed === "queued-work") await db.prisma.runtimeInstruction.create({ data: { id: "late-work", sessionId: "primary", text: "useful work", state: "queued" } });
    if (changed === "runtime-busy") busy = true;
    if (changed === "owner-resume") await recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "late-owner-resume" } });
    return fresh;
  } }).catch(() => undefined);
  expect(inspected).toBe(true);
  expect(f.classifications()).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-attempt" } })).toBe(0);
});

test("new useful work resets an exhausted episode but never bypasses environment spacing", async () => {
  const { computeIdleAttemptStatus, IDLE_FIRST_BACKOFF_MS } = await import("./compute-idle-attempt.ts");
  const f = await fixture(); let now = Date.now(), calls = 0;
  const dependencies = { refresh: f.refresh, now: () => now, classify: async (evidence: Parameters<typeof classifyCompute>[0], options: Parameters<typeof classifyCompute>[1]) => {
    calls++; return classifyCompute(evidence, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "insufficient-evidence", confidence: 0.67 }] }) });
  } };
  await considerIdleComputeSuspension(f.input, dependencies);
  now += IDLE_FIRST_BACKOFF_MS; await considerIdleComputeSuspension(f.input, dependencies);
  now += 15 * 60_000; await considerIdleComputeSuspension(f.input, dependencies);
  expect(calls).toBe(3);
  // A completed owner instruction is useful work, even after the session settles.
  await db.prisma.runtimeInstruction.create({ data: { id: "completed-useful-work", sessionId: "primary", text: "new work completed", state: "completed" } });
  await considerIdleComputeSuspension(f.input, dependencies); expect(calls).toBe(3);
  now += IDLE_FIRST_BACKOFF_MS;
  await considerIdleComputeSuspension(f.input, dependencies); expect(calls).toBe(4);
  const status = await computeIdleAttemptStatus({ ...f.input, observed: await collectComputeEvidence(f.input), now });
  expect(status.attempts).toBe(1);
});

test.each(["missing-credential", "refused", "leave-running", "eligible-for-authorized-closure"])("automatic %s is visible without repeated paid attempts", async choice => {
  const { computeIdleAttemptStatus } = await import("./compute-idle-attempt.ts");
  const f = await fixture(); let now = Date.now(), calls = 0;
  const dependencies = { refresh: f.refresh, now: () => now, classify: async (evidence: Parameters<typeof classifyCompute>[0], options: Parameters<typeof classifyCompute>[1]) => {
    calls++;
    return classifyCompute(evidence, { ...options, apiKey: choice === "missing-credential" ? "" : options.apiKey,
      fetch: async () => Response.json({ answers: [choice === "refused" ? { type: "refusal", name: "compute_action" } : { type: "choice", name: "compute_action", choice, confidence: 0.92 }] }) });
  } };
  await considerIdleComputeSuspension(f.input, dependencies); now += 24 * 60 * 60_000;
  for (let tick = 0; tick < 3; tick++) await considerIdleComputeSuspension(f.input, dependencies);
  const status = await computeIdleAttemptStatus({ ...f.input, observed: await collectComputeEvidence(f.input), now });
  expect(status.status).toBe(["refused", "missing-credential"].includes(choice) ? "attention" : "advisory");
  expect(calls).toBe(1); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
});

test("the real worker reconsiders uncertainty then frees the stopped allocation for the normal next-task offer and claim", async () => {
  const { tickCompute } = await import("./compute-worker.ts");
  const { requestCompute, confirmComputeDelivery, claimCompute } = await import("./compute-admission.ts");
  const { IDLE_FIRST_BACKOFF_MS } = await import("./compute-idle-attempt.ts");
  const f = await fixture(); let now = Date.now(), calls = 0, stops = 0;
  const pOffer = await db.prisma.computeOffer.create({ data: { id: "incumbent-P", environmentId: f.environment.id, machineId: "host", instructionId: "completed-P-start", state: "running", dispatchDeadline: new Date(), claimedAt: new Date() } });
  await db.prisma.computeSlot.create({ data: { id: "host:0", machineId: "host", ordinal: 0, allocationId: pOffer.id } });
  await db.prisma.runtimeSession.create({ data: { id: "primary-Q", scopeKey: "Q", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/Q", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "Q", requestKey: "Q", repositoryId: "repo", machineId: "host", branchName: "codex/Q", worktreePath: "/fixture/Q", toolingRoot: "/fixture/tooling", toolingRevision: "c".repeat(40), primarySessionId: "primary-Q", phase: "working" } });
  const admission = { prisma: db.prisma, machineId: "host", policy: config.compute! };
  const q = await requestCompute({ ...admission, taskId: "Q", request: { key: "development", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  const dependencies = { refresh: f.refresh,
    consider: (input: Parameters<typeof considerIdleComputeSuspension>[0]) => considerIdleComputeSuspension(input, { refresh: f.refresh, now: () => now,
      classify: (evidence, options) => { calls++; return classifyCompute(evidence, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: calls === 1 ? "insufficient-evidence" : "suspend-compute", confidence: 0.92 }] }) }); } }),
    continue: async (input: { intentRevision: number; intentDigest: string }) => {
      expect(await db.prisma.computeOffer.count({ where: { environmentId: q.id } })).toBe(0);
      const reference = { intentRevision: input.intentRevision, intentDigest: input.intentDigest };
      await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
      stops++; f.observation.state = "stopped"; await f.refresh();
      await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "allocated" } });
      const authority = await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
      await completeDevelopmentIntent({ ...f.context, ...reference, resourcesEpoch: authority.resourcesEpoch, resources: authority.resources });
    },
  };
  await tickCompute({ ...f.input, runtime: f.input.runtime as never }, dependencies);
  expect(calls).toBe(1); expect(stops).toBe(0);
  expect(await db.prisma.computeOffer.count({ where: { environmentId: q.id } })).toBe(0);
  now += IDLE_FIRST_BACKOFF_MS;
  await tickCompute({ ...f.input, runtime: f.input.runtime as never }, dependencies);
  expect(calls).toBe(2); expect(stops).toBe(1);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: pOffer.id } })).state).toBe("stopped");
  const offered = await db.prisma.computeOffer.findFirstOrThrow({ where: { environmentId: q.id } });
  expect(offered.state).toBe("queued"); expect(offered.deliveredAt).toBeNull();
  await expect(claimCompute({ ...admission, taskId: "Q", offerId: offered.id, request: { key: q.key, purpose: "development", revision: q.revision, recipeDigest: q.recipeDigest } })).rejects.toThrow();
  await db.prisma.runtimeInstruction.update({ where: { id: offered.instructionId }, data: { state: "dispatching", executionRequestId: offered.instructionId } });
  await db.prisma.runtimeSession.update({ where: { id: "primary-Q" }, data: { status: "active" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "Q-started", runtimeSessionId: "primary-Q", requestId: offered.instructionId, phase: "started", occurredAt: new Date() } });
  await confirmComputeDelivery({ ...admission, sessionId: "primary-Q", requestId: offered.instructionId });
  expect(await claimCompute({ ...admission, taskId: "Q", offerId: offered.id, request: { key: q.key, purpose: "development", revision: q.revision, recipeDigest: q.recipeDigest } })).toMatchObject({ offer: { id: offered.id, state: "claimed" }, environment: { id: q.id, state: "starting" }, resumed: false });
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).toMatchObject({ ownerPaused: false, phase: "working", worktreePath: "/fixture/task", toolingRevision: "c".repeat(40) });
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).state).toBe("allocated");
});

test("the authenticated capacity diagnostic exposes exhaustion without history reads, model calls or row changes", async () => {
  const { createApp } = await import("../../app.ts");
  const { createFakeAgentRuntime } = await import("../../../../test-support/agent-runtime.ts");
  const f = await fixture(); let now = Date.now();
  const dependencies = { refresh: f.refresh, now: () => now, classify: (evidence: Parameters<typeof classifyCompute>[0], options: Parameters<typeof classifyCompute>[1]) =>
    classifyCompute(evidence, { ...options, fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "insufficient-evidence", confidence: 0.67 }] }) }) };
  for (const advance of [0, 5 * 60_000, 15 * 60_000]) { now += advance; await considerIdleComputeSuspension(f.input, dependencies); }
  const before = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const environment = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  const runtime = createFakeAgentRuntime(); runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  runtime.history = async () => { throw Error("Read-only diagnostics cannot collect conversation"); };
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime });
  expect((await app.request("/api/tasks/task/compute-policy?capacity=1")).status).toBe(401);
  const response = await app.request("/api/tasks/task/compute-policy?capacity=1", { headers: { authorization: `Bearer ${config.apiKey}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ idleConsiderations: [{ environmentId: f.environment.id, status: "attention", attempts: 3, maxAttempts: 3, nextEligibleAt: null }] });
  expect(await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).toEqual(before);
  expect(await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).toEqual(environment);
});
