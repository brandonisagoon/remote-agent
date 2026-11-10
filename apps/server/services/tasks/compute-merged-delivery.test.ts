import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { applyTraffic, beginTraffic, type TrafficEnvelope } from "../../../../lib/compute-telemetry.ts";
import { assertCompletionAllowed, CompletionContractInput, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { requestCompute } from "./compute-admission.ts";
import { recordComputeObservation, type ComputeObservation } from "./compute-observation.ts";
import { considerIdleComputeSuspension } from "./compute-suspension.ts";
import { completeDevelopmentIntent, developmentProjection, renewDevelopmentAuthority } from "./development-intent.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { tickCompute } from "./compute-worker.ts";
import { workMapIdentity } from "./work-map-state.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function fixture(phase = "working") {
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "merged-app-stop-"))); cleanups.push(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "codex/task"); git(root, "config", "user.email", "fixture@example.com"); git(root, "config", "user.name", "Fixture");
  await writeFile(path.join(root, "README.md"), "original reviewed implementation\n"); git(root, "add", "."); git(root, "commit", "-qm", "reviewed implementation");
  const original = git(root, "rev-parse", "HEAD");
  const base = testConfig(), repository = { ...base.repository, id: "repo", root };
  const config = testConfig({ machine: "host", repository, repositories: { repo: repository }, compute: ComputePolicy.parse({ enabled: true, slots: 1, quietPeriodSeconds: 30 }) });
  const prisma = db.prisma, runtime = createFakeAgentRuntime(); runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", role: "primary", repositoryId: "repo", machineId: "host", cwd: root, status: "idle" } });
  const task = await prisma.remoteTask.create({ data: { id: "task", requestKey: "task", primarySessionId: "primary", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: root, toolingRoot: "/original/tooling", toolingRevision: "a".repeat(40), phase: "working" } });
  const context = { prisma, config, runtime, taskId: task.id }, admission = { prisma, machineId: "host", policy: config.compute! };
  const resource = await prisma.remoteTaskResource.create({ data: { id: "app", taskId: task.id, key: "app", kind: "task-runtime", purpose: "development", externalId: "/private/original-runtime.json", state: "ready", metadata: { container: "original-app", recipe: "saved" } } });
  await prisma.remoteTaskResource.create({ data: { id: "data", taskId: task.id, key: "data", kind: "neon-branch", purpose: "development", externalId: "retained-test-data", state: "ready" } });
  const requested = await requestCompute({ ...admission, taskId: task.id, request: { key: "app", purpose: "development", revision: original, recipeDigest: "b".repeat(64) } });
  const environment = await prisma.computeEnvironment.update({ where: { id: requested.id }, data: { state: "running", resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest } });
  await prisma.computeWait.deleteMany({ where: { environmentId: environment.id } });
  await prisma.computeOffer.create({ data: { id: "original-allocation", environmentId: environment.id, machineId: "host", instructionId: "original-start", state: "running", dispatchDeadline: new Date(), claimedAt: new Date() } });
  await prisma.computeSlot.create({ data: { id: "host:0", machineId: "host", ordinal: 0, allocationId: "original-allocation" } });
  await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner-merge", expectedRevision: 0, boundary: "merge", basis: "Owner requested Merge", repository: "owner/product", pullRequest: 42, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "reviewed", passed: true, evidence: ["original source checks"] } });
  await writeFile(path.join(root, "README.md"), "implementation reconciled with staging\n"); git(root, "add", "."); git(root, "commit", "-qm", "reconcile staging");
  const head = git(root, "rev-parse", "HEAD");
  const observer = { ...completionObservation, remote: async () => ({ remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: {
    url: "https://github.com/owner/product/pull/42", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) },
  } }) };
  await expect(assertCompletionAllowed({ ...context, sessionId: "primary" }, observer)).rejects.toThrow("verification is missing, failed or stale");
  await prisma.remoteTask.update({ where: { id: task.id }, data: { phase } });
  const route = { id: "api", taskId: task.id, primarySessionId: "primary", environmentId: environment.id, resourceId: resource.id, resourceIdentity: environment.resourceIdentity!, purpose: "development" as const,
    service: "api", revision: original, proxyId: "proxy", configurationDigest: "e".repeat(64) };
  let traffic = beginTraffic(route, "merged-app-epoch", Date.now(), true);
  const observation: ComputeObservation = { version: 1, environmentId: environment.id, taskId: task.id, primarySessionId: "primary", purpose: "development", revision: original, sourceRevision: head,
    recipeDigest: environment.recipeDigest, resourceId: resource.id, resourceIdentity: environment.resourceIdentity!, observedAt: Date.now(), state: "running", coverage: "complete",
    configurationDigest: route.configurationDigest, routes: [route], operations: { coverage: "complete", active: 0, generation: "f".repeat(64) } };
  const input = { ...context, environmentId: environment.id, requestKey: "merged-stop" };
  const event = async (value: TrafficEnvelope["event"]) => {
    traffic = applyTraffic(traffic, { version: 1, routeId: route.id, epoch: traffic.epoch, sequence: traffic.sequence + 1, observedAt: Date.now(), event: value }, Date.now());
    await prisma.computeTraffic.upsert({ where: { routeId: route.id }, create: { routeId: route.id, environmentId: environment.id, taskId: task.id, epoch: traffic.epoch, sequence: traffic.sequence, state: traffic }, update: { epoch: traffic.epoch, sequence: traffic.sequence, state: traffic } });
  };
  const refresh = async () => {
    observation.observedAt = Date.now(); await event({ kind: "heartbeat" });
    return recordComputeObservation({ ...input, observation });
  };
  await refresh();
  const classify = async (): Promise<never> => { throw new Error("Merged delivery must not call the idle classifier"); };
  return { ...context, context: { ...context, refreshCompute: refresh }, input, root, task, resource, environment, observation, observer, refresh, event, classify };
}

for (const phase of ["working", "complete"]) test(`merged app stops and frees its slot while final verification stays stale (${phase})`, async () => {
  const f = await fixture(phase), original = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  const resources = await f.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
  const contract = await f.prisma.runtimeMetadataEvent.findMany({ where: { source: `owner:${f.task.id}` }, orderBy: { sequence: "asc" } });
  await f.prisma.runtimeSession.create({ data: { id: "next", scopeKey: "next", agentCommand: "codex", role: "primary", repositoryId: "repo", machineId: "host", cwd: "/next", status: "idle" } });
  await f.prisma.remoteTask.create({ data: { id: "next", requestKey: "next", primarySessionId: "next", repositoryId: "repo", machineId: "host", branchName: "next", worktreePath: "/next", toolingRoot: "/tooling", toolingRevision: "a".repeat(40), phase: "working" } });
  await requestCompute({ prisma: f.prisma, machineId: "host", policy: f.config.compute!, taskId: "next", request: { key: "next", purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64) } });
  let stops = 0, continuations = 0;
  const dependencies = { refresh: f.refresh, consider: (input: Parameters<typeof considerIdleComputeSuspension>[0]) => considerIdleComputeSuspension(input, { refresh: f.refresh, classify: f.classify }),
    continue: async (input: { intentRevision: number; intentDigest: string }) => {
      continuations++;
      const reference = { intentRevision: input.intentRevision, intentDigest: input.intentDigest };
      await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
      if (f.observation.state === "running") { stops++; f.observation.state = "stopped"; await f.refresh(); }
      if (continuations === 1) throw new Error("lost stop acknowledgment");
      const scope = await renewDevelopmentAuthority({ ...f.context, ...reference, resourceKeys: [f.resource.key] });
      await completeDevelopmentIntent({ ...f.context, ...reference, resourcesEpoch: scope.resourcesEpoch, resources: scope.resources });
    } };
  expect(await tickCompute(f.context, dependencies)).toMatchObject({ unavailable: 1 });
  expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: "original-allocation" } })).state).toBe("running");
  expect(await tickCompute(f.context, dependencies)).toMatchObject({ unavailable: 0 });
  expect(stops).toBe(1); expect(continuations).toBe(2);
  expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: "original-allocation" } })).state).toBe("stopped");
  const next = await f.prisma.computeOffer.findFirstOrThrow({ where: { state: "queued" } });
  expect(await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: next.environmentId } })).toMatchObject({ taskId: "next" });
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(original);
  expect(await f.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } })).toEqual(resources);
  expect(await f.prisma.runtimeMetadataEvent.findMany({ where: { source: `owner:${f.task.id}` }, orderBy: { sequence: "asc" } })).toEqual(contract);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-decision" } })).toBe(0);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-merged-delivery-stop" } })).toBe(1);
  await expect(assertCompletionAllowed({ ...f.context, sessionId: "primary" }, f.observer)).rejects.toThrow("verification is missing, failed or stale");
  expect((await developmentProjection(f.context)).developmentIntent?.state).toBe("complete");
});

for (const fault of ["browser", "consumer", "active-descendant", "queued-work", "operations", "incomplete-operations", "incomplete-coverage", "unknown", "dirty", "revoked", "review", "paused", "changed-contract", "request"] as const) test(`pending completion app is retained for ${fault}`, async () => {
  const f = await fixture("complete");
  if (fault === "browser") await f.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "browser", kind: "browser", purpose: "browser", externalId: "actual-consumer", state: "ready" } });
  if (fault === "consumer") await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: `work-map:${f.task.id}`, action: "task-work-map", key: "remaining", value: JSON.stringify({ identity: workMapIdentity(f.task), sourceIssueId: "task", input: { version: 1, requestKey: "remaining", expectedRevision: 0,
    units: [{ issueId: "task", kind: "work-item", acceptance: "Verify with the app", deliveryIds: [] }], deliveries: [], remainingConsumers: [{ issueId: "task", reason: "Browser verification still needs this app" }] } }) } });
  if (fault === "active-descendant") {
    await f.prisma.runtimeSession.create({ data: { id: "moved", scopeKey: "moved", agentCommand: "codex", role: "delegate", repositoryId: "repo", machineId: "host", cwd: "/different/working/directory", status: "active" } });
    await f.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "moved", targetSessionId: "primary", relationship: "spawned-by" } });
  }
  if (fault === "queued-work") await f.prisma.runtimeInstruction.create({ data: { id: "pending-verification", sessionId: "primary", text: "Verify the app", state: "queued" } });
  if (fault === "operations") f.observation.operations.active = 1;
  if (fault === "incomplete-operations") f.observation.operations.coverage = "incomplete";
  if (fault === "incomplete-coverage") f.observation.coverage = "incomplete";
  if (fault === "review") await f.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "review", kind: "task-runtime", purpose: "review", externalId: "retained-preview", state: "ready" } });
  if (fault === "paused") await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  if (fault === "changed-contract") {
    const original = await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "completion-contract" } });
    await setCompletionContract({ ...f.context, contract: CompletionContractInput.parse({ requestKey: "new-scope", expectedRevision: original.sequence, boundary: "merge", basis: "Owner revised scope", repository: "owner/product", pullRequest: 43, baseBranch: "main" }) });
  }
  if (fault === "request") await f.event({ kind: "start", requestId: "browser-request", classification: "meaningful" });
  if (fault === "unknown") f.observation.state = "unknown";
  if (fault === "dirty") await writeFile(path.join(f.root, "README.md"), "new unverified source\n");
  if (fault === "revoked") await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: `owner:${f.task.id}`, action: "completion-retirement-authority", key: "revoked", value: JSON.stringify({ version: 1, action: "revoke" }) } });
  if (fault !== "paused") await f.refresh();
  const run = considerIdleComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  if (fault === "dirty") await expect(run).rejects.toThrow("source changed");
  else if (fault === "paused") await expect(run).rejects.toThrow("original eligible task primary");
  else await run;
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-merged-delivery-stop" } })).toBe(0);
  expect((await f.prisma.computeSlot.findUniqueOrThrow({ where: { id: "host:0" } })).allocationId).toBe("original-allocation");
});

test("a dirty worktree after stop intent prevents renewed effect authority", async () => {
  const f = await fixture(), stop = await considerIdleComputeSuspension(f.input, { refresh: f.refresh, classify: f.classify });
  expect(stop?.intent).toBeDefined();
  await writeFile(path.join(f.root, "new.txt"), "new source work\n");
  await expect(renewDevelopmentAuthority({ ...f.context, ...stop!.intent!, resourceKeys: [f.resource.key] })).rejects.toThrow("source changed");
});
