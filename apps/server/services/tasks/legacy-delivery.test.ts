import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { completionObservation } from "./completion-observation.ts";
import { externalBindingDependencies } from "./external-deliveries.ts";
import { DeliveredRetirementInput } from "./external-delivery-schema.ts";
import { adoptLegacyDelivery, inspectLegacyDelivery, legacyDeliveryDependencies } from "./legacy-delivery.ts";
import { assertExternalDoneAllowed, confirmExternalFinalization, prepareExternalFinalization } from "./external-finalization.ts";
import { observeDeliveredScope } from "./delivered-retirement-observation.ts";
import { revokeDeliveredRetirement } from "./delivered-retirement-revocation.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "legacy-delivered-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("present-day acceptance freezes clean staging correspondence without inventing historical authority or changing recorded branch", async () => {
  const f = await fixture(), request = await f.request();
  const adopted = await adoptLegacyDelivery({ ...f.context, retirement: request }, f.dependencies);
  expect(adopted.binding.contractRevision).toBeNull(); expect(adopted.binding.verificationRevision).toBeNull();
  expect(adopted.binding.identity.branch).toBe("codex/original-task");
  expect(adopted.binding.cleanupSnapshot).toMatchObject({ branch: "staging", head: f.merge, clean: true });
  expect(adopted.binding.deliveries[0]).toMatchObject({ reviewedHead: f.reviewed, mergeCommit: f.merge });
  expect(await adoptLegacyDelivery({ ...f.context, retirement: request }, f.dependencies)).toEqual(adopted);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: ["completion-contract", "completion-verification", "completion-owner-approval"] } } })).toBe(0);
  const prepared = await prepareExternalFinalization(f.finalizer, f.dependencies);
  expect(prepared).toMatchObject({ contractRevision: null, branch: "staging", revision: f.merge, deliveredRetirement: { recordedBranch: "codex/original-task" }, doneHandoff: { expectedState: "Done", state: "Done" } });
  await expect(confirmExternalFinalization(f.finalizer, f.dependencies)).rejects.toThrow("still exists");
  git(f.root, "worktree", "remove", f.worktree);
  const confirmed = await confirmExternalFinalization(f.finalizer, f.dependencies);
  expect(await confirmExternalFinalization(f.finalizer, f.dependencies)).toEqual(confirmed);
  expect(await prepareExternalFinalization(f.finalizer, f.dependencies)).toEqual(confirmed);
  expect(git(f.root, "rev-parse", "staging")).toBe(f.merge);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).branchName).toBe("codex/original-task");
  await assertExternalDoneAllowed({ ...f.finalizer, ...confirmed.doneHandoff }, f.dependencies);
  await expect(assertExternalDoneAllowed({ ...f.finalizer, ...confirmed.doneHandoff, body: "different" }, f.dependencies)).rejects.toThrow("immutable");
  expect(f.issue.state.name).toBe("Done");
});

test.each(["branch", "head", "dirty", "source", "pin", "resource"])("changed %s during observation refuses adoption before any authority is stored", async changed => {
  const f = await fixture(), request = await f.request();
  const dependencies = { ...f.dependencies, delivered: async (...args: Parameters<typeof f.dependencies.delivered>) => {
    if (changed === "branch") git(f.worktree, "switch", "-c", "foreign");
    if (changed === "head") { await writeFile(path.join(f.worktree, "new"), "later"); git(f.worktree, "add", "."); git(f.worktree, "commit", "-m", "later"); }
    if (changed === "dirty") await writeFile(path.join(f.worktree, "untracked"), "preserve me");
    if (changed === "source") f.issue.state = { id: "blocked", name: "Blocked", type: "started" };
    if (changed === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
    if (changed === "resource") await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "later", kind: "evidence", purpose: "development", externalId: "/foreign" } });
    return f.dependencies.delivered(...args);
  } };
  await expect(adoptLegacyDelivery({ ...f.context, retirement: request }, dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "external-delivery-binding" } })).toBe(0);
});

test("revocation and changed owner state block prepared retries; a stale same-key adoption cannot restore them", async () => {
  const f = await fixture(), request = await f.request();
  const adopted = await adoptLegacyDelivery({ ...f.context, retirement: request }, f.dependencies);
  await prepareExternalFinalization(f.finalizer, f.dependencies);
  f.issue.state = { id: "blocked", name: "Blocked", type: "started" };
  await expect(prepareExternalFinalization(f.finalizer, f.dependencies)).rejects.toThrow("Done source");
  f.issue.state = { id: "done", name: "Done", type: "completed" };
  const revocation = { requestKey: "revoke", expectedRevision: adopted.revision, basis: "Owner stopped cleanup" };
  expect(await revokeDeliveredRetirement({ prisma: db.prisma, taskId: "task", revocation })).toEqual(await revokeDeliveredRetirement({ prisma: db.prisma, taskId: "task", revocation }));
  await expect(prepareExternalFinalization(f.finalizer, f.dependencies)).rejects.toThrow("owner authority changed");
  await expect(adoptLegacyDelivery({ ...f.context, retirement: request }, f.dependencies)).rejects.toThrow();
});

test("bare Done, unmerged original bytes and arbitrary clean commits do not confer retirement authority", async () => {
  const f = await fixture();
  await expect(prepareExternalFinalization(f.finalizer, f.dependencies)).rejects.toThrow("adopted");
  await writeFile(path.join(f.worktree, "README.md"), "unmerged original bytes");
  await expect(f.request()).rejects.toThrow("Unfinished original work");
  git(f.worktree, "add", "."); git(f.worktree, "commit", "-m", "unmerged original");
  await expect(adoptLegacyDelivery({ ...f.context, retirement: await f.request() }, f.dependencies)).rejects.toThrow("exact accepted PR");
});

test("provider evidence binds external required check IDs to the exact reviewed head without Actions run fiction", async () => {
  const f = await fixture();
  const observed = await observeDeliveredScope(f.delivery, f.client);
  expect(observed.ci).toEqual([]); expect(observed.snapshot).toBeUndefined();
  expect(observed.checks).toEqual([{ name: "CI / CI Passed", head: f.reviewed, kind: "check-run", id: 17, appId: 23, conclusion: "success" }]);
  for (const error of ["wrong head", "failed", "wrong app link", "missing required", "wrong ancestry"]) {
    f.providerFault = error;
    await expect(observeDeliveredScope(f.delivery, f.client)).rejects.toThrow();
  }
});

async function fixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  git(root, "remote", "add", "origin", "https://github.com/owner/product.git");
  await writeFile(path.join(root, "README.md"), "accepted PR content\n"); git(root, "add", "."); git(root, "commit", "-m", "reviewed");
  const reviewed = git(root, "rev-parse", "HEAD");
  git(root, "commit", "--allow-empty", "-m", "accepted merge"); const merge = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", "-b", "staging", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-8", primarySessionId: session.id, branchName: "codex/original-task", worktreePath: worktree, toolingRoot: directory, toolingRevision: "a".repeat(40), pinnedToolingRoot: directory, phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-8", relationship: "handles" } });
  const issue = { id: "issue", identifier: "DRA-8", updatedAt: "2026-10-30T04:00:00.000Z", branchName: "codex/original-task", title: "Task", description: "Request", state: { id: "done", name: "Done", type: "completed" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const delivery = { id: "accepted", repository: "owner/product", pullRequest: 4190, branch: "codex/original-task", reviewedHead: reviewed, expectedMergeCommit: merge, baseBranch: "staging", requiredChecks: ["CI / CI Passed"] };
  const context = { prisma: db.prisma, config, taskId: "task" }, finalizer = { ...context, sessionId: session.id, requestKey: "finalize:task", finalizationVersion: 2 as const };
  let fault = "";
  const client = { run: async (_command: string, args: string[]) => {
    const endpoint = args[1] ?? "";
    let value: unknown;
    if (args[0] === "pr") value = fault === "missing required" ? [] : [{ name: "CI / CI Passed", state: "SUCCESS", link: "https://provider.test/check/17" }];
    else if (endpoint.includes("/pulls/")) value = { number: 4190, html_url: "https://github.com/owner/product/pull/4190", state: "closed", draft: false, merged: true, merge_commit_sha: merge, merged_at: "2026-10-28T04:00:00.000Z", head: { sha: reviewed, ref: delivery.branch, repo: { full_name: delivery.repository } }, base: { ref: "staging", repo: { full_name: delivery.repository } } };
    else if (endpoint.includes("/compare/")) value = { status: "identical", merge_base_commit: { sha: fault === "wrong ancestry" ? reviewed : merge } };
    else if (endpoint.includes("/check-runs")) value = { total_count: 1, check_runs: [{ id: 17, name: "CI / CI Passed", head_sha: fault === "wrong head" ? merge : reviewed, status: "completed", conclusion: fault === "failed" ? "failure" : "success", html_url: fault === "wrong app link" ? "https://foreign.test/check" : "https://provider.test/check/17", app: { id: 23 } }] };
    else if (endpoint.includes("/status?")) value = { sha: reviewed, total_count: 0, statuses: [] };
    else value = { sha: merge };
    return { ok: true, stdout: JSON.stringify(value), stderr: "" };
  } };
  const dependencies = { ...legacyDeliveryDependencies, source: async () => ({ session, link, config, issue }), delivered: (input: typeof delivery) => observeDeliveredScope(input, client) };
  const request = async () => { const observed = await inspectLegacyDelivery(context, dependencies); return DeliveredRetirementInput.parse({ version: 1, mode: "legacy-delivery", requestKey: "present-day-retirement", expectedBindingRevision: observed.revision, expectedIdentityDigest: observed.identityDigest, source: observed.source, basis: "Standing owner direction to finish delivered non-workflow work", cleanupSnapshot: observed.cleanupSnapshot, deliveries: [delivery], mergeOrder: [delivery.id], resourceIds: [], ownership: { ownedPaths: [] } }); };
  return { root, worktree, reviewed, merge, session, issue, config, context, finalizer, dependencies, delivery, client, request, set providerFault(value: string) { fault = value; } };
}
