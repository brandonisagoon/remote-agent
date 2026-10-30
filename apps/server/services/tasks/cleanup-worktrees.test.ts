import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertFinalizationResources, finalizationDigest, prepareFinalizationResources, type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
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
async function saveAdministration(entry: ReturnType<typeof selected>) {
  for (const item of entry.git.administrativeInventory) {
    const target = path.join(entry.retainedAdministration.path, item.path);
    if (item.kind === "directory") await mkdir(target, { mode: 0o700 });
    else if (item.kind === "file") await writeFile(target, await readFile(path.join(entry.git.administrativeDirectory, item.path)), { mode: 0o600, flag: "wx" });
    else throw new Error("Unexpected fixture administration");
  }
}
async function capture(plan: FinalizationResourcePlan[], saveAdmin = true) {
  const entry = selected(plan), target = entry.target, source = target.inventory[0]!;
  if (saveAdmin) await saveAdministration(entry);
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
  await expect(f.verify(plan, true)).rejects.toThrow("registration is still present");
  git(f.repository, ["worktree", "remove", f.worktree]); f.resources[0]!.state = "released";
  await f.verify(plan, true); await f.verify(plan, true);
  expect(await readFile(path.join(entry.retainedAdministration.path, "index"))).toEqual(index);
  for (const item of entry.git.administrativeInventory.filter(item => item.kind === "file")) expect((await readFile(path.join(entry.retainedAdministration.path, item.path))).length).toBe(item.kind === "file" ? item.size : 0);
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

test("complete retained administration is required before any captured worktree can be acknowledged", async () => {
  const f = await fixture(), plan = await f.prepare(); await capture(plan, false);
  await expect(f.verify(plan)).rejects.toThrow("no retained administration");
  const entry = selected(plan); await saveAdministration(entry); await writeFile(path.join(entry.retainedAdministration.path, "index"), "wrong index", { mode: 0o600 });
  await expect(f.verify(plan)).rejects.toThrow("administration bytes changed");
  expect(git(f.repository, ["worktree", "list", "--porcelain"])).toContain(f.worktree);
});

test("active writers prevent linked capture preparation and confirmation", async () => {
  const f = await fixture(); let running = true;
  const observation = { ...quiet, rootIdle: async () => { if (running) throw new Error("active writer"); } };
  await expect(f.prepare(observation)).rejects.toThrow("active writer"); running = false;
  const plan = await f.prepare(observation); await capture(plan); running = true;
  await expect(f.verify(plan, false, observation)).rejects.toThrow("active writer");
});


test.each(["reflog", "missing", "new", "symlink"])("retained Git administration refuses %s replacement without losing original metadata", async change => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan);
  await saveAdministration(entry); const file = path.join(entry.retainedAdministration.path, "logs/HEAD");
  const original = await readFile(path.join(entry.git.administrativeDirectory, "logs/HEAD"));
  if (change === "reflog") await writeFile(file, "different history");
  if (change === "missing") await rm(file);
  if (change === "new") await writeFile(path.join(entry.retainedAdministration.path, "unrecorded"), "extra", { mode: 0o600 });
  if (change === "symlink") { await rename(file, path.join(f.directory, "saved-reflog")); await symlink(path.join(f.directory, "saved-reflog"), file); }
  await expect(f.verify(plan)).rejects.toThrow();
  expect(await readFile(path.join(entry.git.administrativeDirectory, "logs/HEAD"))).toEqual(original);
  expect(git(f.repository, ["worktree", "list", "--porcelain"])).toContain(f.worktree);
});

test("changes to original Git administration after capture prevent unregister acknowledgment", async () => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); await capture(plan);
  await writeFile(path.join(entry.git.administrativeDirectory, "logs/HEAD"), "new history");
  await expect(f.verify(plan)).rejects.toThrow("administrative contents changed");
  expect(await readFile(path.join(entry.git.administrativeDirectory, "logs/HEAD"), "utf8")).toBe("new history");
});


test("linked retention protects the whole saved administration from other task claims", async () => {
  const f = await fixture(), plan = await f.prepare(), entry = selected(plan); let query: unknown;
  const database = { remoteTaskResource: { findFirst: async (input: unknown) => { query = input; return null; } } };
  await assertRegisteredCaptureSharing(database as never, "task", plan);
  expect(JSON.stringify(query)).toContain(entry.retainedAdministration.path);
  const foreign = { remoteTaskResource: { findFirst: async () => ({ id: "another-task-admin-claim" }) } };
  await expect(assertRegisteredCaptureSharing(foreign as never, "task", plan)).rejects.toThrow("another task");
});
