import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { assertConnectorOwnership } from "../../services/tasks/connector-ownership.ts";

let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", repositoryId: "repo", machineId: "host", cwd: "/task", role: "primary", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: "/task", toolingRoot: "/tooling", toolingRevision: "a".repeat(40), primarySessionId: "primary", phase: "working" } });
});
afterEach(async () => { await db.cleanup(); });
const receipt = { key: "capture", kind: "evidence", purpose: "browser", externalId: "/task-evidence/capture.png", state: "ready" };
const write = (metadata: unknown) => createApp({ config: testConfig(), prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true }).request("/api/sessions/primary/task/resources", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...receipt, metadata }),
});

test.each(["bytes", "byteSize", "size", "sizeBytes"])("registration and cleanup accept the same %s identity without normalizing storage", async key => {
  const metadata = { sha256: "a".repeat(64), [key]: 12, description: "original" };
  expect((await write(metadata)).status).toBe(200);
  expect((await db.prisma.remoteTaskResource.findFirstOrThrow()).metadata).toEqual(metadata);
});

test.each([{}, { bytes: 12 }, { sha256: "a".repeat(64) }, { sha256: "a".repeat(64), bytes: 12, sizeBytes: 13 },
  { sha256: "a".repeat(64), sizeBytes: -1 }, { sha256: "a".repeat(64), sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
])("new unusable evidence is rejected before registration: %j", async metadata => {
  expect((await write(metadata)).status).toBe(409);
  expect(await db.prisma.remoteTaskResource.count()).toBe(0);
});

test("historical incomplete evidence can retain its original metadata for the adoption path", async () => {
  const metadata = { description: "historical directory" };
  await db.prisma.remoteTaskResource.create({ data: { ...receipt, taskId: "task", metadata } });
  expect((await write(metadata)).status).toBe(200);
  expect((await db.prisma.remoteTaskResource.findFirstOrThrow()).metadata).toEqual(metadata);
});

const connectorMetadata = () => ({ version: 1, taskId: "task", pid: 1234, dedicated: true, configPath: "/task-env/cloudflared.yml", pidFile: "/task-env/connector.pid",
  tunnelId: "11111111-2222-4333-8444-555555555555", hostname: "task.brandongoon.com", source: "http://localhost:1234",
  process: { pid: 1234, start: "linux:fixture:123", uid: 501, cwd: "/task", executable: "/usr/bin/cloudflared", argv: ["cloudflared", "--config", "/task-env/cloudflared.yml", "tunnel", "run"] } });
const connectorWrite = (metadata: unknown) => createApp({ config: testConfig(), prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true }).request("/api/sessions/primary/task/resources", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "connector", kind: "cloudflared-connector", purpose: "development", externalId: "pid:1234", state: "ready", metadata }),
});
test("connector registration requires complete identity, exact tunnel arguments and the original task", async () => {
  const metadata = connectorMetadata();
  for (const invalid of [{ ...metadata, process: undefined }, { ...metadata, taskId: "other" }, { ...metadata, process: { ...metadata.process, pid: 9999 } },
    { ...metadata, source: "https://public.example.com" }, { ...metadata, process: { ...metadata.process, argv: ["cloudflared", "tunnel", "run", "--token", "do-not-accept"] } }]) {
    expect((await connectorWrite(invalid)).status).toBe(409);
    expect(await db.prisma.remoteTaskResource.count()).toBe(0);
  }
  expect((await connectorWrite(metadata)).status).toBe(200);
  expect((await db.prisma.remoteTaskResource.findFirstOrThrow()).metadata).toEqual(metadata);
});

test("another unresolved host owner prevents connector registration and cleanup renewal", async () => {
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", repositoryId: task.repositoryId, machineId: task.machineId, branchName: "codex/other", worktreePath: "/other", toolingRoot: "/tooling", toolingRevision: task.toolingRevision } });
  const other = await db.prisma.remoteTaskResource.create({ data: { taskId: "other", key: "other", kind: "cloudflared-connector", purpose: "development", externalId: "pid:1234", state: "ready", metadata: connectorMetadata() } });
  expect((await connectorWrite(connectorMetadata())).status).toBe(409);
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "historical", kind: "cloudflared-connector", purpose: "development", externalId: "pid:1234", state: "ready", metadata: connectorMetadata() } });
  await expect(assertConnectorOwnership(db.prisma, "task", "host")).rejects.toThrow("another unresolved owner");
  await db.prisma.remoteTaskResource.update({ where: { id: other.id }, data: { state: "released" } });
  await assertConnectorOwnership(db.prisma, "task", "host");
});
