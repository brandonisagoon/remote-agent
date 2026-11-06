import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { withToolingInstructions } from "../../../../lib/skills/compose.ts";
import { prepareSourceToolingTurn } from "./tooling-turn.ts";

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
const prepare = (receipt: Awaited<ReturnType<typeof fixture>>) => prepareSourceToolingTurn({ prisma: db.prisma, config, receipt, requestId: "turn" }, { verify: async () => {} });

test("a queued owner turn adopts B with durable instructions while A pin and ingress remain unchanged", async () => {
  const receipt = await fixture(); await activate();
  const turn = await prepare(receipt);
  expect(turn.text).toContain("Instructions B"); expect(turn.text).not.toContain("Instructions A");
  expect(turn.text).toContain("Owner request remains verbatim");
  await db.prisma.$transaction(async tx => {
    expect(await turn.claim(tx)).toBe(true);
    await tx.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "dispatching", executionRequestId: "turn" } });
  });
  const recorded = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { source: "tooling-turn", key: "turn" } });
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
  await expect(prepareSourceToolingTurn({ prisma: db.prisma, config, receipt, requestId: "turn" }, { verify: async () => { throw new Error("tampered checkout"); } })).rejects.toThrow("tampered checkout");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(false);
});
