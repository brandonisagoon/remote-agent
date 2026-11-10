import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { createAcpxSessionRuntime } from "../../transports/acpx/session-runtime.ts";
import { CONFIGURATION_REPAIR_CONTRACT, TOOLING_OPERATION_ASSOCIATION } from "./tooling-operations.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { configurationRepairInstructionAllows, configurationRepairSourceAllows, wakeConfigurationAfterRepair } from "./configuration-repair-wakeup.ts";
import type { linkedSourceIssue } from "../sessions/questions.ts";
import { tickCompute } from "./compute-worker.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); }, 20_000);
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
async function fixture(status = "idle") {
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const root = await mkdtemp(path.join(tmpdir(), "configuration-repair-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const base = testConfig({ machine: "host", acpxStateDir: root, compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
  const repository = { ...base.repository, id: "repo", tooling: { root: "/configured/new-tooling", revision: B } };
  const config = { ...base, repository, repositories: { repo: repository } }, prisma = db.prisma;
  await prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", cwd: root, repositoryId: "repo", machineId: "host", role: "primary", lifecycle: "persistent", status, acpxRecordId: "primary", acpxSessionId: "provider-primary" } });
  const task = await prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: root, toolingRoot: "/original/tooling", toolingRevision: A, primarySessionId: "primary", phase: "working" } });
  const record: AcpSessionRecord = { schema: "acpx.session.v1", acpxRecordId: "primary", acpSessionId: "provider-primary", agentCommand: "codex", cwd: root,
    createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-02T00:00:01Z", lastSeq: 1, pid: 2147483647, lastPromptAt: "2026-01-02T00:00:00Z", lastRequestId: "original-failed",
    eventLog: { active_path: path.join(root, "primary.stream"), segment_count: 1, max_segment_bytes: 100000, max_segments: 1 }, messages: [], updated_at: "2026-01-02T00:00:01Z", cumulative_token_usage: {}, request_token_usage: {} };
  const store = createRuntimeStore({ stateDir: root }); await store.save(record);
  await prisma.runtimeLifecycleEvent.create({ data: { id: "terminal", runtimeSessionId: "primary", requestId: record.lastRequestId!, phase: "failed", occurredAt: new Date(record.lastUsedAt) } });
  await prisma.toolingRelease.create({ data: { id: "original-release", repositoryId: "repo", revision: A, tree: "e".repeat(40), policyBlob: "f".repeat(40), checkout: "/immutable/original", lockfileDigest: "0".repeat(64), bunVersion: "1.3.0",
    manifest: { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 3 }, stateFormats: { "drafted.runtime": { read: [1], write: 1, preservesUnknown: true } } } } });
  const resource = await prisma.remoteTaskResource.create({ data: { id: "resource", taskId: task.id, key: "app", kind: "task-runtime", purpose: "development", externalId: "/private/runtime.json", state: "active", metadata: { containerId: "d".repeat(64), revision: C, recipeHash: "e".repeat(64) } } });
  const environment = await prisma.computeEnvironment.create({ data: { id: "environment", taskId: task.id, primarySessionId: "primary", machineId: "host", taskIdentity: "9".repeat(64), key: resource.key, purpose: "development", revision: C, recipeDigest: "e".repeat(64), resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest, state: "stopped" } });
  await prisma.computeOffer.create({ data: { id: "original-offer", environmentId: environment.id, machineId: "host", instructionId: "original-start", state: "stopped", dispatchDeadline: new Date() } });
  const common = { taskId: task.id, sessionId: "primary", repositoryId: "repo", releaseId: "original-release", generation: 1, protocol: 3 };
  await prisma.toolingOperation.create({ data: { ...common, id: "original-command", requestKey: "original-settings-change", inputDigest: "1".repeat(64), kind: "adapter-command", status: "running" } });
  await prisma.toolingOperation.create({ data: { ...common, id: "failed-configure", requestKey: "old-pid-callback", inputDigest: "2".repeat(64), kind: "compute-configure", parentOperationId: "original-command", existingOperationId: "original-offer", status: "unknown" } });
  const attempt = async (state: string, extra: Record<string, unknown> = {}) => prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: TOOLING_OPERATION_ASSOCIATION, key: "outcome:failed-configure",
    value: JSON.stringify({ version: 1, state, attemptId: "old-attempt", operationId: "failed-configure", inputDigest: "2".repeat(64), route: "POST /api/tasks/:taskId/compute-configure", ...extra }) } });
  await attempt("intent"); await attempt("unknown");
  const runtime = createAcpxSessionRuntime(prisma, config);
  const context = { prisma, config, runtime, taskId: task.id, environmentId: environment.id };
  // This suite exercises real SQLite and real provider-absence observation.
  // Capability/source/HEAD are injected; the paired suite exercises actual code.
  const dependencies: Parameters<typeof wakeConfigurationAfterRepair>[1] = {
    revision: async () => C,
    resolve: async input => {
      expect(input.release).toMatchObject({ id: "original-release", revision: A, checkout: "/immutable/original" });
      expect(input.install).toBe(false);
      return { instructions: "Use the supported runtime configure command.", receipt: { contract: "remote-agent.tooling-capability/v1", capability: "runtime", source: "pinned-constituents", taskToolingRevision: A, capabilityRevision: A, checkout: "/immutable/original", instructions: "runtime.md", adapter: "runtime.ts" } };
    },
  };
  const wake = (overrides: Parameters<typeof wakeConfigurationAfterRepair>[1] = {}) => wakeConfigurationAfterRepair(context, { ...dependencies, ...overrides });
  return { ...context, store, record, task, resource, environment, attempt, dependencies, wake };
}

for (const status of ["idle", "error", "active"]) test(`one original-primary continuation survives restart with a genuinely stopped ${status} provider`, async () => {
  const f = await fixture(status), operations = await f.prisma.toolingOperation.findMany(), history = await f.prisma.runtimeMetadataEvent.findMany(), environment = await f.prisma.computeEnvironment.findMany(), provider = await f.store.load("primary");
  const result = await f.wake(); expect(result.state).toBe("queued");
  const instruction = await f.prisma.runtimeInstruction.findFirstOrThrow();
  expect(instruction).toMatchObject({ sessionId: "primary", state: "queued", executionRequestId: null });
  expect(instruction.text).toContain('"requestKey": "original-settings-change"');
  expect(instruction.text).toContain(A);
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(f.task);
  expect(await f.prisma.toolingOperation.findMany()).toEqual(operations);
  expect(await f.prisma.runtimeMetadataEvent.findMany({ where: { action: TOOLING_OPERATION_ASSOCIATION } })).toEqual(history);
  expect(await f.prisma.computeEnvironment.findMany()).toEqual(environment);
  expect(await f.store.load("primary")).toEqual(provider);
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "primary" } })).status).toBe(status === "active" ? "idle" : status);
  expect(await f.prisma.$transaction(tx => configurationRepairInstructionAllows(tx, f.config, instruction))).toBe(true);
  await f.prisma.$disconnect();
  expect(await wakeConfigurationAfterRepair({ ...f, runtime: createAcpxSessionRuntime(f.prisma, f.config) }, f.dependencies)).toEqual({ state: "not-needed" });
  expect(await f.prisma.runtimeInstruction.count()).toBe(1);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "configuration-repair-wakeup", key: instruction.id } })).toBe(1);
});

test("concurrent collectors and a lost committed response cannot duplicate the continuation", async () => {
  const f = await fixture(), release = f.runtime.releaseIdleTransports!.bind(f.runtime);
  f.runtime.releaseIdleTransports = input => release({ ...input, commit: async (proof, check) => { await input.commit(proof, check); throw new Error("lost response"); } });
  await Promise.all([f.wake(), f.wake()]);
  expect(await f.prisma.runtimeInstruction.count()).toBe(1);
  expect(await f.wake()).toEqual({ state: "not-needed" });
});

for (const refusal of ["pause", "closed", "review", "live-provider", "wrong-turn", "missing-provider", "invalid-time", "new-execution", "unknown-inbox", "in-flight-attempt", "duplicate-intent", "orphan-outcome", "malformed-history", "repair-already-attempted", "foreign-parent", "changed-release", "released-resource", "owner-completion", "cleanup", "worktree", "capability"] as const)
  test(`shared repair does not resume ${refusal}`, async () => {
    const f = await fixture(refusal === "live-provider" ? "active" : "idle");
    if (refusal === "pause") await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: true } });
    if (refusal === "closed" || refusal === "review") await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { phase: refusal } });
    if (refusal === "live-provider") await f.store.save({ ...f.record, pid: process.pid });
    if (refusal === "wrong-turn") await f.store.save({ ...f.record, lastRequestId: "different-turn" });
    if (refusal === "missing-provider") await f.prisma.runtimeSession.update({ where: { id: "primary" }, data: { acpxRecordId: "missing" } });
    if (refusal === "invalid-time") await f.store.save({ ...f.record, lastPromptAt: "invalid" });
    if (refusal === "new-execution") await f.prisma.runtimeLifecycleEvent.create({ data: { id: "new-turn", runtimeSessionId: "primary", requestId: "new-turn", phase: "started", occurredAt: new Date() } });
    if (refusal === "unknown-inbox") await f.prisma.runtimeInstruction.create({ data: { id: "uncertain", sessionId: "primary", text: "Original execution is uncertain", state: "unknown" } });
    if (refusal === "in-flight-attempt") await f.attempt("intent", { attemptId: "new-attempt" });
    if (refusal === "duplicate-intent") await f.attempt("intent");
    if (refusal === "orphan-outcome") await f.attempt("unknown", { attemptId: "orphan" });
    if (refusal === "malformed-history") await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: TOOLING_OPERATION_ASSOCIATION, key: "outcome:failed-configure", value: "{" } });
    if (refusal === "repair-already-attempted") { await f.attempt("intent", { attemptId: "new-attempt", repairContracts: [CONFIGURATION_REPAIR_CONTRACT] }); await f.attempt("unknown", { attemptId: "new-attempt" }); }
    if (refusal === "foreign-parent") await f.prisma.toolingOperation.update({ where: { id: "original-command" }, data: { sessionId: "other" } });
    if (refusal === "changed-release") await f.prisma.toolingOperation.update({ where: { id: "original-command" }, data: { generation: 2 } });
    if (refusal === "released-resource") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "released" } });
    if (refusal === "owner-completion") await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "owner:task", action: "completion-owner-approval", key: "new-owner-delivery", value: "{}" } });
    if (refusal === "cleanup") await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: "finalization-cleanup-started", key: "finalize:task", value: "{}" } });
    const result = await f.wake(refusal === "worktree" ? { revision: async () => B } : refusal === "capability" ? { resolve: async () => { throw new Error("immutable capability unavailable"); } } : {});
    expect(result.state).not.toBe("queued");
    expect(await f.prisma.runtimeInstruction.count({ where: { id: { startsWith: "configuration-repair:" } } })).toBe(0);
    expect((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.taskId } })).toolingRevision).toBe(A);
  });

for (const change of ["pause", "resource", "environment", "parent", "history", "owner", "instruction", "resolved"] as const)
  test(`normal inbox rechecks ${change} before claiming the repair continuation`, async () => {
    const f = await fixture(); expect((await f.wake()).state).toBe("queued");
    const instruction = await f.prisma.runtimeInstruction.findFirstOrThrow();
    if (change === "pause") await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: true } });
    if (change === "resource") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { externalId: "/different/runtime.json" } });
    if (change === "environment") await f.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { revision: B } });
    if (change === "parent") await f.prisma.toolingOperation.update({ where: { id: "original-command" }, data: { inputDigest: "3".repeat(64) } });
    if (change === "history") await f.attempt("intent", { attemptId: "another-attempt" });
    if (change === "owner") await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { toolingRevision: B } });
    if (change === "instruction") await f.prisma.runtimeInstruction.update({ where: { id: instruction.id }, data: { text: "Unrelated action" } });
    if (change === "resolved") await f.prisma.toolingOperation.update({ where: { id: "failed-configure" }, data: { status: "completed" } });
    expect(await f.prisma.$transaction(tx => configurationRepairInstructionAllows(tx, f.config, instruction))).toBe(false);
    expect(await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } })).toMatchObject({ state: change === "pause" ? "queued" : "cancelled", executionRequestId: null });
    if (change === "pause") {
      await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: false } });
      expect(await f.prisma.$transaction(tx => configurationRepairInstructionAllows(tx, f.config, instruction))).toBe(true);
    }
  });

test("the ordinary compute collector queues repair even while producer observation still refuses", async () => {
  const f = await fixture();
  expect(await tickCompute(f, { repair: input => wakeConfigurationAfterRepair(input, f.dependencies), refresh: async () => { throw new Error("unconfirmed configuration producer"); } })).toEqual({ observed: 0, unavailable: 1 });
  expect(await f.prisma.runtimeInstruction.count({ where: { state: "queued", sessionId: "primary" } })).toBe(1);
  expect(await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: "original-offer" } })).toMatchObject({ state: "stopped" });
});

for (const mutation of ["pause", "provider", "environment", "parent"] as const) test(`repair availability rechecks ${mutation} after capability resolution`, async () => {
  const f = await fixture();
  const result = await f.wake({ resolve: async input => {
    const capability = await f.dependencies!.resolve!(input);
    if (mutation === "pause") await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: true } });
    if (mutation === "provider") await f.store.save({ ...f.record, pid: process.pid });
    if (mutation === "environment") await f.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { recipeDigest: "f".repeat(64) } });
    if (mutation === "parent") await f.prisma.toolingOperation.update({ where: { id: "original-command" }, data: { inputDigest: "f".repeat(64) } });
    return capability;
  } });
  expect(result.state).toBe("pending");
  expect(await f.prisma.runtimeInstruction.count()).toBe(0);
});

for (const state of ["Implementing", "Merge", "Cleanup", "Done", "Canceled", "unknown", "foreign"] as const) test(`linked source ${state} is checked at wakeup and inbox delivery`, async () => {
  const f = await fixture(), connectionId = f.config.activeConnectionId!;
  await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { connectionId, issueIdentifier: "TASK-1" } });
  const link = await f.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: "primary", provider: "linear", connectionId, resourceType: "issue-identifier", externalId: "TASK-1", relationship: "handles" } });
  const session = await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "primary" } });
  const read: typeof linkedSourceIssue = async () => {
    if (state === "unknown") throw new Error("Source read unavailable");
    return { session, config: f.config, link: { ...link, externalId: state === "foreign" ? "OTHER-1" : link.externalId }, issue: { id: "source-id", identifier: "TASK-1", state: { name: state, type: state === "Canceled" ? "canceled" : state === "Done" ? "completed" : "started" } } } as unknown as Awaited<ReturnType<typeof linkedSourceIssue>>;
  };
  expect(await configurationRepairSourceAllows(f.prisma, f.config, { id: "configuration-repair:fixture", sessionId: "primary" }, read)).toBe(state === "Implementing");
  expect((await f.wake({ source: read })).state === "queued").toBe(state === "Implementing");
});

test("an unacknowledged admission under the same command cannot be mistaken for an ended configuration", async () => {
  const f = await fixture();
  const parent = await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "original-command" } });
  await f.prisma.toolingOperation.create({ data: { id: "uncertain-admission", taskId: f.taskId, requestKey: "admission", inputDigest: "5".repeat(64), kind: "compute-admission", repositoryId: parent.repositoryId, sessionId: parent.sessionId, parentOperationId: parent.id, generation: parent.generation, releaseId: parent.releaseId, protocol: parent.protocol, status: "running" } });
  for (const state of ["intent", "unknown"]) await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: TOOLING_OPERATION_ASSOCIATION, key: "outcome:uncertain-admission", value: JSON.stringify({ state, attemptId: "admission", operationId: "uncertain-admission", inputDigest: "5".repeat(64), route: "POST /api/tasks/:taskId/compute-request" }) } });
  expect(await f.wake()).toEqual({ state: "not-needed" });
  expect(await f.prisma.runtimeInstruction.count()).toBe(0);
});
