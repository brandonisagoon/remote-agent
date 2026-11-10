import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { createApp } from "../../app.ts";
import { prepareToolingRelease } from "./tooling.ts";
import { accountingObserverDependencies, adoptComputeAccountingObserver, inspectComputeAccountingObserver } from "./compute-accounting-observer.ts";
import { refreshComputeBaselines } from "./compute-baseline.ts";
import { computeAdmissionCapacity, computeTaskIdentity, offerNextCompute, requestCompute } from "./compute-admission.ts";
import { reclaimStoppedCompute } from "./compute-reclamation.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Real immutable installed Git checkout, child CLI and SQLite ownership and
// admission paths. The child is a synthetic physical provider in these tests.
async function fixture(kind: "baseline" | "environment" = "baseline", compatible = true) {
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "accounting-adoption-"))); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); await mkdir(source);
  git(source, "init", "-q", "-b", "main"); git(source, "config", "user.email", "fixture@example.com"); git(source, "config", "user.name", "Fixture");
  const files = {
    ".gitignore": "node_modules\nphysical.json\n", "bun.lock": "{\"lockfileVersion\":1}\n", "package.json": "{\"name\":\"fixture\"}\n",
    ".remote-agent.config.json": "{}\n", "runtime.md": "Read-only accounting fixture\n",
    ".remote-agent-capabilities.json": JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "cli.ts",
      observationContracts: ["compute-traffic/v1", "compute-baseline/v1", "compute-reclamation/v1", ...(compatible ? ["compute-historical-accounting/v1"] : [])] } } }),
    ".remote-agent-release.json": JSON.stringify({ contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 3 }, stateFormats: { "drafted.runtime": { read: [1], write: 1, preservesUnknown: false } } }),
    "cli.ts": `import path from "node:path";
const request = JSON.parse(await Bun.stdin.text());
const state = await Bun.file(path.join(import.meta.dir, "physical.json")).json().catch(() => "absent");
if (state === "failed") throw new Error("synthetic provider unavailable");
const base = { version: 1, taskId: request.task.id, primarySessionId: request.task.primarySessionId, observedAt: Date.now() };
const result = request.kind === "compute-baseline" ? { ...base, kind: "compute-baseline", machineId: request.machineId,
purpose: request.purpose, resourceSetDigest: request.resourceSetDigest,
resources: request.resources.map(resource => ({ resourceId: resource.id, resourceIdentity: resource.identityDigest, state, proofDigest: "f".repeat(64) })) }
: { ...base, kind: "compute-reclamation", environmentId: request.environment.id, resourceId: request.resource.id,
resourceIdentity: request.resource.identityDigest, allocationResourceIdentity: request.allocationResourceIdentity,
configurationDigest: request.configurationDigest, state, proofDigest: "f".repeat(64) };
process.stdout.write(JSON.stringify(result));\n`,
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(source, name), bytes);
  git(source, "add", "."); git(source, "commit", "-qm", "compatible read-only observer");
  const revision = git(source, "rev-parse", "HEAD");
  const prepared = await prepareToolingRelease({ repositoryId: "repo", toolingRoot: source, installRoot: root, revision }, async checkout => {
    await mkdir(path.join(checkout, "node_modules", "fixture"), { recursive: true });
    await writeFile(path.join(checkout, "node_modules", "fixture", "package.json"), '{"name":"fixture","version":"1.0.0"}');
  });
  const release = await db.prisma.toolingRelease.create({ data: { id: "read-only-release", ...prepared, manifest: JSON.parse(JSON.stringify(prepared.manifest)) } });
  const base = testConfig(), repository = { ...base.repository, id: "repo", root: "/original/repository", tooling: { root: source, revision: "0".repeat(40) } };
  const config = testConfig({ machine: "host", installRoot: root, repository, repositories: { repo: repository }, compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
  const runtime = createFakeAgentRuntime(); runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  const session = await db.prisma.runtimeSession.create({ data: { id: "old-primary", scopeKey: "old", agentCommand: "codex", role: "primary", repositoryId: "repo", machineId: "host", cwd: "/original/worktree", status: "closed", closedAt: new Date() } });
  const task = await db.prisma.remoteTask.create({ data: { id: "old-task", requestKey: "old", primarySessionId: session.id, repositoryId: "repo", machineId: "host", branchName: "old", worktreePath: session.cwd, toolingRoot: "/missing/old/tooling", toolingRevision: "a".repeat(40), ownerPaused: true, phase: "closed" } });
  const configuration = { configurationFile: "/private/retained-compute.json", configurationSha256: "b".repeat(64) };
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "app", kind: kind === "baseline" ? "docker-container" : "task-runtime", purpose: "development", externalId: kind === "baseline" ? "c".repeat(64) : "/private/retained-runtime.json", state: "ready", metadata: { containerId: "c".repeat(64), compute: configuration } } });
  const environment = kind === "environment" ? await db.prisma.computeEnvironment.create({ data: { id: crypto.randomUUID(), taskId: task.id, primarySessionId: session.id, machineId: "host",
    taskIdentity: computeTaskIdentity(task, session.id, "host", null), key: resource.key, purpose: "development", revision: "d".repeat(40), recipeDigest: "e".repeat(64), configuration,
    resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest, state: "unknown" } }) : null;
  if (environment) {
    await db.prisma.computeOffer.create({ data: { id: "original-offer", environmentId: environment.id, machineId: "host", instructionId: "original-start", state: "unknown", dispatchDeadline: new Date(), claimedAt: new Date() } });
    await db.prisma.computeSlot.create({ data: { id: "host:0", machineId: "host", ordinal: 0, allocationId: "original-offer" } });
  } else await refreshComputeBaselines({ prisma: db.prisma, config, runtime });
  const target = environment ? { kind: "environment" as const, environmentId: environment.id } : { kind: "baseline" as const, purpose: "development" as const };
  const context = { prisma: db.prisma, config, runtime, taskId: task.id };
  const inspection = await inspectComputeAccountingObserver({ ...context, target });
  const request = { target, requestKey: "owner-adopts-reader", expectedBindingDigest: inspection.bindingDigest, expectedRevision: inspection.revision, releaseId: release.id };
  const rows = () => Promise.all([db.prisma.remoteTask.findMany(), db.prisma.runtimeSession.findMany(), db.prisma.remoteTaskResource.findMany(), db.prisma.computeEnvironment.findMany(), db.prisma.computeOffer.findMany(), db.prisma.computeSlot.findMany(), db.prisma.toolingLegacyConsumer.findMany(), db.prisma.toolingSelection.findMany()]);
  const physical = (state: string) => writeFile(path.join(prepared.checkout, "physical.json"), JSON.stringify(state));
  return { ...context, context, task, resource, environment, target, release, prepared, inspection, request, rows, physical };
}

for (const kind of ["baseline", "environment"] as const) test(`owner adopts a missing ${kind} reader; only normal collection frees capacity`, async () => {
  const f = await fixture(kind), before = await f.rows();
  expect(f.inspection.originalAvailable).toBe(false);
  if (kind === "baseline") expect((await computeAdmissionCapacity(f.prisma, { prisma: f.prisma, machineId: "host", policy: f.config.compute!, runtime: f.runtime })).blockers.unaccounted[0]?.baseline?.refresh?.code).toBe("ACCOUNTING_OBSERVER_REQUIRED");
  const adopted = await adoptComputeAccountingObserver({ ...f.context, request: f.request });
  expect(await adoptComputeAccountingObserver({ ...f.context, request: f.request })).toEqual(adopted);
  expect(await f.rows()).toEqual(before);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-accounting-observer-adopted" } })).toBe(1);
  if (f.environment) expect(await reclaimStoppedCompute({ ...f.context, environmentId: f.environment.id })).toEqual({ released: true });
  else expect(await refreshComputeBaselines(f.context)).toEqual({ observed: 1, unavailable: 0 });
  const admission = { prisma: f.prisma, machineId: "host", policy: f.config.compute!, runtime: f.runtime };
  expect(await computeAdmissionCapacity(f.prisma, admission)).toMatchObject({ unaccounted: 0, occupied: 0, usable: 1 });
  await f.prisma.runtimeSession.create({ data: { id: "waiting", scopeKey: "waiting", agentCommand: "codex", role: "primary", repositoryId: "repo", machineId: "host", cwd: "/waiting", status: "idle" } });
  await f.prisma.remoteTask.create({ data: { id: "waiting", requestKey: "waiting", primarySessionId: "waiting", repositoryId: "repo", machineId: "host", branchName: "waiting", worktreePath: "/waiting", toolingRoot: "/tooling", toolingRevision: "a".repeat(40), phase: "working" } });
  await requestCompute({ ...admission, taskId: "waiting", request: { key: "new", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  expect(await offerNextCompute(admission)).not.toBeNull();
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(f.task);
  expect(await f.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
});

test("an available original executable is preferred and cannot be replaced by adoption", async () => {
  const f = await fixture(); f.config.repositories.repo!.tooling!.revision = f.release.revision;
  expect((await inspectComputeAccountingObserver({ ...f.context, target: f.target })).originalAvailable).toBe(true);
  await expect(adoptComputeAccountingObserver({ ...f.context, request: f.request })).rejects.toThrow("Original accounting observer is available");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-accounting-observer-adopted" } })).toBe(0);
});

for (const state of ["running", "unknown", "failed"]) test(`${state} physical inventory refuses historical observer adoption`, async () => {
  const f = await fixture(), before = await f.rows(); await f.physical(state);
  await expect(adoptComputeAccountingObserver({ ...f.context, request: f.request })).rejects.toThrow();
  expect(await f.rows()).toEqual(before);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-accounting-observer-adopted" } })).toBe(0);
});

test("incompatible reader, changed retained inputs and active writers refuse adoption", async () => {
  const f = await fixture("baseline", false);
  await expect(adoptComputeAccountingObserver({ ...f.context, request: f.request })).rejects.toThrow("compatibility");
  await f.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { changed: "input" } } });
  await expect(adoptComputeAccountingObserver({ ...f.context, request: f.request })).rejects.toThrow("unchanged");
  await f.prisma.runtimeSession.update({ where: { id: f.task.primarySessionId! }, data: { status: "active", closedAt: null } });
  const inspection = await inspectComputeAccountingObserver({ ...f.context, target: f.target });
  await expect(adoptComputeAccountingObserver({ ...f.context, request: { ...f.request, expectedBindingDigest: inspection.bindingDigest } })).rejects.toThrow("settled");
});

test("a new physical member during observation prevents adopting a partial inventory", async () => {
  const f = await fixture();
  await expect(adoptComputeAccountingObserver({ ...f.context, request: f.request }, { ...accountingObserverDependencies,
    observe: async (...args) => {
      const proof = await accountingObserverDependencies.observe(...args);
      await f.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "new-member", kind: "docker-container", purpose: "development", externalId: "9".repeat(64), state: "ready" } });
      return proof;
    } })).rejects.toThrow("changed during registration");
});

test("explicit adoption handles ambiguous original provenance without modifying it", async () => {
  const f = await fixture(), before = await f.rows();
  const dependencies = { ...accountingObserverDependencies, original: async () => { throw new Error("Four candidate original executables; producer unknown"); } };
  expect((await inspectComputeAccountingObserver({ ...f.context, target: f.target }, dependencies)).originalAvailable).toBe(false);
  await adoptComputeAccountingObserver({ ...f.context, request: f.request }, dependencies);
  expect(await f.rows()).toEqual(before);
  expect(await refreshComputeBaselines(f.context)).toEqual({ observed: 1, unavailable: 0 });
});

test("shared original resources, foreign releases and stale adoption generations refuse", async () => {
  const f = await fixture();
  await expect(adoptComputeAccountingObserver({ ...f.context, request: { ...f.request, expectedRevision: 999 } })).rejects.toThrow("generation");
  await f.prisma.toolingRelease.update({ where: { id: f.release.id }, data: { repositoryId: "foreign" } });
  await expect(adoptComputeAccountingObserver({ ...f.context, request: f.request })).rejects.toThrow("another repository");
  await f.prisma.remoteTask.create({ data: { id: "foreign", requestKey: "foreign", repositoryId: "repo", machineId: "host", branchName: "foreign", worktreePath: "/foreign", toolingRoot: "/tooling", toolingRevision: "a".repeat(40) } });
  await f.prisma.remoteTaskResource.create({ data: { taskId: "foreign", key: "shared", kind: f.resource.kind, purpose: "development", externalId: f.resource.externalId, state: "ready" } });
  await expect(inspectComputeAccountingObserver({ ...f.context, target: f.target })).rejects.toThrow("another task");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-accounting-observer-adopted" } })).toBe(0);
});

test("adopted reader refuses changed code and later running state without freeing capacity", async () => {
  const f = await fixture(); await adoptComputeAccountingObserver({ ...f.context, request: f.request });
  await f.physical("running");
  expect(await refreshComputeBaselines(f.context)).toEqual({ observed: 0, unavailable: 1 });
  expect(await computeAdmissionCapacity(f.prisma, { prisma: f.prisma, machineId: "host", policy: f.config.compute!, runtime: f.runtime })).toMatchObject({ unaccounted: 1, usable: 0 });
  await writeFile(path.join(f.prepared.checkout, "cli.ts"), 'throw new Error("changed reader");');
  expect(await refreshComputeBaselines(f.context)).toEqual({ observed: 0, unavailable: 1 });
  expect((await computeAdmissionCapacity(f.prisma, { prisma: f.prisma, machineId: "host", policy: f.config.compute!, runtime: f.runtime })).blockers.unaccounted[0]?.baseline?.refresh?.code).toBe("ACCOUNTING_OBSERVER_CHANGED");
});

test("owner routes require bearer on the trusted local socket and reject operation headers", async () => {
  const f = await fixture(), app = createApp({ ...f.context, agentRuntime: f.runtime, trustLocal: true });
  const call = (suffix: string, body: unknown, headers: Record<string, string>) => app.request(`/api/tasks/${f.task.id}/compute-accounting-observer${suffix}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  for (const [suffix, body] of [["/inspect", f.target], ["", f.request]] as const) {
    expect((await call(suffix, body, {})).status).toBe(401);
    expect((await call(suffix, body, { authorization: `Bearer ${f.config.apiKey}`, "x-remote-agent-operation": "foreign" })).status).toBe(400);
  }
  expect((await call("/inspect", f.target, { authorization: `Bearer ${f.config.apiKey}` })).status).toBe(200);
  expect((await call("", f.request, { authorization: `Bearer ${f.config.apiKey}` })).status).toBe(200);
});
