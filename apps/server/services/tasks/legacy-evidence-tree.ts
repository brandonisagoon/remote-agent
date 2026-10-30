import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { assertFinalizationPath, assertFinalizationTree, finalizationDigest, finalizationInventory, type FinalizationInventoryEntry } from "./finalization-resources.ts";
import type { LegacyEvidenceEntry } from "./legacy-evidence-schema.ts";

export type EvidenceTreeEntry = Extract<LegacyEvidenceEntry, { retained: { type: "tree" } }>;
export const isEvidenceTree = (entry: LegacyEvidenceEntry): entry is EvidenceTreeEntry => entry.target.type === "tree" && "type" in entry.retained && entry.retained.type === "tree";

/** The directory is an explicit original receipt, not an inferred filesystem
 * prefix. Preflight bounds and ownership before the shared streaming inventory. */
export async function observeLegacyEvidenceTree(root: string, privateTree = false) {
  await assertFinalizationPath(root);
  const original = await lstat(root); let count = 0, bytes = 0;
  if (!original.isDirectory() || root === path.parse(root).root) throw new Error("Directory evidence requires an exact owned directory");
  async function bound(file: string) {
    const stat = await lstat(file);
    if (++count > 10_025 || stat.dev !== original.dev || stat.uid !== process.getuid?.() || stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile()) || stat.isFile() && stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || privateTree && (stat.mode & 0o7777) !== (stat.isDirectory() ? 0o700 : 0o600)) throw new Error("Directory evidence contains shared, unowned or unsupported material");
    if (stat.isFile()) { bytes += stat.size; if (bytes > 512 * 1024 * 1024) throw new Error("Directory evidence exceeds its byte bound"); }
    else for (const name of await readdir(file)) await bound(path.join(file, name));
  }
  await bound(root);
  const inventory = await finalizationInventory(root, [root], new Map(), new Map());
  if (inventory.length !== count || inventory.some(entry => entry.kind !== "file" && entry.kind !== "directory")) throw new Error("Directory evidence changed during observation");
  let actualBytes = 0;
  for (const entry of inventory) {
    const stat = await lstat(path.resolve(root, entry.path));
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.mode !== entry.mode || stat.uid !== process.getuid?.() || stat.isFile() && stat.nlink !== 1) throw new Error("Directory evidence ownership changed");
    if (entry.kind === "file") actualBytes += entry.size;
  }
  if (actualBytes > 512 * 1024 * 1024) throw new Error("Directory evidence exceeds its byte bound");
  return { type: "tree" as const, path: root, inventory, inventoryDigest: finalizationDigest(inventory) };
}

export function matchLegacyEvidenceTrees(source: Awaited<ReturnType<typeof observeLegacyEvidenceTree>>, retained: Awaited<ReturnType<typeof observeLegacyEvidenceTree>>, members: Map<string, { dev: number; ino: number; mode: number; size: number; sha256: string }>) {
  const copies = new Map(retained.inventory.map(entry => [entry.path, entry]));
  if (copies.size !== source.inventory.length) throw new Error("Retained directory inventory differs from the original");
  for (const entry of source.inventory) {
    const copy = copies.get(entry.path);
    if (!copy || copy.kind !== entry.kind || copy.dev === entry.dev && copy.ino === entry.ino) throw new Error("Retained directory requires independent exact members");
    if (entry.kind === "file") {
      const declared = members.get(path.resolve(retained.path, entry.path));
      if (copy.kind !== "file" || copy.sha256 !== entry.sha256 || copy.size !== entry.size || !declared || ["dev", "ino", "mode", "size", "sha256"].some(key => declared[key as keyof typeof declared] !== copy[key as keyof typeof copy])) throw new Error("Retained directory bytes are missing, changed or unmanifested");
    }
  }
}

export async function assertLegacyEvidenceTree(entry: EvidenceTreeEntry, physicalPath: string, retained = false) {
  const expected = retained ? entry.retained : entry.target;
  if (retained && finalizationDigest(entry.retained.inventory) !== entry.retained.inventoryDigest) throw new Error("Retained directory inventory digest changed");
  await assertFinalizationTree({ ...entry.target, path: expected.path, inventory: expected.inventory }, physicalPath);
  // Full inode/content comparison above plus explicit owner/mode checks for all
  // entries; no socket, link, opaque child or shared file is an evidence member.
  for (const member of expected.inventory) {
    const stat = await lstat(path.resolve(physicalPath, member.path));
    if (!["file", "directory"].includes(member.kind) || stat.uid !== process.getuid?.() || stat.dev !== member.dev || stat.ino !== member.ino || stat.mode !== member.mode || stat.isFile() && stat.nlink !== 1 || retained && (stat.mode & 0o7777) !== (member.kind === "directory" ? 0o700 : 0o600)) throw new Error("Directory evidence ownership changed");
  }
}
