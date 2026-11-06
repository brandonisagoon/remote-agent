import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";

setDefaultTimeout(120_000);
let db: TestDatabase;
const config = testConfig();
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

async function fixture() {
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "task", agentCommand: "codex", repositoryId: "repo", machineId: config.machine,
    role: "primary", cwd: "/fixture/task", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: config.machine, branchName: "task", primarySessionId: "primary",
    toolingRoot: "/fixture/old-tooling", toolingRevision: "f".repeat(40) } });
  await db.prisma.toolingRelease.create({ data: { id: "release", repositoryId: "repo", revision: "a".repeat(40), tree: "b".repeat(40), policyBlob: "c".repeat(40),
    checkout: "/fixture/release", lockfileDigest: "d".repeat(64), bunVersion: "fixture", manifest: { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 1 },
      stateFormats: { "drafted.runtime": { read: [1, 2], write: 1, writeVersions: [1, 2], preservesUnknown: true } } } } });
  await db.prisma.toolingOperation.create({ data: { id: "operation", taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: "recovery", inputDigest: "e".repeat(64),
    kind: "compute-neon-recovery", existingOperationId: "offer", resourceKey: "runtime-development", generation: 1, releaseId: "release", protocol: 1 } });
  const app = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime() });
  return (task = "task", operation = "operation", authenticated = true) => app.request(`/api/tasks/${task}/compute-neon-recovery/${operation}`,
    { headers: authenticated ? { authorization: `Bearer ${config.apiKey}` } : {} });
}

test("recovery result read uses stored task and primary authority, including after pause and completion", async () => {
  const read = await fixture();
  expect((await read("task", "operation", false)).status).toBe(401);
  expect((await read("other-task")).status).toBe(404);
  expect((await read("task", "missing")).status).toBe(404);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true, phase: "closed" } });
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed" } });
  for (const status of ["bound", "running", "unknown", "completed"]) {
    await db.prisma.toolingOperation.update({ where: { id: "operation" }, data: { status } });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "operation" } })).status).toBe(status);
  }
  for (const change of [{ repositoryId: "other" }, { sessionId: "other" }, { kind: "compute-configure" }]) {
    await db.prisma.toolingOperation.update({ where: { id: "operation" }, data: { repositoryId: "repo", sessionId: "primary", kind: "compute-neon-recovery", ...change } });
    expect((await read()).status).toBe(404);
  }
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(0);
  expect(await db.prisma.toolingStateWrite.count()).toBe(0);
});

test("an unreadable committed history is a refusal, never an absent result or repair", async () => {
  const read = await fixture();
  const event = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "compute:task", action: "compute-neon-recovery", key: "bad", value: "{" } });
  const before = await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "operation" } });
  const response = await read();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "neon-recovery-result-unverifiable", reason: "event-unreadable" });
  expect(await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: "operation" } })).toEqual(before);
  expect(await db.prisma.runtimeMetadataEvent.findMany()).toEqual([event]);
});
