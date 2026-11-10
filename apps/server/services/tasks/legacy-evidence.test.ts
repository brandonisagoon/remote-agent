import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, open, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { privateBackupFixture } from "../../../../test-support/private-backup.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import type { RemoteTask, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { prepareTaskFinalization, confirmTaskFinalization } from "./finalization.ts";
import { bindPreparedCleanup, assertCleanupResourceUpdate } from "./cleanup-lifecycle.ts";
import { enqueueTaskCleanup } from "./cleanup-inbox.ts";
import { observeLegacyEvidenceTree, isEvidenceTree } from "./legacy-evidence-tree.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { adoptLegacyEvidence, assertLegacyEvidenceResourceUpdate, legacyEvidenceDependencies, legacyEvidenceProjection, manageLegacyEvidence } from "./legacy-evidence.ts";
import { LegacyEvidenceAdoptionInput, type LegacyEvidenceReceipt, type LegacyEvidenceOperationInput } from "./legacy-evidence-schema.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { computeTaskIdentity, offerNextCompute, requestCompute } from "./compute-admission.ts";
import { reclaimStoppedCompute } from "./compute-reclamation.ts";
import { assertComputeStartIntent } from "./development-intent.ts";
import type { readInstalledComputeReclamation } from "./compute-observer.ts";
import { evidenceWriterObservation } from "./legacy-evidence-writers.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "legacy-evidence-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]) { const command = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }); if (command.exitCode) throw new Error(command.stderr.toString()); return command.stdout.toString().trim(); }

async function fixture(options: { historicalSizeBytes?: boolean; taskId?: string; directoryEvidence?: boolean; directoryPurpose?: "development" | "review"; files?: number; privateBackup?: boolean; beforePrepare?: (task: RemoteTask) => Promise<void> } = {}) {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree"), historical = path.join(directory, options.historicalSizeBytes ? `dra52-${options.taskId ?? "task"}-evidence` : "DRA-99"), archive = path.join(directory, "retained");
  for (const dir of [root, historical, archive]) await mkdir(dir, { mode: 0o700 });
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture"); git(root, "worktree", "add", "-b", "codex/legacy", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: options.taskId ?? "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-99", primarySessionId: session.id, branchName: "codex/legacy", worktreePath: worktree, toolingRoot: root, toolingRevision: "a".repeat(40), phase: "complete" } });
  const sourceLink = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-99", relationship: "handles" } });
  const context = { prisma: db.prisma, config, taskId: task.id };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "verified", passed: true, evidence: ["Accepted"] } });
  const head = git(worktree, "rev-parse", "HEAD"), remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/legacy", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const issue = { id: "issue", identifier: "DRA-99", branchName: "codex/legacy", title: "Task", description: "Request", state: { id: "merge", name: "Merge", type: "started" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const observer = { ...completionObservation, remote: async () => remote };
  const dependencies = { source: async () => ({ session, link: sourceLink, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, observer), snapshot: completionObservation.snapshot };
  const resources: RemoteTaskResource[] = [], files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const [index, body] of Array.from({ length: options.files ?? 2 }, (_, index) => index === 0 ? "saved capture\n" : index === 1 ? "sentinel without historical proof\n" : `sentinel ${index}\n`).entries()) {
    const name = `evidence-${index}.txt`, original = path.join(historical, name), retained = path.join(archive, name);
    await writeFile(original, body, { mode: 0o600 }); await copyFile(original, retained); await chmod(retained, 0o600);
    resources.push(await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: `capture-${index}`, kind: "evidence", purpose: index === 0 ? "development" : "browser", externalId: original, state: "ready", metadata: options.historicalSizeBytes ? { sha256: sha(body), sizeBytes: Buffer.byteLength(body), description: "original receipt" } : index === 0 ? { sha256: sha(body), bytes: Buffer.byteLength(body), description: "original receipt" } : { description: "legacy sentinel" } } }));
    files.push({ path: name, sha256: sha(body), bytes: Buffer.byteLength(body) });
  }
  let treeResource: RemoteTaskResource | undefined;
  if (options.directoryEvidence) {
    const original = path.join(directory, "environment", "logs", "turns"), retained = path.join(archive, "turns");
    await mkdir(original, { recursive: true, mode: 0o700 }); await mkdir(retained, { mode: 0o700 });
    for (let index = 0; index < 29; index++) {
      const name = `turn-${index}.ndjson`, body = `saved turn ${index}\n`;
      await writeFile(path.join(original, name), body, { mode: 0o600 }); await writeFile(path.join(retained, name), body, { mode: 0o600 });
      files.push({ path: `turns/${name}`, sha256: sha(body), bytes: Buffer.byteLength(body) });
    }
    treeResource = await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "turns", kind: "evidence", purpose: options.directoryPurpose ?? "development", externalId: original, state: "ready", metadata: { description: "original directory receipt" } } });
    await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "environment-parent", kind: "directory", purpose: "development", externalId: path.join(directory, "environment"), state: "allocated" } });
  }
  await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "old-browser", kind: "browser", purpose: "browser", externalId: "already-gone", state: "released", metadata: { preserved: true } } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "clerk", kind: "clerk", purpose: "development", externalId: "unclaimed.example.test", state: "unknown" } });
  const backup = options.privateBackup ? await privateBackupFixture(path.join(directory, "private-backup"), task.id, task.issueIdentifier!) : undefined;
  if (backup) await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "saved-backup", kind: "private-backup", purpose: "development", externalId: backup.root, state: "ready", metadata: backup.metadata } });
  await options.beforePrepare?.(task);
  const finalInput = { prisma: db.prisma, config, sessionId: session.id, requestKey: `finalize:${task.id}` };
  const prepared = await prepareTaskFinalization(finalInput, dependencies);
  const manifestPath = path.join(archive, "RETENTION.json"), manifestBytes = JSON.stringify({ task: task.id, retainedArchive: archive, files, sourceUnchanged: true });
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const adoption: LegacyEvidenceAdoptionInput = { requestKey: "retain-legacy", finalizationRequestKey: prepared.requestKey, expectedPreparedRevision: prepared.preparedRevision,
    manifest: { path: manifestPath, sha256: sha(manifestBytes) }, entries: resources.map((resource, index) => ({ resourceId: resource.id, retainedPath: path.join(archive, files[index]!.path), sha256: files[index]!.sha256, size: files[index]!.bytes })) };
  if (treeResource) { const tree = await observeLegacyEvidenceTree(treeResource.externalId); adoption.entries.push({ type: "tree", resourceId: treeResource.id, retainedPath: path.join(archive, "turns"), inventoryDigest: tree.inventoryDigest }); }
  const manageDependencies = { prepare: (input: Parameters<typeof prepareTaskFinalization>[0]) => prepareTaskFinalization(input, dependencies) };
  const app = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const adopt = () => adoptLegacyEvidence({ ...context, adoption });
  const manage = (receipt: LegacyEvidenceReceipt, key: string, action: LegacyEvidenceOperationInput["action"]) => manageLegacyEvidence({ ...finalInput, operation: { resourceKey: key, action, proofRevision: receipt.proofRevision, proofDigest: receipt.proofDigest, preparedRevision: prepared.preparedRevision, finalizationRequestKey: prepared.requestKey } }, manageDependencies);
  return { config, task, session, root, worktree, historical, archive, resources, treeResource, backup, files, prepared, context, finalInput, dependencies, manageDependencies, contract, issue, app, adoption, adopt, manage };
}

async function capture(receipt: LegacyEvidenceReceipt, index = 0, intentOnly = false) {
  const entry = receipt.proof.entries[index]!, target = entry.target, q = target.quarantine;
  const source = target.type === "file" ? target : target.inventory.find(entry => entry.path === ".")!;
  await mkdir(q.directory, { mode: 0o700 }); const stat = await lstat(q.directory);
  await writeFile(q.journal, JSON.stringify({ version: 1, taskId: receipt.proof.taskId, resourceId: entry.resourceId, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: q.path,
    source: { dev: source.dev, ino: source.ino, mode: source.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600 });
  if (!intentOnly) await rename(target.path, q.path);
}

test("owner-only adoption preserves the exact v1 receipt and records missing digest as a new observation", async () => {
  const f = await fixture(); const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } }); f.issue.state.name = "Blocked";
  const request = (authorized: boolean) => f.app.request(`/api/tasks/${f.task.id}/legacy-evidence`, { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${f.config.apiKey}` } : {}) }, body: JSON.stringify(f.adoption) });
  expect((await request(false)).status).toBe(401);
  const response = await request(true); expect(response.status).toBe(200); const receipt = await response.json() as LegacyEvidenceReceipt;
  expect(receipt.proof.entries[0]!.recorded).toEqual({ sha256: f.files[0]!.sha256, size: f.files[0]!.bytes });
  expect(receipt.proof.entries[1]!.recorded).toEqual({}); expect(receipt.proof.entries[1]!.digestProvenance).toBe("observed-at-adoption");
  expect(await f.adopt()).toEqual(receipt);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
  expect(await db.prisma.remoteTaskResource.findUnique({ where: { id: f.resources[1]!.id } })).toEqual(f.resources[1]);
  expect((await f.manage(receipt, "capture-0", "inspect")).proofDigest).toBe(receipt.proofDigest);
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("open complete");
  expect((await (await f.app.request("/api/tasks/task")).json()).task.legacyEvidenceRetention).toEqual(receipt);
});

test("partial capture and lost confirmation resume without rewriting receipts or releasing Clerk", async () => {
  const f = await fixture(), receipt = await f.adopt();
  expect(await f.manage(receipt, "capture-0", "authorize")).toMatchObject({ proofRevision: receipt.proofRevision });
  await capture(receipt, 0, true);
  await expect(f.manage(receipt, "capture-0", "confirm")).rejects.toThrow("still present");
  await f.manage(receipt, "capture-0", "authorize");
  await rename(receipt.proof.entries[0]!.target.path, receipt.proof.entries[0]!.target.quarantine.path);
  const first = await f.manage(receipt, "capture-0", "confirm"); expect(first.confirmedRevision).toBeDefined();
  expect(await f.manage(receipt, "capture-0", "confirm")).toEqual(first);
  expect((await f.manage(receipt, "capture-0", "inspect")).confirmedRevision).toBe(first.confirmedRevision);
  await db.prisma.$disconnect(); expect(await f.adopt()).toEqual(receipt);
  expect(await legacyEvidenceProjection(db.prisma, f.config, f.task)).toEqual({ legacyEvidenceRetentionRequired: true, legacyEvidenceRetention: receipt });
  await capture(receipt, 1); await f.manage(receipt, "capture-1", "confirm");
  for (const original of f.resources) expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: original.id } })).metadata).toEqual(original.metadata);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: "clerk" } } })).state).toBe("unknown");
  expect(await prepareTaskFinalization(f.finalInput, f.dependencies)).toEqual(f.prepared);
  git(f.root, "worktree", "remove", f.worktree);
  await expect(confirmTaskFinalization(f.finalInput, f.dependencies)).rejects.toThrow("unreleased");
  expect((await readFile(receipt.proof.entries[0]!.target.quarantine.path)).length).toBe(f.files[0]!.bytes);
});

test("generic resource writes and metadata claims cannot fabricate retained retirement", async () => {
  const f = await fixture();
  await db.prisma.remoteTaskResource.update({ where: { id: f.resources[0]!.id }, data: { metadata: { ...f.resources[0]!.metadata as object, legacyEvidenceRetention: { verified: true } } } });
  expect(await legacyEvidenceProjection(db.prisma, f.config, f.task)).toEqual({});
  const receipt = await f.adopt();
  const old = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resources[0]!.id } });
  const response = await f.app.request("/api/sessions/primary/task/resources", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: old.key, kind: old.kind, purpose: old.purpose, externalId: old.externalId, state: "released", metadata: old.metadata }) });
  expect(response.status).toBe(409);
  await db.prisma.remoteTaskResource.update({ where: { id: old.id }, data: { state: "released" } });
  expect(await legacyEvidenceProjection(db.prisma, f.config, f.task)).toEqual({ legacyEvidenceRetentionRequired: true });
  await expect(f.manage(receipt, old.key, "inspect")).rejects.toThrow("without independent");
});

test.each([
  { bytes: 1, size: 2 }, { bytes: 1, sizeBytes: 2 }, { sizeBytes: -1 }, { bytes: -1 }, { sha256: "invalid" }, { sha256: "0".repeat(64) },
])("conflicting or changed historical proof is refused: %j", async (metadata) => {
  const f = await fixture(); await db.prisma.remoteTaskResource.update({ where: { id: f.resources[0]!.id }, data: { metadata } });
  await expect(f.adopt()).rejects.toThrow(); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "legacy-evidence-retained" } })).toBe(0);
});

test.each(["bytes", "byteSize", "size", "sizeBytes"])("retention adoption verifies %s and preserves the historical receipt", async sizeKey => {
  const f = await fixture();
  const original = f.resources[0]!;
  const previous = original.metadata as { sha256: string; bytes: number };
  const metadata = { sha256: previous.sha256, [sizeKey]: previous.bytes, description: "Unchanged historical receipt" };
  await db.prisma.remoteTaskResource.update({ where: { id: original.id }, data: { metadata } });
  const receipt = await f.adopt();
  expect(receipt.proof.entries.find(entry => entry.resourceId === original.id)?.recorded).toEqual({ sha256: previous.sha256, size: previous.bytes });
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: original.id } })).metadata).toEqual(metadata);
});

test("changed original or retained bytes cannot be authorized or confirmed", async () => {
  const f = await fixture(), receipt = await f.adopt();
  await writeFile(f.resources[0]!.externalId, "owner edit"); await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("changed");
  await capture(receipt, 1); await writeFile(receipt.proof.entries[1]!.retained.path, "different archive");
  await expect(f.manage(receipt, "capture-1", "confirm")).rejects.toThrow("changed");
  expect(await db.prisma.remoteTaskResource.count({ where: { kind: "evidence", state: "released" } })).toBe(0);
});

test.each(["symlink", "hardlink", "public-archive", "missing-copy", "inside-worktree"])("unsafe archive/source shape is refused: %s", async (kind) => {
  const f = await fixture();
  if (kind === "symlink") { const source = f.resources[0]!.externalId; await rename(source, `${source}.original`); await symlink(`${source}.original`, source); }
  if (kind === "hardlink") await link(f.resources[0]!.externalId, `${f.resources[0]!.externalId}.link`);
  if (kind === "public-archive") await chmod(f.archive, 0o755);
  if (kind === "missing-copy") await rm(f.adoption.entries[0]!.retainedPath);
  if (kind === "inside-worktree") { const replacement = path.join(f.worktree, "evidence.txt"); await rename(f.resources[0]!.externalId, replacement); await db.prisma.remoteTaskResource.update({ where: { id: f.resources[0]!.id }, data: { externalId: replacement } }); }
  await expect(f.adopt()).rejects.toThrow();
});

test("paused, replaced pin, revoked contract and stale prepared revision cannot authorize cleanup", async () => {
  const f = await fixture(), receipt = await f.adopt();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } }); await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("authority");
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: false, toolingRevision: "b".repeat(40) } }); await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("changed");
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: f.task.toolingRevision } });
  f.issue.state.name = "Blocked"; await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("current owner Merge"); f.issue.state.name = "Merge";
  await setCompletionContract({ ...f.context, contract: CompletionContractInput.parse({ requestKey: "revoked", expectedRevision: f.contract.revision, boundary: "revoked", basis: "Withdrawn" }) });
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("revoked");
});

test("capture confirmation rechecks source authority after physical observations", async () => {
  const f = await fixture(), receipt = await f.adopt(); await capture(receipt);
  let calls = 0;
  await expect(manageLegacyEvidence({ ...f.finalInput, operation: { resourceKey: "capture-0", action: "confirm", proofRevision: receipt.proofRevision, proofDigest: receipt.proofDigest, preparedRevision: receipt.proof.preparedRevision, finalizationRequestKey: receipt.proof.finalizationRequestKey } }, { prepare: async (input) => {
    if (++calls === 2) f.issue.state.name = "Blocked"; return prepareTaskFinalization(input, f.dependencies);
  } })).rejects.toThrow("current owner Merge");
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resources[0]!.id } })).state).toBe("ready");
});

test("foreign/subset receipts, post-preparation receipts and missing prepared history cannot be adopted", async () => {
  const f = await fixture();
  await expect(adoptLegacyEvidence({ ...f.context, adoption: { ...f.adoption, entries: f.adoption.entries.slice(0, 1) } })).rejects.toThrow("complete exact");
  await expect(adoptLegacyEvidence({ ...f.context, adoption: { ...f.adoption, expectedPreparedRevision: f.contract.revision } })).rejects.toThrow("exact existing");
  await db.prisma.remoteTaskResource.update({ where: { id: f.resources[0]!.id }, data: { createdAt: new Date(Date.now() + 10_000) } });
  await expect(f.adopt()).rejects.toThrow("original prepared provenance");
});

test("a replaced captured inode or forged journal cannot stand in for retirement", async () => {
  const f = await fixture(), receipt = await f.adopt(); await capture(receipt);
  const entry = receipt.proof.entries[0]!, captured = entry.target.quarantine.path;
  await rename(captured, `${captured}.preserved`); await copyFile(entry.retained.path, captured);
  await expect(f.manage(receipt, "capture-0", "confirm")).rejects.toThrow();
  await rm(captured); await rename(`${captured}.preserved`, captured);
  const journal = JSON.parse(await readFile(entry.target.quarantine.journal, "utf8"));
  await writeFile(entry.target.quarantine.journal, JSON.stringify({ ...journal, taskId: "other-task" }));
  await expect(f.manage(receipt, "capture-0", "confirm")).rejects.toThrow("immutable proof");
});

test("database uniqueness protects immutable adoption and per-resource confirmation across concurrent callers", async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([f.adopt(), f.adopt()]);
  expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
  const receipt = await f.adopt();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "legacy-evidence-retained" } })).toBe(1);
  const event = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: receipt.proofRevision } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: event.runtimeSessionId, action: event.action, source: event.source, key: "different-key", value: event.value } }))).rejects.toThrow();
  await capture(receipt); await f.manage(receipt, "capture-0", "confirm");
  const confirmation = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "legacy-evidence-confirmed" } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: confirmation.runtimeSessionId, action: confirmation.action, source: confirmation.source, key: confirmation.key, value: confirmation.value } }))).rejects.toThrow();
});

test("a later cleanup resource cannot absorb the retained archive or captured originals", async () => {
  const f = await fixture(), receipt = await f.adopt();
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "new-root", kind: "source-copies", purpose: "development", externalId: f.archive, state: "ready" } });
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("overlaps");
  expect(await legacyEvidenceProjection(db.prisma, f.config, f.task)).toEqual({ legacyEvidenceRetentionRequired: true });
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { externalId: f.historical } });
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("overlaps");
  expect(await readFile(f.resources[0]!.externalId, "utf8")).toBe("saved capture\n");
});

test("an original retained tooling parent is not a whole-tree cleanup operation", async () => {
  const f = await fixture();
  const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } });
  const parent = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "task-evidence-archive", kind: "directory", purpose: "tooling", externalId: f.historical, state: "ready", metadata: { archive: true, retained: true, root: f.historical } } });
  const receipt = await f.adopt();
  await f.manage(receipt, "capture-0", "authorize"); await capture(receipt); await f.manage(receipt, "capture-0", "confirm");
  expect((await lstat(f.historical)).isDirectory()).toBeTrue();
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: parent.id } })).toEqual(parent);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
  await db.prisma.remoteTaskResource.update({ where: { id: parent.id }, data: { purpose: "development" } });
  await expect(f.manage(receipt, "capture-1", "authorize")).rejects.toThrow("overlaps");
  expect(await readFile(f.resources[1]!.externalId, "utf8")).toBe("sentinel without historical proof\n");
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;

test.skipIf(!draftedRoot)("DRA52 seven-file sizeBytes receipts keep their registered directory and original cleanup binding", async () => {
  const f = await fixture({ files: 7, historicalSizeBytes: true }), receipt = await f.adopt();
  const originalPrepare = legacyEvidenceDependencies.prepare;
  legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
  const server = Bun.serve({ unix: path.join(directory, "dra52-evidence.sock"), fetch: f.app.fetch });
  try {
    const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
    const { manageEvidenceResource } = await import(path.join(draftedRoot!, "src/evidence-resources.ts"));
    const registry = taskRegistry(path.join(directory, "dra52-evidence.sock"), f.task.id);
    expect(f.historical.split(path.sep)).not.toContain(f.task.id);
    for (const original of f.resources) {
      expect((await manageEvidenceResource({ registry, key: original.key, action: "release" })).observed).toBe("evidence-retired-archive-retained");
      expect((await manageEvidenceResource({ registry, key: original.key, action: "release" })).state).toBe("released");
      expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: original.id } })).metadata).toEqual(original.metadata);
    }
    expect(await prepareTaskFinalization(f.finalInput, f.dependencies)).toEqual(f.prepared);
    for (const entry of receipt.proof.entries) {
      expect(await lstat(entry.target.path).catch(() => null)).toBeNull();
      if (entry.target.type === "file") expect(sha(await readFile(entry.retained.path))).toBe(entry.target.sha256);
    }
  } finally { await server.stop(true); legacyEvidenceDependencies.prepare = originalPrepare; }
}, 30_000);
test("saved evidence supplements an already bound cleanup without replacing its original records", async () => {
  const f = await fixture({ privateBackup: true });
  const active = await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started", "finalization-archive-retention"] } } });
  expect(frozen.length).toBe(3);
  const receipt = await f.adopt();
  const renewed = await prepareTaskFinalization({ ...f.finalInput, cleanup: true, authorityOnly: true }, f.dependencies);
  expect(renewed.cleanup).toEqual(active.cleanup);
  await f.manage(receipt, "capture-0", "authorize");
  await capture(receipt);
  const confirmed = await f.manage(receipt, "capture-0", "confirm");
  expect(await f.manage(receipt, "capture-0", "confirm")).toEqual(confirmed);
  expect(await f.adopt()).toEqual(receipt);
  for (const event of frozen) expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: event.sequence } })).toEqual(event);
  const supplement = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-cleanup-evidence-supplement" } });
  const value = JSON.parse(supplement.value!);
  expect(value.operationRevision).toBe(active.cleanup!.operationRevision);
  expect(value.evidence.revision).toBe(receipt.proofRevision);
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: supplement.runtimeSessionId, source: supplement.source, action: supplement.action, key: supplement.key, value: supplement.value } }))).rejects.toThrow();
});

test.each(["pause", "pin", "resource", "revocation"])("evidence supplementation refuses existing operation drift before adopting: %s", async change => {
  const f = await fixture();
  await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
  if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (change === "pin") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "b".repeat(40) } });
  if (change === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resources[1]!.id }, data: { metadata: { description: "changed ownership" } } });
  if (change === "revocation") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "delivered-retirement-revoked", key: "withdrawn", value: JSON.stringify({ basis: "Owner revoked cleanup" }) } });
  await expect(f.adopt()).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: ["legacy-evidence-retained", "finalization-cleanup-evidence-supplement"] } } })).toBe(0);
  expect(await readFile(f.resources[0]!.externalId, "utf8")).toBe("saved capture\n");
});

test.each(["missing", "operation", "preparation", "proof", "proof-bytes"])("a missing or altered evidence supplement cannot change an operation: %s", async change => {
  const f = await fixture(); await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies); const receipt = await f.adopt();
  const event = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-cleanup-evidence-supplement" } });
  const value = JSON.parse(event.value!);
  if (change === "missing") await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: event.sequence } });
  else if (change === "proof-bytes") {
    const proof = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: receipt.proofRevision } });
    await db.prisma.runtimeMetadataEvent.update({ where: { sequence: proof.sequence }, data: { value: proof.value + " " } });
  } else {
    if (change === "operation") value.operationRevision++;
    if (change === "preparation") value.preparedDigest = "0".repeat(64);
    if (change === "proof") value.evidence.digest = "0".repeat(64);
    await db.prisma.runtimeMetadataEvent.update({ where: { sequence: event.sequence }, data: { value: JSON.stringify(value) } });
  }
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow();
  expect(await readFile(f.resources[0]!.externalId, "utf8")).toBe("saved capture\n");
});

test("authenticated adoption retry repairs an old late proof without replacing proof or operation bytes", async () => {
  const f = await fixture(); await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies); const receipt = await f.adopt();
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started", "legacy-evidence-retained"] } } });
  // Reproduce the historical endpoint outcome before supplements existed.
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: "finalization-cleanup-evidence-supplement" } });
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("authority");
  const request = (authorized: boolean) => f.app.request(`/api/tasks/${f.task.id}/legacy-evidence`, { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${f.config.apiKey}` } : {}) }, body: JSON.stringify(f.adoption) });
  expect((await request(false)).status).toBe(401);
  const response = await request(true); expect(response.status).toBe(200); expect(await response.json()).toEqual(receipt);
  await db.prisma.$disconnect();
  await f.manage(receipt, "capture-0", "authorize");
  expect(await f.adopt()).toEqual(receipt);
  for (const event of frozen) expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: event.sequence } })).toEqual(event);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-cleanup-evidence-supplement" } })).toBe(1);
});

test("idle owner adoption does not waive the original automatic cleanup turn or pending work", async () => {
  const f = await fixture();
  const capability = async () => ({ receipt: { contract: "remote-agent.tooling-capability/v1" as const, capability: "cleanup" as const, source: "configured-host" as const,
    taskToolingRevision: f.task.toolingRevision, capabilityRevision: "b".repeat(40), checkout: "/fixture/immutable", instructions: "/fixture/immutable/cleanup.md", adapter: "/fixture/immutable/src/cli.ts" }, instructions: "Fixture cleanup adapter" });
  const start = async (key: string) => {
    const queued = await enqueueTaskCleanup({ ...f.context, requestKey: key }, { capability });
    await db.prisma.runtimeInstruction.update({ where: { id: queued.instructionId }, data: { state: "dispatching", executionRequestId: key } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: key, runtimeSessionId: f.session.id, requestId: key, phase: "started", occurredAt: new Date() } });
    return queued;
  };
  const first = await start("first");
  const active = await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
  await db.prisma.runtimeInstruction.update({ where: { id: first.instructionId }, data: { state: "completed" } });
  const receipt = await f.adopt();
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("exact executing");
  await start("second");
  await f.manage(receipt, "capture-0", "authorize");
  expect((await prepareTaskFinalization({ ...f.finalInput, cleanup: true, authorityOnly: true }, f.dependencies)).cleanup).toEqual(active.cleanup);
  await db.prisma.runtimeInstruction.create({ data: { id: "new-owner-work", sessionId: f.session.id, text: "Owner follow-up", state: "queued" } });
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow("pending task instructions");
  expect(await readFile(f.resources[0]!.externalId, "utf8")).toBe("saved capture\n");
});

test.each(["retained-copy", "pause", "pin", "revocation"])("bound evidence authority still refuses %s before capture", async change => {
  const f = await fixture();
  await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
  const receipt = await f.adopt();
  if (change === "retained-copy") await writeFile(receipt.proof.entries[0]!.retained.path, "changed retained bytes\n");
  if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (change === "pin") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "b".repeat(40) } });
  if (change === "revocation") await setCompletionContract({ ...f.context, contract: CompletionContractInput.parse({ requestKey: "revoked", expectedRevision: f.contract.revision, boundary: "revoked", basis: "Withdrawn" }) });
  await expect(f.manage(receipt, "capture-0", "authorize")).rejects.toThrow();
  expect(await readFile(f.resources[0]!.externalId, "utf8")).toBe("saved capture\n");
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resources[0]!.id } })).state).toBe("ready");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { source: `legacy-evidence:${f.task.id}`, action: "legacy-evidence-confirmed" } })).toBe(0);
});

test.skipIf(!draftedRoot)("actual client retires20 files and a directory with the same supplemented operation after lost acknowledgment", async () => {
  const f = await fixture({ files: 20, directoryEvidence: true, privateBackup: true });
  const active = await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started", "finalization-archive-retention"] } } });
  expect(frozen.length).toBe(3);
  const response = await f.app.request(`/api/tasks/${f.task.id}/legacy-evidence`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.config.apiKey}` }, body: JSON.stringify(f.adoption) });
  expect(response.status).toBe(200);
  const receipt = await response.json() as LegacyEvidenceReceipt;
  expect(receipt.proof.entries.length).toBe(21);
  const originalPrepare = legacyEvidenceDependencies.prepare; legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
  const socket = path.join(directory, "supplement.sock"); let lost = false;
  const server = Bun.serve({ unix: socket, fetch: async request => {
    const operation = new URL(request.url).pathname.endsWith("/legacy-evidence") ? await request.clone().json() : null;
    const result = await f.app.fetch(request);
    if (operation?.resourceKey === "turns" && operation?.action === "confirm" && result.ok && !lost) { lost = true; return Response.json({ error: "Lost retained directory acknowledgment" }, { status: 500 }); }
    return result;
  } });
  try {
    const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
    const { manageEvidenceResource } = await import(path.join(draftedRoot!, "src/evidence-resources.ts"));
    const registry = taskRegistry(socket, f.task.id);
    for (const entry of receipt.proof.entries) {
      if (isEvidenceTree(entry)) {
        await expect(manageEvidenceResource({ registry, key: entry.key, action: "release" })).rejects.toThrow("Lost retained directory acknowledgment");
        await db.prisma.$disconnect();
      }
      expect((await manageEvidenceResource({ registry, key: entry.key, action: "release" })).state).toBe("released");
      expect(await lstat(entry.target.path).catch(() => null)).toBeNull();
      if (isEvidenceTree(entry)) expect(await readFile(path.join(entry.retained.path, "turn-28.ndjson"), "utf8")).toBe("saved turn 28\n");
      else expect(sha(await readFile(entry.retained.path))).toBe(entry.target.sha256);
    }
    expect(lost).toBeTrue();
    expect(await f.adopt()).toEqual(receipt);
    expect((await registry.task()).cleanupOperation.operationRevision).toBe(active.cleanup!.operationRevision);
    for (const original of [...f.resources, f.treeResource!]) expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: original.id } })).metadata).toEqual(original.metadata);
    for (const event of frozen) expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: event.sequence } })).toEqual(event);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-cleanup-evidence-supplement" } })).toBe(1);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "legacy-evidence-confirmed" } })).toBe(21);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: f.task.id, key: "saved-backup" } } })).state).toBe("ready");
    expect((await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies)).cleanup).toEqual(active.cleanup);
  } finally { await server.stop(true); legacyEvidenceDependencies.prepare = originalPrepare; }
}, 30_000);

test.skipIf(!draftedRoot)("bound cleanup checks each evidence copy without repeating whole-task fingerprints", async () => {
  const f = await fixture({ files: 6, privateBackup: true }), receipt = await f.adopt();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
  const before = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } });
  const snapshot = f.dependencies.snapshot;
  let fingerprints = 0;
  f.dependencies.snapshot = async (...args) => { fingerprints++; return snapshot(...args); };
  const originalPrepare = legacyEvidenceDependencies.prepare;
  legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
  const socket = path.join(directory, "bounded-evidence.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
    const { manageLegacyEvidence: manage } = await import(path.join(draftedRoot!, "src/legacy-evidence.ts"));
    const registry = taskRegistry(socket, f.task.id);
    for (const entry of receipt.proof.entries) {
      expect((await manage({ registry, key: entry.key, action: "release" })).observed).toBe("evidence-retired-archive-retained");
      expect(await lstat(entry.target.path).catch(() => null)).toBeNull();
      expect(sha(await readFile(entry.retained.path))).toBe(entry.target.type === "file" ? entry.target.sha256 : "unexpected tree");
    }
    expect(fingerprints).toBe(0);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: before.sequence } })).value).toBe(before.value);
    // The full finalizer boundary still observes the worktree and archives.
    await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
    expect(fingerprints).toBeGreaterThan(0);
    await writeFile(path.join(f.worktree, "README.md"), "later source edit\n");
    await expect(prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies)).rejects.toThrow("worktree changed");
  } finally { await server.stop(true); legacyEvidenceDependencies.prepare = originalPrepare; }
}, 30_000);

test.skipIf(!draftedRoot)("actual Drafted adapter, control socket and server confirm retain bytes across lost response", async () => {
  const f = await fixture(), receipt = await f.adopt();
  const originalPrepare = legacyEvidenceDependencies.prepare;
  legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
  const socket = path.join(directory, "control.sock"); let lost = false, confirmations = 0;
  const server = Bun.serve({ unix: socket, fetch: async (request) => {
    const isOperation = new URL(request.url).pathname === "/api/sessions/primary/legacy-evidence";
    const operation = isOperation ? await request.clone().json() : null;
    const response = await f.app.fetch(request);
    if (operation?.action === "confirm" && response.ok) {
      confirmations++;
      if (!lost) { lost = true; return Response.json({ error: "Lost acknowledgment after confirmation committed" }, { status: 500 }); }
    }
    return response;
  } });
  await chmod(socket, 0o600);
  try {
    const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
    const { manageEvidenceResource } = await import(path.join(draftedRoot!, "src/evidence-resources.ts"));
    const registry = taskRegistry(socket, "task");
    expect((await registry.task()).legacyEvidenceRetention).toEqual(receipt);
    await expect(manageEvidenceResource({ registry, key: "capture-0", action: "release" })).rejects.toThrow("Lost acknowledgment");
    const entry = receipt.proof.entries[0]!;
    if (entry.target.type !== "file") throw new Error("Expected file fixture");
    const captured = await lstat(entry.target.quarantine.path);
    expect(captured.ino).toBe(entry.target.ino);
    expect((await manageEvidenceResource({ registry, key: "capture-0", action: "release" })).observed).toBe("evidence-retired-archive-retained");
    expect(confirmations).toBe(1);
    expect((await lstat(entry.target.quarantine.path)).ino).toBe(captured.ino);
    expect(sha(await readFile(entry.retained.path))).toBe(entry.target.sha256);
    expect(await prepareTaskFinalization(f.finalInput, f.dependencies)).toEqual(f.prepared);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: "clerk" } } })).state).toBe("unknown");
  } finally { server.stop(true); legacyEvidenceDependencies.prepare = originalPrepare; }
});

test("complete26-file plus directory adoption retains the original v1 event and captures outside parent cleanup", async () => {
  const f = await fixture({ files: 26, directoryEvidence: true });
  const before = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } });
  const receipt = await f.adopt(), entry = receipt.proof.entries.find(isEvidenceTree)!;
  expect(receipt.proof.entries.length).toBe(27);
  expect(entry.target.inventory.length).toBe(30);
  expect(entry.recorded).toEqual({});
  expect("sha256" in entry.target).toBeFalse();
  expect(path.dirname(entry.target.quarantine.directory)).toBe(directory);
  expect(entry.target.quarantine.directory.startsWith(path.join(directory, "environment") + path.sep)).toBeFalse();
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: before.sequence } })).value).toBe(before.value);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.treeResource!.id } })).toEqual(f.treeResource!);
  const parent = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: f.task.id, key: "environment-parent" } } });
  await expect(assertLegacyEvidenceResourceUpdate(db.prisma, parent, { state: "released", metadata: parent.metadata, expiresAt: parent.expiresAt })).rejects.toThrow("confirmed directory");
  await f.manage(receipt, entry.key, "authorize");
  await capture(receipt, receipt.proof.entries.indexOf(entry), true);
  await expect(f.manage(receipt, entry.key, "confirm")).rejects.toThrow("still present");
  await f.manage(receipt, entry.key, "authorize");
  await rename(entry.target.path, entry.target.quarantine.path);
  const confirmed = await f.manage(receipt, entry.key, "confirm");
  expect(confirmed.confirmedRevision).toBeDefined();
  await assertLegacyEvidenceResourceUpdate(db.prisma, parent, { state: "released", metadata: parent.metadata, expiresAt: parent.expiresAt });
  await rm(parent.externalId, { recursive: true }); // only the now-empty disposable parent
  await db.prisma.$disconnect();
  expect(await f.manage(receipt, entry.key, "confirm")).toEqual(confirmed);
  expect(await f.adopt()).toEqual(receipt);
  expect(await readFile(path.join(entry.target.quarantine.path, "turn-0.ndjson"), "utf8")).toBe("saved turn 0\n");
  expect(await readFile(path.join(entry.retained.path, "turn-0.ndjson"), "utf8")).toBe("saved turn 0\n");
});

test.each(["missing-copy", "changed-copy", "file-swap", "symlink", "hardlink", "shared-mode"])("directory adoption refuses %s without changing originals", async failure => {
  const f = await fixture({ directoryEvidence: true }), source = f.treeResource!.externalId, retained = path.join(f.archive, "turns");
  if (failure === "missing-copy") await rm(path.join(retained, "turn-0.ndjson"));
  if (failure === "changed-copy") await writeFile(path.join(retained, "turn-0.ndjson"), "changed\n");
  if (failure === "file-swap") { await rename(source, source + "-preserved"); await writeFile(source, "replacement file", { mode: 0o600 }); }
  if (failure === "symlink") await symlink(path.join(source, "turn-0.ndjson"), path.join(source, "another"));
  if (failure === "hardlink") await link(path.join(source, "turn-0.ndjson"), path.join(directory, "shared"));
  if (failure === "shared-mode") await chmod(source, 0o777);
  await expect(f.adopt()).rejects.toThrow();
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.treeResource!.id } })).state).toBe("ready");
  expect(await lstat(source)).toBeDefined();
});

test("directory capture waits for writers and rejects later retained/source substitutions", async () => {
  const f = await fixture({ directoryEvidence: true }), receipt = await f.adopt(), entry = receipt.proof.entries.find(isEvidenceTree)!;
  const writer = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "writer", kind: "local-http", purpose: "development", externalId: "http://127.0.0.1:12345", state: "ready" } });
  await expect(f.manage(receipt, entry.key, "authorize")).rejects.toThrow("writers");
  await db.prisma.remoteTaskResource.update({ where: { id: writer.id }, data: { state: "released" } });
  const handle = await open(path.join(entry.target.path, "turn-0.ndjson"), "a");
  try { await expect(f.manage(receipt, entry.key, "authorize")).rejects.toThrow("open files"); } finally { await handle.close(); }
  await f.manage(receipt, entry.key, "authorize");
  await rename(path.join(entry.retained.path, "turn-0.ndjson"), path.join(entry.retained.path, "old"));
  await writeFile(path.join(entry.retained.path, "turn-0.ndjson"), "saved turn 0\n", { mode: 0o600 });
  await expect(f.manage(receipt, entry.key, "authorize")).rejects.toThrow();
  expect(await lstat(entry.target.path)).toBeDefined();
});

test("an independently stopped writer does not require its failed DNS preview to be released", async () => {
  const f = await fixture({ directoryEvidence: true }), receipt = await f.adopt(), entry = receipt.proof.entries.find(isEvidenceTree)!;
  const preview = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "development-preview-proxy", kind: "local-http", purpose: "development", externalId: "http://127.0.0.1:12345", state: "allocated", metadata: { publicUrl: "https://fixture.example.test", observed: { error: "Cloudflare 403" } } } });
  let observations = 0;
  const dependencies = { ...f.manageDependencies, writers: async () => { observations++; return async () => {}; } };
  await manageLegacyEvidence({ ...f.finalInput, operation: { resourceKey: entry.key, action: "authorize", proofRevision: receipt.proofRevision, proofDigest: receipt.proofDigest, preparedRevision: f.prepared.preparedRevision, finalizationRequestKey: receipt.proof.finalizationRequestKey } }, dependencies);
  expect(observations).toBe(1);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: preview.id } })).toEqual(preview);
});

test("directory evidence cannot be omitted or overlap another task", async () => {
  const f = await fixture({ directoryEvidence: true });
  const missing = { ...f.adoption, entries: f.adoption.entries.slice(0, -1) };
  await expect(adoptLegacyEvidence({ ...f.context, adoption: missing })).rejects.toThrow("complete exact");
  await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", repositoryId: f.task.repositoryId, machineId: f.task.machineId, connectionId: f.task.connectionId, issueIdentifier: "OTHER", worktreePath: path.join(directory, "other-work"), branchName: "other", toolingRoot: f.task.toolingRoot, toolingRevision: f.task.toolingRevision } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "other", key: "shared", kind: "directory", purpose: "development", externalId: f.treeResource!.externalId, state: "ready" } });
  await expect(f.adopt()).rejects.toThrow("another task");
});

test.skipIf(!draftedRoot)("actual Drafted directory capture uses both pinned parents and resumes lost confirmation", async () => {
  const f = await fixture({ files: 26, directoryEvidence: true }), receipt = await f.adopt(), entry = receipt.proof.entries.find(isEvidenceTree)!;
  const originalPrepare = legacyEvidenceDependencies.prepare; legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
  const socket = path.join(directory, "directory.sock"); let lost = false, confirmations = 0;
  const server = Bun.serve({ unix: socket, fetch: async request => {
    const operation = new URL(request.url).pathname.endsWith("/legacy-evidence") ? await request.clone().json() : null;
    const response = await f.app.fetch(request);
    if (operation?.action === "confirm" && response.ok) { confirmations++; if (!lost) { lost = true; return Response.json({ error: "Lost directory acknowledgment" }, { status: 500 }); } }
    return response;
  } });
  await chmod(socket, 0o600);
  try {
    const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
    const { manageLegacyEvidence: clientManage, assertLegacyEvidenceParentRelease } = await import(path.join(draftedRoot!, "src/legacy-evidence.ts"));
    const registry = taskRegistry(socket, f.task.id);
    let task = await registry.task(); const parent = task.resources.find((resource: any) => resource.key === "environment-parent");
    await expect(assertLegacyEvidenceParentRelease(registry, task, parent)).rejects.toThrow("confirmed directory");
    await expect(clientManage({ registry, key: entry.key, action: "release", hooks: { afterJournal() { throw new Error("interrupted before capture"); } } })).rejects.toThrow("interrupted before capture");
    expect((await lstat(entry.target.path)).ino).toBe(entry.target.inventory[0]!.ino);
    await expect(clientManage({ registry, key: entry.key, action: "release" })).rejects.toThrow("Lost directory acknowledgment");
    const captured = await lstat(entry.target.quarantine.path), journal = await readFile(entry.target.quarantine.journal);
    expect((await clientManage({ registry, key: entry.key, action: "release" })).state).toBe("released");
    expect(confirmations).toBe(1);
    expect((await lstat(entry.target.quarantine.path)).ino).toBe(captured.ino);
    expect(await readFile(entry.target.quarantine.journal)).toEqual(journal);
    task = await registry.task(); await assertLegacyEvidenceParentRelease(registry, task, parent);
    expect(task.resources.filter((resource: any) => resource.kind === "evidence" && resource.state === "ready").length).toBe(26);
    expect(await readFile(path.join(entry.retained.path, "turn-28.ndjson"), "utf8")).toBe("saved turn 28\n");
  } finally { server.stop(true); legacyEvidenceDependencies.prepare = originalPrepare; }
});


test.skipIf(!draftedRoot)("waiting cleanup preserves its private backup and original evidence proofs through pause and directory capture", async () => {
  const f = await fixture({ directoryEvidence: true, privateBackup: true }), receipt = await f.adopt();
  const before = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } });
  const proofBefore = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: receipt.proofRevision } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } }); f.issue.state.name = "Owner selected custom status";
  const active = await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies);
  expect("cleanup" in active && active.cleanup).toBeTruthy();
  const originalPrepare = legacyEvidenceDependencies.prepare;
  legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
  const socket = path.join(directory, "cleanup.sock"), server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
    const { manageLegacyEvidence: manage } = await import(path.join(draftedRoot!, "src/legacy-evidence.ts"));
    const registry = taskRegistry(socket, f.task.id), tree = receipt.proof.entries.find(isEvidenceTree)!;
    await expect(manage({ registry, key: tree.key, action: "release", hooks: { beforeCapture: async () => {
      await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    } } })).rejects.toThrow("Saved archive proof is unavailable");
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).ownerPaused).toBeTrue();
    expect((await lstat(tree.target.path)).isDirectory()).toBeTrue();
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    const result = await manage({ registry, key: tree.key, action: "release" });
    expect(result.observed).toBe("evidence-retired-archive-retained");
    expect((await lstat(tree.target.quarantine.path)).isDirectory()).toBeTrue();
    expect((await manage({ registry, key: tree.key, action: "release" })).observed).toBe(result.observed);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: tree.resourceId } })).metadata).toEqual(f.treeResource!.metadata);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: before.sequence } })).value).toBe(before.value);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: proofBefore.sequence } })).value).toBe(proofBefore.value);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: f.task.id, key: "saved-backup" } } })).state).toBe("ready");
    expect(await readFile(path.join(f.backup!.root, "development/mysql.sql"), "utf8")).toBe("retained SQL\n");
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: f.task.id, key: "clerk" } } })).state).toBe("unknown");
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("waiting");
  } finally { await server.stop(true); legacyEvidenceDependencies.prepare = originalPrepare; }
}, 30_000);

test.skipIf(!draftedRoot || process.platform !== "darwin")("actual stopped native writer allows retained directory capture despite Allocated DNS failure and lost confirmation", async () => {
  const { evidenceWriterFixture } = await import(path.join(draftedRoot!, "test/fixtures/evidence-writer.ts"));
  const { observeEvidenceWriters } = await import(path.join(draftedRoot!, "src/cleanup-observer-writers.ts"));
  const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
  const { manageLegacyEvidence: clientManage } = await import(path.join(draftedRoot!, "src/legacy-evidence.ts"));
  let writer: Awaited<ReturnType<typeof evidenceWriterFixture>> | undefined;
  const original = { ...evidenceWriterObservation }, oldPrepare = legacyEvidenceDependencies.prepare;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const f = await fixture({ taskId: `dra211-${crypto.randomUUID()}`, directoryEvidence: true, directoryPurpose: "review", privateBackup: true, beforePrepare: async task => {
      writer = await evidenceWriterFixture({ id: task.id, primarySessionId: task.primarySessionId, worktreePath: task.worktreePath, toolingRevision: task.toolingRevision });
      await writer.reconcile();
      for (const resource of writer.task.resources) await db.prisma.remoteTaskResource.create({ data: { ...resource, taskId: task.id } });
    } });
    const active = await prepareTaskFinalization({ ...f.finalInput, cleanup: true }, f.dependencies), receipt = await f.adopt();
    const before = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started", "finalization-archive-retention"] } }, orderBy: { sequence: "asc" } });
    expect(before.length).toBe(3);
    const tree = receipt.proof.entries.find(isEvidenceTree)!;
    legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
    evidenceWriterObservation.resolve = async () => ({ version: 1, source: "configured-host", checkout: draftedRoot!, revision: "a".repeat(40), adapter: path.join(draftedRoot!, "src/cli.ts"), adapterSha256: "a".repeat(64) });
    evidenceWriterObservation.observe = async ({ request }) => observeEvidenceWriters(request);
    const socket = path.join(directory, "stopped-writers.sock"); let lost = false;
    server = Bun.serve({ unix: socket, fetch: async request => {
      const op = new URL(request.url).pathname.endsWith("/legacy-evidence") ? await request.clone().json() : null;
      const response = await f.app.fetch(request);
      if (op?.action === "confirm" && response.ok && !lost) { lost = true; return Response.json({ error: "Lost capture response" }, { status: 500 }); }
      return response;
    } });
    const registry = taskRegistry(socket, f.task.id);
    await expect(clientManage({ registry, key: tree.key, action: "release" })).rejects.toThrow("running writer");
    expect((await lstat(tree.target.path)).isDirectory()).toBeTrue();
    await writer!.stop();
    for (const resource of writer!.task.resources) await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: resource.metadata } });
    const preview = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "writer-id" } });
    const pidFile = writer!.pidFile, pidBytes = await readFile(pidFile);
    await expect(clientManage({ registry, key: tree.key, action: "release", hooks: { beforeCapture: async () => {
      await rename(pidFile, `${pidFile}.original`); await writeFile(pidFile, pidBytes, { mode: 0o600 });
    } } })).rejects.toThrow("identity changed");
    expect((await lstat(tree.target.path)).isDirectory()).toBeTrue();
    await rename(pidFile, `${pidFile}.replacement`); await rename(`${pidFile}.original`, pidFile);
    await expect(clientManage({ registry, key: tree.key, action: "release" })).rejects.toThrow("Lost capture response");
    const captured = await lstat(tree.target.quarantine.path), journal = await readFile(tree.target.quarantine.journal);
    expect((await clientManage({ registry, key: tree.key, action: "release" })).state).toBe("released");
    expect((await lstat(tree.target.quarantine.path)).ino).toBe(captured.ino);
    expect(await readFile(tree.target.quarantine.journal)).toEqual(journal);
    expect(await readFile(path.join(tree.target.quarantine.path, "turn-28.ndjson"), "utf8")).toBe("saved turn 28\n");
    expect(await readFile(path.join(tree.retained.path, "turn-28.ndjson"), "utf8")).toBe("saved turn 28\n");
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "writer-id" } })).toEqual(preview);
    expect(preview.state).toBe("allocated");
    expect(JSON.stringify(preview.metadata)).toContain("Cloudflare 403");
    for (const event of before) expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: event.sequence } })).toEqual(event);
    expect((await prepareTaskFinalization({ ...f.finalInput, cleanup: true, authorityOnly: true }, f.dependencies)).cleanup).toEqual(active.cleanup);
  } finally { server?.stop(true); Object.assign(evidenceWriterObservation, original); legacyEvidenceDependencies.prepare = oldPrepare; await writer?.dispose(); }
}, 30_000);


test("closed original operation uses its adopted evidence and refuses new owner adoption", async () => {
  const f = await fixture(), saved = await f.adopt();
  await bindPreparedCleanup(f.finalInput, async () => {});
  const frozen = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const closedAt = new Date();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed", closedAt } });
  await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: f.session.id }, data: { endedAt: closedAt } });
  await expect(f.adopt()).rejects.toThrow("open original primary");
  const entry = saved.proof.entries[0]!;
  expect(await f.manage(saved, entry.key, "authorize")).toBeDefined();
  await capture(saved);
  expect(await f.manage(saved, entry.key, "confirm")).toBeDefined();
  expect(await f.manage(saved, entry.key, "confirm")).toBeDefined();
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
  expect(await readFile(path.join(f.archive, f.files[0]!.path), "utf8")).toBe("saved capture\n");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(f.manage(saved, entry.key, "authorize")).rejects.toThrow();
});


async function cleanupComputeFixture() {
  const configuration = { configurationFile: "/private/original-compute.json", configurationSha256: "b".repeat(64) };
  const f = await fixture({ beforePrepare: async task => {
    await db.prisma.remoteTaskResource.create({ data: { id: "original-app", taskId: task.id, key: "app", kind: "task-runtime", purpose: "development", externalId: "/private/original-runtime.json", state: "ready", metadata: { compute: configuration, containerId: "c".repeat(64) } } });
  } });
  f.config.compute = ComputePolicy.parse({ enabled: true, slots: 1 });
  await f.adopt();
  await bindPreparedCleanup(f.finalInput, async () => {});
  const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "original-app" } });
  const source = await db.prisma.runtimeSessionResourceLink.findFirstOrThrow({ where: { runtimeSessionId: f.session.id, relationship: "handles" } });
  const environment = await db.prisma.computeEnvironment.create({ data: { id: crypto.randomUUID(), taskId: f.task.id, primarySessionId: f.session.id, machineId: f.config.machine,
    taskIdentity: computeTaskIdentity(f.task, f.session.id, f.config.machine, source.id), key: resource.key, purpose: "development", revision: "d".repeat(40), recipeDigest: "e".repeat(64),
    resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest, state: "running", configuration } });
  const offer = await db.prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: environment.id, machineId: f.config.machine, instructionId: "original-app-start", state: "running", dispatchDeadline: new Date(), claimedAt: new Date() } });
  await db.prisma.computeSlot.create({ data: { id: `${f.config.machine}:0`, machineId: f.config.machine, ordinal: 0, allocationId: offer.id } });
  await db.prisma.$transaction(async tx => {
    await assertCleanupResourceUpdate({ ...f.finalInput, prisma: tx, taskId: f.task.id }, resource, { state: "released", expiresAt: null });
    await tx.remoteTaskResource.update({ where: { id: resource.id }, data: { state: "released" } });
  });
  // Active cleanup can be recorded as Working; that projection must not let
  // the original claim restart the already removed application.
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working" } });
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "active" } });
  await db.prisma.runtimeInstruction.create({ data: { id: "remaining-cleanup", sessionId: f.session.id, state: "dispatching", executionRequestId: "cleanup-turn", text: "Finish the accepted cleanup" } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: "cleanup-turn:start", runtimeSessionId: f.session.id, requestId: "cleanup-turn", phase: "started", occurredAt: new Date() } });
  const runtime = { observeSessionActivity: (id: string) => ({ state: id === f.session.id ? "executing" as const : "unknown" as const, observedAt: Date.now(), ...(id === f.session.id ? { requestId: "cleanup-turn" } : {}) }) };
  const input = { prisma: db.prisma, config: f.config, runtime, environmentId: environment.id };
  const read: typeof readInstalledComputeReclamation = async (_input, _task, raw: any) => ({ version: 1, kind: "compute-reclamation", environmentId: raw.environment.id, taskId: raw.task.id, primarySessionId: raw.task.primarySessionId,
    resourceId: raw.resource.id, resourceIdentity: raw.resource.identityDigest, allocationResourceIdentity: raw.allocationResourceIdentity, configurationDigest: raw.configurationDigest, observedAt: Date.now(), state: "absent", proofDigest: "f".repeat(64) });
  return { ...f, resource, environment, offer, input, read };
}

test("released app frees its allocation while the original accepted cleanup continues", async () => {
  const f = await cleanupComputeFixture();
  const events = await db.prisma.runtimeMetadataEvent.findMany({ where: { source: `finalizer:${f.task.id}` }, orderBy: { sequence: "asc" } });
  const evidence = await db.prisma.remoteTaskResource.findMany({ where: { kind: "evidence" }, orderBy: { id: "asc" } });
  await expect(assertComputeStartIntent(db.prisma, f.task.id, f.environment.id, f.offer.id)).rejects.toThrow("cleanup authority remains active");
  await db.prisma.runtimeSession.create({ data: { id: "next-primary", scopeKey: "next", agentCommand: "codex", status: "idle", role: "primary", cwd: "/next", repositoryId: f.task.repositoryId, machineId: f.config.machine } });
  await db.prisma.remoteTask.create({ data: { id: "next-task", requestKey: "next", primarySessionId: "next-primary", repositoryId: f.task.repositoryId, machineId: f.config.machine, branchName: "next", worktreePath: "/next", toolingRoot: "/tooling", toolingRevision: "a".repeat(40), phase: "working" } });
  const admission = { prisma: db.prisma, machineId: f.config.machine, policy: f.config.compute! };
  await requestCompute({ ...admission, taskId: "next-task", request: { key: "app", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  expect(await offerNextCompute(admission)).toBeNull();
  expect(await reclaimStoppedCompute(f.input, f.read)).toEqual({ released: true });
  expect(await reclaimStoppedCompute(f.input, f.read)).toEqual({ released: true });
  const next = await offerNextCompute(admission);
  expect(next).not.toBeNull();
  expect(await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: next!.environmentId } })).toMatchObject({ taskId: "next-task" });
  expect(await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).toMatchObject({ state: "stopped" });
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-capacity-reclaimed" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { source: `finalizer:${f.task.id}` }, orderBy: { sequence: "asc" } })).toEqual(events);
  expect(await db.prisma.remoteTaskResource.findMany({ where: { kind: "evidence" }, orderBy: { id: "asc" } })).toEqual(evidence);
  expect(await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).toMatchObject({ status: "active" });
  expect(await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "remaining-cleanup" } })).toMatchObject({ state: "dispatching" });
});

for (const changed of ["running", "unknown", "failed", "revoked", "active-descendant", "queued-primary", "resource-changed"] as const) test(`cleanup reclamation retains the allocation when ${changed}`, async () => {
  const f = await cleanupComputeFixture();
  if (changed === "active-descendant") {
    await db.prisma.runtimeSession.create({ data: { id: "delegate", scopeKey: "delegate", agentCommand: "codex", status: "active", role: "delegate", cwd: f.worktree, repositoryId: f.task.repositoryId, machineId: f.config.machine } });
    await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "delegate", targetSessionId: f.session.id, relationship: "spawned-by" } });
  }
  if (changed === "queued-primary") await db.prisma.runtimeInstruction.create({ data: { id: "new-work", sessionId: f.session.id, text: "New work", state: "queued" } });
  const read: typeof f.read = async (...args) => {
    if (changed === "failed") throw new Error("physical inventory unavailable");
    if (changed === "revoked") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-retirement-authority", key: "revoke", value: JSON.stringify({ version: 1, action: "revoke" }) } });
    if (changed === "resource-changed") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { externalId: "/private/different-runtime.json" } });
    return { ...await f.read(...args) as object, ...(["running", "unknown"].includes(changed) ? { state: changed } : {}) };
  };
  if (["revoked", "resource-changed", "failed"].includes(changed)) await expect(reclaimStoppedCompute(f.input, read)).rejects.toThrow();
  else expect(await reclaimStoppedCompute(f.input, read)).toEqual({ released: false });
  expect(await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).toMatchObject({ state: "running" });
  expect(await db.prisma.computeSlot.findUniqueOrThrow({ where: { allocationId: f.offer.id } })).toBeDefined();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-capacity-reclaimed" } })).toBe(0);
});

// The connector is a disposable sleeping executable, not a Cloudflare client.
// Its process inspection and identity-bound signal are real; cloud HTTP is a fixture.
test.skipIf(process.platform !== "darwin" || !draftedRoot)("original finalizer retries seven legacy files, a real connector and rejected/lost tunnel deletion", async () => {
  const { connectorProcess } = await import(path.join(draftedRoot!, "test/fixtures/connector-process.ts"));
  const { inspectHostProcess } = await import(path.join(draftedRoot!, "src/runtime-transfer-host.ts"));
  const { taskRegistry, closeTask } = await import(path.join(draftedRoot!, "src/control.ts"));
  const { finalizeTask } = await import(path.join(draftedRoot!, "src/finalize.ts"));
  const { manageResource } = await import(path.join(draftedRoot!, "src/resources.ts"));
  const { manageConnectorResource } = await import(path.join(draftedRoot!, "src/connector-resources.ts"));
  const { releasePublicPreview } = await import(path.join(draftedRoot!, "src/public-preview.ts"));
  const tunnelId = "11111111-2222-4333-8444-555555555555", accountId = "a".repeat(32), zoneId = "b".repeat(32);
  const hostname = "drafted-task-dev.brandongoon.com", source = "http://127.0.0.1:3234";
  const environment = path.join(directory, "environments", "task"), configPath = path.join(environment, "cloudflared.yml"), pidFile = path.join(environment, "connector.pid");
  let processFixture: Awaited<ReturnType<typeof connectorProcess>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const savedPrepare = legacyEvidenceDependencies.prepare;
  try {
    const f = await fixture({ files: 7, historicalSizeBytes: true, beforePrepare: async task => {
      await db.prisma.remoteTaskResource.deleteMany({ where: { taskId: task.id, key: "clerk" } });
      await mkdir(environment, { recursive: true, mode: 0o700 });
      const credentialFile = path.join(environment, "tunnel.json");
      await writeFile(credentialFile, JSON.stringify({ TunnelID: tunnelId, AccountTag: accountId, TunnelSecret: "fixture-only" }), { mode: 0o600 });
      await writeFile(configPath, JSON.stringify({ tunnel: tunnelId, "credentials-file": credentialFile, ingress: [{ hostname, service: source }, { service: "http_status:404" }] }), { mode: 0o600 });
      processFixture = await connectorProcess(directory, task.worktreePath!, configPath);
      const identity = processFixture.identity;
      await writeFile(pidFile, String(identity.pid) + "\n", { mode: 0o600 });
      const resources = [
        { key: "development-env-directory", kind: "directory", externalId: environment, state: "ready", metadata: { trackedGreenfieldEdits: false } },
        { key: "connector", kind: "cloudflared-connector", externalId: "pid:" + identity.pid, state: "ready", metadata: { version: 1, taskId: task.id, pid: identity.pid, process: identity, configPath, pidFile, tunnelId, hostname, source, dedicated: true, accountId } },
        { key: "tunnel", kind: "cloudflare-tunnel", externalId: tunnelId, state: "ready", metadata: { shared: false, hostname, tunnelId, accountId, zoneId, dnsRecordId: "c".repeat(32), configPath, source } },
        { key: "app", kind: "docker-container", externalId: "already-removed-app", state: "released", metadata: {} },
        { key: "dns", kind: "cloudflare-dns-record", externalId: "c".repeat(32), state: "released", metadata: { hostname, tunnelId, zoneId } },
      ];
      for (const resource of resources) await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, purpose: "development", ...resource } });
    } });
    const retained = await f.adopt();
    legacyEvidenceDependencies.prepare = f.manageDependencies.prepare;
    const socket = path.join(directory, "combined.sock");
    server = Bun.serve({ unix: socket, fetch: f.app.fetch });
    const wire = taskRegistry(socket, f.task.id), input = { ...f.finalInput, cleanup: true as const };
    const operation = await prepareTaskFinalization(input, f.dependencies);
    const frozen = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["finalization-prepared", "finalization-cleanup-started", "legacy-evidence-retained"] } }, orderBy: { sequence: "asc" } });
    const originalResources = await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id } });
    let loseConnector = true, rejectDelete = true, loseDelete = true, loseConfirm = true, tunnelPresent = true, deleteAttempts = 0;
    const provider = { request: async (method: string, route: string) => {
      if (method === "GET" && route.includes("/dns_records")) return route.endsWith("c".repeat(32)) ? null : [];
      if (method === "GET" && route.endsWith("/connections")) return await inspectHostProcess(processFixture!.identity.pid) ? [{ id: "live" }] : [];
      if (route !== "/accounts/" + accountId + "/cfd_tunnel/" + tunnelId) throw new Error("Unexpected provider route: " + route);
      if (method === "GET") return tunnelPresent ? { id: tunnelId, name: "fixture" } : null;
      if (method !== "DELETE") throw new Error("Unexpected provider mutation");
      expect(await inspectHostProcess(processFixture!.identity.pid)).toBeNull();
      deleteAttempts++;
      if (rejectDelete) { rejectDelete = false; throw new Error("HTTP 400 / code 1022 fixture rejection"); }
      tunnelPresent = false;
      if (loseDelete) { loseDelete = false; throw new Error("lost tunnel deletion reply"); }
      return null;
    } };
    const registry = { ...wire,
      prepareFinalization: (request: object) => prepareTaskFinalization({ ...input, ...request }, f.dependencies),
      confirmFinalization: async () => { const result = await confirmTaskFinalization(input, f.dependencies); if (loseConfirm) { loseConfirm = false; throw new Error("lost final confirmation"); } return result; },
      publishCleanupStatus: undefined,
      publishCleanupReport: async () => ({ published: false, recorded: true, reportId: "fixture-report-deferred" }),
      resource: async (receipt: any) => { await wire.resource(receipt); if (receipt.key === "connector" && receipt.state === "released" && loseConnector) { loseConnector = false; throw new Error("lost connector receipt reply"); } },
    };
    const manage = async (request: any) => (request.key === "tunnel"
      ? releasePublicPreview({ registry: request.registry, key: "tunnel", provider, releaseConnector: (key: string) => manageConnectorResource({ registry: request.registry, key, action: "release" }) })
      : manageResource(request));
    const finalize = () => finalizeTask({ registry, cleanup: true, manage, close: () => closeTask(socket, f.task.id) });
    await expect(finalize()).rejects.toThrow();
    expect(loseConnector).toBeFalse(); expect(await inspectHostProcess(processFixture!.identity.pid)).toBeNull(); expect(deleteAttempts).toBe(0);
    await expect(finalize()).rejects.toThrow(); expect(deleteAttempts).toBe(1); expect(tunnelPresent).toBeTrue();
    await expect(finalize()).rejects.toThrow(); expect(deleteAttempts).toBe(2); expect(tunnelPresent).toBeFalse();
    await expect(finalize()).rejects.toThrow("lost final confirmation");
    const confirmation = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-confirmed" } });
    expect(await finalize()).toMatchObject({ closed: true });
    expect(await finalize()).toMatchObject({ closed: true, alreadyClosed: true });
    expect(deleteAttempts).toBe(2);
    expect(await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: confirmation.sequence } })).toEqual(confirmation);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: frozen.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(frozen);
    expect(operation.cleanup!.operationRevision).toBeGreaterThan(0);
    expect(await lstat(f.worktree).catch(() => null)).toBeNull();
    expect(git(f.root, "worktree", "list", "--porcelain")).not.toContain(f.worktree);
    for (const resource of originalResources.filter(row => row.key.startsWith("capture-") || row.key === "connector" || row.state === "released")) expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).metadata).toEqual(resource.metadata);
    for (const entry of retained.proof.entries) if (entry.target.type === "file") expect(sha(await readFile(entry.retained.path))).toBe(entry.target.sha256);
  } finally { legacyEvidenceDependencies.prepare = savedPrepare; await server?.stop(true); await processFixture?.stop(); }
}, 90_000);
