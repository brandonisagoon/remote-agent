import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { claimCompute, confirmComputeDelivery, offerNextCompute, requestCompute } from "./compute-admission.ts";
import { readComputeWorktreeRevision } from "./compute-worktree-revision.ts";
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";

let db: TestDatabase;
const A = "a".repeat(40), B = "b".repeat(40);
const request = { key: "runtime-development", purpose: "development" as const, revision: A, recipeDigest: "c".repeat(64) };
const policy = ComputePolicy.parse({ enabled: true, slots: 1 });
const now = new Date("2030-01-01T00:00:00Z");
const context = () => ({ prisma: db.prisma, machineId: "host", policy, now, config: testConfig({ machine: "host" }) });
const next = () => ({ ...request, revision: B });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function task(id = "one", worktree = `/fixture/${id}`, initial = request) {
  await db.prisma.runtimeSession.create({ data: { id: `primary-${id}`, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: worktree, status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id, requestKey: id, repositoryId: "repo", machineId: "host", branchName: `codex/${id}`, worktreePath: worktree, toolingRoot: "/fixture/tooling", toolingRevision: "d".repeat(40), primarySessionId: `primary-${id}`, phase: "working" } });
  return requestCompute({ ...context(), taskId: id, request: initial });
}
const advance = (head: (worktree: string) => Promise<string> = async () => B) => requestCompute({ ...context(), taskId: "one", request: next() }, undefined, head);

test.each(["directory", "evidence", "clerk-test-user"])("preparation %s survives a never-started revision advance", async kind => {
  const environment = await task();
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "one", key: "preparation-input", kind, purpose: "development", externalId: "/fixture/preparation", state: "ready", metadata: { taskId: "one", retained: true } } });
  const waiting = await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } });
  expect(await advance()).toMatchObject({ id: environment.id, revision: B, state: "waiting" });
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
  expect(await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } })).toEqual(waiting);
  expect(await db.prisma.computeOffer.count({ where: { claimedAt: { not: null } } })).toBe(0);
});

test.each(["task-runtime", "native-app", "launch-agent", "launch-agents", "docker-container", "docker-compose-project", "neon-branch", "redis", "storage", "docker-volume", "unknown-kind", "directory-runtime-key", "evidence-runtime-key"])("runtime, provider or ambiguous preparation blocks revision advance: %s", async kind => {
  const environment = await task();
  const collision = kind.endsWith("-runtime-key");
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "one", key: collision ? request.key : "existing-resource", kind: collision ? kind.slice(0, -"-runtime-key".length) : kind, purpose: "development", externalId: "/fixture/existing", state: "released" } });
  await expect(advance()).rejects.toThrow("existing resources");
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(A);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
});

test("a preparation resource becoming runtime evidence during HEAD observation refuses atomically", async () => {
  const environment = await task();
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "one", key: "preparation", kind: "directory", purpose: "development", externalId: "/fixture/preparation" } });
  await expect(advance(async () => {
    await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { kind: "task-runtime" } });
    return B;
  })).rejects.toThrow("existing resources");
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(A);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-unstarted-revision" } })).toBe(0);
});

test("never-started revision keeps the same environment, queue position and offer history, once", async () => {
  const environment = await task(); await task("peer");
  const offer = (await offerNextCompute(context()))!;
  // Fixture: the assignment was withdrawn (selection-time reservation released).
  await db.prisma.computeOffer.update({ where: { id: offer.id }, data: { state: "expired", completedAt: now } });
  await db.prisma.computeSlot.updateMany({ where: { allocationId: offer.id }, data: { allocationId: null } });
  await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "completed" } });
  const waiting = await db.prisma.computeWait.findMany({ orderBy: { sequence: "asc" } });
  const updated = await advance();
  expect(updated).toMatchObject({ id: environment.id, revision: B, state: "waiting", taskIdentity: environment.taskIdentity, recipeDigest: request.recipeDigest });
  expect(await db.prisma.computeWait.findMany({ orderBy: { sequence: "asc" } })).toEqual(waiting);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("expired");
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  expect(await db.prisma.remoteTaskResource.count()).toBe(0);
  await advance();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-unstarted-revision" } })).toBe(1);
  expect((await offerNextCompute(context()))!.environmentId).toBe(environment.id);
  await expect(claimCompute({ ...context(), taskId: "one", offerId: offer.id, request: next() })).rejects.toThrow("expired or superseded");
});

test.each([false, true])("unclaimed offer delivered=%s is withdrawn without rotating the queue", async delivered => {
  const environment = await task(); const offer = (await offerNextCompute(context()))!;
  if (delivered) {
    await db.prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: offer.id, runtimeSessionId: "primary-one", requestId: offer.instructionId, phase: "started", occurredAt: now } });
    await confirmComputeDelivery({ ...context(), sessionId: "primary-one", requestId: offer.instructionId });
  }
  const waiting = await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } });
  await advance();
  expect(await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } })).toEqual(waiting);
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("ineligible");
  expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  await expect(claimCompute({ ...context(), taskId: "one", offerId: offer.id, request: next() })).rejects.toThrow("expired or superseded");
});

test.each(["validating", "claimed", "running", "unknown", "stopped", "claimed-history"])("refuses prior or uncertain compute: %s", async state => {
  const environment = await task(); const offer = (await offerNextCompute(context()))!;
  await db.prisma.computeOffer.update({ where: { id: offer.id }, data: { state: state === "claimed-history" ? "expired" : state, claimedAt: now } });
  await expect(advance()).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(A);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-unstarted-revision" } })).toBe(0);
});

test.each(["resource", "released-resource", "binding", "configuration", "observation", "traffic", "unexplained-slot", "no-wait", "review", "recipe", "pause", "closed", "pin", "primary", "stop"])("refuses changed or nonempty evidence: %s", async fault => {
  const environment = await task();
  if (["resource", "released-resource"].includes(fault)) await db.prisma.remoteTaskResource.create({ data: { taskId: "one", key: request.key, kind: "task-runtime", purpose: "development", externalId: "/fixture/runtime.json", state: fault === "resource" ? "allocated" : "released" } });
  if (fault === "binding") await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { resourceId: "missing" } });
  if (fault === "configuration" || fault === "observation") await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { [fault]: {} } });
  if (fault === "traffic") await db.prisma.computeTraffic.create({ data: { routeId: "route", environmentId: environment.id, taskId: "one", epoch: "epoch", state: {} } });
  if (fault === "unexplained-slot") {
    // A queued assignment explains its own reservation; a withdrawn one cannot.
    const offer = (await offerNextCompute(context()))!;
    await db.prisma.computeOffer.update({ where: { id: offer.id }, data: { state: "expired" } });
    await db.prisma.computeSlot.update({ where: { id: "host:0" }, data: { allocationId: offer.id } });
  }
  if (fault === "no-wait") await db.prisma.computeWait.delete({ where: { environmentId: environment.id } });
  if (fault === "review") await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { purpose: "review" } });
  if (fault === "recipe") await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { recipeDigest: "e".repeat(64) } });
  if (fault === "pause") await db.prisma.remoteTask.update({ where: { id: "one" }, data: { ownerPaused: true } });
  if (fault === "closed") await db.prisma.remoteTask.update({ where: { id: "one" }, data: { phase: "closed" } });
  if (fault === "pin") await db.prisma.remoteTask.update({ where: { id: "one" }, data: { toolingRevision: "e".repeat(40) } });
  if (fault === "primary") await db.prisma.runtimeSession.update({ where: { id: "primary-one" }, data: { role: "delegate" } });
  if (fault === "stop") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary-one", source: "development:one", action: "development-compute-intent", key: "stop", value: JSON.stringify({ version: 1, action: "stop" }) } });
  await expect(advance()).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(A);
});

test.each(["head", "head-race", "claim-race", "resource-race", "pause-race"])("observation changes abort atomically: %s", async fault => {
  const environment = await task(); const waiting = await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } });
  let calls = 0;
  await expect(advance(async () => {
    calls++;
    if (calls === 1 && fault === "claim-race") { const offer = (await offerNextCompute(context()))!; await db.prisma.computeOffer.update({ where: { id: offer.id }, data: { state: "claimed", claimedAt: now } }); }
    if (calls === 1 && fault === "resource-race") await db.prisma.remoteTaskResource.create({ data: { taskId: "one", key: request.key, kind: "task-runtime", purpose: "development", externalId: "/fixture/runtime.json" } });
    if (calls === 1 && fault === "pause-race") await db.prisma.remoteTask.update({ where: { id: "one" }, data: { ownerPaused: true } });
    return fault === "head" || fault === "head-race" && calls === 2 ? A : B;
  })).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(A);
  expect(await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } })).toEqual(waiting);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-unstarted-revision" } })).toBe(0);
});

test("default observer reads actual Git HEAD and rejects an aliased worktree", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "compute-head-")));
  try {
    const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", root, ...args]); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
    git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
    expect(await readComputeWorktreeRevision(root)).toBe(git("rev-parse", "HEAD"));
    await symlink(root, `${root}-link`);
    try { await expect(readComputeWorktreeRevision(`${root}-link`)).rejects.toThrow(); } finally { await rm(`${root}-link`); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary HTTP request advances actual product HEAD but creates no claim or provider", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "compute-head-http-")));
  try {
    const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", root, ...args]); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
    git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
    const environment = await task("one", root, { ...request, revision: git("rev-parse", "HEAD") });
    for (const kind of ["directory", "evidence", "clerk-test-user"]) await db.prisma.remoteTaskResource.create({ data: { taskId: "one", key: `preparation-${kind}`, kind, purpose: "development", externalId: `/fixture/${kind}`, state: "ready" } });
    const preparation = await db.prisma.remoteTaskResource.findMany({ where: { taskId: "one" }, orderBy: { id: "asc" } });
    const waiting = await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } });
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "product change");
    const revision = git("rev-parse", "HEAD");
    const app = createApp({ prisma: db.prisma, config: testConfig({ machine: "host", compute: policy }), agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const response = await app.request("http://localhost/api/tasks/one/compute-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request, revision }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ enabled: true, environment: { id: environment.id, revision, state: "waiting" } });
    expect(await db.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: environment.id } })).toEqual(waiting);
    expect(await db.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
    expect(await db.prisma.computeOffer.count({ where: { claimedAt: { not: null } } })).toBe(0);
    expect(await db.prisma.remoteTaskResource.findMany({ where: { taskId: "one" }, orderBy: { id: "asc" } })).toEqual(preparation);
  } finally { await rm(root, { recursive: true, force: true }); }
});
