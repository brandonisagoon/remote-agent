import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { assertFinalizationPath, finalizationDigest, type FinalizationTreeTarget, type LinkedWorktreePlan } from "./finalization-resources.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";

type Dependencies = z.infer<typeof LinkedWorktreePlan>["installedDependencies"];
type Target = z.infer<typeof FinalizationTreeTarget>;
const locks = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);
async function git(worktree: string, args: string[]) {
  const child = Bun.spawnSync(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: worktree, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (child.exitCode !== 0) throw new Error("Installed dependency ownership could not be inspected");
  return child.stdout.toString();
}

/** Retain exact ignored install roots, bound to their tracked package/lock files.
 * Dependency contents are not individually hashed or deleted. */
export async function prepareInstalledDependencies(worktree: string): Promise<Dependencies> {
  const tracked = new Set((await git(worktree, ["ls-files", "-z"])).split("\0").filter(Boolean));
  const lockNames = locks.filter(file => tracked.has(file));
  const ignored = (await git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).split("\0").filter(Boolean);
  const result: Dependencies = [];
  for (const value of ignored) {
    const relative = value.endsWith("/") ? value.slice(0, -1) : value;
    if (path.basename(relative) !== "node_modules") continue;
    if (path.isAbsolute(relative) || path.normalize(relative) !== relative || relative.split(path.sep).includes("..")) throw new Error("Installed dependency path is invalid");
    const file = path.join(worktree, relative), packageFile = path.join(path.dirname(relative), "package.json");
    if (!lockNames.length || !tracked.has(packageFile) || await git(worktree, ["ls-files", "-z", "--", relative])) throw new Error("Installed dependencies need their tracked package and lock pins");
    await assertFinalizationPath(file);
    const stat = await lstat(file);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || await realpath(file) !== file) throw new Error("Installed dependency directory is shared, unowned or redirected");
    const packageFiles = await Promise.all([packageFile, ...lockNames].map(relative => observeLegacyEvidenceFile(path.join(worktree, relative), false, 16 * 1024 * 1024)));
    result.push({ path: file, dev: stat.dev, ino: stat.ino, mode: stat.mode, packageFiles });
  }
  if (result.length > 100) throw new Error("Installed dependency roots exceed their bound");
  return result;
}

export function validateInstalledDependencies(target: Target, dependencies: Dependencies, resourceId: string) {
  const root = target.path, opaque = target.inventory.filter(entry => entry.kind === "opaque");
  if (new Set(dependencies.map(entry => entry.path)).size !== dependencies.length || opaque.length !== dependencies.length
    || opaque.some(entry => entry.dependencyResourceId !== resourceId || !dependencies.some(dependency => dependency.path === path.join(root, entry.path) && dependency.dev === entry.dev && dependency.ino === entry.ino && dependency.mode === entry.mode))) throw new Error("Opaque installed dependency scope changed");
  for (const dependency of dependencies) {
    if (path.basename(dependency.path) !== "node_modules" || !inside(root, dependency.path) || dependencies.some(other => other !== dependency && inside(other.path, dependency.path))) throw new Error("Opaque path is not an exact installed dependency root");
    const packagePath = path.join(path.dirname(dependency.path), "package.json");
    const pins = dependency.packageFiles.map(file => file.path);
    if (new Set(pins).size !== pins.length || !pins.includes(packagePath) || !pins.some(file => locks.some(lock => file === path.join(root, lock)))
      || pins.some(file => file !== packagePath && !locks.some(lock => file === path.join(root, lock)))) throw new Error("Installed dependency package and lock scope changed");
    for (const file of dependency.packageFiles) {
      const entry = target.inventory.find(entry => entry.path === path.relative(root, file.path));
      if (!inside(root, file.path) || entry?.kind !== "file" || finalizationDigest({ ...file, path: entry.path, kind: "file" }) !== finalizationDigest(entry)) throw new Error("Installed dependency package pin changed");
    }
  }
}

/** Recheck held identities at the original or captured location without walking
 * the opaque installs. The rest of the tree keeps its full inventory check. */
export async function assertInstalledDependencies(target: Target, dependencies: Dependencies, resourceId: string, physicalRoot: string) {
  validateInstalledDependencies(target, dependencies, resourceId);
  for (const dependency of dependencies) {
    const file = path.join(physicalRoot, path.relative(target.path, dependency.path));
    await assertFinalizationPath(file);
    const stat = await lstat(file);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.dev !== dependency.dev || stat.ino !== dependency.ino || stat.mode !== dependency.mode || await realpath(file) !== file) throw new Error("Installed dependency directory identity changed");
    for (const expected of dependency.packageFiles) {
      const observed = await observeLegacyEvidenceFile(path.join(physicalRoot, path.relative(target.path, expected.path)), false, 16 * 1024 * 1024);
      if (finalizationDigest({ ...observed, path: expected.path }) !== finalizationDigest(expected)) throw new Error("Installed dependency package pin changed");
    }
  }
}
