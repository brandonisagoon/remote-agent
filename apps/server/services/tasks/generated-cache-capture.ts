import path from "node:path";
import { z } from "zod";
import { GeneratedCacheRoot, type GeneratedCacheData } from "./generated-cache-schema.ts";
import { scanOwnedGeneratedCache } from "./generated-cache-files.ts";
import { finalizationDigest, type FinalizationTreeTarget } from "./finalization-resources.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { originalWorkGit } from "./original-work-git.ts";
import { assertGeneratedCacheMounts } from "./generated-cache-mounts.ts";
const locks = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const inside = (root: string, file: string) => file.startsWith(root + path.sep);
export async function prepareGeneratedCaches(worktree: string, selected: string[], ownedPaths: string[]) {
  if (!selected.length) return [];
  if (new Set(selected).size !== selected.length || selected.some(file => !inside(worktree, file) || path.basename(file) !== "node_modules" || !ownedPaths.includes(file)
    || selected.some(other => other !== file && inside(other, file)))) throw Error("Generated cache selection must be exact, explicit and unique");
  const tracked = new Set((await originalWorkGit(worktree, ["ls-files", "-z"])).toString().split("\0").filter(Boolean));
  const ignored = new Set((await originalWorkGit(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).toString().split("\0").filter(Boolean).map(value => value.replace(/\/$/, "")));
  const result: z.infer<typeof GeneratedCacheRoot>[] = [];
  await assertGeneratedCacheMounts([worktree]);
  for (const file of selected) {
    const relative = path.relative(worktree, file), packageFile = path.join(path.dirname(relative), "package.json"), lockFiles = locks.filter(file => tracked.has(file));
    if (!ignored.has(relative) || !tracked.has(packageFile) || !lockFiles.length || [...tracked].some(p => p === relative || p.startsWith(relative + path.sep))) throw Error("Generated cache needs ignored membership and tracked package/lock pins");
    const packageFiles = await Promise.all([packageFile, ...lockFiles].map(relative => observeLegacyEvidenceFile(path.join(worktree, relative), false, 16 * 1024 * 1024)));
    result.push(GeneratedCacheRoot.parse({ path: file, ...scanOwnedGeneratedCache(file), packageFiles }));
  }
  return result;
}
export async function assertGeneratedCaches(target: z.infer<typeof FinalizationTreeTarget>, data: GeneratedCacheData, physicalRoot: string) {
  if (new Set(data.roots.map(r => r.path)).size !== data.roots.length) throw Error("Generated cache roots are ambiguous");
  await assertGeneratedCacheMounts([target.path, physicalRoot]);
  for (const root of data.roots) {
    if (!inside(target.path, root.path) || path.basename(root.path) !== "node_modules" || target.inventory.some(e => e.kind === "opaque" && (path.join(target.path,e.path) === root.path || inside(path.join(target.path,e.path),root.path)))) throw Error("Generated cache is hidden behind an opaque ancestor");
    const physical = path.join(physicalRoot, path.relative(target.path, root.path)), actual = scanOwnedGeneratedCache(physical);
    if (finalizationDigest(actual) !== finalizationDigest({ entries: root.entries, bytes: root.bytes, digest: root.digest }) || finalizationDigest(root.entries) !== root.digest) throw Error("Generated cache bytes, ownership or membership changed");
    const prefix = path.relative(target.path, root.path);
    const inventory = target.inventory.filter(e => e.path === prefix || e.path.startsWith(prefix + path.sep));
    const projected = root.entries.map(entry => ({ path: entry.path === "." ? prefix : path.join(prefix,entry.path), kind: entry.kind, dev: entry.dev, ino: entry.ino, mode: entry.mode, ...(entry.kind === "file" ? { size: entry.size, sha256: entry.sha256 } : {}) }));
    if (finalizationDigest(inventory) !== finalizationDigest(projected)) throw Error("Generated cache is not fully inventoried original-work data");
    const packagePath = path.join(path.dirname(root.path),"package.json"), pins = root.packageFiles.map(p => p.path);
    if (new Set(pins).size !== pins.length || !pins.includes(packagePath) || !pins.some(file => locks.some(lock => file === path.join(target.path,lock))) || pins.some(file => file !== packagePath && !locks.some(lock => file === path.join(target.path,lock)))) throw Error("Generated cache package/lock pin scope changed");
    for (const pin of root.packageFiles) {
      const observed = await observeLegacyEvidenceFile(path.join(physicalRoot,path.relative(target.path,pin.path)),false,16*1024*1024);
      if (finalizationDigest({ ...observed,path:pin.path }) !== finalizationDigest(pin)) throw Error("Generated cache package pin changed");
      const entry = target.inventory.find(e => e.path === path.relative(target.path,pin.path));
      if (!entry || finalizationDigest({ ...pin,path:entry.path,kind:"file" }) !== finalizationDigest(entry)) throw Error("Generated cache package pin is outside the captured inventory");
    }
  }
}
