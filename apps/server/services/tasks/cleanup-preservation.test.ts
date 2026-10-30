import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod, realpath, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { CleanupTarget, cleanupTargetDigest, CleanupObserverBatchInput } from "./cleanup-observer-schema.ts";
import { assertFinalizationResources, prepareFinalizationResources, finalizationResourceIdentity, finalizationDigest, RetainedArchivePlan, RetainedArchiveMemberPlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { preparePreservationEvidence, assertPreservationSources } from "./cleanup-preservation.ts";
import { assertExternalResourceRecords } from "./external-deliveries.ts";
import { captureAdapterDependencies } from "./cleanup-filesystem.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "preserved-cleanup-"))); roots.push(root); await chmod(root, 0o700);
  const taskId = "originaltask", sessionId = "primary", purpose = "development", project = `drafted-${taskId}-${purpose}`, volume = `${project}-objects`, userId = "user_Preserved";
  const labels = { "dev.drafted.task": taskId, "dev.drafted.purpose": purpose, "com.docker.compose.project": project, "com.docker.compose.volume": "objects" };
  const saved = { task: taskId, sharedIdentity: { id: userId, disposition: "preserve per owner; no Clerk write or provider request performed" }, objectBucket: { id: "drafted-dra42", backingVolume: volume, disposition: "offline retained; provider absence NOT proven" }, volumes: [{ Name: volume, CreatedAt: "recorded-time", Labels: labels }] };
  const file = path.join(root, "resource-inventory.json"); await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const observed = await observeLegacyEvidenceFile(file, true);
  const archive: FinalizationResourceRecord = { id: "archive", key: "saved-archive", kind: "recovery-archive", purpose: "tooling", externalId: root, state: "ready", metadata: {} };
  const inventory: FinalizationResourceRecord = { id: "inventory", key: "saved-inventory", kind: "resource-inventory", purpose: "tooling", externalId: file, state: "ready", metadata: { sha256: observed.sha256, size: observed.size } };
  const compose: FinalizationResourceRecord = { id: "compose", key: "development-compose", kind: "docker-compose-project", purpose, externalId: project, state: "ready", metadata: { volumes: [volume, `${project}-redis`], composeFile: "/private/environment/compose.yml" } };
  const user: FinalizationResourceRecord = { id: "user", key: "preserved-user", kind: "clerk-test-user", purpose, externalId: userId, state: "ready", metadata: { instance: "recorded test instance", email: "synthetic@example.com" } };
  const bucket: FinalizationResourceRecord = { id: "bucket", key: "preserved-bucket", kind: "s3-bucket", purpose, externalId: "drafted-dra42", state: "ready", metadata: { volume } };
  const resources = [archive, inventory, compose, user, bucket];
  const retainedArchives = [RetainedArchivePlan.parse({ ...finalizationResourceIdentity(archive), disposition: "retain-archive", archive: { root, manifestPath: path.join(root, "MANIFEST"), manifestSha256: "a".repeat(64), inventoryDigest: "b".repeat(64) } }),
    RetainedArchiveMemberPlan.parse({ ...finalizationResourceIdentity(inventory), disposition: "retain-archive-member", archive: { root, resourceId: archive.id, inventoryDigest: "b".repeat(64) }, file: { path: file, sha256: observed.sha256, size: observed.size } })];
  const target = (raw: unknown) => { const t = CleanupTarget.parse(raw); t.identityDigest = cleanupTargetDigest(t); return t; };
  const volumeTarget = target({ kind: "docker-volume", id: volume, scope: { taskId, purpose, project, compose: { file: "/private/environment/compose.yml", sha256: "a".repeat(64), dev: 1, ino: 2, mode: 0o100600, member: "objects" } }, identity: { createdAt: "recorded-time", labelsDigest: finalizationDigest(labels) }, presentAtPrepare: true, identityDigest: "0".repeat(64) });
  const redisTarget = target({ kind: "docker-volume", id: `${project}-redis`, scope: { taskId, purpose, project }, identity: { createdAt: "recorded-time", labelsDigest: finalizationDigest(labels) }, presentAtPrepare: true, identityDigest: "0".repeat(64) });
  const userTarget = target({ kind: "clerk-user", id: userId, scope: { taskId, purpose, instanceId: "ins_Test", credentials: { backupFile: "/private/credentials/backup", backupSha256: "a".repeat(64), keyFile: "/private/credentials/key", keyId: "b".repeat(64) } }, creation: { createdAt: 1, emailDigest: "a".repeat(64) }, presentAtPrepare: true, identityDigest: "0".repeat(64) });
  const targets = new Map([[compose.id, [volumeTarget, redisTarget]], [user.id, [userTarget]]]), present = new Set([volumeTarget, redisTarget, userTarget].map(t => t.identityDigest));
  const instruction = { id: `task:${taskId}:owner-standing-cleanup`, sequence: 1503, sessionId, text: "Preserve the approved user and offline objects volume." };
  const database = { remoteTaskResource: { findMany: async () => resources }, runtimeInstruction: { findUnique: async () => instruction } } as unknown as PrismaClient;
  const selection = { instruction: { id: instruction.id, sequence: instruction.sequence }, inventoryResourceId: inventory.id, targets: [{ resourceId: user.id, kind: "clerk-user" as const, id: userId }, { resourceId: compose.id, kind: "docker-volume" as const, id: volume }] };
  const context = { task: { id: taskId, primarySessionId: sessionId, worktreePath: "/private/product", toolingRevision: "a".repeat(40) }, capability: { version: 1 as const, source: "configured-host" as const, checkout: "/private/tooling", revision: "b".repeat(40), adapter: "/private/tooling/src/cli.ts", adapterSha256: "c".repeat(64) } };
  const observation: ResourceObservation = { rootIdle: async () => {}, browserAbsent: async () => {}, endpointAbsent: async () => {}, adapters: async ({ request }) => {
    const batch = CleanupObserverBatchInput.parse(request);
    return { version: 1, taskId, observations: batch.observations.map(entry => { const record = resources.find(r => r.id === entry.resourceId)!, currentTargets = targets.get(entry.resourceId)!;
      const presentTargetDigests = currentTargets.filter(t => present.has(t.identityDigest)).map(t => t.identityDigest);
      return { version: 1, taskId, resourceId: record.id, resourceIdentityDigest: finalizationResourceIdentity(record).identityDigest, adapter: record.id === "compose" ? "compose" : "clerk", dependencies: [], stoppedConsumers: [], targets: currentTargets, presentTargetDigests, absent: presentTargetDigests.length === 0 }; }) };
  } };
  const proof = () => preparePreservationEvidence({ prisma: database, taskId, sessionId, resources, plan: retainedArchives, selection });
  const prepare = async () => prepareFinalizationResources({ taskId, sessionId, resources, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [], preservation: selection }, preservation: await proof(), originalWork: true, retainedArchives, toolingRoot: "/private/old-tooling", adapterContext: context }, observation);
  const verify = (plan: Awaited<ReturnType<typeof prepare>>, removed = false) => assertFinalizationResources({ taskId, resources, plan, removed, originalWork: true }, observation);
  return { root, taskId, sessionId, resources, archive, inventory, compose, user, bucket, retainedArchives, targets, volumeTarget, redisTarget, userTarget, present, instruction, database, selection, context, proof, prepare, verify, saved, observation };
}

test("exact retained target partition preserves original Ready receipts through partial retirement and replay", async () => {
  const f = await fixture(), plan = await f.prepare(), before = JSON.stringify(f.resources);
  expect(plan.filter(p => p.disposition === "retain-adapter")).toHaveLength(2); expect(plan.find(p => p.id === f.bucket.id)?.disposition).toBe("retain-backed");
  await f.verify(plan); await expect(f.verify(plan, true)).rejects.toThrow("unfinished retired partition");
  f.present.delete(f.redisTarget.identityDigest); await f.verify(plan, true); await f.verify(plan, true);
  await assertPreservationSources(f.database, f.taskId, f.sessionId, plan); assertExternalResourceRecords(f.resources, plan, true);
  expect(JSON.stringify(f.resources)).toBe(before); expect(f.present.size).toBe(2);
});
test.each(["volume", "user", "bucket"])("a retained %s cannot be missing or falsely Released", async selected => {
  const f = await fixture(), plan = await f.prepare(); f.present.delete(f.redisTarget.identityDigest);
  const record = selected === "volume" ? f.compose : selected === "user" ? f.user : f.bucket;
  record.state = "released"; await expect(f.verify(plan, true)).rejects.toThrow(); expect(() => assertExternalResourceRecords(f.resources, plan, true)).toThrow();
  record.state = "stopped"; await expect(assertPreservationSources(f.database, f.taskId, f.sessionId, plan)).rejects.toThrow("Ready");
  record.state = "ready"; f.present.delete((selected === "user" ? f.userTarget : f.volumeTarget).identityDigest); await expect(f.verify(plan, true)).rejects.toThrow("retained target");
});
test.each(["instruction-text", "instruction-session", "inventory-content", "inventory-inode", "inventory-receipt", "archive-member", "volume-created", "volume-labels", "selection", "duplicate-selection", "not-ready", "bucket-name"])("changed %s refuses preservation or renewal", async changed => {
  const f = await fixture(), plan = await f.prepare();
  if (changed === "instruction-text") f.instruction.text += " changed";
  if (changed === "instruction-session") f.instruction.sessionId = "another-primary";
  if (changed === "inventory-content") await writeFile(f.inventory.externalId, "{}");
  if (changed === "inventory-inode") { await rename(f.inventory.externalId, `${f.inventory.externalId}.old`); await writeFile(f.inventory.externalId, JSON.stringify(f.saved), { mode: 0o600 }); }
  if (changed === "inventory-receipt") f.inventory.metadata = { unrelated: true };
  if (changed === "archive-member") { const p = plan.find(p => p.disposition === "retain-archive-member")!; if (p.disposition === "retain-archive-member") p.archive.resourceId = "other"; }
  if (changed === "volume-created" && f.volumeTarget.kind === "docker-volume") f.volumeTarget.identity!.createdAt = "replacement";
  if (changed === "volume-labels" && f.volumeTarget.kind === "docker-volume") f.volumeTarget.identity!.labelsDigest = "e".repeat(64);
  if (changed === "selection") f.selection.targets[1]!.id = f.redisTarget.id;
  if (changed === "duplicate-selection") f.selection.targets.push(f.selection.targets[1]!);
  if (changed === "not-ready") f.compose.state = "stopped";
  if (changed === "bucket-name") f.bucket.externalId = "drafted-dra99";
  if (changed.startsWith("instruction")) await expect(assertPreservationSources(f.database, f.taskId, f.sessionId, plan)).rejects.toThrow("instruction");
  else if (["selection", "duplicate-selection", "not-ready", "bucket-name"].includes(changed)) await expect(f.prepare()).rejects.toThrow();
  else await expect(f.verify(plan)).rejects.toThrow();
});
test("omitting recorded preservation or selecting only one preserved target cannot grant ordinary deletion", async () => {
  const f = await fixture();
  await expect(preparePreservationEvidence({ prisma: f.database, taskId: f.taskId, sessionId: f.sessionId, resources: f.resources, plan: f.retainedArchives })).rejects.toThrow("complete exact target selection");
  f.selection.targets.pop(); await expect(f.prepare()).rejects.toThrow("complete exact target selection");
  expect(f.resources.every(resource => resource.state === "ready")).toBeTrue();
});
test.each(["large-video", "json-lookalike"])("preservation recognition does not read unrelated retained %s members", async shape => {
  const f = await fixture(), record = { ...f.inventory, id: "unrelated", key: "unrelated-member", kind: "evidence", purpose: "review" };
  const bytes = shape === "large-video" ? Buffer.alloc(2 * 1024 * 1024 + 1, 1) : Buffer.from(JSON.stringify(f.saved));
  await writeFile(record.externalId, bytes);
  const observed = await observeLegacyEvidenceFile(record.externalId, true, bytes.length);
  // Exercise this helper's recognition boundary separately from the stricter
  // public plan parser. A noninventory member cannot select this parser by shape.
  const member = { ...f.retainedArchives[1]!, ...finalizationResourceIdentity(record), file: { path: record.externalId, size: observed.size, sha256: observed.sha256 } } as unknown as typeof f.retainedArchives[number];
  const proof = await preparePreservationEvidence({ prisma: f.database, taskId: f.taskId, sessionId: f.sessionId, resources: [f.archive, record], plan: [f.retainedArchives[0]!, member] });
  expect(proof).toBeUndefined(); expect((await observeLegacyEvidenceFile(record.externalId, true, bytes.length)).sha256).toBe(observed.sha256);
});
test("capture cannot sweep retained Compose configuration or Clerk credentials", async () => {
  const f = await fixture(), plan = await f.prepare();
  expect(() => captureAdapterDependencies("/private/environment", f.resources, plan)).toThrow("confirmation inputs");
  expect(() => captureAdapterDependencies("/private/credentials", f.resources, plan)).toThrow("confirmation inputs");
  expect(captureAdapterDependencies("/private/unrelated", f.resources, plan)).toEqual({ dependencies: [], stoppedConsumers: [] });
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot)("actual client honors server-produced retained partition and retries a lost removal response without touching preserved bytes or receipts", async () => {
  const f = await fixture();
  const { observeCleanupResource } = await import(path.join(draftedRoot!, "src/cleanup-observer.ts"));
  const { releasePreparedResources } = await import(path.join(draftedRoot!, "src/finalization-resources.ts"));
  const { FinalizationResourcePlan: ClientPlan, assertResourcePlan, isRetainedPlan, retainedReferenceIds } = await import(path.join(draftedRoot!, "src/finalization-plan.ts"));
  const { adapterReceipt, fixtureCapability } = await import(path.join(draftedRoot!, "test/fixtures/prepared-adapter.ts"));
  const directory = path.join(f.root, f.taskId); await mkdir(directory, { mode: 0o700 });
  const composeFile = path.join(directory, "compose.yml"), project = f.compose.externalId, volume = f.volumeTarget.id, redis = f.redisTarget.id, network = "b".repeat(64), container = "a".repeat(64);
  await writeFile(composeFile, JSON.stringify({ name: project, services: { minio: {} }, networks: { default: { name: project } }, volumes: { objects: { name: volume }, redis: { name: redis } } }), { mode: 0o600 });
  f.compose.metadata = { composeFile, network: project, volumes: [volume, redis], containers: [`${project}-minio-1`] };
  f.user.metadata = { email: "dra42.original+clerk_test@example.com", instance: "pilot nonprod Clerk test instance (kid ins_Test)" };
  f.context.task.worktreePath = directory; Object.assign(f.context.capability, fixtureCapability);
  const objects: Record<string, Map<string, any>> = { container: new Map(), network: new Map(), volume: new Map() }, effects: string[] = [], writes: string[] = [];
  objects.container!.set(container, { id: container, name: `${project}-minio-1`, createdAt: "container-created", image: "sha256:fixture", running: true, networks: [network], volumes: [volume], labels: { "dev.drafted.task": f.taskId, "dev.drafted.purpose": "development", "com.docker.compose.project": project, "com.docker.compose.service": "minio", "com.docker.compose.project.config_files": composeFile, "com.docker.compose.project.working_dir": directory, "com.docker.compose.oneoff": "False", "com.docker.compose.container-number": "1" } });
  objects.network!.set(network, { id: network, name: project, createdAt: "network-created", labels: { "dev.drafted.task": f.taskId, "dev.drafted.purpose": "development", "com.docker.compose.project": project, "com.docker.compose.network": "default" } });
  objects.volume!.set(volume, { id: volume, createdAt: f.saved.volumes[0]!.CreatedAt, labels: f.saved.volumes[0]!.Labels });
  objects.volume!.set(redis, { id: redis, createdAt: "redis-created", labels: { ...f.saved.volumes[0]!.Labels, "com.docker.compose.volume": "redis" } });
  let lost = true;
  const docker = { inspect: async (kind: string, id: string) => structuredClone(objects[kind]!.get(id) ?? null), inventory: async (kind: string) => structuredClone([...objects[kind]!.values()]),
    stop: async (id: string) => { effects.push(`stop:${id}`); objects.container!.get(id)!.running = false; },
    remove: async (kind: string, id: string) => { effects.push(`remove:${kind}:${id}`); objects[kind]!.delete(id); if (kind === "container" && lost) { lost = false; throw new Error("lost removal response"); } } };
  const clerk = { credentials: async () => ({ backupFile: "/private/credentials/backup", backupSha256: "a".repeat(64), keyFile: "/private/credentials/key", keyId: "b".repeat(64) }), request: async (method: string, route: string) => {
    if (method !== "GET") throw new Error("Preserved user mutation refused");
    if (route === "/instance") return { id: "ins_Test", environment_type: "development" };
    if (route === `/users/${f.user.externalId}`) return { id: f.user.externalId, created_at: 1, email_addresses: [{ email_address: "dra42.original+clerk_test@example.com" }] };
    throw new Error("Unexpected route");
  } };
  f.observation.adapters = async ({ request }) => { const batch = CleanupObserverBatchInput.parse(request); return { version: 1, taskId: f.taskId, observations: await Promise.all(batch.observations.map(entry => observeCleanupResource({ version: 1, task: batch.task, resource: batch.resources.find(r => r.id === entry.resourceId), resources: batch.resources, stage: batch.stage, ...(entry.expectedTargets ? { expectedTargets: entry.expectedTargets } : {}) }, { docker, clerk }))) }; };
  const plan = await f.prepare(), task = { ...f.context.task, phase: "waiting", ownerPaused: false, finalizationVersion: 2, resources: f.resources }, prepared = adapterReceipt(task, plan.map(entry => ClientPlan.parse(entry))), before = JSON.stringify(f.resources);
  const registry = { task: async () => structuredClone(task), prepareFinalization: async () => { await assertPreservationSources(f.database, f.taskId, f.sessionId, plan); return structuredClone(prepared); }, resource: async (update: { key: string }) => { writes.push(update.key); throw new Error("Retained receipts cannot be rewritten"); } };
  const run = async () => { const result = await releasePreparedResources({ registry, prepared, assertAuthority: () => f.verify(plan), assertBatchAuthority: async () => { await assertPreservationSources(f.database, f.taskId, f.sessionId, plan); assertResourcePlan(task, prepared.resources); }, adapters: { observer: { docker, clerk } } }); return { ...result, incomplete: result.results.some((entry: { outcome: string }) => entry.outcome === "failed") }; };
  expect((await run()).incomplete).toBeTrue(); expect(objects.volume!.has(volume)).toBeTrue();
  const result = await run(); expect(result.incomplete, JSON.stringify(result)).toBeFalse(); await f.verify(plan, true);
  expect([...objects.volume!.keys()]).toEqual([volume]); expect(objects.container!.size + objects.network!.size).toBe(0); expect(writes).toHaveLength(0); expect(JSON.stringify(f.resources)).toBe(before);
  expect(effects).toEqual([`stop:${container}`, `remove:container:${container}`, `remove:network:${network}`, `remove:volume:${redis}`]);
  expect((await run()).incomplete).toBeFalse(); expect(effects).toHaveLength(4);
  const projection = { requestKey: prepared.requestKey, taskId: f.taskId, sessionId: f.sessionId, preparedRevision: prepared.preparedRevision, confirmedRevision: 30, resourcePlanDigest: prepared.resourcePlanDigest, resources: prepared.resources.filter(isRetainedPlan) };
  expect([...retainedReferenceIds({ ...task, phase: "closed", finalizationRetention: projection })].sort()).toEqual(f.resources.map(r => r.id).sort());
  f.instruction.text += " changed"; expect((await run()).incomplete).toBeTrue(); expect(effects).toHaveLength(4); expect(writes).toHaveLength(0);
}, 30_000);
