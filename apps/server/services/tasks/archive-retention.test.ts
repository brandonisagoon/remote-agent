import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { privateBackupFixture } from "../../../../test-support/private-backup.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { RetirementAuthorityInput, inspectRetirementAuthority, setRetirementAuthority } from "./retirement-authority.ts";
import { prepareTaskFinalization, confirmTaskFinalization } from "./finalization.ts";
import { ARCHIVE_RETENTION, ArchiveRetentionProof, type ArchiveRetentionReceipt } from "./archive-retention-schema.ts";
import { archiveRetentionProjection, verifyArchiveRetention } from "./archive-retention.ts";
import { observeLegacyEvidenceTree } from "./legacy-evidence-tree.ts";
import { observeSavedArchive } from "./archive-observation.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";
import { adoptLegacyEvidence, manageLegacyEvidence } from "./legacy-evidence.ts";
import { finalizationDigest } from "./finalization-resources.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "saved-archives-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]) { const command = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }); if (command.exitCode) throw new Error(command.stderr.toString()); return command.stdout.toString().trim(); }

async function baseFixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  git(root, "worktree", "add", "-b", "codex/task", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: root, toolingRevision: "a".repeat(40), pinnedToolingRoot: root, phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Blocked", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", branchName: "codex/task", title: "Task", description: "Request", state: states[1]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
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
  const retirementRemote = async () => ({ id: "retirement", repository: "owner/product", pullRequest: 12, url: remote.pullRequest.url, reviewedHead: head, mergeCommit: remote.pullRequest.mergeCommit.oid, mergedAt: new Date(0).toISOString(), baseHead: remote.remoteBase, ci: [] });
  const authorityDependencies = { ...dependencies, remote: retirementRemote };
  const finalizationDependencies = { ...dependencies, retirementRemote };
  const delivery = { repository: "owner/product", pullRequest: 12, head, mergeCommit: remote.pullRequest.mergeCommit.oid, baseBranch: "main" };
  const authorization = async () => {
    const inspected = await inspectRetirementAuthority(context, authorityDependencies);
    if (!inspected.eligible) throw new Error(inspected.bindingError);
    const parsed = RetirementAuthorityInput.parse({ requestKey: "owner-retire", expectedRevision: 0, action: "authorize", basis: "Retire this exact accepted delivery without changing Done", expectedBindingDigest: inspected.bindingDigest, delivery });
    if (parsed.action !== "authorize") throw new Error("Unexpected fixture action");
    return parsed;
  };
  const grant = async () => setRetirementAuthority({ ...context, authorization: await authorization() }, authorityDependencies);
  return { authorization, grant, delivery, authorityDependencies, finalizationDependencies, retirementRemote, root, worktree, config, session, task, issue, states, context, contract, remote, observer, input, dependencies, remove, revoke };
}

async function fixture(options: { prepare?: boolean } = {}) {
  const f = await baseFixture(), archive = path.join(directory, "saved");
  await mkdir(archive, { mode: 0o700 });
  const files = ["captures/shot.txt", "env/saved.txt", "logs/trace.txt", "FINAL-CLEANUP-RECEIPT.json", "extra-1.txt", "extra-2.txt", "extra-3.txt"];
  for (const name of ["captures", "env", "logs"]) await mkdir(path.join(archive, name), { mode: 0o700 });
  const entries = [];
  for (const name of files) {
    const body = `retained fixture ${name}\n`; await writeFile(path.join(archive, name), body, { mode: 0o600 });
    entries.push({ archivePath: name, sourcePath: `/historical/${name}`, sha256: sha(body), bytes: Buffer.byteLength(body) });
  }
  const manifests = [];
  for (let index = 0; index < 5; index++) {
    const members = index === 0 ? entries.slice(0, 3) : [entries[index + 2]!];
    const name = index === 0 ? "ARCHIVE-MANIFEST.json" : `ARCHIVE-ADDENDUM-${index}.json`;
    const body = JSON.stringify({ task: f.task.id, issue: f.task.issueIdentifier, mergedCommit: f.remote.pullRequest.mergeCommit.oid, count: members.length, entries: members });
    await writeFile(path.join(archive, name), body, { mode: 0o600 }); manifests.push({ path: name, sha256: sha(body), entries: members.length });
  }
  await writeFile(path.join(archive, "README.md"), "Ancillary bytes, newly observed rather than historical evidence\n", { mode: 0o600 });
  const resources = [];
  for (const [index, member] of ["", "captures", "env", "logs", "FINAL-CLEANUP-RECEIPT.json"].entries()) {
    const cleanup = entries.find(entry => entry.archivePath === "FINAL-CLEANUP-RECEIPT.json")!;
    resources.push(await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: `saved-${index}`, kind: "evidence-archive", purpose: "development", externalId: path.join(archive, member), state: "ready",
      metadata: index === 0 ? { archival: true, manifest: manifests[0]!, addenda: manifests.slice(1), finalCleanupReceipt: { path: cleanup.archivePath, sha256: cleanup.sha256 } } : { archival: true, ...(index === 4 ? { sha256: cleanup.sha256 } : {}) } } }));
  }
  const identity = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "private-identity", kind: "private-identity-retention", purpose: "tooling", externalId: path.join(directory, "retained-identity"), state: "ready", metadata: { offline: true } } });
  const grant = await f.grant();
  const prepare = () => prepareTaskFinalization(f.input, f.finalizationDependencies);
  const prepared = options.prepare === false ? undefined : await prepare();
  const app = createApp({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  const check = (receipt: ArchiveRetentionReceipt) => verifyArchiveRetention({ prisma: db.prisma, config: f.config, sessionId: f.session.id, check: { proofRevision: receipt.proofRevision, proofDigest: receipt.proofDigest, preparedRevision: receipt.preparedRevision, requestKey: receipt.requestKey } });
  return { ...f, archive, files, manifests, resources, identity, grant, prepared, prepare, app, check };
}

async function privateFixture(options: { prepare?: boolean; directoryEvidence?: boolean } = {}) {
  const f = await baseFixture(), backups = [], resources = [];
  for (const extended of [false, true]) {
    const backup = await privateBackupFixture(path.join(directory, extended ? "current-backup" : "older-backup"), f.task.id, f.task.issueIdentifier!, extended);
    backups.push(backup);
    resources.push(await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: extended ? "current-backup" : "older-backup", kind: "private-backup", purpose: "development", externalId: backup.root, state: "ready", metadata: backup.metadata } }));
  }
  let treeResource;
  if (options.directoryEvidence) {
    const environment = path.join(directory, "environment"), original = path.join(environment, "evidence");
    await mkdir(original, { recursive: true, mode: 0o700 });
    for (const name of ["secret.env", "run.sh"]) await writeFile(path.join(original,name), await readFile(path.join(backups[1]!.root,"evidence/browser",name)), { mode:0o600 });
    treeResource = await db.prisma.remoteTaskResource.create({data:{taskId:f.task.id,key:"original-evidence",kind:"evidence",purpose:"browser",externalId:original,state:"ready",metadata:{description:"exact original directory"}}});
    await db.prisma.remoteTaskResource.create({data:{taskId:f.task.id,key:"environment",kind:"directory",purpose:"development",externalId:environment,state:"allocated"}});
  }
  const grant = await f.grant(), prepare = () => prepareTaskFinalization(f.input, f.finalizationDependencies);
  const prepared = options.prepare === false ? undefined : await prepare();
  const app = createApp({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  return { ...f, archive: backups[0]!.root, files: backups[0]!.files, backups, resources, grant, prepared, prepare, app, treeResource };
}

function retention(prepared: Awaited<ReturnType<typeof prepareTaskFinalization>>) {
  if (!("archiveRetention" in prepared) || !prepared.archiveRetention) throw new Error("Missing archive proof");
  return prepared.archiveRetention;
}

test("five original archive receipts stay ready through old-preparation adoption, restart and repeated confirmation", async () => {
  const f = await fixture(), original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared!.preparedRevision } });
  // Model the deployed v1 receipt before this additive feature existed.
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: ARCHIVE_RETENTION } });
  const upgraded = await f.prepare(), saved = retention(upgraded);
  expect(saved.resources).toHaveLength(5);
  const event = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: saved.proofRevision } });
  const proof = ArchiveRetentionProof.parse(JSON.parse(event.value!));
  expect(proof.archives[0]!.manifestEntries).toBe(7);
  expect(proof.archives[0]!.ancillary.map(entry => entry.path)).toEqual(["README.md"]);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
  expect((await f.prepare()).preparedRevision).toBe(original.sequence);
  await db.prisma.$disconnect(); expect(retention(await f.prepare())).toEqual(saved);
  expect(await f.check(saved)).toEqual(saved);
  f.remove(); const confirmed = await confirmTaskFinalization(f.input, f.finalizationDependencies);
  expect(retention(confirmed)).toEqual(saved);
  expect(await confirmTaskFinalization(f.input, f.finalizationDependencies)).toEqual(confirmed);
  expect(confirmed).toHaveProperty("retirement.doneHandoff.body", expect.stringContaining("verified saved archives remain intact"));
  for (const record of f.resources) expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: record.id } })).toEqual(record);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.identity.id } })).toEqual(f.identity);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.grant.revision } })).action).toBe("completion-retirement-authority");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
  await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: f.session.id }, data: { endedAt: new Date() } });
  expect(await f.check(saved)).toEqual(saved);
});

test("two existing private backups preserve the original v1 preparation and immutable Ready receipts across retry", async () => {
  const f = await privateFixture(), original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared!.preparedRevision } });
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: ARCHIVE_RETENTION } });
  const saved = retention(await f.prepare());
  expect(saved.resources.map(x => x.kind)).toEqual(["private-backup", "private-backup"]);
  const proofEvent = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: saved.proofRevision } });
  const proof = ArchiveRetentionProof.parse(JSON.parse(proofEvent.value!));
  expect(proof.archives.map(x=>x.manifestEntries).sort((a,b)=>a-b)).toEqual([12,18]);
  expect(proof.archives.every(x=>x.ancillary.length===1)).toBeTrue();
  await db.prisma.$disconnect(); expect(retention(await f.prepare())).toEqual(saved);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
  for (const record of f.resources) expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: record.id } })).toEqual(record);
  await writeFile(path.join(f.backups[1]!.root,"README.md"),"changed ancillary bytes");
  await expect(f.prepare()).rejects.toThrow("contents or inode inventory changed");
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
});

test("retained private backup proof allows exact directory evidence adoption without weakening its cleanup-root guard", async () => {
  const f = await privateFixture({directoryEvidence:true}), backup=f.backups[1]!, original=await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({where:{sequence:f.prepared!.preparedRevision}});
  const tree=await observeLegacyEvidenceTree(f.treeResource!.externalId);
  const adoption={requestKey:"retain-backup-evidence",finalizationRequestKey:f.prepared!.requestKey,expectedPreparedRevision:f.prepared!.preparedRevision,
    manifest:{path:path.join(backup.root,"MANIFEST.json"),sha256:backup.selection.manifests[0].sha256,format:"task-backup-evidence-v1" as const},
    entries:[{type:"tree" as const,resourceId:f.treeResource!.id,retainedPath:path.join(backup.root,"evidence/browser"),inventoryDigest:tree.inventoryDigest}]};
  await db.prisma.runtimeMetadataEvent.deleteMany({where:{action:ARCHIVE_RETENTION}});
  await expect(adoptLegacyEvidence({...f.context,adoption})).rejects.toThrow("cleanup root");
  const retained=retention(await f.prepare());
  const evidence=await adoptLegacyEvidence({...f.context,adoption});
  expect(evidence.proof.entries).toHaveLength(1);expect(evidence.proof.manifests).toHaveLength(4);
  const entry=evidence.proof.entries[0]!;
  await manageLegacyEvidence({...f.input,operation:{resourceKey:entry.key,action:"authorize",proofRevision:evidence.proofRevision,proofDigest:evidence.proofDigest,preparedRevision:original.sequence,finalizationRequestKey:f.prepared!.requestKey}},
    {prepare:()=>f.prepare()});
  expect(retention(await f.prepare())).toEqual(retained);
  for(const record of f.resources)expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({where:{id:record.id}})).toEqual(record);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({where:{sequence:original.sequence}})).value).toBe(original.value);
  expect(await lstat(entry.target.path)).toBeDefined();
});

test.each(["late", "unbound-manifest", "overlap"])("private backup %s cannot acquire a retention exception", async variant => {
  const f = await privateFixture(), original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared!.preparedRevision } });
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: ARCHIVE_RETENTION } });
  if (variant === "late") await db.prisma.remoteTaskResource.update({ where:{id:f.resources[1]!.id},data:{createdAt:new Date(original.occurredAt.getTime()+1)} });
  if (variant === "unbound-manifest") await db.prisma.remoteTaskResource.update({ where:{id:f.resources[1]!.id},data:{metadata:{retention:"please retain",manifest:"MANIFEST.json"}} });
  if (variant === "overlap") await db.prisma.remoteTaskResource.create({ data:{taskId:f.task.id,key:"new-cleanup-root",kind:"directory",purpose:"development",externalId:path.dirname(f.archive),state:"ready"} });
  await expect(f.prepare()).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({where:{action:ARCHIVE_RETENTION}})).toBe(0);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
});

test.each(["ARCHIVE-MANIFEST.json", "ARCHIVE-ADDENDUM-4.json", "env/saved.txt", "README.md"])("changed %s blocks preparation and confirmation while cheap status projection stays read-only", async name => {
  const f = await fixture(), saved = retention(f.prepared!);
  await writeFile(path.join(f.archive, name), "changed bytes", { mode: 0o600 });
  expect(await archiveRetentionProjection(db.prisma, f.config, f.task)).toEqual({ archiveRetentionRequired: true, archiveRetention: saved });
  await expect(f.check(saved)).rejects.toThrow(); await expect(f.prepare()).rejects.toThrow();
  f.remove(); await expect(confirmTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(0);
});

test.each(["symlink", "hardlink", "fifo", "permissions", "root-replacement"])("uncertain archive %s preserves all original receipts", async kind => {
  const f = await fixture(), saved = retention(f.prepared!), file = path.join(f.archive, "README.md");
  if (kind === "symlink") { await rename(file, `${file}.retained`); await symlink(`${file}.retained`, file); }
  if (kind === "hardlink") await link(file, path.join(directory, "alias"));
  if (kind === "fifo") { await rename(file, `${file}.retained`); expect(Bun.spawnSync(["mkfifo", "-m", "600", file]).exitCode).toBe(0); }
  if (kind === "permissions") await chmod(file, 0o644);
  if (kind === "root-replacement") { await rename(f.archive, `${f.archive}.retained`); await mkdir(f.archive, { mode: 0o700 }); }
  await expect(f.check(saved)).rejects.toThrow();
  for (const record of f.resources) expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: record.id } })).toEqual(record);
});

test("generic PUT cannot fake archive release, metadata retention cannot authorize an unmanifested root", async () => {
  const f = await fixture(), record = f.resources[0]!;
  const response = await f.app.request("/api/sessions/primary/task/resources", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: record.key, purpose: record.purpose, kind: record.kind, externalId: record.externalId, state: "released", metadata: record.metadata }) });
  expect(response.status).toBe(409);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: record.id } })).state).toBe("ready");
  await db.prisma.remoteTaskResource.update({ where: { id: record.id }, data: { metadata: { archival: true, retained: true } } });
  expect(await archiveRetentionProjection(db.prisma, f.config, f.task)).toEqual({ archiveRetentionRequired: true });
  await expect(f.check(retention(f.prepared!))).rejects.toThrow();
});

test.each(["ownerPaused", "toolingRevision", "contract", "grant", "resource", "cleanup-overlap"])("changed %s invalidates the supplemental proof", async kind => {
  const f = await fixture(), saved = retention(f.prepared!);
  if (kind === "ownerPaused") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (kind === "toolingRevision") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "d".repeat(40) } });
  if (kind === "contract") await f.revoke();
  if (kind === "grant") await setRetirementAuthority({ ...f.context, authorization: { requestKey: "revoke", action: "revoke", expectedRevision: f.grant.revision, basis: "Withdraw retirement" } });
  if (kind === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resources[0]!.id }, data: { state: "released" } });
  if (kind === "cleanup-overlap") await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "new-root", kind: "directory", purpose: "development", externalId: f.archive, state: "ready" } });
  expect(await archiveRetentionProjection(db.prisma, f.config, f.task)).toEqual({ archiveRetentionRequired: true });
  await expect(f.check(saved)).rejects.toThrow();
});

test("unreleased unrelated resources still block closure and proof cannot be selected by another session", async () => {
  const f = await fixture(), saved = retention(f.prepared!);
  const bad = await f.app.request("/api/sessions/other/archive-retention", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proofRevision: saved.proofRevision, proofDigest: saved.proofDigest, preparedRevision: saved.preparedRevision, requestKey: saved.requestKey }) });
  expect(bad.status).toBe(409);
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "unknown", kind: "other", purpose: "development", externalId: "unclaimed", state: "ready" } });
  f.remove(); await expect(confirmTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(0);
});

test("one immutable archive supplement is enforced independently of request retries", async () => {
  const f = await fixture(), saved = retention(f.prepared!);
  const existing = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: saved.proofRevision } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: existing.runtimeSessionId, source: existing.source, action: existing.action, key: "replacement", value: existing.value } }))).rejects.toThrow();
  expect(await f.check(saved)).toEqual(saved);
});

test.each(["new", "replayed", "confirmed"])("%s preparation refreshes source authority after archive and Git observations", async mode => {
  const f = await fixture({ prepare: mode !== "new" });
  if (mode === "confirmed") { f.remove(); await confirmTaskFinalization(f.input, f.finalizationDependencies); }
  let sourceReads = 0;
  const dependencies = { ...f.finalizationDependencies,
    source: async () => {
      sourceReads++;
      if (mode === "new" && await db.prisma.runtimeMetadataEvent.count({ where: { action: ARCHIVE_RETENTION } }) || mode === "confirmed" && sourceReads >= 3) f.issue.state = f.states[2]!;
      return f.dependencies.source();
    },
    snapshot: async (worktree: string) => { const snapshot = await f.dependencies.snapshot(worktree); if (mode === "replayed") f.issue.state = f.states[2]!; return snapshot; },
  };
  await expect(prepareTaskFinalization(f.input, dependencies)).rejects.toThrow("current owner Merge");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  for (const resource of f.resources) expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).state).toBe("ready");
  f.issue.state = f.states[1]!;
  expect(retention(await f.prepare()).resources).toHaveLength(5);
});

test("Done retirement adopts and captures three original evidence files beneath their retained tooling parent without replacing grant or preparation", async () => {
  const f = await baseFixture(), parent = path.join(directory, "original-evidence"), archive = path.join(directory, "retained-copies");
  await mkdir(parent, { mode: 0o700 }); await mkdir(archive, { mode: 0o700 });
  const retainedParent = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "task-evidence-archive", kind: "directory", purpose: "tooling", externalId: parent, state: "ready", metadata: { archive: true, retained: true, root: parent } } });
  const files: Array<{ path: string; sha256: string; bytes: number }> = [], resources = [];
  for (let index = 0; index < 3; index++) {
    const name = `capture-${index}.txt`, body = `original saved evidence ${index}`;
    await writeFile(path.join(parent, name), body, { mode: 0o600 }); await writeFile(path.join(archive, name), body, { mode: 0o600 });
    files.push({ path: name, sha256: sha(body), bytes: Buffer.byteLength(body) });
    resources.push(await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: name, kind: "evidence", purpose: "browser", externalId: path.join(parent, name), state: "ready", metadata: { bytes: Buffer.byteLength(body), sha256: sha(body) } } }));
  }
  const grant = await f.grant(), prepared = await prepareTaskFinalization(f.input, f.finalizationDependencies);
  const before = await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: [grant.revision, prepared.preparedRevision] } }, orderBy: { sequence: "asc" } });
  const manifest = JSON.stringify({ task: f.task.id, retainedArchive: archive, files }), manifestPath = path.join(archive, "RETENTION.json");
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  const proof = await adoptLegacyEvidence({ ...f.context, adoption: { requestKey: "retain-three", finalizationRequestKey: prepared.requestKey, expectedPreparedRevision: prepared.preparedRevision,
    manifest: { path: manifestPath, sha256: sha(manifest) }, entries: resources.map((resource, index) => ({ resourceId: resource.id, retainedPath: path.join(archive, files[index]!.path), sha256: files[index]!.sha256, size: files[index]!.bytes })) } });
  const dependencies = { prepare: () => prepareTaskFinalization(f.input, f.finalizationDependencies) };
  for (const entry of proof.proof.entries) {
    const operation = { resourceKey: entry.key, proofRevision: proof.proofRevision, proofDigest: proof.proofDigest, preparedRevision: prepared.preparedRevision, finalizationRequestKey: prepared.requestKey };
    await manageLegacyEvidence({ ...f.input, operation: { ...operation, action: "authorize" } }, dependencies);
    const target = entry.target, q = target.quarantine; if (target.type !== "file") throw new Error("Expected file fixture"); await mkdir(q.directory, { mode: 0o700 }); const stat = await lstat(q.directory);
    await writeFile(q.journal, JSON.stringify({ version: 1, taskId: f.task.id, resourceId: entry.resourceId, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: q.path,
      source: { dev: target.dev, ino: target.ino, mode: target.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600 });
    await rename(target.path, q.path);
    await manageLegacyEvidence({ ...f.input, operation: { ...operation, action: "confirm" } }, dependencies);
    expect(sha(await readFile(entry.retained.path))).toBe(target.sha256);
    expect((await lstat(q.path)).ino).toBe(target.ino);
  }
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: retainedParent.id } })).toEqual(retainedParent);
  expect((await lstat(parent)).isDirectory()).toBeTrue();
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: [grant.revision, prepared.preparedRevision] } }, orderBy: { sequence: "asc" } })).toEqual(before);
  expect(await prepareTaskFinalization(f.input, f.finalizationDependencies)).toEqual(prepared);
});

test.skipIf(process.env.DRA_ARCHIVE_VOLUME_TEST !== "1")("disposable 459 MB archive is streamed with bounded memory", async () => {
  const archive = path.join(directory, "large-archive"); await mkdir(archive, { mode: 0o700 });
  const size = 459_275_486, chunk = Buffer.alloc(1024 * 1024, 0x61), hash = createHash("sha256");
  const handle = await open(path.join(archive, "payload.bin"), "wx", 0o600);
  try {
    for (let offset = 0; offset < size;) {
      const part = chunk.subarray(0, Math.min(chunk.length, size - offset));
      const written = await handle.write(part, 0, part.length, offset);
      if (!written.bytesWritten) throw new Error("Fixture write did not progress");
      hash.update(part.subarray(0, written.bytesWritten)); offset += written.bytesWritten;
    }
  } finally { await handle.close(); }
  const body = JSON.stringify({ task: "task", issue: "DRA-10", mergedCommit: "c".repeat(40), count: 1, entries: [{ archivePath: "payload.bin", sha256: hash.digest("hex"), bytes: size }] });
  await writeFile(path.join(archive, "MANIFEST.json"), body, { mode: 0o600 });
  const start = performance.now();
  const observed = await observeSavedArchive({ root: archive, manifests: [{ path: "MANIFEST.json", sha256: sha(body), entries: 1 }], taskId: "task", issueIdentifier: "DRA-10", mergeCommit: "c".repeat(40) });
  console.info(JSON.stringify({ fixtureBytes: size, streamedVerificationMs: Math.round(performance.now() - start) }));
  expect(observed.manifestEntries).toBe(1); expect(observed.ancillary).toEqual([]);
  expect(observed.inventory.find(entry => entry.kind === "file" && entry.path === "payload.bin")).toMatchObject({ size });
}, 60_000);

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot).each(["evidence-archive", "private-backup"])("actual original-primary finalizer retains %s through lost responses, then closed upkeep rechecks contents", async kind => {
  const f = kind === "private-backup" ? await privateFixture({ prepare: false }) : await fixture({ prepare: false });
  let lostPrepare = true, lostConfirm = true, comments = 0, stateWrites = 0, closed = 0;
  const provider = { ...issueUpdateDelivery, source: f.dependencies.source, read: async () => f.issue,
    graph: async () => ({ id: f.issue.id, identifier: f.issue.identifier, children: [], states: f.states }),
    create: async (_config: unknown, value: { id?: string }) => { comments++; return { id: value.id! }; }, update: async () => { stateWrites++; },
  };
  const socket = path.join(directory, "control.sock");
  const server = Bun.serve({ unix: socket, fetch: async request => {
    const route = new URL(request.url).pathname;
    try {
      if (route.endsWith("/prepare-finalization")) {
        const result = await f.prepare();
        if (lostPrepare) { lostPrepare = false; return Response.json({ error: "Prepare acknowledgment lost" }, { status: 500 }); }
        return Response.json(result);
      }
      if (route.endsWith("/confirm-finalization")) {
        const result = await confirmTaskFinalization(f.input, f.finalizationDependencies);
        if (lostConfirm) { lostConfirm = false; return Response.json({ error: "Confirm acknowledgment lost" }, { status: 500 }); }
        return Response.json(result);
      }
      if (route.endsWith("/issue-update")) return Response.json(await publishSessionIssueUpdate({ ...f.input, ...await request.json(), evidence: [] }, provider));
      return f.app.fetch(request);
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
  } });
  await chmod(socket, 0o600);
  try {
    const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
    const { finalizeTask } = await import(path.join(draftedRoot!, "src/finalize.ts"));
    const { upkeepTask } = await import(path.join(draftedRoot!, "src/upkeep.ts"));
    const { manageResource } = await import(path.join(draftedRoot!, "src/resources.ts"));
    const registry = taskRegistry(socket, "task", 60_000);
    const close = async () => {
      expect(comments).toBe(1); expect(stateWrites).toBe(0); closed++;
      await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
      await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
    };
    await expect(finalizeTask({ registry, close })).rejects.toThrow("Prepare acknowledgment lost");
    const original = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-prepared" } });
    const grant = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.grant.revision } });
    expect((await lstat(f.worktree)).isDirectory()).toBeTrue();
    await expect(finalizeTask({ registry, close })).rejects.toThrow("Confirm acknowledgment lost");
    expect(closed).toBe(0); expect(comments).toBe(0);
    await finalizeTask({ registry, close });
    expect(closed).toBe(1); expect(comments).toBe(1); expect(f.issue.state.name).toBe("Done");
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: grant.sequence } })).value).toBe(grant.value);
    const upkeep = await upkeepTask(registry, "closed", async () => { throw new Error("Retained archives must not reach a release adapter"); });
    expect(upkeep.results.filter((entry: { outcome: string }) => entry.outcome === "retained")).toHaveLength(f.resources.length);
    expect(await manageResource({ registry, key: f.resources[0]!.key, action: "release" })).toMatchObject({ retained: true, state: "ready" });
    for (const record of f.resources) expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: record.id } })).toEqual(record);
    await rm(path.join(f.archive, "README.md"));
    await expect(upkeepTask(registry, "expired")).rejects.toThrow();
    expect((await lstat(path.join(f.archive, f.files[0]!))).isFile()).toBeTrue();
    expect(closed).toBe(1);
  } finally { await server.stop(true); }
}, 60_000);

