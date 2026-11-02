import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { setCompletionContract, CompletionContractInput, recordCompletionVerification } from "./completion.ts";
import { preparationJournalWorker } from "./finalization-preparation.ts";
import { prepareTaskFinalization, confirmTaskFinalization } from "./finalization.ts";
import { inspectPreparedCleanupState, assertPreparedCleanup, cleanupRetainedResourceIds } from "./cleanup-lifecycle.ts";
import { cleanupProjection } from "./cleanup-report.ts";
import { localCleanupReferenceDependencies, localCleanupReferenceRetention, LOCAL_CLEANUP_REFERENCE } from "./local-cleanup-reference.ts";
import { observeLocalCleanupReference } from "./external-delivery-observation.ts";
import { finalizationDigest } from "./finalization-resources.ts";
import { adoptLegacyOriginalWork } from "./legacy-original-work.ts";

let db: TestDatabase, directory: string;
const dependencies = { ...localCleanupReferenceDependencies };
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "local-reference-"))); });
afterEach(async () => { Object.assign(localCleanupReferenceDependencies, dependencies); await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw Error(result.stderr.toString()); return result.stdout.toString().trim();
}
async function fixture(missingProof = false, ignored = false) {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "remote", "add", "origin", "https://github.com/owner/product.git");
  await writeFile(path.join(root, "source.txt"), "accepted content"); git(root, "add", "."); git(root, "commit", "-m", "source");
  git(root, "worktree", "add", "-b", "codex/local", worktree);
  if (ignored) { await writeFile(path.join(root, ".git/info/exclude"), "cache/\n"); await mkdir(path.join(worktree, "cache")); await writeFile(path.join(worktree, "cache/value"), "retain me", { mode: 0o600 }); }
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", role: "primary", status: "idle", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "local-task", requestKey: "local-task", primarySessionId: session.id, repositoryId: config.repository.id, machineId: config.machine, branchName: "codex/local", worktreePath: worktree, toolingRoot: root, toolingRevision: "a".repeat(40), phase: "complete" } });
  const head = git(worktree, "rev-parse", "HEAD"), context = { prisma: db.prisma, config, taskId: task.id };
  const resource = await db.prisma.remoteTaskResource.create({ data: { id: "published-pr", taskId: task.id, key: "published-pr", kind: "pull-request", purpose: "development", externalId: "https://github.com/owner/product/pull/7", state: "ready", metadata: { repository: "owner/product", number: 7, head, branch: "codex/local", baseBranch: "main", draft: true } } });
  await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "local-only", basis: "Retain the accepted local work and its published reference" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "verified", passed: true, evidence: ["Local work verified; no Merge workflow claimed"] } });
  let observations = 0, refuse = missingProof;
  localCleanupReferenceDependencies.observe = async reference => {
    observations++; expect(Reflect.get(db.prisma, Symbol.for("prisma.client.transaction.scope_context"))).toBeUndefined();
    if (refuse) throw Error("GitHub unavailable");
    return { id: reference.id, repository: reference.repository, pullRequest: reference.pullRequest, url: resource.externalId, reviewedHead: head, mergeCommit: "c".repeat(40), mergedAt: "2026-01-01T00:00:00.000Z", baseHead: "d".repeat(40), ci: [] };
  };
  const input = { prisma: db.prisma, config, sessionId: session.id, requestKey: `finalize:${task.id}`, cleanup: true as const };
  let initialError: unknown;
  try { await prepareTaskFinalization(input); } catch (error) { initialError = error; }
  if (!missingProof && !ignored && initialError) throw initialError;
  const preparation = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-prepared" } });
  const operation = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-cleanup-started" } });
  const unchanged = async () => {
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: preparation.sequence } })).value).toBe(preparation.value);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: operation.sequence } })).value).toBe(operation.value);
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
    expect(await db.prisma.taskDelivery.count()).toBe(0); expect(await db.prisma.runtimeSessionResourceLink.count()).toBe(0);
  };
  return { ...context, root, worktree, task, session, head, resource, input, preparation, operation, unchanged, initialError,
    observations: () => observations, allow: () => { refuse = false; }, active: () => inspectPreparedCleanupState(input) };
}

test("full preparation adds verified retained history without rewriting local-only receipts or Ready metadata", async () => {
  const f = await fixture();
  expect(f.observations()).toBe(1); await f.unchanged();
  const active = await f.active(), retention = await localCleanupReferenceRetention(db.prisma, active);
  expect(retention?.resources[0]).toMatchObject({ id: f.resource.id, disposition: "retain-reference", reference: { reviewedHead: f.head, mergeCommit: "c".repeat(40) } });
  expect(JSON.parse(f.preparation.value!).delivery).toMatchObject({ boundary: "local-only", receipts: { pullRequest: { observed: false, url: null }, merge: { merged: false, sha: null } } });
  expect((await cleanupRetainedResourceIds(db.prisma, f.config, active)).has(f.resource.id)).toBe(true);
  await prepareTaskFinalization(f.input); expect(f.observations()).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: LOCAL_CLEANUP_REFERENCE } })).toBe(1);
  git(f.root, "worktree", "remove", f.worktree);
  const confirmed = await confirmTaskFinalization(f.input); expect(confirmed.confirmedRevision).toBeDefined();
  const projection = await cleanupProjection(db.prisma, f.config, await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } }));
  expect(projection).toMatchObject({ finalizationRetention: { confirmedRevision: confirmed.confirmedRevision, resources: [{ id: f.resource.id, disposition: "retain-reference" }] } });
  await f.unchanged();
}, 15_000);

test("status and authority-only requests never observe GitHub or mint a missing supplement", async () => {
  const f = await fixture(true); expect(String(f.initialError)).toContain("GitHub unavailable");
  await f.active(); await prepareTaskFinalization({ ...f.input, authorityOnly: true });
  const projection = await cleanupProjection(db.prisma, f.config, await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } }));
  expect("finalizationRetention" in projection).toBe(false); expect(f.observations()).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: LOCAL_CLEANUP_REFERENCE } })).toBe(0);
  f.allow(); await prepareTaskFinalization(f.input); expect(f.observations()).toBe(2); await f.unchanged();
}, 15_000);

test.each(["pause", "resource", "contract", "operation"])("late %s drift prevents proof publication after provider IO", async change => {
  const f = await fixture(true); f.allow(); const observe = localCleanupReferenceDependencies.observe;
  localCleanupReferenceDependencies.observe = async reference => {
    const result = await observe(reference);
    if (change === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
    if (change === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { changed: true } } });
    if (change === "contract") await setCompletionContract({ ...f, contract: CompletionContractInput.parse({ requestKey: "revoke", expectedRevision: JSON.parse(f.preparation.value!).contractRevision, boundary: "revoked", basis: "Changed owner direction" }) });
    if (change === "operation") await db.prisma.runtimeMetadataEvent.update({ where: { sequence: f.operation.sequence }, data: { value: f.operation.value + " " } });
    return result;
  };
  await expect(prepareTaskFinalization(f.input)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: LOCAL_CLEANUP_REFERENCE } })).toBe(0);
  expect(await readFile(path.join(f.worktree, "source.txt"), "utf8")).toBe("accepted content");
}, 15_000);

test.each(["url", "head", "plan", "duplicate", "released"])("saved reference refuses %s drift without provider calls", async change => {
  const f = await fixture(), before = f.observations();
  if (change === "url" || change === "head") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: change === "url" ? { externalId: "https://github.com/owner/product/pull/8" } : { metadata: { ...(f.resource.metadata as object), head: "e".repeat(40) } } });
  if (change === "released") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { state: "released" } });
  if (change === "duplicate") await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "alias", kind: "evidence", purpose: "development", externalId: f.resource.externalId, state: "ready" } });
  if (change === "plan") {
    const event = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: LOCAL_CLEANUP_REFERENCE } }), proof = JSON.parse(event.value!);
    proof.resource.key = "other-key";
    await db.prisma.runtimeMetadataEvent.update({ where: { sequence: event.sequence }, data: { value: JSON.stringify(proof) } });
  }
  await expect((async () => localCleanupReferenceRetention(db.prisma, await f.active()))()).rejects.toThrow();
  expect(f.observations()).toBe(before);
}, 15_000);

test("source adoption raw bytes remain part of the new reference binding", async () => {
  const f = await fixture(true, true), archive = path.join(directory, "retained"); await mkdir(archive, { mode: 0o700 });
  git(f.worktree, "bundle", "create", path.join(archive, "source.bundle"), "refs/heads/codex/local"); await chmod(path.join(archive, "source.bundle"), 0o600);
  for (const name of ["index.diff", "worktree.diff"]) await writeFile(path.join(archive, name), "", { mode: 0o600 });
  await writeFile(path.join(archive, "untracked.tar"), Buffer.alloc(1024), { mode: 0o600 });
  const names = ["index.diff", "source.bundle", "untracked.tar", "worktree.diff"], lines: string[] = [];
  for (const name of names) lines.push(`${createHash("sha256").update(await readFile(path.join(archive, name))).digest("hex")}  ${name}`);
  const manifest = lines.join("\n") + "\n"; await writeFile(path.join(archive, "MANIFEST.sha256"), manifest, { mode: 0o600 });
  const adoption = await adoptLegacyOriginalWork({ ...f, adoption: { kind: "original-work", requestKey: "retain-source", finalizationRequestKey: f.input.requestKey,
    expectedPreparedRevision: f.preparation.sequence, expectedPreparedRawDigest: hash(f.preparation.value!), expectedOperationRevision: f.operation.sequence, expectedOperationRawDigest: hash(f.operation.value!), expectedOperationDigest: finalizationDigest(JSON.parse(f.operation.value!)),
    archive: { archiveRoot: archive, manifestPath: path.join(archive, "MANIFEST.sha256"), manifestSha256: hash(manifest), bundlePath: "source.bundle", bundleRef: "refs/heads/codex/local", indexPatchPath: "index.diff", worktreePatchPath: "worktree.diff", untrackedArchivePath: "untracked.tar", expectedWorkingTree: git(f.worktree, "rev-parse", "HEAD^{tree}"), ownedPaths: [path.join(f.worktree, "cache")] } } });
  f.allow(); await prepareTaskFinalization(f.input); await f.unchanged();
  const event = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: adoption.revision } });
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: event.sequence }, data: { value: event.value + " " } });
  await expect((async () => localCleanupReferenceRetention(db.prisma, await f.active()))()).rejects.toThrow();
}, 15_000);

test.each(["valid", "head", "branch", "base", "draft", "unmerged", "ancestry"])("normal GitHub observer independently checks %s", async change => {
  const head = "a".repeat(40), merge = "c".repeat(40);
  const pr = { number: 7, html_url: "https://github.com/owner/product/pull/7", state: "closed", draft: change === "draft", merged: change !== "unmerged", merge_commit_sha: merge, merged_at: "2026-01-01T00:00:00.000Z", head: { sha: change === "head" ? "e".repeat(40) : head, ref: change === "branch" ? "other" : "codex/local", repo: { full_name: "owner/product" } }, base: { ref: change === "base" ? "other" : "main", repo: { full_name: "owner/product" } } };
  const calls: string[][] = [];
  const client = { run: async (command: string, args: string[]) => { calls.push([command, ...args]); return { ok: true, stderr: "", stdout: JSON.stringify(args[1]!.includes("/pulls/") ? pr : args[1]!.includes("/compare/") ? { status: "ahead", merge_base_commit: { sha: change === "ancestry" ? "e".repeat(40) : merge } } : { sha: "d".repeat(40) }) }; } };
  const operation = observeLocalCleanupReference({ id: "published-pr", repository: "owner/product", pullRequest: 7, reviewedHead: head, branch: "codex/local", baseBranch: "main" }, client);
  if (change === "valid") expect((await operation).mergeCommit).toBe(merge); else await expect(operation).rejects.toThrow();
  expect(calls.every(call => call[0] === "gh" && call[1] === "api")).toBe(true);
});


const integrationRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!integrationRoot)("actual configured client retains the verified Ready PR and closes local cleanup last", async () => {
  const f = await fixture();
  const runtime = createFakeAgentRuntime();
  const app = createApp({ prisma: db.prisma, config: f.config, agentRuntime: runtime, trustLocal: true });
  const worker = preparationJournalWorker({ prisma: db.prisma, config: f.config, runtime });
  const timer = setInterval(() => worker.tick(), 20);
  const socket = path.join(directory, "control.sock"), server = Bun.serve({ unix: socket, fetch: app.fetch }); await chmod(socket, 0o600);
  try {
    const { taskRegistry, closeTask } = await import(path.join(integrationRoot!, "src/control.ts"));
    const { finalizeTask } = await import(path.join(integrationRoot!, "src/finalize.ts"));
    const { retainedReferenceIds } = await import(path.join(integrationRoot!, "src/finalization-plan.ts"));
    const registry = taskRegistry(socket, f.task.id);
    expect([...retainedReferenceIds(await registry.task())]).toEqual([f.resource.id]);
    let managed = 0, closed = 0;
    const result = await finalizeTask({ registry, cleanup: true,
      manage: async () => { managed++; throw Error("A persistent reference must never enter a physical adapter"); },
      close: async () => { expect(await readFile(path.join(f.root, "source.txt"), "utf8")).toBe("accepted content"); await closeTask(socket, f.task.id); closed++; },
    });
    expect(result).toMatchObject({ closed: true, reporting: { state: "recorded" } });
    expect(managed).toBe(0); expect(closed).toBe(1); expect(f.observations()).toBe(1);
    expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("closed");
    await f.unchanged();
  } finally { clearInterval(timer); await worker.stop(); server.stop(true); }
}, 30_000);
