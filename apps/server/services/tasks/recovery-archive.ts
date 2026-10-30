import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { archiveMember, readArchiveBytes } from "./archive-observation.ts";
import { assertFinalizationPath, finalizationDigest, type FinalizationInventoryEntry } from "./finalization-resources.ts";
import { RecoveryWorkInput } from "./original-work-schema.ts";
import { safeRecoveryLink, assertRecoveryLinkSet, type RecoveryTarMember } from "./recovery-tar.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/), Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const checksum = z.object({ file: z.string(), size: Size, sha256: Digest }).strict();
export const RecoveryManifest = z.array(z.object({ path: z.string(), kind: z.enum(["file", "symlink"]), mode: z.number().int().nonnegative(), size: Size, sha256: Digest, untracked: z.boolean(), changed: z.boolean() }).strict()).min(1).max(250_000);
const Receipt = z.object({ task: z.string(), source: z.string(), archive: z.string(), base: Sha, branch: z.string(), toolingPin: Sha, checksums: z.array(checksum).min(1).max(100), trackedFiles: Size, modifiedFiles: Size, untrackedFiles: Size, verifiedRestoredFiles: Size }).passthrough();
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const stable = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) => ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);

/** The containing 0700 archive supplies privacy; historical 0644 files stay
 * unchanged. Hash a held descriptor in fixed chunks rather than allocating the
 * historical tar's declared length. Existing v1 archive limits are unchanged. */
export async function observeRecoveryFile(file: string, expectedSize?: number) {
  await assertFinalizationPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o7022 || !Number.isSafeInteger(before.size) || expectedSize !== undefined && before.size !== expectedSize) throw new Error("Recovery archive file ownership or size changed");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let offset = 0;
    while (offset < before.size) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset); if (!bytesRead) throw new Error("Recovery archive file changed"); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
    if (!stable(before, await handle.stat()) || !stable(before, await lstat(file))) throw new Error("Recovery archive file changed during observation");
    await assertFinalizationPath(file);
    return { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

export async function observeRecoveryArchive(root: string, selected: RecoveryWorkInput) {
  const selection = RecoveryWorkInput.parse(selected);
  await assertFinalizationPath(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o7777) !== 0o700 || await realpath(root) !== root) throw new Error("Recovery archive root must be an exact private owned directory");
  const manifestRelative = path.relative(root, selection.manifestPath);
  if (archiveMember(root, manifestRelative) !== selection.manifestPath) throw new Error("Recovery manifest is outside its archive");
  const [manifestBytes, receiptBytes, checksumBytes] = await Promise.all([
    readArchiveBytes(selection.manifestPath, 32 * 1024 * 1024), readArchiveBytes(archiveMember(root, selection.receiptPath), 1024 * 1024), readArchiveBytes(archiveMember(root, selection.checksumsPath), 1024 * 1024),
  ]);
  if (sha(manifestBytes) !== selection.manifestSha256 || sha(receiptBytes) !== selection.receiptSha256 || sha(checksumBytes) !== selection.checksumsSha256) throw new Error("Recovery archive selected documents changed");
  const manifest = RecoveryManifest.parse(JSON.parse(manifestBytes.toString())), receipt = Receipt.parse(JSON.parse(receiptBytes.toString()));
  if (receipt.archive !== root) throw new Error("Recovery receipt belongs to another archive");
  const sums = new Map<string, string>();
  for (const line of checksumBytes.toString().split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line); if (!match) throw new Error("Invalid recovery checksum manifest");
    const name = match[2]!; archiveMember(root, name);
    if (sums.has(name) || sums.size > 100 || name === selection.checksumsPath) throw new Error("Duplicate or recursive recovery checksum entry"); sums.set(name, match[1]!);
  }
  const inputs = new Map<string, z.infer<typeof checksum>>();
  for (const entry of receipt.checksums) {
    archiveMember(root, entry.file);
    if (inputs.has(entry.file) || sums.get(entry.file) !== entry.sha256 || [selection.receiptPath, selection.checksumsPath].includes(entry.file)) throw new Error("Recovery receipt and checksums disagree"); inputs.set(entry.file, entry);
  }
  if (sums.size !== inputs.size + 1 || sums.get(selection.receiptPath) !== selection.receiptSha256 || inputs.get(manifestRelative)?.sha256 !== selection.manifestSha256) throw new Error("Recovery archive lacks exact document coverage");
  for (const name of ["base.tar.gz", "work.tar.gz", "index.patch", "tracked.patch", "status.porcelain", "base-tree.txt", "changed-files.txt", manifestRelative]) if (!inputs.has(name)) throw new Error("Recovery archive lacks a required restore input");
  const members = new Map<string, z.infer<typeof RecoveryManifest>[number]>(); let restoredBytes = 0;
  for (const entry of manifest) {
    archiveMember(root, entry.path);
    if (entry.path === ".git" || entry.path.startsWith(".git/") || members.has(entry.path) || ![0o644, 0o755].includes(entry.mode)) throw new Error("Unsupported or duplicate recovery manifest member");
    for (let parent = path.dirname(entry.path); parent !== "."; parent = path.dirname(parent)) if (members.has(parent)) throw new Error("Recovery manifest traverses a file");
    members.set(entry.path, entry); restoredBytes += entry.size;
  }
  for (const name of members.keys()) for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent)) if (members.has(parent)) throw new Error("Recovery manifest traverses a file or symlink");
  if (!Number.isSafeInteger(restoredBytes) || receipt.verifiedRestoredFiles !== members.size || receipt.trackedFiles !== manifest.filter(x => !x.untracked).length || receipt.modifiedFiles !== manifest.filter(x => x.changed && !x.untracked).length || receipt.untrackedFiles !== manifest.filter(x => x.untracked).length) throw new Error("Recovery manifest counts disagree");
  // Existing restore copies and interrupted tar bytes are observed ancillary
  // material. Their budget derives from the declared archive and restored sizes;
  // they are never fed into the restore or claimed as historical proof.
  const declared = [...inputs.values()].reduce((total, entry) => total + entry.size, 0), bound = declared * 2 + restoredBytes * 2 + 64 * 1024 * 1024;
  if (!Number.isSafeInteger(bound)) throw new Error("Recovery archive size budget is invalid");
  const inventory: FinalizationInventoryEntry[] = []; let total = 0;
  async function visit(file: string) {
    if (inventory.length >= 250_000) throw new Error("Recovery inventory exceeds its entry bound");
    const before = await lstat(file), relative = path.relative(root, file) || ".";
    if (before.dev !== rootStat.dev || before.uid !== rootStat.uid || !before.isSymbolicLink() && before.mode & 0o7022) throw new Error("Recovery inventory ownership changed");
    const common = { path: relative, dev: before.dev, ino: before.ino, mode: before.mode };
    if (before.isDirectory()) {
      inventory.push({ ...common, kind: "directory" }); const names = (await readdir(file)).sort();
      for (const name of names) await visit(path.join(file, name));
      const after = await lstat(file);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid || JSON.stringify(names) !== JSON.stringify((await readdir(file)).sort())) throw new Error("Recovery directory changed during observation");
    } else if (before.isSymbolicLink()) {
      const link = await readlink(file); safeRecoveryLink(relative, link);
      if (!stable(before, await lstat(file)) || await readlink(file) !== link) throw new Error("Recovery ancillary symlink changed");
      inventory.push({ ...common, kind: "symlink", link });
    } else {
      if (!before.isFile() || total + before.size > bound) throw new Error("Recovery inventory contains unsupported or excessive material");
      const observed = await observeRecoveryFile(file, before.size); total += observed.size;
      if (before.dev !== observed.dev || before.ino !== observed.ino || before.mode !== observed.mode) throw new Error("Recovery file changed during observation");
      inventory.push({ ...common, kind: "file", size: observed.size, sha256: observed.sha256 });
    }
  }
  await visit(root);
  assertRecoveryLinkSet(new Map(inventory.filter(entry => entry.kind === "symlink").map(entry => [entry.path, entry.link])));
  const files = new Map(inventory.filter(entry => entry.kind === "file").map(entry => [entry.path, entry]));
  for (const entry of inputs.values()) if (files.get(entry.file)?.sha256 !== entry.sha256 || files.get(entry.file)?.size !== entry.size) throw new Error("Recovery restore input differs from its historical checksum");
  if (files.get(selection.receiptPath)?.sha256 !== selection.receiptSha256 || files.get(selection.checksumsPath)?.sha256 !== selection.checksumsSha256 || files.get(manifestRelative)?.sha256 !== selection.manifestSha256) throw new Error("Recovery documents changed during observation");
  await assertFinalizationPath(root);
  if (!stable(rootStat, await lstat(root))) throw new Error("Recovery archive root changed during observation");
  return { receipt, manifest, members, inputs, inventory, inventoryDigest: finalizationDigest(inventory), entries: new Map([...files].map(([name, entry]) => [name, entry.sha256])) };
}

export function recoveryTarMembers(entries: Iterable<{ path: string; kind: "file" | "symlink"; size: number; mode: number; sha256: string }>): Map<string, RecoveryTarMember> {
  return new Map([...entries].map(entry => [entry.path, { kind: entry.kind, size: entry.size, executable: Boolean(entry.mode & 0o111), sha256: entry.sha256 }]));
}

/** Reproduce the complete selected source, including symlink text and executable
 * mode. A fresh directory list detects extra or missing output, not just matches. */
export async function assertRecoveryContents(root: string, manifest: z.infer<typeof RecoveryManifest>, allowGit = false) {
  const expected = new Map(manifest.map(entry => [entry.path, entry])), seen = new Set<string>(), links = new Map<string, string>();
  const directories = new Set<string>(); for (const name of expected.keys()) for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent)) directories.add(parent);
  async function visit(file: string) {
    const relative = path.relative(root, file); if (allowGit && relative === ".git") return;
    const before = await lstat(file), entry = expected.get(relative);
    if (before.isDirectory()) {
      if (relative && !directories.has(relative)) throw new Error("Recovery output contains an unlisted directory");
      for (const name of await readdir(file)) await visit(path.join(file, name));
    } else {
      if (!entry || seen.has(relative) || Boolean(before.mode & 0o111) !== Boolean(entry.mode & 0o111)) throw new Error("Recovery output contains an unlisted or changed member");
      if (entry.kind === "symlink") {
        if (!before.isSymbolicLink()) throw new Error("Recovery output link type changed"); const link = await readlink(file); safeRecoveryLink(relative, link);
        links.set(relative, link);
        if (Buffer.byteLength(link) !== entry.size || sha(Buffer.from(link)) !== entry.sha256) throw new Error("Recovery output symlink differs from manifest");
      } else {
        const observed = await observeRecoveryFile(file, entry.size); if (observed.sha256 !== entry.sha256) throw new Error("Recovery output file differs from manifest");
      }
      seen.add(relative);
    }
  }
  await visit(root); assertRecoveryLinkSet(links); if (seen.size !== expected.size) throw new Error("Recovery output is incomplete");
}
