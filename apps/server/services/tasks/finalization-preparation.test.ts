import { acquireRuntimeOwnership } from "../sessions/runtime-owner.ts";
import { startRuntimeEventProjection } from "../sessions/runtime-events/projection.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { prepareTaskFinalization, confirmTaskFinalization } from "./finalization.ts";
import { preparationJournalWorker, requestFinalizationPreparation } from "./finalization-preparation.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { taskRoutes } from "../../routes/tasks/index.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { preparationStage } from "./preparation-diagnostics.ts";
import { PreparationDiagnosticError } from "./preparation-errors.ts";
import { cleanupObserverFixture, existingCleanupObserverFixture } from "../../../../test-support/cleanup-observer.ts";
import { runCleanupResourceObserver } from "./cleanup-resource-observer.ts";
let db: TestDatabase, directory: string;
let worker: ReturnType<typeof preparationJournalWorker> | undefined;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "prep-"))); });
afterEach(async () => { await worker?.stop(); worker = undefined; await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
const attempt = (boundary = "initial") => ({ version: 1 as const, attemptId: randomUUID(), boundary });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  git(root, "worktree", "add", "-b", "codex/task", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: directory, toolingRevision: "a".repeat(40), phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Blocked", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", branchName: "codex/task", title: "Task", description: "Request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const context = { prisma: db.prisma, config, taskId: task.id };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "owner-verified", passed: true, evidence: ["Owner accepted verified content"] } });
  const head = git(worktree, "rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const observer = { ...completionObservation, remote: async () => remote };
  const input = { prisma: db.prisma, config, sessionId: session.id, requestKey: "finalize:task" };
  const dependencies = { source: async () => ({ session, link, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, observer), snapshot: completionObservation.snapshot };
  const remove = () => git(root, "worktree", "remove", worktree);
  const revoke = () => setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "revoke", expectedRevision: contract.revision, boundary: "revoked", basis: "Owner withdrew delivery" }) });
  return { root, worktree, config, session, task, issue, states, context, contract, remote, observer, input, dependencies, remove, revoke };
}

async function preparedFixture() {
  const f = await fixture();
  await db.prisma.remoteTaskResource.create({ data: { id: "volume", taskId: f.task.id, key: "data", kind: "docker-volume", purpose: "development", externalId: "exact-owned-volume", state: "ready", metadata: { taskId: f.task.id } } });
  const prepared = await prepareTaskFinalization(f.input, f.dependencies);
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const observe = async () => { expect(await completionObservation.snapshot(f.worktree)).toEqual(JSON.parse(frozen.find(row => row.sequence === prepared.preparedRevision)!.value!).delivery.receipts.snapshot); };
  return { ...f, prepared, frozen, observe };
}


function controls(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = createFakeAgentRuntime();
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: runtime, commandClient: bunCommandClient })).route("/api/tasks", taskRoutes);
  const input = { ...f.input, runtime, cleanup: true as const };
  const post = (preparation?: ReturnType<typeof attempt>) => app.request(`/api/tasks/${f.task.id}/prepare-finalization`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: input.requestKey, cleanup: true, ...(preparation ? { preparation } : {}) }) });
  return { input, runtime, app, post };
}

test("async preparation persists and replays the safe real-process observer failure without authority", async () => {
  const f = await fixture(), c = controls(f), attemptInput = attempt();
  const resource = { id: "container", key: "saved-container", kind: "docker-container", purpose: "development", externalId: "c".repeat(64), state: "ready", expiresAt: null, metadata: { original: "private-record" } };
  await db.prisma.remoteTaskResource.create({ data: { ...resource, taskId: f.task.id } });
  const original = await db.prisma.remoteTaskResource.findMany();
  const capability = await cleanupObserverFixture(directory, `const input=JSON.parse(await Bun.stdin.text()); const r=input.resource; console.error(JSON.stringify({version:1,type:"cleanup-observer-failure",stage:"resource",code:"provider-forbidden",resource:{id:r.id,key:r.key,kind:r.kind,adapter:"docker"}})); process.exit(1);`);
  const request = { version: 1, task: { id: f.task.id, primarySessionId: f.session.id, worktreePath: f.worktree, toolingRevision: f.task.toolingRevision }, resources: [resource], resource, stage: "prepare" };
  expect((await c.post(attemptInput)).status).toBe(202);
  worker = preparationJournalWorker(c.input, () => preparationStage("resource-plan", async () => { await runCleanupResourceObserver({ capability, request }); throw new Error("Failed observer must never return"); }));
  worker.tick(); await worker.idle();
  const progress = await (await c.post(attemptInput)).json();
  expect(progress.preparation).toMatchObject({ state: "failed", stage: "resource-plan" });
  expect(progress.preparation.error).toContain("[OBSERVER_PROVIDER_FORBIDDEN]");
  expect(progress.preparation.error).toContain("saved-container (docker-container/docker)");
  expect(progress.receipt).toBeUndefined();
  const events = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "finalization-preparation-status" }, orderBy: { sequence: "asc" } });
  const failed = JSON.parse(events.at(-1)!.value!);
  expect(failed.diagnostic.code).toBe("OBSERVER_PROVIDER_FORBIDDEN");
  expect(failed.error).toBe(progress.preparation.error);
  expect(JSON.stringify(events)).not.toMatch(/private-record|observer\/adapter/);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: ["finalization-prepared", "finalization-confirmed", "finalization-cleanup-started"] } } })).toBe(0);
  expect(await db.prisma.remoteTaskResource.findMany()).toEqual(original);
  await worker.stop();
  worker = preparationJournalWorker(c.input, async () => { throw new Error("Failed attempt cannot rerun after restart"); });
  worker.tick(); await worker.idle();
  expect((await (await c.post(attemptInput)).json()).preparation).toMatchObject({ acceptedRevision: progress.preparation.acceptedRevision, state: "failed", stage: "resource-plan", error: progress.preparation.error });
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual pinned Drafted third-resource failure crosses the subprocess and async journal without partial proof", async () => {
  const f = await fixture(), c = controls(f), capability = await existingCleanupObserverFixture(process.env.DRAFTED_INTEGRATION_ROOT!);
  const selected = ["first", "second", "development-tunnel"].map((key, index) => ({ id: `resource-${index}`, key, kind: index === 2 ? "cloudflare-tunnel" : "docker-container", purpose: "development", state: "ready", expiresAt: null,
    externalId: index === 2 ? "original-tunnel" : String(index + 1).repeat(64), metadata: index === 2 ? { tunnelId: "11111111-2222-3333-4444-555555555555", ingress: "private.invalid -> http://127.0.0.1:19913", configPath: "/private/not-read.yml" } : {} }));
  for (const resource of selected) await db.prisma.remoteTaskResource.create({ data: { ...resource, taskId: f.task.id } });
  const before = await db.prisma.remoteTaskResource.findMany();
  const bin = path.join(directory, "bin"), log = path.join(directory, "docker-calls.jsonl"); await mkdir(bin);
  // Real CLI/transport with a disposable command boundary. Nothing can invoke
  // host Docker or a provider: only the two exact read-only list calls exist.
  await writeFile(path.join(bin, "docker"), `#!${process.execPath}\nimport {appendFileSync} from "node:fs"; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n"); if(JSON.stringify(args)!==JSON.stringify(["container","ls","-aq","--no-trunc"])) process.exit(9);`, { mode: 0o700 });
  const request = { version: 1, task: { id: f.task.id, primarySessionId: f.session.id, worktreePath: f.worktree, toolingRevision: f.task.toolingRevision }, resources: selected, stage: "prepare", observations: selected.map(resource => ({ resourceId: resource.id })) };
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    await expect(runCleanupResourceObserver({ capability, request })).rejects.toThrow("[OBSERVER_PREVIEW_BINDING_MISSING]");
    expect((await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual(Array(2).fill(["container", "ls", "-aq", "--no-trunc"]));
    const pending = attempt(); expect((await c.post(pending)).status).toBe(202);
    worker = preparationJournalWorker(c.input, () => preparationStage("resource-plan", async () => { await runCleanupResourceObserver({ capability, request }); throw new Error("No partial observer success allowed"); }));
    worker.tick(); await worker.idle();
    const result = await (await c.post(pending)).json();
    expect(result.preparation).toMatchObject({ state: "failed", stage: "resource-plan" });
    expect(result.preparation.error).toContain("[OBSERVER_PREVIEW_BINDING_MISSING]");
    expect(result.preparation.error).toContain("development-tunnel (cloudflare-tunnel/preview)");
    expect(result.preparation.error).not.toMatch(/private.invalid|not-read|11111111/);
    expect(result.receipt).toBeUndefined();
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(4);
    expect(await db.prisma.remoteTaskResource.findMany()).toEqual(before);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: ["finalization-prepared", "finalization-confirmed", "finalization-cleanup-started"] } } })).toBe(0);
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
});

test.each([false, true])("failed journal and progress preserve the exact safe nested diagnostic (nested=%s) without authority", async nested => {
  const f = await fixture(), c = controls(f), input = c.input, request = attempt();
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "saved", kind: "docker-volume", purpose: "development", externalId: "saved", state: "ready" } });
  const original = await db.prisma.remoteTaskResource.findMany();
  expect((await c.post(request)).status).toBe(202);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), resumed = new Promise<void>(resolve => release = resolve);
  worker = preparationJournalWorker(input, () => preparationStage("delivery", async () => {
    await preparationStage("fingerprint", async () => { if (nested) throw Object.assign(new Error("private path /Users/owner/secret and Bearer value"), { code: "ENOENT" }); });
    entered(); await resumed;
    throw new PreparationDiagnosticError("PR_NOT_FOUND");
  }));
  worker.tick();
  if (!nested) {
    try {
      await waiting;
      const running = await (await c.post(request)).json();
      expect(running.preparation).toMatchObject({ state: "running", stage: "delivery" });
      expect(running.receipt).toBeUndefined();
    } finally { release(); }
  }
  await worker.idle();
  const result = await (await c.post(request)).json();
  expect(result.preparation).toMatchObject({ state: "failed", stage: nested ? "fingerprint" : "delivery" });
  const rows = (await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "finalization-preparation-status" }, orderBy: { sequence: "asc" } })).map(row => JSON.parse(row.value!));
  const failed = rows.at(-1);
  expect(failed.diagnostic.code).toBe(nested ? "ENOENT" : "PR_NOT_FOUND");
  expect(result.preparation.error).toBe(failed.error);
  expect(result.preparation.error).toContain(failed.diagnostic.reason);
  expect(JSON.stringify(rows)).not.toMatch(/Bearer|\/Users\/owner|secret/);
  expect(rows.filter(row => row.event === "end" && ["delivery", "verification"].includes(row.stage)).every(row => row.outcome === "failed")).toBe(true);
  expect(result.receipt).toBeUndefined();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(0);
  expect(await db.prisma.remoteTaskResource.findMany()).toEqual(original);
  const { assertPreparedCleanup } = await import("./cleanup-lifecycle.ts");
  await expect(assertPreparedCleanup(input)).rejects.toThrow();
  await worker.stop();
  worker = preparationJournalWorker(input, async () => { throw new Error("failed attempts cannot rerun"); });
  worker.tick(); await worker.idle();
  expect((await (await c.post(request)).json()).preparation.error).toBe(failed.error);
});

test("lost acceptance joins one durable scan, old synchronous callers are busy, and ready replay preserves original receipts", async () => {
  const f = await preparedFixture(), c = controls(f), request = attempt();
  const before = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } });
  const accepted = await c.post(request); expect(accepted.status).toBe(202);
  const first = await accepted.json();
  const lostRetry = await (await c.post(request)).json(); expect(lostRetry.preparation.acceptedRevision).toBe(first.preparation.acceptedRevision);
  let runs = 0, release!: () => void;
  const wait = new Promise<void>(resolve => release = resolve);
  worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, async input => { runs++; await wait; return prepareTaskFinalization(input, f.dependencies); });
  worker.tick(); await Bun.sleep(30);
  expect((await c.post()).status).toBe(409);
  const joined = await (await c.post(attempt())).json(); expect(joined.preparation.acceptedRevision).toBe(first.preparation.acceptedRevision);
  worker.tick(); expect(runs).toBe(1);
  release(); await worker.idle();
  const ready = await (await c.post(request)).json(); expect(ready.preparation.state).toBe("ready");
  expect(ready.receipt.preparedRevision).toBe(f.prepared.preparedRevision);
  expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: before.sequence } })).toEqual(before);
  await worker.stop(); worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, async () => { throw new Error("completed scans must not run after restart"); });
  worker.tick(); await worker.idle();
  expect((await (await c.post(request)).json()).receipt).toEqual(ready.receipt);
  expect(runs).toBe(1);
});

test("a new full boundary rechecks changed bytes instead of replaying a completed physical scan", async () => {
  const f = await preparedFixture(), c = controls(f), initial = attempt();
  let runs = 0;
  worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, input => { runs++; return prepareTaskFinalization(input, f.dependencies); });
  await c.post(initial); worker.tick(); await worker.idle();
  expect((await (await c.post(initial)).json()).preparation.state).toBe("ready");
  await writeFile(path.join(f.worktree, "README.md"), "later owner content");
  const next = attempt("worktree-removal");
  expect((await c.post(next)).status).toBe(202); worker.tick(); await worker.idle();
  const failed = await (await c.post(next)).json(); expect(failed.preparation.state).toBe("failed"); expect(failed.receipt).toBeUndefined();
  expect(runs).toBe(2); expect(await Bun.file(path.join(f.worktree, "README.md")).text()).toBe("later owner content");
  expect((await c.post({ ...initial, boundary: "worktree-removal" })).status).toBe(409);
});

test.each(["pause", "revoke", "pin", "turn"] as const)("%s during verification prevents ready authority, including retry after restart", async change => {
  const f = await preparedFixture(), c = controls(f), request = attempt();
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: f.session.id, requestId: "turn", phase: "started", occurredAt: new Date() } });
  await c.post(request);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => enter = resolve), wait = new Promise<void>(resolve => release = resolve);
  worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, async input => { const result = await prepareTaskFinalization(input, f.dependencies); enter(); await wait; return result; });
  worker.tick(); await entered;
  if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (change === "revoke") await f.revoke();
  if (change === "pin") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "b".repeat(40) } });
  if (change === "turn") await db.prisma.runtimeLifecycleEvent.create({ data: { id: "completed", runtimeSessionId: f.session.id, requestId: "turn", phase: "completed", occurredAt: new Date() } });
  release(); await worker.idle(); await worker.stop();
  worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, async () => { throw new Error("failed attempt cannot restart automatically"); }); worker.tick(); await worker.idle();
  expect((await c.post(request)).status).toBe(409);
  const statuses = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "finalization-preparation-status" } });
  expect(statuses.some(row => JSON.parse(row.value!).state === "ready")).toBe(false);
  expect(JSON.parse(statuses.at(-1)!.value!).state).toBe("failed");
});

test("a queued request survives service restart under its exact original turn", async () => {
  const f = await preparedFixture(), c = controls(f), request = attempt();
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: f.session.id, requestId: "turn", phase: "started", occurredAt: new Date() } });
  const accepted = await (await c.post(request)).json();
  await db.prisma.$disconnect();
  worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, input => prepareTaskFinalization(input, f.dependencies));
  worker.tick(); await worker.idle();
  const replay = await (await c.post(request)).json();
  expect(replay.preparation.acceptedRevision).toBe(accepted.preparation.acceptedRevision); expect(replay.preparation.state).toBe("ready");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
});

test("the existing projection worker serves real control requests while two 16-second fingerprints finish once", async () => {
  const f = await preparedFixture(), c = controls(f), request = attempt(); let hashes = 0, projections = 0;
  const slow = { ...f.dependencies, snapshot: async (root: string) => { hashes++; await Bun.sleep(16_000); return f.dependencies.snapshot(root); } };
  c.app.get("/health", context => context.json({ ok: true }));
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: c.app.fetch });
  const post = () => fetch(`http://local/api/tasks/${f.task.id}/prepare-finalization`, { unix: socket, method: "POST", signal: AbortSignal.timeout(1000), headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: c.input.requestKey, cleanup: true, preparation: request }) } as RequestInit & { unix: string });
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = performance.now(), first = await post(); expect(first.status).toBe(202); expect(performance.now() - started).toBeLessThan(1000);
    const accepted = await first.json();
    stop = startRuntimeEventProjection({ ...c.input, runtime: c.runtime }, async () => { projections++; }, { prepareFinalization: input => prepareTaskFinalization(input, slow) });
    const client = process.env.DRAFTED_INTEGRATION_ROOT ? await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT, "src/control.ts")) : undefined;
    const paired = client?.taskRegistry(socket, f.task.id, 1000).prepareFinalization({ requestKey: c.input.requestKey, cleanup: true, preparationBoundary: "initial" });
    await Bun.sleep(15_500);
    const during = await post(); expect(during.status).toBe(202); expect((await during.json()).preparation.acceptedRevision).toBe(accepted.preparation.acceptedRevision);
    const health = await fetch("http://local/health", { unix: socket, signal: AbortSignal.timeout(1000) } as RequestInit & { unix: string }); expect(health.status).toBe(200); await health.body?.cancel();
    expect(projections).toBeGreaterThanOrEqual(10);
    let ready: any;
    while (performance.now() - started < 40_000) { ready = await (await post()).json(); if (ready.preparation.state === "ready") break; await Bun.sleep(100); }
    expect(ready.preparation.state).toBe("ready"); expect(hashes).toBe(2);
    if (paired) expect(await paired).toEqual(ready.receipt);
    expect(performance.now() - started).toBeGreaterThan(32_000);
    const stages = (await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "finalization-preparation-status" } })).map(row => JSON.parse(row.value!));
    const fingerprints = stages.filter(stage => stage.stage === "fingerprint" && stage.event === "end");
    expect(fingerprints).toHaveLength(2); expect(fingerprints.every(stage => stage.elapsedMs >= 16_000)).toBe(true);
    expect(await db.prisma.remoteTaskResource.count({ where: { state: "released" } })).toBe(0);
  } finally { await stop?.(); server.stop(true); }
}, 45_000);

test("async acceptance cannot overlap a pre-existing synchronous scan", async () => {
  const f = await preparedFixture(), c = controls(f); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve), wait = new Promise<void>(resolve => release = resolve);
  const running = prepareTaskFinalization(c.input, { ...f.dependencies, snapshot: async root => { entered(); await wait; return f.dependencies.snapshot(root); } });
  await ready;
  try { expect((await c.post(attempt())).status).toBe(409); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-preparation-accepted" } })).toBe(0); }
  finally { release(); await running; }
});

test("the next boundary independently rejects drift in an already-retained archive", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRoot: f.root, pinnedToolingRoot: f.root } });
  const archive = path.join(directory, "retained"), bytes = Buffer.from("saved content"), sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  await mkdir(archive, { mode: 0o700 }); await writeFile(path.join(archive, "snapshot.bin"), bytes, { mode: 0o600 });
  const manifest = JSON.stringify({ task: f.task.id, issue: f.task.issueIdentifier, mergedCommit: f.remote.pullRequest.mergeCommit.oid, count: 1,
    entries: [{ archivePath: "snapshot.bin", sourcePath: "/historical/snapshot", sha256: sha(bytes), bytes: bytes.length }] });
  await writeFile(path.join(archive, "ARCHIVE-MANIFEST.json"), manifest, { mode: 0o600 });
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "retained", kind: "evidence-archive", purpose: "development", externalId: archive, state: "ready",
    metadata: { archival: true, manifest: { path: "ARCHIVE-MANIFEST.json", sha256: sha(manifest), entries: 1 } } } });
  const originalCount = await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } });
  expect(originalCount).toBe(0);
  const input = { ...f.input, cleanup: true as const }, runtime = createFakeAgentRuntime();
  worker = preparationJournalWorker({ ...input, runtime }, value => prepareTaskFinalization(value, f.dependencies));
  const first = attempt(); await requestFinalizationPreparation(input, first); worker.tick(); await worker.idle();
  expect((await requestFinalizationPreparation(input, first)).preparation.state).toBe("ready");
  await writeFile(path.join(archive, "snapshot.bin"), "changed later");
  const next = attempt("worktree-removal"); await requestFinalizationPreparation(input, next); worker.tick(); await worker.idle();
  const failure = await requestFinalizationPreparation(input, next);
  expect(failure.preparation).toMatchObject({ state: "failed", stage: "retained-archives" }); expect(failure.receipt).toBeUndefined();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-archive-retention" } })).toBe(1);
});

test("a killed verifier process leaves one durable attempt that resumes only after its original runtime owner exits", async () => {
  const f = await preparedFixture(), c = controls(f), request = attempt();
  const accepted = await (await c.post(request)).json();
  const [database] = await db.prisma.$queryRawUnsafe<Array<{ file: string }>>("PRAGMA database_list");
  const project = path.resolve(import.meta.dir, "../../../.."), script = path.join(directory, "verifier.ts");
  await writeFile(script, `import {createPrismaClient} from ${JSON.stringify(path.join(project, "apps/server/prisma.ts"))};
import {testConfig} from ${JSON.stringify(path.join(project, "test-support/config.ts"))};
import {createFakeAgentRuntime} from ${JSON.stringify(path.join(project, "test-support/agent-runtime.ts"))};
import {acquireRuntimeOwnership} from ${JSON.stringify(path.join(project, "apps/server/services/sessions/runtime-owner.ts"))};
import {preparationJournalWorker} from ${JSON.stringify(path.join(project, "apps/server/services/tasks/finalization-preparation.ts"))};
const config=testConfig({databaseUrl:process.argv[2],repository:{...testConfig().repository,root:process.argv[3]}});
const owner=acquireRuntimeOwnership(config), prisma=createPrismaClient(config.databaseUrl);
const worker=preparationJournalWorker({prisma,config,runtime:createFakeAgentRuntime()},async()=>{console.log("owned-verifier-started");await Bun.sleep(60000);throw new Error("never finish");});
worker.tick();await worker.idle();await worker.stop();await prisma.$disconnect();owner.release();`);
  const child = Bun.spawn([process.execPath, script, `file:${database!.file}`, f.root], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const first = await Promise.race([reader.read(), Bun.sleep(2000).then(() => { throw new Error("Disposable verifier did not start"); })]);
    expect(new TextDecoder().decode(first.value)).toContain("owned-verifier-started"); reader.releaseLock();
    expect(() => acquireRuntimeOwnership({ ...f.config, databaseUrl: `file:${database!.file}` })).toThrow("another Remote Agent process");
    child.kill("SIGTERM"); await child.exited;
    const ownership = acquireRuntimeOwnership({ ...f.config, databaseUrl: `file:${database!.file}` });
    try {
    worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, value => prepareTaskFinalization(value, f.dependencies));
    worker.tick(); await worker.idle();
    const ready = await (await c.post(request)).json(); expect(ready.preparation.acceptedRevision).toBe(accepted.preparation.acceptedRevision); expect(ready.preparation.state).toBe("ready");
    expect(ready.receipt.preparedRevision).toBe(f.prepared.preparedRevision);
    } finally { ownership.release(); }
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
});

test("acceptance racing a synchronous scan waits for the shared reservation before running", async () => {
  const f = await preparedFixture(), c = controls(f), request = attempt();
  let guarded!: () => void, accept!: () => void, scanning!: () => void, finish!: () => void;
  const guard = new Promise<void>(r => guarded = r), resume = new Promise<void>(r => accept = r);
  const scan = new Promise<void>(r => scanning = r), done = new Promise<void>(r => finish = r);
  const accepting = requestFinalizationPreparation(c.input, request, { afterAcceptanceGuard: async () => { guarded(); await resume; } });
  await guard;
  let active = 0, maximum = 0, journalRuns = 0;
  const sync = prepareTaskFinalization(c.input, { ...f.dependencies, snapshot: async root => {
    active++; maximum = Math.max(maximum, active); scanning(); await done;
    try { return await f.dependencies.snapshot(root); } finally { active--; }
  } });
  await scan; accept(); await accepting;
  worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, async value => {
    journalRuns++; active++; maximum = Math.max(maximum, active);
    try { return await prepareTaskFinalization(value, f.dependencies); } finally { active--; }
  });
  worker.tick(); await worker.idle(); expect(journalRuns).toBe(0);
  finish(); await sync; worker.tick(); await worker.idle();
  expect(journalRuns).toBe(1); expect(maximum).toBe(1);
  expect((await requestFinalizationPreparation(c.input, request)).preparation.state).toBe("ready");
});

test("queued verification refuses changed primitive resource metadata before reading any bytes", async () => {
  const f = await preparedFixture(), c = controls(f), request = attempt();
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: "first receipt" } });
  expect((await c.post(request)).status).toBe(202);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { metadata: "different receipt" } });
  let scans = 0;
  worker = preparationJournalWorker({ ...c.input, runtime: c.runtime }, async value => { scans++; return prepareTaskFinalization(value, f.dependencies); });
  worker.tick(); await worker.idle(); expect(scans).toBe(0); expect((await c.post(request)).status).toBe(409);
});

async function removedFixture() {
  const f = await preparedFixture(), c = controls(f);
  const prepared = await prepareTaskFinalization(c.input, f.dependencies);
  await db.prisma.remoteTaskResource.update({ where: { id: "volume" }, data: { state: "released" } });
  f.remove();
  const post = (confirmation = attempt("confirmation")) => c.app.request(`/api/tasks/${f.task.id}/confirm-finalization`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: c.input.requestKey, cleanup: true, confirmation }) });
  return { ...f, c, prepared, post };
}

test("confirmation acknowledgment joins one full observation and recovers its lost response with the exact revision", async () => {
  const f = await removedFixture(), request = attempt("confirmation");
  const accepted = await (await f.post(request)).json();
  expect(accepted.confirmation.state).toBe("pending"); expect(accepted.receipt).toBeUndefined();
  let scans = 0, release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve);
  worker = preparationJournalWorker(f.c.input, undefined, async input => { scans++; entered(); await wait; return confirmTaskFinalization(input, f.dependencies); });
  worker.tick(); await started;
  try {
    const joined = await (await f.post()).json();
    expect(joined.confirmation.acceptedRevision).toBe(accepted.confirmation.acceptedRevision);
    await expect(confirmTaskFinalization(f.c.input, f.dependencies)).rejects.toThrow("already running");
    expect((await f.c.post(request)).status).toBe(409); // A confirmation token cannot become a preparation token.
  } finally { release(); }
  await worker.idle();
  // Treat the first terminal response as lost; a replay is only a local receipt read.
  const ready = await (await f.post(request)).json(), replay = await (await f.post(request)).json();
  expect(replay.receipt).toEqual(ready.receipt);
  expect(replay.receipt.preparedRevision).toBe(f.prepared.preparedRevision);
  expect(replay.receipt.cleanup).toEqual(f.prepared.cleanup);
  expect(replay.receipt.confirmedRevision).toBeGreaterThan(0); expect(scans).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  await worker.stop(); worker = preparationJournalWorker(f.c.input, undefined, async () => { throw new Error("completed confirmation must not rerun"); });
  worker.tick(); await worker.idle();
  expect((await (await f.post(request)).json()).receipt).toEqual(ready.receipt);
});

test.each(["pause", "revoke", "mismatch"])("confirmation %s cannot yield a ready receipt or closure authority", async mode => {
  const f = await removedFixture(), request = attempt("confirmation");
  await f.post(request);
  worker = preparationJournalWorker(f.c.input, undefined, async input => {
    const confirmed = await confirmTaskFinalization(input, f.dependencies);
    if (mode === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (mode === "revoke") await f.revoke();
    return mode === "mismatch" ? { ...confirmed, confirmedRevision: confirmed.confirmedRevision! + 1000 } : confirmed;
  });
  worker.tick(); await worker.idle();
  const statuses = (await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "finalization-preparation-status" }, orderBy: { sequence: "asc" } })).map(row => JSON.parse(row.value!));
  expect(statuses.at(-1).state).toBe("failed"); expect(statuses.some(row => row.state === "ready")).toBe(false);
  const response = await f.post(request), result = await response.json();
  expect(result.receipt).toBeUndefined(); expect(result.confirmation?.state).not.toBe("ready");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).not.toBe("closed");
});

test("the existing worker completes confirmation beyond a control request deadline while requests stay responsive", async () => {
  const f = await removedFixture(), request = attempt("confirmation");
  f.c.app.get("/health", c => c.json({ ok: true }));
  const socket = path.join(directory, "confirmation.sock"), server = Bun.serve({ unix: socket, fetch: f.c.app.fetch });
  const post = () => fetch(`http://local/api/tasks/${f.task.id}/confirm-finalization`, { unix: socket, method: "POST", signal: AbortSignal.timeout(1000), headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: f.c.input.requestKey, cleanup: true, confirmation: request }) } as RequestInit & { unix: string });
  let scans = 0;
  const stop = startRuntimeEventProjection(f.c.input, async () => {}, { confirmFinalization: async input => { scans++; await Bun.sleep(31_000); return confirmTaskFinalization(input, f.dependencies); } });
  try {
    const first = await post(); expect(first.status).toBe(202); await first.body?.cancel();
    const started = performance.now(); let result: any;
    do { result = await (await post()).json(); if (result.confirmation.state === "ready") break; await Bun.sleep(200); } while (performance.now() - started < 36_000);
    expect(result.confirmation.state).toBe("ready"); expect(result.receipt.confirmedRevision).toBeGreaterThan(0);
    expect(performance.now() - started).toBeGreaterThan(30_000); expect(scans).toBe(1);
    const health = await fetch("http://local/health", { unix: socket, signal: AbortSignal.timeout(1000) } as RequestInit & { unix: string }); expect(health.status).toBe(200); await health.body?.cancel();
  } finally { await stop(); server.stop(true); }
}, 40_000);

test("an existing confirmed revision cannot conceal changed retained bytes at the next confirmation boundary", async () => {
  const f = await fixture(), c = controls(f);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRoot: f.root, pinnedToolingRoot: f.root } });
  const root = path.join(directory, "retained"), data = Buffer.from("preserved owner data"), sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  await mkdir(root, { mode: 0o700 }); await writeFile(path.join(root, "saved.bin"), data, { mode: 0o600 });
  const manifest = JSON.stringify({ task: f.task.id, issue: f.task.issueIdentifier, mergedCommit: f.remote.pullRequest.mergeCommit.oid, count: 1,
    entries: [{ archivePath: "saved.bin", sourcePath: "/historical/saved", sha256: sha(data), bytes: data.length }] });
  await writeFile(path.join(root, "ARCHIVE-MANIFEST.json"), manifest, { mode: 0o600 });
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "retained", kind: "evidence-archive", purpose: "development", externalId: root, state: "ready",
    metadata: { archival: true, manifest: { path: "ARCHIVE-MANIFEST.json", sha256: sha(manifest), entries: 1 } } } });
  await prepareTaskFinalization(c.input, f.dependencies); f.remove();
  const { requestFinalizationConfirmation } = await import("./finalization-preparation.ts");
  worker = preparationJournalWorker(c.input, undefined, input => confirmTaskFinalization(input, f.dependencies));
  const first = attempt("confirmation"); await requestFinalizationConfirmation(c.input, first); worker.tick(); await worker.idle();
  const confirmed = await requestFinalizationConfirmation(c.input, first); expect(confirmed.confirmation.state).toBe("ready");
  await writeFile(path.join(root, "saved.bin"), "changed retained bytes");
  const next = attempt("confirmation"); await requestFinalizationConfirmation(c.input, next); worker.tick(); await worker.idle();
  const failed = await requestFinalizationConfirmation(c.input, next); expect(failed.confirmation.state).toBe("failed"); expect(failed.receipt).toBeUndefined();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
  expect((await db.prisma.remoteTaskResource.findFirstOrThrow({ where: { key: "retained" } })).state).toBe("ready");
  expect(await Bun.file(path.join(root, "saved.bin")).text()).toBe("changed retained bytes");
});
