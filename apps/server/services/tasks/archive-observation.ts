import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertFinalizationPath, finalizationDigest, type FinalizationInventoryEntry } from "./finalization-resources.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";

const MAX_BYTES = 512 * 1024 * 1024;
const PRIVATE_ARCHIVE_FILE_MODES = [0o600, 0o700];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);

/** Bounded, private regular-file inventory shared by backup restore and saved
 * archive retention. File hashing uses the existing streaming evidence reader. */
export async function privateArchiveInventory(root: string, backup = false) {
  const byteLimit = backup ? 8 * 1024 * 1024 * 1024 : MAX_BYTES;
  await assertFinalizationPath(root);
  const rootStat = await lstat(root);
  if (await realpath(root) !== root || !rootStat.isDirectory()) throw new Error("Retained archive root is not an exact directory");
  const inventory: FinalizationInventoryEntry[] = []; let total = 0, files = 0;
  async function visit(file: string) {
    if (inventory.length >= 250_000) throw new Error("Archive inventory exceeds its entry bound");
    const before = await lstat(file), relative = path.relative(root, file) || ".";
    if (before.dev !== rootStat.dev || before.uid !== process.getuid?.() || (before.isDirectory() ? (before.mode & 0o7777) !== 0o700 : !(backup ? [0o400, 0o600, 0o700] : PRIVATE_ARCHIVE_FILE_MODES).includes(before.mode & 0o7777))) throw new Error("Retained archive must be private and task-owned");
    if (before.isDirectory()) {
      inventory.push({ path: relative, kind: "directory", dev: before.dev, ino: before.ino, mode: before.mode });
      const children = (await readdir(file)).sort();
      for (const child of children) await visit(path.join(file, child));
      const after = await lstat(file);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid || JSON.stringify(children) !== JSON.stringify((await readdir(file)).sort())) throw new Error("Archive directory changed during observation");
    } else {
      if (!before.isFile() || before.size + total > byteLimit || ++files > 10_025) throw new Error("Archive contains unsupported or excessive material");
      // Mode is checked above and compared again below. Owner-only executable
      // members are retained bytes, never executable inputs to this observer.
      const observed = backup ? await observeBackupFile(file, byteLimit - total) : await observeLegacyEvidenceFile(file, false); total += observed.size;
      if (total > byteLimit || before.dev !== observed.dev || before.ino !== observed.ino || before.mode !== observed.mode) throw new Error("Archive file changed during observation");
      inventory.push({ kind: "file", path: relative, dev: observed.dev, ino: observed.ino, mode: observed.mode, size: observed.size, sha256: observed.sha256 });
    }
  }
  await visit(root);
  await assertFinalizationPath(root);
  const after = await lstat(root);
  if (after.dev !== rootStat.dev || after.ino !== rootStat.ino) throw new Error("Archive root changed during observation");
  return inventory;
}
export function archiveMember(root: string, relative: string) {
  if (!relative || relative === "." || path.isAbsolute(relative) || path.normalize(relative) !== relative || relative.split(path.sep).includes("..") || relative.includes("\0")) throw new Error("Archive member has an unsafe path");
  const file = path.join(root, relative);
  if (!inside(root, file)) throw new Error("Archive member escapes its root");
  return file;
}
export async function readArchiveBytes(file: string, limit = MAX_BYTES) {
  await assertFinalizationPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > limit) throw new Error("Archive input must be a bounded owned regular file");
    const output = Buffer.alloc(before.size); let offset = 0;
    while (offset < output.length) { const read = await handle.read(output, offset, output.length - offset, offset); if (!read.bytesRead) throw new Error("Archive input changed"); offset += read.bytesRead; }
    const after = await handle.stat(), leaf = await lstat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || leaf.ino !== before.ino || leaf.dev !== before.dev || leaf.mode !== before.mode || leaf.isSymbolicLink()) throw new Error("Archive input changed during observation");
    return output;
  } finally { await handle.close(); }
}
export async function observeArchive(root: string, manifestPath: string, manifestSha256: string, format: "sha256-lines" | "files-v1" = "sha256-lines") {
  if (!inside(root, manifestPath)) throw new Error("Manifest must be inside its registered archive");
  const manifest = await readArchiveBytes(manifestPath, 8 * 1024 * 1024);
  if (sha(manifest) !== manifestSha256) throw new Error("Archive manifest digest changed");
  const entries = new Map<string, string>(); let total = 0;
  const listed = format === "files-v1" ? (() => {
    const value = z.object({ root: z.literal(root), files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(10000) }).passthrough().parse(JSON.parse(manifest.toString()));
    return value.files.map((entry) => ({ name: entry.path, digest: entry.sha256, size: entry.bytes }));
  })() : manifest.toString().split("\n").filter(Boolean).map((line) => {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error("Unsupported archive manifest entry");
    return { name: match[2]!.startsWith("./") ? match[2]!.slice(2) : match[2]!, digest: match[1]!, size: undefined };
  });
  const inventory = await privateArchiveInventory(root);
  const files = new Map(inventory.filter(entry => entry.kind === "file").map(entry => [entry.path, entry]));
  for (const { name, digest, size } of listed) {
    const file = archiveMember(root, name);
    if (file === manifestPath || entries.has(name) || entries.size >= 10000) throw new Error("Archive manifest has duplicate or recursive members");
    const content = files.get(name); total += content?.size ?? 0;
    if (!content || total > MAX_BYTES || content.sha256 !== digest || size !== undefined && content.size !== size) throw new Error("Archive member does not match its manifest");
    entries.set(name, digest);
  }
  if (!entries.size) throw new Error("Archive manifest is empty");
  for (const entry of inventory) {
    if (entry.kind !== "directory" && entry.kind !== "file" || entry.kind === "file" && (path.join(root, entry.path) === manifestPath ? entry.sha256 !== manifestSha256 : entries.get(entry.path) !== entry.sha256)) throw new Error("Archive contains unmanifested or unsupported material");
    const mode = entry.mode & 0o7777;
    if (entry.kind === "directory" ? mode !== 0o700 : path.join(root, entry.path) === manifestPath ? mode !== 0o600 : !PRIVATE_ARCHIVE_FILE_MODES.includes(mode)) throw new Error("Retained archive must be private");
  }
  return { inventory, inventoryDigest: finalizationDigest(inventory), entries };
}

const ManifestReference = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), entries: z.number().int().nonnegative().optional() }).strict();
const FlatSavedArchiveSelection = z.object({ root: z.string(), manifests: z.array(ManifestReference).min(1).max(21), taskId: z.string(), issueIdentifier: z.string(), mergeCommit: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export const PrivateBackupSelection = z.object({ format: z.literal("task-private-backup/v1"), root: z.string(), manifests: z.tuple([ManifestReference]), taskId: z.string(), issueIdentifier: z.string() }).strict();
export const SavedArchiveSelection = z.union([FlatSavedArchiveSelection, PrivateBackupSelection]);
export type SavedArchiveSelection = z.infer<typeof SavedArchiveSelection>;

/** Legacy saved archives can carry separately hashed addenda. Manifest-covered
 * entries remain historical evidence; other private files are explicitly new
 * retained observations. Neither category is discarded or mislabeled. */
export async function observeSavedArchive(value: SavedArchiveSelection) {
  const selection = SavedArchiveSelection.parse(value), { root } = selection;
  if ("format" in selection) return observePrivateBackup(selection);
  const documents = new Map<string, string>(), entries = new Map<string, { sha256: string; size?: number }>();
  for (const [index, reference] of selection.manifests.entries()) {
    const file = archiveMember(root, reference.path);
    if (documents.has(reference.path)) throw new Error("Saved archive has duplicate manifest references");
    const content = await readArchiveBytes(file, 8 * 1024 * 1024);
    if (sha(content) !== reference.sha256) throw new Error("Saved archive manifest digest changed");
    const parsed = z.object({ task: z.string().optional(), issue: z.string().optional(), mergedCommit: z.string().optional(), entries: z.array(z.object({ archivePath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative().optional() }).passthrough()).max(10_000) }).passthrough().parse(JSON.parse(content.toString()));
    if (index === 0 && (parsed.task !== selection.taskId || parsed.issue !== selection.issueIdentifier || parsed.mergedCommit !== selection.mergeCommit)) throw new Error("Saved archive belongs to another task or delivery");
    if (reference.entries !== undefined && reference.entries !== parsed.entries.length) throw new Error("Saved archive manifest count changed");
    documents.set(reference.path, reference.sha256);
    for (const entry of parsed.entries) {
      archiveMember(root, entry.archivePath);
      if (entries.has(entry.archivePath) || entries.size >= 10_000) throw new Error("Saved archive has duplicate or excessive manifest entries");
      entries.set(entry.archivePath, { sha256: entry.sha256, ...(entry.bytes !== undefined ? { size: entry.bytes } : {}) });
    }
  }
  if (!entries.size || [...documents.keys()].some(name => entries.has(name))) throw new Error("Saved archive has empty or recursive manifest coverage");
  const inventory = await privateArchiveInventory(root);
  const files = new Map(inventory.filter(entry => entry.kind === "file").map(entry => [entry.path, entry]));
  for (const [name, expected] of entries) {
    const file = files.get(name);
    if (!file || file.sha256 !== expected.sha256 || expected.size !== undefined && file.size !== expected.size) throw new Error("Saved archive member differs from its manifest");
  }
  for (const [name, expected] of documents) if (files.get(name)?.sha256 !== expected || ((files.get(name)?.mode ?? 0) & 0o7777) !== 0o600) throw new Error("Saved archive manifest identity or private mode changed during observation");
  const ancillary = [...files.values()].filter(entry => !entries.has(entry.path) && !documents.has(entry.path)).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  return { inventory, inventoryDigest: finalizationDigest(inventory), ancillary, manifestEntries: entries.size };
}

/** Backup payloads can be large logs or database exports. Keep a fixed buffer,
 * exact pre-read size and descriptor identity, never an allocation per file. */
async function observeBackupFile(file: string, limit: number) {
  await assertFinalizationPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > limit || ![0o400, 0o600, 0o700].includes(before.mode & 0o7777)) throw new Error("Backup file must be bounded, private and unshared");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error("Backup file changed during observation");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat(), leaf = await lstat(file);
    if (["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after] || before[key as keyof typeof before] !== leaf[key as keyof typeof leaf])) throw new Error("Backup file changed during observation");
    await assertFinalizationPath(file);
    return { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

/** This historical format records hashes in nested descriptors, component
 * manifests and object inventories. Other files remain newly observed retained
 * bytes; they never acquire historical backup or restore provenance. */
async function observePrivateBackup(selection: z.infer<typeof PrivateBackupSelection>) {
  const { root } = selection, Digest = z.string().regex(/^[a-f0-9]{64}$/);
  const File = z.object({ file: z.string(), sha256: Digest, bytes: z.number().int().nonnegative().optional() }).passthrough();
  const Component = z.object({ dir: z.string(), manifest: z.string(), manifestSha256: Digest, files: z.number().int().nonnegative().optional() }).passthrough();
  const Purpose = z.object({ mysql: File, postgis: File, redis: File,
    objects: z.object({ manifest: z.string(), manifestSha256: Digest, count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).passthrough(),
    runtimeConfig: Component, receipt: File.optional(),
  }).passthrough();
  const Manifest = z.object({ version: z.literal(1), taskId: z.string(), issue: z.string().optional(),
    purposes: z.object({ development: Purpose, review: Purpose }).strict(),
    evidence: z.object({ browserEvidence: Component, worktreeLocal: Component }).strict().optional(),
    git: z.object({ bundle: z.string(), sha256: Digest, bytes: z.number().int().nonnegative() }).passthrough().optional(),
  }).passthrough();
  const documents = new Map<string, string>(), entries = new Map<string, { sha256: string; size?: number }>();
  async function document(name: string, expected: string) {
    if (documents.has(name) || entries.has(name)) throw new Error("Backup has duplicate or recursive manifest references");
    const content = await readArchiveBytes(archiveMember(root, name), 8 * 1024 * 1024);
    if (sha(content) !== expected) throw new Error("Backup manifest digest changed");
    documents.set(name, expected); return content;
  }
  function member(name: string, expected: string, size?: number) {
    archiveMember(root, name);
    if (entries.has(name) || documents.has(name) || entries.size >= 10_000) throw new Error("Backup has duplicate, recursive or excessive members");
    entries.set(name, { sha256: expected, ...(size === undefined ? {} : { size }) });
  }
  async function component(value: z.infer<typeof Component>) {
    archiveMember(root, value.dir);
    const bytes = await document(value.manifest, value.manifestSha256), lines = bytes.toString("utf8").split("\n").filter(Boolean);
    if (value.files !== undefined && value.files !== lines.length) throw new Error("Backup component count changed");
    if (!lines.length) throw new Error("Backup component manifest is empty");
    for (const line of lines) {
      const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
      if (!match) throw new Error("Unsupported backup component manifest");
      const relative = match[2]!.startsWith("./") ? match[2]!.slice(2) : match[2]!;
      const file = archiveMember(archiveMember(root, value.dir), relative);
      member(path.relative(root, file), match[1]!);
    }
  }
  const first = selection.manifests[0], manifest = Manifest.parse(JSON.parse((await document(first.path, first.sha256)).toString("utf8")));
  if (manifest.taskId !== selection.taskId || manifest.issue !== undefined && manifest.issue !== selection.issueIdentifier) throw new Error("Backup belongs to another task");
  for (const value of Object.values(manifest.purposes)) {
    for (const file of [value.mysql, value.postgis, value.redis, ...(value.receipt ? [value.receipt] : [])]) member(file.file, file.sha256, file.bytes);
    const objects = z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), objects: z.array(z.object({ key: z.string(), size: z.number().int().nonnegative(), sha256: Digest }).passthrough()).max(10_000) }).passthrough()
      .parse(JSON.parse((await document(value.objects.manifest, value.objects.manifestSha256)).toString("utf8")));
    if (objects.count !== value.objects.count || objects.bytes !== value.objects.bytes || objects.count !== objects.objects.length || objects.bytes !== objects.objects.reduce((sum, entry) => sum + entry.size, 0)) throw new Error("Backup object inventory count or bytes changed");
    const objectRoot = path.join(path.dirname(archiveMember(root, value.objects.manifest)), "objects");
    for (const entry of objects.objects) member(path.relative(root, archiveMember(objectRoot, entry.key)), entry.sha256, entry.size);
    await component(value.runtimeConfig);
  }
  if (manifest.evidence) for (const value of Object.values(manifest.evidence)) await component(value);
  if (manifest.git) member(manifest.git.bundle, manifest.git.sha256, manifest.git.bytes);
  if (first.entries !== undefined && first.entries !== entries.size) throw new Error("Backup manifest count changed");
  const inventory = await privateArchiveInventory(root, true), files = new Map(inventory.filter(entry => entry.kind === "file").map(entry => [entry.path, entry]));
  for (const [name, expected] of entries) {
    const file = files.get(name);
    if (!file || file.sha256 !== expected.sha256 || expected.size !== undefined && file.size !== expected.size) throw new Error("Backup member differs from its historical manifest");
  }
  for (const [name, expected] of documents) if (files.get(name)?.sha256 !== expected) throw new Error("Backup manifest changed during observation");
  const ancillary = [...files.values()].filter(entry => !entries.has(entry.path) && !documents.has(entry.path)).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  return { inventory, inventoryDigest: finalizationDigest(inventory), ancillary, manifestEntries: entries.size };
}

