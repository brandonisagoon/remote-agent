import { expect, test } from "bun:test";
import path from "node:path";
import { CleanupObserverBatchInput, CleanupTarget, cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { hasHistoricalCleanupAdapter } from "./cleanup-adapter-resources.ts";
import { assertFinalizationResources, finalizationResourceIdentity, prepareFinalizationResources, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

type Shape = "development-fixture" | "review-fixture" | "old-object" | "r2-objects" | "bucket";
function fixture(shape: Shape = "development-fixture") {
  const taskId = "original-task", purpose = shape === "review-fixture" ? "review" : "development";
  const project = shape.endsWith("fixture") ? `drafted-${taskId}${purpose === "review" ? "-review" : ""}` : `drafted-${taskId}-${purpose}`;
  const volume = `${project}-${shape.endsWith("fixture") ? "redis" : "objects"}`;
  const backing: FinalizationResourceRecord = { id: "store", key: "development-compose", kind: "docker-compose-project", purpose, externalId: project, state: shape === "old-object" ? "released" : "ready", metadata: { volumes: [volume] } };
  if (shape === "old-object") backing.metadata = { configPath: "/private/original/compose.yml", containers: {}, volumes: { [volume]: { createdAt: "recorded" } } };
  if (shape === "r2-objects") { backing.kind = "task-runtime"; backing.key = "runtime-development"; backing.externalId = "/private/runtime.json"; backing.metadata = { recipeHash: "b".repeat(64), providers: [{ provider: "storage", id: "drafted-task-bucket", name: "drafted-task-bucket", released: true }] }; }
  const record: FinalizationResourceRecord = shape.endsWith("fixture") ? { id: "logical", key: "saved-fixture", kind: "fixture", purpose, externalId: "rubin-chats", state: "ready", metadata: {
    owner: "user_Shared (existing synthetic pilot identity; no new Clerk user, no metadata changes)", chats: ["8a000000-0000-4000-8000-000000000001", "8a000000-0000-4000-8000-000000000002", "8a000000-0000-4000-8000-000000000003"], store: purpose === "development" ? "task Redis only" : "review Redis only" } }
    : shape === "r2-objects" ? { id: "logical", key: "saved-objects", kind: "s3-object", purpose, externalId: "drafted-task-bucket/fixture/", state: "ready", metadata: { bucket: "drafted-task-bucket (task R2)", objects: [{ key: "fixture/image.png", sha256: "a".repeat(64) }, { key: "fixture/result.json", sha256: "b".repeat(64) }] } }
    : { id: "logical", key: "saved-bucket", kind: shape === "bucket" ? "s3-bucket" : "s3-object", purpose, externalId: shape === "bucket" ? "drafted-dra98" : "drafted-dra98/probe.txt", state: "ready", metadata: { bucket: "drafted-dra98", key: "probe.txt", volume, ownerReceipt: "development-compose (store)", content: "old synthetic note, not a retained file" } };
  const raw = shape === "r2-objects" ? { kind: "r2-bucket", id: "drafted-task-bucket", name: "drafted-task-bucket", createdAt: "recorded", scope: { taskId, purpose, accountId: "a".repeat(32), runtimeFile: "/private/runtime.json", credentialsFile: "/private/credentials.json", recipeHash: "b".repeat(64) } }
    : { kind: "docker-volume", id: volume, identity: shape === "old-object" ? null : { createdAt: "recorded", labelsDigest: "c".repeat(64) }, scope: { taskId, purpose, project } };
  const target = CleanupTarget.parse({ ...raw, presentAtPrepare: shape !== "old-object", identityDigest: "0".repeat(64) }); target.identityDigest = cleanupTargetDigest(target);
  const other = CleanupTarget.parse({ kind: "docker-volume", id: `${project}-unrelated`, scope: { taskId, purpose, project }, identity: { createdAt: "other", labelsDigest: "d".repeat(64) }, presentAtPrepare: true, identityDigest: "0".repeat(64) }); other.identityDigest = cleanupTargetDigest(other);
  const targets = shape === "old-object" ? [target] : [target, other], present = new Set(targets.filter(target => target.presentAtPrepare).map(target => target.identityDigest)), resources = [backing, record];
  const observation: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {}, adapters: async ({ request }) => {
    const batch = CleanupObserverBatchInput.parse(request);
    return { version: 1, taskId, observations: batch.observations.map(entry => ({ version: 1, taskId, resourceId: entry.resourceId, resourceIdentityDigest: finalizationResourceIdentity(backing).identityDigest,
      adapter: shape === "r2-objects" ? "runtime" : "compose", dependencies: [], stoppedConsumers: [], targets: entry.expectedTargets ?? targets, absent: present.size === 0, presentTargetDigests: [...present] })) };
  } };
  const context = { task: { id: taskId, primarySessionId: "primary", worktreePath: "/private/product", toolingRevision: "a".repeat(40) }, capability: { version: 1 as const, source: "configured-host" as const, checkout: "/private/tooling", revision: "b".repeat(40), adapter: "/private/tooling/src/cli.ts", adapterSha256: "c".repeat(64) } };
  const prepare = () => prepareFinalizationResources({ taskId, sessionId: "primary", resources, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [] }, originalWork: true, toolingRoot: "/private/old-tooling", adapterContext: context }, observation);
  const verify = (plan: Awaited<ReturnType<typeof prepare>>, removed = false) => assertFinalizationResources({ taskId, resources, plan, originalWork: true, removed }, observation);
  return { taskId, resources, record, backing, targets, target, other, present, observation, context, prepare, verify };
}

test.each<Shape>(["development-fixture", "review-fixture", "old-object", "r2-objects", "bucket"])("exact %s correspondence grants no new effect or retained-copy claim", async shape => {
  const f = fixture(shape), plan = await f.prepare(), logical = plan.find(entry => entry.disposition === "retire-backed")!;
  if (logical.disposition !== "retire-backed") throw new Error("Missing backing plan");
  expect(logical.storage).toEqual({ resourceId: "store", targetDigests: [f.target.identityDigest] });
  expect("dependencies" in logical).toBeFalse(); expect("archive" in logical).toBeFalse(); await f.verify(plan);
  if (logical.members.kind === "redis-chats") { expect(logical.members.preservedUserId).toBe("user_Shared"); expect(logical.members.chatIds).toHaveLength(3); }
  if (shape === "old-object" && logical.members.kind === "s3-objects") expect(logical.members.objects).toEqual([{ key: "probe.txt", sha256: null }]);
  if (shape === "r2-objects" && logical.members.kind === "s3-objects") expect(logical.members.objects).toHaveLength(2);
});
test("a selected store can be absent while an unrelated target and its backing receipt remain present", async () => {
  const f = fixture(), plan = await f.prepare(); f.record.state = "released";
  await expect(f.verify(plan)).rejects.toThrow("present backing");
  f.present.delete(f.target.identityDigest); await f.verify(plan); expect(f.backing.state).toBe("ready"); expect(f.present.has(f.other.identityDigest)).toBeTrue();
  await expect(f.verify(plan, true)).rejects.toThrow();
  f.present.clear(); f.backing.state = "released"; await f.verify(plan, true); await f.verify(plan, true);
});
test.each(["project", "volume", "declared-volume", "purpose", "target-task", "ambiguous", "member", "owner", "store", "duplicate-chat"])("invalid %s fixture correspondence refuses preparation", async changed => {
  const f = fixture(), meta = f.record.metadata as Record<string, unknown>;
  if (changed === "project") f.backing.externalId = "another-project";
  if (changed === "volume") f.target.id = "another-volume";
  if (changed === "declared-volume") f.backing.metadata = { volumes: ["another"] };
  if (changed === "purpose") f.backing.purpose = "review";
  if (changed === "target-task") f.target.scope.taskId = "another-task";
  if (changed === "ambiguous") f.resources.push({ ...f.backing, id: "duplicate", key: "duplicate" });
  if (changed === "member") (meta.chats as string[])[0] = "not-a-chat-id";
  if (changed === "owner") meta.owner = "unscoped user prose";
  if (changed === "store") meta.store = "shared Redis";
  if (changed === "duplicate-chat") (meta.chats as string[])[1] = (meta.chats as string[])[0]!;
  await expect(f.prepare()).rejects.toThrow();
});
test.each(["owner-key", "owner-id", "key", "bucket", "objects", "duplicate-object", "prefix"])("invalid %s object correspondence refuses preparation", async changed => {
  const f = fixture(["objects", "duplicate-object", "prefix"].includes(changed) ? "r2-objects" : "old-object"), meta = f.record.metadata as Record<string, unknown>;
  if (changed === "owner-key") meta.ownerReceipt = "other (store)";
  if (changed === "owner-id") meta.ownerReceipt = "development-compose (other)";
  if (changed === "key") meta.key = "other.txt";
  if (changed === "bucket") meta.bucket = "drafted-dra42";
  if (changed === "objects") meta.objects = [{ key: "fixture/a", sha256: "invented" }];
  if (changed === "duplicate-object") meta.objects = [{ key: "fixture/a", sha256: "a".repeat(64) }, { key: "fixture/a", sha256: "b".repeat(64) }];
  if (changed === "prefix") f.record.externalId = "drafted-task-bucket/another/";
  await expect(f.prepare()).rejects.toThrow();
});
test("released logical history cannot hide a recreated or differently scoped backing target", async () => {
  const f = fixture("r2-objects"), plan = await f.prepare(); f.present.clear(); f.record.state = "released"; await f.verify(plan);
  f.present.add(f.target.identityDigest); await expect(f.verify(plan)).rejects.toThrow("present backing"); f.present.clear();
  const logical = plan.find(entry => entry.disposition === "retire-backed")!; if (logical.disposition !== "retire-backed") throw new Error("Missing plan");
  logical.storage.targetDigests = [f.other.identityDigest]; await expect(f.verify(plan)).rejects.toThrow("correspondence changed");
});
test("no independent observation can be replaced by a released backing receipt", async () => {
  const f = fixture("old-object"), plan = await f.prepare(); f.record.state = "released";
  f.observation.adapters = async () => { throw new Error("provider unavailable"); };
  await expect(f.verify(plan, true)).rejects.toThrow("provider unavailable");
});

test("an unresolved object can reuse its exact released runtime only after independent absence", async () => {
  const f = fixture("r2-objects"); f.backing.state = "released";
  const before = JSON.stringify(f.resources);
  await expect(f.prepare()).rejects.toThrow("Historical released adapter is still present");
  for (const target of f.targets) { target.presentAtPrepare = false; if ("identity" in target) target.identity = null; target.identityDigest = cleanupTargetDigest(target); }
  f.present.clear();
  const plan = await f.prepare();
  expect(plan.find(entry => entry.id === f.backing.id)).toMatchObject({ disposition: "retire-adapter", adapter: "runtime" });
  expect(plan.find(entry => entry.id === f.record.id)).toMatchObject({ disposition: "retire-backed", storage: { resourceId: f.backing.id, targetDigests: [f.target.identityDigest] } });
  await f.verify(plan); expect(JSON.stringify(f.resources)).toBe(before);
  f.present.add(f.target.identityDigest); await expect(f.verify(plan)).rejects.toThrow(); f.present.clear();
  f.observation.adapters = async () => { throw new Error("provider unavailable"); };
  await expect(f.prepare()).rejects.toThrow("provider unavailable");
});

test("released runtime history is observed only for its unresolved same-purpose bucket receipt", () => {
  const f = fixture("r2-objects"); f.backing.state = "released";
  expect(hasHistoricalCleanupAdapter(f.backing)).toBeFalse();
  expect(hasHistoricalCleanupAdapter(f.backing, f.resources)).toBeTrue();
  f.record.state = "released"; expect(hasHistoricalCleanupAdapter(f.backing, f.resources)).toBeFalse();
  f.record.state = "ready"; f.record.purpose = "review"; expect(hasHistoricalCleanupAdapter(f.backing, f.resources)).toBeFalse();
  f.record.purpose = "development"; (f.record.metadata as Record<string, unknown>).bucket = "drafted-another (task R2)";
  expect(hasHistoricalCleanupAdapter(f.backing, f.resources)).toBeFalse();
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot)("actual runtime observer and client settle old objects after the original bucket was deleted", async () => {
  const { mkdtemp, realpath, readFile, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os");
  const { RuntimeConfig, RuntimeReceipt, digest, savePrivate } = await import(path.join(draftedRoot!, "src/runtime-config.ts"));
  const { observeCleanupBatch } = await import(path.join(draftedRoot!, "src/cleanup-observer.ts"));
  const { releasePreparedBackedResources } = await import(path.join(draftedRoot!, "src/prepared-backed.ts"));
  const { FinalizationResourcePlan: ClientPlan, assertResourcePlan } = await import(path.join(draftedRoot!, "src/finalization-plan.ts"));
  const { adapterReceipt } = await import(path.join(draftedRoot!, "test/fixtures/prepared-adapter.ts"));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "released-runtime-backing-"))), f = fixture("r2-objects");
  try {
    const credentialsFile = path.join(root, "credentials.json"); await savePrivate(credentialsFile, { PRIVATE: "synthetic-not-output" });
    const recipe = RuntimeConfig.parse({ version: 1, profile: "platform", image: "fixture", credentialsFile,
      planetscale: { organization: "org", database: "db", baseBranch: "main", baseBranchId: "baseline" }, storage: { accountId: "a".repeat(32) },
      services: { api: { command: ["bun", "index.ts"], port: 8080 } }, checks: [{ service: "api", path: "/", representative: true }] });
    const file = path.join(root, "runtimes", f.taskId, "development", "runtime.json");
    const state = RuntimeReceipt.parse({ version: 1, taskId: f.taskId, worktree: f.context.task.worktreePath, revision: "b".repeat(40), purpose: "development",
      recipeHash: digest(recipe), recipe, phase: "released", resources: [
        { provider: "planetscale", id: "original-branch", name: "original-name", released: true },
        { provider: "storage", id: "drafted-task-bucket", name: "drafted-task-bucket", createdAt: "2026-10-28T00:00:00.000Z", released: true },
      ] });
    await savePrivate(file, state);
    f.backing.externalId = file; f.backing.state = "released"; f.backing.metadata = { recipeHash: state.recipeHash, providers: state.resources };
    const bytes = await readFile(file), original = JSON.stringify(f.backing), calls: string[] = []; let present = false, unavailable = false;
    const services = { docker: { inspect: async () => { throw new Error("No Docker target was recorded"); } }, providers: () => ({ inspect: async (resource: { id: string }) => {
      expect(state.resources.some((saved: { id: string }) => saved.id === resource.id)).toBeTrue(); calls.push(resource.id);
      if (unavailable) throw new Error("Provider unavailable"); return present;
    } }) };
    f.observation.adapters = async ({ request }) => observeCleanupBatch(request, services);
    const plan = await f.prepare(); await f.verify(plan);
    expect(plan.find(entry => entry.id === f.backing.id)).toMatchObject({ disposition: "retire-adapter", adapter: "runtime" });
    const task = { ...f.context.task, phase: "complete", finalizationVersion: 2, ownerPaused: false, resources: f.resources };
    const prepared = adapterReceipt(task, plan.map(entry => ClientPlan.parse(entry))), writes: string[] = []; let lost = true;
    const registry = { task: async () => structuredClone(task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: { key: string; state: string }) => {
      expect(update.key).toBe(f.record.key); writes.push(update.key); Object.assign(f.record, update); await f.verify(plan);
      if (lost) { lost = false; throw new Error("Lost receipt acknowledgement"); }
    } };
    const run = () => releasePreparedBackedResources({ registry, prepared, assertAuthority: () => f.verify(plan),
      assertBatchAuthority: async () => { assertResourcePlan(task, prepared.resources); }, adapters: { observer: services } });
    expect((await run()).incomplete).toBeTrue(); expect(f.record.state).toBe("released");
    expect((await run()).incomplete).toBeFalse(); expect(writes).toEqual([f.record.key]); await f.verify(plan, true);
    expect(calls).toContain("original-branch"); expect(calls).toContain("drafted-task-bucket");
    expect(JSON.stringify(f.backing)).toBe(original); expect(await readFile(file)).toEqual(bytes);
    present = true; expect((await run()).incomplete).toBeTrue(); await expect(f.verify(plan, true)).rejects.toThrow();
    present = false; unavailable = true; expect((await run()).incomplete).toBeTrue(); expect(writes).toHaveLength(1);
    expect(JSON.stringify(plan)).not.toContain("synthetic-not-output");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(!draftedRoot).each<Shape>(["development-fixture", "review-fixture", "old-object"])("actual client retires only the %s logical receipt and reconciles a lost write acknowledgment", async shape => {
  const f = fixture(shape), plan = await f.prepare(); f.present.delete(f.target.identityDigest);
  const { releasePreparedBackedResources } = await import(path.join(draftedRoot!, "src/prepared-backed.ts"));
  const { FinalizationResourcePlan: ClientPlan, assertResourcePlan } = await import(path.join(draftedRoot!, "src/finalization-plan.ts"));
  const { adapterReceipt } = await import(path.join(draftedRoot!, "test/fixtures/prepared-adapter.ts"));
  const task = { ...f.context.task, phase: "waiting", finalizationVersion: 2, ownerPaused: false, resources: f.resources }, prepared = adapterReceipt(task, plan.map(entry => ClientPlan.parse(entry))), writes: string[] = [], inspected: string[] = [];
  let lost = true, pause = false;
  const registry = { task: async () => structuredClone(task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: { key: string; state: string }) => {
    writes.push(update.key); Object.assign(f.resources.find(resource => resource.key === update.key)!, update); await f.verify(plan);
    if (lost) { lost = false; throw new Error("lost registry write acknowledgment"); }
  } };
  const docker = { inspect: async (kind: string, id: string) => { expect(kind).toBe("volume"); expect(id).toBe(f.target.id); inspected.push(id); if (pause) task.ownerPaused = true; return null; } };
  const run = () => releasePreparedBackedResources({ registry, prepared, assertAuthority: () => f.verify(plan), assertBatchAuthority: async () => { assertResourcePlan(task, prepared.resources); }, adapters: { observer: { docker } } });
  const before = JSON.stringify(f.backing), first = await run(); expect(first.incomplete).toBeTrue(); expect(writes).toEqual([f.record.key]); await f.verify(plan);
  expect((await run()).incomplete).toBeFalse(); expect(writes).toHaveLength(1); expect(JSON.stringify(f.backing)).toBe(before); expect(inspected.length).toBeGreaterThan(1);
  expect(f.record.state).toBe("released"); expect(f.present.has(f.other.identityDigest)).toBe(shape !== "old-object");
  pause = true; expect((await run()).incomplete).toBeTrue(); expect(writes).toHaveLength(1);
}, 30_000);
