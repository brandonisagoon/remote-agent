import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../app.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../sessions/runtime-registry.ts";
import { beginTask } from "./store.ts";
import { LocalServiceStopAuthority, resolveLocalServiceStopAuthority } from "./local-service-stop-authority.ts";
import { recordDevelopmentIntent } from "./development-intent.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error("Fixture Git operation failed"); return result.stdout.toString().trim();
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "local-service-stop-authority-"))); cleanup.push(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const db = await createTestDatabase(); cleanup.push(db.cleanup); const { prisma } = db;
  const source = path.join(root, "tooling"), product = path.join(root, "product"); await mkdir(source); await mkdir(product);
  git(source, "init", "--quiet"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(source, "AGENTS.md"), "Original policy"); git(source, "add", "."); git(source, "commit", "--quiet", "-m", "Original policy"); const originalRevision = git(source, "rev-parse", "HEAD");
  await writeFile(path.join(source, "cleanup.md"), "Exact browser compute stop only");
  await writeFile(path.join(source, "adapter.ts"), "throw new Error('Authority resolution must never execute an adapter');\n");
  await writeFile(path.join(source, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { cleanup: { instructions: "cleanup.md", adapter: "adapter.ts" } } }));
  git(source, "add", "."); git(source, "commit", "--quiet", "-m", "Configured cleanup"); const revision = git(source, "rev-parse", "HEAD");
  const config = testConfig({ installRoot: path.join(root, "install") });
  const repository = { ...config.repository, root: product, tooling: { root: source, revision: originalRevision } };
  const task = await beginTask(prisma, { requestKey: "task", repository, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-42", branchName: "codex/original" });
  const session = await beginRuntimeSession(prisma, { sessionKey: "primary", agent: "codex", cwd: product, role: "primary", repositoryId: repository.id, machineId: config.machine,
    resourceLinks: [{ provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-42", relationship: "handles" }] });
  await prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "active" } });
  await prisma.remoteTask.update({ where: { id: task.id }, data: { primarySessionId: session.id, worktreePath: product, pinnedToolingRoot: path.join(root, "old-policy"), phase: "waiting" } });
  repository.tooling.revision = revision; config.repository = repository; config.repositories = { [repository.id]: repository };
  const checkout = path.join(config.installRoot, "tooling", repository.id, revision); await mkdir(path.dirname(checkout), { recursive: true });
  git(source, "worktree", "add", "--detach", checkout, revision); await writeFile(`${checkout}.ready`, `${revision}\n`);
  const environment = path.join(root, task.id), profile = path.join(environment, "api.pid"); await mkdir(environment, { mode: 0o700 });
  const resource = await prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "dev-api", kind: "local-http", purpose: "development", externalId: "http://localhost:19801", state: "allocated",
    metadata: { start: "run.sh api", pidFile: profile } } });
  await prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "dev-compose", kind: "docker-compose-project", purpose: "development", externalId: `drafted-${task.id}-development`, state: "ready", metadata: { composeFile: path.join(environment, "compose.yml") } } });
  const runtime = createFakeAgentRuntime([{ ...session, status: "active" }]); let requestId = "original-request";
  runtime.observeSessionActivity = () => ({ state: "executing", requestId, observedAt: Date.now() });
  const event = (phase = "started", request = requestId) => prisma.runtimeLifecycleEvent.create({ data: { id: randomUUID(), runtimeSessionId: session.id, requestId: request, phase, occurredAt: new Date() } });
  await event();
  const input = { prisma, config, runtime, sessionId: session.id, key: resource.key };
  const capability = { version: 1 as const, source: "configured-host" as const, checkout, revision, adapter: path.join(checkout, "adapter.ts"), adapterSha256: hash(await readFile(path.join(checkout, "adapter.ts"))) };
  const resolve = async () => capability;
  const app = createApp({ config, prisma, agentRuntime: runtime });
  const request = (body: unknown, sessionId = session.id) => app.request(`/api/sessions/${sessionId}/local-service-stop-authority`, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { root, prisma, config, runtime, task, session, resource, profile, input, capability, resolve, event, request, setRequest: (next: string) => { requestId = next; } };
}

test("real local service stop route resolves configured code without altering original receipts, pins or source state", async () => {
  const f = await fixture(), taskBefore = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  const first = await f.request({ key: f.resource.key }); expect(first.status).toBe(200);
  const authority = LocalServiceStopAuthority.parse(await first.json()); expect(authority.capability).toEqual(f.capability); expect(authority.turn!.requestId).toBe("original-request");
  expect(authority.task.toolingRevision).toBe(f.task.toolingRevision); expect(authority.capability.revision).not.toBe(f.task.toolingRevision);
  expect(await (await f.request({ key: f.resource.key })).json()).toEqual(authority);
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(taskBefore);
  expect(await f.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
  expect(await f.prisma.runtimeMetadataEvent.count()).toBe(0); expect(await f.prisma.runtimeInstruction.count()).toBe(0);
  expect((await f.request({ key: f.resource.key, capability: f.capability })).status).toBe(400);
}, 30_000);

test.each(["pause", "closed", "delegate", "wrong-cwd", "wrong-machine", "released", "source-revoked", "wrong-session", "process-description", "ended-turn", "unknown-runtime"])("local service stop refuses %s before capability resolution", async changed => {
  const f = await fixture(); let resolved = false;
  if (changed === "pause") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (changed === "closed") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  if (changed === "delegate") await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  if (changed === "wrong-cwd") await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: path.join(f.root, "other") } });
  if (changed === "wrong-machine") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { machineId: "another-host" } });
  if (changed === "released") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "released" } });
  if (changed === "source-revoked") await f.prisma.runtimeSessionResourceLink.updateMany({ data: { endedAt: new Date() } });
  if (changed === "process-description") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { kind: "local-process", externalId: "task PostHog process" } });
  if (changed === "wrong-session") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), start: "run.sh another" } } });
  if (changed === "ended-turn") await f.event("completed");
  if (changed === "unknown-runtime") f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await expect(resolveLocalServiceStopAuthority(f.input, async () => { resolved = true; return f.capability; })).rejects.toThrow(); expect(resolved).toBeFalse();
});

test.each(["pause", "turn", "pin", "resource", "shared-parent"])("local service stop rechecks %s after resolving immutable code", async changed => {
  const f = await fixture();
  await expect(resolveLocalServiceStopAuthority(f.input, async () => {
    if (changed === "pause") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (changed === "turn") { f.setRequest("later-request"); await f.event(); }
    if (changed === "pin") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: path.join(f.root, "different-pin") } });
    if (changed === "resource") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), start: "run.sh web" } } });
    if (changed === "shared-parent") {
      const other = await beginTask(f.prisma, { requestKey: "other", repository: f.config.repository, machineId: f.config.machine, branchName: "codex/other" });
      await f.prisma.remoteTaskResource.create({ data: { taskId: other.id, key: "shared", kind: "docker-compose-project", purpose: "development", externalId: "another-project", state: "ready", metadata: { composeFile: path.join(path.dirname(f.profile), "compose.yml") } } });
    }
    return f.capability;
  })).rejects.toThrow();
});

test("local service stop distinguishes a later turn and a new started event with the same request ID", async () => {
  const f = await fixture(), first = await resolveLocalServiceStopAuthority(f.input, f.resolve); await f.event();
  const replay = await resolveLocalServiceStopAuthority(f.input, f.resolve); expect(replay.turn!.requestId).toBe(first.turn!.requestId); expect(replay.turn!.lifecycleRevision).toBeGreaterThan(first.turn!.lifecycleRevision);
  f.setRequest("later-request"); await expect(resolveLocalServiceStopAuthority(f.input, f.resolve)).rejects.toThrow("executing"); await f.event();
  const later = await resolveLocalServiceStopAuthority(f.input, f.resolve); expect(later.turn!.requestId).toBe("later-request");
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot || process.platform !== "darwin")("actual control socket stops old task apps independently before adoption and preserves all stores", async () => {
  const f = await fixture();
  const { localServiceFixture } = await import(path.join(draftedRoot!, "test/fixtures/local-service-stop.ts"));
  const { manageResource } = await import(path.join(draftedRoot!, "src/resources.ts"));
  const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
  const service = await localServiceFixture({ taskId: f.task.id }); cleanup.push(service.cleanup);
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { worktreePath: service.checkout } });
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: service.checkout } });
  await f.prisma.remoteTaskResource.deleteMany({ where: { taskId: f.task.id } });
  for (const resource of service.task.resources) await f.prisma.remoteTaskResource.create({ data: { ...resource, taskId: f.task.id } });
  const before = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  const socket = `/private/tmp/service-${randomUUID().slice(0, 8)}.sock`, app = createApp({ config: f.config, prisma: f.prisma, agentRuntime: f.runtime, trustLocal: true });
  const server = Bun.serve({ unix: socket, fetch: app.fetch }); await chmod(socket, 0o600); cleanup.push(async () => { await server.stop(true); });
  const registry = taskRegistry(socket, f.task.id);
  const run = (role: string) => manageResource({ registry, key: `dev-${role}`, action: "stop", serviceStop: { ...service.observation, assertCapability: async (value: unknown) => { expect(value).toEqual(f.capability); } } });
  await run("api"); expect(service.effects).toEqual([service.children.api.pid]);
  for (const role of ["web", "posthog"]) expect(await (await fetch(service.task.resources.find((resource: { key: string }) => resource.key === `dev-${role}`).externalId)).text()).toBe(role);
  await run("api"); await run("web"); await run("posthog");
  expect(new Set(service.effects).size).toBe(3); expect(await service.readSaved()).toBe('{"saved":"unchanged"}');
  const records = await f.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id } });
  expect(records).toHaveLength(4); expect(records.every(record => record.state !== "released")).toBeTrue();
  expect(await f.prisma.runtimeMetadataEvent.count()).toBe(0); expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(before);
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(run("api")).rejects.toThrow(); expect(service.effects).toHaveLength(3);
}, 30_000);



test("local service witness binds the original private pin between otherwise identical successful requests", async () => {
  const f = await fixture(), first = LocalServiceStopAuthority.parse(await (await f.request({ key: f.resource.key })).json());
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: path.join(f.root, "changed-private-pin") } });
  const second = LocalServiceStopAuthority.parse(await (await f.request({ key: f.resource.key })).json());
  expect(second.task).toEqual(first.task); expect(second.turn).toEqual(first.turn); expect(second.resource).toEqual(first.resource);
  expect(second.authorityDigest).not.toBe(first.authorityDigest);
});

test("saved owner-pause intent permits exact older service stop after cancellation settles without inventing a live turn", async () => {
  const f = await fixture();
  const development = await recordDevelopmentIntent({ prisma: f.prisma, config: f.config, taskId: f.task.id, request: { action: "pause", development: true, requestKey: "pause-development" } });
  await expect(resolveLocalServiceStopAuthority({ ...f.input, development }, f.resolve)).rejects.toThrow("settle");
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "idle" } });
  f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  const before = await f.prisma.remoteTaskResource.findMany();
  const receipt = await resolveLocalServiceStopAuthority({ ...f.input, development }, f.resolve);
  expect(receipt.development).toEqual(development); expect(receipt.turn).toBeUndefined();
  expect(receipt.resource.id).toBe(f.resource.id); expect(receipt.capability).toEqual(f.capability);
  await expect(resolveLocalServiceStopAuthority(f.input, f.resolve)).rejects.toThrow();
  await recordDevelopmentIntent({ prisma: f.prisma, config: f.config, taskId: f.task.id, request: { action: "resume", development: true, requestKey: "resume-development" } });
  await expect(resolveLocalServiceStopAuthority({ ...f.input, development }, f.resolve)).rejects.toThrow("changed");
  expect(await f.prisma.remoteTaskResource.findMany()).toEqual(before);
});

test.skipIf(!draftedRoot || process.platform !== "darwin")("actual paused development intent finishes an interrupted older process family and preserves its saved data", async () => {
  const f = await fixture();
  const { localServiceFixture } = await import(path.join(draftedRoot!, "test/fixtures/local-service-stop.ts"));
  const { continueDevelopmentIntent } = await import(path.join(draftedRoot!, "src/development-intent.ts"));
  const { manageResource } = await import(path.join(draftedRoot!, "src/resources.ts"));
  const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
  const service = await localServiceFixture({ taskId: f.task.id }); cleanup.push(service.cleanup);
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { worktreePath: service.checkout } });
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: service.checkout, status: "idle" } });
  f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await f.prisma.remoteTaskResource.deleteMany({ where: { taskId: f.task.id } });
  for (const resource of service.task.resources) await f.prisma.remoteTaskResource.create({ data: { ...resource, taskId: f.task.id } });
  await recordDevelopmentIntent({ prisma: f.prisma, config: f.config, taskId: f.task.id, request: { action: "pause", development: true, requestKey: "pause-services" } });
  const socket = `/private/tmp/development-${randomUUID().slice(0, 8)}.sock`, app = createApp({ config: f.config, prisma: f.prisma, agentRuntime: f.runtime, trustLocal: true });
  const server = Bun.serve({ unix: socket, fetch: app.fetch }); await chmod(socket, 0o600); cleanup.push(async () => { await server.stop(true); });
  const registry = taskRegistry(socket, f.task.id); let interrupted = false;
  const manage = (input: any) => manageResource({ ...input, serviceStop: { ...service.observation,
    assertCapability: async (value: unknown) => { expect(value).toEqual(f.capability); },
    afterSignal: async () => { if (!interrupted) { interrupted = true; throw new Error("Interrupted after one exact process stop"); } },
  } });
  await expect(continueDevelopmentIntent(registry, manage)).rejects.toThrow("Interrupted after one exact process stop");
  expect(service.effects).toHaveLength(1); expect((await registry.task()).ownerPaused).toBeTrue();
  await continueDevelopmentIntent(registry, manage); await continueDevelopmentIntent(registry, manage);
  expect(new Set(service.effects).size).toBe(3); expect(service.effects).toHaveLength(3);
  expect((await registry.task()).developmentIntent.state).toBe("complete"); expect((await registry.task()).ownerPaused).toBeTrue();
  expect(await service.readSaved()).toBe('{"saved":"unchanged"}');
  expect(await f.prisma.remoteTaskResource.count({ where: { state: "released" } })).toBe(0);
  await recordDevelopmentIntent({ prisma: f.prisma, config: f.config, taskId: f.task.id, request: { action: "resume", development: true, requestKey: "resume-services" } });
  await expect(continueDevelopmentIntent(registry, manage)).rejects.toThrow("no verified saved resume adapter");
  expect((await registry.task()).developmentIntent.state).toBe("pending"); expect(service.effects).toHaveLength(3);
}, 30_000);
