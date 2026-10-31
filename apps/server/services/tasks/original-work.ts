import { prepareInstalledDependencies, assertInstalledDependencies } from "./installed-dependencies.ts";
import { assertOriginalAdministration, prepareOriginalAdministration } from "./original-work-administration.ts";
import { archiveMember as member, readArchiveBytes as bytes, observeArchive as archiveObservation } from "./archive-observation.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { originalWorkGit as git, originalWorkTextGit as textGit, originalWorkDirtySnapshot as dirtySnapshot } from "./original-work-git.ts";
import { assertFinalizationPath, assertFinalizationTree, finalizationDigest, finalizationInventory, finalizationResourceIdentity, finalizationResourceObservation, inspectFinalizationQuarantine, RetainedArchivePlan, RetainedArchiveMemberPlan, RetainedResultPlan, type RetainedMaterialPlan, type FinalizationResourceRecord } from "./finalization-resources.ts";
import { OriginalWork, OriginalWorkInput, type RecoveryWorkInput } from "./original-work-schema.ts";
import { observeRecoveryArchive, assertRecoveryContents, recoveryTarMembers } from "./recovery-archive.ts";
import { restoreRecoveryTar, type RecoveryTarMember } from "./recovery-tar.ts";
import { assertMacArchiveMetadata } from "./apple-double.ts";
import { preparationStage } from "./preparation-diagnostics.ts";

const MAX_BYTES = 512 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);
export function originalWorkRetainedPlans(originalWork: OriginalWork, resources: FinalizationResourceRecord[]): RetainedMaterialPlan[] {
  const proof = OriginalWork.parse(originalWork);
  const identity = (id: string, digest: string) => { const resource = resources.find(entry => entry.id === id); if (!resource || resource.state === "released" || finalizationResourceIdentity(resource).identityDigest !== digest) throw new Error("Retained original resource identity changed"); return finalizationResourceIdentity(resource); };
  return [
    ...[proof.archive, ...proof.additionalArchives ?? []].map(archive => RetainedArchivePlan.parse({ ...identity(archive.resourceId, archive.identityDigest), disposition: "retain-archive", archive: { root: archive.root, manifestPath: archive.manifestPath, manifestSha256: archive.manifestSha256, inventoryDigest: archive.inventoryDigest } })),
    ...(proof.retainedResults ?? []).map(result => RetainedResultPlan.parse({ ...identity(result.resourceId, result.identityDigest), disposition: "retain-result", reference: { archiveResourceId: proof.archive.resourceId, provenancePath: result.provenancePath, provenanceSha256: result.provenanceSha256 } })),
    ...(proof.retainedArchiveMembers ?? []).map(member => RetainedArchiveMemberPlan.parse({ ...identity(member.resourceId, member.identityDigest), disposition: "retain-archive-member", archive: { resourceId: member.archiveResourceId, root: proof.archive.root, inventoryDigest: proof.archive.inventoryDigest }, file: { path: member.path, size: member.size, sha256: member.sha256 } })),
  ];
}
/** Decode only regular files/directories. Never extract archive-supplied links,
 * devices, absolute names or traversal paths through a host tar command. */
export function originalWorkTar(buffer: Buffer) {
  const files = new Map<string, { bytes: Buffer; executable: boolean; mode: number }>();
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
    files.set(name, { bytes: Buffer.from(content), executable: Boolean(mode & 0o111), mode });
  }
  if (!ended || pendingPath !== undefined) throw new Error("Incomplete tar archive");
  return files;
}

/** Classification needs the independently observed Git files, never a filename
 * prefix alone. A genuine expected ._ file remains ordinary restore content. */
export function originalWorkUntrackedTar(buffer: Buffer, expectedPaths: ReadonlySet<string>) {
  const files = originalWorkTar(buffer), metadata: string[] = [];
  for (const [name, entry] of files) {
    if (expectedPaths.has(name)) continue;
    const base = path.posix.basename(name), paired = path.posix.join(path.posix.dirname(name), base.slice(2));
    if (!base.startsWith("._") || base.length === 2 || !expectedPaths.has(paired) || !files.has(paired) || entry.mode & 0o7111) throw new Error("Unlisted or ambiguous original tar member");
    assertMacArchiveMetadata(entry.bytes);
    metadata.push(name); files.delete(name);
  }
  return { files, metadata };
}

export async function verifyOriginalBundleArchive(input: { worktree: string; branch: string; approvedHead: string; root: string; selection: Pick<import("./original-work-schema.ts").BundleOriginalWorkSelection, "manifestPath" | "manifestSha256" | "bundlePath" | "bundleRef" | "indexPatchPath" | "worktreePatchPath" | "untrackedArchivePath" | "expectedWorkingTree" | "ownedPaths"> }) {
  const { worktree, root, selection } = input;
  await assertFinalizationPath(root); await assertFinalizationPath(worktree);
  if (await realpath(root) !== root || await realpath(worktree) !== worktree || root === worktree || inside(root, worktree) || inside(worktree, root)) throw new Error("Retained archive must be outside the original cleanup tree");
  if (selection.ownedPaths.some((file) => !inside(worktree, file))) throw new Error("Original owned paths must stay inside the original worktree");
  const snapshot = await dirtySnapshot(worktree);
  if (snapshot.head !== input.approvedHead || snapshot.branch !== input.branch) throw new Error("Original archive must retain the original owner-approved HEAD and branch");
  const archive = await archiveObservation(root, selection.manifestPath, selection.manifestSha256);
  for (const name of [selection.bundlePath, selection.indexPatchPath, selection.worktreePatchPath, selection.untrackedArchivePath]) if (!archive.entries.has(name)) throw new Error("Restore input is not covered by the retained manifest");
  const indexPatch = await bytes(member(root, selection.indexPatchPath)), worktreePatch = await bytes(member(root, selection.worktreePatchPath));
  if (sha(indexPatch) !== snapshot.indexPatchSha256 || sha(worktreePatch) !== snapshot.worktreePatchSha256) throw new Error("Archived staged or unstaged changes do not match the original");
  const { files: untracked, metadata } = originalWorkUntrackedTar(await bytes(member(root, selection.untrackedArchivePath)), new Set(snapshot.untracked.map(entry => entry.path)));
  for (const name of metadata) {
    try { await lstat(member(worktree, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new Error("Archive metadata collides with an original source path");
  }
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
  return { snapshot, archive, restore };
}

export async function prepareOriginalWork(input: { taskId: string; toolingRevision?: string; worktree: string; branch: string; approvedHead: string; resources: FinalizationResourceRecord[]; originalWork: OriginalWorkInput }, observation = finalizationResourceObservation) {
  const selection = OriginalWorkInput.parse(input.originalWork);
  if ("format" in selection) return prepareRecoveryOriginalWork({ ...input, originalWork: selection }, observation);
  const resource = input.resources.find((entry) => entry.id === selection.archiveResourceId);
  if (!resource || resource.kind !== "source-archive" || resource.state === "released") throw new Error("Original work requires its exact retained archive resource");
  const root = resource.externalId, worktree = input.worktree;
  const { snapshot, archive, restore } = await verifyOriginalBundleArchive({ worktree, branch: input.branch, approvedHead: input.approvedHead, root, selection });
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
  const ignored = (await git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean);
  for (const name of ignored) if (!selection.ownedPaths.some((owned) => member(worktree, name) === owned || inside(owned, member(worktree, name)))) throw new Error("Ignored original material needs explicit owner-adopted paths");
  const installedDependencies = await prepareInstalledDependencies(worktree);
  const idle = installedDependencies.length ? observation.linkedRootIdle ?? observation.rootIdle : observation.rootIdle;
  await idle(worktree);
  const inventory = await finalizationInventory(worktree, [worktree], new Map(installedDependencies.map(dependency => [dependency.path, `original-worktree:${input.taskId}`])), new Map());
  const directory = path.join(path.dirname(worktree), `.drafted-finalization-${randomUUID()}`);
  const proof = OriginalWork.parse({ version: 1, ...(installedDependencies.length ? { installedDependencies } : {}), captureId: `original-worktree:${input.taskId}`, archive: { resourceId: resource.id, identityDigest: finalizationResourceIdentity(resource).identityDigest, root, manifestPath: selection.manifestPath, manifestSha256: selection.manifestSha256, inventory: archive.inventory, inventoryDigest: archive.inventoryDigest }, ...(additionalArchives.length ? { additionalArchives } : {}), ...(retainedResults.length ? { retainedResults } : {}), snapshot, restore,
    target: { type: "tree", path: worktree, inventory, sourcePaths: [worktree], quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } });
  proof.administration = await prepareOriginalAdministration(input.taskId, proof);
  await assertOriginalWork({ taskId: input.taskId, originalWork: proof, resources: input.resources, removed: false }, observation);
  return proof;
}

type RecoveryOriginalInput = { taskId: string; toolingRevision?: string; worktree: string; branch: string; approvedHead: string; resources: FinalizationResourceRecord[]; originalWork: RecoveryWorkInput };
/** Read-only source/archive verification. Temporary restore writes never grant
 * cleanup authority, register resources, or change the original checkout. */
export async function verifyRecoveryOriginal(input: RecoveryOriginalInput) {
  const selection = input.originalWork, resource = input.resources.find(entry => entry.id === selection.archiveResourceId), worktree = input.worktree;
  if (!resource || resource.kind !== "recovery-archive" || resource.purpose !== "tooling" || resource.state === "released") throw new Error("Recovery work requires its exact retained archive resource");
  const root = resource.externalId;
  await assertFinalizationPath(worktree);
  if (await realpath(worktree) !== worktree || root === worktree || inside(root, worktree) || inside(worktree, root) || selection.ownedPaths.some(file => !inside(worktree, file))) throw new Error("Recovery archive and owned paths overlap or escape the original worktree");
  const original = await dirtySnapshot(worktree), archive = await observeRecoveryArchive(root, selection), receipt = archive.receipt;
  if (original.head !== input.approvedHead || original.branch !== input.branch || receipt.task !== input.taskId || receipt.source !== worktree || receipt.base !== original.head || receipt.branch !== original.branch || !input.toolingRevision || receipt.toolingPin !== input.toolingRevision) throw new Error("Recovery archive belongs to another original task, source or tooling revision");
  const recorded = z.record(z.string(), z.unknown()).parse(resource.metadata ?? {});
  for (const [key, observed] of Object.entries({ base: receipt.base, toolingPin: receipt.toolingPin, manifestSha256: selection.manifestSha256, baseArchiveSha256: archive.inputs.get("base.tar.gz")!.sha256, workArchiveSha256: archive.inputs.get("work.tar.gz")!.sha256 })) {
    if (recorded[key] !== undefined && recorded[key] !== observed) throw new Error("Recovery archive conflicts with its recorded identity or digest");
  }
  const indexPatch = await bytes(member(root, "index.patch")), worktreePatch = await bytes(member(root, "tracked.patch"));
  if (sha(indexPatch) !== original.indexPatchSha256 || sha(worktreePatch) !== original.worktreePatchSha256 || !(await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).equals(await bytes(member(root, "status.porcelain")))) throw new Error("Recovery staged, unstaged or untracked status changed");
  if (!(await git(worktree, ["ls-tree", "-r", "-l", "HEAD"])).equals(await bytes(member(root, "base-tree.txt")))) throw new Error("Recovery base tree differs from the original Git tree");
  const tree = new Map<string, RecoveryTarMember>();
  for (const line of (await git(worktree, ["ls-tree", "-r", "-l", "-z", "HEAD"])).toString().split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/s.exec(line);
    if (!match) throw new Error("Recovery base contains unsupported Git entries");
    const name = match[4]!, size = Number(match[3]); member(worktree, name);
    if (!Number.isSafeInteger(size) || tree.has(name)) throw new Error("Recovery base contains duplicate or oversized entries");
    tree.set(name, { kind: match[1] === "120000" ? "symlink" : "file", executable: match[1] !== "100644", size, gitSha: match[2]! });
  }
  const tracked = new Set((await git(worktree, ["ls-files", "--cached", "-z"])).toString().split("\0").filter(Boolean));
  const currentPaths = new Set([...tracked, ...original.untracked.map(entry => entry.path)]);
  const deleted = new Set((await git(worktree, ["ls-files", "--deleted", "-z"])).toString().split("\0").filter(Boolean)); for (const file of deleted) currentPaths.delete(file);
  if (currentPaths.size !== archive.members.size || [...currentPaths].some(name => !archive.members.has(name)) || archive.manifest.some(entry => entry.untracked !== original.untracked.some(file => file.path === entry.path))) throw new Error("Recovery manifest does not cover exact tracked and untracked source paths");
  const changes = archive.manifest.filter(entry => entry.changed || entry.untracked);
  const changedNames = (await bytes(member(root, "changed-files.txt"))).toString().trimEnd().split("\n").filter(Boolean);
  if (new Set(changedNames).size !== changedNames.length || JSON.stringify([...changedNames].sort()) !== JSON.stringify(changes.map(entry => entry.path).sort())) throw new Error("Recovery changed-file list disagrees with its manifest");
  const common = await realpath(await textGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "drafted-recovery-restore-"))); await chmod(temporary, 0o700);
  let restore: OriginalWork["restore"];
  try {
    await git(temporary, ["init", "--quiet"]);
    await writeFile(path.join(temporary, ".git/objects/info/alternates"), `${path.join(common, "objects")}\n`, { mode: 0o600 });
    await git(temporary, ["update-ref", `refs/heads/${original.branch}`, original.head]);
    await git(temporary, ["symbolic-ref", "HEAD", `refs/heads/${original.branch}`]);
    await git(temporary, ["read-tree", "HEAD"]);
    const base = archive.inputs.get("base.tar.gz")!, work = archive.inputs.get("work.tar.gz")!;
    await restoreRecoveryTar({ path: member(root, base.file), size: base.size, sha256: base.sha256 }, tree, temporary);
    if (indexPatch.length) await git(temporary, ["apply", "--binary", "--index", member(root, "index.patch")]);
    const indexTree = await textGit(temporary, ["write-tree"]);
    if (worktreePatch.length) await git(temporary, ["apply", "--binary", member(root, "tracked.patch")]);
    await restoreRecoveryTar({ path: member(root, work.file), size: work.size, sha256: work.sha256 }, recoveryTarMembers(changes), temporary, { appleDouble: true, write: name => archive.members.get(name)!.untracked });
    await assertRecoveryContents(temporary, archive.manifest, true);
    const restored = await dirtySnapshot(temporary);
    if (finalizationDigest(restored) !== finalizationDigest(original)) throw new Error("Independent recovery restore differs from original staged, unstaged or untracked content");
    await git(temporary, ["add", "--all", "--force", "--", "."]);
    restore = { format: "base-work-tar/v1", gitDirectory: common, head: original.head, indexTree, workingTree: await textGit(temporary, ["write-tree"]), fingerprint: restored.fingerprint, baseArchiveSha256: base.sha256, workArchiveSha256: work.sha256 };
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const retainedArchiveMembers: NonNullable<OriginalWork["retainedArchiveMembers"]> = [], selectedIds = new Set<string>();
  for (const selected of selection.retainedArchiveMembers ?? []) {
    const record = input.resources.find(entry => entry.id === selected.resourceId);
    const file = record && archive.inventory.find(entry => entry.kind === "file" && member(root, entry.path) === record.externalId);
    if (!record || record.kind !== "resource-inventory" || record.purpose !== "tooling" || record.state === "released" || selectedIds.has(record.id) || !file || file.kind !== "file") throw new Error("Retained archive member requires an exact owned resource inventory file");
    selectedIds.add(record.id);
    const content = z.object({ task: z.literal(input.taskId) }).passthrough().parse(JSON.parse((await bytes(record.externalId, 8 * 1024 * 1024)).toString()));
    void content;
    retainedArchiveMembers.push({ resourceId: record.id, identityDigest: finalizationResourceIdentity(record).identityDigest, archiveResourceId: resource.id, path: record.externalId, size: file.size, sha256: file.sha256 });
  }
  if (finalizationDigest(await dirtySnapshot(worktree)) !== finalizationDigest(original)) throw new Error("Original source changed during recovery verification");
  return { selection, resource, original, archive, restore, retainedArchiveMembers };
}

async function prepareRecoveryOriginalWork(input: RecoveryOriginalInput, observation: typeof finalizationResourceObservation) {
  const { selection, resource, original, archive, restore, retainedArchiveMembers } = await verifyRecoveryOriginal(input), worktree = input.worktree, root = resource.externalId;
  const ignored = (await git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean);
  for (const name of ignored) if (!selection.ownedPaths.some(owned => member(worktree, name) === owned || inside(owned, member(worktree, name)))) throw new Error("Ignored original material needs explicit owner-adopted paths");
  if (finalizationDigest(await dirtySnapshot(worktree)) !== finalizationDigest(original)) throw new Error("Original source changed during recovery verification");
  const installedDependencies = await prepareInstalledDependencies(worktree);
  const idle = installedDependencies.length ? observation.linkedRootIdle ?? observation.rootIdle : observation.rootIdle;
  await idle(worktree);
  const inventory = await finalizationInventory(worktree, [worktree], new Map(installedDependencies.map(dependency => [dependency.path, `original-worktree:${input.taskId}`])), new Map()), directory = path.join(path.dirname(worktree), `.drafted-finalization-${randomUUID()}`);
  const proof = OriginalWork.parse({ version: 1, ...(installedDependencies.length ? { installedDependencies } : {}), captureId: `original-worktree:${input.taskId}`, archive: { resourceId: resource.id, identityDigest: finalizationResourceIdentity(resource).identityDigest, root, manifestPath: selection.manifestPath, manifestSha256: selection.manifestSha256, format: selection.format, recovery: selection, inventory: archive.inventory, inventoryDigest: archive.inventoryDigest }, ...(retainedArchiveMembers.length ? { retainedArchiveMembers } : {}), snapshot: original, restore, target: { type: "tree", path: worktree, inventory, sourcePaths: [worktree], quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } });
  proof.administration = await prepareOriginalAdministration(input.taskId, proof);
  await assertOriginalWork({ taskId: input.taskId, originalWork: proof, resources: input.resources, removed: false }, observation);
  return proof;
}

export async function assertOriginalWork(input: { taskId: string; originalWork: OriginalWork; resources: FinalizationResourceRecord[]; removed: boolean }, observation = finalizationResourceObservation) {
  const proof = OriginalWork.parse(input.originalWork), resource = input.resources.find((entry) => entry.id === proof.archive.resourceId);
  const recovery = proof.archive.format === "base-work-tar/v1";
  if (proof.captureId !== `original-worktree:${input.taskId}` || !resource || (recovery ? resource.kind !== "recovery-archive" || resource.purpose !== "tooling" : resource.kind !== "source-archive") || resource.externalId !== proof.archive.root || resource.state === "released" || finalizationResourceIdentity(resource).identityDigest !== proof.archive.identityDigest) throw new Error("Original archive resource identity changed");
  for (const expected of [proof.archive, ...proof.additionalArchives ?? []]) {
    const record = input.resources.find((entry) => entry.id === expected.resourceId);
    if (!record || (expected.format === "base-work-tar/v1" ? record.kind !== "recovery-archive" || record.purpose !== "tooling" : record.kind !== "source-archive") || record.state === "released" || record.externalId !== expected.root || finalizationResourceIdentity(record).identityDigest !== expected.identityDigest) throw new Error("Retained archive resource identity changed");
    if (expected.format === "base-work-tar/v1" && (!expected.recovery || expected.recovery.archiveResourceId !== expected.resourceId || expected.recovery.manifestPath !== expected.manifestPath || expected.recovery.manifestSha256 !== expected.manifestSha256)) throw new Error("Recovery archive selection changed");
    const archive = expected.format === "base-work-tar/v1" ? await observeRecoveryArchive(expected.root, expected.recovery!) : await archiveObservation(expected.root, expected.manifestPath, expected.manifestSha256, expected.format);
    if (archive.inventoryDigest !== expected.inventoryDigest || finalizationDigest(expected.inventory) !== archive.inventoryDigest) throw new Error("Retained archive changed since adoption");
  }
  for (const member of proof.retainedArchiveMembers ?? []) {
    const record = input.resources.find(entry => entry.id === member.resourceId), entry = proof.archive.inventory.find(entry => entry.kind === "file" && path.join(proof.archive.root, entry.path) === member.path);
    if (!record || record.kind !== "resource-inventory" || record.purpose !== "tooling" || record.state === "released" || record.externalId !== member.path || finalizationResourceIdentity(record).identityDigest !== member.identityDigest || member.archiveResourceId !== proof.archive.resourceId || !entry || entry.kind !== "file" || entry.sha256 !== member.sha256 || entry.size !== member.size) throw new Error("Retained archive member identity changed");
  }
  for (const result of proof.retainedResults ?? []) {
    const record = input.resources.find((entry) => entry.id === result.resourceId);
    if (!record || record.state === "released" || finalizationResourceIdentity(record).identityDigest !== result.identityDigest || sha(await bytes(result.provenancePath)) !== result.provenanceSha256) throw new Error("Historical result identity or provenance changed");
  }
  await assertOriginalWorkCapture({ taskId: input.taskId, originalWork: proof, removed: input.removed }, observation);
}

export async function assertOriginalWorkCapture(input: { taskId: string; originalWork: import("./original-work-schema.ts").OriginalWorkCapture; removed: boolean }, observation = finalizationResourceObservation) {
  const proof = input.originalWork;
  if (proof.captureId !== `original-worktree:${input.taskId}`) throw new Error("Original source capture belongs to another task");
  await preparationStage("original-worktree", async () => {
    await assertFinalizationPath(proof.restore.gitDirectory);
    if (await realpath(proof.restore.gitDirectory) !== proof.restore.gitDirectory || await textGit(proof.restore.gitDirectory, ["rev-parse", "--verify", `refs/heads/${proof.snapshot.branch}`]) !== proof.snapshot.head) throw new Error("Original retained branch or repository changed");
    for (const prerequisite of "prerequisiteCommits" in proof.restore ? proof.restore.prerequisiteCommits : []) if (await textGit(proof.restore.gitDirectory, ["rev-parse", "--verify", `${prerequisite}^{commit}`]) !== prerequisite) throw new Error("Retained thin-bundle prerequisite is unavailable");
    const capture = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: proof.captureId, target: proof.target });
    await assertInstalledDependencies(proof.target, proof.installedDependencies ?? [], proof.captureId, capture.physicalPath);
    await assertFinalizationTree(proof.target, capture.physicalPath);
    if (input.removed && !capture.captured) throw new Error("Original work has not been preserved in quarantine");
    if (!capture.captured && finalizationDigest(await dirtySnapshot(proof.target.path)) !== finalizationDigest(proof.snapshot)) throw new Error("Original staged, unstaged or untracked state changed since adoption");
    const idle = proof.installedDependencies?.length ? observation.linkedRootIdle ?? observation.rootIdle : observation.rootIdle;
    await idle(proof.target.path);
    if (capture.captured) await idle(capture.physicalPath);
  });
  if (proof.administration) await preparationStage("git-administration", () => assertOriginalAdministration({ taskId: input.taskId, originalWork: proof, administration: proof.administration!, removed: input.removed }, observation));
}
