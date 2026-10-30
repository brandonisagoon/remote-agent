import { afterEach, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { originalArchiveFixture, originalGit } from "../../../../test-support/original-work.ts";
import { recoveryArchiveFixture } from "../../../../test-support/recovery-work.ts";
import { prepareOriginalWork, assertOriginalWork } from "./original-work.ts";
import { OriginalWork } from "./original-work-schema.ts";
import { assertLinkedRootIdle } from "./cleanup-open-handles.ts";
import { finalizationInventory } from "./finalization-resources.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const idle = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
async function fixture(format: "bundle" | "recovery" = "bundle") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "archived-dependencies-"))); roots.push(root);
  const product = path.join(root, "product"), worktree = path.join(root, "original"), archive = path.join(root, "archive");
  await mkdir(product); originalGit(product, ["init", "-b", "main"]); originalGit(product, ["config", "user.name", "Fixture"]); originalGit(product, ["config", "user.email", "fixture@example.invalid"]);
  await mkdir(path.join(product, "apps/web"), { recursive: true });
  for (const file of ["package.json", "apps/web/package.json"]) await writeFile(path.join(product, file), "{}");
  await writeFile(path.join(product, "bun.lock"), "frozen install pins\n");
  await writeFile(path.join(product, ".gitignore"), "node_modules/\nowner-cache\n");
  await writeFile(path.join(product, "README.md"), "base\n");
  originalGit(product, ["add", "."]); originalGit(product, ["commit", "-m", "base"]);
  originalGit(product, ["worktree", "add", "-b", "codex/original", worktree]);
  const recovery = format === "recovery" ? await recoveryArchiveFixture(worktree, archive) : undefined;
  const selection = recovery?.selection ?? await originalArchiveFixture(worktree, archive, "archive");
  const resources = recovery?.resources ?? [{ id: "archive", key: "archive", kind: "source-archive", purpose: "review", externalId: archive, state: "ready", metadata: {} }];
  const modules = path.join(worktree, "node_modules"), nested = path.join(worktree, "apps/web/node_modules");
  await mkdir(modules); await mkdir(nested); await writeFile(path.join(nested, "index.js"), "installed nested dependency");
  for (const [first, second] of [["workerd", "workerd-platform"], ["bun.exe", "bunx.exe"]]) {
    await writeFile(path.join(modules, first!), "installed executable", { mode: 0o700 });
    await link(path.join(modules, first!), path.join(modules, second!));
  }
  await writeFile(path.join(worktree, "owner-cache"), "ignored owner material");
  selection.ownedPaths = [modules, nested, path.join(worktree, "owner-cache")];
  const input = { taskId: "task", toolingRevision: "a".repeat(40), worktree, branch: "codex/original", approvedHead: originalGit(worktree, ["rev-parse", "HEAD"]).toString().trim(), resources, originalWork: selection };
  return { root, product, worktree, archive, resources, selection, input, modules };
}

test.each(["bundle", "recovery"] as const)("%s original retains hardlinked installs but hashes other ignored bytes", async format => {
  const f = await fixture(format), selectionBytes = JSON.stringify(f.selection), archiveBytes = await readFile(f.selection.manifestPath);
  const proof = await prepareOriginalWork(f.input, idle);
  expect(proof.installedDependencies).toHaveLength(2);
  expect(proof.target.inventory.filter(entry => entry.kind === "opaque")).toHaveLength(2);
  expect(proof.target.inventory.some(entry => entry.path.startsWith("node_modules/"))).toBe(false);
  expect(proof.target.inventory.find(entry => entry.path === "owner-cache")?.kind).toBe("file");
  expect(JSON.stringify(f.selection)).toBe(selectionBytes);
  expect(await readFile(f.selection.manifestPath)).toEqual(archiveBytes);
  await assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, idle);
  expect((await lstat(path.join(f.modules, "bun.exe"))).nlink).toBe(2);
});

test.each(["directory", "package", "lock", "other-ignored"] as const)("changed %s prevents the next archive cleanup boundary", async change => {
  const f = await fixture(), proof = await prepareOriginalWork(f.input, idle);
  if (change === "directory") { await rename(f.modules, `${f.modules}-saved`); await mkdir(f.modules); }
  else await writeFile(path.join(f.worktree, change === "package" ? "package.json" : change === "lock" ? "bun.lock" : "owner-cache"), "changed owner bytes");
  await expect(assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, idle)).rejects.toThrow();
  expect(await Bun.file(path.join(f.worktree, "README.md")).exists()).toBe(true);
});

test("ignored installs still require explicit selection and tracked package/lock files", async () => {
  const f = await fixture();
  await expect(prepareOriginalWork({ ...f.input, originalWork: { ...f.selection, ownedPaths: [] } }, idle)).rejects.toThrow("Ignored original material");
  originalGit(f.worktree, ["rm", "--cached", "bun.lock"]);
  const { prepareInstalledDependencies } = await import("./installed-dependencies.ts");
  await expect(prepareInstalledDependencies(f.worktree)).rejects.toThrow("tracked package and lock");
});

test("old proofs keep exact bytes and full inventory semantics", async () => {
  const f = await fixture(); await rm(f.modules, { recursive: true }); await rm(path.join(f.worktree, "apps/web/node_modules"), { recursive: true });
  const proof = await prepareOriginalWork(f.input, idle), before = JSON.stringify(proof);
  expect(proof).not.toHaveProperty("installedDependencies");
  expect(JSON.stringify(OriginalWork.parse(JSON.parse(before)))).toBe(before);
  await assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, idle);
  expect(JSON.stringify(proof)).toBe(before);
});

test("an existing full dependency inventory is never silently converted to opaque retention", async () => {
  const f = await fixture();
  for (const name of ["workerd-platform", "bunx.exe"]) {
    await unlink(path.join(f.modules, name)); await writeFile(path.join(f.modules, name), "independent installed bytes");
  }
  const proof = await prepareOriginalWork(f.input, idle);
  // Construct the previous protocol's fully inventoried receipt, without the
  // new optional field. New readers must keep every frozen dependency hash.
  proof.target.inventory = await finalizationInventory(f.worktree, [f.worktree], new Map(), new Map());
  delete proof.installedDependencies;
  const before = JSON.stringify(proof);
  await assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, idle);
  expect(JSON.stringify(proof)).toBe(before);
  await writeFile(path.join(f.modules, "bunx.exe"), "changed dependency bytes");
  await expect(assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, idle)).rejects.toThrow();
  expect(JSON.stringify(proof)).toBe(before);
});

test("installed originals use the existing bounded handle observer without excluding their contents", async () => {
  const f = await fixture(), observed: string[] = [];
  const observation = { ...idle, rootIdle: async (root: string) => {
    if (root === f.worktree) throw new Error("recursive original observation should not run");
  }, linkedRootIdle: async (root: string) => { observed.push(root); } };
  const proof = await prepareOriginalWork(f.input, observation);
  await assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, observation);
  expect(observed.filter(root => root === f.worktree).length).toBeGreaterThanOrEqual(3);
});

test("a real open dependency handle prevents original preparation despite the opaque inventory", async () => {
  const f = await fixture();
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", 'const fs=require("node:fs");const fd=fs.openSync(process.env.DEPENDENCY_FILE,"r");console.log("ready");setTimeout(()=>fs.closeSync(fd),30000);'], {
    cwd: f.root, env: { ...process.env, DEPENDENCY_FILE: path.join(f.modules, "bun.exe") }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader(); await reader.read(); await reader.cancel();
  const run = (args: string[]) => Bun.spawnSync(args[0] === "lsof" ? [...args, "-a", "-p", String(child.pid)] : args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  try { await expect(prepareOriginalWork(f.input, { ...idle, rootIdle: root => assertLinkedRootIdle(root, run) })).rejects.toThrow("still holds"); }
  finally { child.kill(9); await child.exited; }
}, 20_000);

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual client preserves both hardlink pairs and retries the same source/admin capture", async () => {
  const f = await fixture("recovery"), proof = await prepareOriginalWork(f.input, idle), before = JSON.stringify(proof);
  const { retireArchivedWorktree } = await import(pathToFileURL(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/archived-worktree.ts")).href);
  const input = { taskId: "task", worktree: f.worktree, revision: proof.snapshot.head, branch: proof.snapshot.branch, gitDirectory: proof.restore.gitDirectory, gitCwd: f.product,
    target: proof.target, administration: proof.administration, installedDependencies: proof.installedDependencies,
    observation: idle, assertAuthority: async () => assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, idle) };
  await expect(retireArchivedWorktree({ ...input, captureHooks: { afterCapture() { throw new Error("lost capture response"); } } })).rejects.toThrow("lost capture response");
  const retainedInode = (await lstat(proof.target.quarantine.path)).ino;
  await retireArchivedWorktree(input);
  await retireArchivedWorktree(input);
  await assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: true }, idle);
  expect((await lstat(proof.target.quarantine.path)).ino).toBe(retainedInode);
  for (const [first, second] of [["workerd", "workerd-platform"], ["bun.exe", "bunx.exe"]]) {
    const one = await lstat(path.join(proof.target.quarantine.path, "node_modules", first!)), two = await lstat(path.join(proof.target.quarantine.path, "node_modules", second!));
    expect(one.ino).toBe(two.ino); expect(one.nlink).toBe(2);
  }
  expect(await readFile(path.join(proof.target.quarantine.path, "owner-cache"), "utf8")).toBe("ignored owner material");
  expect(JSON.stringify(proof)).toBe(before);
}, 30_000);
