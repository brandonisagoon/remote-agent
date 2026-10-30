import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertFinalizationPath, finalizationDigest, FinalizationQuarantineJournal, inspectFinalizationQuarantine } from "./finalization-resources.ts";
import { LegacyEvidenceFile, type LegacyEvidenceProof, type LegacyEvidenceAdoptionInput } from "./legacy-evidence-schema.ts";

import { assertLegacyEvidenceTree, isEvidenceTree } from "./legacy-evidence-tree.ts";

const MAX_BYTES = 512 * 1024 * 1024;
const Relative = z.string().min(1).refine((value) => !path.isAbsolute(value) && path.normalize(value) === value && !value.split(path.sep).some((part) => part === ".." || part === "."));
const Manifest = z.object({ task: z.string(), retainedArchive: z.string(), files: z.array(z.object({ path: Relative, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })).min(1).max(10_000) });
export function within(root: string, file: string) { const relative = path.relative(root, file); return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); }
async function absent(file: string) { try { await lstat(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } }
async function privateDirectory(directory: string) {
  await assertFinalizationPath(directory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw new Error("Retained archive and quarantine directories must be private and owned by the server user");
  return stat;
}

/** A single descriptor owns hashing through close. Never follow links or
 * accept a replacement leaf, hard link, changing file, or unbounded input. */
export async function observeLegacyEvidenceFile(file: string, privateFile = false, maximumBytes = MAX_BYTES) {
  await assertFinalizationPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size > maximumBytes || maximumBytes > 2 * 1024 * 1024 * 1024 || privateFile && (before.mode & 0o7777) !== 0o600) throw new Error("Evidence must be a bounded unshared owned file; retained files must be private");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error("Evidence changed during observation");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat(), leaf = await lstat(file);
    if (["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].some((key) => before[key as keyof typeof before] !== after[key as keyof typeof after] || before[key as keyof typeof before] !== leaf[key as keyof typeof leaf])) throw new Error("Evidence changed during observation");
    await assertFinalizationPath(file);
    return LegacyEvidenceFile.parse({ path: file, dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, sha256: hash.digest("hex") });
  } finally { await handle.close(); }
}
async function assertFile(expected: z.infer<typeof LegacyEvidenceFile>, privateFile = false, file = expected.path) {
  const observed = await observeLegacyEvidenceFile(file, privateFile);
  if (finalizationDigest({ ...observed, path: expected.path }) !== finalizationDigest(expected)) throw new Error("Retained evidence identity or bytes changed");
}
function sourceFile(target: Extract<LegacyEvidenceProof["entries"][number]["target"], { type: "file" }>) {
  const { type: _type, quarantine: _quarantine, ...file } = target;
  return LegacyEvidenceFile.parse(file);
}

export async function observeLegacyArchive(input: LegacyEvidenceAdoptionInput["manifest"], taskId: string, cleanupRoots: string[]) {
  const manifest = await observeLegacyEvidenceFile(input.path, true);
  if (manifest.sha256 !== input.sha256 || manifest.size > 8 * 1024 * 1024) throw new Error("Archive manifest digest or size does not match");
  const bytes = await readFile(input.path);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("Archive manifest changed while reading");
  const root = path.dirname(input.path);
  const value = JSON.parse(bytes.toString("utf8"));
  const manifests: Array<z.infer<typeof LegacyEvidenceFile>> = [];
  let parsed: { task: string; retainedArchive: string; files: Array<{ path: string; sha256: string; bytes?: number }> };
  if (input.format === "task-backup-evidence-v1") {
    const backup = z.object({ version: z.literal(1), taskId: z.literal(taskId), evidence: z.object({ browserEvidence: z.unknown(), worktreeLocal: z.unknown() }), purposes: z.object({ development: z.object({ runtimeConfig: z.unknown() }), review: z.object({ runtimeConfig: z.unknown() }) }) }).parse(value);
    const files: Array<{ path: string; sha256: string }> = [];
    for (const raw of [backup.evidence.browserEvidence, backup.evidence.worktreeLocal, backup.purposes.development.runtimeConfig, backup.purposes.review.runtimeConfig]) {
      const component = z.object({ dir: Relative, manifest: Relative, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(raw);
      const file = path.join(root, component.manifest), observed = await observeLegacyEvidenceFile(file, true);
      if (observed.sha256 !== component.manifestSha256 || observed.size > 8 * 1024 * 1024 || manifests.some(item => item.path === file)) throw new Error("Backup evidence manifest identity changed");
      const document = await readFile(file);
      if (createHash("sha256").update(document).digest("hex") !== observed.sha256) throw new Error("Backup evidence manifest changed while reading");
      manifests.push(observed);
      for (const line of document.toString().split("\n").filter(Boolean)) {
        const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
        if (!match || files.length >= 10_000) throw new Error("Backup evidence manifest is malformed or excessive");
        const relative = Relative.parse(match[2]!.startsWith("./") ? match[2]!.slice(2) : match[2]);
        files.push({ path: path.join(component.dir, relative), sha256: match[1]! });
      }
    }
    parsed = { task: backup.taskId, retainedArchive: root, files };
  } else parsed = Manifest.parse(value);
  if (parsed.task !== taskId || parsed.retainedArchive !== root || cleanupRoots.some((candidate) => within(candidate, root) || within(root, candidate))) throw new Error("Retained archive must belong to this task and remain outside every cleanup root");
  await privateDirectory(root);
  const members = new Map<string, z.infer<typeof LegacyEvidenceFile>>();
  let total = 0;
  for (const entry of parsed.files) {
    const file = path.join(root, entry.path);
    if (members.has(file) || file === input.path || !within(root, file)) throw new Error("Archive manifest contains duplicate or invalid paths");
    for (let directory = path.dirname(file); directory !== root; directory = path.dirname(directory)) await privateDirectory(directory);
    const observed = await observeLegacyEvidenceFile(file, input.format !== "task-backup-evidence-v1", input.format ? 2 * 1024 * 1024 * 1024 : MAX_BYTES);
    if (input.format && ((observed.mode & 0o7077) !== 0 || !(observed.mode & 0o400))) throw new Error("Backup evidence members must remain owner-only regular files");
    total += observed.size;
    if (total > (input.format ? 4 * 1024 * 1024 * 1024 : MAX_BYTES)) throw new Error("Archive inventory exceeds the bounded verification limit");
    if (entry.bytes !== undefined && observed.size !== entry.bytes || observed.sha256 !== entry.sha256) throw new Error("Retained archive file does not match its manifest");
    members.set(file, observed);
  }
  await assertFile(manifest, true);
  for (const document of manifests) await assertFile(document, true);
  return { archiveRoot: root, manifest, members, ...(manifests.length ? { manifests } : {}) };
}

export async function assertLegacyRetainedCopy(proof: LegacyEvidenceProof, entry: LegacyEvidenceProof["entries"][number]) {
  await privateDirectory(proof.archiveRoot);
  for (let directory = path.dirname(entry.retained.path); directory !== proof.archiveRoot; directory = path.dirname(directory)) await privateDirectory(directory);
  await assertFile(proof.manifest, true);
  for (const document of proof.manifests ?? []) await assertFile(document, true);
  if (isEvidenceTree(entry)) await assertLegacyEvidenceTree(entry, entry.retained.path, true);
  else await assertFile(entry.retained, true);
}

/** Pending journals are restart evidence, not proof that the original is gone.
 * Confirmation requires the exact captured inode and independent retained copy. */
export async function inspectLegacyEvidenceCapture(proof: LegacyEvidenceProof, entry: LegacyEvidenceProof["entries"][number], removed: boolean) {
  await assertLegacyRetainedCopy(proof, entry);
  if (isEvidenceTree(entry)) {
    const capture = await inspectFinalizationQuarantine({ taskId: proof.taskId, resourceId: entry.resourceId, target: entry.target, quarantineParent: entry.target.quarantineParent, sourceParent: entry.target.sourceParent });
    if (removed && !capture.captured) throw new Error("Original directory evidence is still present");
    await assertLegacyEvidenceTree(entry, capture.physicalPath);
    return capture.captured ? "captured" as const : "intact" as const;
  }
  const target = entry.target, q = target.quarantine;
  if (path.dirname(q.directory) !== path.dirname(target.path) || q.path !== path.join(q.directory, "contents") || q.journal !== path.join(q.directory, "pending.json") || !path.basename(q.directory).startsWith(".drafted-evidence-")) throw new Error("Evidence quarantine identity is invalid");
  await assertFinalizationPath(target.path);
  const missing = await absent(target.path);
  if (await absent(q.directory)) {
    if (missing || removed) throw new Error("Evidence retirement lacks its recoverable capture");
    await assertFile(sourceFile(target));
    return "intact" as const;
  }
  const directory = await privateDirectory(q.directory);
  const names = await readdir(q.directory);
  if (names.some((name) => !["contents", "pending.json"].includes(name))) throw new Error("Evidence quarantine contains unexpected entries");
  if (await absent(q.journal)) {
    if (names.length || missing || removed) throw new Error("Evidence quarantine has no durable intent");
    await assertFile(sourceFile(target));
    return "intact" as const;
  }
  const journalIdentity = await observeLegacyEvidenceFile(q.journal, true);
  if (journalIdentity.size > 16_384) throw new Error("Evidence quarantine journal is too large");
  const journalBytes = await readFile(q.journal);
  if (createHash("sha256").update(journalBytes).digest("hex") !== journalIdentity.sha256) throw new Error("Evidence quarantine journal changed");
  const journal = FinalizationQuarantineJournal.parse(JSON.parse(journalBytes.toString("utf8")));
  if (journal.taskId !== proof.taskId || journal.resourceId !== entry.resourceId || journal.planDigest !== finalizationDigest(target) || journal.sourcePath !== target.path || journal.capturedPath !== q.path || journal.source.dev !== target.dev || journal.source.ino !== target.ino || journal.source.mode !== target.mode || journal.quarantine.dev !== directory.dev || journal.quarantine.ino !== directory.ino || directory.dev !== target.dev) throw new Error("Evidence quarantine journal does not match the immutable proof");
  const capturedMissing = await absent(q.path);
  if (!missing) {
    if (!capturedMissing || removed) throw new Error("Original evidence is still present or capture is ambiguous");
    await assertFile(sourceFile(target));
    return "pending" as const;
  }
  if (capturedMissing) throw new Error("Evidence capture is missing");
  await assertFile(sourceFile(target), false, q.path);
  return "captured" as const;
}
