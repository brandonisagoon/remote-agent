import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { claimCompute, confirmComputeDelivery, offerNextCompute, reconcileComputeOffers, requestCompute } from "./compute-admission.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { recordComputeObservation } from "./compute-observation.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { recordDevelopmentIntent } from "./development-intent.ts";

let db: TestDatabase;
const policy = ComputePolicy.parse({ enabled: true, slots: 1, collectorFreshnessSeconds: 10 });
const now = new Date("2030-01-01T00:00:00Z");
const context = () => ({ prisma: db.prisma, machineId: "host", policy, now });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function fixture(kind = "native-app") {
  const primary = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "task", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/task", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: primary.cwd, toolingRoot: "/fixture/tooling", toolingRevision: "c".repeat(40), primarySessionId: primary.id, phase: "working" } });
  const resource = await db.prisma.remoteTaskResource.create({ data: { id: "saved-app", taskId: "task", key: "saved-native", kind, purpose: "development", externalId: "/fixture/task-owned/app.json", state: "allocated", metadata: { original: "unchanged" } } });
  const saved = { resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest };
  const request = { key: resource.key, purpose: "development" as const, revision: "a".repeat(40), recipeDigest: finalizationDigest({ version: 1, adapter: "saved-compute", ...saved }), saved };
  return { resource, request };
}
test("a saved resume binds the original resource without rewriting or duplicating it", async () => {
  const f = await fixture();
  const environment = await requestCompute({ ...context(), taskId: "task", request: f.request });
  expect(environment.resourceId).toBe(f.resource.id);
  expect(environment.resourceIdentity).toBe(f.request.saved.resourceIdentity);
  expect(environment.configuration).toBeNull();
  expect((await requestCompute({ ...context(), taskId: "task", request: f.request })).id).toBe(environment.id);
  expect(await db.prisma.remoteTaskResource.count()).toBe(1);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
});
test("saved review receipts retain their separate lifecycle and cannot reserve a development resume", async () => {
  const f = await fixture();
  const resource = await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { purpose: "review" } });
  const saved = { resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest };
  await expect(requestCompute({ ...context(), taskId: "task", request: { ...f.request, purpose: "review", saved, recipeDigest: finalizationDigest({ version: 1, adapter: "saved-compute", ...saved }) } })).rejects.toThrow("identity changed");
  expect(await db.prisma.computeEnvironment.count()).toBe(0); expect(await db.prisma.computeOffer.count()).toBe(0);
});
async function registered() {
  const f = await fixture(), environment = await requestCompute({ ...context(), taskId: "task", request: f.request });
  const observation = { version: 1 as const, environmentId: environment.id, taskId: "task", primarySessionId: "primary", purpose: f.request.purpose,
    revision: f.request.revision, recipeDigest: f.request.recipeDigest, ...f.request.saved, observedAt: now.getTime(), state: "stopped" as const,
    configurationDigest: f.request.recipeDigest, coverage: "incomplete" as const, routes: [], operations: { coverage: "incomplete" as const, active: 0, generation: "d".repeat(64) } };
  const record = (value: unknown = observation) => recordComputeObservation({ prisma: db.prisma, config: testConfig({ machine: "host", compute: policy }), environmentId: environment.id, now, observation: value as typeof observation });
  return { ...f, environment, observation, record };
}
async function delivered(f: Awaited<ReturnType<typeof registered>>) {
  await f.record();
  const offer = (await offerNextCompute(context()))!;
  const message = await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
  expect(message.text).toContain(`resource resume --key ${f.request.key} --compute-offer ${offer.id}`);
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: "primary", requestId: offer.instructionId, phase: "started", occurredAt: now } });
  await confirmComputeDelivery({ ...context(), sessionId: "primary", requestId: offer.instructionId });
  return offer;
}
test("an unobserved saved resource consumes capacity; its stopped proof allows one claim", async () => {
  const f = await registered();
  expect(await offerNextCompute(context())).toBeNull();
  const offer = await delivered(f);
  const claim = () => claimCompute({ ...context(), taskId: "task", offerId: offer.id, request: f.request });
  expect((await claim()).resumed).toBe(false);
  await f.record({ ...f.observation, state: "running" });
  expect((await claim()).resumed).toBe(true);
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
  expect(await db.prisma.remoteTaskResource.count()).toBe(1);
});
test.each(["absent", "running", "stale", "missing"])("first saved claim refuses %s physical evidence", async changed => {
  const f = await registered(), offer = await delivered(f);
  if (changed === "missing") await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { observation: (await import("../../../../generated/prisma/client.ts")).Prisma.DbNull } });
  else await f.record({ ...f.observation, ...(changed === "stale" ? {} : { state: changed }) });
  await expect(claimCompute({ ...context(), now: new Date(now.getTime() + (changed === "stale" ? 10_001 : 1)), taskId: "task", offerId: offer.id, request: f.request })).rejects.toThrow("fresh stopped observation");
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("offered");
});
test("saved physical observation cannot become full activity coverage", async () => {
  const f = await registered();
  for (const observation of [{ ...f.observation, coverage: "complete" }, { ...f.observation, operations: { ...f.observation.operations, coverage: "complete" } }, { ...f.observation, configurationDigest: "e".repeat(64) }]) {
    await expect(f.record(observation)).rejects.toThrow("physical-only");
  }
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).observation).toBeNull();
});

test("actual physical HEAD can differ for reconciliation but never for first claim", async () => {
  const f = await registered(), offer = await delivered(f);
  await f.record({ ...f.observation, revision: "b".repeat(40) });
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(f.request.revision);
  await expect(claimCompute({ ...context(), taskId: "task", offerId: offer.id, request: f.request })).rejects.toThrow("physical-only observation");
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("offered");
});
test.each(["identity", "released", "pause"])("saved claim renewal refuses later %s without freeing its allocation", async changed => {
  const f = await registered(), offer = await delivered(f);
  const claim = () => claimCompute({ ...context(), taskId: "task", offerId: offer.id, request: f.request });
  await claim();
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  else await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: changed === "released" ? { state: "released" } : { metadata: { original: "changed" } } });
  await expect(claim()).rejects.toThrow();
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("claimed");
});
test("saved binding cannot be omitted, moved to another resource or rewritten", async () => {
  const f = await registered();
  const { saved: _saved, ...withoutSaved } = f.request;
  await expect(requestCompute({ ...context(), taskId: "task", request: withoutSaved })).rejects.toThrow("saved resource binding");
  await expect(requestCompute({ ...context(), taskId: "task", request: { ...f.request, saved: { ...f.request.saved, resourceId: "different" } } })).rejects.toThrow("identity changed");
  await expect(requestCompute({ ...context(), taskId: "task", request: { ...f.request, recipeDigest: "f".repeat(64) } })).rejects.toThrow("identity changed");
  expect(await db.prisma.computeEnvironment.count()).toBe(1);
});
test("a saved-resource inspection failure preserves an existing queued offer", async () => {
  const f = await registered(); await f.record(); const offer = (await offerNextCompute(context()))!;
  const original = db.prisma.$transaction.bind(db.prisma);
  db.prisma.$transaction = (async (callback: any) => original(async tx => callback(new Proxy(tx, { get(target, key) {
    if (key === "remoteTaskResource") return { ...target.remoteTaskResource, findUnique: async () => { throw new Error("fixture saved-resource read failure"); } };
    return Reflect.get(target, key);
  } })))) as typeof db.prisma.$transaction;
  try { await expect(reconcileComputeOffers(context())).rejects.toThrow("fixture saved-resource read failure"); }
  finally { db.prisma.$transaction = original as typeof db.prisma.$transaction; }
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("queued");
});
test.each(["docker-container", "docker-compose-project", "launch-agent"])("saved %s enrollment keeps its exact original resource", async kind => {
  const f = await fixture(kind), env = await requestCompute({ ...context(), taskId: "task", request: f.request });
  expect(env.resourceId).toBe(f.resource.id);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
});
test.each(["docker-volume", "directory", "task-runtime"])("%s cannot enter saved compute mode", async kind => {
  const f = await fixture(kind);
  await expect(requestCompute({ ...context(), taskId: "task", request: f.request })).rejects.toThrow("identity changed");
  expect(await db.prisma.computeEnvironment.count()).toBe(0);
});
test("saved resume cannot override an explicit stop left pending across maintenance", async () => {
  const f = await registered(), offer = await delivered(f);
  const claim = () => claimCompute({ ...context(), taskId: "task", offerId: offer.id, request: f.request });
  await claim();
  await recordDevelopmentIntent({ prisma: db.prisma, config: testConfig({ machine: "host", compute: policy }), taskId: "task", request: { action: "pause", development: true, requestKey: "owner-stop" } });
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false } });
  await expect(claim()).rejects.toThrow("superseded by a development stop");
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
});

async function nextRevision() {
  const f = await registered(); await f.record();
  const request = { ...f.request, revision: "b".repeat(40) };
  const config = testConfig({ machine: "host", compute: policy });
  const observation = { ...f.observation, revision: request.revision };
  const read: NonNullable<Parameters<typeof requestCompute>[1]> = async (_input, _task, candidate, _resource, traffic) => {
    expect(candidate.revision).toBe(request.revision); expect(candidate.observation).toBeNull(); expect(traffic).toEqual([]);
    return { observation, traffic: [] };
  };
  const transition = (reader = read) => requestCompute({ ...context(), config, taskId: "task", request }, reader);
  return { ...f, request, observation, read, transition, config };
}

test("stopped saved revision requeues fairly, preserves history and replays a lost transition reply", async () => {
  const f = await nextRevision(), oldOffer = (await offerNextCompute(context()))!;
  await db.prisma.runtimeInstruction.update({ where: { id: oldOffer.instructionId }, data: { state: "dispatching" } });
  const previousSequence = (await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: f.environment.id } })).sequence;
  const oldObservation = (await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).observation;
  const updated = await f.transition();
  expect(updated).toMatchObject({ id: f.environment.id, key: f.environment.key, revision: f.request.revision, state: "waiting" });
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: oldOffer.id } })).state).toBe("ineligible");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: oldOffer.instructionId } })).state).toBe("dispatching");
  await expect(claimCompute({ ...context(), taskId: "task", offerId: oldOffer.id, request: f.request })).rejects.toThrow("expired or superseded");
  expect((await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: updated.id } })).sequence).toBeGreaterThan(previousSequence);
  // The caller lost its reply after the transaction committed. Same request
  // replays without reading another physical generation or appending a fact.
  expect(await f.transition(async () => { throw new Error("must not reobserve committed transition"); })).toEqual(updated);
  const events = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "compute-saved-revision" } });
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.value!)).toMatchObject({ fromRevision: f.environment.revision, toRevision: f.request.revision, previousObservation: oldObservation, observation: f.observation, offers: [{ id: oldOffer.id, state: "queued" }] });
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
});

test.each(["claimed", "running", "unknown", "unexplained-slot"])("saved revision refuses %s without changing its allocation", async state => {
  const f = await nextRevision(), offer = (await offerNextCompute(context()))!;
  await db.prisma.computeOffer.update({ where: { id: offer.id }, data: { state: state === "unexplained-slot" ? "stopped" : state } });
  await db.prisma.computeSlot.upsert({ where: { id: "host:0" }, create: { id: "host:0", machineId: "host", ordinal: 0, allocationId: offer.id }, update: { allocationId: offer.id } });
  await expect(f.transition(async () => { throw new Error("must refuse before observation"); })).rejects.toThrow(state === "unexplained-slot" ? "unexplained slot" : "active or uncertain allocation");
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(f.environment.revision);
  expect((await db.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(offer.id);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-saved-revision" } })).toBe(0);
});

test.each(["running", "stale", "wrong-revision", "coverage"])("saved revision refuses %s candidate observation", async change => {
  const f = await nextRevision();
  await expect(f.transition(async () => ({ traffic: [], observation: { ...f.observation,
    ...(change === "running" ? { state: "running" as const } : change === "stale" ? { observedAt: now.getTime() - 10_001 } : change === "coverage" ? { coverage: "complete" as const } : { revision: f.environment.revision }) } }))).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(f.environment.revision);
});

test.each(["pause", "owner", "resource", "revision", "observation", "claim"])("saved revision CAS refuses late %s", async change => {
  const f = await nextRevision(), offer = (await offerNextCompute(context()))!;
  await expect(f.transition(async (...args) => {
    const output = await f.read(...args);
    if (change === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    if (change === "owner") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { branchName: "codex/replaced" } });
    if (change === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { original: "changed" } } });
    if (change === "revision") await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { revision: "c".repeat(40) } });
    if (change === "observation") await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { observation: { ...f.observation, observedAt: now.getTime() - 1 } } });
    if (change === "claim") await db.prisma.computeOffer.update({ where: { id: offer.id }, data: { state: "claimed", claimedAt: now } });
    return output;
  })).rejects.toThrow();
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe(change === "claim" ? "claimed" : "queued");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-saved-revision" } })).toBe(0);
});

test("two saved revision contenders cannot both advance the same prior generation", async () => {
  const f = await nextRevision(); let ready = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read: typeof f.read = async (...args) => { const output = await f.read(...args); if (++ready === 2) release(); await gate; return output; };
  const results = await Promise.allSettled([f.transition(read), f.transition(read)]);
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-saved-revision" } })).toBe(1);
});
