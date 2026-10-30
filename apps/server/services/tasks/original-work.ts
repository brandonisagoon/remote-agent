import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { observeCompletionSnapshot } from "./completion-observation.ts";
import { assertFinalizationPath, assertFinalizationTree, finalizationDigest, finalizationInventory, finalizationResourceIdentity, finalizationResourceObservation, inspectFinalizationQuarantine, type FinalizationResourceRecord } from "./finalization-resources.ts";
import { OriginalWork, OriginalWorkInput, OriginalWorkSnapshot } from "./original-work-schema.ts";

const MAX_BYTES = 512 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);
function member(root: string, relative: string) {
  if (!relative || relative === "." || path.isAbsolute(relative) || path.normalize(relative) !== relative || relative.split(path.sep).includes("..") || relative.includes("\0")) throw new Error("Archive member has an unsafe path");
  const file = path.join(root, relative);
  if (!inside(root, file)) throw new Error("Archive member escapes its root");
  return file;
}
async function bytes(file: string, limit = MAX_BYTES) {
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
async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false; const timeout = setTimeout(() => { timedOut = true; child.kill(9); }, 30_000);
  const bounded = async (stream: ReadableStream<Uint8Array>, limit: number) => {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) return Buffer.concat(chunks); length += value.byteLength; if (length > limit) { child.kill(9); throw new Error("Original-work Git output exceeded its bound"); } chunks.push(value); } }
    finally { reader.releaseLock(); }
  };
  try {
    const [out, err, code] = await Promise.all([bounded(child.stdout, MAX_BYTES), bounded(child.stderr, 1024 * 1024), child.exited]);
    if (timedOut || code !== 0 || out.byteLength > MAX_BYTES || err.byteLength > 1024 * 1024) throw new Error("Original-work Git proof failed");
    return Buffer.from(out);
  } finally { clearTimeout(timeout); }
}
const textGit = async (cwd: string, args: string[]) => (await git(cwd, args)).toString().trimEnd();
const snapshot = (cwd: string) => observeCompletionSnapshot(cwd, { async run(command, args, options) {
  if (command !== "git" || !options?.cwd) throw new Error("Unexpected original-work observation command");
  return { ok: true, stdout: (await git(options.cwd, args)).toString(), stderr: "" };
} });

/** Decode only regular files/directories. Never extract archive-supplied links,
 * devices, absolute names or traversal paths through a host tar command. */
export function originalWorkTar(buffer: Buffer) {
  const files = new Map<string, { bytes: Buffer; executable: boolean }>();
  let offset = 0, pendingPath: string | undefined, ended = false;
  const text = (value: Buffer) => value.toString("utf8").replace(/\0.*$/s, "");
  const number = (value: Buffer) => { const raw = text(value).trim(); if (!/^[0-7]*$/.test(raw)) throw new Error("Unsupported tar numeric encoding"); return raw ? parseInt(raw, 8) : 0; };
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512); offset += 512;
    if (header.every((byte) => byte === 0)) { ended = true; if (buffer.subarray(offset).some((byte) => byte !== 0)) throw new Error("Unexpected tar trailing data"); break; }
    const checksum = number(header.subarray(148, 156)); let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
    const size = number(header.subarray(124, 136)), mode = number(header.subarray(100, 108));
    if (sum !== checksum || size > MAX_BYTES || offset + size > buffer.length) throw new Error("Invalid bounded tar member");
    const content = buffer.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (type === "x") {
      if (pendingPath !== undefined) throw new Error("Duplicate tar extended header");
      let cursor = 0;
      while (cursor < content.length) {
        const space = content.indexOf(32, cursor); const length = Number(content.subarray(cursor, space).toString());
        if (space < cursor || !Number.isSafeInteger(length) || length < 5 || cursor + length > content.length || content[cursor + length - 1] !== 10) throw new Error("Invalid tar extended record");
        const entry = content.subarray(space + 1, cursor + length - 1).toString(); const split = entry.indexOf("=");
        if (split < 1) throw new Error("Invalid tar extended record");
        const key = entry.slice(0, split), value = entry.slice(split + 1);
        if (key === "path") { if (pendingPath !== undefined) throw new Error("Duplicate extended path"); pendingPath = value; }
        else if (["linkpath", "size", "GNU.sparse.map", "GNU.sparse.size"].includes(key)) throw new Error("Unsupported tar extended identity");
        cursor += length;
      }
      continue;
    }
    const prefix = text(header.subarray(345, 500)); let name = pendingPath ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join("/"); pendingPath = undefined;
    if (name.startsWith("./")) name = name.slice(2);
    if (type === "5" && name.endsWith("/")) name = name.slice(0, -1);
    member("/archive", name);
    if (name === ".git" || name.startsWith(".git/") || files.has(name)) throw new Error("Unsafe or duplicate tar member");
    if (type === "5") { if (size !== 0) throw new Error("Invalid tar directory"); continue; }
    if (type !== "0") throw new Error("Only regular untracked files may be restored");
    if (files.size >= 10000) throw new Error("Too many untracked archive files");
    files.set(name, { bytes: Buffer.from(content), executable: Boolean(mode & 0o111) });
  }
  if (!ended || pendingPath !== undefined) throw new Error("Incomplete tar archive");
  return files;
}

async function dirtySnapshot(worktree: string) {
  const observed = await snapshot(worktree);
  const indexPatch = await git(worktree, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--cached", "HEAD"]);
  const worktreePatch = await git(worktree, ["diff", "--binary", "--no-ext-diff", "--no-textconv"]);
  const paths = (await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean).sort();
  const untracked = [];
  for (const relative of paths) { const file = member(worktree, relative), content = await bytes(file); untracked.push({ path: relative, size: content.length, sha256: sha(content), executable: Boolean((await lstat(file)).mode & 0o111) }); }
  return OriginalWorkSnapshot.parse({ ...observed, indexPatchSha256: sha(indexPatch), worktreePatchSha256: sha(worktreePatch), untracked });
}

async function archiveObservation(root: string, manifestPath: string, manifestSha256: string, format: "sha256-lines" | "files-v1" = "sha256-lines") {
  if (!inside(root, manifestPath)) throw new Error("Manifest must be inside its registered archive");
  const manifest = await bytes(manifestPath, 8 * 1024 * 1024);
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
  for (const { name, digest, size } of listed) {
    const file = member(root, name);
    if (file === manifestPath || entries.has(name) || entries.size >= 10000) throw new Error("Archive manifest has duplicate or recursive members");
    const content = await bytes(file); total += content.length;
    if (total > MAX_BYTES || sha(content) !== digest || size !== undefined && content.length !== size) throw new Error("Archive member does not match its manifest");
    entries.set(name, digest);
  }
  if (!entries.size) throw new Error("Archive manifest is empty");
  const inventory = await finalizationInventory(root, [root], new Map(), new Map());
  for (const entry of inventory) {
    if (entry.kind === "symlink" || entry.kind === "opaque" || entry.kind === "file" && path.join(root, entry.path) !== manifestPath && entries.get(entry.path) !== entry.sha256) throw new Error("Archive contains unmanifested or unsupported material");
    if ((entry.mode & 0o7777) !== (entry.kind === "directory" ? 0o700 : 0o600)) throw new Error("Retained archive must be private");
  }
  return { inventory, inventoryDigest: finalizationDigest(inventory), entries };
}

export async function prepareOriginalWork(input: { taskId: string; toolingRevision?: string; worktree: string; branch: string; approvedHead: string; resources: FinalizationResourceRecord[]; originalWork: OriginalWorkInput }, observation = finalizationResourceObservation) {
  const selection = OriginalWorkInput.parse(input.originalWork);
  const resource = input.resources.find((entry) => entry.id === selection.archiveResourceId);
  if (!resource || resource.kind !== "source-archive" || resource.state === "released") throw new Error("Original work requires its exact retained archive resource");
  const root = resource.externalId, worktree = input.worktree;
  await assertFinalizationPath(root); await assertFinalizationPath(worktree);
  if (await realpath(root) !== root || await realpath(worktree) !== worktree || root === worktree || inside(root, worktree) || inside(worktree, root)) throw new Error("Retained archive must be outside the original cleanup tree");
  if (selection.ownedPaths.some((file) => !inside(worktree, file))) throw new Error("Original owned paths must stay inside the original worktree");
  const snapshot = await dirtySnapshot(worktree);
  if (snapshot.head !== input.approvedHead || snapshot.branch !== input.branch) throw new Error("Original archive must retain the original owner-approved HEAD and branch");
  const archive = await archiveObservation(root, selection.manifestPath, selection.manifestSha256);
  const additionalArchives: NonNullable<OriginalWork["additionalArchives"]> = [];
  const archiveIds = new Set([resource.id]);
  for (const selected of selection.additionalArchives ?? []) {
    const record = input.resources.find((entry) => entry.id === selected.resourceId);
    if (!record || record.kind !== "source-archive" || record.state === "released" || archiveIds.has(record.id)) throw new Error("Additional archive requires a distinct exact retained resource");
    archiveIds.add(record.id);
    if (record.externalId === worktree || inside(worktree, record.externalId) || inside(record.externalId, worktree) || record.externalId === root || inside(root, record.externalId) || inside(record.externalId, root)) throw new Error("Retained archive roots must be separate from cleanup and one another");
    const observed = await archiveObservation(record.externalId, selected.manifestPath, selected.manifestSha256, selected.format);
    additionalArchives.push({ resourceId: record.id, identityDigest: finalizationResourceIdentity(record).identityDigest, root: record.externalId, manifestPath: selected.manifestPath, manifestSha256: selected.manifestSha256, format: selected.format, inventory: observed.inventory, inventoryDigest: observed.inventoryDigest });
  }
  const retainedResults: NonNullable<OriginalWork["retainedResults"]> = [], resultIds = new Set<string>();
  for (const selected of selection.retainedResults ?? []) {
    const record = input.resources.find((entry) => entry.id === selected.resourceId);
    if (!record || record.state === "released" || !["rubin-chat", "rubin-property-revision", "studio-site-snapshot"].includes(record.kind) || resultIds.has(record.id)) throw new Error("Historical results require distinct exact supported resource identities");
    resultIds.add(record.id);
    const expectedDigest = archive.entries.get(selected.provenancePath);
    if (!expectedDigest || !input.toolingRevision) throw new Error("Historical result provenance must belong to the retained archive and original tooling pin");
    const provenancePath = member(root, selected.provenancePath), content = await bytes(provenancePath, 8 * 1024 * 1024);
    if (sha(content) !== expectedDigest) throw new Error("Historical result provenance changed");
    const provenance = z.object({ taskId: z.literal(input.taskId), toolingRevision: z.literal(input.toolingRevision), resources: z.array(z.object({ key: z.string(), kind: z.string(), purpose: z.string(), externalId: z.string(), state: z.string() }).strict()).max(10000) }).passthrough().parse(JSON.parse(content.toString()));
    const matches = provenance.resources.filter((entry) => entry.key === record.key);
    if (matches.length !== 1 || matches[0]!.kind !== record.kind || matches[0]!.purpose !== record.purpose || matches[0]!.externalId !== record.externalId) throw new Error("Historical result does not match its archived task identity");
    retainedResults.push({ resourceId: record.id, identityDigest: finalizationResourceIdentity(record).identityDigest, provenancePath, provenanceSha256: expectedDigest });
  }
  for (const name of [selection.bundlePath, selection.indexPatchPath, selection.worktreePatchPath, selection.untrackedArchivePath]) if (!archive.entries.has(name)) throw new Error("Restore input is not covered by the retained manifest");
  const indexPatch = await bytes(member(root, selection.indexPatchPath)), worktreePatch = await bytes(member(root, selection.worktreePatchPath));
  if (sha(indexPatch) !== snapshot.indexPatchSha256 || sha(worktreePatch) !== snapshot.worktreePatchSha256) throw new Error("Archived staged or unstaged changes do not match the original");
  const untracked = originalWorkTar(await bytes(member(root, selection.untrackedArchivePath)));
  if (untracked.size !== snapshot.untracked.length || snapshot.untracked.some((entry) => { const archived = untracked.get(entry.path); return !archived || archived.bytes.length !== entry.size || sha(archived.bytes) !== entry.sha256 || archived.executable !== entry.executable; })) throw new Error("Archived untracked files do not match the original");
  const common = await realpath(await textGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "drafted-original-restore-"))); await chmod(temporary, 0o700);
  let restore: OriginalWork["restore"];
  try {
    await git(temporary, ["init", "--quiet"]);
    // Only the temporary repository receives writes. Read-only alternates
    // supply thin-bundle prerequisites; the original index/objects stay intact.
    await writeFile(path.join(temporary, ".git/objects/info/alternates"), `${path.join(common, "objects")}\n`, { mode: 0o600 });
    const bundlePath = member(root, selection.bundlePath), bundle = await bytes(bundlePath);
    const headerEnd = bundle.indexOf(Buffer.from("\n\n"));
    if (headerEnd < 0 || headerEnd > 1024 * 1024) throw new Error("Invalid bounded Git bundle header");
    const prerequisiteCommits = bundle.subarray(0, headerEnd).toString().split("\n").filter((line) => line.startsWith("-")).map((line) => line.slice(1, 41));
    if (prerequisiteCommits.length > 1000 || prerequisiteCommits.some((value) => !/^[a-f0-9]{40}$/.test(value))) throw new Error("Invalid bundle prerequisites");
    await git(temporary, ["bundle", "verify", bundlePath]);
    await git(temporary, ["fetch", "--no-tags", bundlePath, `${selection.bundleRef}:refs/heads/restored-original`]);
    if (await textGit(temporary, ["rev-parse", "refs/heads/restored-original"]) !== snapshot.head) throw new Error("Archive bundle does not retain the original HEAD");
    await git(temporary, ["checkout", "--quiet", "-B", snapshot.branch, snapshot.head]);
    if (indexPatch.length) await git(temporary, ["apply", "--binary", "--index", member(root, selection.indexPatchPath)]);
    const indexTree = await textGit(temporary, ["write-tree"]);
    if (worktreePatch.length) await git(temporary, ["apply", "--binary", member(root, selection.worktreePatchPath)]);
    for (const [relative, entry] of untracked) { const file = member(temporary, relative); await assertFinalizationPath(file); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, entry.bytes, { flag: "wx", mode: entry.executable ? 0o700 : 0o600 }); }
    const restored = await dirtySnapshot(temporary);
    if (restored.fingerprint !== snapshot.fingerprint) throw new Error("Independent archive restore differs from the original working content");
    if (finalizationDigest(restored) !== finalizationDigest(snapshot)) throw new Error("Independent archive restore changed the original staged or untracked classification");
    await git(temporary, ["add", "--all", "--force", "--", "."]);
    const workingTree = await textGit(temporary, ["write-tree"]);
    if (workingTree !== selection.expectedWorkingTree) throw new Error("Independent archive restore differs from the selected content tree");
    restore = { gitDirectory: common, head: snapshot.head, indexTree, workingTree, fingerprint: restored.fingerprint, bundleSha256: sha(bundle), prerequisiteCommits };
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const ignored = (await git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean);
  for (const name of ignored) if (!selection.ownedPaths.some((owned) => member(worktree, name) === owned || inside(owned, member(worktree, name)))) throw new Error("Ignored original material needs explicit owner-adopted paths");
  await observation.rootIdle(worktree);
  const inventory = await finalizationInventory(worktree, [worktree], new Map(), new Map());
  const directory = path.join(path.dirname(worktree), `.drafted-finalization-${randomUUID()}`);
  const proof = OriginalWork.parse({ version: 1, captureId: `original-worktree:${input.taskId}`, archive: { resourceId: resource.id, identityDigest: finalizationResourceIdentity(resource).identityDigest, root, manifestPath: selection.manifestPath, manifestSha256: selection.manifestSha256, inventory: archive.inventory, inventoryDigest: archive.inventoryDigest }, ...(additionalArchives.length ? { additionalArchives } : {}), ...(retainedResults.length ? { retainedResults } : {}), snapshot, restore,
    target: { type: "tree", path: worktree, inventory, sourcePaths: [worktree], quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } });
  await assertOriginalWork({ taskId: input.taskId, originalWork: proof, resources: input.resources, removed: false }, observation);
  return proof;
}

export async function assertOriginalWork(input: { taskId: string; originalWork: OriginalWork; resources: FinalizationResourceRecord[]; removed: boolean }, observation = finalizationResourceObservation) {
  const proof = OriginalWork.parse(input.originalWork), resource = input.resources.find((entry) => entry.id === proof.archive.resourceId);
  if (proof.captureId !== `original-worktree:${input.taskId}` || !resource || resource.kind !== "source-archive" || resource.externalId !== proof.archive.root || resource.state === "released" || finalizationResourceIdentity(resource).identityDigest !== proof.archive.identityDigest) throw new Error("Original archive resource identity changed");
  for (const expected of [proof.archive, ...proof.additionalArchives ?? []]) {
    const record = input.resources.find((entry) => entry.id === expected.resourceId);
    if (!record || record.kind !== "source-archive" || record.state === "released" || record.externalId !== expected.root || finalizationResourceIdentity(record).identityDigest !== expected.identityDigest) throw new Error("Retained archive resource identity changed");
    const archive = await archiveObservation(expected.root, expected.manifestPath, expected.manifestSha256, expected.format);
    if (archive.inventoryDigest !== expected.inventoryDigest || finalizationDigest(expected.inventory) !== archive.inventoryDigest) throw new Error("Retained archive changed since adoption");
  }
  for (const result of proof.retainedResults ?? []) {
    const record = input.resources.find((entry) => entry.id === result.resourceId);
    if (!record || record.state === "released" || finalizationResourceIdentity(record).identityDigest !== result.identityDigest || sha(await bytes(result.provenancePath)) !== result.provenanceSha256) throw new Error("Historical result identity or provenance changed");
  }
  await assertFinalizationPath(proof.restore.gitDirectory);
  if (await realpath(proof.restore.gitDirectory) !== proof.restore.gitDirectory || await textGit(proof.restore.gitDirectory, ["rev-parse", "--verify", `refs/heads/${proof.snapshot.branch}`]) !== proof.snapshot.head) throw new Error("Original retained branch or repository changed");
  for (const prerequisite of proof.restore.prerequisiteCommits) if (await textGit(proof.restore.gitDirectory, ["rev-parse", "--verify", `${prerequisite}^{commit}`]) !== prerequisite) throw new Error("Retained thin-bundle prerequisite is unavailable");
  const capture = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: proof.captureId, target: proof.target });
  await assertFinalizationTree(proof.target, capture.physicalPath);
  if (input.removed && !capture.captured) throw new Error("Original work has not been preserved in quarantine");
  if (!capture.captured && finalizationDigest(await dirtySnapshot(proof.target.path)) !== finalizationDigest(proof.snapshot)) throw new Error("Original staged, unstaged or untracked state changed since adoption");
  await observation.rootIdle(proof.target.path);
  if (capture.captured) await observation.rootIdle(capture.physicalPath);
}
