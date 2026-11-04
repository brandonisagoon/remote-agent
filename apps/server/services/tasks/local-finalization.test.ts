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

test.each(["contract", "verification", "source", "resource", "pause"])("same-operation renewal refuses later %s drift and preserves preparation bytes", async change => {
  const f = await fixture();
  try {
    const prepared = await f.request("prepare-finalization", f.input); expect(prepared.status).toBe(200);
    const raw = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.preparedRevision } });
    if (change === "contract") await f.request("completion/contract", { requestKey: "replaced", expectedRevision: f.contractRevision, boundary: "local-only", basis: "New scope" }, true, "PUT");
    if (change === "verification") await f.request("completion/verification", { requestKey: "later", passed: true, evidence: ["Different verification"] }, true);
    if (change === "source") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { connectionId: f.config.activeConnectionId, issueIdentifier: "DRA-238" } });
    if (change === "resource") await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "late", kind: "evidence", purpose: "development", externalId: path.join(directory, "new"), state: "ready" } });
    if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
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

test.each([false, true])("finished local task prunes ignored files without an archive (historical flag=%s)", async historicalFlag => {
  const f = await fixture("local-only");
  try {
    await writeFile(path.join(f.root, ".git/info/exclude"), "cache/\n");
    await mkdir(path.join(f.worktree, "cache"));
    await writeFile(path.join(f.worktree, "cache/data"), "finished development data");
    const first = await f.request("prepare-finalization", f.input); expect(first.status).toBe(200);
    // Construct the exact pre-upgrade persisted shape. The operation and its
    // preparation remain immutable throughout the cleanup exercised below.
    if (historicalFlag) {
      const preparation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: first.data.preparedRevision } });
      const saved = JSON.parse(preparation.value!); saved.localCompletion.sourceCaptureRequired = true;
      const value = JSON.stringify(saved);
      await db.prisma.runtimeMetadataEvent.update({ where: { sequence: preparation.sequence }, data: { value } });
      const operation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: first.data.cleanup.operationRevision } });
      const bound = JSON.parse(operation.value!); bound.binding.preparedDigest = createHash("sha256").update(value).digest("hex");
      await db.prisma.runtimeMetadataEvent.update({ where: { sequence: operation.sequence }, data: { value: JSON.stringify(bound) } });
    }
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started"] } } });
    const replay = await f.request("prepare-finalization", f.input); expect(replay.status).toBe(200);
    expect(replay.data.localCompletion.sourceCaptureRequired).toBe(historicalFlag);
    await writeFile(path.join(f.worktree, "cache/late"), "disposable late cache");
    expect((await f.request("prepare-finalization", f.input)).status).toBe(200);
    expect((await f.request("confirm-finalization", f.input)).status).toBe(409);
    git(f.root, "worktree", "remove", f.worktree);
    expect((await f.request("confirm-finalization", f.input)).status).toBe(200);
    expect((await f.request("confirm-finalization", f.input)).status).toBe(200);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started"] } } })).toEqual(frozen);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-legacy-original-work" } })).toBe(0);
    expect(await db.prisma.remoteTaskResource.count()).toBe(0);
    expect(await lstat(f.worktree).catch(() => null)).toBeNull();
  } finally { await f.server.stop(true); }
}, 30_000);

test.each(["retained-tooling", "retained-archive", "foreign-resource", "foreign-worktree"])("finished source pruning preserves %s", async condition => {
  const f = await fixture();
  try {
    if (condition.startsWith("retained")) await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "retained", kind: condition === "retained-archive" ? "evidence-archive" : "evidence", purpose: condition === "retained-archive" ? "development" : "tooling", externalId: path.join(f.worktree, "retained"), state: "ready" } });
    else {
      const other = await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, branchName: "other", toolingRoot: f.root, toolingRevision: "a".repeat(40), ...(condition === "foreign-worktree" ? { worktreePath: path.join(f.worktree, "other") } : {}) } });
      if (condition === "foreign-resource") await db.prisma.remoteTaskResource.create({ data: { taskId: other.id, key: "shared", kind: "evidence", purpose: "development", externalId: path.join(f.worktree, "shared"), state: "ready" } });
    }
    expect((await f.request("prepare-finalization", f.input)).status).toBe(409);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(0);
    expect((await lstat(f.worktree)).isDirectory()).toBeTrue();
  } finally { await f.server.stop(true); }
}, 15_000);

const actual = process.env.DRAFTED_LOCAL_FINALIZATION_ROOT ? test : test.skip;
actual.each([false, true, "adopted"])("actual client prunes finished development without an archive (historical flag=%s)", async historicalFlag => {
  const f = await fixture("local-only"), root = process.env.DRAFTED_LOCAL_FINALIZATION_ROOT!;
  const client = (file: string) => import(pathToFileURL(path.join(root, `src/${file}.ts`)).href);
  const { finalizeTask } = await client("finalize"), { taskRegistry, closeTask } = await client("control"), { manageResource } = await client("resources");
  const stop = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime: createFakeAgentRuntime() }, async () => {});
  try {
    await writeFile(path.join(f.root, ".git/info/exclude"), "cache/\n"); await mkdir(path.join(f.worktree, "cache"));
    await writeFile(path.join(f.worktree, "cache/data"), "disposable finished bytes");
    const ownedRoot = path.join(directory, f.task.id); await mkdir(ownedRoot);
    const evidenceFile = path.join(ownedRoot, "development.txt"), retainedFile = path.join(ownedRoot, "retained.txt");
    await writeFile(evidenceFile, "development evidence"); await writeFile(retainedFile, "explicit retained evidence");
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "development", kind: "evidence", purpose: "development", externalId: evidenceFile, state: "ready", metadata: { sha256: sha("development evidence"), bytes: 20 } } });
    const retained = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "retained", kind: "evidence", purpose: "tooling", externalId: retainedFile, state: "ready", metadata: { sha256: sha("explicit retained evidence"), bytes: 26 } } });
    const prepared = await f.request("prepare-finalization", f.input); expect(prepared.status).toBe(200);
    if (historicalFlag === true) {
      const event = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.preparedRevision } });
      const value = JSON.parse(event.value!); value.localCompletion.sourceCaptureRequired = true;
      const raw = JSON.stringify(value);
      await db.prisma.runtimeMetadataEvent.update({ where: { sequence: event.sequence }, data: { value: raw } });
      const operation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.cleanup.operationRevision } });
      const bound = JSON.parse(operation.value!); bound.binding.preparedDigest = sha(raw);
      await db.prisma.runtimeMetadataEvent.update({ where: { sequence: operation.sequence }, data: { value: JSON.stringify(bound) } });
    }
    let adopted: any;
    if (historicalFlag === "adopted") {
      const { prepareLegacyOriginalArchive } = await client("legacy-original-archive");
      const event = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.preparedRevision } });
      const operation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.cleanup.operationRevision } });
      const binding = { kind: "original-work", requestKey: "historical-mandatory-adoption", finalizationRequestKey: f.input.requestKey,
        expectedPreparedRevision: event.sequence, expectedPreparedRawDigest: sha(event.value!), expectedOperationRevision: operation.sequence,
        expectedOperationRawDigest: sha(operation.value!), expectedOperationDigest: finalizationDigest(JSON.parse(operation.value!)) };
      const parent = path.join(directory, "historical-archive"); await mkdir(parent, { mode: 0o700 });
      const idle = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
      const prior = legacyOriginalWorkDependencies.observation; legacyOriginalWorkDependencies.observation = idle;
      try {
        const archive = await prepareLegacyOriginalArchive({ taskId: f.task.id, sessionId: f.session.id, toolingRevision: f.task.toolingRevision,
          worktree: f.worktree, revision: f.task.baseCommit, branch: f.task.branchName, archiveRoot: path.join(parent, "source"), ownedPaths: [path.join(f.worktree, "cache")], binding },
          { assertAuthority: async () => { await inspectCleanupSupplementAuthority({ prisma: db.prisma, config: f.config, sessionId: f.session.id, requestKey: f.input.requestKey }); } });
        const response = await f.request("legacy-evidence", { ...binding, archive }, true); expect(response.status).toBe(200);
        adopted = response.data.proof.originalWork;
      } finally { legacyOriginalWorkDependencies.observation = prior; }
    }
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started", "finalization-legacy-original-work"] } } });
    const registry = taskRegistry(f.socket, f.task.id, 20_000);
    expect(await finalizeTask({ registry, cleanup: true, close: () => closeTask(f.socket, f.task.id), manage: (input: any) => manageResource(input) })).toMatchObject({ closed: true, reporting: { state: "recorded" } });
    expect(await lstat(f.worktree).catch(() => null)).toBeNull();
    expect(await lstat(evidenceFile).catch(() => null)).toBeNull();
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).state).toBe("released");
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: retained.id } })).toEqual(retained);
    expect(await readFile(retainedFile, "utf8")).toBe("explicit retained evidence");
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("closed");
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started", "finalization-legacy-original-work"] } } })).toEqual(frozen);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "legacy-evidence-retained" } })).toBe(0);
    if (adopted) {
      expect((await lstat(adopted.archive.root)).isDirectory()).toBeTrue();
      expect(await lstat(adopted.target.quarantine.path).catch(() => null)).toBeNull();
      expect(await lstat(adopted.administration.administrationCapture.quarantine.path).catch(() => null)).toBeNull();
    }
    expect(await finalizeTask({ registry, cleanup: true, close: () => closeTask(f.socket, f.task.id) })).toMatchObject({ alreadyClosed: true });
  } finally { await stop(); await f.server.stop(true); }
}, 60_000);

actual.each(["none", "changed-ignored", "new-ignored", "pause", "changed-manifest", "changed-manifest-copy", "tooling-directory", "tooling-kind", "shared-copy-root"])("actual client preserves unlinked source and evidence through capture/retry (late change=%s)", async change => {
  const f = await fixture(), root = process.env.DRAFTED_LOCAL_FINALIZATION_ROOT!;
  const client = (file: string) => import(pathToFileURL(path.join(root, `src/${file}.ts`)).href);
  const { finalizeTask } = await client("finalize"), { taskRegistry, closeTask } = await client("control"), { manageResource } = await client("resources");
  const { prepareLegacyEvidence } = await client("legacy-evidence");
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
    // Exact actual task shape: six development evidence files and two tooling
    // manifest FILES inside a prior archive. All copies live in a disjoint root.
    const copied = [{ resource: evidence, path: "evidence.txt", bytes: "published evidence" }];
    for (let index = 1; index < 8; index++) {
      const tooling = index >= 6, name = `evidence-${index}.txt`, bytes = `original retained material ${index}`;
      const source = tooling ? path.join(directory, "original-retained", index === 6 ? "RETENTION.json" : "lifecycle/RETENTION.json") : path.join(path.dirname(sourceEvidence), name);
      await mkdir(path.dirname(source), { recursive: true, mode: 0o700 }); await writeFile(source, bytes, { mode: 0o600 }); await writeFile(path.join(retainedRoot, name), bytes, { mode: 0o600 });
      const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: name, kind: "evidence", purpose: tooling ? "tooling" : "development", externalId: source, state: "ready", metadata: { sha256: sha(bytes), bytes: Buffer.byteLength(bytes) } } });
      copied.push({ resource, path: name, bytes });
    }
    const retainedRecords = copied.filter(item => item.resource.purpose === "tooling").map(item => structuredClone(item.resource));
    const registry = taskRegistry(f.socket, f.task.id, 20_000); let removals = 0, closed = 0;
    const close = async () => { await closeTask(f.socket, f.task.id); closed++; };
    const manage = (input: any) => manageResource(input);
    const args = { registry, cleanup: true, close, manage, preparedCleanup: { observation: idle } };
    expect((await f.request("prepare-finalization", f.input)).status).toBe(200);
    expect(removals).toBe(0); expect(closed).toBe(0); expect(await readFile(cache, "utf8")).toBe("original ignored material");
    const prepared = await f.request("prepare-finalization", { ...f.input, authorityOnly: true }); expect(prepared.status).toBe(200);
    expect(prepared.data.localCompletion.sourceCaptureRequired).toBe(false);
    const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.preparedRevision } });
    const operation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.cleanup.operationRevision } });
    const manifestPath = path.join(retainedRoot, "RETENTION.json"), manifest = JSON.stringify({ task: f.task.id, retainedArchive: retainedRoot, sourceUnchanged: true, files: copied.map(item => ({ path: item.path, sha256: sha(item.bytes), bytes: Buffer.byteLength(item.bytes) })) });
    await writeFile(manifestPath, manifest, { mode: 0o600 });
    const evidenceInput = { requestKey: "evidence-retention", finalizationRequestKey: f.input.requestKey, expectedPreparedRevision: original.sequence,
      manifest: { path: manifestPath, sha256: sha(manifest) }, entries: copied.map(item => ({ resourceId: item.resource.id, retainedPath: path.join(retainedRoot, item.path), sha256: sha(item.bytes), size: Buffer.byteLength(item.bytes) })) };
    if (["tooling-directory", "tooling-kind", "shared-copy-root"].includes(change)) {
      let input: any = structuredClone(evidenceInput);
      if (change === "tooling-directory") input.entries[6] = { type: "tree", resourceId: copied[6]!.resource.id, retainedPath: path.join(retainedRoot, copied[6]!.path), inventoryDigest: "a".repeat(64) };
      if (change === "tooling-kind") await db.prisma.remoteTaskResource.update({ where: { id: copied[6]!.resource.id }, data: { kind: "private-file" } });
      if (change === "shared-copy-root") {
        const shared = path.join(path.dirname(retainedRecords[0]!.externalId), "copies"); await mkdir(shared, { mode: 0o700 });
        for (const item of copied) await writeFile(path.join(shared, item.path), item.bytes, { mode: 0o600 });
        const bytes = JSON.stringify({ task: f.task.id, retainedArchive: shared, sourceUnchanged: true, files: copied.map(item => ({ path: item.path, sha256: sha(item.bytes), bytes: Buffer.byteLength(item.bytes) })) });
        const file = path.join(shared, "RETENTION.json"); await writeFile(file, bytes, { mode: 0o600 });
        input = { ...input, manifest: { path: file, sha256: sha(bytes) }, entries: copied.map(item => ({ resourceId: item.resource.id, retainedPath: path.join(shared, item.path), sha256: sha(item.bytes), size: Buffer.byteLength(item.bytes) })) };
      }
      expect((await f.request("legacy-evidence", input, true)).status).toBe(409);
      expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "legacy-evidence-retained" } })).toBe(0);
      expect(removals).toBe(0); expect(closed).toBe(0); expect(await readFile(retainedRecords[0]!.externalId, "utf8")).toBe(copied[6]!.bytes);
      return;
    }
    expect(await prepareLegacyEvidence({ registry, configuration: { requestKey: evidenceInput.requestKey, finalizationRequestKey: evidenceInput.finalizationRequestKey,
      expectedPreparedRevision: evidenceInput.expectedPreparedRevision, manifest: evidenceInput.manifest,
      copies: copied.map(item => ({ resourceKey: item.resource.key, retainedPath: path.join(retainedRoot, item.path) })) } })).toEqual(evidenceInput);
    expect((await f.request("legacy-evidence", evidenceInput)).status).toBe(401);
    const evidenceAdoption = await f.request("legacy-evidence", evidenceInput, true); expect(evidenceAdoption).toMatchObject({ status: 200 });
    expect(evidenceAdoption.data.proof.entries).toHaveLength(8);
    const retainedEntry = evidenceAdoption.data.proof.entries.find((entry: any) => entry.purpose === "tooling");
    const retainedOperation = { resourceKey: retainedEntry.key, action: "authorize", proofRevision: evidenceAdoption.data.proofRevision, proofDigest: evidenceAdoption.data.proofDigest, preparedRevision: original.sequence, finalizationRequestKey: f.input.requestKey };
    const forbidden = await fetch(`http://localhost/api/sessions/${f.session.id}/legacy-evidence`, { unix: f.socket, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(retainedOperation) });
    expect(forbidden.status).toBe(409);
    const retainedResource = retainedRecords[0]!;
    await expect(registry.resource({ key: retainedResource.key, kind: retainedResource.kind, purpose: "tooling", externalId: retainedResource.externalId, state: "allocated", metadata: retainedResource.metadata })).rejects.toThrow();
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: retainedResource.id } })).toEqual(retainedResource);
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
      if (change === "changed-manifest") await writeFile(retainedRecords[0]!.externalId, "changed original manifest");
      if (change === "changed-manifest-copy") await writeFile(path.join(retainedRoot, copied[6]!.path), "changed copied manifest");
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
    for (const record of retainedRecords) {
      expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: record.id } })).toEqual(record);
      expect(await readFile(record.externalId, "utf8")).toBe(copied.find(item => item.resource.id === record.id)!.bytes);
    }
    expect(await db.prisma.remoteTaskResource.count()).toBe(8);
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


test.each(["delegate", "moved-descendant", "pending", "primary-role", "primary-owner"])("inventory-read liveness preserves direct cleanup %s guards", async condition => {
  const f = await fixture("local-only");
  try {
    expect((await f.request("prepare-finalization", f.input)).status).toBe(200);
    const first = await f.request("cleanup-inventory-ownership", { requestKey: f.input.requestKey }); expect(first.status).toBe(200);
    if (["delegate", "moved-descendant"].includes(condition)) {
      const child = await db.prisma.runtimeSession.create({ data: { scopeKey: "child", agentCommand: "codex", status: "active", role: "delegate", cwd: condition === "delegate" ? f.worktree : path.join(directory, "moved"), repositoryId: f.task.repositoryId, machineId: f.task.machineId } });
      await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: child.id, targetSessionId: f.session.id, relationship: "spawned-by" } });
    }
    if (condition === "pending") await db.prisma.runtimeInstruction.create({ data: { id: "pending", sessionId: f.session.id, text: "Owner work", state: "queued" } });
    if (condition === "primary-role") await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
    if (condition === "primary-owner") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { primarySessionId: null } });
    expect((await f.request("cleanup-inventory-ownership", { requestKey: f.input.requestKey, ownershipEpoch: first.data.ownershipEpoch })).status).toBe(409);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(0);
  } finally { f.server.stop(true); }
}, 15_000);
