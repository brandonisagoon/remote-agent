import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { createAcpxSessionRuntime } from "../../transports/acpx/session-runtime.ts";
import { reconcileClosedTaskFamily, settleClosedTaskFamily } from "./closure-recovery.ts";
import { computeTaskIdentity, requestCompute } from "./compute-admission.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { reclaimStoppedCompute } from "./compute-reclamation.ts";
import { tickCompute } from "./compute-worker.ts";
import type { readInstalledComputeReclamation } from "./compute-observer.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const root = await mkdtemp(path.join(tmpdir(), "closed-task-recovery-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const prisma = db.prisma, config = testConfig({ machine: "host", acpxStateDir: root, compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
  const store = createRuntimeStore({ stateDir: root });
  for (const id of ["primary", "delegate", "nested"]) {
    const cwd = id === "nested" ? path.join(root, "moved") : root;
    await prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", cwd, repositoryId: "repo", machineId: "host", role: id === "primary" ? "primary" : "delegate", lifecycle: "persistent", status: id === "primary" ? "closed" : "error", closedAt: id === "primary" ? new Date("2026-01-01") : null, acpxRecordId: id, acpxSessionId: `provider-${id}` } });
    const record: AcpSessionRecord = { schema: "acpx.session.v1", acpxRecordId: id, acpSessionId: `provider-${id}`, agentCommand: "codex", cwd,
      createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-02T00:00:01Z", lastSeq: 1, pid: 2147483647, lastPromptAt: "2026-01-02T00:00:00Z", lastRequestId: `${id}-completed`,
      eventLog: { active_path: path.join(root, `${id}.stream`), segment_count: 1, max_segment_bytes: 100000, max_segments: 1 }, messages: [], updated_at: "2026-01-02T00:00:01Z", cumulative_token_usage: {}, request_token_usage: {} };
    await store.save(record);
  }
  await prisma.runtimeSessionRelation.createMany({ data: [{ sourceSessionId: "delegate", targetSessionId: "primary", relationship: "spawned-by" }, { sourceSessionId: "nested", targetSessionId: "delegate", relationship: "spawned-by" }] });
  const task = await prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "branch", worktreePath: root, toolingRoot: "/original/tooling", toolingRevision: "a".repeat(40), primarySessionId: "primary", phase: "closed" } });
  const queued = await prisma.runtimeInstruction.create({ data: { id: "never-dispatched", sessionId: "nested", text: "Follow up after the original result", state: "queued" } });
  const runtime = createAcpxSessionRuntime(prisma, config);
  return { prisma, config, runtime, root, task, queued, store, context: { prisma, runtime, taskId: task.id, machineId: config.machine } };
}

test("real stopped-provider records settle interrupted closure and ordinary collection offers its capacity to the next task", async () => {
  const f = await fixture(), relations = await f.prisma.runtimeSessionRelation.findMany(), originalTask = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  const records = await Promise.all(["primary", "delegate", "nested"].map(id => f.store.load(id)));
  const configuration = { configurationFile: "/private/compute.json", configurationSha256: "b".repeat(64) };
  const resource = await f.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "app", kind: "task-runtime", purpose: "development", externalId: "/private/runtime.json", state: "released", metadata: { compute: configuration, containerId: "c".repeat(64), revision: "d".repeat(40), recipeHash: "e".repeat(64) } } });
  const environment = await f.prisma.computeEnvironment.create({ data: { id: crypto.randomUUID(), taskId: f.task.id, primarySessionId: "primary", machineId: "host", taskIdentity: computeTaskIdentity(f.task, "primary", "host", null), key: resource.key, purpose: "development", revision: "d".repeat(40), recipeDigest: "e".repeat(64), resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest, state: "running", configuration } });
  await f.prisma.computeOffer.create({ data: { id: "original", environmentId: environment.id, machineId: "host", instructionId: "original-start", state: "running", dispatchDeadline: new Date(), claimedAt: new Date() } });
  await f.prisma.computeSlot.create({ data: { id: "host:0", machineId: "host", ordinal: 0, allocationId: "original" } });
  await f.prisma.runtimeSession.create({ data: { id: "next", scopeKey: "next", agentCommand: "codex", cwd: "/next", repositoryId: "repo", machineId: "host", role: "primary", status: "idle" } });
  await f.prisma.remoteTask.create({ data: { id: "next", requestKey: "next", primarySessionId: "next", repositoryId: "repo", machineId: "host", worktreePath: "/next", branchName: "next", toolingRoot: "/tooling", toolingRevision: "a".repeat(40), phase: "working" } });
  await requestCompute({ prisma: f.prisma, machineId: "host", policy: f.config.compute!, taskId: "next", request: { key: "next", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  let physicalReads = 0;
  const read: typeof readInstalledComputeReclamation = async (_input, _task, raw: any) => {
    physicalReads++;
    expect(await f.prisma.runtimeSession.count({ where: { id: { in: ["primary", "delegate", "nested"] }, status: "closed" } })).toBe(3);
    return { version: 1, kind: "compute-reclamation", environmentId: raw.environment.id, taskId: raw.task.id, primarySessionId: raw.task.primarySessionId,
      resourceId: raw.resource.id, resourceIdentity: raw.resource.identityDigest, allocationResourceIdentity: raw.allocationResourceIdentity, configurationDigest: raw.configurationDigest, observedAt: Date.now(), state: "absent", proofDigest: "f".repeat(64) };
  };
  const delegate = (await f.store.load("delegate"))!;
  await f.store.save({ ...delegate, pid: process.pid });
  expect(await tickCompute(f, { reclaim: input => reclaimStoppedCompute(input, read) })).toEqual({ observed: 0, unavailable: 1 });
  expect(physicalReads).toBe(0);
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe("original");
  await f.store.save(delegate);
  expect(await tickCompute(f, { reclaim: input => reclaimStoppedCompute(input, read) })).toEqual({ observed: 1, unavailable: 0 });
  expect(physicalReads).toBe(1);
  expect(await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.queued.id } })).toMatchObject({ state: "cancelled", text: f.queued.text, executionRequestId: null });
  expect(await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: "original" } })).toMatchObject({ state: "stopped" });
  expect(await f.prisma.computeOffer.count({ where: { state: "queued" } })).toBe(1);
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(originalTask);
  expect(await f.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
  expect(await f.prisma.runtimeSessionRelation.findMany()).toEqual(relations);
  expect(await Promise.all(["primary", "delegate", "nested"].map(id => f.store.load(id)))).toEqual(records);
  await f.prisma.$disconnect();
  const restarted = createAcpxSessionRuntime(f.prisma, f.config);
  expect(await settleClosedTaskFamily({ ...f.context, runtime: restarted })).toEqual({ state: "settled", changed: false });
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "task-closure-settlement" } })).toBe(1);
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(0);
});

test("concurrent collection shares closure recovery and a lost committed response clears on restart without another disposition", async () => {
  const f = await fixture(), release = f.runtime.releaseIdleTransports!.bind(f.runtime);
  let reservations = 0;
  f.runtime.releaseIdleTransports = input => {
    reservations++;
    return release({ ...input, commit: async (proof, check) => { await input.commit(proof, check); throw new Error("Lost committed closure response"); } });
  };
  const results = await Promise.all([reconcileClosedTaskFamily(f.context), reconcileClosedTaskFamily(f.context)]);
  expect(results[0]).toEqual(results[1]); expect(results[0].state).toBe("pending"); expect(reservations).toBe(1);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "task-closure-settlement" } })).toBe(1);
  await f.prisma.$disconnect();
  expect(await reconcileClosedTaskFamily({ ...f.context, runtime: createAcpxSessionRuntime(f.prisma, f.config) })).toEqual({ state: "settled", changed: false });
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "task-closure-settlement" } })).toBe(1);
  const reports = await f.prisma.runtimeMetadataEvent.findMany({ where: { action: "task-closure-recovery" }, orderBy: { sequence: "asc" } });
  expect(reports.map(value => JSON.parse(value.value!).state)).toEqual(["pending", "settled"]);
});

test("owner pause arriving during provider observation preserves the original family and queue", async () => {
  const f = await fixture(), release = f.runtime.releaseIdleTransports!.bind(f.runtime);
  f.runtime.releaseIdleTransports = input => release({ ...input, check: async () => {
    await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    await input.check();
  } });
  await expect(settleClosedTaskFamily(f.context)).rejects.toThrow("original unpaused closed task");
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "nested" } })).status).toBe("error");
  expect((await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.queued.id } })).state).toBe("queued");
});

for (const change of ["live-provider", "missing-provider", "unknown", "dispatching", "attempted-queued", "retried-queued", "newer-provider", "pause", "reopened", "foreign-parent", "foreign-host"] as const) test(`closure recovery preserves original uncertainty for ${change}`, async () => {
  const f = await fixture();
  if (change === "live-provider") await f.store.save({ ...(await f.store.load("delegate"))!, pid: process.pid });
  if (change === "missing-provider") await f.prisma.runtimeSession.update({ where: { id: "delegate" }, data: { acpxRecordId: "missing" } });
  if (change === "unknown" || change === "dispatching") await f.prisma.runtimeInstruction.update({ where: { id: f.queued.id }, data: { state: change } });
  if (change === "attempted-queued") await f.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: "nested", requestId: f.queued.id, phase: "started", occurredAt: new Date() } });
  if (change === "retried-queued") await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "nested", source: "supervisor", action: "instruction-resolved", key: f.queued.id, value: JSON.stringify({ action: "retry" }) } });
  if (change === "newer-provider") await f.store.save({ ...(await f.store.load("nested"))!, lastUsedAt: new Date(Date.now() + 1_000).toISOString() });
  if (change === "pause") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (change === "reopened") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working" } });
  if (change === "foreign-parent") {
    await f.prisma.runtimeSession.create({ data: { id: "foreign", scopeKey: "foreign", agentCommand: "codex", cwd: "/other", repositoryId: "repo", machineId: "host", status: "closed" } });
    await f.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "delegate", targetSessionId: "foreign", relationship: "spawned-by" } });
  }
  if (change === "foreign-host") await f.prisma.runtimeSession.update({ where: { id: "nested" }, data: { machineId: "other" } });
  const before = await f.prisma.runtimeSession.findMany(), instructions = await f.prisma.runtimeInstruction.findMany();
  expect((await reconcileClosedTaskFamily(f.context)).state).toBe("pending");
  expect((await reconcileClosedTaskFamily(f.context)).state).toBe("pending");
  expect(await f.prisma.runtimeSession.findMany()).toEqual(before);
  expect(await f.prisma.runtimeInstruction.findMany()).toEqual(instructions);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "task-closure-settlement" } })).toBe(0);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "task-closure-recovery" } })).toBe(change === "reopened" ? 0 : 1);
});

test("a late provider change rolls back logical closure and every queued disposition; the same recovery retries after restart", async () => {
  const f = await fixture(), release = f.runtime.releaseIdleTransports!.bind(f.runtime), original = (await f.store.load("nested"))!;
  f.runtime.releaseIdleTransports = input => release({ ...input, commit: async (proof, assert) => {
    let checks = 0;
    await input.commit(proof, async () => {
      if (++checks === 2) await f.store.save({ ...original, lastRequestId: "changed-during-commit" });
      await assert!();
    });
  } });
  await expect(settleClosedTaskFamily(f.context)).rejects.toThrow("Stopped provider identity changed");
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "nested" } })).status).toBe("error");
  expect((await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.queued.id } })).state).toBe("queued");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "task-closure-settlement" } })).toBe(0);
  await f.store.save(original); await f.prisma.$disconnect();
  expect(await settleClosedTaskFamily({ ...f.context, runtime: createAcpxSessionRuntime(f.prisma, f.config) })).toEqual({ state: "settled", changed: true });
});
