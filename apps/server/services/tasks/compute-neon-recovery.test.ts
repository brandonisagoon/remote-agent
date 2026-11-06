import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { bindComputeResource, requestCompute } from "./compute-admission.ts";
import { configureCompute } from "./compute-configuration.ts";
import { canonicalSha256, ComputeNeonRecoveryProof, ReviewedLegacyNeonSources, neonRecoveryInputDigest, readNeonRecovery, readRecoverySource, readReleaseBlobs, recoverComputeNeon, verifyBoundObserver, type BoundToolingOperation } from "./compute-neon-recovery.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";

let db: TestDatabase;
const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
// The environment keeps its original provisioning revision; the task worktree
// has since advanced by normal product commits (as DRA-16/18 have).
const currentHead = "22406a5eddb33f983a669f8f686b9a416beac113";
const revision = "a".repeat(40), pin = "d".repeat(40), oldHash = "b".repeat(64), nextHash = "c".repeat(64);
// DRA-16's actual task resource name (taskResourceName at the pinned source).
const planetscale = { provider: "planetscale" as const, id: "fjoeit1mmtrd", name: "drafted-d-8f9be1ae3e70da71c349dcb3" };
const childName = "drafted-d-8f9be1ae3e70da71c349dcb3";
const release = { id: "tr_release_b", repositoryId: "repo", revision: "9".repeat(40), tree: "6".repeat(40), checkout: "/install/tooling/repo/release-b" };
const observer = { operationId: "op-recovery", releaseId: release.id, revision: release.revision, tree: release.tree, adapterSha256: "8".repeat(64) };
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

type Ids = { task: string; primary: string; name: string; planetscaleId: string; slot: string; environmentId?: string; offerId?: string; operationId?: string; resourceId?: string };
const defaultIds: Ids = { task: "task", primary: "primary", name: childName, planetscaleId: planetscale.id, slot: "host:0" };
async function fixture(options: { allocation?: "unknown" | "claimed" | "stopped"; outcome?: "absent" | "owned"; ids?: Ids } = {}) {
  const outcome = options.outcome ?? "absent", ids = options.ids ?? defaultIds, worktree = `/fixture/${ids.task}`;
  const saved = { provider: "planetscale" as const, id: ids.planetscaleId, name: ids.name };
  await db.prisma.runtimeSession.create({ data: { id: ids.primary, scopeKey: ids.task, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: worktree, status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: ids.task, requestKey: ids.task, repositoryId: "repo", machineId: "host", branchName: `codex/${ids.task}`, worktreePath: worktree, toolingRoot: "/fixture/tooling", toolingRevision: pin, primarySessionId: ids.primary, phase: "working" } });
  const context = { prisma: db.prisma, config, machineId: "host", policy: config.compute! };
  const requested = await requestCompute({ ...context, taskId: ids.task, request: { key: "runtime-development", purpose: "development", revision, recipeDigest: oldHash } });
  await db.prisma.computeWait.deleteMany({ where: { environmentId: requested.id } });
  const environment = ids.environmentId ? await db.prisma.computeEnvironment.update({ where: { id: requested.id }, data: { id: ids.environmentId } }) : requested;
  const resource = await db.prisma.remoteTaskResource.create({ data: { ...(ids.resourceId ? { id: ids.resourceId } : {}), taskId: ids.task, key: environment.key, kind: "task-runtime", purpose: "development", externalId: "/private/runtime/runtime.json", state: "failed",
    metadata: { recipeHash: oldHash, revision, providers: [saved], observed: "failed", progress: { step: "neon", detail: "Creating a task-owned neon dependency", state: "running", updatedAt: "2026-11-04T10:01:00.000Z" } } } });
  const stopped = options.allocation === "stopped";
  const offer = await db.prisma.computeOffer.create({ data: { id: ids.offerId ?? crypto.randomUUID(), environmentId: environment.id, machineId: "host", instructionId: `historical-offer:${ids.task}`, dispatchDeadline: new Date(),
    state: options.allocation ?? "unknown", claimedAt: new Date(Date.now() - 3_600_000), ...(stopped ? { completedAt: new Date() } : {}) } });
  if (!stopped) await db.prisma.computeSlot.create({ data: { id: ids.slot, ordinal: Number(ids.slot.split(":")[1]), machineId: "host", allocationId: offer.id } });
  // A real claim (or terminal stop) leaves no waiting entry.
  await db.prisma.computeWait.deleteMany({ where: { environmentId: environment.id } });
  await db.prisma.computeEnvironment.update({ where: { id: environment.id }, data: { state: stopped ? "suspended" : "unknown", resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest } });
  const operationId = ids.operationId ?? crypto.randomUUID();
  const request = { offerId: offer.id, operationId, resourceKey: environment.key, previousRecipeHash: oldHash, recipeHash: nextHash, baselineFile: "/private/runtime/neon-recovery-baseline.json", lockPid: 4242, outcome, sourceRevision: currentHead };
  const operation: BoundToolingOperation = { contract: "remote-agent.tooling-operation/v1", operationId: "op-recovery", requestKey: "dra16-neon-recovery", inputDigest: neonRecoveryInputDigest(request),
    repositoryId: "repo", taskId: ids.task, sessionId: ids.primary, kind: "compute-neon-recovery", existingOperationId: offer.id, resourceKey: environment.key, generation: 5, release: { ...release } };
  const attempt = { version: 1 as const, name: childName, projectId: "spatial-project", templateBranchId: "br-template", parentLsn: "0/1A2B3C4", requestedAt: "2026-11-04T10:01:00.000Z", expiresAt: "2026-11-11T10:01:00.000Z" };
  const rejected = { ...attempt, rejection: { status: 422, code: "BRANCHES_LIMIT_EXCEEDED", observedAt: "2026-11-04T10:01:01.000Z" } };
  const child = { provider: "neon" as const, id: "br-child", name: childName, parentId: "br-template", parentLsn: "0/1A2B3C4", templateBranchId: "br-template" };
  const proof: ComputeNeonRecoveryProof = { version: 1, contract: "runtime-neon-recovery/v1", transition: "neon-template-child", taskId: ids.task, primarySessionId: ids.primary, toolingRevision: pin,
    environmentId: environment.id, resourceId: resource.id, resourceKey: environment.key, offerId: offer.id, operationId, revision, sourceRevision: currentHead,
    previousRecipeHash: oldHash, recipeHash: nextHash, receiptSha256: "1".repeat(64), baselineSha256: "2".repeat(64), lockSha256: "3".repeat(64), lockPid: 4242,
    stage: { phase: "failed", pending: outcome === "owned" ? "create-neon" : null, setupComplete: false, schemaApplied: false, fixturesComplete: false, spatialSchema: false, container: false, containerOperation: false, configuration: false, coverage: false, startBundle: false },
    baselineProviders: [saved], providers: outcome === "owned" ? [saved, child] : [saved],
    reconciliation: outcome === "owned" ? { operation: "create-neon", outcome, name: childName, projectId: "spatial-project", observedAt: "2026-11-05T09:00:00.000Z", branchId: "br-child", attempt }
      : { operation: "create-neon", outcome, name: childName, projectId: "spatial-project", observedAt: "2026-11-05T09:00:00.000Z", attempt: rejected, absence: { basis: "provider-rejection" } },
    baselineNeonCreateSha256: canonicalSha256(outcome === "owned" ? attempt : rejected),
    operation: { operationId: "op-recovery", releaseId: release.id, revision: release.revision, tree: release.tree } };
  const input = { prisma: db.prisma, config, taskId: ids.task, request, operation };
  return { context, input, proof, environment, resource, offer, read: async () => ({ proof: structuredClone(proof), observer: { ...observer } }), head: async () => currentHead };
}
const rows = async () => ({ offers: await db.prisma.computeOffer.findMany({ orderBy: { id: "asc" } }), slots: await db.prisma.computeSlot.findMany({ orderBy: { id: "asc" } }),
  waits: await db.prisma.computeWait.findMany(), traffic: await db.prisma.computeTraffic.findMany(), task: await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } }),
  instructions: await db.prisma.runtimeInstruction.findMany(), sessions: await db.prisma.runtimeSession.findMany() });
const events = () => db.prisma.runtimeMetadataEvent.count({ where: { action: "compute-neon-recovery" } });

test.each(["unknown", "claimed"] as const)("absent outcome advances only the recipe projection and preserves the retained %s claim", async state => {
  const f = await fixture({ allocation: state }), before = await rows();
  const environmentBefore = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  const result = await recoverComputeNeon(f.input, f.read, f.head);
  expect(result).toMatchObject({ environmentId: f.environment.id, resourceId: f.resource.id, offerId: f.offer.id, recipeHash: nextHash, outcome: "absent", allocation: "retained-existing-claim" });
  const environment = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } });
  expect(resource.metadata).toEqual({ ...(f.resource.metadata as object), recipeHash: nextHash });
  expect(resource.state).toBe("failed"); expect(resource.externalId).toBe(f.resource.externalId);
  const { recipeDigest, resourceIdentity, updatedAt: _u, ...rest } = environment, { recipeDigest: _d, resourceIdentity: _i, updatedAt: _v, ...restBefore } = environmentBefore;
  expect(rest).toEqual(restBefore);
  expect(recipeDigest).toBe(nextHash); expect(resourceIdentity).toBe(finalizationResourceIdentity(resource).identityDigest);
  expect(await rows()).toEqual(before);
  expect(await events()).toBe(1);
  // Lost acknowledgment: re-observes, reproduces the original result, writes nothing.
  expect(await recoverComputeNeon(f.input, f.read, f.head)).toEqual(result);
  expect(await events()).toBe(1); expect(await rows()).toEqual(before);
  // The ordinary bind now accepts the retained claim under the child recipe.
  await bindComputeResource({ ...f.context, taskId: "task", offerId: f.offer.id, resourceKey: f.resource.key });
});

test("terminal allocation stays history; recovery grants nothing and normal admission queues afresh", async () => {
  const f = await fixture({ allocation: "stopped" }), before = await rows();
  const result = await recoverComputeNeon(f.input, f.read, f.head);
  expect(result.allocation).toBe("previously-stopped-await-normal-admission");
  expect(await rows()).toEqual(before);
  expect(before.waits).toHaveLength(0); expect(before.slots).toHaveLength(0);
  await requestCompute({ ...f.context, taskId: "task", request: { key: f.resource.key, purpose: "development", revision, recipeDigest: nextHash } });
  expect(await db.prisma.computeWait.count()).toBe(1);
  expect(await db.prisma.computeOffer.findMany({ orderBy: { id: "asc" } })).toEqual(before.offers);
  // The old digest is no longer an admissible identity for this environment.
  await expect(requestCompute({ ...f.context, taskId: "task", request: { key: f.resource.key, purpose: "development", revision, recipeDigest: oldHash } })).rejects.toThrow();
});

test("exact owned outcome is accepted without publishing the receipt on the owner's behalf", async () => {
  const f = await fixture({ outcome: "owned" });
  const result = await recoverComputeNeon(f.input, f.read, f.head);
  expect(result.outcome).toBe("owned");
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).metadata).toEqual({ ...(f.resource.metadata as object), recipeHash: nextHash });
});

test.each(["pause", "pin", "primary", "source", "slot", "offer", "wait", "intent", "resource", "digest", "head", "evidence", "complete"])("refuses %s drift during observation without any write", async fault => {
  const f = await fixture(); let calls = 0;
  const environmentBefore = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  if (fault === "source") {
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { issueIdentifier: "DRA-16", connectionId: "conn" } });
    await db.prisma.runtimeSessionResourceLink.create({ data: { id: "link", runtimeSessionId: "primary", provider: "linear", connectionId: "conn", resourceType: "issue-identifier", externalId: "DRA-16", relationship: "handles" } });
  }
  const read = async () => {
    calls++;
    if (calls === 1) {
      if (fault === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
      if (fault === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
      if (fault === "primary") await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { role: "delegate" } });
      if (fault === "source") await db.prisma.runtimeSessionResourceLink.update({ where: { id: "link" }, data: { endedAt: new Date() } });
      if (fault === "slot") await db.prisma.computeSlot.update({ where: { id: "host:0" }, data: { allocationId: null } });
      if (fault === "offer") await db.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { state: "stopped", completedAt: new Date() } });
      if (fault === "wait") await db.prisma.computeWait.create({ data: { environmentId: f.environment.id, machineId: "host" } });
      if (fault === "intent") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: "stop", value: JSON.stringify({ version: 1, action: "stop" }) } });
      if (fault === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { externalId: "/changed/runtime.json" } });
      if (fault === "digest") await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { recipeDigest: "f".repeat(64) } });
      if (fault === "complete") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "complete" } });
    }
    return { proof: { ...f.proof, ...(fault === "evidence" && calls === 2 ? { baselineSha256: "f".repeat(64) } : {}) }, observer };
  };
  let heads = 0;
  // A fault in the source link is installed before the first snapshot, so
  // the source link is part of the original identity being protected.
  if (fault === "source") {
    const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
    const { computeTaskIdentity } = await import("./compute-admission.ts");
    await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { taskIdentity: computeTaskIdentity(task, "primary", "host", "link") } });
  }
  const head = async () => fault === "head" && ++heads === 2 ? "e".repeat(40) : currentHead;
  await expect(recoverComputeNeon(f.input, read, head)).rejects.toThrow();
  // The original snapshot was valid: each fault was observed only after it.
  expect(calls).toBeGreaterThan(0);
  const environment = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  expect(environment.recipeDigest).not.toBe(nextHash);
  if (fault !== "digest" && fault !== "source") expect(environment.resourceIdentity).toBe(environmentBefore.resourceIdentity);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).metadata).toMatchObject({ recipeHash: oldHash });
  expect(await events()).toBe(0);
});

const proofFaults: Record<string, (proof: ComputeNeonRecoveryProof) => void> = {
  outcome: proof => { proof.reconciliation.outcome = "owned"; },
  "absent-with-neon": proof => { proof.providers.push({ provider: "neon", id: "br-x", name: childName }); },
  "absent-still-pending": proof => { proof.stage.pending = "create-neon"; },
  "planetscale-changed": proof => { proof.providers = [{ ...planetscale, id: "other" }]; proof.baselineProviders = [{ ...planetscale, id: "other" }]; },
  "baseline-has-neon": proof => { proof.baselineProviders.push({ provider: "neon", id: "br-x", name: childName }); proof.providers.push({ provider: "neon", id: "br-x", name: childName }); },
  "released-provider": proof => { proof.providers = [{ ...planetscale, released: true }]; proof.baselineProviders = [{ ...planetscale, released: true }]; },
  "source-revision": proof => { proof.sourceRevision = "e".repeat(40); },
  "tooling-pin": proof => { proof.toolingRevision = "e".repeat(40); },
  lock: proof => { proof.lockPid = 1; },
  operation: proof => { proof.operationId = crypto.randomUUID(); },
  environment: proof => { proof.environmentId = crypto.randomUUID(); },
  container: proof => { (proof.stage as any).container = true; },
  setup: proof => { (proof.stage as any).setupComplete = true; },
  "schema-applied": proof => { (proof.stage as any).schemaApplied = true; },
  "spatial-schema-evidence": proof => { (proof.stage as any).spatialSchema = true; },
  "spatial-schema-omitted": proof => { delete (proof.stage as any).spatialSchema; },
  contract: proof => { (proof as any).contract = "runtime-configuration/v1"; },
};
test.each(Object.keys(proofFaults))("refuses inconsistent proof: %s", async fault => {
  const f = await fixture();
  const read = async () => { const proof = structuredClone(f.proof); proofFaults[fault]!(proof); return { proof, observer }; };
  await expect(recoverComputeNeon(f.input, read, f.head)).rejects.toThrow();
  expect(await events()).toBe(0);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
});

const ownedFaults: Record<string, (proof: ComputeNeonRecoveryProof) => void> = {
  "no-attempt": proof => { delete (proof.reconciliation as any).attempt; },
  rejected: proof => { proof.reconciliation.attempt!.rejection = { status: 422, observedAt: "2026-11-04T10:01:01.000Z" }; },
  "other-parent": proof => { proof.providers[1]!.parentId = "br-other"; },
  "other-branch": proof => { proof.reconciliation.branchId = "br-other"; },
  "two-children": proof => { proof.providers.push({ ...proof.providers[1]!, id: "br-other" }); },
  "not-pending": proof => { proof.stage.pending = null; },
  "with-absence-basis": proof => { proof.reconciliation.absence = { basis: "provider-rejection" }; },
  "observed-before-request": proof => { proof.reconciliation.observedAt = "2026-11-04T09:00:00.000Z"; },
};
test.each(Object.keys(ownedFaults))("refuses inexact owned outcome: %s", async fault => {
  const f = await fixture({ outcome: "owned" });
  const read = async () => { const proof = structuredClone(f.proof); ownedFaults[fault]!(proof); return { proof, observer }; };
  await expect(recoverComputeNeon(f.input, read, f.head)).rejects.toThrow();
  expect(await events()).toBe(0);
});

test.each(["container", "coverage", "configuration", "traffic", "metadata-ahead", "identity", "saved-provider-released", "foreign-offer", "older-claim", "disabled"])("refuses unsupported prior state: %s", async fault => {
  const f = await fixture();
  const meta = f.resource.metadata as Record<string, unknown>;
  if (fault === "container") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...meta, containerId: "c".repeat(64) } } });
  if (fault === "coverage") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...meta, compute: { configurationFile: "/private/c.json", configurationSha256: "e".repeat(64) } } } });
  if (fault === "saved-provider-released") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...meta, providers: [{ ...planetscale, released: true }] } } });
  if (fault === "metadata-ahead") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...meta, recipeHash: nextHash } } });
  if (["container", "coverage", "saved-provider-released", "metadata-ahead"].includes(fault)) {
    const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } });
    await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { resourceIdentity: finalizationResourceIdentity(resource).identityDigest } });
  }
  if (fault === "identity") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...meta, progress: { step: "neon", detail: "later", state: "failed", updatedAt: "2026-11-05T00:00:00.000Z" } } } });
  if (fault === "configuration") await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { configuration: { configurationFile: "/private/c.json", configurationSha256: "e".repeat(64) } } });
  if (fault === "traffic") await db.prisma.computeTraffic.create({ data: { routeId: "route", taskId: "task", environmentId: f.environment.id, epoch: "e", state: {} } });
  if (fault === "foreign-offer") await db.prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: f.environment.id, machineId: "host", instructionId: "other", dispatchDeadline: new Date(), state: "offered" } });
  if (fault === "older-claim") {
    await db.prisma.computeOffer.create({ data: { id: crypto.randomUUID(), environmentId: f.environment.id, machineId: "host", instructionId: "newer", dispatchDeadline: new Date(), state: "stopped", claimedAt: new Date(), completedAt: new Date() } });
  }
  const input = fault === "disabled" ? { ...f.input, config: testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: false, slots: 1 }) }) } : f.input;
  let reads = 0;
  await expect(recoverComputeNeon(input, async () => { reads++; return { proof: f.proof, observer }; }, f.head)).rejects.toThrow();
  expect(reads).toBe(0);
  expect(await events()).toBe(0);
});

test("request validation refuses an unchanged digest and unknown fields", async () => {
  const f = await fixture();
  await expect(recoverComputeNeon({ ...f.input, request: { ...f.input.request, recipeHash: oldHash } }, f.read, f.head)).rejects.toThrow();
  await expect(recoverComputeNeon({ ...f.input, request: { ...f.input.request, recipe: {} } as any }, f.read, f.head)).rejects.toThrow();
  await expect(recoverComputeNeon({ ...f.input, request: { ...f.input.request, baselineFile: "relative.json" } }, f.read, f.head)).rejects.toThrow();
});

test("a matching new digest without the durable journal cannot authorize a retry", async () => {
  const f = await fixture();
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { recipeDigest: nextHash } });
  await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), recipeHash: nextHash } } });
  await expect(recoverComputeNeon(f.input, f.read, f.head)).rejects.toThrow();
});

test.each(["baseline", "reconciliation", "outcome-request", "baseline-file", "observer", "adapter"])("lost acknowledgment refuses changed %s evidence without writing", async changed => {
  const f = await fixture({ outcome: changed === "outcome-request" ? "owned" : "absent" });
  await recoverComputeNeon(f.input, f.read, f.head);
  const after = { environment: await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }), resource: await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } }) };
  const read = async () => {
    const proof = structuredClone(f.proof);
    if (changed === "baseline") proof.baselineSha256 = "9".repeat(64);
    if (changed === "reconciliation") proof.reconciliation.observedAt = "2026-11-05T10:00:00.000Z";
    if (changed === "outcome-request") { proof.reconciliation = { operation: "create-neon", outcome: "absent", name: childName, projectId: "spatial-project", observedAt: proof.reconciliation.observedAt,
      attempt: { ...proof.reconciliation.attempt!, rejection: { status: 422, observedAt: "2026-11-04T10:01:01.000Z" } }, absence: { basis: "provider-rejection" } }; proof.stage.pending = null; proof.providers = [planetscale]; }
    if (changed === "outcome-request") proof.baselineNeonCreateSha256 = canonicalSha256(proof.reconciliation.attempt);
    if (changed === "observer") proof.operation.operationId = "op-other";
    return { proof, observer: changed === "observer" ? { ...observer, operationId: "op-other" } : changed === "adapter" ? { ...observer, adapterSha256: "7".repeat(64) } : observer };
  };
  const request = changed === "outcome-request" ? { ...f.input.request, outcome: "absent" as const } : changed === "baseline-file" ? { ...f.input.request, baselineFile: "/private/runtime/other.json" }
    : f.input.request;
  // A retry must reuse its durable operation; a second binding of the same input cannot replay.
  const operation = changed === "observer" ? { ...f.input.operation, operationId: "op-other" } : { ...f.input.operation, inputDigest: neonRecoveryInputDigest(request) };
  await expect(recoverComputeNeon({ ...f.input, request, operation }, read, f.head)).rejects.toThrow();
  expect(await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).toEqual(after.environment);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(after.resource);
  expect(await events()).toBe(1);
});

test.each(["progress", "owned-providers", "container", "pause"])("replay after later registry publication: %s", async changed => {
  const f = await fixture({ outcome: changed === "owned-providers" ? "owned" : "absent" });
  const result = await recoverComputeNeon(f.input, f.read, f.head);
  const saved = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } });
  const meta = saved.metadata as Record<string, unknown>;
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  else await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...meta,
    ...(changed === "progress" ? { progress: { step: "recovery", detail: "Reconciled", state: "running", updatedAt: "2026-11-05T09:30:00.000Z" } }
      : changed === "owned-providers" ? { providers: f.proof.providers } : { containerId: "c".repeat(64) }) } } });
  const environment = await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
  if (changed === "progress" || changed === "owned-providers") {
    expect(await recoverComputeNeon(f.input, f.read, f.head)).toEqual(result);
    expect(await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).toEqual(environment);
  } else await expect(recoverComputeNeon(f.input, f.read, f.head)).rejects.toThrow();
  expect(await events()).toBe(1);
});

test("the existing configuration protocol is not broadened to a container-less pending runtime", async () => {
  const f = await fixture();
  const compute = { configurationFile: "/private/runtime/next.json", configurationSha256: "f".repeat(64) };
  await expect(configureCompute({ ...f.input, request: { offerId: f.offer.id, resourceKey: f.resource.key, previousRecipeHash: oldHash, recipeHash: nextHash, baselineFile: f.input.request.baselineFile, lockPid: 4242,
    coverage: { previousFile: "/private/runtime/before.json", next: compute } } }, async () => { throw new Error("configuration observer must not be reached for this unsupported state"); }, f.head)).rejects.toThrow();
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
});

async function releaseCheckout(contracts: string[]) {
  const checkout = await realpath(await mkdtemp(path.join(tmpdir(), "neon-recovery-release-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
  git("init", "-q");
  await mkdir(path.join(checkout, "src"));
  await writeFile(path.join(checkout, "src", "cli.ts"), "console.log('observer');\n", { mode: 0o644 });
  await writeFile(path.join(checkout, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "src/cli.ts", observationContracts: contracts } } }));
  git("add", "-A"); git("commit", "-q", "-m", "release");
  return { checkout, git, release: { id: "tr_test", repositoryId: "repo", revision: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), checkout } };
}

// Real git, but not the process-group supervisor (its /bin/ps probe is
// unavailable in sandboxed test hosts); the logic under test is the checkout check.
const plainExecute = (async (argv: string[], options: { cwd: string }) => execFileSync(argv[0]!, argv.slice(1), { cwd: options.cwd, encoding: "utf8" })) as any;
test("bound observer runs only from the exact prepared release checkout, never the active selection or pin", async () => {
  const fixtureRelease = await releaseCheckout(["compute-traffic/v1", "runtime-neon-recovery/v1"]);
  try {
    const verified = await verifyBoundObserver(fixtureRelease.release, plainExecute);
    expect(verified.adapterPath).toBe(path.join(fixtureRelease.checkout, "src", "cli.ts"));
    expect(verified.adapterSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyBoundObserver({ ...fixtureRelease.release, tree: "0".repeat(40) }, plainExecute)).rejects.toThrow("bound release");
    await expect(verifyBoundObserver({ ...fixtureRelease.release, revision: "0".repeat(40) }, plainExecute)).rejects.toThrow();
    await writeFile(path.join(fixtureRelease.checkout, "src", "cli.ts"), "console.log('changed');\n");
    await expect(verified.check()).rejects.toThrow();
    fixtureRelease.git("checkout", "--", "src/cli.ts");
    expect(await verified.check()).toBe(verified.adapterSha256);
    await writeFile(path.join(fixtureRelease.checkout, "untracked.txt"), "x");
    await expect(verified.check()).rejects.toThrow("bound release");
  } finally { await rm(fixtureRelease.checkout, { recursive: true, force: true }); }
  const legacy = await releaseCheckout(["compute-traffic/v1", "runtime-configuration/v1"]);
  try { await expect(verifyBoundObserver(legacy.release, plainExecute)).rejects.toThrow("cannot verify Neon recovery"); }
  finally { await rm(legacy.checkout, { recursive: true, force: true }); }
});

test("production reader sends the declared operation envelope to the bound release's adapter", async () => {
  const f = await fixture(), calls: { argv: string[]; options: any }[] = [];
  let hash = "8".repeat(64);
  const verify = async (bound: any) => { expect(bound).toEqual(f.input.operation.release); return { adapterPath: path.join(release.checkout, "src", "cli.ts"), adapterSha256: "8".repeat(64), check: async () => hash }; };
  const execute = async (argv: string[], options: any) => { calls.push({ argv, options }); return JSON.stringify(f.proof); };
  const before = { owner: { session: { id: "primary" }, task: { worktreePath: "/fixture/task", toolingRevision: pin } }, environment: f.environment, resource: f.resource, offer: f.offer, stopped: false } as any;
  expect(await readNeonRecovery(f.input, before, { verify: verify as any, execute: execute as any })).toEqual({ proof: f.proof, observer });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv).toEqual([process.execPath, "--no-env-file", path.join(release.checkout, "src", "cli.ts"), "compute", "neon-recovery-observe"]);
  expect(calls[0]!.options.cwd).toBe(release.checkout);
  expect(calls[0]!.options.env.REMOTE_AGENT_TOOLING_OPERATION).toBe("op-recovery");
  expect(Object.keys(calls[0]!.options.env).every(key => ["PATH", "HOME", "USER", "TMPDIR", "REMOTE_AGENT_TOOLING_OPERATION", "REMOTE_AGENT_SOCKET", "REMOTE_AGENT_TASK_ID", "REMOTE_AGENT_SESSION_ID"].includes(key))).toBe(true);
  // DRA-29 toolingProcessContext: the observer guard reads its binding back over this socket.
  expect(calls[0]!.options.env).toMatchObject({ REMOTE_AGENT_SOCKET: config.controlIpcPath, REMOTE_AGENT_TASK_ID: "task", REMOTE_AGENT_SESSION_ID: "primary" });
  const payload = JSON.parse(calls[0]!.options.input);
  expect(payload).toMatchObject({ version: 1, contract: "runtime-neon-recovery/v1", request: f.input.request,
    operation: { operationId: "op-recovery", kind: "compute-neon-recovery", generation: 5, inputDigest: f.input.operation.inputDigest, release: { id: release.id, revision: release.revision, tree: release.tree } },
    task: { id: "task", primarySessionId: "primary", toolingRevision: pin }, allocation: { offerId: f.offer.id, mode: "retained-existing-claim" } });
  expect(JSON.stringify(payload)).not.toContain(release.checkout);
  hash = "7".repeat(64);
  await expect(readNeonRecovery(f.input, before, { verify: verify as any, execute: execute as any })).rejects.toThrow("observer changed");
});

const bindingFaults: Record<string, (operation: BoundToolingOperation) => void> = {
  kind: operation => { operation.kind = "compute-configure"; },
  task: operation => { operation.taskId = "other"; },
  session: operation => { operation.sessionId = "delegate"; },
  repository: operation => { operation.release.repositoryId = "other-repo"; },
  "existing-offer": operation => { operation.existingOperationId = crypto.randomUUID(); },
  resource: operation => { operation.resourceKey = "runtime-review"; },
  input: operation => { operation.inputDigest = "0".repeat(64); },
  contract: operation => { (operation as any).contract = "remote-agent.tooling-operation/v0"; },
};
test.each(Object.keys(bindingFaults))("refuses a mismatched operation binding before observing: %s", async fault => {
  const f = await fixture(); const operation = structuredClone(f.input.operation); bindingFaults[fault]!(operation);
  let reads = 0;
  await expect(recoverComputeNeon({ ...f.input, operation }, async () => { reads++; return { proof: f.proof, observer }; }, f.head)).rejects.toThrow("bound tooling operation");
  expect(reads).toBe(0); expect(await events()).toBe(0);
});

test.each(["operation", "release", "revision", "tree"])("refuses a proof from another release or operation: %s", async fault => {
  const f = await fixture();
  const read = async () => { const proof = structuredClone(f.proof);
    if (fault === "operation") proof.operation.operationId = "op-other";
    if (fault === "release") proof.operation.releaseId = "tr_other";
    if (fault === "revision") proof.operation.revision = "7".repeat(40);
    if (fault === "tree") proof.operation.tree = "7".repeat(40);
    return { proof, observer }; };
  await expect(recoverComputeNeon(f.input, read, f.head)).rejects.toThrow("bound operation's release");
  expect(await events()).toBe(0);
});

test("operation input digest is canonical, excludes only the volatile lock and matches the generic algorithm", async () => {
  const request = { offerId: crypto.randomUUID(), operationId: crypto.randomUUID(), resourceKey: "runtime-development", previousRecipeHash: oldHash, recipeHash: nextHash,
    baselineFile: "/private/runtime/b.json", lockPid: 1, outcome: "absent" as const, sourceRevision: currentHead };
  const reordered = Object.fromEntries(Object.entries({ ...request, lockPid: 999 }).reverse()) as typeof request;
  expect(neonRecoveryInputDigest(reordered)).toBe(neonRecoveryInputDigest(request));
  const { lockPid: _lock, ...stable } = request;
  const sorted = Object.fromEntries(Object.keys(stable).sort().map(key => [key, (stable as Record<string, unknown>)[key]]));
  expect(neonRecoveryInputDigest(request)).toBe(createHash("sha256").update(JSON.stringify(sorted)).digest("hex"));
  expect(neonRecoveryInputDigest({ ...request, outcome: "owned" })).not.toBe(neonRecoveryInputDigest(request));
});

// FOUNDATION PORT (DRA-24): the service is unreachable. No route, operation
// kind or admission hook is wired yet; the admission hook stays null until the
// reader handoff and lost-acknowledgment contract are closed. The reviewed
// isolated candidate's route expectations, for the later integration: an
// authenticated POST answers 400 for an unknown field or an unchanged recipe
// digest, 409 `operation-required` without an admitted binding (nothing
// written, no private path in the body), and 401 without a bearer.
test("route is not exposed in this foundation port: the exact request reaches no handler and writes nothing", async () => {
  const f = await fixture();
  const app = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() });
  const response = await app.request("/api/tasks/task/compute-neon-recovery", { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(f.input.request) });
  expect(response.status).toBe(404);
  expect(await events()).toBe(0);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
  const unauthenticated = await app.request("/api/tasks/task/compute-neon-recovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.input.request) });
  expect(unauthenticated.status).toBe(401);
});

test("lost acknowledgment from a new lock holder reproduces the original result", async () => {
  const f = await fixture();
  const result = await recoverComputeNeon(f.input, f.read, f.head);
  const read = async () => ({ proof: { ...structuredClone(f.proof), lockPid: 5151, lockSha256: "4".repeat(64), receiptSha256: "5".repeat(64) }, observer });
  expect(await recoverComputeNeon({ ...f.input, request: { ...f.input.request, lockPid: 5151 } }, read, f.head)).toEqual(result);
  expect(result).toMatchObject({ basis: "provider-rejection", observer });
  expect(await events()).toBe(1);
});

test.each(["revision", "between-reads"])("refuses an observer that is not the bound operation's release: %s", async fault => {
  const f = await fixture(); let calls = 0;
  const read = async () => ({ proof: structuredClone(f.proof), observer: fault === "revision" || ++calls === 2 ? { ...observer, ...(fault === "revision" ? { revision: "7".repeat(40) } : { adapterSha256: "7".repeat(64) }) } : observer });
  await expect(recoverComputeNeon(f.input, read, f.head)).rejects.toThrow(fault === "revision" ? "bound operation's release" : "changed during observation");
  expect(await events()).toBe(0);
});

const template = { id: "br-template", name: "spatial-template", createdAt: "2026-10-01T00:00:00.000Z" };
const inventory = (branches: { id: string; name: string; parentId?: string; createdAt: string }[], listedAt = "2026-11-05T08:59:00.000Z", projectId = "spatial-project") =>
  ({ basis: "complete-inventory" as const, complete: true as const, projectId, listedAt, pages: 1, branches: [template, ...branches] });
const absenceCases: Record<string, { ok: boolean; edit: (proof: ComputeNeonRecoveryProof) => void }> = {
  // DRA-16 shape: legacy POST, no pre-request journal, response body discarded.
  "legacy-no-journal": { ok: false, edit: proof => { delete (proof.reconciliation as any).attempt; delete proof.reconciliation.absence; } },
  "legacy-no-journal-with-inventory": { ok: false, edit: proof => { delete (proof.reconciliation as any).attempt; proof.reconciliation.absence = inventory([]); } },
  // A bare absent claim from a name search carries no basis.
  "name-search-only": { ok: false, edit: proof => { delete proof.reconciliation.absence; } },
  "rejection-without-response": { ok: false, edit: proof => { delete proof.reconciliation.attempt!.rejection; } },
  "rejection-before-request": { ok: false, edit: proof => { proof.reconciliation.attempt!.rejection!.observedAt = "2026-11-04T10:00:00.000Z"; } },
  "rejection-after-lifetime": { ok: false, edit: proof => { proof.reconciliation.attempt!.rejection!.observedAt = "2026-11-04T10:30:00.000Z"; } },
  "attempt-other-task": { ok: false, edit: proof => { proof.reconciliation.attempt!.name = "drafted-d-other"; } },
  "inventory-complete": { ok: true, edit: proof => { delete proof.reconciliation.attempt!.rejection; proof.baselineNeonCreateSha256 = canonicalSha256(proof.reconciliation.attempt); proof.reconciliation.absence = inventory([
    { id: "br-sibling", name: "drafted-d-sibling", parentId: "br-template", createdAt: "2026-11-03T00:00:00.000Z" }]); } },
  "inventory-without-template": { ok: false, edit: proof => { proof.reconciliation.absence = { ...inventory([]), branches: [{ id: "br-other", name: "other", createdAt: "2026-10-01T00:00:00.000Z" }] }; } },
  "inventory-other-project": { ok: false, edit: proof => { proof.reconciliation.absence = inventory([], undefined, "other-project"); } },
  "rejection-conflict-409": { ok: false, edit: proof => { proof.reconciliation.attempt!.rejection!.status = 409; proof.baselineNeonCreateSha256 = canonicalSha256(proof.reconciliation.attempt); } },
  "rejection-timeout-408": { ok: false, edit: proof => { proof.reconciliation.attempt!.rejection!.status = 408; proof.baselineNeonCreateSha256 = canonicalSha256(proof.reconciliation.attempt); } },
  "rejection-not-baseline-journal": { ok: false, edit: proof => { proof.baselineNeonCreateSha256 = "0".repeat(64); } },
  "rejection-400-no-code": { ok: true, edit: proof => { proof.reconciliation.attempt!.rejection = { status: 400, observedAt: "2026-11-04T10:01:02.000Z" }; proof.baselineNeonCreateSha256 = canonicalSha256(proof.reconciliation.attempt); } },
  "inventory-too-early": { ok: false, edit: proof => { proof.reconciliation.absence = inventory([], "2026-11-04T10:05:00.000Z"); } },
  "inventory-same-name": { ok: false, edit: proof => { proof.reconciliation.absence = inventory([{ id: "br-x", name: childName, createdAt: "2026-10-01T00:00:00.000Z" }]); } },
  "inventory-renamed-child": { ok: false, edit: proof => { proof.reconciliation.absence = inventory([{ id: "br-x", name: "renamed", parentId: "br-template", createdAt: "2026-11-04T10:01:30.000Z" }]); } },
  "inventory-duplicate-ids": { ok: false, edit: proof => { proof.reconciliation.absence = inventory([{ id: "br-template", name: "dup", createdAt: "2026-10-01T00:00:00.000Z" }]); } },
  "inventory-incomplete": { ok: false, edit: proof => { proof.reconciliation.absence = { ...inventory([]), complete: false } as any; } },
  "observed-before-listing": { ok: false, edit: proof => { proof.reconciliation.absence = inventory([], "2026-11-05T09:30:00.000Z"); } },
};
test.each(Object.keys(absenceCases))("absence evidence basis: %s", async name => {
  const f = await fixture(), entry = absenceCases[name]!;
  const read = async () => { const proof = structuredClone(f.proof); entry.edit(proof); return { proof, observer }; };
  // A timer plus a listing is not provider settlement evidence: every
  // complete-inventory absence is refused and the create stays pending.
  if (entry.ok && !name.startsWith("inventory")) expect((await recoverComputeNeon(f.input, read, f.head)).basis).toBe("provider-rejection");
  else if (entry.ok) { await expect(recoverComputeNeon(f.input, read, f.head)).rejects.toThrow("pending create is preserved"); expect(await events()).toBe(0); }
  else {
    await expect(recoverComputeNeon(f.input, read, f.head)).rejects.toThrow();
    expect(await events()).toBe(0);
    expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
  }
});

// DRA-16 regression: the retained original log (runtime-up-3.err, 1210 bytes,
// sha256 94f266ae…235c), the pinned f4f93c8 source blobs and the current
// receipt's interruption-guard progress. Only the inventory is synthetic.
const dra16Log = { file: "/state/drafted/task-private/task/development/runtime-up-3.err", bytes: 1210, sha256: "94f266aeaa2471c927cffafadbfd13d900dc196a7d2f31c1d8fbe010abe6235c",
  events: [
    { step: "recovery", detail: "Resuming the recorded planetscale dependency", state: "running", updatedAt: "2026-11-05T23:23:35.660Z" },
    { step: "identity", detail: "Checking the approved reusable synthetic login", state: "running", updatedAt: "2026-11-05T23:23:38.069Z" },
    { step: "credentials", detail: "Checking saved runtime credentials and application image", state: "running", updatedAt: "2026-11-05T23:24:05.990Z" },
    { step: "planetscale", detail: "Checking the saved planetscale dependency", state: "running", updatedAt: "2026-11-05T23:24:06.500Z" },
    { step: "neon", detail: "Creating a task-owned neon dependency", state: "running", updatedAt: "2026-11-05T23:24:08.826Z" },
    { step: "neon", detail: "Remote dependency POST failed (422)", state: "failed", updatedAt: "2026-11-05T23:24:09.915Z" },
  ].map(event => ({ event: "runtime-progress" as const, taskId: "task", ...event, state: event.state as "running" | "failed" })),
  stderr: "Remote dependency POST failed (422)\n" };
const reviewedBlobs = { ...ReviewedLegacyNeonSources[0]! };
// Fresh read-only inventory (/private/tmp/dra23-neon-recovery-inventory-20261106.json,
// sha256 6f044995…a877): every page, include_deleted, 15 branches / 5 roots.
// It supplies the missing inventory for both consumers; it does not itself
// prove either original rejection.
const legacyInventory = { complete: true as const, projectId: "empty-field-48456385", listedAt: "2026-11-06T02:32:57.095Z", pages: 1, branches: [{"id": "br-blue-truth-b87gxjpw", "name": "studio-spatial-baseline", "createdAt": "2026-10-09T03:12:42Z"}, {"id": "br-cold-hat-b8gljhf8", "name": "studio-staging", "createdAt": "2026-10-09T16:33:23Z"}, {"id": "br-old-band-b80lstzf", "name": "drafted-dra71-cmvsmq45w001g42xc12nhj1rx-development", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:06:49Z"}, {"id": "br-little-band-b8jn40ex", "name": "drafted-dra90-cmvsmu3po002342xci7rdhauo-development", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:07:29Z"}, {"id": "br-bold-snow-b8g1hy9o", "name": "drafted-dra36-cmvrbl16f01983cxc7ge0jqk0-development", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:07:40Z"}, {"id": "br-withered-leaf-b8h8vo59", "name": "drafted-dra68-dra68-development", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:07:50Z"}, {"id": "br-nameless-glade-b83c8h2s", "name": "drafted-dra28-cmvr1wia4010k3cxcixdo26k6-review", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:08:02Z"}, {"id": "br-bold-hall-b8nv0whc", "name": "drafted-dra14-cmvpw8v3s00hj3cxcbdtt6k4i-review", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:08:21Z"}, {"id": "br-quiet-field-b8kigchk", "name": "drafted-studiopilot-cmvii02xg00000lxcpxy0sefr-development", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:08:30Z"}, {"id": "br-quiet-pine-b8o15h1o", "name": "drafted-dra90-cmvsmu3po002342xci7rdhauo-review", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-29T00:42:18Z"}, {"id": "br-little-forest-b8vg008q", "name": "rubin-production", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-10-30T19:34:01Z"}, {"id": "br-little-feather-b81qziot", "name": "drafted-r-cc78c55567b622366161859e", "createdAt": "2026-11-02T23:00:40Z"}, {"id": "br-round-hall-b8sr8154", "name": "drafted-d-9502a991927ac6d3ce5ff858", "createdAt": "2026-11-04T02:22:42Z"}, {"id": "br-divine-shape-b8kd4oob", "name": "drafted-d-2e3169b54bbf436885538b27", "createdAt": "2026-11-05T23:01:45Z"}, {"id": "br-curly-art-b8bmspn5", "name": "drafted-d-d42b220d80f905340a207cd1", "parentId": "br-blue-truth-b87gxjpw", "createdAt": "2026-11-06T00:26:40Z"}] };
type Consumer = "dra16" | "dra18";
const consumers: Record<Consumer, { ids: Ids; claimedAt: string; turn: [string, string]; receiptProgress: { step: string; detail: string; state: "failed"; updatedAt: string }; log?: typeof dra16Log }> = {
  // Receipt progress overwritten by the guard at 00:31; the CLI log retains the failure.
  dra16: { ids: { ...defaultIds, environmentId: "a60c4fc1-c66e-4ab6-a7f2-b67573f39500", offerId: "7ebb1829-a987-422a-b8b1-117509ad8ec0", operationId: "73b4cbd2-4270-49cc-8d62-0b749c89c35c", resourceId: "cmw466c9600etzkxclbwhfi8l" }, claimedAt: "2026-11-05T23:20:00.000Z", turn: ["2026-11-05T23:21:00.000Z", "2026-11-05T23:40:00.000Z"], log: dra16Log,
    receiptProgress: { step: "neon", detail: "Interrupted runtime operation (create-neon); preserve resources and reconcile the exact provider result before retrying", state: "failed", updatedAt: "2026-11-06T00:31:52.905Z" } },
  // No retained log; the tool-written receipt still holds its original failure.
  dra18: { ids: { task: "cmw45mrxk004lzkxcyfiaoujl", primary: "cmw45n2c8004mzkxc487qh6te", name: "drafted-d-1cb4a488ebdafc8c37f0345c", planetscaleId: "hf48h5o4belw", slot: "host:1",
      environmentId: "c7804078-f94c-4e05-bf1c-f2dd8ad67ede", offerId: "c962e9d0-7626-46b2-8a9a-ffe7d85899cf", operationId: "b80f4a2f-4fbc-4a21-93fa-3b5aaca3d117", resourceId: "cmw48yw4w00tyzkxca11te1sl" },
    claimedAt: "2026-11-06T00:30:00.000Z", turn: ["2026-11-06T00:31:00.000Z", "2026-11-06T00:50:00.000Z"],
    receiptProgress: { step: "neon", detail: "Remote dependency POST failed (422)", state: "failed", updatedAt: "2026-11-06T00:40:34.940Z" } },
};
async function legacyFixture(options: { allocation?: "unknown" | "stopped"; consumer?: Consumer } = {}) {
  const consumer = consumers[options.consumer ?? "dra16"], ids = consumer.ids;
  const f = await fixture({ allocation: options.allocation, ids });
  await db.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { claimedAt: new Date(consumer.claimedAt) } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: `${ids.task}:turn-started`, runtimeSessionId: ids.primary, requestId: `${ids.task}:turn-1`, phase: "started", occurredAt: new Date(consumer.turn[0]) } });
  await db.prisma.runtimeLifecycleEvent.create({ data: { id: `${ids.task}:turn-completed`, runtimeSessionId: ids.primary, requestId: `${ids.task}:turn-1`, phase: "completed", occurredAt: new Date(consumer.turn[1]) } });
  // The registry projection the pinned tool published with its last save.
  const published = await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...(f.resource.metadata as object), progress: { ...consumer.receiptProgress } } } });
  await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { resourceIdentity: finalizationResourceIdentity(published).identityDigest } });
  const proof = structuredClone(f.proof);
  proof.reconciliation = { operation: "create-neon", outcome: "absent", name: ids.name, projectId: "empty-field-48456385", observedAt: "2026-11-06T03:00:00.000Z",
    absence: { basis: "legacy-provider-rejection", requestName: ids.name, baselineBranchId: "br-blue-truth-b87gxjpw", source: { revision: pin, blobs: { ...reviewedBlobs } },
      ...(consumer.log ? { log: structuredClone(consumer.log) } : {}), receiptProgress: { ...consumer.receiptProgress }, inventory: structuredClone(legacyInventory) } };
  proof.baselineNeonCreateSha256 = null;
  const blobs = async () => ({ ...reviewedBlobs });
  // Deterministic trusted server clock: five minutes after the inventory listing.
  let now = Date.parse(legacyInventory.listedAt) + 5 * 60_000;
  const clock = Object.assign(() => now, { set: (value: number) => { now = value; } });
  return { ...f, resource: published, ids, proof, blobs, clock, read: async () => ({ proof: structuredClone(proof), observer: { ...observer } }) };
}
type Legacy = Extract<NonNullable<ComputeNeonRecoveryProof["reconciliation"]["absence"]>, { basis: "legacy-provider-rejection" }>;
const legacyOf = (proof: ComputeNeonRecoveryProof) => proof.reconciliation.absence as Legacy;

test.each(["unknown", "stopped"] as const)("DRA-16 retained 422 evidence with settled inventory supports absence (%s allocation)", async allocation => {
  const f = await legacyFixture({ allocation }), before = await rows();
  const result = await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock);
  expect(result).toMatchObject({ outcome: "absent", basis: "legacy-provider-rejection", recipeHash: nextHash });
  expect(await rows()).toEqual(before);
  const event = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-neon-recovery" } });
  expect(JSON.parse(event.value!).proof.reconciliation.absence.log.sha256).toBe(dra16Log.sha256);
  expect(await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock)).toEqual(result);
  expect(await events()).toBe(1);
});

test("legacy basis may use a server-granted runtime capability revision recorded before the request", async () => {
  const f = await legacyFixture(), executed = "f4f93c8bb2f8497c69405f548ac0efcb8dc67e8f";
  legacyOf(f.proof).source.revision = executed;
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", action: "tooling-capability", key: "grant", source: "task:task", occurredAt: new Date("2026-11-05T23:16:00.000Z"),
    value: JSON.stringify({ contract: "remote-agent.tooling-capability/v1", capability: "runtime", capabilityRevision: executed }) } });
  let asked = "";
  expect((await recoverComputeNeon(f.input, f.read, f.head, async (_release, revision) => { asked = revision; return { ...reviewedBlobs }; }, f.clock)).basis).toBe("legacy-provider-rejection");
  expect(asked).toBe(executed);
});

const legacyFaults: Record<string, (f: Awaited<ReturnType<typeof legacyFixture>>) => Promise<void> | void> = {
  "journal-present": f => { f.proof.reconciliation.attempt = { version: 1, name: childName, projectId: "empty-field-48456385", templateBranchId: "br-t", parentLsn: "0/1", requestedAt: "2026-11-05T23:24:08.900Z", expiresAt: "2026-11-12T23:24:08.900Z" }; },
  "baseline-journal-digest": f => { f.proof.baselineNeonCreateSha256 = "0".repeat(64); },
  "status-409-conflict": f => { legacyOf(f.proof).log!.events[5]!.detail = "Remote dependency POST failed (409)"; legacyOf(f.proof).log!.stderr = "Remote dependency POST failed (409)"; },
  "status-408-timeout": f => { legacyOf(f.proof).log!.events[5]!.detail = "Remote dependency POST failed (408)"; legacyOf(f.proof).log!.stderr = "Remote dependency POST failed (408)"; },
  "transport-failure": f => { legacyOf(f.proof).log!.events[5]!.detail = "Remote dependency request failed; inspect the recorded operation before retrying"; legacyOf(f.proof).log!.stderr = legacyOf(f.proof).log!.events[5]!.detail; },
  "get-not-post": f => { legacyOf(f.proof).log!.events[5]!.detail = "Remote dependency GET failed (422)"; legacyOf(f.proof).log!.stderr = "Remote dependency GET failed (422)"; },
  "stderr-differs": f => { legacyOf(f.proof).log!.stderr = "Remote Agent returned 422"; },
  "event-between": f => { legacyOf(f.proof).log!.events.splice(5, 0, { event: "runtime-progress", taskId: "task", step: "neon", detail: "Creating a task-owned neon dependency", state: "running", updatedAt: "2026-11-05T23:24:09.000Z" }); },
  "later-event": f => { legacyOf(f.proof).log!.events.push({ event: "runtime-progress", taskId: "task", step: "redis", detail: "Creating a task-owned redis dependency", state: "running", updatedAt: "2026-11-05T23:24:10.000Z" }); },
  "resumed-not-created": f => { legacyOf(f.proof).log!.events[4]!.detail = "Checking the saved neon dependency"; },
  "no-planetscale-before": f => { legacyOf(f.proof).log!.events.splice(3, 1); },
  "exceeds-request-timeout": f => { legacyOf(f.proof).log!.events[5]!.updatedAt = "2026-11-05T23:24:45.000Z"; },
  "other-task-log": f => { legacyOf(f.proof).log!.events[0]!.taskId = "other"; },
  "out-of-order": f => { legacyOf(f.proof).log!.events[2]!.updatedAt = "2026-11-05T23:30:00.000Z"; },
  "log-not-task-private": f => { legacyOf(f.proof).log!.file = "/tmp/runtime-up-3.err"; },
  "log-in-worktree": f => { legacyOf(f.proof).log!.file = "/fixture/task/task/runtime-up-3.err"; },
  "receipt-later-effect": f => { legacyOf(f.proof).receiptProgress.detail = "A remote dependency is missing or released; no shared fallback was used"; },
  "receipt-before-failure": f => { legacyOf(f.proof).receiptProgress.updatedAt = "2026-11-05T23:24:00.000Z"; },
  "request-name": f => { legacyOf(f.proof).requestName = "drafted-d-other"; },
  "no-inventory": f => { delete (legacyOf(f.proof) as any).inventory; },
  "count-only-audit": f => { legacyOf(f.proof).inventory.branches = []; },
  "inventory-without-baseline": f => { legacyOf(f.proof).inventory.branches.shift(); },
  "inventory-too-early": f => { legacyOf(f.proof).inventory.listedAt = "2026-11-05T23:30:00.000Z"; },
  "inventory-same-name": f => { legacyOf(f.proof).inventory.branches.push({ id: "br-x", name: childName, createdAt: "2026-10-01T00:00:00.000Z" }); },
  "inventory-root-in-window": f => { legacyOf(f.proof).inventory.branches.push({ id: "br-x", name: "renamed-root", createdAt: "2026-11-05T23:24:09.100Z" }); },
  "inventory-other-project": f => { legacyOf(f.proof).inventory.projectId = "other-project"; },
  "observed-before-inventory": f => { f.proof.reconciliation.observedAt = "2026-11-05T23:45:00.000Z"; },
  "unreviewed-source": async f => { f.blobs = async () => ({ ...reviewedBlobs, "src/runtime-providers.ts": "1".repeat(40) }); legacyOf(f.proof).source.blobs = await f.blobs(); },
  "claimed-source-blobs": f => { legacyOf(f.proof).source.blobs["src/runtime.ts"] = "1".repeat(40); },
  "ungranted-revision": f => { legacyOf(f.proof).source.revision = "f4f93c8bb2f8497c69405f548ac0efcb8dc67e8f"; },
  "grant-after-request": async f => { legacyOf(f.proof).source.revision = "f4f93c8bb2f8497c69405f548ac0efcb8dc67e8f";
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", action: "tooling-capability", key: "late", source: "task:task", occurredAt: new Date("2026-11-05T23:30:00.000Z"),
      value: JSON.stringify({ capability: "runtime", capabilityRevision: "f4f93c8bb2f8497c69405f548ac0efcb8dc67e8f" }) } }); },
  "no-primary-turn": async () => { await db.prisma.runtimeLifecycleEvent.deleteMany({}); },
  "turn-ended-before-failure": async () => { await db.prisma.runtimeLifecycleEvent.update({ where: { id: "task:turn-completed" }, data: { occurredAt: new Date("2026-11-05T23:24:09.000Z") } }); },
  "claimed-after-request": async f => { await db.prisma.computeOffer.update({ where: { id: f.offer.id }, data: { claimedAt: new Date("2026-11-05T23:25:00.000Z") } }); },
  "owned-outcome": f => { f.input.request.outcome = "owned"; f.input.operation.inputDigest = neonRecoveryInputDigest(f.input.request); },
};
test.each(Object.keys(legacyFaults))("legacy rejection basis refuses: %s", async fault => {
  const f = await legacyFixture();
  await legacyFaults[fault]!(f);
  const read = async () => ({ proof: structuredClone(f.proof), observer: { ...observer } });
  const error = await recoverComputeNeon(f.input, read, f.head, f.blobs, f.clock).then(() => null, (value: Error) => value);
  if (process.env.NEON_RECOVERY_REASONS) console.log(`REASON ${fault}: ${error?.message.slice(0, 140)}`);
  expect(error).toBeInstanceOf(Error);
  expect(await events()).toBe(0);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).metadata).toMatchObject({ recipeHash: oldHash });
});

test("the real release object store resolves the pinned blobs the review covered", async () => {
  const drafted = "/Users/brandon/Desktop/.worktrees/drafted-tooling/dra-23-neon-child-recovery";
  const revision = "f4f93c8bb2f8497c69405f548ac0efcb8dc67e8f";
  try { execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: drafted }); } catch { return; } // host-specific fixture
  const blobs = await readReleaseBlobs({ id: "tr", repositoryId: "repo", revision, tree: "0".repeat(40), checkout: drafted }, revision, plainExecute);
  expect(blobs).toEqual(reviewedBlobs);
});

// Historical synthetic fixture: modeled on an earlier read-only observation
// in which DRA-16 was owner-paused. (Latest live state: no longer paused, its
// offer released and its receipt holding prepared providers.) The rule stays:
// a pause present before the call stops recovery before any observer, source
// read or write, and never resumes, unpauses or queues work.
test.each(["journaled", "legacy", "legacy-replay"] as const)("owner pause refuses live recovery before observation: %s", async mode => {
  const f = mode === "journaled" ? await fixture() : await legacyFixture();
  const blobs: typeof readReleaseBlobs = "blobs" in f ? f.blobs as typeof readReleaseBlobs : async () => ({ ...reviewedBlobs });
  const clock = "clock" in f ? (f as { clock: () => number }).clock : Date.now;
  if (mode === "legacy-replay") await recoverComputeNeon(f.input, f.read, f.head, blobs, clock);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  const before = { ...await rows(), environment: await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }),
    resource: await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } }), events: await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }) };
  let reads = 0, sourceReads = 0, heads = 0;
  await expect(recoverComputeNeon(f.input, async () => { reads++; return f.read(); }, async () => { heads++; return currentHead; },
    async (...args: Parameters<typeof readReleaseBlobs>) => { sourceReads++; return blobs(...args); })).rejects.toThrow();
  expect({ reads, sourceReads, heads }).toEqual({ reads: 0, sourceReads: 0, heads: 0 });
  expect({ ...await rows(), environment: await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }),
    resource: await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } }), events: await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } }) }).toEqual(before);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).ownerPaused).toBe(true);
});

// DRA-18: same generic route and observer contract; no adapter of its own.
test.each(["unknown", "stopped"] as const)("DRA-18 receipt-retained 422 with settled inventory supports absence without a CLI log (%s)", async allocation => {
  const f = await legacyFixture({ consumer: "dra18", allocation });
  expect(legacyOf(f.proof).log).toBeUndefined();
  const result = await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock);
  expect(result).toMatchObject({ outcome: "absent", basis: "legacy-provider-rejection", environmentId: f.environment.id });
  expect(await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock)).toEqual(result);
  expect(await events()).toBe(1);
});

const dra18Events = (...steps: [string, string, "running" | "failed", string][]) => steps.map(([step, detail, state, updatedAt]) => ({ event: "runtime-progress" as const, taskId: consumers.dra18.ids.task, step, detail, state, updatedAt }));
const dra18Failure: [string, string, "failed", string] = ["neon", "Remote dependency POST failed (422)", "failed", "2026-11-06T00:40:34.940Z"];
const dra18Logs: Record<string, { ok: boolean; events: ReturnType<typeof dra18Events>; stderr?: string }> = {
  // Legitimate other flows: fresh creation (no saved PlanetScale), resumed PlanetScale, minimal tail.
  "fresh-creation-flow": { ok: true, events: dra18Events(["providers", "Checking access to the selected remote services", "running", "2026-11-06T00:39:00.000Z"],
    ["planetscale", "Creating a task-owned planetscale dependency", "running", "2026-11-06T00:39:05.000Z"], ["neon", "Creating a task-owned neon dependency", "running", "2026-11-06T00:40:33.900Z"], dra18Failure) },
  "saved-planetscale-flow": { ok: true, events: dra18Events(["planetscale", "Checking the saved planetscale dependency", "running", "2026-11-06T00:40:32.000Z"], ["neon", "Creating a task-owned neon dependency", "running", "2026-11-06T00:40:33.900Z"], dra18Failure) },
  "minimal-tail": { ok: true, events: dra18Events(["neon", "Creating a task-owned neon dependency", "running", "2026-11-06T00:40:33.900Z"], dra18Failure) },
  // Contradictions with the receipt's own retained failure.
  "log-other-status": { ok: false, stderr: "Remote dependency POST failed (400)", events: dra18Events(["neon", "Creating a task-owned neon dependency", "running", "2026-11-06T00:40:33.900Z"], ["neon", "Remote dependency POST failed (400)", "failed", "2026-11-06T00:40:34.940Z"]) },
  "log-other-time": { ok: false, events: dra18Events(["neon", "Creating a task-owned neon dependency", "running", "2026-11-06T00:40:33.900Z"], ["neon", "Remote dependency POST failed (422)", "failed", "2026-11-06T00:40:35.000Z"]) },
  "log-redis-before-neon": { ok: false, events: dra18Events(["redis", "Creating a task-owned redis dependency", "running", "2026-11-06T00:40:32.000Z"], ["neon", "Creating a task-owned neon dependency", "running", "2026-11-06T00:40:33.900Z"], dra18Failure) },
};
test.each(Object.keys(dra18Logs))("DRA-18 optional log must agree with the receipt: %s", async name => {
  const f = await legacyFixture({ consumer: "dra18" }), entry = dra18Logs[name]!;
  legacyOf(f.proof).log = { file: `/state/drafted/task-private/${consumers.dra18.ids.task}/development/runtime-up-2.err`, bytes: 900, sha256: "a".repeat(64), events: entry.events, stderr: entry.stderr ?? "Remote dependency POST failed (422)\n" };
  const run = recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock);
  if (entry.ok) expect((await run).basis).toBe("legacy-provider-rejection"); else { await expect(run).rejects.toThrow("Legacy Neon rejection"); expect(await events()).toBe(0); }
});

const receiptFaults: Record<string, (proof: ComputeNeonRecoveryProof) => void> = {
  "other-failure-no-log": proof => { legacyOf(proof).receiptProgress.detail = "A remote dependency is missing or released; no shared fallback was used"; },
  "conflict-409": proof => { legacyOf(proof).receiptProgress.detail = "Remote dependency POST failed (409)"; },
  "transport-unknown": proof => { legacyOf(proof).receiptProgress.detail = "Remote dependency request failed; inspect the recorded operation before retrying"; },
  "planetscale-step": proof => { legacyOf(proof).receiptProgress.step = "planetscale"; },
  "guard-without-log": proof => { legacyOf(proof).receiptProgress.detail = "Interrupted runtime operation (create-neon); preserve resources and reconcile the exact provider result before retrying"; },
  "branch-in-window": proof => { legacyOf(proof).inventory.branches.push({ id: "br-late", name: "unrelated", createdAt: "2026-11-06T00:40:20.000Z" }); },
};
test.each(Object.keys(receiptFaults))("DRA-18 receipt-borne evidence refuses: %s", async name => {
  const f = await legacyFixture({ consumer: "dra18" });
  receiptFaults[name]!(f.proof);
  await expect(recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock)).rejects.toThrow("Legacy Neon rejection");
  expect(await events()).toBe(0);
});

test("DRA-16 without its retained log has no record of the provider response", async () => {
  const f = await legacyFixture();
  delete legacyOf(f.proof).log;
  await expect(recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock)).rejects.toThrow("no retained record of the original provider response");
});

// Both consumers in one control plane: one shared inventory, independent
// authority, no evidence or binding crosses tasks.
async function both() {
  const dra16 = await legacyFixture({ consumer: "dra16", allocation: "stopped" });
  const dra18 = await legacyFixture({ consumer: "dra18" });
  return { dra16, dra18 };
}
const recipeOf = async (id: string) => (await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id } })).recipeDigest;
test("both consumers recover independently from the same inventory and journal only their own task", async () => {
  const { dra16, dra18 } = await both();
  await recoverComputeNeon(dra18.input, dra18.read, dra18.head, dra18.blobs, dra18.clock);
  expect(await recipeOf(dra18.environment.id)).toBe(nextHash); expect(await recipeOf(dra16.environment.id)).toBe(oldHash);
  await recoverComputeNeon(dra16.input, dra16.read, dra16.head, dra16.blobs, dra16.clock);
  expect(await recipeOf(dra16.environment.id)).toBe(nextHash);
  const journal = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "compute-neon-recovery" }, orderBy: { sequence: "asc" } });
  expect(journal.map(event => [event.runtimeSessionId, event.source])).toEqual([[dra18.ids.primary, `compute:${dra18.ids.task}`], [dra16.ids.primary, `compute:${dra16.ids.task}`]]);
});

const crossFaults: Record<string, (c: Awaited<ReturnType<typeof both>>) => Parameters<typeof recoverComputeNeon>[0] | Promise<Parameters<typeof recoverComputeNeon>[0]>> = {
  "dra16-proof-for-dra18": c => c.dra18.input,
  "dra16-binding-for-dra18": c => ({ ...c.dra18.input, operation: c.dra16.input.operation }),
  "dra16-request-for-dra18-task": c => ({ ...c.dra16.input, taskId: c.dra18.ids.task }),
  "dra16-name-in-dra18-evidence": c => { legacyOf(c.dra18.proof).requestName = c.dra16.ids.name; c.dra18.proof.reconciliation.name = c.dra16.ids.name; return c.dra18.input; },
  "dra16-log-as-dra18-evidence": c => { const legacy = legacyOf(c.dra18.proof); legacy.log = structuredClone(dra16Log); legacy.receiptProgress = { ...consumers.dra16.receiptProgress }; return c.dra18.input; },
};
test.each(Object.keys(crossFaults))("cross-consumer contradiction is refused without touching either task: %s", async name => {
  const c = await both();
  const input = await crossFaults[name]!(c);
  const proof = name === "dra16-proof-for-dra18" || name === "dra16-request-for-dra18-task" ? c.dra16.proof : c.dra18.proof;
  const error = await recoverComputeNeon(input, async () => ({ proof: structuredClone(proof), observer: { ...observer } }), c.dra18.head, c.dra18.blobs, c.dra18.clock).then(() => null, (value: Error) => value);
  if (process.env.NEON_RECOVERY_REASONS) console.log(`REASON ${name}: ${error?.message.slice(0, 140)}`);
  expect(error).toBeInstanceOf(Error);
  expect(await recipeOf(c.dra16.environment.id)).toBe(oldHash); expect(await recipeOf(c.dra18.environment.id)).toBe(oldHash);
  expect(await events()).toBe(0);
});

test("a branch that would match only DRA-18's window or name blocks DRA-18 but not DRA-16", async () => {
  for (const branch of [{ id: "br-late", name: "unrelated", createdAt: "2026-11-06T00:40:40.000Z" }, { id: "br-named", name: "drafted-d-1cb4a488ebdafc8c37f0345c", createdAt: "2026-11-06T01:30:00.000Z" }]) {
    await db.cleanup(); db = await createTestDatabase();
    const { dra16, dra18 } = await both();
    legacyOf(dra16.proof).inventory.branches.push(branch); legacyOf(dra18.proof).inventory.branches.push(branch);
    await expect(recoverComputeNeon(dra18.input, dra18.read, dra18.head, dra18.blobs, dra18.clock)).rejects.toThrow("inventory does not prove the create absent");
    expect((await recoverComputeNeon(dra16.input, dra16.read, dra16.head, dra16.blobs, dra16.clock)).basis).toBe("legacy-provider-rejection");
  }
});

test("DRA-16's owner pause refuses only DRA-16; DRA-18 proceeds under its own authority", async () => {
  const { dra16, dra18 } = await both();
  await db.prisma.remoteTask.update({ where: { id: dra16.ids.task }, data: { ownerPaused: true } });
  let reads = 0;
  await expect(recoverComputeNeon(dra16.input, async () => { reads++; return dra16.read(); }, dra16.head, dra16.blobs, dra16.clock)).rejects.toThrow();
  expect(reads).toBe(0);
  expect((await recoverComputeNeon(dra18.input, dra18.read, dra18.head, dra18.blobs, dra18.clock)).environmentId).toBe(dra18.environment.id);
  expect(await recipeOf(dra16.environment.id)).toBe(oldHash);
});

// Historical synthetic fixture using the consumers' exact IDs as observed
// earlier (DRA-16 then owner-paused; both original claims then retained).
// Latest live state differs: DRA-16 is unpaused with its offer released, and
// both receipts now hold prepared providers, so neither is eligible. This
// exercises the pause and retained-claim rules generically, not a replay.
test("exact retained allocations: paused DRA-16 refuses before any read; unpaused DRA-18 advances only its own projection", async () => {
  const dra16 = await legacyFixture({ consumer: "dra16" }), dra18 = await legacyFixture({ consumer: "dra18" });
  await db.prisma.remoteTask.update({ where: { id: dra16.ids.task }, data: { ownerPaused: true } });
  const snapshot = async () => ({ offers: await db.prisma.computeOffer.findMany({ orderBy: { id: "asc" } }), slots: await db.prisma.computeSlot.findMany({ orderBy: { id: "asc" } }),
    waits: await db.prisma.computeWait.findMany(), tasks: await db.prisma.remoteTask.findMany({ orderBy: { id: "asc" } }), instructions: await db.prisma.runtimeInstruction.findMany() });
  const before = await snapshot();
  expect(before.slots.map(slot => [slot.id, slot.allocationId])).toEqual([["host:0", "7ebb1829-a987-422a-b8b1-117509ad8ec0"], ["host:1", "c962e9d0-7626-46b2-8a9a-ffe7d85899cf"]]);
  let reads = 0;
  await expect(recoverComputeNeon(dra16.input, async () => { reads++; return dra16.read(); }, dra16.head, dra16.blobs, dra16.clock)).rejects.toThrow();
  expect(reads).toBe(0);
  const result = await recoverComputeNeon(dra18.input, dra18.read, dra18.head, dra18.blobs, dra18.clock);
  expect(result).toMatchObject({ environmentId: "c7804078-f94c-4e05-bf1c-f2dd8ad67ede", resourceId: "cmw48yw4w00tyzkxca11te1sl", offerId: "c962e9d0-7626-46b2-8a9a-ffe7d85899cf",
    operationId: "b80f4a2f-4fbc-4a21-93fa-3b5aaca3d117", allocation: "retained-existing-claim", basis: "legacy-provider-rejection" });
  expect(await snapshot()).toEqual(before);
  expect(await recipeOf("a60c4fc1-c66e-4ab6-a7f2-b67573f39500")).toBe(oldHash);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: "cmw466c9600etzkxclbwhfi8l" } })).metadata).toMatchObject({ recipeHash: oldHash });
});

// An outcome that cannot be proven stays pending: nothing is written and the
// failed runtime, claim and history remain exactly as observed.
const unknownCases: Record<string, (f: Awaited<ReturnType<typeof legacyFixture>>) => Promise<void> | void> = {
  "dra18-transport-unknown": f => { legacyOf(f.proof).receiptProgress.detail = "Remote dependency request failed; inspect the recorded operation before retrying"; },
  "dra18-registry-disagrees": async f => { const meta = (await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).metadata as Record<string, unknown>;
    const changed = await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { ...meta, progress: { ...(meta.progress as object), detail: "Remote dependency POST failed (400)" } } } });
    await db.prisma.computeEnvironment.update({ where: { id: f.environment.id }, data: { resourceIdentity: finalizationResourceIdentity(changed).identityDigest } }); },
  "dra18-registry-written-before-failure": async f => { await db.prisma.$executeRawUnsafe(`UPDATE "RemoteTaskResource" SET "updatedAt" = '2026-11-06T00:40:00.000Z' WHERE "id" = '${f.resource.id}'`); },
  "dra18-no-primary-turn": async () => { await db.prisma.runtimeLifecycleEvent.deleteMany({}); },
  "dra18-no-inventory": f => { delete (legacyOf(f.proof) as any).inventory; },
};
test.each(Object.keys(unknownCases))("unproven outcome stays pending with no write: %s", async name => {
  const f = await legacyFixture({ consumer: "dra18" });
  await unknownCases[name]!(f);
  const before = { env: await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }), resource: await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } }),
    offers: await db.prisma.computeOffer.findMany(), slots: await db.prisma.computeSlot.findMany() };
  const read = async () => ({ proof: structuredClone(f.proof), observer: { ...observer } });
  const error = await recoverComputeNeon(f.input, read, f.head, f.blobs, f.clock).then(() => null, (value: Error) => value);
  if (process.env.NEON_RECOVERY_REASONS) console.log(`REASON ${name}: ${error?.message.slice(0, 140)}`);
  expect(error).toBeInstanceOf(Error);
  expect({ env: await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }), resource: await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } }),
    offers: await db.prisma.computeOffer.findMany(), slots: await db.prisma.computeSlot.findMany() }).toEqual(before);
  expect(await events()).toBe(0);
});

// Source progress: original provisioning revision preserved, current HEAD
// pinned by the operation and observed twice.
test("original revision differs from the current worktree HEAD; recovery preserves the environment revision and records the source", async () => {
  const f = await fixture(), seen: unknown[] = [];
  const result = await recoverComputeNeon(f.input, f.read, async (task, base) => { seen.push({ task, base }); return currentHead; });
  expect(result.sourceRevision).toBe(currentHead);
  expect(seen).toEqual([{ task: { worktreePath: "/fixture/task", branchName: "codex/task" }, base: revision }, { task: { worktreePath: "/fixture/task", branchName: "codex/task" }, base: revision }]);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(revision);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).metadata).toMatchObject({ revision });
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).toolingRevision).toBe(pin);
});

const sourceFaults: Record<string, { head: (calls: number) => string; edit?: (f: Awaited<ReturnType<typeof fixture>>) => void; reason: string }> = {
  "head-moves-mid-observation": { head: calls => calls === 1 ? currentHead : "5".repeat(40), reason: "changed during observation" },
  "head-not-recorded-source": { head: () => "5".repeat(40), reason: "recorded worktree revision" },
  "proof-other-source": { head: () => currentHead, edit: f => { f.proof.sourceRevision = "5".repeat(40); }, reason: "proof changed ownership" },
  "proof-claims-original-as-source": { head: () => currentHead, edit: f => { f.proof.sourceRevision = revision; }, reason: "proof changed ownership" },
  "proof-rewrites-environment-revision": { head: () => currentHead, edit: f => { f.proof.revision = currentHead; }, reason: "proof changed ownership" },
};
test.each(Object.keys(sourceFaults))("source distinction refuses: %s", async name => {
  const f = await fixture(), fault = sourceFaults[name]!; let calls = 0;
  fault.edit?.(f);
  await expect(recoverComputeNeon(f.input, async () => ({ proof: structuredClone(f.proof), observer: { ...observer } }), async () => fault.head(++calls))).rejects.toThrow(fault.reason);
  expect(await events()).toBe(0);
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).recipeDigest).toBe(oldHash);
});

test("a lost acknowledgment replays only at the recorded source; after source progress the committed projection stands without rewrite", async () => {
  const f = await fixture();
  const result = await recoverComputeNeon(f.input, f.read, f.head);
  expect(await recoverComputeNeon(f.input, f.read, f.head)).toEqual(result);
  await expect(recoverComputeNeon(f.input, f.read, async () => "5".repeat(40))).rejects.toThrow("recorded worktree revision");
  expect(await events()).toBe(1);
  expect(await recipeOf(f.environment.id)).toBe(nextHash);
});

async function sourceRepo(seed = "task") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "neon-recovery-source-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
  git("init", "-q", "-b", "codex/task");
  await writeFile(path.join(root, "a.txt"), `${seed}:1`); git("add", "-A"); git("commit", "-q", "-m", "original");
  const original = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "a.txt"), "2"); git("commit", "-q", "-am", "product progress");
  return { root, git, original, head: git("rev-parse", "HEAD") };
}
test("real worktree source: advanced task branch is accepted; wrong worktree, branch, ancestry and symlinked paths are refused", async () => {
  const repo = await sourceRepo("task"), other = await sourceRepo("other-task");
  try {
    expect(await readRecoverySource({ worktreePath: repo.root, branchName: "codex/task" }, repo.original, plainExecute)).toBe(repo.head);
    expect(repo.head).not.toBe(repo.original);
    // Another task's worktree: its history does not descend from this environment's revision.
    await expect(readRecoverySource({ worktreePath: other.root, branchName: "codex/task" }, repo.original, plainExecute)).rejects.toThrow();
    await mkdir(path.join(repo.root, "nested"));
    await expect(readRecoverySource({ worktreePath: path.join(repo.root, "nested"), branchName: "codex/task" }, repo.original, plainExecute)).rejects.toThrow("top level");
    await expect(readRecoverySource({ worktreePath: repo.root, branchName: "codex/other" }, repo.original, plainExecute)).rejects.toThrow("task branch");
    const link = `${repo.root}-link`; await symlink(repo.root, link);
    try { await expect(readRecoverySource({ worktreePath: link, branchName: "codex/task" }, repo.original, plainExecute)).rejects.toThrow("exact directory"); } finally { await rm(link); }
    repo.git("checkout", "-q", "--detach");
    await expect(readRecoverySource({ worktreePath: repo.root, branchName: "codex/task" }, repo.original, plainExecute)).rejects.toThrow();
    repo.git("checkout", "-q", "codex/task");
    repo.git("reset", "-q", "--hard", repo.original); repo.git("commit", "-q", "--allow-empty", "-m", "rewritten");
    expect(await readRecoverySource({ worktreePath: repo.root, branchName: "codex/task" }, repo.original, plainExecute)).not.toBe(repo.head);
    await expect(readRecoverySource({ worktreePath: repo.root, branchName: "codex/task" }, repo.head, plainExecute)).rejects.toThrow();
  } finally { await rm(repo.root, { recursive: true, force: true }); await rm(other.root, { recursive: true, force: true }); }
});

// Legacy inventory freshness: first commit only, by the trusted server clock.
const listedAt = Date.parse(legacyInventory.listedAt), FRESH = 15 * 60_000;
const nothingWritten = async (f: Awaited<ReturnType<typeof legacyFixture>>) => {
  expect(await events()).toBe(0);
  expect(await recipeOf(f.environment.id)).toBe(oldHash);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).metadata).toMatchObject({ recipeHash: oldHash });
};
test.each([["recent (5 min)", 5 * 60_000], ["boundary (exactly 15 min)", FRESH], ["same instant", 0]] as const)("legacy inventory freshness accepts %s", async (_name, age) => {
  const f = await legacyFixture({ consumer: "dra18" }); f.clock.set(listedAt + age);
  expect((await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock)).basis).toBe("legacy-provider-rejection");
});
test.each([["stale by 1 ms", FRESH + 1, "older than 15 minutes"], ["stale by hours", 6 * 3_600_000, "older than 15 minutes"], ["dated in the future", -1, "dated after"]] as const)("legacy inventory freshness refuses %s with zero writes", async (_name, age, reason) => {
  const f = await legacyFixture({ consumer: "dra18" }); f.clock.set(listedAt + age);
  await expect(recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock)).rejects.toThrow(reason);
  await nothingWritten(f);
});
test("an inventory that ages past the bound during a slow observation is refused immediately before the first write", async () => {
  const f = await legacyFixture({ consumer: "dra18" }); f.clock.set(listedAt + 14 * 60_000);
  let reads = 0;
  const read = async () => { if (++reads === 2) f.clock.set(listedAt + FRESH + 30_000); return f.read(); }; // the second observation is slow
  await expect(recoverComputeNeon(f.input, read, f.head, f.blobs, f.clock)).rejects.toThrow("older than 15 minutes");
  expect(reads).toBe(2);
  await nothingWritten(f);
});
test("a lost acknowledgment replays hours later under the same operation and evidence; age is not re-required", async () => {
  const f = await legacyFixture({ consumer: "dra18" });
  const result = await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock);
  f.clock.set(listedAt + 6 * 3_600_000);
  expect(await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock)).toEqual(result);
  expect(await events()).toBe(1);
});
test("a replay never substitutes a fresh inventory: changed evidence after acknowledgment is refused", async () => {
  const f = await legacyFixture({ consumer: "dra18" });
  await recoverComputeNeon(f.input, f.read, f.head, f.blobs, f.clock);
  const later = listedAt + 6 * 3_600_000; f.clock.set(later + 60_000);
  const fresher = structuredClone(f.proof);
  legacyOf(fresher).inventory.listedAt = new Date(later).toISOString(); fresher.reconciliation.observedAt = new Date(later).toISOString();
  await expect(recoverComputeNeon(f.input, async () => ({ proof: structuredClone(fresher), observer: { ...observer } }), f.head, f.blobs, f.clock)).rejects.toThrow("changed after acknowledgment");
  expect(await events()).toBe(1);
});
test("freshness never promotes inventory-only absence or an unknown outcome", async () => {
  const f = await legacyFixture({ consumer: "dra18" }); f.clock.set(listedAt);
  legacyOf(f.proof).receiptProgress.detail = "Remote dependency request failed; inspect the recorded operation before retrying";
  const read = async () => ({ proof: structuredClone(f.proof), observer: { ...observer } });
  await expect(recoverComputeNeon(f.input, read, f.head, f.blobs, f.clock)).rejects.toThrow("no retained record");
  await nothingWritten(f);
});
