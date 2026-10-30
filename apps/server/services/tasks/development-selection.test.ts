import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { retainedDevelopmentFixture } from "../../../../test-support/retained-development-fixture.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { taskRoutes, sessionTaskRoutes } from "../../routes/tasks/index.ts";
import { taskSupervisionRoutes } from "../../routes/tasks/supervision.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { readDevelopmentJson } from "./development-selection.ts";
import { completeDevelopmentIntent, recordDevelopmentIntent, renewDevelopmentAuthority } from "./development-intent.ts";
import { retainedDevelopment } from "./retained-development.ts";

let db: TestDatabase;
const roots: string[] = [];
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await retainedDevelopmentFixture(); roots.push(f.root);
  const config = testConfig();
  await db.prisma.runtimeSession.create({ data: { id: f.task.primarySessionId!, scopeKey: "primary", agentCommand: "codex", role: "primary", status: "idle", cwd: f.task.worktreePath!, repositoryId: config.repository.id, machineId: config.machine } });
  await db.prisma.remoteTask.create({ data: { id: f.task.id, requestKey: f.task.id, primarySessionId: f.task.primarySessionId, worktreePath: f.task.worktreePath,
    toolingRevision: f.task.toolingRevision!, toolingRoot: f.root, branchName: "codex/task", repositoryId: config.repository.id, machineId: config.machine, phase: "waiting" } });
  for (const resource of f.task.resources) await db.prisma.remoteTaskResource.create({ data: { ...resource, id: resource.id!, taskId: f.task.id, metadata: resource.metadata as any } });
  const context = { prisma: db.prisma, config, taskId: f.task.id };
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }))
    .route("/api/tasks", taskRoutes).route("/api/tasks", taskSupervisionRoutes).route("/api/sessions", sessionTaskRoutes);
  const post = (route: string, value: unknown) => app.request(`/api/tasks/${f.task.id}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const task = async () => (await (await app.request(`/api/tasks/${f.task.id}`)).json()).task;
  const intent = await recordDevelopmentIntent({ ...context, request: { action: "pause", development: true, requestKey: "pause-current-app" } });
  return { ...f, appRecord: f.app, app, context, post, task, intent };
}

test("retained source selection uses exact existing proofs while every old resource remains in the completion epoch", async () => {
  const f = await fixture();
  const before = await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
  const renew = (keys: string[]) => f.post("development-authority", { ...f.intent, resourceKeys: keys });
  const response = await renew([f.appRecord.key]); expect(response.status).toBe(200);
  const authority = await response.json(); expect(authority.resources.map((value: any) => value.id)).toEqual([f.appRecord.id]);
  for (const source of [f.mysql, f.spatial, f.old]) expect((await renew([source.key])).status).toBe(409);
  const complete = { ...f.intent, resourcesEpoch: authority.resourcesEpoch, resources: authority.resources };
  expect((await f.post("development-complete", complete)).status).toBe(200); expect((await f.post("development-complete", complete)).status).toBe(200);
  expect((await f.task()).developmentIntent.state).toBe("complete");
  expect(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  await db.prisma.remoteTaskResource.update({ where: { id: f.mysql.id }, data: { state: "allocated" } });
  expect((await f.task()).developmentIntent.state).toBe("pending");
  expect((await f.post("development-complete", complete)).status).toBe(409);
  expect((await (await renew([f.appRecord.key])).json()).resourcesEpoch).not.toBe(authority.resourcesEpoch);
});

test.each(["image", "alias", "released", "incomplete", "missing", "pin"])("retained development %s drift never falls back to generic source authority", async change => {
  const f = await fixture();
  if (change === "image") await db.prisma.remoteTaskResource.update({ where: { id: f.appRecord.id }, data: { metadata: { ...f.appRecord.metadata, image: "changed" } } });
  if (change === "alias") await db.prisma.remoteTaskResource.create({ data: { ...f.mysql, id: "alias-id", key: "alias", taskId: f.context.taskId } });
  if (change === "released") await db.prisma.remoteTaskResource.update({ where: { id: f.appRecord.id }, data: { state: "released" } });
  if (change === "incomplete") await f.file("transfer/transfer.json", { version: 1, phase: "copying", configHash: "f".repeat(64), completedAt: new Date().toISOString() });
  if (change === "missing") await rm(path.join(f.root, "app/app.json"));
  if (change === "pin") await db.prisma.remoteTask.update({ where: { id: f.context.taskId }, data: { toolingRevision: "b".repeat(40) } });
  expect((await f.post("development-authority", { ...f.intent, resourceKeys: [f.appRecord.key] })).status).toBe(409);
  expect((await f.post("development-authority", { ...f.intent, resourceKeys: [f.mysql.key] })).status).toBe(409);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-complete" } })).toBe(0);
  const task = await f.task(); expect(task.developmentIntent?.state).not.toBe("complete");
});

test.each(["development-state", "review-alias", "tooling-alias"].flatMap(change => ["renew", "complete"].map(operation => ({ change, operation }))))("local proof reads finish outside SQL and concurrent $change invalidates $operation", async ({ change, operation }) => {
  const f = await fixture(); let changed = false;
  const authority = await renewDevelopmentAuthority({ ...f.context, ...f.intent, resourceKeys: [f.appRecord.key] });
  const read: typeof readDevelopmentJson = async (file, hash) => {
    const value = await readDevelopmentJson(file, hash);
    if (!changed) {
      changed = true;
      if (change === "development-state") await db.prisma.remoteTaskResource.update({ where: { id: f.mysql.id }, data: { state: "allocated" } });
      else await db.prisma.remoteTaskResource.create({ data: { ...f.mysql, id: "late-alias", key: "late-alias", taskId: f.context.taskId, purpose: change === "review-alias" ? "review" : "tooling" } });
    }
    return value;
  };
  await expect(operation === "renew" ? renewDevelopmentAuthority({ ...f.context, ...f.intent, resourceKeys: [f.appRecord.key] }, read)
    : completeDevelopmentIntent({ ...f.context, ...f.intent, resourcesEpoch: authority.resourcesEpoch, resources: authority.resources }, read)).rejects.toThrow("selection changed");
  expect(changed).toBeTrue();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-complete" } })).toBe(0);
});

test("retained proof reader requires bounded private held bytes and exact hash without following links", async () => {
  const f = await fixture(), pin = await f.file("bounded.json", { original: true });
  expect(await readDevelopmentJson(pin.file, pin.sha256)).toEqual({ original: true });
  await expect(readDevelopmentJson(pin.file, "0".repeat(64))).rejects.toThrow("bytes changed");
  await chmod(pin.file, 0o644); await expect(readDevelopmentJson(pin.file)).rejects.toThrow("private"); await chmod(pin.file, 0o600);
  await symlink(pin.file, path.join(f.root, "link.json")); await expect(readDevelopmentJson(path.join(f.root, "link.json"))).rejects.toThrow();
  await writeFile(pin.file, Buffer.alloc(1024 * 1024 + 1)); await expect(readDevelopmentJson(pin.file)).rejects.toThrow("bounded");
});

const client = process.env.DRAFTED_DEVELOPMENT_INTEGRATION_ROOT;
test.skipIf(!client)("actual client selection and intent agree with server scope through stopped-app retry and saved resume", async () => {
  const f = await fixture(), original = await db.prisma.remoteTaskResource.findMany({ where: { id: { not: f.appRecord.id } }, orderBy: { id: "asc" } });
  const { retainedDevelopment: clientSelection } = await import(path.join(client!, "src/retained-development.ts"));
  const { readDevelopmentRecord } = await import(path.join(client!, "src/development-retained.ts"));
  const { taskRegistry } = await import(path.join(client!, "src/control.ts"));
  const { continueDevelopmentIntent } = await import(path.join(client!, "src/development-intent.ts"));
  const { manageResource } = await import(path.join(client!, "src/resources.ts"));
  const socket = path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `retained-intent-${crypto.randomUUID().slice(0, 8)}.sock`);
  const server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const registry = taskRegistry(socket, f.context.taskId), task = await registry.task();
    expect(await clientSelection(task, readDevelopmentRecord)).toEqual(await retainedDevelopment(task, readDevelopmentJson));
    let lost = false; const record = registry.resource;
    registry.resource = async (receipt: any) => { await record(receipt); if (!lost) { lost = true; throw new Error("Lost stopped acknowledgment"); } };
    const manage = async (input: any) => {
      expect(input.key).toBe(f.appRecord.key);
      if (input.action === "stop") return manageResource({ ...input, docker: f.docker });
      // The saved retained-app resume adapter has its own full physical/probe
      // fixture. This pair checks the actual intent/selection/receipt boundary.
      const selected = (await input.registry.task()).resources.find((value: any) => value.key === input.key);
      await f.docker.start(f.appRecord.externalId);
      await input.registry.resource({ key: selected.key, kind: selected.kind, purpose: selected.purpose, externalId: selected.externalId, metadata: selected.metadata, state: "ready" });
      return { key: selected.key, state: "ready" };
    };
    await expect(continueDevelopmentIntent(registry, manage, undefined, f.docker)).rejects.toThrow("Lost stopped acknowledgment");
    expect((await continueDevelopmentIntent(registry, manage, undefined, f.docker)).developmentIntent.state).toBe("complete");
    await recordDevelopmentIntent({ ...f.context, request: { action: "resume", development: true, requestKey: "resume-current-app" } });
    expect((await continueDevelopmentIntent(registry, manage, undefined, f.docker)).developmentIntent.state).toBe("complete");
    expect(f.effects).toEqual([`stop:${f.appRecord.externalId}`, `start:${f.appRecord.externalId}`]);
    expect(await db.prisma.remoteTaskResource.findMany({ where: { id: { not: f.appRecord.id } }, orderBy: { id: "asc" } })).toEqual(original);
    expect(f.actual.get(f.mysql.externalId)!.running).toBeFalse(); expect(f.actual.get(f.spatial.externalId)!.running).toBeFalse();
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(2);
  } finally { server.stop(true); }
});
