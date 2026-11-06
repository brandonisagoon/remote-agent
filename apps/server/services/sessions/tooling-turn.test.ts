import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { withToolingInstructions } from "../../../../lib/skills/compose.ts";
import { prepareSourceToolingTurn, recordSourceToolingFailure } from "./tooling-turn.ts";

import { resolveTaskInstruction } from "./inbox.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";

let db: TestDatabase, root: string;
const config = testConfig();
beforeEach(async () => { db = await createTestDatabase(); root = mkdtempSync(path.join(tmpdir(), "tooling-turn-")); });
afterEach(async () => { await db.cleanup(); rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  for (const name of ["product", "a", "b"]) mkdirSync(path.join(root, name));
  writeFileSync(path.join(root, "a", "AGENTS.md"), "Instructions A\n");
  writeFileSync(path.join(root, "b", "AGENTS.md"), "Instructions B\n");
  await db.prisma.runtimeSession.create({ data: { id: "owner", scopeKey: "scope", agentCommand: "codex", role: "primary", status: "idle", repositoryId: "repo", machineId: config.machine, cwd: path.join(root, "product") } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: config.machine, primarySessionId: "owner", branchName: "fixture", worktreePath: path.join(root, "product"), toolingRoot: root, toolingRevision: "a".repeat(40), pinnedToolingRoot: path.join(root, "a") } });
  await db.prisma.toolingRelease.create({ data: { id: "release-b", repositoryId: "repo", revision: "b".repeat(40), tree: "c".repeat(40), policyBlob: "d".repeat(40), checkout: path.join(root, "b"), manifest: {}, lockfileDigest: "fixture", bunVersion: "fixture" } });
  const text = withToolingInstructions("Owner request remains verbatim", path.join(root, "product"), path.join(root, "a"));
  return db.prisma.runtimeInstruction.create({ data: { id: "message", sessionId: "owner", sourceMessageId: "source", text } });
}
async function activate() { await db.prisma.toolingSelection.create({ data: { repositoryId: "repo", releaseId: "release-b", generation: 1, activatedAt: new Date() } }); }
const prepare = (receipt: Awaited<ReturnType<typeof fixture>>) => prepareSourceToolingTurn({ prisma: db.prisma, config, receipt, requestId: receipt.id }, { verify: async () => {} });

test("a queued owner turn adopts B with durable instructions while A pin and ingress remain unchanged", async () => {
  const receipt = await fixture(); await activate();
  const turn = await prepare(receipt);
  expect(turn.text).toContain("Instructions B"); expect(turn.text).not.toContain("Instructions A");
  expect(turn.text).toContain("Owner request remains verbatim");
  await db.prisma.$transaction(async tx => {
    expect(await turn.claim(tx)).toBe(true);
    await tx.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "dispatching", executionRequestId: receipt.id } });
  });
  const recorded = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { source: "tooling-turn", key: receipt.id } });
  expect(JSON.parse(recorded.value!)).toMatchObject({ releaseId: "release-b", generation: 1, text: turn.text, sourceMessageId: "source" });
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } })).text).toBe(receipt.text);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).toolingRevision).toBe("a".repeat(40));
  await expect(prepare(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } }))).rejects.toThrow("unstarted");
});

test("activation or pause during preparation refuses the dispatch without recording stale instructions", async () => {
  const receipt = await fixture();
  const legacy = await prepare(receipt); await activate();
  expect(await db.prisma.$transaction(tx => legacy.claim(tx))).toBe(false);
  const selected = await prepare(receipt);
  await db.prisma.toolingSelection.update({ where: { repositoryId: "repo" }, data: { generation: 2 } });
  expect(await db.prisma.$transaction(tx => selected.claim(tx))).toBe(false);
  const refreshed = await prepare(receipt);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  expect(await db.prisma.$transaction(tx => refreshed.claim(tx))).toBe(false);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { source: "tooling-turn" } })).toBe(0);
});

test("synthetic continuations never adopt the current release and unavailable provenance blocks only its source turn", async () => {
  const receipt = await fixture(); await activate();
  const synthetic = await prepare({ ...receipt, sourceMessageId: null });
  expect(synthetic.text).toBe(receipt.text);
  const broken = { ...receipt, text: receipt.text.replace("Instructions A", "Unverifiable old policy") };
  await expect(prepare(broken)).rejects.toThrow("verifiable original tooling prefix");
  await expect(prepareSourceToolingTurn({ prisma: db.prisma, config, receipt, requestId: receipt.id }, { verify: async () => { throw new Error("tampered checkout"); } })).rejects.toThrow("tampered checkout");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
});


async function authorizeRetry(receipt: Awaited<ReturnType<typeof fixture>>) {
  await db.prisma.runtimeSourceMessage.create({ data: { id: "source", provider: "linear", connectionId: "fixture", repositoryId: "repo", machineId: config.machine,
    resourceId: "issue", resourceIdentifier: "DRA-fixture", commentId: "comment", threadRootId: "comment", authorId: "owner", body: "Owner request", presentation: {}, state: "attention" } });
  const runtime = createFakeAgentRuntime([{ id: "owner", cwd: path.join(root, "product"), repositoryId: "repo", machineId: config.machine }]);
  runtime.reconcileInterruptedSession = async id => (await runtime.getSession(id))!;
  await resolveTaskInstruction(db.prisma, runtime, { taskId: "task", instructionId: receipt.id, action: "retry", reason: "Owner verified prior attempt stopped", requestKey: "owner-retry", ownerAuthenticated: true });
  const decision = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "instruction-resolved" } });
  return { receipt: await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } }), requestId: `${receipt.id}:retry:${decision.sequence}` };
}

test("an owner-authorized retry preserves its recorded release after activation and claims once", async () => {
  const receipt = await fixture(); await activate();
  const first = await prepare(receipt);
  await db.prisma.$transaction(async tx => {
    expect(await first.claim(tx)).toBe(true);
    await tx.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "unknown", executionRequestId: receipt.id } });
  });
  const released = await db.prisma.toolingRelease.findUniqueOrThrow({ where: { id: "release-b" } });
  await db.prisma.toolingRelease.create({ data: { ...released, manifest: {}, id: "release-c", revision: "e".repeat(40) } });
  await db.prisma.toolingSelection.update({ where: { repositoryId: "repo" }, data: { releaseId: "release-c", generation: 2 } });
  const retry = await authorizeRetry(receipt);
  const prepared = await prepareSourceToolingTurn({ prisma: db.prisma, config, ...retry }, { verify: async release => { expect(release.revision).toBe("b".repeat(40)); } });
  expect(prepared.text).toBe(first.text);
  const claim = () => db.prisma.$transaction(async tx => {
    if (!(await prepared.claim(tx))) return false;
    await tx.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "dispatching", executionRequestId: retry.requestId } });
    return true;
  });
  expect(await claim()).toBe(true);
  expect(await claim()).toBe(false);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } })).text).toBe(receipt.text);
});

test("a retry predating release selection adopts current code only with a matching durable owner decision", async () => {
  const receipt = await fixture();
  await db.prisma.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "unknown", executionRequestId: "old-turn" } });
  await activate();
  const retry = await authorizeRetry(receipt);
  await expect(prepareSourceToolingTurn({ prisma: db.prisma, config, ...retry, requestId: "invented-retry" }, { verify: async () => {} })).rejects.toThrow("unstarted");
  const prepared = await prepareSourceToolingTurn({ prisma: db.prisma, config, ...retry }, { verify: async () => {} });
  expect(prepared.text).toContain("Instructions B");
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  expect(await db.prisma.$transaction(tx => prepared.claim(tx))).toBe(false);
});

test("a failed checkout has a durable idempotent diagnosis and the queued message recovers", async () => {
  const receipt = await fixture(); await activate();
  const failure = new Error("Selected checkout is tampered");
  await expect(prepareSourceToolingTurn({ prisma: db.prisma, config, receipt, requestId: receipt.id }, { verify: async () => { throw failure; } })).rejects.toThrow("tampered");
  expect(await recordSourceToolingFailure(db.prisma, receipt, failure)).toBe(true);
  const diagnosed = await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } });
  expect(diagnosed).toMatchObject({ state: "queued", detail: "Tooling adoption needs attention: Selected checkout is tampered" });
  expect(await recordSourceToolingFailure(db.prisma, diagnosed, failure)).toBe(false);
  const recovered = await prepare(diagnosed);
  await db.prisma.$transaction(async tx => {
    expect(await recovered.claim(tx)).toBe(true);
    await tx.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "dispatching", detail: null, executionRequestId: receipt.id } });
  });
  expect(await recordSourceToolingFailure(db.prisma, diagnosed, failure)).toBe(false);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } })).detail).toBeNull();
});
