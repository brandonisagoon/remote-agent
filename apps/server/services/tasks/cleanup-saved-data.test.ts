import { afterEach, expect, test } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { savedDataFixture, sha } from "./cleanup-saved-data-fixture.ts";
import { prepareSavedData, assertSavedData, assertSavedDataCaptureSeparation } from "./cleanup-saved-data.ts";
import { SavedDataSelections } from "./cleanup-saved-data-schema.ts";
import { prepareFinalizationResources, assertFinalizationResources } from "./finalization-resources.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const f = await savedDataFixture(); roots.push(f.root); return { ...f, prepare: () => prepareSavedData({ task: f.task, resources: f.task.resources, selections: [f.selection] }) }; }
test("existing generic tooling directory retains exact complete manifest and original restore correspondence", async () => {
  const f = await fixture(), original = structuredClone(f.task.resources), plan = await f.prepare();
  expect(plan[0]!.kind).toBe("directory"); expect(plan[0]!.purpose).toBe("tooling"); expect(plan[0]!.archive.inventory).toEqual(f.inventory); expect(plan[0]!.archive.scratch).toHaveLength(1); expect(f.task.resources).toEqual(original);
  expect((await f.prepare())[0]).toEqual(plan[0]);
});
test("changed byte, missing member, new ancillary material and same-byte replacement fail frozen verification", async () => {
  for (const change of ["content", "missing", "extra", "replacement"] as const) {
    const f = await fixture(), plan = await f.prepare(), file = path.join(f.archive, "redis-cold.tar");
    if (change === "content") await writeFile(file, "changed");
    if (change === "missing") await rm(file);
    if (change === "extra") await writeFile(path.join(f.archive, "new"), "new", { mode: 0o600 });
    if (change === "replacement") { await rename(file, path.join(f.root, "old")); await writeFile(file, f.files.get("redis-cold.tar")!, { mode: 0o600 }); }
    if (change === "replacement") expect((await f.prepare())[0]!.archive.inventoryDigest).not.toBe(plan[0]!.archive.inventoryDigest);
    else await expect(f.prepare()).rejects.toThrow();
  }
});
test("selector must identify exact complete pairs and original task/pin/receipt manifest", async () => {
  const f = await fixture(); f.selection.scratchResourceIds.pop(); await expect(f.prepare()).rejects.toThrow("pair");
  f.selection.scratchResourceIds.push(f.volumeRecord.id); f.task.toolingRevision = "d".repeat(40); await expect(f.prepare()).rejects.toThrow("original task");
  expect(SavedDataSelections.safeParse([f.selection, f.selection]).success).toBeFalse();
});
test("original checkout and administration captures cannot absorb retained saved data", async () => {
  const f = await fixture(), saved = (await f.prepare())[0]!;
  expect(() => assertSavedDataCaptureSeparation([saved], [f.root])).toThrow("overlaps");
  expect(() => assertSavedDataCaptureSeparation([saved], [path.join(f.archive, "admin")])).toThrow("overlaps");
});
const clientRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!clientRoot)("actual server plan and client dispatcher retire scratch after verified backup, retry lost response and confirm retained Ready", async () => {
  const f = await fixture(), observer = await import(path.join(clientRoot!, "src/cleanup-observer.ts")), client = await import(path.join(clientRoot!, "src/finalization-resources.ts")), helper = await import(path.join(clientRoot!, "test/fixtures/prepared-adapter.ts"));
  const task = { id: f.task.id, primarySessionId: f.task.primarySessionId, worktreePath: f.task.worktreePath, toolingRevision: f.task.toolingRevision };
  const context = { task, capability: helper.fixtureCapability };
  const adapters = async ({ request }: any) => observer.observeCleanupBatch(request, { docker: f.docker });
  const observation: any = { adapters, endpointAbsent: async () => {}, rootIdle: async () => {}, browserAbsent: async () => {} };
  const plans = await prepareFinalizationResources({ taskId: f.task.id, sessionId: f.task.primarySessionId, resources: f.task.resources, toolingRoot: path.join(f.root, "tooling"), sourcePaths: [], deliveries: [], ownership: { ownedPaths: [], savedData: [f.selection] }, originalWork: true, adapterContext: context }, observation);
  const prepared = helper.adapterReceipt(f.task, plans), before = structuredClone(f.backup), writes: string[] = [];
  const registry = { task: async () => structuredClone(f.task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: any) => { writes.push(update.key); Object.assign(f.task.resources.find(r => r.key === update.key), update); } };
  let once = true; const remove = f.docker.remove;
  f.docker.remove = async (kind, id) => { await remove(kind, id); if (once) { once = false; throw new Error("lost applied removal"); } };
  const run = () => client.releasePreparedResources({ registry, prepared, assertAuthority: async () => {}, adapters: { observer: { docker: f.docker } } });
  expect((await run()).results.some((r: any) => r.outcome === "failed")).toBeTrue();
  expect((await run()).results.every((r: any) => ["released", "retained"].includes(r.outcome))).toBeTrue();
  await assertFinalizationResources({ taskId: f.task.id, resources: f.task.resources, plan: plans, removed: true, originalWork: true }, observation);
  expect(f.backup).toEqual(before); expect(f.effects).toHaveLength(3); expect(writes).not.toContain(f.backup.key); expect(await readFile(path.join(f.archive, "redis-cold.tar"))).toEqual(Buffer.from(f.files.get("redis-cold.tar")!));
  await assertSavedData({ resources: f.task.resources, plan: plans });
  await writeFile(path.join(f.archive, "redis-cold.tar"), "changed"); await expect(assertSavedData({ resources: f.task.resources, plan: plans })).rejects.toThrow();
}, 30000);

test("existing digest sidecar is separately observed and must describe the unchanged historical manifest", async () => {
  const f = await fixture(), sidecar = path.join(f.archive, "manifest-digest.json");
  const bytes = Buffer.from(JSON.stringify({ file: "manifest.json", sha256: f.selection.manifestSha256, bytes: f.files.get("manifest.json")!.length }));
  await writeFile(sidecar, bytes, { mode: 0o600 }); const plans = await f.prepare();
  expect(plans[0]!.archive.ancillary).toEqual([{ path: "manifest-digest.json", size: bytes.length, sha256: sha(bytes) }]);
  await writeFile(sidecar, JSON.stringify({ file: "manifest.json", sha256: "0".repeat(64), bytes: bytes.length }));
  await expect(f.prepare()).rejects.toThrow();
});
test.skipIf(!clientRoot)("saved-data drift at a later file-capture boundary preserves the original evidence", async () => {
  const f = await fixture(), observer = await import(path.join(clientRoot!, "src/cleanup-observer.ts")), client = await import(path.join(clientRoot!, "src/finalization-resources.ts")), helper = await import(path.join(clientRoot!, "test/fixtures/prepared-adapter.ts"));
  const file = path.join(f.root, "evidence.json"), content = "original evidence"; await writeFile(file, content, { mode: 0o600 });
  const resource = { id: "evidence", key: "evidence", kind: "evidence", purpose: "development", externalId: file, state: "ready", metadata: { sha256: sha(content), size: content.length } }; f.task.resources.push(resource);
  const task = { id: f.task.id, primarySessionId: f.task.primarySessionId, worktreePath: f.task.worktreePath, toolingRevision: f.task.toolingRevision };
  const observation: any = { adapters: async ({ request }: any) => observer.observeCleanupBatch(request, { docker: f.docker }), endpointAbsent: async () => {}, rootIdle: async () => {}, pathsIdle: async () => {}, browserAbsent: async () => {} };
  const plans = await prepareFinalizationResources({ taskId: f.task.id, sessionId: f.task.primarySessionId, resources: f.task.resources, toolingRoot: path.join(f.root, "tooling"), sourcePaths: [], deliveries: [], ownership: { ownedPaths: [file], savedData: [f.selection] }, originalWork: true, adapterContext: { task, capability: helper.fixtureCapability } }, observation);
  const prepared = helper.adapterReceipt(f.task, plans), registry = { task: async () => structuredClone(f.task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: any) => Object.assign(f.task.resources.find(r => r.key === update.key), update) };
  const result = await client.releasePreparedResources({ registry, prepared, assertAuthority: async () => {}, adapters: { observer: { docker: f.docker } }, observation, fileCaptureHooks: { beforeCapture: async () => writeFile(path.join(f.archive, "redis-cold.tar"), "changed") } });
  expect(result.results.find((r: any) => r.key === resource.key)?.outcome).toBe("failed"); expect(await readFile(file, "utf8")).toBe(content); expect(resource.state).toBe("ready"); expect(f.backup.state).toBe("ready");
});
