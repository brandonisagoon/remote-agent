import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { requestCompute } from "./compute-admission.ts";
import { readComputeReviewRevision } from "./compute-review-revision.ts";

let db: TestDatabase, root: string;
const pin = "d".repeat(40), now = new Date();
beforeEach(async () => { db = await createTestDatabase(); root = await realpath(await mkdtemp(path.join(tmpdir(), "review-revision-"))); });
afterEach(async () => { await db.cleanup(); await rm(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim();
}
async function fixture() {
  const worktree = path.join(root, "product"); await mkdir(worktree); git(worktree, "init", "-q");
  git(worktree, "config", "user.name", "Fixture"); git(worktree, "config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(worktree, "source.txt"), "original"); git(worktree, "add", "."); git(worktree, "commit", "-qm", "Original");
  const originalRevision = git(worktree, "rev-parse", "HEAD");
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "one", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: worktree, status: "idle" } });
  const task = await db.prisma.remoteTask.create({ data: { id: "one", requestKey: "one", repositoryId: "repo", machineId: "host", branchName: "codex/one", worktreePath: worktree, toolingRoot: "/fixture/tooling", toolingRevision: pin, primarySessionId: "primary", phase: "working" } });
  const context = { prisma: db.prisma, machineId: "host", policy: ComputePolicy.parse({ enabled: true, slots: 1 }), now, config: testConfig({ machine: "host" }) };
  const request = { key: "runtime-review", purpose: "review" as const, revision: originalRevision, recipeDigest: "c".repeat(64) };
  const environment = await requestCompute({ ...context, taskId: task.id, request });
  const anchor = async (revision: string) => {
    const directory = path.join(root, "reviews", task.id, revision); await mkdir(directory, { recursive: true, mode: 0o700 });
    const checkout = path.join(directory, "checkout"), file = path.join(directory, "receipt.json"), expiresAt = new Date(now.getTime() + 86400000);
    git(worktree, "worktree", "add", "--detach", checkout, revision);
    const receipt = { version: 1, taskId: task.id, revision, worktree: checkout, commonGitDirectory: git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"), expiresAt: expiresAt.toISOString(), state: "prepared", error: null };
    await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
    const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: `review-${revision}`, kind: "git-worktree", purpose: "review", state: "ready", externalId: checkout, expiresAt,
      metadata: { revision, toolingRevision: pin, receipt: file, environmentStatus: "pending", reviewEnvironments: [`review-${revision}`] } } });
    return { resource, file, receipt, checkout };
  };
  const first = await anchor(originalRevision);
  await writeFile(path.join(worktree, "source.txt"), "corrected"); git(worktree, "add", "."); git(worktree, "commit", "-qm", "Corrected");
  const revision = git(worktree, "rev-parse", "HEAD"), selected = await anchor(revision);
  const advance = (read = readComputeReviewRevision) => requestCompute({ ...context, taskId: task.id, request: { ...request, revision } }, undefined, undefined, read);
  return { task, environment, request, originalRevision, revision, first, selected, advance, worktree };
}

test("review advancement uses the exact detached revision independently of later development HEAD", async () => {
  const f = await fixture(), waiting = await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: f.environment.id } });
  git(f.worktree, "commit", "--allow-empty", "-qm", "Further development");
  const resources = await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
  expect(await f.advance()).toMatchObject({ id: f.environment.id, revision: f.revision, state: "waiting" });
  expect(await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: f.environment.id } })).toEqual(waiting);
  expect(await db.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } })).toEqual(resources);
  expect(await db.prisma.computeOffer.count()).toBe(0);
  await f.advance(); expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-unstarted-revision" } })).toBe(1);
});

test.each(["missing-anchor", "released", "expired", "wrong-pin", "receipt-task", "receipt-expiry", "receipt-allocated", "receipt-error", "receipt-public", "receipt-symlink", "head", "branch", "dirty", "untracked", "locked", "runtime-resource", "provider-resource", "unknown-resource", "foreign-checkout", "foreign-parent", "claim", "pause", "traffic"])("review advancement refuses %s", async fault => {
  const f = await fixture(), { resource, receipt, file, checkout } = f.selected;
  if (fault === "missing-anchor") await db.prisma.remoteTaskResource.delete({ where: { id: resource.id } });
  if (fault === "released") await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { state: "released" } });
  if (fault === "expired") await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { expiresAt: new Date(now.getTime() - 1) } });
  if (fault === "wrong-pin") await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: { ...resource.metadata as object, toolingRevision: "e".repeat(40) } } });
  if (fault.startsWith("receipt-")) {
    if (fault === "receipt-task") receipt.taskId = "foreign";
    if (fault === "receipt-expiry") receipt.expiresAt = new Date(now.getTime() + 86400001).toISOString();
    if (fault === "receipt-allocated") receipt.state = "allocated";
    if (fault === "receipt-error") Object.assign(receipt, { error: "Unverified checkout" });
    await writeFile(file, JSON.stringify(receipt));
    if (fault === "receipt-public") await chmod(file, 0o644);
    if (fault === "receipt-symlink") { await rename(file, `${file}.original`); await symlink(`${file}.original`, file); }
  }
  if (fault === "head") git(checkout, "checkout", "--detach", f.originalRevision);
  if (fault === "branch") git(checkout, "checkout", "-qb", "attached-review");
  if (fault === "dirty") await writeFile(path.join(checkout, "source.txt"), "uncommitted");
  if (fault === "untracked") await writeFile(path.join(checkout, "untracked.txt"), "uncommitted");
  if (fault === "locked") git(f.worktree, "worktree", "lock", checkout);
  if (fault.endsWith("-resource")) await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "not-preparation", purpose: "review", kind: fault === "runtime-resource" ? "task-runtime" : fault === "provider-resource" ? "redis" : "unknown-kind", externalId: "existing", state: "released" } });
  if (fault.startsWith("foreign-")) {
    await db.prisma.remoteTask.create({ data: { id: "peer", requestKey: "peer", repositoryId: "repo", machineId: "host", branchName: "codex/peer", toolingRoot: "/fixture/tooling", toolingRevision: pin } });
    await db.prisma.remoteTaskResource.create({ data: { taskId: "peer", key: "foreign", kind: "directory", purpose: "review", externalId: fault === "foreign-parent" ? path.dirname(checkout) : checkout, state: "ready" } });
  }
  if (fault === "claim") await db.prisma.computeOffer.create({ data: { id: "old", environmentId: f.environment.id, machineId: "host", instructionId: "old", state: "stopped", claimedAt: now, dispatchDeadline: now } });
  if (fault === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (fault === "traffic") await db.prisma.computeTraffic.create({ data: { routeId: "route", environmentId: f.environment.id, taskId: f.task.id, epoch: "epoch", state: {} } });
  await expect(f.advance()).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(f.originalRevision);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-unstarted-revision" } })).toBe(0);
});

test.each(["receipt", "resource", "pause", "claim"])("review advancement rechecks %s after physical observation", async fault => {
  const f = await fixture(); let calls = 0;
  await expect(f.advance(async (...args) => {
    const proof = await readComputeReviewRevision(...args);
    if (++calls === 1) {
      if (fault === "receipt") await writeFile(f.selected.file, `${await readFile(f.selected.file, "utf8")}\n`);
      if (fault === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.selected.resource.id }, data: { state: "failed" } });
      if (fault === "pause") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
      if (fault === "claim") await db.prisma.computeOffer.create({ data: { id: "racing", environmentId: f.environment.id, machineId: "host", instructionId: "racing", state: "claimed", claimedAt: now, dispatchDeadline: now } });
    }
    return proof;
  })).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(f.originalRevision);
});

test("an unrelated task progress update does not change review source authority", async () => {
  const f = await fixture(); let calls = 0;
  expect(await f.advance(async (...args) => {
    const proof = await readComputeReviewRevision(...args);
    if (++calls === 1) await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { recoveryDetail: "Actual browser verification continues" } });
    return proof;
  })).toMatchObject({ revision: f.revision });
});
