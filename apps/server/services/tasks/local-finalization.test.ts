import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../app.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { startRuntimeEventProjection } from "../sessions/runtime-events/projection.ts";
import { finalizationDigest } from "./finalization-resources.ts";
import { inspectCleanupSupplementAuthority } from "./cleanup-lifecycle.ts";
import { legacyOriginalWorkDependencies } from "./legacy-original-work.ts";
import { enqueueTaskCleanup, cleanupInstructionAllows } from "./cleanup-inbox.ts";
import { cleanupCandidates } from "./cleanup-candidates.ts";
import { preparationFailure } from "./preparation-errors.ts";
import { prepareTaskFinalization } from "./finalization.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "local-finalize-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture(boundary = "research") {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "original product\n"); git(root, "add", "."); git(root, "commit", "-m", "base");
  git(root, "worktree", "add", "-b", "codex/evaluation", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "direct-task", requestKey: "direct-task", repositoryId: config.repository.id, machineId: config.machine, primarySessionId: session.id, branchName: "codex/evaluation", baseCommit: git(root, "rev-parse", "HEAD"), worktreePath: worktree, toolingRoot: root, toolingRevision: "a".repeat(40), phase: "complete" } });
  const app = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: app.fetch }); await chmod(socket, 0o600);
  const request = async (route: string, body: object, owner = false, method = "POST") => {
    const response = await fetch(`http://localhost/api/tasks/${task.id}/${route}`, { unix: socket, method, headers: { "content-type": "application/json", ...(owner ? { authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const contract = { requestKey: "owner-completion", expectedRevision: 0, boundary, basis: "Original evaluation is complete; preserve its published evidence." };
  expect((await request("completion/contract", contract, false, "PUT")).status).toBe(401);
  const accepted = await request("completion/contract", contract, true, "PUT"); expect(accepted.status).toBe(200);
  const verified = await request("completion/verification", { requestKey: "owner-verification", passed: true, evidence: ["Actual two-turn evaluation report and archived evidence reviewed; no product implementation claimed."] }, true); expect(verified.status).toBe(200);
  return { root, worktree, config, task, session, server, socket, request, contractRevision: accepted.data.revision, input: { requestKey: `finalize:${task.id}`, cleanup: true as const } };
}

test("real owner contract and Unix control finalize an unlinked research task without inventing a source issue", async () => {
  const f = await fixture();
  try {
    const prepared = await f.request("prepare-finalization", f.input);
    expect(prepared.status).toBe(200);
    expect(prepared.data.localCompletion).toMatchObject({ kind: "local-completion/v1", boundary: "research" });
    expect(prepared.data.cleanup).toBeDefined();
    expect((await f.request("confirm-finalization", f.input)).status).toBe(409);
    git(f.root, "worktree", "remove", f.worktree);
    const confirmed = await f.request("confirm-finalization", f.input); expect(confirmed.status).toBe(200);
    expect(confirmed.data.preparedRevision).toBe(prepared.data.preparedRevision);
    expect((await f.request("confirm-finalization", f.input)).data).toEqual(confirmed.data);
    const report = await f.request("cleanup-report", { requestKey: f.input.requestKey });
    expect(report.status).toBe(200); expect(report.data).toMatchObject({ recorded: true, published: false });
    expect(await db.prisma.runtimeIssueUpdate.count()).toBe(0); expect(await db.prisma.runtimeSessionResourceLink.count()).toBe(0);
    expect(await lstat(f.worktree).catch(() => null)).toBeNull();
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toolingRevision).toBe(f.task.toolingRevision);
  } finally { await f.server.stop(true); }
}, 30_000);

test.each(["unverified", "failed", "revoked", "nonlocal", "mixed-source", "source-link", "paused", "closed", "dirty", "delegate", "moved-descendant", "pending"])("direct preparation refuses %s without authority or source effects", async condition => {
  const f = await fixture("local-only");
  try {
    if (condition === "unverified") await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: "completion-verification" } });
    if (condition === "failed") await f.request("completion/verification", { requestKey: "new-failed", passed: false, evidence: ["Verification failed"] }, true);
    if (["revoked", "nonlocal"].includes(condition)) await f.request("completion/contract", { requestKey: "new-contract", expectedRevision: f.contractRevision, boundary: condition === "revoked" ? "revoked" : "commit", basis: "Changed scope" }, true, "PUT");
    if (condition === "mixed-source") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { connectionId: f.config.activeConnectionId } });
    if (condition === "source-link") await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: f.session.id, provider: "linear", connectionId: f.config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-238", relationship: "handles" } });
    if (condition === "paused") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (condition === "closed") { await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } }); await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed", closedAt: new Date() } }); }
    if (condition === "dirty") { await writeFile(path.join(f.worktree, "README.md"), "uncommitted work"); await f.request("completion/verification", { requestKey: "dirty-verified", passed: true, evidence: ["Local-only work inspected, but must remain recoverable"] }, true); }
    if (["delegate", "moved-descendant"].includes(condition)) {
      const child = await db.prisma.runtimeSession.create({ data: { scopeKey: "child", agentCommand: "codex", status: "active", role: "delegate", cwd: condition === "delegate" ? f.worktree : path.join(directory, "moved"), repositoryId: f.task.repositoryId, machineId: f.task.machineId } });
      await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: child.id, targetSessionId: f.session.id, relationship: "spawned-by" } });
    }
    if (condition === "pending") await db.prisma.runtimeInstruction.create({ data: { id: "pending", sessionId: f.session.id, text: "Owner requested further work", state: "queued" } });
    const response = await f.request("prepare-finalization", f.input); expect(response.status).toBe(409);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started"] } } })).toBe(0);
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.task.baseCommit!);
  } finally { await f.server.stop(true); }
});

test.each(["contract", "verification", "source", "resource", "ignored", "pause"])("same-operation renewal refuses later %s drift and preserves preparation bytes", async change => {
  const f = await fixture();
  try {
    const prepared = await f.request("prepare-finalization", f.input); expect(prepared.status).toBe(200);
    const raw = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.preparedRevision } });
    if (change === "contract") await f.request("completion/contract", { requestKey: "replaced", expectedRevision: f.contractRevision, boundary: "local-only", basis: "New scope" }, true, "PUT");
    if (change === "verification") await f.request("completion/verification", { requestKey: "later", passed: true, evidence: ["Different verification"] }, true);
    if (change === "source") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { connectionId: f.config.activeConnectionId, issueIdentifier: "DRA-238" } });
    if (change === "resource") await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "late", kind: "evidence", purpose: "development", externalId: path.join(directory, "new"), state: "ready" } });
    if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (change === "ignored") { await writeFile(path.join(f.root, ".git/info/exclude"), "late-cache\n"); await writeFile(path.join(f.worktree, "late-cache"), "retained owner bytes"); }
    expect((await f.request("prepare-finalization", f.input)).status).toBe(409);
    expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: raw.sequence } })).toEqual(raw);
    expect((await lstat(f.worktree)).isDirectory()).toBe(true);
  } finally { await f.server.stop(true); }
});

test("missing direct completion emits a fixed safe diagnostic and schedules no cleanup", async () => {
  const f = await fixture();
  try {
    expect((await cleanupCandidates(db.prisma, f.config, [f.task])).has(f.task.id)).toBe(true);
    await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: "completion-contract" } });
    expect((await cleanupCandidates(db.prisma, f.config, [f.task])).size).toBe(0);
    try { await prepareTaskFinalization({ ...f.input, prisma: db.prisma, config: f.config, sessionId: f.session.id }); throw Error("must refuse"); }
    catch (error) { expect(preparationFailure(error)).toMatchObject({ code: "LOCAL_COMPLETION_REQUIRED" }); expect(JSON.stringify(preparationFailure(error))).not.toContain(directory); }
  } finally { await f.server.stop(true); }
});

const actual = process.env.DRAFTED_LOCAL_FINALIZATION_ROOT ? test : test.skip;
actual.each(["none", "changed-ignored", "new-ignored", "pause"])("actual client preserves unlinked source and evidence through capture/retry (late change=%s)", async change => {
  const f = await fixture(), root = process.env.DRAFTED_LOCAL_FINALIZATION_ROOT!;
  const client = (file: string) => import(pathToFileURL(path.join(root, `src/${file}.ts`)).href);
  const { finalizeTask } = await client("finalize"), { taskRegistry, closeTask } = await client("control"), { manageResource } = await client("resources");
  const { prepareLegacyOriginalArchive } = await client("legacy-original-archive"), { run } = await client("process");
  const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const idle = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
  const priorObservation = legacyOriginalWorkDependencies.observation; legacyOriginalWorkDependencies.observation = idle;
  const stop = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime: createFakeAgentRuntime() }, async () => {});
  try {
    await writeFile(path.join(f.root, ".git/info/exclude"), "cache/\n"); await mkdir(path.join(f.worktree, "cache"));
    const cache = path.join(f.worktree, "cache", "result.bin"); await writeFile(cache, "original ignored material");
    const sourceEvidence = path.join(directory, "original-evidence", "evidence.txt"), retainedRoot = path.join(directory, "retained-evidence"), retainedFile = path.join(retainedRoot, "evidence.txt");
    await mkdir(path.dirname(sourceEvidence), { mode: 0o700 }); await mkdir(retainedRoot, { mode: 0o700 }); await writeFile(sourceEvidence, "published evidence", { mode: 0o600 }); await writeFile(retainedFile, "published evidence", { mode: 0o600 });
    const evidence = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "evidence", kind: "evidence", purpose: "development", externalId: sourceEvidence, state: "ready", metadata: { sha256: sha("published evidence"), bytes: 18 } } });
    const registry = taskRegistry(f.socket, f.task.id, 20_000); let removals = 0, closed = 0;
    const close = async () => { await closeTask(f.socket, f.task.id); closed++; };
    const manage = (input: any) => manageResource(input);
    const args = { registry, cleanup: true, close, manage, preparedCleanup: { observation: idle } };
    await expect(finalizeTask({ ...args, runner: async (command: string[], cwd: string) => { if (command.includes("remove")) removals++; return run(command, cwd); } })).rejects.toThrow("ignored material");
    expect(removals).toBe(0); expect(closed).toBe(0); expect(await readFile(cache, "utf8")).toBe("original ignored material");
    const prepared = await f.request("prepare-finalization", f.input); expect(prepared.status).toBe(200);
    expect(prepared.data.localCompletion.sourceCaptureRequired).toBe(true);
    const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.preparedRevision } });
    const operation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.cleanup.operationRevision } });
    const manifestPath = path.join(retainedRoot, "RETENTION.json"), manifest = JSON.stringify({ task: f.task.id, retainedArchive: retainedRoot, sourceUnchanged: true, files: [{ path: "evidence.txt", sha256: sha("published evidence"), bytes: 18 }] });
    await writeFile(manifestPath, manifest, { mode: 0o600 });
    const evidenceInput = { requestKey: "evidence-retention", finalizationRequestKey: f.input.requestKey, expectedPreparedRevision: original.sequence,
      manifest: { path: manifestPath, sha256: sha(manifest) }, entries: [{ resourceId: evidence.id, retainedPath: retainedFile, sha256: sha("published evidence"), size: 18 }] };
    expect((await f.request("legacy-evidence", evidenceInput)).status).toBe(401);
    const evidenceAdoption = await f.request("legacy-evidence", evidenceInput, true); expect(evidenceAdoption).toMatchObject({ status: 200 });
    const binding = { kind: "original-work", requestKey: "source-retention", finalizationRequestKey: f.input.requestKey, expectedPreparedRevision: original.sequence, expectedPreparedRawDigest: sha(original.value!),
      expectedOperationRevision: operation.sequence, expectedOperationRawDigest: sha(operation.value!), expectedOperationDigest: finalizationDigest(JSON.parse(operation.value!)) };
    const parent = path.join(directory, "source-archive"); await mkdir(parent, { mode: 0o700 });
    const archive = await prepareLegacyOriginalArchive({ taskId: f.task.id, sessionId: f.session.id, toolingRevision: f.task.toolingRevision, worktree: f.worktree, revision: f.task.baseCommit,
      branch: f.task.branchName, archiveRoot: path.join(parent, "source"), ownedPaths: [path.join(f.worktree, "cache")], binding }, { assertAuthority: async () => { await inspectCleanupSupplementAuthority({ prisma: db.prisma, config: f.config, sessionId: f.session.id, requestKey: f.input.requestKey }); } });
    const adopted = await f.request("legacy-evidence", { ...binding, archive }, true); expect(adopted.status).toBe(200);
    const proof = adopted.data.proof.originalWork, inode = (await lstat(f.worktree)).ino;
    if (change !== "none") {
      if (change === "changed-ignored") await writeFile(cache, "new owner material after adoption");
      if (change === "new-ignored") await writeFile(path.join(f.worktree, "cache", "late.bin"), "later ignored material");
      if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
      let effects = 0;
      await expect(finalizeTask({ ...args, manage: async () => { effects++; throw Error("must refuse before effects"); } })).rejects.toThrow();
      expect(effects).toBe(0); expect(closed).toBe(0); expect((await lstat(f.worktree)).ino).toBe(inode);
      expect(await lstat(proof.target.quarantine.path).catch(() => null)).toBeNull();
      expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
      expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: operation.sequence } })).value).toBe(operation.value);
      return;
    }
    await expect(finalizeTask({ ...args, preparedCleanup: { observation: idle, captureHooks: { afterCapture() { throw Error("lost source reply"); } } } })).rejects.toThrow("lost source reply");
    expect((await lstat(proof.target.quarantine.path)).ino).toBe(inode); expect(closed).toBe(0);
    const confirm = registry.confirmFinalization; let lost = false;
    registry.confirmFinalization = async (input: unknown) => { const value = await confirm(input); if (!lost) { lost = true; throw Error("lost confirmation reply"); } return value; };
    await expect(finalizeTask(args)).rejects.toThrow("lost confirmation reply"); expect(closed).toBe(0);
    await db.prisma.$disconnect();
    expect(await finalizeTask({ ...args, manage: async () => { throw Error("must not repeat effects"); }, runner: async () => { throw Error("must not remove twice"); } })).toMatchObject({ closed: true, reporting: { state: "recorded" } });
    expect(closed).toBe(1); expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("closed");
    expect(await readFile(retainedFile, "utf8")).toBe("published evidence"); expect(await readFile(path.join(proof.target.quarantine.path, "cache/result.bin"), "utf8")).toBe("original ignored material");
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: evidence.id } })).state).toBe("released");
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: operation.sequence } })).value).toBe(operation.value);
    expect(await db.prisma.runtimeIssueUpdate.count()).toBe(0); expect(await db.prisma.runtimeSession.count()).toBe(1);
    expect(await finalizeTask(args)).toMatchObject({ alreadyClosed: true, reporting: { state: "recorded" } });
  } finally { await stop(); legacyOriginalWorkDependencies.observation = priorObservation; await f.server.stop(true); }
}, 60_000);


test("direct cleanup uses the existing inbox key and rejects changed verification before delivery", async () => {
  const f = await fixture();
  try {
    const capability = async () => ({ receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
      taskToolingRevision: f.task.toolingRevision, capabilityRevision: "b".repeat(40), checkout: "/immutable/current", instructions: "/immutable/current/cleanup.md", adapter: "/immutable/current/src/cli.ts" }, instructions: "Use the configured cleanup capability." });
    const enqueue = (requestKey: string) => enqueueTaskCleanup({ prisma: db.prisma, config: f.config, taskId: f.task.id, requestKey }, { capability });
    const first = await enqueue("scheduled-pass");
    await db.prisma.$disconnect();
    expect(await enqueue("scheduled-pass")).toEqual(first); expect(await enqueue("another-pass")).toEqual(first);
    expect(await db.prisma.runtimeInstruction.count()).toBe(1);
    expect(await cleanupInstructionAllows(db.prisma, { id: first.instructionId, sessionId: f.session.id })).toBeTrue();
    await f.request("completion/verification", { requestKey: "new-failure", passed: false, evidence: ["New verification invalidates the previous result"] }, true);
    expect(await cleanupInstructionAllows(db.prisma, { id: first.instructionId, sessionId: f.session.id })).toBeFalse();
    expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: first.instructionId } })).state).toBe("cancelled");
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(0);
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toolingRevision).toBe(f.task.toolingRevision);
  } finally { await f.server.stop(true); }
});
