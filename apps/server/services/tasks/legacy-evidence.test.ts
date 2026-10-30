import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import type { RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { prepareTaskFinalization, confirmTaskFinalization } from "./finalization.ts";
import { finalizationDigest } from "./finalization-resources.ts";
import { adoptLegacyEvidence, legacyEvidenceDependencies, legacyEvidenceProjection, manageLegacyEvidence } from "./legacy-evidence.ts";
import type { LegacyEvidenceReceipt, LegacyEvidenceOperationInput } from "./legacy-evidence-schema.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "legacy-evidence-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]) { const command = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }); if (command.exitCode) throw new Error(command.stderr.toString()); return command.stdout.toString().trim(); }

async function fixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree"), historical = path.join(directory, "DRA-99"), archive = path.join(directory, "retained");
  for (const dir of [root, historical, archive]) await mkdir(dir, { mode: 0o700 });
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture"); git(root, "worktree", "add", "-b", "codex/legacy", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-99", primarySessionId: session.id, branchName: "codex/legacy", worktreePath: worktree, toolingRoot: root, toolingRevision: "a".repeat(40), phase: "complete" } });
  const sourceLink = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-99", relationship: "handles" } });
  const context = { prisma: db.prisma, config, taskId: task.id };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "verified", passed: true, evidence: ["Accepted"] } });
  const head = git(worktree, "rev-parse", "HEAD"), remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/legacy", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const issue = { id: "issue", identifier: "DRA-99", branchName: "codex/legacy", title: "Task", description: "Request", state: { id: "merge", name: "Merge", type: "started" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const observer = { ...completionObservation, remote: async () => remote };
  const dependencies = { source: async () => ({ session, link: sourceLink, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, observer), snapshot: completionObservation.snapshot };
  const resources: RemoteTaskResource[] = [], files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const [index, body] of ["saved capture\n", "sentinel without historical proof\n"].entries()) {
    const name = `evidence-${index}.txt`, original = path.join(historical, name), retained = path.join(archive, name);
    await writeFile(original, body, { mode: 0o600 }); await copyFile(original, retained); await chmod(retained, 0o600);
    resources.push(await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: `capture-${index}`, kind: "evidence", purpose: index === 0 ? "development" : "browser", externalId: original, state: "ready", metadata: index === 0 ? { sha256: sha(body), bytes: Buffer.byteLength(body), description: "original receipt" } : { description: "legacy sentinel" } } }));
    files.push({ path: name, sha256: sha(body), bytes: Buffer.byteLength(body) });
  }
  await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "old-browser", kind: "browser", purpose: "browser", externalId: "already-gone", state: "released", metadata: { preserved: true } } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "clerk", kind: "clerk", purpose: "development", externalId: "unclaimed.example.test", state: "unknown" } });
  const finalInput = { prisma: db.prisma, config, sessionId: session.id, requestKey: "finalize:task" };
  const prepared = await prepareTaskFinalization(finalInput, dependencies);
  const manifestPath = path.join(archive, "RETENTION.json"), manifestBytes = JSON.stringify({ task: task.id, retainedArchive: archive, files, sourceUnchanged: true });
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const adoption = { requestKey: "retain-legacy", finalizationRequestKey: prepared.requestKey, expectedPreparedRevision: prepared.preparedRevision,
    manifest: { path: manifestPath, sha256: sha(manifestBytes) }, entries: resources.map((resource, index) => ({ resourceId: resource.id, retainedPath: path.join(archive, files[index]!.path), sha256: files[index]!.sha256, size: files[index]!.bytes })) };
  const manageDependencies = { prepare: (input: Parameters<typeof prepareTaskFinalization>[0]) => prepareTaskFinalization(input, dependencies) };
  const app = createApp({ prisma: db.prisma, config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const adopt = () => adoptLegacyEvidence({ ...context, adoption });
  const manage = (receipt: LegacyEvidenceReceipt, key: string, action: LegacyEvidenceOperationInput["action"]) => manageLegacyEvidence({ ...finalInput, operation: { resourceKey: key, action, proofRevision: receipt.proofRevision, proofDigest: receipt.proofDigest, preparedRevision: prepared.preparedRevision, finalizationRequestKey: prepared.requestKey } }, manageDependencies);
  return { config, task, session, root, worktree, historical, archive, resources, files, prepared, context, finalInput, dependencies, manageDependencies, contract, issue, app, adoption, adopt, manage };
}

async function capture(receipt: LegacyEvidenceReceipt, index = 0, intentOnly = false) {
  const entry = receipt.proof.entries[index]!, target = entry.target, q = target.quarantine;
  await mkdir(q.directory, { mode: 0o700 }); const stat = await lstat(q.directory);
  await writeFile(q.journal, JSON.stringify({ version: 1, taskId: receipt.proof.taskId, resourceId: entry.resourceId, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: q.path,
    source: { dev: target.dev, ino: target.ino, mode: target.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600 });
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
  { bytes: 1, size: 2 }, { bytes: -1 }, { sha256: "invalid" }, { sha256: "0".repeat(64) },
])("conflicting or changed historical proof is refused: %j", async (metadata) => {
  const f = await fixture(); await db.prisma.remoteTaskResource.update({ where: { id: f.resources[0]!.id }, data: { metadata } });
  await expect(f.adopt()).rejects.toThrow(); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "legacy-evidence-retained" } })).toBe(0);
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

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
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
