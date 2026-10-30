import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readArchiveBytes } from "./archive-observation.ts";
import { administrativeInventory } from "./cleanup-worktrees.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { assertFinalizationPath, assertFinalizationTree, finalizationDigest, inspectFinalizationQuarantine, type ResourceObservation } from "./finalization-resources.ts";
import { finalizationWorktrees } from "./finalization-receipts.ts";
import { OriginalWorkAdministration, type OriginalWork } from "./original-work-schema.ts";
import { originalWorkDirtySnapshot, originalWorkTextGit as git } from "./original-work-git.ts";

const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const missing = (file: string) => lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
const identity = (stat: { dev: number; ino: number; mode: number }) => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
async function directory(file: string) {
  await assertFinalizationPath(file);
  const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o022 || await realpath(file) !== file) throw new Error("Original administration directory ownership changed");
  return identity(stat);
}
async function selectedRegistration(proof: OriginalWork) {
  const entries = finalizationWorktrees(await git(proof.restore.gitDirectory, ["--git-dir", proof.restore.gitDirectory, "worktree", "list", "--porcelain", "-z"]));
  const selected = entries.filter(entry => entry.worktree === proof.target.path);
  if (selected.length > 1 || selected.some(entry => entry.HEAD !== proof.snapshot.head || entry.branch !== `refs/heads/${proof.snapshot.branch}` || "locked" in entry)) throw new Error("Original worktree registration changed");
  return { entries, selected };
}

/** The current admin must correspond to the saved source, including its index.
 * A captured source is inspected with its explicit work-tree path; no index
 * refresh, checkout, reset or Git administrative write is permitted. */
async function observeAdministration(proof: OriginalWork, physicalSource: string) {
  const pointer = await observeLegacyEvidenceFile(path.join(physicalSource, ".git"), false, 16384);
  const expectedPointer = proof.target.inventory.find(entry => entry.path === ".git");
  if (!expectedPointer || expectedPointer.kind !== "file" || finalizationDigest({ ...pointer, path: ".git", kind: "file" }) !== finalizationDigest(expectedPointer)) throw new Error("Captured original Git pointer differs from its saved inventory");
  const bytes = await readArchiveBytes(pointer.path, 16384);
  if (createHash("sha256").update(bytes).digest("hex") !== pointer.sha256) throw new Error("Original Git pointer changed during observation");
  const match = /^gitdir: (\/[^\n\r\0]+)\n?$/.exec(bytes.toString());
  const commonDirectory = proof.restore.gitDirectory, administrativeDirectory = match?.[1];
  if (!administrativeDirectory || path.normalize(administrativeDirectory) !== administrativeDirectory || path.dirname(administrativeDirectory) !== path.join(commonDirectory, "worktrees")) throw new Error("Original Git pointer does not name one exact linked administration directory");
  const commonIdentity = await directory(commonDirectory), administrativeIdentity = await directory(administrativeDirectory);
  const backPointer = (await readArchiveBytes(path.join(administrativeDirectory, "gitdir"), 16384)).toString().trimEnd();
  if (backPointer !== path.join(proof.target.path, ".git")) throw new Error("Original administration points to another worktree");
  const args = ["--git-dir", administrativeDirectory, "--work-tree", physicalSource];
  const [common, head, branch, indexPath, sharedIndex] = await Promise.all([
    git(physicalSource, [...args, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(physicalSource, [...args, "rev-parse", "HEAD"]), git(physicalSource, [...args, "symbolic-ref", "--short", "HEAD"]),
    git(physicalSource, [...args, "rev-parse", "--path-format=absolute", "--git-path", "index"]), git(physicalSource, [...args, "rev-parse", "--shared-index-path"]),
  ]);
  if (path.resolve(common) !== commonDirectory || head !== proof.snapshot.head || branch !== proof.snapshot.branch || indexPath !== path.join(administrativeDirectory, "index") || sharedIndex) throw new Error("Original administrative Git identity or index scope changed");
  const { entries, selected } = await selectedRegistration(proof), repositoryRoot = entries[0]?.worktree;
  if (selected.length !== 1 || !repositoryRoot || repositoryRoot === proof.target.path || within(proof.target.path, repositoryRoot)) throw new Error("Original worktree has no exact independent repository registration");
  const repositoryIdentity = await directory(repositoryRoot);
  if (await git(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== commonDirectory) throw new Error("Original common repository changed");
  const index = await observeLegacyEvidenceFile(indexPath, false, 16 * 1024 * 1024), inventory = await administrativeInventory(administrativeDirectory);
  if (finalizationDigest({ ...index, path: "index", kind: "file" }) !== finalizationDigest(inventory.find(entry => entry.path === "index"))) throw new Error("Original index changed during observation");
  if (finalizationDigest(await originalWorkDirtySnapshot(physicalSource, administrativeDirectory)) !== finalizationDigest(proof.snapshot)) throw new Error("Original staged, unstaged or untracked snapshot differs from its archive proof");
  if (finalizationDigest(await administrativeInventory(administrativeDirectory)) !== finalizationDigest(inventory)) throw new Error("Original administration changed during snapshot verification");
  return { repositoryRoot, commonDirectory, administrativeDirectory, repositoryIdentity, commonIdentity, administrativeIdentity, head, branch,
    pointer: { ...pointer, path: path.join(proof.target.path, ".git") }, index, administrativeInventory: inventory };
}

export async function prepareOriginalAdministration(taskId: string, proof: OriginalWork) {
  const source = await inspectFinalizationQuarantine({ taskId, resourceId: proof.captureId, target: proof.target });
  await assertFinalizationTree(proof.target, source.physicalPath);
  const state = await observeAdministration(proof, source.physicalPath);
  const sourceParent = { path: path.dirname(state.administrativeDirectory), ...await directory(path.dirname(state.administrativeDirectory)) };
  const quarantineParent = { path: path.dirname(proof.target.path), ...await directory(path.dirname(proof.target.path)) };
  const destination = path.join(quarantineParent.path, `.drafted-finalization-${randomUUID()}`);
  if (sourceParent.dev !== quarantineParent.dev || state.administrativeIdentity.dev !== quarantineParent.dev || proof.target.inventory[0]?.dev !== quarantineParent.dev
    || within(sourceParent.path, destination) || overlaps(proof.target.quarantine.directory, destination) || await missing(destination)) throw new Error("Original administration requires an unused same-filesystem retained destination");
  return OriginalWorkAdministration.parse({ git: state, administrationCapture: { type: "tree", path: state.administrativeDirectory, sourcePaths: [state.administrativeDirectory], inventory: state.administrativeInventory,
    sourceParent, quarantineParent, quarantine: { directory: destination, path: path.join(destination, "contents"), journal: path.join(destination, "pending.json") } } });
}

export async function assertOriginalAdministration(input: { taskId: string; originalWork: OriginalWork; administration: OriginalWorkAdministration; removed: boolean }, observation: ResourceObservation) {
  const proof = input.originalWork, administration = OriginalWorkAdministration.parse(input.administration), target = administration.administrationCapture, state = administration.git;
  const source = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: proof.captureId, target: proof.target });
  if (state.commonDirectory !== proof.restore.gitDirectory || state.head !== proof.snapshot.head || state.branch !== proof.snapshot.branch
    || state.pointer.path !== path.join(proof.target.path, ".git") || state.index.path !== path.join(state.administrativeDirectory, "index")
    || path.dirname(state.administrativeDirectory) !== path.join(state.commonDirectory, "worktrees") || target.path !== state.administrativeDirectory
    || target.sourcePaths.length !== 1 || target.sourcePaths[0] !== target.path || finalizationDigest(target.inventory) !== finalizationDigest(state.administrativeInventory)
    || target.sourceParent.path !== path.dirname(target.path) || target.quarantineParent.path !== path.dirname(proof.target.path)
    || path.dirname(target.quarantine.directory) !== target.quarantineParent.path || within(path.join(state.commonDirectory, "worktrees"), target.quarantine.directory)
    || overlaps(proof.target.quarantine.directory, target.quarantine.directory) || overlaps(proof.target.path, target.quarantine.directory)
    || [state.administrativeIdentity.dev, target.sourceParent.dev, target.quarantineParent.dev].some(dev => dev !== proof.target.inventory[0]?.dev)) throw new Error("Original administration capture scope changed");
  for (const expected of [target.sourceParent, target.quarantineParent, { path: state.commonDirectory, ...state.commonIdentity }, { path: state.repositoryRoot, ...state.repositoryIdentity }])
    if (finalizationDigest(await directory(expected.path)) !== finalizationDigest(identity(expected))) throw new Error("Original administration parent or repository changed");
  const captured = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: proof.captureId, target, sourceParent: target.sourceParent, quarantineParent: target.quarantineParent, ownedQuarantineParent: true });
  await assertFinalizationTree(target, captured.physicalPath);
  if (captured.captured && !source.captured || input.removed && !captured.captured) throw new Error("Original source must be captured before its exact administration");
  const { selected } = await selectedRegistration(proof);
  if (captured.captured) {
    if (selected.length || await missing(state.administrativeDirectory)) throw new Error("Original administration or registration was recreated");
  } else if (selected.length !== 1 || finalizationDigest(await observeAdministration(proof, source.physicalPath)) !== finalizationDigest(state)) throw new Error("Original administration correspondence changed");
  await observation.rootIdle(state.administrativeDirectory);
  if (captured.captured) await observation.rootIdle(captured.physicalPath);
  await assertFinalizationTree(target, captured.physicalPath);
  const after = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: proof.captureId, target, sourceParent: target.sourceParent, quarantineParent: target.quarantineParent, ownedQuarantineParent: true });
  if (after.captured !== captured.captured || after.physicalPath !== captured.physicalPath) throw new Error("Original administration changed during verification");
}

/** Historical retirement has no administration capture to invent. Require the
 * saved source pointer and its exact linked entry both independently absent. */
export async function originalAdministrationAlreadyRetired(taskId: string, proof: OriginalWork) {
  const source = await inspectFinalizationQuarantine({ taskId, resourceId: proof.captureId, target: proof.target });
  if (!source.captured) return false;
  const pointer = await observeLegacyEvidenceFile(path.join(source.physicalPath, ".git"), false, 16384);
  const expected = proof.target.inventory.find(entry => entry.path === ".git");
  if (!expected || finalizationDigest({ ...pointer, path: ".git", kind: "file" }) !== finalizationDigest(expected)) throw new Error("Retired original pointer changed");
  const match = /^gitdir: (\/[^\n\r\0]+)\n?$/.exec((await readArchiveBytes(pointer.path, 16384)).toString());
  const admin = match?.[1];
  if (!admin || path.normalize(admin) !== admin || path.dirname(admin) !== path.join(proof.restore.gitDirectory, "worktrees")) throw new Error("Retired original pointer scope changed");
  return !(await selectedRegistration(proof)).selected.length && !await missing(admin);
}
