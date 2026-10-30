import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertRegisteredCaptureSharing } from "./cleanup-filesystem.ts";
import { assertFinalizationResources, finalizationDigest, prepareFinalizationResources, type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const quiet: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(kind = "evidence") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "standalone-capture-"))); roots.push(directory); await chmod(directory, 0o700);
  const file = path.join(directory, "saved-evidence.txt"); await writeFile(file, "original retained bytes\n", { mode: 0o600 });
  const resources: FinalizationResourceRecord[] = [{ id: "file", key: "capture", kind, purpose: "browser", externalId: file, state: "ready", metadata: { sha256: sha("original retained bytes\n"), bytes: 24 } }];
  const input = { resources, taskId: "task", sessionId: "primary", toolingRoot: path.join(directory, "immutable-tooling"), sourcePaths: [], deliveries: [], ownership: { ownedPaths: [file] }, originalWork: true };
  return { directory, file, resources, input, prepare: (observation = quiet) => prepareFinalizationResources(input, observation), verify: (plan: FinalizationResourcePlan[], removed = false, observation = quiet) => assertFinalizationResources({ taskId: "task", resources, plan, removed, originalWork: true }, observation) };
}
async function checkpoint() {
  const f = await fixture("source-checkpoint"), root = path.join(f.directory, "checkpoint"); await mkdir(root, { mode: 0o755 }); await chmod(root, 0o755);
  await mkdir(path.join(root, "original")); await writeFile(path.join(root, "original/source.ts"), "source bytes\n");
  await writeFile(path.join(root, "README.md"), "ancillary notes stay retained\n");
  const manifest = `${sha("source bytes\n")}  ./original/source.ts\n`; await writeFile(path.join(root, "MANIFEST.sha256"), manifest);
  f.resources[0]!.externalId = root; f.resources[0]!.metadata = { manifest: "MANIFEST.sha256", manifestSha256: sha(manifest) }; f.input.ownership.ownedPaths = [root];
  return { ...f, root, manifest };
}
function filePlan(plan: FinalizationResourcePlan[]) {
  const entry = plan.find(entry => entry.disposition === "retire-file"); if (!entry || entry.disposition !== "retire-file") throw new Error("Missing standalone file plan"); return entry;
}
async function capture(plan: FinalizationResourcePlan[], pending = false) {
  const entry = plan[0]!;
  if (entry.disposition !== "retire-file" && entry.disposition !== "retire-tree") throw new Error("Missing capture plan");
  const target = entry.target, source = target.type === "tree" ? target.inventory[0]! : target;
  await mkdir(target.quarantine.directory, { mode: 0o700 }); const stat = await lstat(target.quarantine.directory);
  await writeFile(target.quarantine.journal, JSON.stringify({ version: 1, taskId: "task", resourceId: entry.id, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path,
    source: { dev: source.dev, ino: source.ino, mode: source.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600, flag: "wx" });
  if (!pending) await rename(target.path, target.quarantine.path);
}

test.each(["evidence", "private-file", "scenario-fixture"])("standalone %s retains exact bytes through pending capture and replay", async kind => {
  const f = await fixture(kind), plan = await f.prepare(), entry = filePlan(plan);
  await f.verify(plan); await capture(plan, true); await f.verify(plan);
  await expect(f.verify(plan, true)).rejects.toThrow("still present");
  await rename(f.file, entry.target.quarantine.path); f.resources[0]!.state = "released";
  await f.verify(plan, true); await f.verify(plan, true);
  expect(await readFile(entry.target.quarantine.path, "utf8")).toBe("original retained bytes\n");
  expect((await lstat(entry.target.quarantine.path)).ino).toBe(entry.target.ino);
});
test("scenario digest map binds only the exact registered entrypoint and leaves other saved files intact", async () => {
  const f = await fixture("scenario-fixture"), wrapper = path.join(f.directory, "wrapper.sh"); await writeFile(wrapper, "retained supporting bytes\n", { mode: 0o600 });
  f.resources[0]!.metadata = { sha256: { [path.basename(f.file)]: sha("original retained bytes\n"), "wrapper.sh": sha("retained supporting bytes\n") } };
  const plan = await f.prepare(); expect(plan).toHaveLength(1); await capture(plan); f.resources[0]!.state = "released"; await f.verify(plan, true);
  expect(await readFile(wrapper, "utf8")).toBe("retained supporting bytes\n");
  const missing = await fixture("scenario-fixture"); missing.resources[0]!.metadata = { sha256: { "another.ts": sha("original retained bytes\n") } };
  await expect(missing.prepare()).rejects.toThrow("exact registered file");
});
test.each(["unselected", "hash", "size", "symlink", "hard-link", "shared-file", "shared-parent", "duplicate", "git", "directory", "protected"])("standalone %s refuses before capture", async change => {
  const f = await fixture();
  if (change === "unselected") f.input.ownership.ownedPaths = [];
  if (change === "hash") f.resources[0]!.metadata = { sha256: "a".repeat(64) };
  if (change === "size") f.resources[0]!.metadata = { bytes: 99 };
  if (change === "symlink") { await rename(f.file, path.join(f.directory, "original")); await symlink(path.join(f.directory, "original"), f.file); }
  if (change === "hard-link") await link(f.file, path.join(f.directory, "shared"));
  if (change === "shared-file") await chmod(f.file, 0o666);
  if (change === "shared-parent") await chmod(f.directory, 0o777);
  if (change === "duplicate") f.resources.push({ ...f.resources[0]!, id: "second", key: "second" });
  if (change === "git") await mkdir(path.join(f.directory, ".git"));
  if (change === "directory") { await rm(f.file); await mkdir(f.file); }
  if (change === "protected") f.input.toolingRoot = f.directory;
  await expect(f.prepare()).rejects.toThrow(); expect(f.resources[0]!.state).toBe("ready");
});
test.each(["captured-bytes", "captured-inode", "recreated", "missing", "wrong-journal"])("standalone capture refuses %s without deleting either generation", async change => {
  const f = await fixture(), plan = await f.prepare(), entry = filePlan(plan); await capture(plan);
  if (change === "captured-bytes") await writeFile(entry.target.quarantine.path, "changed\n");
  if (change === "captured-inode") { await rename(entry.target.quarantine.path, path.join(f.directory, "original-retained")); await writeFile(entry.target.quarantine.path, "original retained bytes\n", { mode: 0o600 }); }
  if (change === "recreated") await writeFile(f.file, "new owner material\n");
  if (change === "missing") await rename(entry.target.quarantine.path, path.join(f.directory, "original-retained"));
  if (change === "wrong-journal") { const journal = JSON.parse(await readFile(entry.target.quarantine.journal, "utf8")); journal.taskId = "another-task"; await writeFile(entry.target.quarantine.journal, JSON.stringify(journal)); }
  await expect(f.verify(plan)).rejects.toThrow();
  if (change === "recreated") expect(await readFile(f.file, "utf8")).toBe("new owner material\n");
  if (["captured-inode", "missing"].includes(change)) expect(await readFile(path.join(f.directory, "original-retained"), "utf8")).toBe("original retained bytes\n");
});
test("standalone batch observation is bounded and files are rechecked after it", async () => {
  const f = await fixture(), second = path.join(f.directory, "other.txt"); await writeFile(second, "other\n", { mode: 0o600 });
  f.resources.push({ ...f.resources[0]!, id: "second", key: "second", externalId: second, metadata: {} }); f.input.ownership.ownedPaths.push(second);
  const calls: string[][] = [], observation = { ...quiet, pathsIdle: async (files: string[]) => { calls.push(files); } };
  const plan = await f.prepare(observation); expect(calls).toEqual([[f.file, second]]);
  await f.verify(plan, false, observation); expect(calls).toHaveLength(2);
  await expect(f.prepare({ ...observation, pathsIdle: async () => { await writeFile(second, "changed during process snapshot"); } })).rejects.toThrow("changed during preparation");
});
test("standalone files participate in exact cross-task path claims", async () => {
  const f = await fixture(), plan = await f.prepare(); let query: unknown;
  await assertRegisteredCaptureSharing({ remoteTaskResource: { findFirst: async (input: unknown) => { query = input; return null; } } } as never, "task", plan);
  expect(JSON.stringify(query)).toContain(f.file); expect(JSON.stringify(query)).toContain(filePlan(plan).target.quarantine.directory);
  await expect(assertRegisteredCaptureSharing({ remoteTaskResource: { findFirst: async () => ({ id: "foreign" }) } } as never, "task", plan)).rejects.toThrow("another task");
});
test("checkpoint retains manifest-listed and ancillary bytes under a private quarantine", async () => {
  const f = await checkpoint(), plan = await f.prepare(), tree = plan[0]!;
  expect(tree.disposition).toBe("retire-tree"); if (tree.disposition !== "retire-tree" || tree.treeKind !== "source-checkpoint") throw new Error("Missing checkpoint plan");
  expect(tree.manifest.sha256).toBe(sha(f.manifest)); expect(tree.target.inventory.some(entry => entry.path === "README.md")).toBeTrue();
  await capture(plan); f.resources[0]!.state = "released"; await f.verify(plan, true); await f.verify(plan, true);
  expect(await readFile(path.join(tree.target.quarantine.path, "README.md"), "utf8")).toBe("ancillary notes stay retained\n");
  expect((await lstat(tree.target.quarantine.directory)).mode & 0o777).toBe(0o700);
});
test.each(["digest", "member", "traversal", "duplicate", "symlink", "shared", "git-ancestor"])("checkpoint refuses %s before capture", async change => {
  const f = await checkpoint(); let manifest = f.manifest;
  if (change === "digest") f.resources[0]!.metadata = { manifest: "MANIFEST.sha256", manifestSha256: "a".repeat(64) };
  if (change === "member") await writeFile(path.join(f.root, "original/source.ts"), "changed");
  if (change === "traversal") manifest = `${sha("source bytes\n")}  ../outside\n`;
  if (change === "duplicate") manifest += manifest;
  if (["traversal", "duplicate"].includes(change)) { await writeFile(path.join(f.root, "MANIFEST.sha256"), manifest); f.resources[0]!.metadata = { manifest: "MANIFEST.sha256", manifestSha256: sha(manifest) }; }
  if (change === "symlink") { await rm(path.join(f.root, "original/source.ts")); await symlink(f.file, path.join(f.root, "original/source.ts")); }
  if (change === "shared") await chmod(f.root, 0o777);
  if (change === "git-ancestor") await mkdir(path.join(f.directory, ".git"));
  await expect(f.prepare()).rejects.toThrow(); expect(await readFile(path.join(f.root, "README.md"), "utf8")).toBe("ancillary notes stay retained\n");
});
test("checkpoint writer observations cannot authorize a changed inventory", async () => {
  const f = await checkpoint();
  await expect(f.prepare({ ...quiet, rootIdle: async () => { throw new Error("active checkpoint writer"); } })).rejects.toThrow("active checkpoint writer");
  let calls = 0;
  await expect(f.prepare({ ...quiet, rootIdle: async () => { if (++calls === 2) await writeFile(path.join(f.root, "README.md"), "changed during inspection"); } })).rejects.toThrow();
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot)("actual native standalone capture retries its journal and preserves a last-window replacement", async () => {
  const { capturePreparedFile } = await import(path.join(draftedRoot!, "src/quarantine.ts"));
  const f = await fixture(), plan = await f.prepare(), entry = filePlan(plan), identity = { taskId: "task", resourceId: entry.id, planDigest: finalizationDigest(entry.target) };
  await expect(capturePreparedFile(entry.target, identity, { afterCapture: () => { throw new Error("lost response"); } })).rejects.toThrow("lost response");
  const journal = await readFile(entry.target.quarantine.journal); await f.verify(plan); await capturePreparedFile(entry.target, identity);
  f.resources[0]!.state = "released"; await f.verify(plan, true); expect(await readFile(entry.target.quarantine.journal)).toEqual(journal);
  const raced = await fixture(), racedPlan = await raced.prepare(), target = filePlan(racedPlan).target, retained = path.join(raced.directory, "original-kept");
  await expect(capturePreparedFile(target, { taskId: "task", resourceId: "file", planDigest: finalizationDigest(target) }, { beforeRename: async () => { await rename(raced.file, retained); await writeFile(raced.file, "new owner bytes"); } })).rejects.toThrow("Captured source identity changed");
  await expect(raced.verify(racedPlan)).rejects.toThrow();
  expect(await readFile(retained, "utf8")).toBe("original retained bytes\n"); expect(await readFile(target.quarantine.path, "utf8")).toBe("new owner bytes");
});
