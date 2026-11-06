import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import * as baseline from "./compute-baseline.ts";
import { ComputeCapacityBlocked, claimCompute, computeAdmissionCapacity, confirmComputeDelivery, offerNextCompute, reconcileComputeOffers, requestCompute, scheduleComputeOffers } from "./compute-admission.ts";
import { createInstructionTick } from "../sessions/inbox.ts";

/** DRA-34: assignments are reserved before dispatch, delivery is progress
 * only, and slow physical accounting can neither expire started work nor hold
 * up ordinary inbox delivery. Real isolated SQLite; no live resources. */
let db: TestDatabase;
const settings = ComputePolicy.parse({ enabled: true, slots: 1 });
const request = { key: "development", purpose: "development" as const, revision: "a".repeat(40), recipeDigest: "b".repeat(64) };
const began = new Date("2030-01-01T00:00:00Z");
const context = (ms = 0, policy = settings) => ({ prisma: db.prisma, machineId: "host", policy, now: new Date(began.getTime() + ms) });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

async function task(id: string, options: { ownerPaused?: boolean; phase?: string; now?: Date } = {}) {
  const session = await db.prisma.runtimeSession.create({ data: { id: `primary-${id}`, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: `/fixture/${id}`, status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id, requestKey: id, repositoryId: "repo", machineId: "host", branchName: `codex/${id}`, worktreePath: session.cwd, toolingRoot: "/fixture/tooling", toolingRevision: "c".repeat(40), primarySessionId: session.id, phase: "working" } });
  const environment = await requestCompute({ prisma: db.prisma, machineId: "host", policy: settings, now: options.now ?? began, taskId: id, request });
  if (options.ownerPaused || options.phase) await db.prisma.remoteTask.update({ where: { id }, data: { ...(options.ownerPaused ? { ownerPaused: true } : {}), ...(options.phase ? { phase: options.phase } : {}) } });
  return environment;
}
async function start(offerInstructionId: string, at: Date) {
  const instruction = await db.prisma.runtimeInstruction.update({ where: { id: offerInstructionId }, data: { state: "dispatching", executionRequestId: offerInstructionId } });
  await db.prisma.runtimeSession.update({ where: { id: instruction.sessionId }, data: { status: "active" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: `${offerInstructionId}:started`, runtimeSessionId: instruction.sessionId, requestId: offerInstructionId, phase: "started", occurredAt: at } });
  return instruction;
}
const slots = () => db.prisma.computeSlot.count({ where: { allocationId: { not: null } } });
const offerState = async (id: string) => (await db.prisma.computeOffer.findUniqueOrThrow({ where: { id } })).state;

// Deterministic form of the DRA-34 reproduction (root's real-clock run:
// 65,728 ms scan, offer expired, delivery and claim unset). A gated scan is
// held open while the injected clock passes every former deadline.
test("a slow physical baseline neither expires a started assignment nor delays its delivery", async () => {
  await task("one");
  const live = (ms: number) => ({ ...context(ms), config: { machine: "host" } as ServerConfig, runtime: {} });
  const refresh = spyOn(baseline, "refreshComputeBaselines").mockImplementation(async () => ({ observed: 0, unavailable: 0 }) as never);
  try {
    const offer = (await offerNextCompute(live(0)))!;
    expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1); // reserved before dispatch
    await start(offer.instructionId, began);
    let entered!: () => void, release!: () => void;
    const inScan = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    refresh.mockImplementation(async () => { entered(); await gate; return { observed: 0, unavailable: 0 } as never; });
    await task("two");
    const scan = scheduleComputeOffers(live(1));
    await inScan;
    // While the scan is held: delivery is recorded without waiting for it.
    const delivered = (await confirmComputeDelivery({ ...live(65_728), sessionId: "primary-one", requestId: offer.instructionId }))!;
    expect(delivered).toMatchObject({ state: "offered", deliveredAt: began, expiresAt: null });
    await reconcileComputeOffers(live(3_600_000)); // far beyond the old 30 s / 60 s windows
    expect(await offerState(offer.id)).toBe("offered");
    expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
    release(); await scan;
    refresh.mockImplementation(async () => ({ observed: 0, unavailable: 0 }) as never);
    expect((await claimCompute({ ...live(3_600_001), taskId: "one", offerId: offer.id, request })).offer.state).toBe("claimed");
    expect(await slots()).toBe(1);
  } finally { refresh.mockRestore(); }
});

test("an in-flight redemption is joined only by the same verified task and recipe", async () => {
  await task("one"); await task("two");
  const offer = (await offerNextCompute(context()))!; await start(offer.instructionId, began);
  let entered!: () => void, release!: () => void;
  const inValidation = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const first = claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request }, async () => { entered(); await gate; });
  await inValidation;
  const foreignTask = claimCompute({ ...context(2), taskId: "two", offerId: offer.id, request }, async () => undefined);
  const foreignRecipe = claimCompute({ ...context(2), taskId: "one", offerId: offer.id, request: { ...request, recipeDigest: "f".repeat(64) } }, async () => undefined);
  const same = claimCompute({ ...context(2), taskId: "one", offerId: offer.id, request }, async () => undefined);
  release();
  const [a, b, c, d] = await Promise.allSettled([first, foreignTask, foreignRecipe, same]);
  expect(a.status).toBe("fulfilled"); expect(d.status).toBe("fulfilled");
  expect(b.status).toBe("rejected"); expect(c.status).toBe("rejected");
  expect(await db.prisma.computeOffer.count({ where: { state: "claimed" } })).toBe(1);
  expect(await slots()).toBe(1);
});

test("slow accounting never blocks ordinary inbox controls or delivery, and scheduler ticks coalesce", async () => {
  const config = { ...testConfig({ machine: "host" }), compute: settings } as ServerConfig;
  let release!: () => void; const hung = new Promise<void>(resolve => { release = resolve; });
  let scheduled = 0;
  const tick = createInstructionTick(db.prisma, createFakeAgentRuntime(), config, { scheduleCompute: async () => { scheduled++; await hung; } });
  const startedAt = Date.now();
  await tick(); await tick();
  expect(Date.now() - startedAt).toBeLessThan(5_000); // delivery finished while compute is still pending
  expect(scheduled).toBe(2); // each tick asks; the real scheduler coalesces (below)
  release();
  await task("one");
  const refresh = spyOn(baseline, "refreshComputeBaselines").mockImplementation(async () => { await Bun.sleep(200); return { observed: 0, unavailable: 0 } as never; });
  try {
    const live = { ...context(), config: { machine: "host" } as ServerConfig, runtime: {} };
    const [first, second] = [scheduleComputeOffers(live), scheduleComputeOffers(live)];
    expect(second).toBe(first);
    await first;
    expect(refresh.mock.calls.length).toBe(1);
  } finally { refresh.mockRestore(); }
});

test("concurrent selection and duplicate claims create one assignment and one allocation", async () => {
  await task("one"); await task("two");
  const results = await Promise.all([offerNextCompute(context()), offerNextCompute(context()), offerNextCompute(context())]);
  const offers = results.filter(Boolean);
  expect(offers).toHaveLength(1);
  expect(await db.prisma.computeOffer.count()).toBe(1);
  expect(await slots()).toBe(1);
  const offer = offers[0]!;
  await start(offer.instructionId, began);
  const claims = await Promise.all([claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request }), claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request })]);
  expect(claims.map(claim => claim.offer.id)).toEqual([offer.id, offer.id]);
  expect(await db.prisma.computeOffer.count({ where: { state: "claimed" } })).toBe(1);
  expect(await slots()).toBe(1);
});

test("the managed cap holds under concurrency and blocked capacity names its exact evidence", async () => {
  const capped = ComputePolicy.parse({ enabled: true, slots: 3, maxManagedAllocations: 1 });
  await task("one"); await task("two"); await task("three");
  await Promise.all([offerNextCompute(context(0, capped)), offerNextCompute(context(0, capped))]);
  const first = (await db.prisma.computeOffer.findFirstOrThrow())!;
  await start(first.instructionId, began);
  await confirmComputeDelivery({ ...context(1, capped), sessionId: (await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: first.instructionId } })).sessionId, requestId: first.instructionId });
  expect(await offerNextCompute(context(2, capped))).toBeNull();
  expect(await slots()).toBe(1);
  await db.prisma.remoteTaskResource.create({ data: { id: "legacy-app", taskId: "three", key: "old-app", kind: "task-runtime", purpose: "development", externalId: "/fixture/old", state: "ready" } });
  const capacity = await db.prisma.$transaction(store => computeAdmissionCapacity(store, context(3, capped)));
  expect(capacity).toMatchObject({ occupied: 1, usable: 1, headroom: 0 });
  expect(capacity.blockers.allocations).toEqual([expect.objectContaining({ allocationId: first.id, state: "offered", environmentId: first.environmentId })]);
  expect(capacity.blockers.unaccounted).toEqual([{ group: "three:development", reason: "unrecorded-resource", ids: ["legacy-app"],
    detail: "resource old-app (task-runtime, ready)", action: expect.stringContaining("observe them stopped") }]);
});

test("lost claim acknowledgment and restart redeem the same reservation; an abandoned validation is reclaimed", async () => {
  await task("one");
  const offer = (await offerNextCompute(context()))!; await start(offer.instructionId, began);
  await expect(claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request }, async () => { throw new Error("observer interrupted"); })).rejects.toThrow("observer interrupted");
  expect(await offerState(offer.id)).toBe("validating");
  expect(await slots()).toBe(1);
  // Long after the validation deadline, the same reservation is redeemed.
  const claimed = await claimCompute({ ...context(400_000), taskId: "one", offerId: offer.id, request }, async () => undefined);
  expect(claimed.offer.state).toBe("claimed");
  expect(await db.prisma.computeOffer.count()).toBe(1);
  // A validation abandoned by a restart (not in flight) is reclaimed: it never authorized a start.
  await task("two");
  // Fixture: the first allocation was later physically settled and released.
  await db.prisma.computeOffer.update({ where: { id: offer.id }, data: { state: "stopped" } });
  await db.prisma.computeEnvironment.update({ where: { id: offer.environmentId }, data: { state: "suspended" } });
  await db.prisma.computeSlot.updateMany({ data: { allocationId: null } });
  const next = (await offerNextCompute(context(500_000)))!; await start(next.instructionId, new Date(began.getTime() + 500_000));
  await db.prisma.computeOffer.update({ where: { id: next.id }, data: { state: "validating", validationToken: "lost", validationExpiresAt: new Date(began.getTime() + 500_001) } });
  await reconcileComputeOffers(context(800_000));
  expect(await offerState(next.id)).toBe("expired");
  expect(await slots()).toBe(0);
});

test("stale task identity or revision cannot redeem a reservation", async () => {
  await task("one");
  const offer = (await offerNextCompute(context()))!; await start(offer.instructionId, began);
  await expect(claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request: { ...request, revision: "e".repeat(40) } })).rejects.toThrow("exact environment");
  await db.prisma.remoteTask.update({ where: { id: "one" }, data: { toolingRevision: "d".repeat(40) } });
  await expect(claimCompute({ ...context(2), taskId: "one", offerId: offer.id, request })).rejects.toThrow("ownership changed");
  await reconcileComputeOffers(context(3));
  expect(await offerState(offer.id)).toBe("ineligible");
  expect(await slots()).toBe(0);
});

test("pause and source revocation release unclaimed reservations but keep resumable waits", async () => {
  await task("one");
  const offer = (await offerNextCompute(context()))!;
  await db.prisma.remoteTask.update({ where: { id: "one" }, data: { ownerPaused: true } });
  await reconcileComputeOffers(context(1));
  expect(await offerState(offer.id)).toBe("ineligible");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: offer.instructionId } })).state).toBe("cancelled");
  expect(await db.prisma.computeWait.count()).toBe(1);
  expect(await slots()).toBe(0);
  expect(await offerNextCompute(context(2))).toBeNull(); // paused: skipped, not discarded
  await db.prisma.remoteTask.update({ where: { id: "one" }, data: { ownerPaused: false } });
  const resumed = (await offerNextCompute(context(3)))!;
  expect(resumed.environmentId).toBe(offer.environmentId);
  // A revoked source link withdraws the same way.
  await db.prisma.remoteTask.update({ where: { id: "one" }, data: { connectionId: "connection", issueIdentifier: "DRA-1" } });
  await reconcileComputeOffers(context(4));
  expect(await offerState(resumed.id)).toBe("ineligible");
  expect(await slots()).toBe(0);
});

test("a delayed dispatch that already started is never withdrawn by the dispatch deadline", async () => {
  await task("one");
  const offer = (await offerNextCompute(context()))!;
  // The inbox claimed the message just before the deadline; no start record yet.
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
  await reconcileComputeOffers(context(3_600_000));
  expect(await offerState(offer.id)).toBe("queued");
  expect(await slots()).toBe(1);
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "late-start", runtimeSessionId: "primary-one", requestId: offer.instructionId, phase: "started", occurredAt: new Date(began.getTime() + 3_600_000) } });
  await reconcileComputeOffers(context(3_600_001));
  expect(await offerState(offer.id)).toBe("offered");
});

test("never-started work is reclaimed with proof; uncertain or still-running work is kept", async () => {
  await task("one");
  const offer = (await offerNextCompute(context()))!; await start(offer.instructionId, began);
  await confirmComputeDelivery({ ...context(1), sessionId: "primary-one", requestId: offer.instructionId });
  // Uncertain turn outcome: kept indefinitely.
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "unknown" } });
  await reconcileComputeOffers(context(86_400_000));
  expect(await offerState(offer.id)).toBe("offered");
  // Turn ended but the primary is still active: not yet quiescent.
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "completed" } });
  await reconcileComputeOffers(context(86_400_001));
  expect(await offerState(offer.id)).toBe("offered");
  await db.prisma.runtimeSession.update({ where: { id: "primary-one" }, data: { status: "idle" } });
  await reconcileComputeOffers(context(86_400_002));
  expect(await offerState(offer.id)).toBe("expired");
  expect(await slots()).toBe(0);
  // A never-started assignment whose message was cancelled is reclaimed at once.
  const second = (await offerNextCompute(context(86_400_003)))!;
  await db.prisma.runtimeInstruction.update({ where: { id: second.instructionId }, data: { state: "cancelled" } });
  await reconcileComputeOffers(context(86_400_004));
  expect(await offerState(second.id)).toBe("expired");
  expect(await slots()).toBe(0);
});

test("closed waiters are retired with a receipt before any physical scan; paused waiters are kept", async () => {
  await task("closed", { phase: "closed" });
  await task("paused", { ownerPaused: true });
  const refresh = spyOn(baseline, "refreshComputeBaselines").mockImplementation(async () => ({ observed: 0, unavailable: 0 }) as never);
  try {
    expect(await offerNextCompute({ ...context(), config: { machine: "host" } as ServerConfig, runtime: {} })).toBeNull();
    expect(refresh.mock.calls.length).toBe(0);
  } finally { refresh.mockRestore(); }
  const closed = await db.prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: "closed" } });
  expect(await db.prisma.computeWait.count({ where: { environmentId: closed.id } })).toBe(0);
  const receipt = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-wait-retired", key: { startsWith: closed.id } } });
  expect(JSON.parse(receipt.value!)).toMatchObject({ environmentId: closed.id, taskId: "closed", primarySessionId: "primary-closed", reason: "task-closed",
    wait: { sequence: expect.any(Number) }, evidence: { taskPhase: "closed", primaryStatus: "idle" } });
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-wait-retired" } })).toBe(1); // exactly the terminal wait
  const paused = await db.prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: "paused" } });
  expect(await db.prisma.computeWait.count({ where: { environmentId: paused.id } })).toBe(1);
});

test("a claim refused by accounting reports the exact blocking groups, distinct from an expired offer, and keeps its reservation", async () => {
  await task("one");
  const offer = (await offerNextCompute(context()))!; await start(offer.instructionId, began);
  // A historical group appears after selection (cf. DRA-17's 19 unaccounted groups).
  await db.prisma.remoteTaskResource.create({ data: { id: "historical", taskId: "one", key: "old-app", kind: "docker-container", purpose: "review", externalId: "old-container", state: "ready" } });
  const refused = await claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request }, async () => undefined).catch(error => error);
  expect(refused).toBeInstanceOf(ComputeCapacityBlocked);
  expect(refused.message).toContain("capacity accounting blocks this claim");
  expect(refused.blockers.unaccounted).toEqual([expect.objectContaining({ group: "one:review", reason: "unrecorded-resource", ids: ["historical"] })]);
  expect(refused.blockers.allocations).toEqual([expect.objectContaining({ allocationId: offer.id })]);
  expect(await offerState(offer.id)).toBe("validating");
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
});
