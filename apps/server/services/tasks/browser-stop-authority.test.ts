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
import { BrowserStopAuthority, resolveBrowserStopAuthority } from "./browser-stop-authority.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error("Fixture Git operation failed"); return result.stdout.toString().trim();
}
async function fixture(review = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "browser-stop-authority-"))); cleanup.push(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
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
  const profileRoot = path.join(root, "browser"), profile = path.join(profileRoot, "profile"), ownerFile = path.join(profileRoot, "profile-owner.json");
  await mkdir(profile, { recursive: true, mode: 0o700 }); await chmod(profileRoot, 0o700); await writeFile(path.join(profile, "Cookies"), "private opaque cookies", { mode: 0o600 });
  const browserSession = `${task.id}${review ? "-review" : ""}`, bytes = JSON.stringify({ taskId: task.id, profile, nonce: randomUUID(), session: browserSession }); await writeFile(ownerFile, bytes, { mode: 0o600 });
  const resource = await prisma.remoteTaskResource.create({ data: { taskId: task.id, key: review ? "browser-profile:review" : "browser-profile", kind: "browser-profile", purpose: review ? "review" : "browser", externalId: profile, state: "ready",
    metadata: { namespace: "drafted", session: browserSession, ownerFile, ownerSha256: hash(bytes), toolingRoot: path.join(root, "old-metadata-must-not-execute") } } });
  const runtime = createFakeAgentRuntime([{ ...session, status: "active" }]); let requestId = "original-request";
  runtime.observeSessionActivity = () => ({ state: "executing", requestId, observedAt: Date.now() });
  const event = (phase = "started", request = requestId) => prisma.runtimeLifecycleEvent.create({ data: { id: randomUUID(), runtimeSessionId: session.id, requestId: request, phase, occurredAt: new Date() } });
  await event();
  const input = { prisma, config, runtime, sessionId: session.id, key: resource.key };
  const capability = { version: 1 as const, source: "configured-host" as const, checkout, revision, adapter: path.join(checkout, "adapter.ts"), adapterSha256: hash(await readFile(path.join(checkout, "adapter.ts"))) };
  const resolve = async () => capability;
  const app = createApp({ config, prisma, agentRuntime: runtime });
  const request = (body: unknown, sessionId = session.id) => app.request(`/api/sessions/${sessionId}/browser-stop-authority`, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { root, prisma, config, runtime, task, session, resource, profile, ownerFile, input, capability, resolve, event, request, browserSession, setRequest: (next: string) => { requestId = next; } };
}

test("real browser stop route resolves configured code without altering original receipts, pins or source state", async () => {
  const f = await fixture(), taskBefore = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  const first = await f.request({ key: f.resource.key }); expect(first.status).toBe(200);
  const authority = BrowserStopAuthority.parse(await first.json()); expect(authority.capability).toEqual(f.capability); expect(authority.turn.requestId).toBe("original-request");
  expect(authority.task.toolingRevision).toBe(f.task.toolingRevision); expect(authority.capability.revision).not.toBe(f.task.toolingRevision);
  expect(await (await f.request({ key: f.resource.key })).json()).toEqual(authority);
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(taskBefore);
  expect(await f.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
  expect(await f.prisma.runtimeMetadataEvent.count()).toBe(0); expect(await f.prisma.runtimeInstruction.count()).toBe(0);
  expect((await f.request({ key: f.resource.key, capability: f.capability })).status).toBe(400);
}, 30_000);

test.each(["pause", "closed", "delegate", "wrong-cwd", "wrong-machine", "released", "source-revoked", "wrong-session", "ended-turn", "unknown-runtime"])("browser stop refuses %s before capability resolution", async changed => {
  const f = await fixture(); let resolved = false;
  if (changed === "pause") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (changed === "closed") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  if (changed === "delegate") await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  if (changed === "wrong-cwd") await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { cwd: path.join(f.root, "other") } });
  if (changed === "wrong-machine") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { machineId: "another-host" } });
  if (changed === "released") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "released" } });
  if (changed === "source-revoked") await f.prisma.runtimeSessionResourceLink.updateMany({ data: { endedAt: new Date() } });
  if (changed === "wrong-session") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), session: "another-task" } } });
  if (changed === "ended-turn") await f.event("completed");
  if (changed === "unknown-runtime") f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await expect(resolveBrowserStopAuthority(f.input, async () => { resolved = true; return f.capability; })).rejects.toThrow(); expect(resolved).toBeFalse();
});

test.each(["pause", "turn", "pin", "resource", "shared-parent"])("browser stop rechecks %s after resolving immutable code", async changed => {
  const f = await fixture();
  await expect(resolveBrowserStopAuthority(f.input, async () => {
    if (changed === "pause") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (changed === "turn") { f.setRequest("later-request"); await f.event(); }
    if (changed === "pin") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: path.join(f.root, "different-pin") } });
    if (changed === "resource") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), ownerSha256: "d".repeat(64) } } });
    if (changed === "shared-parent") {
      const other = await beginTask(f.prisma, { requestKey: "other", repository: f.config.repository, machineId: f.config.machine, branchName: "codex/other" });
      await f.prisma.remoteTaskResource.create({ data: { taskId: other.id, key: "shared", kind: "directory", purpose: "development", externalId: path.dirname(f.profile), state: "ready" } });
    }
    return f.capability;
  })).rejects.toThrow();
});

test("browser stop distinguishes a later turn and a new started event with the same request ID", async () => {
  const f = await fixture(), first = await resolveBrowserStopAuthority(f.input, f.resolve); await f.event();
  const replay = await resolveBrowserStopAuthority(f.input, f.resolve); expect(replay.turn.requestId).toBe(first.turn.requestId); expect(replay.turn.lifecycleRevision).toBeGreaterThan(first.turn.lifecycleRevision);
  f.setRequest("later-request"); await expect(resolveBrowserStopAuthority(f.input, f.resolve)).rejects.toThrow("executing"); await f.event();
  const later = await resolveBrowserStopAuthority(f.input, f.resolve); expect(later.turn.requestId).toBe("later-request");
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot).each([false, true])("actual client resource-stop consumes fresh server authority and preserves browser files (review=%s)", async review => {
  const f = await fixture(review), { manageResource } = await import(path.join(draftedRoot!, "src/resources.ts"));
  const { TaskRecord } = await import(path.join(draftedRoot!, "src/control.ts"));
  const before = await lstat(f.profile), cookie = await readFile(path.join(f.profile, "Cookies")), marker = await readFile(f.ownerFile); let running = true; const closes: string[] = [];
  const registry = { task: async () => {
    const task = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id }, include: { resources: true } });
    return TaskRecord.parse({ ...task, resources: task.resources.map(resource => ({ ...resource, expiresAt: resource.expiresAt?.toISOString() ?? null })) });
  }, browserStopAuthority: async (input: { key: string }) => { const response = await f.request(input); if (response.status !== 200) throw new Error("Browser authority refused"); return response.json(); }, resource: async () => { throw new Error("Stop must not write resource state"); } };
  const provider = { sessions: async () => running ? [f.browserSession, "unrelated-session"] : ["unrelated-session"], close: async (session: string) => { closes.push(session); running = false; }, assertCapability: async (capability: unknown) => { expect(capability).toEqual(f.capability); } };
  const run = () => manageResource({ registry, key: f.resource.key, action: "stop", browser: provider });
  expect(await run()).toMatchObject({ state: "ready", observed: "browser-stopped-profile-retained" }); await run(); expect(closes).toEqual([f.browserSession]);
  expect((await lstat(f.profile)).ino).toBe(before.ino); expect(await readFile(path.join(f.profile, "Cookies"))).toEqual(cookie); expect(await readFile(f.ownerFile)).toEqual(marker);
  expect(await f.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
}, 30_000);
