import { afterEach, expect, test } from "bun:test";
import { Prisma } from "../../../../generated/prisma/client.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { computeTaskIdentity, requestCompute, offerNextCompute, claimCompute } from "./compute-admission.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { reclaimStoppedCompute } from "./compute-reclamation.ts";
import { ComputeObservation } from "./compute-observation.ts";
import { tickCompute } from "./compute-worker.ts";
import { readInstalledComputeReclamation } from "./compute-observer.ts";
import { chmod, mkdir, mkdtemp, readFile, rename, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { retainComputeAccountingInput } from "./compute-accounting-input.ts";
import { readDevelopmentJson } from "./development-selection.ts";
import { createApp } from "../../app.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(closed = false) {
  const db = await createTestDatabase(); cleanup.push(db.cleanup); const prisma = db.prisma;
  const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
  const session = await prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "fixture", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/absent/product", status: closed ? "closed" : "idle", ...(closed ? { closedAt: new Date() } : {}) } });
  const task = await prisma.remoteTask.create({ data: { id: "task", requestKey: "fixture", repositoryId: "repo", machineId: "host", branchName: "codex/fixture", worktreePath: session.cwd, toolingRoot: "/old/tooling", toolingRevision: "a".repeat(40), primarySessionId: session.id, ownerPaused: !closed, phase: closed ? "closed" : "working" } });
  const configuration = { configurationFile: "/private/compute.json", configurationSha256: "b".repeat(64) };
  const resource = await prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "app", kind: "task-runtime", purpose: "development", externalId: "/private/runtime.json", state: closed ? "released" : "ready", metadata: { compute: configuration, containerId: "c".repeat(64), revision: "d".repeat(40), recipeHash: "e".repeat(64) } } });
  const identity = finalizationResourceIdentity(resource).identityDigest;
  const environment = await prisma.computeEnvironment.create({ data: { id: crypto.randomUUID(), taskId: task.id, primarySessionId: session.id, machineId: "host", taskIdentity: computeTaskIdentity(task, session.id, "host", null), key: resource.key, purpose: "development", revision: "d".repeat(40), recipeDigest: "e".repeat(64), resourceId: resource.id, resourceIdentity: identity, state: "running", configuration } });
  const instruction = await prisma.runtimeInstruction.create({ data: { id: "delivered", sessionId: session.id, text: "original offer", state: "completed" } });
  const offer = await prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: environment.id, machineId: "host", instructionId: instruction.id, state: "running", dispatchDeadline: new Date(), claimedAt: new Date() } });
  await prisma.computeSlot.create({ data: { id: "host:0", machineId: "host", ordinal: 0, allocationId: offer.id } });
  const context = { prisma, config, environmentId: environment.id, runtime: createFakeAgentRuntime() };
  const read: typeof readInstalledComputeReclamation = async (_input, _task, raw: any) => ({ version: 1, kind: "compute-reclamation", environmentId: raw.environment.id, taskId: raw.task.id, primarySessionId: raw.task.primarySessionId,
    resourceId: raw.resource.id, resourceIdentity: raw.resource.identityDigest, allocationResourceIdentity: raw.allocationResourceIdentity, configurationDigest: raw.configurationDigest, observedAt: Date.now(), state: closed ? "absent" : "stopped", proofDigest: "f".repeat(64) });
  return { ...context, context, task, session, environment, resource, offer, read, configuration };
}
async function retainedFixture() {
  const f = await fixture(true);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "retained-compute-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "compute.json");
  const bytes = JSON.stringify({ taskId: f.task.id, primarySessionId: f.session.id, environmentId: f.environment.id,
    resourceKey: f.resource.key, purpose: f.environment.purpose, revision: f.environment.revision, recipeDigest: f.environment.recipeDigest });
  await writeFile(file, bytes, { mode: 0o600 });
  const configuration = { ...f.configuration, configurationSha256: createHash("sha256").update(bytes).digest("hex") };
  const resource = await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), compute: configuration } } });
  const identity = finalizationResourceIdentity(resource).identityDigest;
  const environment = await f.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { configuration, resourceIdentity: identity } });
  const request = { environmentId: environment.id, resourceIdentity: identity, allocationResourceIdentity: identity,
    configurationSha256: configuration.configurationSha256, retainedConfigurationFile: file };
  const input = { ...f.context, taskId: f.task.id, request };
  const rows = async () => ({ task: await f.prisma.remoteTask.findUnique({ where: { id: f.task.id } }),
    resource: await f.prisma.remoteTaskResource.findUnique({ where: { id: resource.id } }),
    environment: await f.prisma.computeEnvironment.findUnique({ where: { id: environment.id } }),
    offers: await f.prisma.computeOffer.findMany(), slots: await f.prisma.computeSlot.findMany(),
    instructions: await f.prisma.runtimeInstruction.findMany() });
  return { ...f, resource, environment, request, input, file, root, rows };
}
test("retained input registration preserves original rows; only a later physical collector can reclaim", async () => {
  const f = await retainedFixture(), before = await f.rows();
  await retainComputeAccountingInput(f.input);
  await retainComputeAccountingInput(f.input);
  expect(await f.rows()).toEqual(before);
  expect(await f.prisma.runtimeMetadataEvent.count()).toBe(1);
  const read: typeof f.read = async (...args) => {
    const raw = args[2] as any;
    expect(raw.resource.metadata.compute.configurationFile).toBe(f.file);
    expect(raw.resource.identityDigest).toBe(f.request.resourceIdentity);
    expect(raw.configurationDigest).toBe(f.request.configurationSha256);
    return f.read(...args);
  };
  // A failed inventory still retains the exact charge, despite a valid locator.
  await expect(reclaimStoppedCompute(f.context, async () => { throw new Error("inventory unknown"); })).rejects.toThrow("inventory unknown");
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
  expect(await reclaimStoppedCompute(f.context, read)).toEqual({ released: true });
  expect(await f.prisma.remoteTaskResource.findUnique({ where: { id: f.resource.id } })).toEqual(before.resource);
  expect(await f.prisma.remoteTask.findUnique({ where: { id: f.task.id } })).toEqual(before.task);
  expect((await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).configuration).toEqual(before.environment!.configuration);
});
test.each(["hash", "identity", "allocation", "task", "active", "unfenced", "public", "symlink", "changed-during-read"])("retained input %s refuses with no registration", async fault => {
  const f = await retainedFixture();
  if (fault === "hash") await writeFile(f.file, "{}");
  if (fault === "identity") f.request.resourceIdentity = "9".repeat(64);
  if (fault === "allocation") f.request.allocationResourceIdentity = "9".repeat(64);
  if (fault === "task") f.input.taskId = "other";
  if (fault === "active") f.context.runtime.observeSessionActivity = f.input.runtime.observeSessionActivity = () => ({ state: "executing" } as never);
  if (fault === "unfenced") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working" } });
  if (fault === "public") await chmod(f.file, 0o644);
  if (fault === "symlink") { const link = path.join(f.root, "link.json"); await symlink(f.file, link); f.request.retainedConfigurationFile = link; }
  const before = await f.rows();
  const read: typeof readDevelopmentJson = async (...args) => {
    const value = await readDevelopmentJson(...args);
    if (fault === "changed-during-read") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { updatedAt: new Date(Date.now() + 1000) } });
    return value;
  };
  await expect(retainComputeAccountingInput(f.input, read)).rejects.toThrow();
  expect(await f.prisma.runtimeMetadataEvent.count()).toBe(0);
  if (fault !== "changed-during-read") expect(await f.rows()).toEqual(before);
});
test.each(["new-locator", "duplicate", "malformed", "foreign-session", "new-pin"])("retained input %s cannot replace or reinterpret the immutable binding", async fault => {
  const f = await retainedFixture();
  await retainComputeAccountingInput(f.input);
  const row = (await f.prisma.runtimeMetadataEvent.findFirst())!;
  if (fault === "new-locator") {
    const file = path.join(f.root, "other.json"); await writeFile(file, await readFile(f.file), { mode: 0o600 });
    f.request.retainedConfigurationFile = file;
    await expect(retainComputeAccountingInput(f.input)).rejects.toThrow("already bound");
  } else {
    if (fault === "duplicate") { const { sequence: _, ...data } = row; await f.prisma.runtimeMetadataEvent.create({ data }); }
    if (fault === "malformed") await f.prisma.runtimeMetadataEvent.update({ where: { sequence: row.sequence }, data: { value: "{}" } });
    if (fault === "foreign-session") {
      const other = await f.prisma.runtimeSession.create({ data: { scopeKey: "foreign", agentCommand: "codex", repositoryId: "repo", cwd: "/foreign", role: "delegate", status: "closed" } });
      await f.prisma.runtimeMetadataEvent.update({ where: { sequence: row.sequence }, data: { runtimeSessionId: other.id } });
    }
    if (fault === "new-pin") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "9".repeat(40) } });
    let ran = false;
    await expect(reclaimStoppedCompute(f.context, async (...args) => { ran = true; return f.read(...args); })).rejects.toThrow();
    expect(ran).toBeFalse();
  }
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
});
test("retained input route requires owner bearer even on local socket; rejects adapter headers and grants no credit", async () => {
  const f = await retainedFixture();
  const app = createApp({ config: f.config, prisma: f.prisma, agentRuntime: f.context.runtime, trustLocal: true });
  const post = (headers: Record<string, string>) => app.request(`/api/tasks/${f.task.id}/compute-accounting-input`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(f.request) });
  expect((await post({})).status).toBe(401);
  expect((await post({ authorization: `Bearer ${f.config.apiKey}`, "x-remote-agent-operation": "fake" })).status).toBe(400);
  const before = await f.rows();
  expect((await post({ authorization: `Bearer ${f.config.apiKey}` })).status).toBe(200);
  expect(await f.rows()).toEqual(before);
});
test("a retained locator registered during physical observation invalidates that observation", async () => {
  const f = await retainedFixture();
  await expect(reclaimStoppedCompute(f.context, async (...args) => {
    await retainComputeAccountingInput(f.input);
    return f.read(...args);
  })).rejects.toThrow("changed during observation");
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
  expect((await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).observation).toBeNull();
});
test.each([false, true])("paused/closed=%s exact stopped capacity releases without start authority or owner mutation", async closed => {
  const f = await fixture(closed);
  const beforeTask = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  expect(await reclaimStoppedCompute(f.context, f.read)).toEqual({ released: true });
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(beforeTask);
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBeNull();
  expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("stopped");
  const environment = await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  expect(ComputeObservation.safeParse(environment.observation).success).toBeFalse();
  await expect(claimCompute({ prisma: f.prisma, machineId: "host", policy: f.config.compute!, taskId: f.task.id, offerId: f.offer.id,
    request: { key: environment.key, purpose: "development", revision: environment.revision, recipeDigest: environment.recipeDigest } })).rejects.toThrow("eligible");
  expect(await reclaimStoppedCompute(f.context, f.read)).toEqual({ released: true });
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-capacity-reclaimed" } })).toBe(1);
});
test("collector reclaims paused capacity before any active observer or Decisions path", async () => {
  const f = await fixture(); let decisions = 0;
  const result = await tickCompute(f.context, { reclaim: input => reclaimStoppedCompute(input, f.read), refresh: async () => { throw new Error("No active capability allowed"); }, consider: async () => { decisions++; throw new Error("No decision allowed"); } });
  expect(result).toEqual({ observed: 1, unavailable: 0 }); expect(decisions).toBe(0);
  const session = await f.prisma.runtimeSession.create({ data: { id: "next", scopeKey: "next", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/next", status: "idle" } });
  await f.prisma.remoteTask.create({ data: { id: "next", requestKey: "next", repositoryId: "repo", machineId: "host", branchName: "next", worktreePath: session.cwd, toolingRoot: "/tooling", toolingRevision: "a".repeat(40), primarySessionId: session.id, phase: "working" } });
  const context = { prisma: f.prisma, machineId: "host", policy: f.config.compute! };
  await requestCompute({ ...context, taskId: "next", request: { key: "new", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  const next = await offerNextCompute(context); expect(next).not.toBeNull();
  expect((await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: next!.environmentId } })).taskId).toBe("next");
});
for (const closed of [false, true]) test.each(["running", "unknown", "failed"])(`new %s evidence invalidates prior free capacity (closed=${closed})`, async state => {
  const f = await fixture(closed);
  expect(await reclaimStoppedCompute(f.context, f.read)).toEqual({ released: true });
  const read: typeof f.read = async (...args) => { if (state === "failed") throw new Error("physical observer unavailable"); return { ...await f.read(...args) as object, state }; };
  if (state === "failed") await expect(reclaimStoppedCompute(f.context, read)).rejects.toThrow("observer unavailable");
  else expect(await reclaimStoppedCompute(f.context, read)).toEqual({ released: false });
  const session = await f.prisma.runtimeSession.create({ data: { id: "next", scopeKey: "next", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/next", status: "idle" } });
  await f.prisma.remoteTask.create({ data: { id: "next", requestKey: "next", repositoryId: "repo", machineId: "host", branchName: "next", worktreePath: session.cwd, toolingRoot: "/tooling", toolingRevision: "a".repeat(40), primarySessionId: session.id, phase: "working" } });
  const context = { prisma: f.prisma, machineId: "host", policy: f.config.compute! };
  await requestCompute({ ...context, taskId: "next", request: { key: "new", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  expect(await offerNextCompute(context)).toBeNull();
  expect((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).ownerPaused).toBe(!closed);
});
test.each([false, true])("cleanup metadata progress keeps the original physical target (replacement=%s)", async replacement => {
  const f = await fixture(true);
  await f.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { configuration: Prisma.DbNull, observation: {
    version: 1, environmentId: f.environment.id, taskId: f.task.id, primarySessionId: f.session.id, purpose: "development", revision: f.environment.revision, recipeDigest: f.environment.recipeDigest,
    resourceId: f.resource.id, resourceIdentity: f.environment.resourceIdentity, observedAt: Date.now(), state: "running", coverage: "incomplete", configurationDigest: f.configuration.configurationSha256, routes: [], operations: { coverage: "incomplete", active: 0, generation: "a".repeat(64) },
  } } });
  await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), providers: [{ released: true }],
    compute: { ...f.configuration, ...(replacement ? { configurationSha256: "9".repeat(64) } : {}) } } } });
  if (replacement) await expect(reclaimStoppedCompute(f.context, f.read)).rejects.toThrow("original physical configuration");
  else {
    expect(await reclaimStoppedCompute(f.context, f.read)).toEqual({ released: true });
    const current = await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
    expect(current.resourceIdentity).toBe(f.environment.resourceIdentity);
    expect((current.observation as any).resourceIdentity).not.toBe(current.resourceIdentity);
    expect(await reclaimStoppedCompute(f.context, f.read)).toEqual({ released: true });
  }
});
test.each(["running", "unknown", "claimed", "busy", "pending", "unmatched-start"])("%s retains capacity", async kind => {
  const f = await fixture();
  if (kind === "claimed") await f.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { state: "claimed" } });
  if (kind === "busy") f.context.runtime.observeSessionActivity = () => ({ state: "executing" } as never);
  if (kind === "pending") await f.prisma.runtimeInstruction.update({ where: { id: "delivered" }, data: { state: "unknown" } });
  if (kind === "unmatched-start") await f.prisma.runtimeLifecycleEvent.create({ data: { id: "start", runtimeSessionId: f.session.id, requestId: "start", phase: "started", occurredAt: new Date() } });
  const read: typeof f.read = async (...args) => ({ ...await f.read(...args) as object, ...(["running", "unknown"].includes(kind) ? { state: kind } : {}) });
  expect(await reclaimStoppedCompute(f.context, read)).toEqual({ released: false });
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
});
test.each(["task", "resource", "slot", "resume", "pending", "stale", "foreign"])("late %s refuses reclamation without freeing an allocation", async kind => {
  const f = await fixture();
  const read: typeof f.read = async (...args) => {
    const result = await f.read(...args) as any;
    if (kind === "task") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "1".repeat(40) } });
    if (kind === "resource") await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { externalId: "/changed" } });
    if (kind === "slot") await f.prisma.computeSlot.update({ where: { id: "host:0" }, data: { allocationId: null } });
    if (kind === "resume") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    if (kind === "pending") await f.prisma.runtimeInstruction.update({ where: { id: "delivered" }, data: { state: "unknown" } });
    if (kind === "stale") result.observedAt -= 60_000;
    if (kind === "foreign") result.resourceIdentity = "1".repeat(64);
    return result;
  };
  await expect(reclaimStoppedCompute(f.context, read)).rejects.toThrow();
  expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: f.offer.id } })).state).toBe("running");
});
test("closed original source relation may be ended, but replacement ownership cannot substitute", async () => {
  const f = await fixture(true);
  const link = await f.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: f.session.id, provider: "linear", connectionId: "connection", resourceType: "issue-identifier", externalId: "TASK-1", relationship: "handles", endedAt: new Date() } });
  const task = await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { connectionId: "connection", issueIdentifier: "TASK-1" } });
  await f.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { taskIdentity: computeTaskIdentity(task, f.session.id, "host", link.id) } });
  expect(await reclaimStoppedCompute(f.context, f.read)).toEqual({ released: true });
  await f.prisma.runtimeSessionResourceLink.delete({ where: { id: link.id } });
  await expect(reclaimStoppedCompute(f.context, f.read)).rejects.toThrow("historical ownership");
});
test.each(["active", "pending", "cycle", "late-child"])("moved historical descendant %s prevents capacity reclamation", async kind => {
  const f = await fixture();
  const add = async () => {
    await f.prisma.runtimeSession.create({ data: { id: "child", scopeKey: "child", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "delegate", cwd: "/moved/child", status: "idle" } });
    await f.prisma.runtimeSession.create({ data: { id: "grandchild", scopeKey: "grandchild", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "delegate", cwd: "/moved/grandchild", status: kind === "active" ? "active" : "idle" } });
    for (const [sourceSessionId, targetSessionId] of [["child", f.session.id], ["grandchild", "child"], ...(kind === "cycle" ? [[f.session.id, "grandchild"]] : [])]) {
      await f.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: sourceSessionId!, targetSessionId: targetSessionId!, relationship: "spawned-by", endedAt: new Date() } });
    }
    if (kind === "pending" || kind === "late-child") await f.prisma.runtimeInstruction.create({ data: { id: "child-work", sessionId: "grandchild", text: "unsettled", state: "unknown" } });
  };
  if (kind !== "late-child") await add();
  const read: typeof f.read = async (...args) => { if (kind === "late-child") await add(); return f.read(...args); };
  if (["cycle", "late-child"].includes(kind)) await expect(reclaimStoppedCompute(f.context, read)).rejects.toThrow();
  else expect(await reclaimStoppedCompute(f.context, read)).toEqual({ released: false });
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
});
test("a closed task reads only an existing clean configured adapter, never installs or recreates source", async () => {
  const f = await fixture(true), root = await realpath(await mkdtemp(path.join(tmpdir(), "compute-reclaim-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const staging = path.join(root, "source"); await mkdir(staging);
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", "-C", staging, ...args]); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  git("init", "-q");
  await writeFile(path.join(staging, "observer.ts"), 'const input=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({input,mode:process.argv.at(-1)}));\n');
  await writeFile(path.join(staging, ".remote-agent-capabilities.json"), JSON.stringify({ capabilities: { runtime: { adapter: "observer.ts", observationContracts: ["compute-traffic/v1"] } } }));
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"); const revision = git("rev-parse", "HEAD");
  const checkout = path.join(root, "tooling", "repo", revision); await mkdir(path.dirname(checkout), { recursive: true }); await rename(staging, checkout);
  const config = { ...f.config, installRoot: root, repositories: { repo: { ...f.config.repository, id: "repo", tooling: { repository: "https://example.invalid/tooling.git", revision } } } } as unknown as typeof f.config;
  expect(await readInstalledComputeReclamation({ config }, f.task, { exact: "input" })).toEqual({ input: { exact: "input" }, mode: "reclaim-observe" });
  expect(await f.prisma.runtimeMetadataEvent.count()).toBe(0);
  const file = path.join(checkout, "observer.ts"), bytes = await readFile(file); await writeFile(file, "throw new Error('dirty')");
  await expect(readInstalledComputeReclamation({ config }, f.task, {})).rejects.toThrow("checkout changed"); await writeFile(file, bytes);
  await rm(checkout, { recursive: true });
  await expect(readInstalledComputeReclamation({ config }, f.task, {})).rejects.toThrow();
  expect(await Bun.file(path.join(checkout, "observer.ts")).exists()).toBeFalse();
});

test.each([false, true])("paused/closed=%s reclamation preserves never-dispatched queued history", async closed => {
  const f = await fixture(closed);
  f.context.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  const queued = await f.prisma.runtimeInstruction.create({ data: { id: "preserved", sessionId: f.session.id, text: "Keep history", state: "queued" } });
  const task = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  expect(await reclaimStoppedCompute(f.context, f.read)).toEqual({ released: true });
  expect(await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: queued.id } })).toEqual(queued);
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBeNull();
});

test.each(["unknown", "dispatching", "preparing", "previous-attempt", "missing-runtime", "active", "runtime-queued", "generation-change", "resume"])("queued reclamation with %s keeps the allocation", async kind => {
  const f = await fixture();
  f.context.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await f.prisma.runtimeInstruction.create({ data: { id: "preserved", sessionId: f.session.id, text: "Keep history", state: ["unknown", "dispatching", "preparing"].includes(kind) ? kind : "queued", executionRequestId: kind === "previous-attempt" ? "attempt" : null } });
  if (kind === "missing-runtime") f.context.runtime.observeSessionActivity = undefined;
  if (kind === "active" || kind === "runtime-queued") f.context.runtime.observeSessionActivity = () => ({ state: kind === "active" ? "executing" : "queued", observedAt: Date.now() });
  let reads = 0;
  const run = reclaimStoppedCompute(f.context, async (...args) => {
    reads++; const result = await f.read(...args);
    if (kind === "resume") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
    if (kind === "generation-change") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { updatedAt: new Date(f.task.updatedAt.getTime() + 1) } });
    return result;
  });
  if (["generation-change", "resume"].includes(kind)) await expect(run).rejects.toThrow("changed during observation");
  else { expect(await run).toEqual({ released: false }); expect(reads).toBe(0); }
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe(f.offer.id);
  expect((await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "preserved" } })).state).toBe(["unknown", "dispatching", "preparing"].includes(kind) ? kind : "queued");
});
