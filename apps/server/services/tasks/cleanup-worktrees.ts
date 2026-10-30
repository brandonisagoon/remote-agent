import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { CleanupObserverBatchResult } from "./cleanup-observer-schema.ts";
import { assertCapturedDependencies, captureAdapterDependencies } from "./cleanup-filesystem.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { LinkedWorktreePlan, assertFinalizationPath, assertFinalizationTree, finalizationDigest, finalizationInventory, finalizationResourceIdentity, inspectFinalizationQuarantine,
  type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

type Worktree = z.infer<typeof LinkedWorktreePlan>;
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const missing = (file: string) => lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
async function git(cwd: string, args: string[], allowMissing = false) {
  const child = Bun.spawnSync(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (child.exitCode !== 0 && !(allowMissing && child.exitCode === 1)) throw new Error("Linked worktree identity could not be independently inspected");
  return child.stdout.toString().trimEnd();
}
function registrations(value: string) {
  return value.split("\0\0").filter(Boolean).map(block => Object.fromEntries(block.split("\0").filter(Boolean).map(line => {
    const offset = line.indexOf(" "); return offset < 0 ? [line, ""] : [line.slice(0, offset), line.slice(offset + 1)];
  })));
}
async function directory(file: string) {
  await assertFinalizationPath(file); const stat = await lstat(file);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || await realpath(file) !== file) throw new Error("Linked worktree directory is shared, unowned or redirected");
  return stat;
}
const directoryIdentity = directory;
const nodeIdentity = (stat: { dev: number; ino: number; mode: number }) => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
async function administrativeInventory(root: string, privateCopy = false) {
  const inventory: Worktree["git"]["administrativeInventory"] = [];
  let bytes = 0;
  const rootStat = await directory(root);
  async function visit(file: string) {
    if (inventory.length >= 256) throw new Error("Linked worktree administration exceeds its inventory bound");
    const stat = await lstat(file), relative = path.relative(root, file) || ".";
    if (stat.dev !== rootStat.dev || stat.uid !== process.getuid?.() || stat.mode & (privateCopy ? 0o077 : 0o022)) throw new Error("Linked worktree administration is shared or outside its filesystem");
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      inventory.push({ path: relative, kind: "directory", ...nodeIdentity(stat) });
      const names = (await readdir(file)).sort();
      for (const name of names) await visit(path.join(file, name));
      if (JSON.stringify(names) !== JSON.stringify((await readdir(file)).sort()) || finalizationDigest(nodeIdentity(await lstat(file))) !== finalizationDigest(nodeIdentity(stat))) throw new Error("Linked worktree administration changed during inspection");
    } else if (stat.isFile()) {
      bytes += stat.size; if (bytes > 64 * 1024 * 1024) throw new Error("Linked worktree administration exceeds its byte bound");
      const observed = await observeLegacyEvidenceFile(file, privateCopy, 16 * 1024 * 1024);
      inventory.push({ ...observed, path: relative, kind: "file" });
    } else throw new Error("Linked worktree administration contains an unsupported entry");
  }
  await visit(root); return inventory;
}
async function unchangedFile(expected: Worktree["git"]["index"], actualPath = expected.path) {
  const observed = await observeLegacyEvidenceFile(actualPath, false, 16 * 1024 * 1024);
  if (finalizationDigest({ ...observed, path: expected.path }) !== finalizationDigest(expected)) throw new Error("Linked worktree index or pointer identity changed");
}
async function inspectGit(worktree: string) {
  await directory(worktree);
  const pointer = await observeLegacyEvidenceFile(path.join(worktree, ".git"), false, 16_384);
  const [commonDirectory, administrativeDirectory, head, branch, root, status, sharedIndex, stage] = await Promise.all([
    git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), git(worktree, ["rev-parse", "--absolute-git-dir"]),
    git(worktree, ["rev-parse", "HEAD"]), git(worktree, ["branch", "--show-current"]), git(worktree, ["rev-parse", "--show-toplevel"]),
    git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), git(worktree, ["rev-parse", "--shared-index-path"]), git(worktree, ["ls-files", "--stage", "-z"]),
  ]);
  if (root !== worktree || status || sharedIndex || stage.split("\0").some(line => line.startsWith("160000 "))
    || await git(worktree, ["config", "--get", "core.sparseCheckout"], true) === "true") throw new Error("Linked worktree requires clean ordinary index state; preserve other states with an archive proof");
  const commonIdentity = nodeIdentity(await directory(commonDirectory)), administrativeIdentity = nodeIdentity(await directory(administrativeDirectory));
  if (administrativeDirectory === commonDirectory || path.dirname(administrativeDirectory) !== path.join(commonDirectory, "worktrees")) throw new Error("Linked worktree administrative scope changed");
  const entries = registrations(await git(worktree, ["--git-dir", commonDirectory, "worktree", "list", "--porcelain", "-z"]));
  const selected = entries.filter(entry => entry.worktree === worktree), repositoryRoot = entries[0]?.worktree;
  if (!repositoryRoot || repositoryRoot === worktree || selected.length !== 1 || selected[0]!.HEAD !== head || "locked" in selected[0]!
    || (branch ? selected[0]!.branch !== `refs/heads/${branch}` : !("detached" in selected[0]!))) throw new Error("Linked worktree registration changed");
  const repositoryIdentity = nodeIdentity(await directory(repositoryRoot));
  if (await git(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== commonDirectory) throw new Error("Linked worktree repository root changed");
  const indexPath = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (indexPath !== path.join(administrativeDirectory, "index")) throw new Error("Linked worktree uses an external index");
  const index = await observeLegacyEvidenceFile(indexPath, false, 16 * 1024 * 1024);
  const administration = await administrativeInventory(administrativeDirectory);
  const indexed = administration.find(entry => entry.path === "index");
  if (!indexed || indexed.kind !== "file") throw new Error("Linked worktree index is absent from its administration inventory");
  const { kind: _kind, ...indexedFile } = indexed;
  if (finalizationDigest({ ...indexedFile, path: index.path }) !== finalizationDigest(index)) throw new Error("Linked worktree index changed during administration inventory");
  await unchangedFile(pointer);
  return { repositoryRoot, commonDirectory, administrativeDirectory, repositoryIdentity, commonIdentity, administrativeIdentity, head, branch: branch || null, pointer, index, administrativeInventory: administration };
}

async function installedDependencies(worktree: string) {
  const tracked = new Set((await git(worktree, ["ls-files", "-z"])).split("\0").filter(Boolean));
  const lockNames = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].filter(file => tracked.has(file));
  const ignored = (await git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).split("\0").filter(Boolean);
  const result: Worktree["installedDependencies"] = [];
  for (const value of ignored) {
    const relative = value.endsWith("/") ? value.slice(0, -1) : value;
    if (path.basename(relative) !== "node_modules") continue;
    if (path.isAbsolute(relative) || path.normalize(relative) !== relative || relative.split(path.sep).includes("..")) throw new Error("Installed dependency path is invalid");
    const file = path.join(worktree, relative), packageFile = path.join(path.dirname(relative), "package.json");
    if (!lockNames.length || !tracked.has(packageFile) || await git(worktree, ["ls-files", "-z", "--", relative])) throw new Error("Installed dependencies need their tracked package and lock pins");
    const stat = await directory(file);
    const packageFiles = await Promise.all([packageFile, ...lockNames].map(relative => observeLegacyEvidenceFile(path.join(worktree, relative), false, 16 * 1024 * 1024)));
    result.push({ path: file, dev: stat.dev, ino: stat.ino, mode: stat.mode, packageFiles });
  }
  return result;
}

/** Installed dependencies remain in the retained capture. Only their exact
 * directory identities are opaque; all other source and ignored bytes hash. */
export async function prepareLinkedWorktreeCaptures(input: { resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; ownedPaths: string[]; protectedPaths: string[] }, observation: ResourceObservation) {
  const result: Worktree[] = [];
  const idle = observation.linkedRootIdle ?? observation.rootIdle;
  for (const resource of input.resources.filter(resource => resource.kind === "git-worktree" && resource.state !== "released")) {
    const root = resource.externalId;
    if (!path.isAbsolute(root) || path.normalize(root) !== root || !input.ownedPaths.includes(root) || input.protectedPaths.some(file => overlaps(root, file))) throw new Error("Linked worktree requires its exact separately owned cleanup path");
    if (input.resources.some(other => other.id !== resource.id && path.isAbsolute(other.externalId) && overlaps(root, other.externalId))) throw new Error("Linked worktree overlaps another registered resource requiring its contained plan");
    for (const retained of input.plan) if (retained.disposition === "retain-archive" && overlaps(root, retained.archive.root)) throw new Error("Linked worktree archive must survive outside its capture");
    const state = await inspectGit(root), dependencies = await installedDependencies(root), edges = captureAdapterDependencies(root, input.resources, input.plan);
    await idle(root);
    const inventory = await finalizationInventory(root, [root], new Map(dependencies.map(dependency => [dependency.path, resource.id])), new Map());
    const name = randomUUID(), directory = path.join(path.dirname(root), `.drafted-finalization-${name}`);
    const sourceParent = { path: path.dirname(state.administrativeDirectory), ...nodeIdentity(await directoryIdentity(path.dirname(state.administrativeDirectory))) };
    const quarantineParent = { path: path.dirname(root), ...nodeIdentity(await directoryIdentity(path.dirname(root))) };
    const adminDirectory = path.join(quarantineParent.path, `.drafted-finalization-${randomUUID()}`);
    if (sourceParent.dev !== quarantineParent.dev || state.administrativeIdentity.dev !== quarantineParent.dev || inventory[0]!.dev !== quarantineParent.dev
      || within(sourceParent.path, adminDirectory)) throw new Error("Linked administration requires a same-filesystem retained destination outside Git registrations");
    const plan = LinkedWorktreePlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retire-worktree", ...edges, git: state,
      target: { type: "tree", path: root, sourcePaths: [root], inventory, quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } },
      administrationCapture: { type: "tree", path: state.administrativeDirectory, sourcePaths: [state.administrativeDirectory], inventory: state.administrativeInventory, sourceParent, quarantineParent,
        quarantine: { directory: adminDirectory, path: path.join(adminDirectory, "contents"), journal: path.join(adminDirectory, "pending.json") } }, installedDependencies: dependencies });
    const destinations = [directory, plan.administrationCapture.quarantine.directory];
    if (destinations.some(destination => input.protectedPaths.some(file => overlaps(destination, file))
      || input.resources.some(other => path.isAbsolute(other.externalId) && overlaps(destination, other.externalId))
      || input.plan.some(entry => entry.disposition === "retain-archive" && overlaps(destination, entry.archive.root)))) throw new Error("Linked worktree retention destination overlaps protected or registered material");
    if (await missing(plan.administrationCapture.quarantine.directory)) throw new Error("Linked worktree administration destination already exists");
    if (finalizationDigest(await inspectGit(root)) !== finalizationDigest(state)) throw new Error("Linked worktree changed during capture preparation");
    await assertFinalizationTree(plan.target); await idle(root);
    result.push(plan);
  }
  return result;
}

async function inspectAdministration(taskId: string, plan: Worktree) {
  const target = plan.administrationCapture;
  if (target.path !== plan.git.administrativeDirectory || target.sourcePaths.length !== 1 || target.sourcePaths[0] !== target.path
    || finalizationDigest(target.inventory) !== finalizationDigest(plan.git.administrativeInventory)
    || target.sourceParent.path !== path.dirname(target.path) || target.quarantineParent.path !== path.dirname(plan.target.path)
    || target.sourceParent.dev !== target.quarantineParent.dev || target.quarantineParent.dev !== plan.target.inventory[0]?.dev
    || within(path.join(plan.git.commonDirectory, "worktrees"), target.quarantine.directory)
    || overlaps(plan.target.quarantine.directory, target.quarantine.directory)) throw new Error("Linked administration capture scope changed");
  const capture = await inspectFinalizationQuarantine({ taskId, resourceId: plan.id, target, sourceParent: target.sourceParent, quarantineParent: target.quarantineParent, ownedQuarantineParent: true });
  await assertFinalizationTree(target, capture.physicalPath);
  return capture;
}
async function assertRegistration(plan: Worktree, captured: boolean, administrationCaptured: boolean, removed: boolean) {
  const state = plan.git;
  if (finalizationDigest(nodeIdentity(await directory(state.repositoryRoot))) !== finalizationDigest(state.repositoryIdentity)
    || finalizationDigest(nodeIdentity(await directory(state.commonDirectory))) !== finalizationDigest(state.commonIdentity)) throw new Error("Linked worktree repository filesystem identity changed");
  if (await git(state.repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== state.commonDirectory) throw new Error("Linked worktree common repository changed");
  const entries = registrations(await git(state.repositoryRoot, ["--git-dir", state.commonDirectory, "worktree", "list", "--porcelain", "-z"])).filter(entry => entry.worktree === plan.target.path);
  if (entries.length > 1 || entries.some(entry => entry.HEAD !== state.head || "locked" in entry || (state.branch ? entry.branch !== `refs/heads/${state.branch}` : !("detached" in entry)))) throw new Error("Linked worktree registration changed");
  if (!captured) {
    if (finalizationDigest(await inspectGit(plan.target.path)) !== finalizationDigest(state)) throw new Error("Prepared linked worktree Git state changed");
  } else {
    if ((removed || administrationCaptured) && entries.length) throw new Error("Captured linked worktree registration is still present");
    if (!administrationCaptured && entries.length !== 1) throw new Error("Linked registration disappeared without its exact administration capture");
    const admin = await missing(state.administrativeDirectory);
    if (entries.length) { if (!admin || finalizationDigest(nodeIdentity(admin)) !== finalizationDigest(state.administrativeIdentity)) throw new Error("Linked worktree administrative state disappeared or changed before registration removal");
      if (finalizationDigest(await administrativeInventory(state.administrativeDirectory)) !== finalizationDigest(state.administrativeInventory)) throw new Error("Linked worktree administrative contents changed before registration removal"); }
    else if (admin) throw new Error("Removed linked worktree administrative directory was recreated");
  }
}
export async function assertLinkedWorktreeCaptures(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; removed: boolean; adapterObservation?: z.infer<typeof CleanupObserverBatchResult> }, observation: ResourceObservation) {
  const idle = observation.linkedRootIdle ?? observation.rootIdle;
  for (const plan of input.plan.filter((entry): entry is Worktree => entry.disposition === "retire-worktree")) {
    const resource = input.resources.find(resource => resource.id === plan.id)!;
    if (plan.kind !== "git-worktree" || plan.target.path !== resource.externalId || plan.target.sourcePaths.length !== 1 || plan.target.sourcePaths[0] !== plan.target.path) throw new Error("Prepared linked worktree path changed");
    const capture = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: plan.id, target: plan.target });
    const removed = input.removed || resource.state === "released";
    if (removed && !capture.captured) throw new Error("Linked worktree has no retained capture");
    await assertFinalizationTree(plan.target, capture.physicalPath);
    const administration = await inspectAdministration(input.taskId, plan);
    if (administration.captured && !capture.captured) throw new Error("Linked administration cannot retire before its source capture");
    if (removed && !administration.captured) throw new Error("Linked worktree has no verified administration capture");
    await assertRegistration(plan, capture.captured, administration.captured, removed);
    const opaque = plan.target.inventory.filter(entry => entry.kind === "opaque");
    if (opaque.length !== plan.installedDependencies.length || opaque.some(entry => entry.dependencyResourceId !== plan.id || !plan.installedDependencies.some(dependency => dependency.path === path.join(plan.target.path, entry.path) && dependency.dev === entry.dev && dependency.ino === entry.ino && dependency.mode === entry.mode))) throw new Error("Opaque dependency scope changed");
    for (const dependency of plan.installedDependencies) for (const file of dependency.packageFiles) {
      if (!within(plan.target.path, file.path)) throw new Error("Dependency package pin is outside its worktree");
      await unchangedFile(file, path.join(capture.physicalPath, path.relative(plan.target.path, file.path)));
    }
    if (capture.captured) assertCapturedDependencies(plan, input.resources, input.adapterObservation);
    await idle(plan.target.path);
    if (capture.captured) await idle(capture.physicalPath);
    await idle(plan.administrationCapture.path);
    if (administration.captured) await idle(administration.physicalPath);
    const freshAdministration = await inspectAdministration(input.taskId, plan);
    if (freshAdministration.captured !== administration.captured || freshAdministration.physicalPath !== administration.physicalPath) throw new Error("Linked administration capture changed during observation");
    const fresh = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: plan.id, target: plan.target });
    if (fresh.captured !== capture.captured || fresh.physicalPath !== capture.physicalPath) throw new Error("Linked worktree capture changed during observation");
    if (input.removed && resource.state !== "released") throw new Error("Linked worktree retirement has not been recorded");
  }
}
