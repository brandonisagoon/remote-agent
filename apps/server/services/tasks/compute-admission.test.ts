import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { claimCompute, confirmComputeDelivery, declineCompute, offerNextCompute, reconcileComputeOffers, requestCompute } from "./compute-admission.ts";

let db: TestDatabase;
const settings = ComputePolicy.parse({ enabled: true, slots: 1 });
const request = { key: "development", purpose: "development" as const, revision: "a".repeat(40), recipeDigest: "b".repeat(64) };
const began = new Date("2030-01-01T00:00:00Z");
const context = (ms = 0) => ({ prisma: db.prisma, machineId: "host", policy: settings, now: new Date(began.getTime() + ms) });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function task(id: string) {
  const session = await db.prisma.runtimeSession.create({ data: { id: `primary-${id}`, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: `/fixture/${id}`, status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id, requestKey: id, repositoryId: "repo", machineId: "host", branchName: `codex/${id}`, worktreePath: session.cwd, toolingRoot: "/fixture/tooling", toolingRevision: "c".repeat(40), primarySessionId: session.id, phase: "working" } });
  return requestCompute({ ...context(), taskId: id, request });
}
async function started(offer: NonNullable<Awaited<ReturnType<typeof offerNextCompute>>>, ms = 0) {
  const instruction = await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
  await db.prisma.runtimeSession.update({ where: { id: instruction.sessionId }, data: { status: "active" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: `${offer.instructionId}:started`, runtimeSessionId: instruction.sessionId, requestId: offer.instructionId, phase: "started", occurredAt: context(ms).now } });
  return confirmComputeDelivery({ ...context(ms), sessionId: instruction.sessionId, requestId: offer.instructionId });
}
async function finishTurn(offer: NonNullable<Awaited<ReturnType<typeof offerNextCompute>>>) {
  const instruction = await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "completed" } });
  await db.prisma.runtimeSession.update({ where: { id: instruction.sessionId }, data: { status: "idle" } });
}
test("queueing and dispatching do not reserve; confirmed executing delivery starts exactly sixty seconds", async () => {
  await task("one");
  const offer = (await offerNextCompute(context()))!;
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
  expect(await confirmComputeDelivery({ ...context(10_000), sessionId: "primary-one", requestId: offer.instructionId })).toBeNull();
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  const delivered = (await started(offer, 20_000))!;
  expect(delivered.deliveredAt).toEqual(context(20_000).now);
  expect(delivered.expiresAt).toEqual(context(80_000).now);
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
});
test("expiry advances fairly to the next existing primary and rejects the old offer", async () => {
  await task("one"); await task("two");
  const first = (await offerNextCompute(context()))!; await started(first); await finishTurn(first);
  expect(await offerNextCompute(context(59_999))).toBeNull();
  const next = (await offerNextCompute(context(60_000)))!;
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: next.instructionId } })).sessionId).toBe("primary-two");
  await expect(claimCompute({ ...context(60_000), taskId: "one", offerId: first.id, request })).rejects.toThrow("expired or superseded");
  expect(await db.prisma.runtimeSession.count()).toBe(2);
  expect(await db.prisma.computeWait.count()).toBe(2);
});
test("a conversational reply is not a claim; duplicate command claims reuse one allocation", async () => {
  const env = await task("one"); const offer = (await offerNextCompute(context()))!;
  await started(offer); await finishTurn(offer);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).claimedAt).toBeNull();
  const first = await claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request });
  const again = await claimCompute({ ...context(2), taskId: "one", offerId: offer.id, request });
  expect(first.environment.id).toBe(env.id); expect(first.resumed).toBe(false); expect(again.resumed).toBe(true);
  expect(again.offer.claimedAt).toEqual(context(1).now);
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
  expect(await db.prisma.computeWait.count()).toBe(0);
});
test("a claimed partial startup survives offer expiry and startup timeout without reallocating", async () => {
  await task("one"); await task("two"); const offer = (await offerNextCompute(context()))!; await started(offer);
  await claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request });
  await reconcileComputeOffers(context(700_000));
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("unknown");
  expect(await offerNextCompute(context(700_001))).toBeNull();
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
});
test("owner pause releases unclaimed offers but cannot pretend claimed compute stopped", async () => {
  await task("one"); const offer = (await offerNextCompute(context()))!; await started(offer);
  await db.prisma.remoteTask.update({ where: { id: "one" }, data: { ownerPaused: true } });
  await reconcileComputeOffers(context(1));
  expect(await db.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(0);
  await expect(claimCompute({ ...context(2), taskId: "one", offerId: offer.id, request })).rejects.toThrow("eligible");
  await task("two"); const next = (await offerNextCompute(context(3)))!; await started(next, 3);
  await claimCompute({ ...context(4), taskId: "two", offerId: next.id, request });
  await db.prisma.remoteTask.update({ where: { id: "two" }, data: { ownerPaused: true } });
  await reconcileComputeOffers(context(5));
  expect(await db.prisma.computeSlot.count({ where: { allocationId: next.id } })).toBe(1);
});
test("undelivered offer timeout does not block another task or start the claim clock", async () => {
  await task("one"); await task("two"); const first = (await offerNextCompute(context()))!;
  const next = (await offerNextCompute(context(30_000)))!;
  expect(next.id).not.toBe(first.id);
  expect(next.deliveredAt).toBeNull(); expect(next.expiresAt).toBeNull();
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: first.instructionId } })).state).toBe("cancelled");
});
test("durable prompt-start can reconcile after restart with its original delivery timestamp", async () => {
  await task("one"); const offer = (await offerNextCompute(context()))!;
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: `${offer.id}:started`, runtimeSessionId: "primary-one", requestId: offer.instructionId, phase: "started", occurredAt: context(5_000).now } });
  await db.prisma.$disconnect();
  const recovered = await confirmComputeDelivery({ ...context(10_000), sessionId: "primary-one", requestId: offer.instructionId });
  expect(recovered?.expiresAt).toEqual(context(65_000).now);
  const replay = await confirmComputeDelivery({ ...context(11_000), sessionId: "primary-one", requestId: offer.instructionId });
  expect(replay).toEqual(recovered);
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});
test("changed task pin and wrong recipe, purpose or primary cannot claim", async () => {
  await task("one"); await task("other"); const offer = (await offerNextCompute(context()))!; await started(offer);
  for (const changed of [{ ...request, purpose: "review" as const }, { ...request, recipeDigest: "d".repeat(64) }, { ...request, revision: "e".repeat(40) }]) {
    await expect(claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request: changed })).rejects.toThrow("exact environment");
  }
  await expect(claimCompute({ ...context(1), taskId: "other", offerId: offer.id, request })).rejects.toThrow("exact environment");
  await db.prisma.remoteTask.update({ where: { id: "one" }, data: { toolingRevision: "d".repeat(40) } });
  await expect(claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request })).rejects.toThrow("ownership changed");
});
test("unreconciled existing compute uses the host budget rather than becoming free", async () => {
  await task("one"); await task("existing");
  await db.prisma.remoteTaskResource.create({ data: { taskId: "existing", key: "old-app", kind: "task-runtime", purpose: "development", externalId: "/fixture/old-receipt", state: "allocated" } });
  expect(await offerNextCompute(context())).toBeNull();
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});
test("decline returns an eligible task to the tail and cannot free a claimed startup", async () => {
  await task("one"); await task("two"); const first = (await offerNextCompute(context()))!; await started(first); await finishTurn(first);
  expect(await declineCompute({ ...context(1), taskId: "one", offerId: first.id })).toEqual({ declined: true });
  const next = (await offerNextCompute(context(2)))!; await started(next, 2);
  await claimCompute({ ...context(3), taskId: "two", offerId: next.id, request });
  expect(await declineCompute({ ...context(4), taskId: "two", offerId: next.id })).toEqual({ declined: false });
  expect(await db.prisma.computeSlot.count({ where: { allocationId: next.id } })).toBe(1);
});

test("an occupied higher slot remains debited after unknown compute reduces the budget", async () => {
  const two = { ...context(), policy: ComputePolicy.parse({ enabled: true, slots: 2 }) };
  const one = await task("one"); await task("two");
  await db.prisma.computeSlot.createMany({ data: [
    { id: "host:0", machineId: "host", ordinal: 0 },
    { id: "host:1", machineId: "host", ordinal: 1, allocationId: "existing-allocation" },
  ] });
  await db.prisma.remoteTaskResource.create({ data: { taskId: one.taskId, key: "unknown", kind: "task-runtime", purpose: "development", externalId: "unknown", state: "ready" } });
  expect(await offerNextCompute(two)).toBeNull();
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(1);
});

test("a pause after durable start withdraws that queued recovery without blocking another task", async () => {
  await task("one"); await task("two"); const first = (await offerNextCompute(context()))!;
  await db.prisma.runtimeInstruction.update({ where: { id: first.instructionId }, data: { state: "dispatching", executionRequestId: "recovered-start" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "recovered-start", runtimeSessionId: "primary-one", requestId: "recovered-start", phase: "started", occurredAt: began } });
  await db.prisma.remoteTask.update({ where: { id: "one" }, data: { ownerPaused: true } });
  const next = (await offerNextCompute(context(1)))!;
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("ineligible");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: next.instructionId } })).sessionId).toBe("primary-two");
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
});

test("first claim refuses a reserved low slot when the full occupied budget shrank", async () => {
  await task("one"); const offer = (await offerNextCompute(context()))!; await started(offer);
  await db.prisma.computeSlot.create({ data: { id: "host:2", machineId: "host", ordinal: 2, allocationId: "older-running" } });
  await expect(claimCompute({ ...context(1), taskId: "one", offerId: offer.id, request })).rejects.toThrow("reservation is unavailable");
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).claimedAt).toBeNull();
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(2);
});

test("physical stopped reconciliation releases exactly one settled allocation and saved resume queues fairly", async () => {
  const { bindComputeResource, reconcileObservedCompute } = await import("./compute-admission.ts");
  const { finalizationResourceIdentity } = await import("./finalization-resources.ts");
  const environment = await task("saved"), offer = (await offerNextCompute(context()))!;
  await started(offer); await claimCompute({ ...context(1), taskId: "saved", offerId: offer.id, request });
  const resource = await db.prisma.remoteTaskResource.create({ data: { id: "saved-resource", taskId: "saved", key: request.key, kind: "task-runtime", purpose: "development", externalId: "/fixture/runtime.json", state: "ready", metadata: { recipeHash: request.recipeDigest, revision: request.revision } } });
  await bindComputeResource({ ...context(2), taskId: "saved", offerId: offer.id, resourceKey: request.key });
  const observation = { version: 1, environmentId: environment.id, taskId: "saved", primarySessionId: "primary-saved", purpose: "development", revision: request.revision, recipeDigest: request.recipeDigest,
    resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest, observedAt: context(3).now.getTime(), state: "running", coverage: "incomplete", configurationDigest: "8".repeat(64), routes: [], operations: { coverage: "incomplete", active: 0, generation: "9".repeat(64) } };
  const reconcile = () => reconcileObservedCompute({ ...context(3), environmentId: environment.id, runtime: {} });
  await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { observation } });
  expect(await reconcile()).toEqual({ released: false });
  observation.state = "stopped"; await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { observation } });
  expect(await reconcile()).toEqual({ released: false }); // actual executing delivery
  await finishTurn(offer);
  expect(await reconcile()).toEqual({ released: false }); // missing terminal lifecycle stays uncertain
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "saved-terminal", runtimeSessionId: "primary-saved", requestId: offer.instructionId, phase: "completed", occurredAt: context(3).now } });
  expect(await reconcile()).toEqual({ released: true });
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).state).toBe("ready");
  await task("next");
  await requestCompute({ ...context(4), taskId: "saved", request });
  expect((await offerNextCompute(context(4)))!.environmentId).not.toBe(environment.id);
  expect(await db.prisma.computeWait.count({ where: { environmentId: environment.id } })).toBe(1);
});

test("an inspection failure cannot revoke a queued offer or free reserved capacity", async () => {
  await task("one"); const offer = (await offerNextCompute(context()))!;
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
  const original = db.prisma.$transaction.bind(db.prisma);
  db.prisma.$transaction = (async (callback: any) => original(async tx => callback(new Proxy(tx, { get(target, key) {
    if (key === "remoteTask") return { ...target.remoteTask, findUnique: async () => { throw new Error("fixture database read failure"); } };
    return Reflect.get(target, key);
  } })))) as typeof db.prisma.$transaction;
  try { await expect(reconcileComputeOffers(context(1))).rejects.toThrow("database read failure"); }
  finally { db.prisma.$transaction = original as typeof db.prisma.$transaction; }
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("queued");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: offer.instructionId } })).state).toBe("dispatching");
});
