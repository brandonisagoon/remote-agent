import { afterEach, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { originalArchiveFixture, originalGit } from "../../../../test-support/original-work.ts";
import { prepareOriginalWork, assertOriginalWork } from "./original-work.ts";
import { automaticCleanupTurn } from "./cleanup-inbox.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "acpx/runtime";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createAcpxSessionRuntime } from "../../transports/acpx/session-runtime.ts";
import { createApp } from "../../app.ts";
import { finalizationResourceObservation } from "./finalization-resources.ts";
import { beginTask } from "./store.ts";
import { releaseTaskCleanupTransports, returnTaskTransportToWork } from "./cleanup-transport.ts";
import { queueInstruction, deliverInstructions } from "../sessions/inbox.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
async function until(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Fixture did not reach its observed state"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(delegates = 0, linked = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dra210-"))), source = path.join(root, "source");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (linked) {
    const product = path.join(root, "product"); await mkdir(product);
    originalGit(product, ["init", "-b", "main"]); originalGit(product, ["config", "user.name", "Fixture"]); originalGit(product, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(product, "README.md"), "Original committed work\n"); originalGit(product, ["add", "."]); originalGit(product, ["commit", "-m", "Original"]);
    originalGit(product, ["worktree", "add", "-b", "codex/original", source]);
  } else await mkdir(source);
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const config = testConfig({ acpxStateDir: path.join(root, "state"), installRoot: root, apiKey: "fixture-owner-key",
    acpxAgentCommands: { codex: [process.execPath, path.resolve(import.meta.dir, "../../../../test-support/warm-acp-provider.ts")] } });
  const repository = { ...config.repository, root, worktreeRoot: root, tooling: { root: path.join(root, "policy"), revision: "a".repeat(40) } };
  config.repository = repository; config.repositories = { [repository.id]: repository };
  const runtime = createAcpxSessionRuntime(db.prisma, config), ids: string[] = [];
  cleanups.push(async () => { await writeFile(path.join(root, "finish-capture"), "fixture teardown"); await until(async () => ids.every(id => runtime.observeSessionActivity!(id).state === "unknown"));
    for (const id of ids) if ((await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id } })).status === "error") await runtime.close(id, "Fixture cleanup");
    await runtime.releaseIdleTransports!({ sessionIds: ids, check: async () => {}, commit: async () => {} }); await runtime.shutdown(); });
  const task = await beginTask(db.prisma, { requestKey: "original-task", repository, machineId: config.machine, branchName: "codex/original" });
  async function provider(key: string, role: "primary" | "delegate") {
    const session = await runtime.ensureSession({ sessionKey: key, agent: "codex", cwd: source, repositoryId: repository.id, machineId: config.machine,
      role, lifecycle: "persistent", agentEnv: { WARM_ACP_LOG: path.join(root, `${key}.jsonl`), WARM_ACP_FINISH: path.join(root, "finish-capture") } }); ids.push(session.id);
    const turn = runtime.startTurn({ sessionId: session.id, requestId: `${key}-first`, text: "Original completed work" });
    for await (const _ of turn.events) {} expect((await turn.result).status).toBe("completed");
    await until(async () => runtime.observeSessionActivity!(session.id).state === "unknown");
    return session;
  }
  const session = await provider("primary", "primary");
  for (let index = 0; index < delegates; index++) {
    const child = await provider(`delegate${index}`, "delegate");
    await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: child.id, targetSessionId: session.id, relationship: "spawned-by" } });
  }
  await db.prisma.remoteTask.update({ where: { id: task.id }, data: { primarySessionId: session.id, worktreePath: source, pinnedToolingRoot: path.join(root, "original-pin"), phase: "waiting" } });
  const store = createRuntimeStore({ stateDir: config.acpxStateDir });
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const context = { prisma: db.prisma, config, runtime, taskId: task.id };
  const request = (body: unknown, token = config.apiKey) => app.request(`/api/tasks/${task.id}/completion/cleanup-transport`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  async function schedule(requestId: string, text = "Continue exact original cleanup") {
    const current = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    const value = JSON.stringify({ boundary: "merge" });
    let contract = await db.prisma.runtimeMetadataEvent.findFirst({ where: { action: "completion-contract" } });
    contract ??= await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: `owner:${task.id}`, action: "completion-contract", key: "fixture-approval", value } });
    await queueInstruction(db.prisma, { sessionId: session.id, requestId, text });
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: "cleanup-inbox", action: "finalization-cleanup-instruction", key: requestId, value: JSON.stringify({ version: 1, taskId: task.id, sessionId: session.id, requestKey: `finalize:${task.id}`, worktree: source,
      repositoryId: current.repositoryId, machineId: current.machineId, toolingRevision: current.toolingRevision, pinnedToolingRoot: current.pinnedToolingRoot,
      contractRevision: contract.sequence, contractDigest: hash(value), capability: { checkout: root, adapter: null, capabilityRevision: current.toolingRevision, taskToolingRevision: current.toolingRevision } }) } });
  }
  return { ...context, db, root, source, session, ids, store, request, schedule, app };
}

test("real warm primary and delegates release; original cleanup resumes outside source with the same history and identity", async () => {
  const f = await fixture(2), taskBefore = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.taskId } });
  const primaryBefore = await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } });
  const records = await Promise.all(f.ids.map(id => f.store.load(id))); expect(records.every(record => record?.pid && alive(record.pid))).toBe(true);
  const beforeHistory = await f.runtime.history(f.session.id);
  await expect(finalizationResourceObservation.rootIdle(f.source)).rejects.toThrow();
  const response = await f.request({ mode: "cleanup" }); expect(response.status).toBe(200); const receipt = await response.json();
  expect(records.every(record => !alive(record!.pid!))).toBe(true);
  await finalizationResourceObservation.rootIdle(f.source);
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(taskBefore);
  expect(await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(primaryBefore);
  expect(await f.runtime.history(f.session.id)).toEqual(beforeHistory);
  expect(await (await f.request({ mode: "cleanup" })).json()).toEqual(receipt); // lost-response retry
  await f.schedule("cleanup-one"); await deliverInstructions(f.prisma, f.runtime, f.config);
  await until(async () => (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "cleanup-one" } })).state === "completed");
  await until(async () => f.runtime.observeSessionActivity!(f.session.id).state === "unknown");
  const next = await f.store.load(f.session.id);
  expect(next!.cwd).toBe(f.source); expect(next!.acpSessionId).toBe(records[0]!.acpSessionId); expect(next!.acpxRecordId).toBe(records[0]!.acpxRecordId);
  expect((await f.runtime.history(f.session.id)).slice(0, beforeHistory.length)).toEqual(beforeHistory);
  const log = (await readFile(path.join(f.root, "primary.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(log.filter(row => row.event === "session/new")).toHaveLength(1);
  expect(log.find(row => row.event === "session/load")).toMatchObject({ cwd: receipt.executionCwd, requestedCwd: receipt.executionCwd, sessionId: next!.acpSessionId });
  await finalizationResourceObservation.rootIdle(f.source);
  // A real pathname move models the existing independently verified capture;
  // the provider no longer pins the original cwd and next retry still resumes.
  await rename(f.source, `${f.source}-captured`);
  await f.schedule("cleanup-two"); await deliverInstructions(f.prisma, f.runtime, f.config);
  await until(async () => (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "cleanup-two" } })).state === "completed");
  expect(await f.prisma.runtimeSession.count()).toBe(3);
  expect((await f.store.load(f.session.id))!.cwd).toBe(f.source);
}, 30_000);

test("owner-only route rejects active, paused and changed identities without stopping their real process", async () => {
  const f = await fixture(); const record = (await f.store.load(f.session.id))!;
  expect((await f.request({ mode: "cleanup" }, "not-owner")).status).toBe(401); expect(alive(record.pid!)).toBe(true);
  await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: true } });
  expect((await f.request({ mode: "cleanup" })).status).toBe(409); expect(alive(record.pid!)).toBe(true);
  await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: false } });
  const turn = f.runtime.startTurn({ sessionId: f.session.id, text: "hold", requestId: "held-turn" });
  await until(async () => f.runtime.observeSessionActivity!(f.session.id).state === "executing");
  expect((await f.request({ mode: "cleanup" })).status).toBe(409); expect(alive(record.pid!)).toBe(true);
  for await (const _ of turn.events) {} await turn.result; await until(async () => f.runtime.observeSessionActivity!(f.session.id).state === "unknown");
  const saved = await releaseTaskCleanupTransports(f);
  await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { pinnedToolingRoot: `${f.root}/changed-pin` } });
  expect((await f.request({ mode: "cleanup" })).status).toBe(409);
  await expect(returnTaskTransportToWork({ ...f, revision: saved.revision })).rejects.toThrow("identity changed");
}, 30_000);

test("ordinary follow-up stays queued until explicit return-to-work; it cannot recreate the cleanup obstruction", async () => {
  const f = await fixture(); const saved = await releaseTaskCleanupTransports(f);
  await queueInstruction(f.prisma, { sessionId: f.session.id, requestId: "owner-followup", text: "Change the existing work" });
  await deliverInstructions(f.prisma, f.runtime, f.config);
  expect((await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "owner-followup" } })).state).toBe("queued");
  expect((await readFile(path.join(f.root, "primary.jsonl"), "utf8")).match(/"event":"spawn"/g)).toHaveLength(1);
  expect((await f.request({ mode: "work", revision: saved.revision })).status).toBe(200);
  await deliverInstructions(f.prisma, f.runtime, f.config);
  await until(async () => (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "owner-followup" } })).state === "completed");
  const log = (await readFile(path.join(f.root, "primary.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(log.at(-2)?.cwd ?? log.at(-1).cwd).toBe(f.source);
}, 30_000);

test("released provider resumes after server restart and original source removal without a new session", async () => {
  const f = await fixture(), before = await f.store.load(f.session.id);
  const saved = await releaseTaskCleanupTransports(f); await rename(f.source, `${f.source}-captured`);
  const restarted = createAcpxSessionRuntime(f.prisma, f.config);
  cleanups.push(async () => { await until(async () => restarted.observeSessionActivity!(f.session.id).state === "unknown");
    if ((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).status !== "closed") await restarted.releaseIdleTransports!({ sessionIds: f.ids, check: async () => {}, commit: async () => {} }); await restarted.shutdown(); });
  await f.schedule("cleanup-after-restart"); await deliverInstructions(f.prisma, restarted, f.config);
  await until(async () => (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "cleanup-after-restart" } })).state === "completed");
  expect((await f.store.load(f.session.id))!.acpSessionId).toBe(before!.acpSessionId);
  await expect(returnTaskTransportToWork({ ...f, runtime: restarted, revision: saved.revision })).rejects.toThrow();
  await until(async () => restarted.observeSessionActivity!(f.session.id).state === "unknown");
  await restarted.releaseIdleTransports!({ sessionIds: f.ids, check: async () => {}, commit: async () => {} });
  // Existing logical final closure is possible after a second restart without
  // an ensureSession call against the now-absent original source.
  const final = createAcpxSessionRuntime(f.prisma, f.config); await final.close(f.session.id, "Fixture confirmed cleanup"); await final.shutdown();
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).toBe("closed");
  expect(await f.prisma.runtimeSession.count()).toBe(1);
}, 30_000);

test("foreign delegate and uncertain instructions preserve every warm process", async () => {
  const f = await fixture(1), records = await Promise.all(f.ids.map(id => f.store.load(id)));
  await f.prisma.runtimeSessionRelation.updateMany({ data: { endedAt: new Date() } });
  await expect(releaseTaskCleanupTransports(f)).rejects.toThrow("owned provider family");
  expect(records.every(record => alive(record!.pid!))).toBe(true);
  await f.prisma.runtimeSessionRelation.updateMany({ data: { endedAt: null } });
  await queueInstruction(f.prisma, { sessionId: f.ids[1]!, requestId: "unsettled", text: "Do not discard" });
  await f.prisma.runtimeInstruction.update({ where: { id: "unsettled" }, data: { state: "unknown" } });
  await expect(releaseTaskCleanupTransports(f)).rejects.toThrow("pending");
  expect(records.every(record => alive(record!.pid!))).toBe(true);
}, 30_000);

test("pause and new local turns cannot cross the release reservation", async () => {
  const f = await fixture(), record = (await f.store.load(f.session.id))!;
  let checked!: () => void, proceed!: () => void;
  const entered = new Promise<void>(resolve => { checked = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
  const release = f.runtime.releaseIdleTransports!({ sessionIds: f.ids, check: async () => { checked(); await gate;
    if ((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.taskId } })).ownerPaused) throw new Error("Owner paused"); }, commit: async () => { throw new Error("Must not commit"); } });
  await entered;
  expect(() => f.runtime.startTurn({ sessionId: f.session.id, text: "Competing writer", requestId: "competing" })).toThrow("reconciled");
  await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: true } }); proceed();
  await expect(release).rejects.toThrow("Owner paused"); expect(alive(record.pid!)).toBe(true);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "cleanup-provider-transport" } })).toBe(0);
}, 30_000);

test("paused cleanup stays queued and an execution-directory replacement cannot become authority", async () => {
  const f = await fixture(), saved = await releaseTaskCleanupTransports(f);
  await f.schedule("cleanup-paused"); await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: true } });
  await deliverInstructions(f.prisma, f.runtime, f.config);
  expect((await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "cleanup-paused" } })).state).toBe("queued");
  await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { ownerPaused: false } });
  await rename(saved.executionCwd, `${saved.executionCwd}-preserved`); await mkdir(saved.executionCwd, { mode: 0o700 });
  await deliverInstructions(f.prisma, f.runtime, f.config);
  await until(async () => (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "cleanup-paused" } })).state === "failed");
  const log = await readFile(path.join(f.root, "primary.jsonl"), "utf8"); expect(log.match(/"event":"spawn"/g)).toHaveLength(1);
}, 30_000);

test("a different runtime cannot adopt an existing live provider as its own idle transport", async () => {
  const f = await fixture(), record = (await f.store.load(f.session.id))!;
  const other = createAcpxSessionRuntime(f.prisma, f.config);
  await expect(releaseTaskCleanupTransports({ ...f, runtime: other })).rejects.toThrow("still alive");
  expect(alive(record.pid!)).toBe(true); expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "cleanup-provider-transport" } })).toBe(0);
  await other.shutdown();
}, 30_000);

const clientRoot = process.env.DRAFTED_INTEGRATION_ROOT;
(clientRoot ? test : test.skip)("actual archive adoption checks and native original retirement succeed during the same relocated primary turn", async () => {
  const f = await fixture(1, true), archive = path.join(f.root, "archive"), selection = await originalArchiveFixture(f.source, archive, "retained-original");
  const resource = await f.prisma.remoteTaskResource.create({ data: { taskId: f.taskId, key: "retained-original", kind: "source-archive", purpose: "review", externalId: archive, state: "ready", metadata: {} } });
  selection.archiveResourceId = resource.id;
  const input = { taskId: f.taskId, toolingRevision: "a".repeat(40), worktree: f.source, branch: "codex/original", approvedHead: originalGit(f.source, ["rev-parse", "HEAD"]).toString().trim(), resources: [resource], originalWork: selection };
  await expect(prepareOriginalWork(input)).rejects.toThrow(/open files|process still references/);
  await releaseTaskCleanupTransports(f); const proof = await prepareOriginalWork(input);
  await f.schedule("cleanup-capture", "capture"); await deliverInstructions(f.prisma, f.runtime, f.config);
  await until(async () => f.runtime.observeSessionActivity!(f.session.id).state === "executing");
  const client = await import(pathToFileURL(path.join(clientRoot!, "src/archived-worktree.ts")).href);
  const assertAuthority = async () => { const task = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.taskId } }); await automaticCleanupTurn(f.prisma, task, true, f.runtime); };
  await assertOriginalWork({ taskId: f.taskId, originalWork: proof, resources: [resource], removed: false });
  const retire = () => client.retireArchivedWorktree({ taskId: f.taskId, worktree: f.source, revision: proof.snapshot.head, branch: proof.snapshot.branch,
    gitDirectory: proof.restore.gitDirectory, gitCwd: path.join(f.root, "product"), target: proof.target, administration: proof.administration, assertAuthority });
  await retire(); await retire(); // exact native journal/lost acknowledgment retry
  await assertOriginalWork({ taskId: f.taskId, originalWork: proof, resources: [resource], removed: true });
  expect(await Bun.file(path.join(proof.target.quarantine.path, "staged.txt")).text()).toBe("saved staged work\n");
  expect(await Bun.file(path.join(proof.target.quarantine.path, "README.md")).text()).toBe("unfinished original change\n");
  expect((await f.store.load(f.session.id))!.cwd).toBe(f.source);
  expect((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.taskId } })).toolingRevision).toBe("a".repeat(40));
  await writeFile(path.join(f.root, "finish-capture"), "fixture turn may complete");
  await until(async () => (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "cleanup-capture" } })).state === "completed");
}, 30_000);

test("existing automatic cleanup scheduling releases the warm family without another approval and retries the same instruction", async () => {
  const f = await fixture(1);
  await f.prisma.remoteTask.update({ where: { id: f.taskId }, data: { connectionId: f.config.activeConnectionId, issueIdentifier: "DRA-fixture" } });
  await f.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: f.session.id, provider: "linear", connectionId: f.config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-fixture", relationship: "handles" } });
  await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.taskId}`, action: "completion-contract", key: "accepted", value: JSON.stringify({ boundary: "merge", verificationRequired: false }) } });
  const { enqueueTaskCleanup } = await import("./cleanup-inbox.ts");
  const dependencies = { capability: async () => ({ receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
    taskToolingRevision: "a".repeat(40), capabilityRevision: "b".repeat(40), checkout: f.root, instructions: `${f.root}/cleanup.md`, adapter: `${f.root}/cli.ts` }, instructions: "Fixture immutable cleanup capability" }) };
  const input = { ...f, requestKey: "automatic-pass" };
  const queued = await enqueueTaskCleanup(input, dependencies);
  expect(await enqueueTaskCleanup(input, dependencies)).toEqual(queued);
  const original = await f.store.load(f.session.id); expect(alive(original!.pid!)).toBe(false);
  await deliverInstructions(f.prisma, f.runtime, f.config);
  await until(async () => (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: queued.instructionId } })).state === "completed");
  const log = (await readFile(path.join(f.root, "primary.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(log.filter(row => row.event === "session/new")).toHaveLength(1);
  expect(log.find(row => row.event === "session/load")!.cwd).not.toBe(f.source);
  const inspection = await f.app.request(`/api/tasks/${f.taskId}/completion/cleanup-transport`, { headers: { authorization: `Bearer ${f.config.apiKey}` } });
  expect(await inspection.json()).toMatchObject({ readOnly: true, mode: "cleanup", sessionId: f.session.id, blocked: null });
}, 30_000);
