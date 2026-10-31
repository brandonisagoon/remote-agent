import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { prepareTaskFinalization } from "./finalization.ts";
import { bindPreparedCleanup, inspectCleanupSupplementAuthority } from "./cleanup-lifecycle.ts";
import { finalizationDigest, type ResourceObservation } from "./finalization-resources.ts";
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { adoptLegacyOriginalWork, assertLegacyOriginalWorkAuthority, legacyOriginalWorkDependencies, legacyOriginalWorkReceipt } from "./legacy-original-work.ts";
import { assertLegacyOriginalWorkFiles } from "./legacy-original-work-files.ts";
import { LEGACY_ORIGINAL_WORK, LegacyOriginalWorkReceipt, type LegacyOriginalWorkAdoption } from "./legacy-original-work-schema.ts";

let db: TestDatabase, directory: string;
const idle: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
const defaultObservation = legacyOriginalWorkDependencies.observation;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "legacy-original-"))); legacyOriginalWorkDependencies.observation = idle; });
afterEach(async () => { legacyOriginalWorkDependencies.observation = defaultObservation; await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function git(cwd: string, ...args: string[]) { const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); }
async function fixture(taskId = "task") {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  await writeFile(path.join(root, "accepted.txt"), "accepted second commit\n"); git(root, "add", "."); git(root, "commit", "-m", "accepted");
  git(root, "worktree", "add", "-b", "codex/task", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: taskId, requestKey: taskId, repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: root, toolingRevision: "a".repeat(40), phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Blocked", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", branchName: "codex/task", title: "Task", description: "Request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const context = { prisma: db.prisma, config, taskId: task.id };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "owner-verified", passed: true, evidence: ["Owner accepted verified content"] } });
  const head = git(worktree, "rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const observer = { ...completionObservation, remote: async () => remote };
  const input = { prisma: db.prisma, config, sessionId: session.id, requestKey: `finalize:${task.id}` };
  const dependencies = { source: async () => ({ session, link, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, observer), snapshot: completionObservation.snapshot };
  const remove = () => git(root, "worktree", "remove", worktree);
  const revoke = () => setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "revoke", expectedRevision: contract.revision, boundary: "revoked", basis: "Owner withdrew delivery" }) });
  return { root, worktree, config, session, task, issue, states, context, contract, remote, observer, input, dependencies, remove, revoke };
}

async function preparedFixture(configure?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture("original71");
  // Match the actual clean v1 source with deliberately retained ignored bytes.
  await writeFile(path.join(f.root, ".git/info/exclude"), "cache/\n");
  await mkdir(path.join(f.worktree, "cache")); await writeFile(path.join(f.worktree, "cache", "owner-material.bin"), Buffer.from([0, 255, 2]));
  for (let index = 0; index < 56; index++) await db.prisma.remoteTaskResource.create({ data: { id: `original-${index}`, taskId: f.task.id, key: `original-${index}`, kind: index === 55 ? "docker-compose-project" : "evidence", purpose: "development", externalId: `original-external-${index}`, state: index === 55 ? "ready" : "released", metadata: { original: index } } });
  await configure?.(f);
  const prepared = await prepareTaskFinalization(f.input, f.dependencies), active = await bindPreparedCleanup(f.input, async () => {});
  const preparation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.preparedRevision } });
  const operation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: active.operationRevision } });
  const archive = path.join(directory, "archive"); await mkdir(archive, { mode: 0o700 });
  git(f.worktree, "bundle", "create", path.join(archive, "source.bundle"), "refs/heads/codex/task");
  await writeFile(path.join(archive, "index.diff"), "", { mode: 0o600 }); await writeFile(path.join(archive, "worktree.diff"), "", { mode: 0o600 });
  await writeFile(path.join(archive, "untracked.tar"), Buffer.alloc(1024), { mode: 0o600 }); await chmod(path.join(archive, "source.bundle"), 0o600);
  const lines: string[] = []; for (const name of (await readdir(archive)).sort()) lines.push(`${hash(await readFile(path.join(archive, name)))}  ${name}`);
  const manifest = lines.join("\n") + "\n", manifestPath = path.join(archive, "MANIFEST.sha256"); await writeFile(manifestPath, manifest, { mode: 0o600 });
  const adoption: LegacyOriginalWorkAdoption = { kind: "original-work", requestKey: "retain-original", finalizationRequestKey: f.input.requestKey, expectedPreparedRevision: preparation.sequence,
    expectedPreparedRawDigest: hash(preparation.value!), expectedOperationRevision: operation.sequence, expectedOperationRawDigest: hash(operation.value!), expectedOperationDigest: finalizationDigest(active.operation),
    archive: { archiveRoot: archive, manifestPath, manifestSha256: hash(manifest), bundlePath: "source.bundle", bundleRef: "refs/heads/codex/task", indexPatchPath: "index.diff", worktreePatchPath: "worktree.diff", untrackedArchivePath: "untracked.tar", expectedWorkingTree: git(f.worktree, "rev-parse", "HEAD^{tree}"), ownedPaths: [path.join(f.worktree, "cache")] } };
  const frozenResources = JSON.stringify(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } }));
  const app = createApp({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const request = (authorized = true, body = adoption) => app.request(`/api/tasks/${f.task.id}/legacy-evidence`, { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${f.config.apiKey}` } : {}) }, body: JSON.stringify(body) });
  const adopt = () => adoptLegacyOriginalWork({ ...f.context, adoption });
  const unchanged = async () => {
    expect(JSON.stringify(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } }))).toBe(frozenResources);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: preparation.sequence } })).value).toBe(preparation.value);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: operation.sequence } })).value).toBe(operation.value);
  };
  return { ...f, prepared, active, preparation, operation, archive, adoption, app, request, adopt, unchanged };
}

test("authenticated original adoption adds only one archive proof and preserves all56 resources/raw preparation/operation", async () => {
  const f = await preparedFixture();
  expect((await f.request(false)).status).toBe(401);
  const response = await f.request(); const body = await response.json(); expect(response.status).toBe(200);
  const receipt = LegacyOriginalWorkReceipt.parse(body); expect(receipt.proof.originalWork.archive).not.toHaveProperty("resourceId");
  expect(await f.adopt()).toEqual(receipt); expect(await legacyOriginalWorkReceipt(db.prisma, f.active.prepared as never, f.preparation.sequence)).toEqual(receipt);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: LEGACY_ORIGINAL_WORK } })).toBe(1); await f.unchanged();
  expect((await inspectCleanupSupplementAuthority(f.input)).operationRevision).toBe(f.operation.sequence);
  await assertLegacyOriginalWorkAuthority(db.prisma, await inspectCleanupSupplementAuthority(f.input), receipt);
});
test.each(["preparation", "operation", "snapshot", "ignored", "archive", "manifest", "paused"] as const)("owner adoption refuses exact %s drift without granting source authority", async kind => {
  const f = await preparedFixture();
  if (kind === "preparation") f.adoption.expectedPreparedRawDigest = "f".repeat(64);
  if (kind === "operation") f.adoption.expectedOperationRawDigest = "f".repeat(64);
  if (kind === "snapshot") await writeFile(path.join(f.worktree, "README.md"), "unaccepted\n");
  if (kind === "ignored") f.adoption.archive.ownedPaths = [];
  if (kind === "archive") await chmod(path.join(f.archive, "source.bundle"), 0o644);
  if (kind === "manifest") await writeFile(path.join(f.archive, "unlisted"), "extra", { mode: 0o600 });
  if (kind === "paused") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(f.adopt()).rejects.toThrow(); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: LEGACY_ORIGINAL_WORK } })).toBe(0); await f.unchanged();
});
test("a foreign archive claim or raw-only operation change during observation refuses final adoption CAS", async () => {
  const f = await preparedFixture(); let changed = false;
  legacyOriginalWorkDependencies.observation = { ...idle, rootIdle: async () => {
    if (changed) return; changed = true;
    await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.operation.sequence }, data: { value: f.operation.value! + " " } });
  } };
  await expect(f.adopt()).rejects.toThrow("operation bytes changed during adoption");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: LEGACY_ORIGINAL_WORK } })).toBe(0);
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.operation.sequence }, data: { value: f.operation.value } }); changed = false;
  const foreign = await db.prisma.remoteTask.create({ data: { requestKey: "foreign", repositoryId: f.task.repositoryId, machineId: f.task.machineId, branchName: "foreign", toolingRoot: f.root, toolingRevision: "b".repeat(40) } });
  legacyOriginalWorkDependencies.observation = { ...idle, rootIdle: async () => {
    if (changed) return; changed = true;
    await db.prisma.remoteTaskResource.create({ data: { taskId: foreign.id, key: "claim", kind: "directory", purpose: "development", externalId: f.archive, state: "ready" } });
  } };
  await expect(f.adopt()).rejects.toThrow("another task"); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: LEGACY_ORIGINAL_WORK } })).toBe(0);
});
test("adopted archive replacement and changed ignored bytes refuse every full boundary", async () => {
  const f = await preparedFixture(), receipt = await f.adopt(), originalWork = receipt.proof.originalWork;
  const before = await readFile(path.join(f.worktree, "cache/owner-material.bin")); await writeFile(path.join(f.worktree, "cache/owner-material.bin"), "changed");
  await expect(assertLegacyOriginalWorkFiles({ taskId: f.task.id, originalWork, removed: false }, idle)).rejects.toThrow();
  await writeFile(path.join(f.worktree, "cache/owner-material.bin"), before); await writeFile(path.join(f.archive, "index.diff"), "changed");
  await expect(assertLegacyOriginalWorkFiles({ taskId: f.task.id, originalWork, removed: false }, idle)).rejects.toThrow("manifest"); await f.unchanged();
});

test("a thin archive records and rechecks its exact retained common-Git prerequisite", async () => {
  const f = await preparedFixture(), parent = git(f.worktree, "rev-parse", "HEAD^");
  git(f.worktree, "bundle", "create", path.join(f.archive, "source.bundle"), "refs/heads/codex/task", `^${parent}`); await chmod(path.join(f.archive, "source.bundle"), 0o600);
  const names = (await readdir(f.archive)).filter(name => name !== "MANIFEST.sha256").sort(), lines: string[] = [];
  for (const name of names) lines.push(`${hash(await readFile(path.join(f.archive, name)))}  ${name}`);
  const manifest = lines.join("\n") + "\n"; await writeFile(f.adoption.archive.manifestPath, manifest); f.adoption.archive.manifestSha256 = hash(manifest);
  const receipt = await f.adopt(), proof = receipt.proof.originalWork;
  expect("prerequisiteCommits" in proof.restore && proof.restore.prerequisiteCommits).toEqual([parent]);
  await rm(path.join(proof.restore.gitDirectory, "objects", parent.slice(0, 2), parent.slice(2)));
  await expect(assertLegacyOriginalWorkFiles({ taskId: f.task.id, originalWork: proof, removed: false }, idle)).rejects.toThrow(); await f.unchanged();
});

const actual = process.env.DRAFTED_ORIGINAL_SOURCE_INTEGRATION_ROOT ? test : test.skip;
actual("actual owner Unix adoption and native source/admin lost-reply capture preserve all original rows and proof bytes", async () => {
  const f = await preparedFixture(), root = process.env.DRAFTED_ORIGINAL_SOURCE_INTEGRATION_ROOT!;
  const socket = path.join(directory, "owner.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const { prepareLegacyOriginalArchive } = await import(pathToFileURL(path.join(root, "src/legacy-original-archive.ts")).href);
    const ownerRoot = path.join(directory, "owner-retained"); await mkdir(ownerRoot, { mode: 0o700 });
    const { archive: _archive, ...binding } = f.adoption;
    f.adoption.archive = await prepareLegacyOriginalArchive({ taskId: f.task.id, sessionId: f.session.id, toolingRevision: f.task.toolingRevision, worktree: f.worktree,
      revision: f.prepared.revision, branch: f.prepared.branch, prerequisite: git(f.worktree, "rev-parse", "HEAD^"), archiveRoot: path.join(ownerRoot, "source"), ownedPaths: [path.join(f.worktree, "cache")], binding }, { assertAuthority: async () => { await inspectCleanupSupplementAuthority(f.input); } });
    const response = await fetch(`http://localhost/api/tasks/${f.task.id}/legacy-evidence`, { unix: socket, method: "POST", headers: { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(f.adoption) });
    expect(response.status).toBe(200); const receipt = LegacyOriginalWorkReceipt.parse(await response.json()), proof = receipt.proof.originalWork;
    const originalInode = (await lstat(f.worktree)).ino, adminInode = (await lstat(proof.administration.administrationCapture.path)).ino, immutable = JSON.stringify(receipt);
    const { retireArchivedWorktree } = await import(pathToFileURL(path.join(root, "src/archived-worktree.ts")).href);
    const assertAuthority = async () => { await assertLegacyOriginalWorkAuthority(db.prisma, await inspectCleanupSupplementAuthority(f.input), receipt); await assertLegacyOriginalWorkFiles({ taskId: f.task.id, originalWork: proof, removed: false }, idle); };
    const args = { taskId: f.task.id, worktree: f.worktree, revision: proof.snapshot.head, branch: proof.snapshot.branch, gitDirectory: proof.restore.gitDirectory, gitCwd: f.root, target: proof.target, administration: proof.administration, installedDependencies: proof.installedDependencies, observation: idle, assertAuthority };
    await expect(retireArchivedWorktree({ ...args, captureHooks: { afterCapture() { throw new Error("lost source capture reply"); } } })).rejects.toThrow("lost source capture reply");
    expect((await lstat(proof.target.quarantine.path)).ino).toBe(originalInode);
    await expect(retireArchivedWorktree({ ...args, administrationHooks: { afterCapture() { throw new Error("lost admin capture reply"); } } })).rejects.toThrow("lost admin capture reply");
    expect((await lstat(proof.administration.administrationCapture.quarantine.path)).ino).toBe(adminInode);
    await retireArchivedWorktree(args); await assertLegacyOriginalWorkFiles({ taskId: f.task.id, originalWork: proof, removed: true }, idle);
    expect(await f.adopt()).toEqual(receipt); expect(JSON.stringify(receipt)).toBe(immutable); await f.unchanged();
    expect(await lstat(f.worktree).catch(() => null)).toBeNull(); expect(await lstat(proof.administration.administrationCapture.path).catch(() => null)).toBeNull();
    expect(git(f.root, "worktree", "list", "--porcelain")).not.toContain(`worktree ${f.worktree}`);
    expect(await readFile(path.join(proof.target.quarantine.path, "cache/owner-material.bin"))).toEqual(Buffer.from([0, 255, 2]));
    await mkdir(f.worktree); await expect(assertLegacyOriginalWorkFiles({ taskId: f.task.id, originalWork: proof, removed: true }, idle)).rejects.toThrow("recreated");
  } finally { await server.stop(true); }
}, 30_000);

actual("actual v1 finalizer retains stopped Docker data and recovers source/admin/confirmation loss with all56 original IDs", async () => {
  const root = process.env.DRAFTED_ORIGINAL_SOURCE_INTEGRATION_ROOT!;
  const client = (file: string) => import(pathToFileURL(path.join(root, `src/${file}.ts`)).href);
  const { manageResource } = await client("resources"), { taskRegistry } = await client("control"), { finalizeTask } = await client("finalize");
  const { observeCleanupResource } = await client("cleanup-observer"), { prepareLegacyOriginalArchive } = await client("legacy-original-archive"), { run } = await client("process");
  const { legacyComposeFinalizationDependencies: retention } = await import("./legacy-compose-finalization.ts");
  const { cleanupReportDelivery } = await import("./cleanup-report.ts");
  const { startRuntimeEventProjection } = await import("../sessions/runtime-events/projection.ts");
  const savedRetention = { ...retention }, savedReport = { ...cleanupReportDelivery };
  const project = "drafted-original71-development", container = "a".repeat(64), network = "b".repeat(64), volume = `${project}-spatial`;
  const environment = path.join(directory, "environments", "original71"), configFile = path.join(environment, "compose.yml"), journalRoot = path.join(directory, "compose-journal");
  const cutoverDirectory = path.join(directory, "cutovers", project), cutoverFile = path.join(cutoverDirectory, "receipt.private.json");
  await mkdir(environment, { recursive: true, mode: 0o700 }); await writeFile(configFile, "name: retained-original-source\n", { mode: 0o600 });
  await mkdir(cutoverDirectory, { recursive: true, mode: 0o700 });
  const cutover = { project, branchId: "br-original", state: "migrated", startedAt: "2026-10-29T00:22:10.729Z", completedAt: "2026-10-29T00:23:25.270Z",
    files: [configFile, path.join(environment, "spatial.env")].map((file, index) => ({ file, backup: path.join(cutoverDirectory, `file-${index}.backup`) })) };
  await writeFile(cutoverFile, JSON.stringify(cutover), { mode: 0o600 });
  const f = await preparedFixture(async f => {
    await db.prisma.remoteTaskResource.update({ where: { id: "original-55" }, data: { key: "compose-development-r2", externalId: project, metadata: { composeFile: configFile, containers: { spatial: container }, volumes: [volume], network: `${network.slice(0, 12)} (${project}-default)` } } });
    await db.prisma.remoteTaskResource.update({ where: { id: "original-54" }, data: { key: "spatial-neon-development", kind: "neon-branch-database", externalId: "br-original/task_spatial", metadata: { cutoverReceipt: cutoverFile, runtimeDatabase: "task_spatial", supersedes: "local PostGIS in compose-development-r2 (stopped by owner cutover; volume retained; not restarted)" } } });
  });
  const labels = { "dev.drafted.task": f.task.id, "dev.drafted.purpose": "development", "com.docker.compose.project": project };
  const objects = new Map<string, any>([
    [`container:${container}`, { id: container, createdAt: "original-container", running: false, image: "sha256:spatial", labels: { ...labels, "com.docker.compose.service": "spatial", "com.docker.compose.project.config_files": configFile, "com.docker.compose.project.working_dir": environment }, networks: [network], volumes: [volume] }],
    [`network:${network}`, { id: network, name: `${project}-default`, createdAt: "original-network", labels: { ...labels, "com.docker.compose.network": "default" } }],
    [`volume:${volume}`, { id: volume, createdAt: "original-volume", labels }],
  ]);
  let effects = 0, observed = 0, closed = 0;
  const docker = { inspect: async (kind: string, id: string) => structuredClone(objects.get(`${kind}:${id}`) ?? null), resolve: async (kind: string, id: string) => structuredClone([...objects].find(([key, value]) => key.startsWith(`${kind}:`) && (value.id.startsWith(id) || value.name === id))?.[1] ?? null),
    inventory: async (kind: string) => structuredClone([...objects].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value)),
    stop: async () => { effects++; throw Error("Retained source must never stop again"); }, remove: async () => { effects++; throw Error("Retained source must never be removed"); } };
  retention.journalRoot = () => journalRoot;
  retention.resolve = async () => ({ version: 1, source: "configured-host", checkout: root, revision: "a".repeat(40), adapter: path.join(root, "src/cli.ts"), adapterSha256: "b".repeat(64) });
  retention.observe = async input => { observed++; return observeCleanupResource(input.request, { docker, retainedComposeJournalRoot: journalRoot }); };
  cleanupReportDelivery.read = async () => { throw Error("Fixture reporting unavailable"); };
  const socket = path.join(directory, "finalizer.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch }); await chmod(socket, 0o600);
  const stopProjection = startRuntimeEventProjection({ prisma: db.prisma, config: f.config, runtime: createFakeAgentRuntime() }, async () => {});
  try {
    const ownerRoot = path.join(directory, "owner-backup"); await mkdir(ownerRoot, { mode: 0o700 });
    const { archive: _archive, ...binding } = f.adoption;
    f.adoption.archive = await prepareLegacyOriginalArchive({ taskId: f.task.id, sessionId: f.session.id, toolingRevision: f.task.toolingRevision, worktree: f.worktree,
      revision: f.prepared.revision, branch: f.prepared.branch, archiveRoot: path.join(ownerRoot, "source"), ownedPaths: [path.join(f.worktree, "cache")], binding }, { assertAuthority: async () => { await inspectCleanupSupplementAuthority(f.input); } });
    const adopted = await f.request(); expect(adopted.status).toBe(200); const proof = LegacyOriginalWorkReceipt.parse(await adopted.json()).proof.originalWork;
    const originalInode = (await lstat(f.worktree)).ino, adminInode = (await lstat(proof.administration.administrationCapture.path)).ino;
    const rawEvents = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }), rows = await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
    const registry = taskRegistry(socket, f.task.id, 20_000); registry.publishCleanupStatus = undefined;
    const close = async () => { const response = await f.app.request(`/api/tasks/${f.task.id}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "close", cleanup: true }) }); if (!response.ok) throw Error(await response.text()); closed++; };
    const manage = (input: any) => manageResource({ ...input, docker, compose: { journalRoot } });
    const args = { registry, cleanup: true, close, manage, preparedCleanup: { observation: idle } };
    await expect(finalizeTask({ ...args, preparedCleanup: { observation: idle, captureHooks: { afterCapture() { throw Error("lost source capture reply"); } } } })).rejects.toThrow("lost source capture reply");
    expect((await lstat(proof.target.quarantine.path)).ino).toBe(originalInode); expect(closed).toBe(0); expect(effects).toBe(0);
    objects.get(`container:${container}`).running = true;
    await expect(finalizeTask(args)).rejects.toThrow(); expect(closed).toBe(0);
    objects.get(`container:${container}`).running = false;
    const cutoverBytes = await readFile(cutoverFile); await writeFile(cutoverFile, JSON.stringify({ ...cutover, branchId: "br-replaced" }));
    await expect(finalizeTask(args)).rejects.toThrow(); expect(closed).toBe(0); await writeFile(cutoverFile, cutoverBytes);
    let lostAdmin = false;
    await expect(finalizeTask({ ...args, runner: async (command: string[], cwd: string) => { const result = await run(command, cwd); if (!lostAdmin && !await Bun.file(proof.administration.administrationCapture.path + "/HEAD").exists()) { lostAdmin = true; throw Error("lost administration capture reply"); } return result; } })).rejects.toThrow("lost administration capture reply");
    expect((await lstat(proof.administration.administrationCapture.quarantine.path)).ino).toBe(adminInode);
    const confirm = registry.confirmFinalization; let lostConfirmation = false;
    registry.confirmFinalization = async (request: unknown) => { const result = await confirm(request); if (!lostConfirmation) { lostConfirmation = true; throw Error("lost confirmation reply"); } return result; };
    await expect(finalizeTask(args)).rejects.toThrow("lost confirmation reply"); expect(closed).toBe(0);
    expect(await finalizeTask({ ...args, manage: async () => { throw Error("Confirmed retry must not clean resources"); }, runner: async () => { throw Error("Confirmed retry must not capture again"); } })).toMatchObject({ closed: true, reporting: { state: "pending" } });
    expect(closed).toBe(1); expect(effects).toBe(0); expect(observed).toBeGreaterThan(4);
    expect(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } })).toEqual(rows); expect(rows).toHaveLength(56); await f.unchanged();
    for (const event of rawEvents) expect(await db.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: event.sequence } })).toEqual(event);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
    const report = await db.prisma.runtimeIssueUpdate.findFirstOrThrow({ where: { requestKey: `${f.input.requestKey}:cleanup-report` } });
    expect(JSON.stringify(report.input)).toContain("source remains recoverable"); expect(JSON.stringify(report.input)).toContain("stopped migration data");
    expect(git(f.root, "worktree", "list", "--porcelain")).not.toContain(f.worktree);
    let comment: any = null, creates = 0;
    cleanupReportDelivery.read = async () => f.issue as never;
    cleanupReportDelivery.comment = async () => comment;
    cleanupReportDelivery.create = async (_key, input) => { creates++; comment = { id: input.id, issue: { id: input.issueId }, body: input.body, parentId: null }; throw Error("lost published report response"); };
    expect(await finalizeTask({ ...args, manage: async () => { throw Error("Closed retry cannot clean"); } })).toMatchObject({ closed: true, alreadyClosed: true, reporting: { state: "published", reportId: report.id } });
    expect(creates).toBe(1); expect((await db.prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: report.id } })).input).toEqual(report.input);
    await assertLegacyOriginalWorkFiles({ taskId: f.task.id, originalWork: proof, removed: true }, idle);
  } finally { await stopProjection(); await server.stop(true); Object.assign(retention, savedRetention); Object.assign(cleanupReportDelivery, savedReport); }
}, 60_000);
