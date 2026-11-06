/**
 * DRA-24 bound Neon recovery seams (design 551400d9): kind/begin/callback,
 * group-scoped fence, exact legacy group eligibility, the transaction-safe
 * handoff resolver, and post-handoff code selection.
 *
 * Isolated migrated SQLite. Real: begin, the tooling-operation guard and its
 * hooks, legacy readers, adoption, resourceGroupCode/accountingCode. STAND-IN
 * (labelled where used): the recovery service's commit — projection, event
 * and completion are written by the test exactly where root composes them —
 * and the compute domain handlers behind the guard (they only acknowledge).
 * No Docker, provider, Drafted checkout or live configuration.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import type { AppEnv } from "../../middleware/context.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { toolingOperationGuard, toolingOperationRoutes } from "../../routes/tasks/tooling-operations.ts";
import {
  TOOLING_CALLBACKS, TOOLING_CALLBACK_CLASSIFICATION, TOOLING_OPERATION_HEADER, TOOLING_OPERATION_KINDS, beginSessionToolingOperation, matchToolingCallback, producerOperationId, resourceGroupCode,
} from "./tooling-operations.ts";
import { canonicalDigest, completeNeonRecoveryOperation, readToolingOperation, registerToolingStateWriteInTransaction, transitionToolingOperation } from "./tooling-releases.ts";
import { canonicalSha256 } from "./compute-neon-recovery.ts";
import {
  NEON_RECOVERY_EVENT_ACTION, NEON_RECOVERY_OPERATION_KIND, NEON_RECOVERY_RESOLUTION_KIND, neonRecoveryFence, neonRecoveryHandoffCode, neonRecoveryObservationContracts, readNeonRecoveryLegacyGroup, resolveNeonRecoveryLegacyGroup,
  type NeonRecoveryHandoff,
} from "./tooling-neon-recovery.ts";
import { accountingCode } from "./compute-observer.ts";
import { computeTaskIdentity } from "./compute-admission.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";

for (const name of Object.keys(process.env)) if (name.startsWith("REMOTE_AGENT_")) delete process.env[name];

let db: TestDatabase;
// Several tests rebuild the migrated database per scenario; keep them bounded but tolerant of host load.
setDefaultTimeout(120_000);
beforeEach(async () => { db = await createTestDatabase(); }, 60_000);
afterEach(async () => { await db.cleanup(); }, 60_000);

const LEGACY = "1".repeat(40), A = "a".repeat(40), OLD = "b".repeat(40), GRANTED = "9".repeat(40);
const KEY = "runtime-development", ENV = "22222222-2222-4222-8222-222222222222", OFFER = "33333333-3333-4333-8333-333333333333";
const PREVIOUS = "d".repeat(64), RECOVERED = "e".repeat(64), REVISION = "c".repeat(40);
const v2 = { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 1 }, stateFormats: { "drafted.runtime": { read: [1, 2], write: 1, writeVersions: [1, 2], preservesUnknown: true } } };
const v1Only = { ...v2, stateFormats: { "drafted.runtime": { read: [1], write: 1, preservesUnknown: true } } };
const request = (offerId = OFFER) => ({ offerId, operationId: "44444444-4444-4444-8444-444444444444", resourceKey: KEY, previousRecipeHash: PREVIOUS, recipeHash: RECOVERED,
  baselineFile: "/private/runtimes/task/development/runtime.baseline.json", lockPid: 4242, outcome: "absent", sourceRevision: "f".repeat(40) });
const stable = ({ lockPid: _pid, ...rest }: ReturnType<typeof request>) => rest;

type Group = { offerState?: "running" | "stopped"; rows?: Array<[kind: string, id: string, revision?: string]>; boundary?: boolean };
async function fixture(group: Group = {}) {
  const base = testConfig({ machine: "host" });
  const repository = { ...base.repository, id: "repo", tooling: { root: "/fixture/tooling-source", revision: LEGACY } };
  const config = { ...base, repository, repositories: { repo: repository }, compute: ComputePolicy.parse({ collectorFreshnessSeconds: 15 }) } as typeof base;
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/task", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: "/fixture/task",
    toolingRoot: "/fixture/tooling-source", toolingRevision: LEGACY, primarySessionId: "primary", phase: "working" } });
  for (const [id, revision, manifest] of [["release-a", A, v2], ["release-old", OLD, v1Only]] as const) await db.prisma.toolingRelease.create({ data: { id, repositoryId: "repo", revision,
    tree: revision.replace(/./g, "e"), policyBlob: "f".repeat(40), checkout: `/install/tooling/repo/${revision}`, manifest, lockfileDigest: "0".repeat(64), bunVersion: "1.3.0" } });
  // The pre-boundary, container-less group: resource, environment, its claimed offer.
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: KEY, kind: "task-runtime", purpose: "development", externalId: "/private/runtimes/task/development/runtime.json",
    metadata: { revision: REVISION, recipeHash: PREVIOUS } } });
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  await db.prisma.computeEnvironment.create({ data: { id: ENV, taskId: "task", primarySessionId: "primary", machineId: "host", key: KEY, purpose: "development", revision: REVISION, recipeDigest: PREVIOUS,
    state: group.offerState === "stopped" ? "suspended" : "running", resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest,
    taskIdentity: computeTaskIdentity(task, "primary", "host", null) } });
  const claimedAt = new Date(Date.now() - 60_000);
  await db.prisma.computeOffer.create({ data: { id: OFFER, environmentId: ENV, machineId: "host", instructionId: "instruction-1", state: group.offerState ?? "running", claimedAt,
    completedAt: group.offerState === "stopped" ? new Date(Date.now() - 30_000) : null, dispatchDeadline: new Date() } });
  if (group.boundary !== false) {
    await db.prisma.toolingLegacyBoundary.create({ data: { repositoryId: "repo", activationRequestKey: "first", legacyRevision: LEGACY, recordedAt: new Date(Date.now() - 1000) } });
    const rows = group.rows ?? [["compute-environment", ENV], ...(group.offerState === "stopped" ? [] : [["compute-offer", OFFER]] as Array<[string, string]>)];
    for (const [consumerKind, consumerId, revision] of rows) await legacyRow(consumerKind, consumerId, revision);
  }
  await activate("release-a", 1);
  return { config, resource };
}
const legacyRow = (consumerKind: string, consumerId: string, revision = LEGACY, task = "task") => db.prisma.toolingLegacyConsumer.create({ data: { id: crypto.randomUUID(), repositoryId: "repo", taskId: task,
  consumerKind, consumerId, provenance: "exact", revision, checkout: `/install/tooling/repo/${revision}` } });
const activate = (releaseId: string, generation: number) => db.prisma.toolingSelection.upsert({ where: { repositoryId: "repo" },
  create: { repositoryId: "repo", generation, releaseId, activatedAt: new Date() }, update: { generation, releaseId, activatedAt: new Date() } });
const task = () => db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
type Config = Awaited<ReturnType<typeof fixture>>["config"];
const begin = (config: Config, body: Record<string, unknown>) => beginSessionToolingOperation({ prisma: db.prisma, config, sessionId: "primary", request: body });
const recoveryBegin = (config: Config, extra: Record<string, unknown> = {}, offerId = OFFER) =>
  begin(config, { requestKey: `neon-${offerId}`, inputDigest: canonicalDigest(stable(request(offerId))), kind: NEON_RECOVERY_OPERATION_KIND, existingOperationId: offerId, resourceKey: KEY, ...extra });
const legacyStatus = async () => (await db.prisma.toolingLegacyConsumer.findMany({ where: { taskId: "task" }, orderBy: { consumerKind: "asc" } })).map(row => `${row.consumerKind}:${row.status}`);

/** STAND-IN for the recovery service's commit (A432 integrates it in
 * compute-neon-recovery.ts under its write lock), composed from the REAL
 * seams in the design's order: the operation is running (the service's CAS),
 * the legacy handoff with the proof-derived capability cutoff, the real
 * drafted.runtime/2 registration, the projection, the full stored event
 * (strictly readable by readCommittedNeonRecovery) and the real completion
 * seam. The proof/observer values are synthetic: no observer runs here. */
async function commitRecovery(operationId: string, options: { fail?: boolean; cutoff?: Date } = {}) {
  const operation = (await readToolingOperation({ prisma: db.prisma, operationId }))!;
  const offerId = operation.existingOperationId!, computeOperation = request().operationId;
  const stableRequest = { ...request(offerId) };
  return db.prisma.$transaction(async tx => {
    await tx.toolingOperation.updateMany({ where: { id: operationId, status: { in: ["bound", "running"] } }, data: { status: "running" } });
    const handoff = await resolveNeonRecoveryLegacyGroup(tx, { taskId: "task", offerId, resourceKey: KEY, operationId, grantedAtOrBefore: options.cutoff ?? new Date() });
    const write = await registerToolingStateWriteInTransaction(tx, { operationId, family: "drafted.runtime", scopeKey: KEY, version: 2 });
    const resource = await tx.remoteTaskResource.update({ where: { taskId_key: { taskId: "task", key: KEY } }, data: { metadata: { revision: REVISION, recipeHash: RECOVERED } } });
    const identity = finalizationResourceIdentity(resource).identityDigest;
    await tx.computeEnvironment.update({ where: { id: ENV }, data: { recipeDigest: RECOVERED, resourceIdentity: identity } });
    const saved = { provider: "planetscale" as const, id: "ps-task", name: "drafted-task" };
    const attempt = { version: 1 as const, name: saved.name, projectId: "spatial-project", templateBranchId: "br-template", parentLsn: "0/1A2B3C4", requestedAt: "2026-11-04T10:01:00.000Z",
      expiresAt: "2026-11-11T10:01:00.000Z", rejection: { status: 422, code: "BRANCHES_LIMIT_EXCEEDED", observedAt: "2026-11-04T10:01:01.000Z" } };
    const reconciliation = { operation: "create-neon", outcome: "absent", name: saved.name, projectId: "spatial-project", observedAt: "2026-11-05T09:00:00.000Z", attempt, absence: { basis: "provider-rejection" } };
    const release = operation.release;
    const proof = { version: 1, contract: "runtime-neon-recovery/v1", transition: "neon-template-child", taskId: "task", primarySessionId: "primary", toolingRevision: LEGACY,
      environmentId: ENV, resourceId: resource.id, resourceKey: KEY, offerId, operationId: computeOperation, revision: REVISION, sourceRevision: stableRequest.sourceRevision,
      previousRecipeHash: PREVIOUS, recipeHash: RECOVERED, receiptSha256: "2".repeat(64), baselineSha256: "2".repeat(64), lockSha256: "3".repeat(64), lockPid: stableRequest.lockPid,
      stage: { phase: "failed", pending: null, setupComplete: false, schemaApplied: false, fixturesComplete: false, spatialSchema: false, container: false, containerOperation: false, configuration: false, coverage: false, startBundle: false },
      baselineProviders: [saved], providers: [saved], reconciliation, baselineNeonCreateSha256: canonicalSha256(attempt),
      operation: { operationId, releaseId: release.id, revision: release.revision, tree: release.tree }, candidateSha256: "4".repeat(64), candidateVersion: 2, canonical: "baseline" };
    const observer = { operationId, releaseId: release.id, revision: release.revision, tree: release.tree, adapterSha256: "8".repeat(64) };
    const stateWrite = { family: "drafted.runtime", scopeKey: KEY, version: 2, operationId, releaseId: release.id, sequence: write.sequence };
    const result = { environmentId: ENV, resourceId: resource.id, resourceIdentity: identity, offerId, operationId: computeOperation, previousRecipeHash: PREVIOUS, recipeHash: RECOVERED,
      sourceRevision: stableRequest.sourceRevision, outcome: "absent", basis: "provider-rejection", reconciliationSha256: finalizationDigest(reconciliation), observer, allocation: "retained-existing-claim", stateWrite };
    const { baselineSha256, candidateSha256, baselineProviders, providers, stage, previousRecipeHash, recipeHash, revision, toolingRevision } = proof;
    const evidence = finalizationDigest({ baselineSha256, candidateSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId: computeOperation, revision, toolingRevision });
    const key = finalizationDigest({ environmentId: ENV, resourceId: resource.id, offerId, operationId: computeOperation, previousRecipeHash: PREVIOUS, recipeHash: RECOVERED });
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "compute:task", action: NEON_RECOVERY_EVENT_ACTION, key, value: JSON.stringify({
      version: 1, contract: "runtime-neon-recovery/v1", transition: "neon-template-child", taskIdentity: "identity-task", request: stableRequest, environment: { id: ENV }, resource: { id: resource.id },
      offer: { id: offerId }, allocations: { offers: [], slots: [], wait: null }, operation: { ...operation, status: "running" }, proof, observer, evidence, projectionIdentity: "6".repeat(64), handoff, stateWrite, result }) } });
    if (options.fail) throw new Error("injected failure after the handoff");
    await completeNeonRecoveryOperation(tx, { operationId, eventSequence: event.sequence });
    return handoff;
  });
}

/** The guard in front of stand-in domain handlers that only acknowledge. */
function app(config: Config) {
  const handled: string[] = [];
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  server.use("/api/*", toolingOperationGuard());
  server.route("/api/sessions", toolingOperationRoutes);
  server.all("/api/*", async c => { await c.req.json().catch(() => undefined); handled.push(c.req.path.split("/").at(-1)!); return c.json({}); });
  const post = async (route: string, body: unknown, operationId?: string) => {
    const response = await server.request(route, { method: "POST", headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  return { post, handled };
}

describe("kind, begin and callback", () => {
  test("compute-neon-recovery is a bound, digest-pinned callback that admits, produces, retains and owns nothing", () => {
    expect(TOOLING_OPERATION_KINDS).toContain("compute-neon-recovery");
    const matched = matchToolingCallback("POST", "/api/tasks/task/compute-neon-recovery")!;
    expect(matched.callback).toMatchObject({ kind: "compute-neon-recovery", scope: "task" });
    expect(matched.callback.reference).toBeUndefined();
    expect(matched.callback.referenceRule ?? matched.callback.admits ?? matched.callback.produces ?? matched.callback.retains).toBeUndefined();
    // The retried request may hold a new runtime lock: lockPid is outside the digest.
    const body = request();
    expect(canonicalDigest(matched.callback.input(body, undefined as never))).toBe(canonicalDigest(stable(body)));
    expect(matched.callback.completes!(body)).toEqual({ kind: "compute-neon-recovery", reference: OFFER });
    expect(TOOLING_CALLBACK_CLASSIFICATION.find(row => row.route === "POST /api/tasks/:taskId/compute-neon-recovery")).toMatchObject({ rule: "operation" });
    expect(TOOLING_CALLBACKS.filter(callback => callback.kind === "compute-neon-recovery")).toHaveLength(1);
  });

  test("begin binds a root or same-command child only for an eligible group, with an exact existing offer and resourceKey, on a v1+v2 release", async () => {
    const { config } = await fixture();
    await expect(begin(config, { requestKey: "no-key", inputDigest: canonicalDigest(stable(request())), kind: NEON_RECOVERY_OPERATION_KIND, existingOperationId: OFFER })).rejects.toThrow(/resourceKey/);
    await expect(begin(config, { requestKey: "no-offer", inputDigest: canonicalDigest(stable(request())), kind: NEON_RECOVERY_OPERATION_KIND, resourceKey: KEY })).rejects.toThrow(/exact existing offer/);
    // A release that cannot write drafted.runtime/2 refuses before binding.
    await activate("release-old", 2);
    await expect(recoveryBegin(config)).rejects.toThrow(/read drafted.runtime versions 1 and 2 and write version 2/);
    expect(await db.prisma.toolingOperation.count()).toBe(0);
    await activate("release-a", 3);
    const root = (await recoveryBegin(config)).binding;
    expect(root).toMatchObject({ kind: "compute-neon-recovery", existingOperationId: OFFER, resourceKey: KEY, parentOperationId: null, release: { revision: A } });
    // The exact same command's child is supported (no parent prohibition).
    const command = (await begin(config, { requestKey: "runtime-recover", inputDigest: canonicalDigest({ command: "recover" }), kind: "adapter-command", resourceKey: KEY })).binding;
    const child = (await recoveryBegin(config, { requestKey: "runtime-recover/neon", parentOperationId: command.operationId })).binding;
    expect(child).toMatchObject({ parentOperationId: command.operationId, release: { revision: A } });
    // Begin decided eligibility only: nothing was resolved, associated or retained.
    expect(await legacyStatus()).toEqual(["compute-environment:retained", "compute-offer:retained"]);
    expect(await db.prisma.toolingRetainedConsumer.count()).toBe(0);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { source: "tooling-operation:task" } })).toBe(0);
    await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    await expect(recoveryBegin(config, { requestKey: "paused" })).rejects.toThrow(/paused/);
  });

  test("a stale retained row of an already-stopped offer resolves through existing evidence; the environment row is the group", async () => {
    const { config } = await fixture({ offerState: "stopped", rows: [["compute-environment", ENV], ["compute-offer", OFFER]] });
    expect((await recoveryBegin(config)).binding.kind).toBe("compute-neon-recovery");
    expect(await legacyStatus()).toEqual(["compute-environment:retained", "compute-offer:resolved"]);
    const group = await readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY });
    expect(group.legacy.map(row => row.consumerKind)).toEqual(["compute-environment"]);
  });
});

describe("exact legacy group eligibility (computed from server rows only)", () => {
  const refused = async (setup: (config: Config) => Promise<unknown>, pattern: RegExp, group: Group = {}) => {
    await db.cleanup(); db = await createTestDatabase();
    const { config } = await fixture(group);
    await setup(config);
    await expect(recoveryBegin(config)).rejects.toThrow(pattern);
    expect(await db.prisma.toolingOperation.count({ where: { kind: NEON_RECOVERY_OPERATION_KIND } })).toBe(0);
  };

  test("unavailable, foreign-revision, unrelated, finalizing and touched groups refuse with nothing bound", async () => {
    await refused(() => db.prisma.toolingLegacyConsumer.updateMany({ where: { consumerKind: "compute-environment" }, data: { provenance: "unavailable", revision: null, checkout: null } }), /provenance is unavailable/);
    await refused(() => db.prisma.toolingLegacyConsumer.updateMany({ where: { consumerKind: "compute-environment" }, data: { revision: OLD } }), /neither the task pin nor a runtime capability granted/);
    // G6: any retained legacy reader outside the group (another environment of the task).
    await refused(async () => { await db.prisma.computeEnvironment.create({ data: { id: "other-env", taskId: "task", primarySessionId: "primary", machineId: "host", key: "runtime-review",
      purpose: "review", revision: REVISION, recipeDigest: PREVIOUS, state: "running", taskIdentity: "9".repeat(64) } }); await legacyRow("compute-environment", "other-env"); }, /outside the recovered group/);
    // G5: a finalizing task keeps its old-pin cleanup reader.
    await refused(() => legacyRow("finalization", "task:final-1"), /finalizing task/);
    // Under the write lock (no finished-reader resolution runs there), any cleanup reader refuses too.
    await legacyRow("cleanup-request", "task:cleanup-1");
    await expect(readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY })).rejects.toThrow(/finalizing task/);
    // G3: bound code already touched the group (any association state) or retained a reader.
    for (const key of [`admission:environment-key:${KEY}`, `producer:compute-environment:${ENV}`, `owner:compute-offer:${OFFER}`]) {
      await refused(() => db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key,
        value: JSON.stringify({ version: 1, operationId: crypto.randomUUID(), role: key.split(":")[0], state: "failed" }) } }), key.startsWith("owner:") ? /binding is missing/ : /already touched by bound code/);
      // The under-lock read refuses every touched group itself, whatever begin checked first.
      await expect(readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY })).rejects.toThrow(/already touched by bound code/);
    }
    await refused(async () => { const operation = (await begin((await fixtureConfig()), { requestKey: "fence", inputDigest: canonicalDigest({ c: 1 }), kind: "adapter-command" })).binding;
      await db.prisma.toolingRetainedConsumer.create({ data: { id: crypto.randomUUID(), operationId: operation.operationId, repositoryId: "repo", taskId: "task", consumerKind: "compute-environment",
        consumerId: ENV, scopeKey: KEY, releaseId: "release-a", generation: 1, protocol: 1, status: "resolved" } }); }, /retained reader/);
    // No first-bootstrap boundary: recovery is bound-only and cannot hand anything off.
    await refused(async () => undefined, /no first-bootstrap boundary/, { boundary: false });
  });

  test("a granted runtime capability snapshot qualifies; an unreadable grant refuses", async () => {
    const { config } = await fixture({ rows: [["compute-environment", ENV, GRANTED], ["compute-offer", OFFER, GRANTED]] });
    await expect(recoveryBegin(config)).rejects.toThrow(/neither the task pin/);
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key: "runtime", value: JSON.stringify({ capability: "runtime", capabilityRevision: GRANTED }) } });
    expect((await recoveryBegin(config)).binding.kind).toBe("compute-neon-recovery");
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key: "broken", value: "{not json" } });
    await expect(readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY })).rejects.toThrow(/cannot read capability grant/);
  });

  test("authoritative handoff counts only capabilities granted by the original request's cutoff, and the legacy basis's reviewed revision", async () => {
    const { config } = await fixture({ rows: [["compute-environment", ENV, GRANTED], ["compute-offer", OFFER, GRANTED]] });
    const requestStart = new Date(Date.now() - 10 * 60_000);
    // Granted AFTER the original failed request: begin is advisory and binds, the authoritative resolver refuses.
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key: "late", occurredAt: new Date(requestStart.getTime() + 1000),
      value: JSON.stringify({ capability: "runtime", capabilityRevision: GRANTED }) } });
    const { binding } = await recoveryBegin(config);
    const resolve = (input: { grantedAtOrBefore: Date; legacySourceRevision?: string }) => db.prisma.$transaction(tx => resolveNeonRecoveryLegacyGroup(tx, { taskId: "task", offerId: OFFER, resourceKey: KEY, operationId: binding.operationId, ...input }));
    await expect(resolve({ grantedAtOrBefore: requestStart })).rejects.toThrow(/granted by/);
    await expect(db.prisma.$transaction(tx => resolveNeonRecoveryLegacyGroup(tx, { taskId: "task", offerId: OFFER, resourceKey: KEY, operationId: binding.operationId } as never))).rejects.toThrow(/capability cutoff/);
    expect(await legacyStatus()).toEqual(["compute-environment:retained", "compute-offer:retained"]);
    // Granted at the cutoff (inclusive): eligible, unless the legacy basis names another reviewed revision.
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "task:task", action: "tooling-capability", key: "early", occurredAt: requestStart,
      value: JSON.stringify({ capability: "runtime", capabilityRevision: GRANTED }) } });
    await expect(resolve({ grantedAtOrBefore: requestStart, legacySourceRevision: LEGACY })).rejects.toThrow(/not the reviewed executed revision/);
    expect((await resolve({ grantedAtOrBefore: requestStart, legacySourceRevision: GRANTED })).rows).toHaveLength(2);
  });

  test("observation contracts are stated explicitly for the service's bound-observer check, never inferred from the format manifest", async () => {
    const { resource } = await fixture();
    expect(neonRecoveryObservationContracts(await readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY }))).toEqual(["runtime-neon-recovery/v1", "compute-traffic/v1"]);
    await db.prisma.computeBaseline.create({ data: { id: "baseline-1", machineId: "host", taskId: "task", purpose: "development", resourceIds: [resource.id], refreshToken: "t" } });
    await legacyRow("compute-baseline", "task:development");
    expect(neonRecoveryObservationContracts(await readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY }))).toEqual(["runtime-neon-recovery/v1", "compute-traffic/v1", "compute-baseline/v1"]);
  });

  test("development intents and baselines join the group only on exact proof", async () => {
    const intent = async (value: Record<string, unknown>) => (await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: crypto.randomUUID(),
      value: JSON.stringify({ version: 1, identityDigest: "a".repeat(64), requestKey: "r", ...value }) } })).sequence;
    const { config, resource } = await fixture();
    // A suspension of this environment is part of the group.
    const own = await intent({ action: "stop", reason: "runtime-suspended", suspension: { environmentId: ENV } });
    await legacyRow("development-intent", String(own));
    // Exact baseline membership: the purpose's accounting group is exactly this resource.
    await db.prisma.computeBaseline.create({ data: { id: "baseline-1", machineId: "host", taskId: "task", purpose: "development", resourceIds: [resource.id], refreshToken: "t" } });
    await legacyRow("compute-baseline", "task:development");
    expect((await readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY })).legacy.map(row => row.consumerKind).sort())
      .toEqual(["compute-baseline", "compute-environment", "compute-offer", "development-intent"]);
    // A baseline that accounts for anything else is refused explicitly.
    await db.prisma.computeBaseline.update({ where: { id: "baseline-1" }, data: { resourceIds: [resource.id, "other-resource"] } });
    await expect(recoveryBegin(config)).rejects.toThrow(/not exactly the recovered resource/);
    await db.prisma.computeBaseline.update({ where: { id: "baseline-1" }, data: { resourceIds: [resource.id] } });
    await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "other-runtime", kind: "task-runtime", purpose: "development", externalId: "/x", metadata: {} } });
    await expect(recoveryBegin(config)).rejects.toThrow(/accounts for other resources/);
    await db.prisma.remoteTaskResource.update({ where: { taskId_key: { taskId: "task", key: "other-runtime" } }, data: { state: "released" } });
    // A suspension of another environment is outside the group; an unreadable intent refuses.
    const foreign = await intent({ action: "stop", reason: "runtime-suspended", suspension: { environmentId: "other-env" } });
    const row = await legacyRow("development-intent", String(foreign));
    await expect(recoveryBegin(config)).rejects.toThrow(/outside the recovered group/);
    await db.prisma.toolingLegacyConsumer.delete({ where: { id: row.id } });
    // A finished (missing) intent is resolved by existing evidence at begin; a live unreadable one refuses.
    await legacyRow("development-intent", "999999");
    const torn = (await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: "torn", value: "{" } })).sequence;
    await legacyRow("development-intent", String(torn));
    await expect(recoveryBegin(config)).rejects.toThrow(/cannot read legacy development intent/);
    expect((await db.prisma.toolingLegacyConsumer.findFirstOrThrow({ where: { consumerId: "999999" } })).status).toBe("resolved");
  });
});
async function fixtureConfig() { const base = testConfig({ machine: "host" }); const repository = { ...base.repository, id: "repo", tooling: { root: "/fixture/tooling-source", revision: LEGACY } };
  return { ...base, repository, repositories: { repo: repository } } as Config; }

describe("transaction-safe handoff resolver", () => {
  test("resolves exactly the group's readers with this operation as evidence, keeps snapshots, and writes nothing else", async () => {
    const { config } = await fixture();
    const { binding } = await recoveryBegin(config);
    const before = { offers: await db.prisma.computeOffer.findMany(), associations: await db.prisma.runtimeMetadataEvent.count({ where: { source: "tooling-operation:task" } }) };
    const handoff = await db.prisma.$transaction(tx => resolveNeonRecoveryLegacyGroup(tx, { taskId: "task", offerId: OFFER, resourceKey: KEY, operationId: binding.operationId, grantedAtOrBefore: new Date() }));
    expect(handoff).toMatchObject({ version: 1, operationId: binding.operationId, taskId: "task", environmentId: ENV });
    expect(handoff.rows.map(row => [row.consumerKind, row.revision]).sort()).toEqual([["compute-environment", LEGACY], ["compute-offer", LEGACY]]);
    for (const row of await db.prisma.toolingLegacyConsumer.findMany()) {
      expect(row).toMatchObject({ status: "resolved", resolution: { kind: NEON_RECOVERY_RESOLUTION_KIND, reference: binding.operationId }, revision: LEGACY, checkout: `/install/tooling/repo/${LEGACY}` });
    }
    // No admission, producer, owner, reader or allocation change; the operation is untouched.
    expect(await db.prisma.computeOffer.findMany()).toEqual(before.offers);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { source: "tooling-operation:task" } })).toBe(before.associations);
    expect(await db.prisma.toolingRetainedConsumer.count()).toBe(0);
    expect(await db.prisma.toolingStateWrite.count()).toBe(0);
    expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: binding.operationId } })).status).toBe("bound");
    // Exact replay by the same operation: same handoff, no writes. Another operation is refused.
    expect(await db.prisma.$transaction(tx => resolveNeonRecoveryLegacyGroup(tx, { taskId: "task", offerId: OFFER, resourceKey: KEY, operationId: binding.operationId, grantedAtOrBefore: new Date() }))).toEqual(handoff);
    await expect(db.prisma.$transaction(tx => resolveNeonRecoveryLegacyGroup(tx, { taskId: "task", offerId: OFFER, resourceKey: KEY, operationId: crypto.randomUUID(), grantedAtOrBefore: new Date() }))).rejects.toThrow(/already handed off/);
  });

  test("a later failure in the same transaction rolls the handoff back; a changed group refuses under the lock", async () => {
    const { config } = await fixture();
    const { binding } = await recoveryBegin(config);
    await expect(commitRecovery(binding.operationId, { fail: true })).rejects.toThrow(/injected failure/);
    expect(await legacyStatus()).toEqual(["compute-environment:retained", "compute-offer:retained"]);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: NEON_RECOVERY_EVENT_ACTION } })).toBe(0);
    const read = await readNeonRecoveryLegacyGroup(db.prisma, { taskId: "task", offerId: OFFER, resourceKey: KEY });
    await db.prisma.computeOffer.create({ data: { id: "late-offer", environmentId: ENV, machineId: "host", instructionId: "late", state: "expired", dispatchDeadline: new Date() } });
    await expect(db.prisma.$transaction(tx => resolveNeonRecoveryLegacyGroup(tx, { taskId: "task", offerId: OFFER, resourceKey: KEY, operationId: binding.operationId, grantedAtOrBefore: new Date(), expectedDigest: read.digest }))).rejects.toThrow(/changed since it was read/);
    // An unrelated retained reader appearing before the lock refuses and resolves nothing.
    await legacyRow("compute-environment", "unrelated-env");
    await expect(commitRecovery(binding.operationId)).rejects.toThrow(/outside the recovered group/);
    expect(await legacyStatus()).toEqual(["compute-environment:retained", "compute-environment:retained", "compute-offer:retained"]);
  });
});

describe("post-handoff code selection", () => {
  test("the group runs the committed recovery's release, strictly validated, never the active release", async () => {
    const { config } = await fixture();
    const reference = { type: "compute-environment" as const, id: ENV };
    expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference })).code!.revision).toBe(LEGACY);
    const { binding } = await recoveryBegin(config);
    await commitRecovery(binding.operationId);
    const selected = await resourceGroupCode({ prisma: db.prisma, task: await task(), reference });
    expect(selected).toMatchObject({ code: { id: "release-a", revision: A }, binding: { operationId: binding.operationId } });
    // A newer activation is never borrowed.
    await activate("release-old", 2);
    expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference })).code!.revision).toBe(A);
    // Offer rows of the handed-off group select the same code.
    expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-offer", id: OFFER } })).code!.revision).toBe(A);
  });

  test("an incomplete operation, a missing, duplicated, unreadable or mismatched event throws", async () => {
    const reference = { type: "compute-environment" as const, id: ENV };
    const scenario = async (corrupt: (operationId: string) => Promise<unknown>, pattern: RegExp) => {
      await db.cleanup(); db = await createTestDatabase();
      const { config } = await fixture();
      const { binding } = await recoveryBegin(config);
      await commitRecovery(binding.operationId);
      await corrupt(binding.operationId);
      await expect(resourceGroupCode({ prisma: db.prisma, task: await task(), reference })).rejects.toThrow(pattern);
    };
    const event = { where: { action: NEON_RECOVERY_EVENT_ACTION } };
    await scenario(id => db.prisma.toolingOperation.update({ where: { id }, data: { status: "running" } }), /not this task's completed recovery/);
    await scenario(() => db.prisma.runtimeMetadataEvent.deleteMany(event), /no committed recovery event names the operation/);
    await scenario(async () => { const row = await db.prisma.runtimeMetadataEvent.findFirstOrThrow(event);
      await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "compute:task", action: NEON_RECOVERY_EVENT_ACTION, key: "duplicate", value: row.value } }); }, /2 recovery events/);
    await scenario(() => db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "compute:task", action: NEON_RECOVERY_EVENT_ACTION, key: "torn", value: "{" } }), /not JSON/);
    await scenario(async () => { const row = await db.prisma.runtimeMetadataEvent.findFirstOrThrow(event), value = JSON.parse(row.value!);
      await db.prisma.runtimeMetadataEvent.update({ where: { sequence: row.sequence }, data: { value: JSON.stringify({ ...value, operation: { ...value.operation, release: { ...value.operation.release, revision: OLD } } }) } }); }, /stored operation binding is not this operation/);
    await scenario(async () => { const row = await db.prisma.runtimeMetadataEvent.findFirstOrThrow(event), value = JSON.parse(row.value!) as { handoff: NeonRecoveryHandoff };
      await db.prisma.runtimeMetadataEvent.update({ where: { sequence: row.sequence }, data: { value: JSON.stringify({ ...value, handoff: { ...value.handoff, rows: value.handoff.rows.filter(entry => entry.consumerKind !== "compute-environment") } }) } }); }, /not exactly the recorded handoff/);
    await scenario(async () => db.prisma.toolingLegacyConsumer.updateMany({ where: { consumerKind: "compute-environment" }, data: { resolution: { kind: NEON_RECOVERY_RESOLUTION_KIND, reference: crypto.randomUUID() } } }), /missing/);
  });

  test("a baseline handed off with exactly its resource is accounted by the recovery release", async () => {
    const { config, resource } = await fixture();
    await db.prisma.computeBaseline.create({ data: { id: "baseline-1", machineId: "host", taskId: "task", purpose: "development", resourceIds: [resource.id], refreshToken: "t" } });
    await legacyRow("compute-baseline", "task:development");
    expect((await accountingCode({ config, prisma: db.prisma }, await task(), { purpose: "development" }, "baseline-observe")).code!.revision).toBe(LEGACY);
    const { binding } = await recoveryBegin(config);
    await commitRecovery(binding.operationId);
    expect(await accountingCode({ config, prisma: db.prisma }, await task(), { purpose: "development" }, "baseline-observe")).toMatchObject({ code: { revision: A }, binding: { operationId: binding.operationId } });
    expect((await accountingCode({ config, prisma: db.prisma }, await task(), { environment: { id: ENV } }, "reclaim-observe")).code!.revision).toBe(A);
    expect(await neonRecoveryHandoffCode(db.prisma, { task: await task(), reference: { type: "compute-baseline", id: "task:review" } }, async () => null)).toBeNull();
  });
});

describe("group-scoped fence for first-bootstrap continuation", () => {
  test("header-less continuation of the recovering group is refused before and after commit; other groups and finalization are not fenced", async () => {
    const { config } = await fixture();
    const { post, handled } = app(config);
    const claim = { key: KEY, purpose: "development", revision: REVISION, recipeDigest: PREVIOUS, offerId: OFFER };
    // Before any recovery operation the legacy snapshot continues, as today.
    expect((await post("/api/tasks/task/compute-claim", claim)).status).toBe(200);
    const { binding } = await recoveryBegin(config);
    const before = await post("/api/tasks/task/compute-claim", claim);
    expect(before).toMatchObject({ status: 428, body: { code: "operation-required", error: expect.stringContaining("under Neon recovery") } });
    await commitRecovery(binding.operationId);
    expect((await post("/api/tasks/task/compute-claim", claim)).status).toBe(428);
    expect(handled).toEqual(["compute-claim"]);
    // Group scope, decided from server rows: another environment, a foreign suspension and finalization are not fenced.
    await db.prisma.computeEnvironment.create({ data: { id: "other-env", taskId: "task", primarySessionId: "primary", machineId: "host", key: "runtime-review", purpose: "review", revision: REVISION, recipeDigest: PREVIOUS, taskIdentity: "9".repeat(64) } });
    await db.prisma.computeOffer.create({ data: { id: "other-offer", environmentId: "other-env", machineId: "host", instructionId: "o", dispatchDeadline: new Date() } });
    const intent = async (value: Record<string, unknown>) => String((await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "development:task", action: "development-compute-intent", key: crypto.randomUUID(), value: JSON.stringify(value) } })).sequence);
    const t = await task();
    expect(await neonRecoveryFence(db.prisma, t, { type: "compute-offer", id: "other-offer" })).toBeNull();
    expect(await neonRecoveryFence(db.prisma, t, { type: "compute-environment", id: "other-env" })).toBeNull();
    expect(await neonRecoveryFence(db.prisma, t, { type: "compute-environment", id: ENV })).toMatch(/under Neon recovery/);
    expect(await neonRecoveryFence(db.prisma, t, { type: "development-intent", id: await intent({ action: "stop", reason: "runtime-suspended", suspension: { environmentId: "other-env" } }) })).toBeNull();
    expect(await neonRecoveryFence(db.prisma, t, { type: "development-intent", id: await intent({ action: "stop", reason: "runtime-suspended", suspension: { environmentId: ENV } }) })).toMatch(/under Neon recovery/);
    expect(await neonRecoveryFence(db.prisma, t, { type: "development-intent", id: await intent({ action: "resume", reason: "owner-resume" }) })).toMatch(/under Neon recovery/);
    expect(await neonRecoveryFence(db.prisma, t, { type: "compute-baseline", id: "task:review" })).toBeNull();
    expect(await neonRecoveryFence(db.prisma, t, { type: "compute-baseline", id: "task:development" })).toMatch(/under Neon recovery/);
    expect(await neonRecoveryFence(db.prisma, t, { type: "finalization", id: "task:final-1" })).toBeNull();
    // A task with no recovery operation is never fenced.
    expect(await neonRecoveryFence(db.prisma, { id: "other-task", primarySessionId: "primary" }, { type: "compute-offer", id: OFFER })).toBeNull();
  });
});

describe("continuation after a committed handoff (no authority from recovery itself)", () => {
  /** Drafted-style command client over the real guard: fence + exact-echo children. */
  const command = async (post: ReturnType<typeof app>["post"], requestKey: string) => {
    const fence = (await post("/api/sessions/primary/tooling-operations", { requestKey, inputDigest: canonicalDigest({ command: requestKey }), kind: "adapter-command", resourceKey: KEY })).body.binding;
    const child = async (kind: string, input: unknown, existing?: string) => post("/api/sessions/primary/tooling-operations", { requestKey: `${requestKey}/${kind}/${existing ?? "new"}`, inputDigest: canonicalDigest(input),
      kind, parentOperationId: fence.operationId, ...(existing ? { existingOperationId: existing } : {}) });
    const settle = () => post(`/api/sessions/primary/tooling-operations/${fence.operationId}/settlement`, { requestKey: fence.requestKey, inputDigest: fence.inputDigest, outcome: "completed" }, fence.operationId);
    return { fence, child, settle };
  };
  const recovered = { key: KEY, purpose: "development", revision: REVISION, recipeDigest: RECOVERED };

  test("stopped history: the waiting request command settles, then a fresh offer command adopts only after a fresh stopped observation of the NEW resource identity", async () => {
    const { config } = await fixture({ offerState: "stopped" });
    const { post } = app(config);
    // The handoff retires the retained legacy environment that would refuse adoption (the C4 counterexample).
    const { binding } = await recoveryBegin(config);
    await commitRecovery(binding.operationId);
    expect(await legacyStatus()).toEqual(["compute-environment:resolved"]);
    // Command A: an ordinary bound request admits the environment key and waits; A settles.
    const a = await command(post, "a-runtime-up");
    const requestChild = (await a.child("compute-admission", recovered)).body.binding;
    expect((await post("/api/tasks/task/compute-request", recovered, requestChild.operationId)).status).toBe(200);
    expect((await a.settle()).status).toBe(200);
    // The delivered offer, created after the earlier claimed offer stopped.
    await Bun.sleep(5);
    await db.prisma.computeOffer.create({ data: { id: "offer-2", environmentId: ENV, machineId: "host", instructionId: "instruction-2", state: "offered", dispatchDeadline: new Date(Date.now() + 60_000) } });
    // Command B: adoption is refused until a fresh stopped observation of the recovered resource exists.
    const b = await command(post, "b-runtime-up-offer");
    expect((await b.child("compute-admission", recovered, "offer-2")).body).toMatchObject({ code: "retained-release-required", error: expect.stringContaining("no stopped observation of its current resource") });
    const resource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: KEY } } });
    const identity = finalizationResourceIdentity(resource).identityDigest;
    expect(identity).toBe((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: ENV } })).resourceIdentity!);
    const observation = (resourceIdentity: string) => ({ version: 1, environmentId: ENV, taskId: "task", primarySessionId: "primary", purpose: "development", revision: REVISION, recipeDigest: RECOVERED,
      resourceId: resource.id, resourceIdentity, observedAt: Date.now(), state: "stopped", coverage: "complete", configurationDigest: "c".repeat(64), routes: [], operations: { coverage: "complete", active: 0, generation: "a".repeat(64) } });
    // A stopped observation of the PREVIOUS identity does not qualify.
    await db.prisma.computeEnvironment.update({ where: { id: ENV }, data: { observation: observation("0".repeat(64)) } });
    expect((await b.child("compute-admission", recovered, "offer-2")).body.code).toBe("retained-release-required");
    await db.prisma.computeEnvironment.update({ where: { id: ENV }, data: { observation: observation(identity) } });
    const claimChild = await b.child("compute-admission", recovered, "offer-2");
    expect(claimChild.status, JSON.stringify(claimChild.body)).toBe(200);
    expect((await post("/api/tasks/task/compute-claim", { ...recovered, offerId: "offer-2" }, claimChild.body.binding.operationId)).status).toBe(200);
    // Recovery granted nothing itself: the only producer, if any, comes from an ordinary bind later.
    expect(await producerOperationId(db.prisma, await task(), ENV)).toBeNull();
  });

  test("retained claim: an ordinary bound bind continues the handed-off offer and its producer supersedes the recovery code", async () => {
    const { config } = await fixture();
    const { post } = app(config);
    const { binding } = await recoveryBegin(config);
    // Before the handoff a release-aware bind cannot take over the legacy offer.
    const early = await command(post, "c-early");
    expect((await early.child("compute-admission", { existingOperationId: OFFER }, OFFER)).body.code).toBe("retained-release-required");
    await commitRecovery(binding.operationId);
    const c = await command(post, "c-runtime-up");
    const bindChild = (await c.child("compute-admission", { existingOperationId: OFFER }, OFFER)).body.binding;
    expect(bindChild).toMatchObject({ existingOperationId: OFFER, release: { revision: A } });
    // The guard does not change offers, slots or claims; the stand-in handler only acknowledges.
    const offers = await db.prisma.computeOffer.findMany();
    expect((await post("/api/tasks/task/compute-bind", { offerId: OFFER, resourceKey: KEY }, bindChild.operationId)).status).toBe(200);
    expect(await db.prisma.computeOffer.findMany()).toEqual(offers);
    expect(await producerOperationId(db.prisma, await task(), ENV)).toBe(bindChild.operationId);
    expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-environment", id: ENV } })).binding!.operationId).toBe(bindChild.operationId);
  });
});

test("operation completion is not the seam's job: a bound recovery whose transaction never committed keeps the legacy code", async () => {
  const { config } = await fixture();
  const { binding } = await recoveryBegin(config);
  await transitionToolingOperation({ prisma: db.prisma, operationId: binding.operationId, from: "bound", to: "running" });
  expect((await resourceGroupCode({ prisma: db.prisma, task: await task(), reference: { type: "compute-environment", id: ENV } })).code!.revision).toBe(LEGACY);
});
