import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertFinalizationResources, inspectFinalizationQuarantine, finalizationDigest, prepareFinalizationResources, type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
import { assertRegisteredCaptureSharing } from "./cleanup-filesystem.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const quiet: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
  if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim();
}
async function fixture(detached = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "linked-capture-"))); roots.push(directory); await chmod(directory, 0o700);
  const repository = path.join(directory, "repository"), worktree = path.join(directory, "review"); await mkdir(repository);
  git(repository, ["init", "-q"]); git(repository, ["config", "user.name", "Fixture"]); git(repository, ["config", "user.email", "fixture@example.test"]);
  await writeFile(path.join(repository, "package.json"), '{"name":"fixture"}\n'); await writeFile(path.join(repository, "bun.lock"), "fixture-lock\n");
  await writeFile(path.join(repository, ".gitignore"), "node_modules/\nprivate-cache/\n"); await writeFile(path.join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["add", "."]); git(repository, ["commit", "-qm", "fixture"]);
  git(repository, ["worktree", "add", ...(detached ? ["--detach"] : ["-b", "codex/review"]), worktree]);
  const dependency = path.join(worktree, "node_modules"), ignored = path.join(worktree, "private-cache");
  await mkdir(dependency); await writeFile(path.join(dependency, "installed.js"), "installed bytes remain retained\n");
  await mkdir(ignored); await writeFile(path.join(ignored, "never-disposable"), "private ignored material\n");
  const resources: FinalizationResourceRecord[] = [{ id: "review", key: "review-checkout", kind: "git-worktree", purpose: "review", externalId: worktree, state: "ready", metadata: { original: true } }];
  const input = { resources, taskId: "task", sessionId: "primary", toolingRoot: path.join(directory, "tooling"), sourcePaths: [], deliveries: [], ownership: { ownedPaths: [worktree] }, originalWork: true };
  const prepare = (observation = quiet) => prepareFinalizationResources(input, observation);
  const verify = (plan: FinalizationResourcePlan[], removed = false, observation = quiet) => assertFinalizationResources({ taskId: "task", resources, plan, removed, originalWork: true }, observation);
  return { directory, repository, worktree, dependency, ignored, resources, input, prepare, verify };
}
function selected(plan: FinalizationResourcePlan[]) {
  const entry = plan.find(entry => entry.disposition === "retire-worktree");
  if (!entry || entry.disposition !== "retire-worktree") throw new Error("Missing linked plan"); return entry;
}
async function capture(plan: FinalizationResourcePlan[], administration = false) {
  const entry = selected(plan), target = administration ? entry.administrationCapture : entry.target, source = target.inventory[0]!;
  await mkdir(target.quarantine.directory, { mode: 0o700 }); const stat = await lstat(target.quarantine.directory);
  await writeFile(target.quarantine.journal, JSON.stringify({ version: 1, taskId: "task", resourceId: entry.id, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path,
    source: { dev: source.dev, ino: source.ino, mode: source.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600, flag: "wx" });
  await rename(target.path, target.quarantine.path);
}

test.each([false, true])("linked worktree keeps exact registration and retained index (detached=%s)", async detached => {
  const f = await fixture(detached), plan = await f.prepare(), entry = selected(plan), index = await readFile(entry.git.index.path);
  expect(entry.git.branch).toBe(detached ? null : "codex/review");
  expect(entry.installedDependencies).toHaveLength(1);
  expect(entry.target.inventory.find(file => file.path === "node_modules")?.kind).toBe("opaque");
  expect(entry.target.inventory.some(file => file.path === "node_modules/installed.js")).toBeFalse();
  expect(entry.target.inventory.find(file => file.path === "private-cache/never-disposable")?.kind).toBe("file");
  await f.verify(plan); await capture(plan); await f.verify(plan);
  await expect(f.verify(plan, true)).rejects.toThrow("no verified administration capture");
  await capture(plan, true); f.resources[0]!.state = "released";
  expect(git(f.repository, ["worktree", "list", "--porcelain"])).not.toContain(f.worktree);
  await f.verify(plan, true); await f.verify(plan, true);
  expect(await readFile(path.join(entry.administrationCapture.quarantine.path, "index"))).toEqual(index);
  for (const item of entry.git.administrativeInventory.filter(item => item.kind === "file")) expect((await readFile(path.join(entry.administrationCapture.quarantine.path, item.path))).length).toBe(item.kind === "file" ? item.size : 0);
  expect(await readFile(path.join(entry.target.quarantine.path, "node_modules/installed.js"), "utf8")).toBe("installed bytes remain retained\n");
  expect(await readFile(path.join(entry.target.quarantine.path, "private-cache/never-disposable"), "utf8")).toBe("private ignored material\n");
  if (!detached) expect(git(f.repository, ["rev-parse", "codex/review"])).toBe(entry.git.head);
});

test.each(["dirty", "split-index", "unselected", "missing-lock", "shared-root"])("linked preparation refuses %s", async change => {
  const f = await fixture();
  if (change === "dirty") await writeFile(path.join(f.worktree, "source.ts"), "changed\n");
  if (change === "split-index") git(f.worktree, ["update-index", "--split-index"]);
  if (change === "unselected") f.input.ownership.ownedPaths = [];
  if (change === "missing-lock") { git(f.worktree, ["rm", "bun.lock"]); git(f.worktree, ["commit", "-qm", "no lock"]); }
  if (change === "shared-root") await chmod(f.worktree, 0o777);
  await expect(f.prepare()).rejects.toThrow();
  expect(await readFile(path.join(f.dependency, "installed.js"), "utf8")).toBe("installed bytes remain retained\n");
});

test("a tracked node_modules path is fully hashed, never classified as an opaque install", async () => {
  const f = await fixture(); git(f.worktree, ["add", "-f", "node_modules/installed.js"]); git(f.worktree, ["commit", "-qm", "tracked source"]);
  const plan = await f.prepare(), entry = selected(plan);
  expect(entry.installedDependencies).toHaveLength(0);
  expect(entry.target.inventory.find(file => file.path === "node_modules/installed.js")?.kind).toBe("file");
  await writeFile(path.join(f.dependency, "installed.js"), "changed tracked source\n");
  await expect(f.verify(plan)).rejects.toThrow();
});

test.each(["dependency", "index", "ignored-file", "package"])("prepared linked worktree refuses changed %s", async change => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan);
  if (change === "dependency") { await rename(f.dependency, path.join(f.worktree, "old-dependencies")); await mkdir(f.dependency); }
  if (change === "index") { const bytes = await readFile(entry.git.index.path); await rename(entry.git.index.path, path.join(f.directory, "original-index")); await writeFile(entry.git.index.path, bytes); expect((await lstat(entry.git.index.path)).ino).not.toBe(entry.git.index.ino); }
  if (change === "ignored-file") await writeFile(path.join(f.ignored, "never-disposable"), "changed bytes\n");
  if (change === "package") await writeFile(path.join(f.worktree, "package.json"), '{"name":"changed"}\n');
  await expect(f.verify(plan)).rejects.toThrow();
});

test("complete native administration capture is required before retirement acknowledgment", async () => {
  const f = await fixture(), plan = await f.prepare(); await capture(plan);
  await f.verify(plan); await expect(f.verify(plan, true)).rejects.toThrow("no verified administration capture");
  expect(git(f.repository, ["worktree", "list", "--porcelain"])).toContain(f.worktree);
  await capture(plan, true); const entry = selected(plan);
  await writeFile(path.join(entry.administrationCapture.quarantine.path, "index"), "wrong index", { mode: 0o600 });
  await expect(f.verify(plan)).rejects.toThrow();
});

test("active writers prevent linked capture preparation and confirmation", async () => {
  const f = await fixture(); let running = true;
  const observation = { ...quiet, rootIdle: async () => { if (running) throw new Error("active writer"); } };
  await expect(f.prepare(observation)).rejects.toThrow("active writer"); running = false;
  const plan = await f.prepare(observation); await capture(plan); running = true;
  await expect(f.verify(plan, false, observation)).rejects.toThrow("active writer");
});


test.each(["reflog", "missing", "new", "symlink"])("captured Git administration refuses %s substitution", async change => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); await capture(plan); await capture(plan, true);
  const file = path.join(entry.administrationCapture.quarantine.path, "logs/HEAD");
  const index = await readFile(path.join(entry.administrationCapture.quarantine.path, "index"));
  if (change === "reflog") await writeFile(file, "different history");
  if (change === "missing") await rm(file);
  if (change === "new") await writeFile(path.join(entry.administrationCapture.quarantine.path, "unrecorded"), "extra", { mode: 0o600 });
  if (change === "symlink") { await rename(file, path.join(f.directory, "saved-reflog")); await symlink(path.join(f.directory, "saved-reflog"), file); }
  await expect(f.verify(plan)).rejects.toThrow();
  expect(await readFile(path.join(entry.administrationCapture.quarantine.path, "index"))).toEqual(index);
});

test("changes to original Git administration after capture prevent unregister acknowledgment", async () => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); await capture(plan);
  await writeFile(path.join(entry.git.administrativeDirectory, "logs/HEAD"), "new history");
  await expect(f.verify(plan)).rejects.toThrow();
  expect(await readFile(path.join(entry.git.administrativeDirectory, "logs/HEAD"), "utf8")).toBe("new history");
});


test("linked retention protects the whole saved administration from other task claims", async () => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); let query: unknown;
  const database = { remoteTaskResource: { findFirst: async (input: unknown) => { query = input; return null; } } };
  await assertRegisteredCaptureSharing(database as never, "task", plan);
  expect(JSON.stringify(query)).toContain(entry.administrationCapture.quarantine.directory);
  expect(JSON.stringify(query)).toContain(entry.administrationCapture.path);
  const foreign = { remoteTaskResource: { findFirst: async () => ({ id: "another-task-admin-claim" }) } };
  await expect(assertRegisteredCaptureSharing(foreign as never, "task", plan)).rejects.toThrow("another task");
});


test.each(["checkout", "administration"])("a recreated %s is preserved and blocks acknowledgment", async change => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); await capture(plan); await capture(plan, true);
  const root = change === "checkout" ? f.worktree : entry.git.administrativeDirectory;
  await mkdir(root); await writeFile(path.join(root, "owner-save"), "new uncaptured material");
  await expect(f.verify(plan)).rejects.toThrow("recreated");
  expect(await readFile(path.join(root, "owner-save"), "utf8")).toBe("new uncaptured material");
  expect(await readFile(path.join(entry.administrationCapture.quarantine.path, "index"))).not.toBeEmpty();
});

test("administration capture before source capture cannot become a valid retirement", async () => {
  const f = await fixture(), plan = await f.prepare(); await capture(plan, true);
  await expect(f.verify(plan)).rejects.toThrow("before its source capture");
  expect(await readFile(path.join(f.worktree, "source.ts"), "utf8")).toBe("export const value = 1;\n");
});

test("changed destination parent identity blocks administration acknowledgment", async () => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); await capture(plan);
  const changed = structuredClone(plan), target = selected(changed).administrationCapture; target.quarantineParent.ino++;
  await expect(f.verify(changed)).rejects.toThrow("parent identity changed");
  expect(await readFile(entry.git.index.path)).not.toBeEmpty();
});


test("only linked administration permits a bound owned 0755 parent; legacy external capture stays private", async () => {
  const f = await fixture(); await chmod(f.directory, 0o755); const plan = await f.prepare(), entry = selected(plan);
  await f.verify(plan);
  await expect(inspectFinalizationQuarantine({ taskId: "task", resourceId: entry.id, target: entry.administrationCapture, sourceParent: entry.administrationCapture.sourceParent, quarantineParent: entry.administrationCapture.quarantineParent })).rejects.toThrow("parent identity changed");
  await capture(plan); await capture(plan, true); f.resources[0]!.state = "released"; await f.verify(plan, true);
  expect((await lstat(entry.administrationCapture.quarantine.directory)).mode & 0o777).toBe(0o700);
});

test("cross-filesystem administration proof refuses before either source changes", async () => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); entry.administrationCapture.quarantineParent.dev++;
  await expect(f.verify(plan)).rejects.toThrow("capture scope changed");
  expect(await readFile(path.join(f.worktree, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  expect(await readFile(entry.git.index.path)).not.toBeEmpty();
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot).each(["capture", "administration"] as const)("actual prepared client retains linked source and administration across lost %s acknowledgment", async stage => {
  const f = await fixture(stage === "administration"), plan = await f.prepare(), entry = selected(plan);
  const frozen = JSON.stringify(plan), branchRefs = git(f.repository, ["show-ref"]);
  const administration = new Map(await Promise.all(entry.git.administrativeInventory.filter(item => item.kind === "file").map(async item => [item.path, await readFile(path.join(entry.git.administrativeDirectory, item.path))] as const)));
  const { releasePreparedResources } = await import(path.join(draftedRoot!, "src/finalization-resources.ts"));
  const { assertResourcePlan, FinalizationResourcePlan: ClientPlan } = await import(path.join(draftedRoot!, "src/finalization-plan.ts"));
  const { adapterReceipt } = await import(path.join(draftedRoot!, "test/fixtures/prepared-adapter.ts"));
  const task = { id: "task", primarySessionId: "primary", worktreePath: path.join(f.directory, "original-worktree"), toolingRevision: "a".repeat(40), phase: "waiting", finalizationVersion: 2, resources: f.resources };
  const prepared = adapterReceipt(task, plan.map(item => ClientPlan.parse(item))), writes: string[] = [];
  const registry = { task: async () => structuredClone(task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: { key: string; state: string }) => {
    writes.push(update.key); Object.assign(f.resources.find(resource => resource.key === update.key)!, update); await f.verify(plan);
  } };
  let once = true;
  const run = () => releasePreparedResources({ registry, prepared, observation: quiet, assertAuthority: () => f.verify(plan),
    assertBatchAuthority: async () => { assertResourcePlan(task, prepared.resources); }, linkedWorktreeHooks: { [stage]: { afterCapture: () => { if (once) { once = false; throw new Error("lost linked capture acknowledgment"); } } } } });
  const partial = await run();
  expect(partial.results).toEqual([{ key: "review-checkout", outcome: "failed", detail: "lost linked capture acknowledgment" }]);
  expect(writes).toEqual([]); await f.verify(plan);
  const captured = await lstat(entry.target.quarantine.path), journal = await readFile(entry.target.quarantine.journal);
  const adminJournal = stage === "administration" ? await readFile(entry.administrationCapture.quarantine.journal) : null;
  const retried = await run();
  expect(retried.results).toEqual([{ key: "review-checkout", outcome: "retired-to-recoverable-quarantine" }]);
  await f.verify(plan, true); await run(); await f.verify(plan, true);
  expect(writes).toEqual(["review-checkout"]); expect(JSON.stringify(plan)).toBe(frozen);
  expect((await lstat(entry.target.quarantine.path)).ino).toBe(captured.ino);
  expect(await readFile(entry.target.quarantine.journal)).toEqual(journal);
  if (adminJournal) expect(await readFile(entry.administrationCapture.quarantine.journal)).toEqual(adminJournal);
  for (const [relative, bytes] of administration) expect(await readFile(path.join(entry.administrationCapture.quarantine.path, relative))).toEqual(bytes);
  expect(await readFile(path.join(entry.target.quarantine.path, "node_modules/installed.js"), "utf8")).toBe("installed bytes remain retained\n");
  expect(await readFile(path.join(entry.target.quarantine.path, "private-cache/never-disposable"), "utf8")).toBe("private ignored material\n");
  expect(git(f.repository, ["worktree", "list", "--porcelain"])).not.toContain(f.worktree);
  expect(git(f.repository, ["show-ref"])).toBe(branchRefs);
}, 30000);
