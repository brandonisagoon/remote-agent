import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { z } from "zod";
import type { CleanupObserverBatchResult } from "./cleanup-observer-schema.ts";
import { ContainedFilePlan, RegisteredTreePlan, assertFinalizationPath, assertFinalizationTree, finalizationDigest, finalizationInventory, finalizationResourceIdentity, inspectFinalizationQuarantine,
  type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { readArchiveBytes } from "./archive-observation.ts";

type Tree = Extract<FinalizationResourcePlan, { disposition: "retire-tree" }>;
type Child = Extract<FinalizationResourcePlan, { disposition: "retire-contained" }>;
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const missing = (file: string) => lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
const directories = new Set(["directory", "private-directory", "source-checkpoint"]);
const files = new Set(["private-file", "evidence"]);
export function hasRegisteredCaptureResource(resource: FinalizationResourceRecord, resources: FinalizationResourceRecord[]) {
  return directories.has(resource.kind) || files.has(resource.kind) && path.isAbsolute(resource.externalId)
    && resources.some(root => root.id !== resource.id && directories.has(root.kind) && path.isAbsolute(root.externalId) && within(root.externalId, resource.externalId));
}

function referencePaths(value: unknown, depth = 0): string[] {
  if (depth > 20) throw new Error("Resource path references exceed their inspection bound");
  if (typeof value === "string") return path.isAbsolute(value) && path.normalize(value) === value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(item => referencePaths(item, depth + 1));
  if (value && typeof value === "object") return Object.values(value).flatMap(item => referencePaths(item, depth + 1));
  return [];
}
export function captureAdapterDependencies(root: string, resources: FinalizationResourceRecord[], plan: FinalizationResourcePlan[]) {
  const dependencies = new Set<string>(), stoppedConsumers = new Set<string>();
  for (const { adapter, retained } of plan.flatMap(entry => entry.disposition === "retire-adapter" ? [{ adapter: entry, retained: false }] : entry.disposition === "retire-vault" ? [{ adapter: entry.vault, retained: false }] : entry.disposition === "retain-adapter" ? [{ adapter: entry.adapterPlan, retained: true }] : [])) {
    for (const target of adapter.targets) {
      const required = "runtimeFile" in target.scope ? [target.scope.runtimeFile, target.scope.credentialsFile] : target.kind === "native-family" ? [target.proof.file]
        : "credentials" in target.scope ? [target.scope.credentials.backupFile, target.scope.credentials.keyFile] : target.kind === "browser-auth-entry" ? [target.scope.keyFile] : [];
      if (retained && "compose" in target.scope && target.scope.compose) required.push(target.scope.compose.file);
      if (required.some(file => within(root, file))) throw new Error("Independent final confirmation inputs must survive outside filesystem capture");
    }
    const record = resources.find(other => other.id === adapter.id)!;
    if (![...referencePaths(record.metadata), ...referencePaths(adapter.targets)].some(file => within(root, file))) continue;
    if (adapter.targets.some(target => target.kind === "native-family")) stoppedConsumers.add(adapter.id);
    else dependencies.add(adapter.id);
  }
  return { dependencies: [...dependencies].sort(), stoppedConsumers: [...stoppedConsumers].sort() };
}
export function assertCapturedDependencies(entry: { dependencies: string[]; stoppedConsumers: string[] }, resources: FinalizationResourceRecord[], observed?: z.infer<typeof CleanupObserverBatchResult>) {
  for (const id of entry.dependencies) if (resources.find(record => record.id === id)?.state !== "released") throw new Error("Captured directory still has an unreleased dependent adapter");
  for (const id of entry.stoppedConsumers) {
    const consumer = observed?.observations.find(entry => entry.resourceId === id), families = consumer?.targets.filter(target => target.kind === "native-family" || target.kind === "browser-session") ?? [];
    if (!consumer || !families.length || families.some(target => consumer.presentTargetDigests.includes(target.identityDigest))) throw new Error("Captured directory still has an active or unverified native consumer");
  }
}

export async function privateRoot(root: string) {
  await assertFinalizationPath(root);
  const stat = await lstat(root), parent = await lstat(path.dirname(root));
  if (path.parse(root).root === root || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700
    || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0 || parent.dev !== stat.dev) throw new Error("Registered capture requires an exact private owned root and parent on one filesystem");
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    if (await missing(path.join(cursor, ".git"))) throw new Error("Registered directory capture cannot include a Git checkout; use its explicit worktree plan");
    if (cursor === path.dirname(cursor)) break;
  }
}

async function checkpointManifest(resource: FinalizationResourceRecord, physicalRoot = resource.externalId) {
  await assertFinalizationPath(physicalRoot);
  const stat = await lstat(physicalRoot), parent = await lstat(path.dirname(physicalRoot));
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022 || !parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o022 || stat.dev !== parent.dev) throw new Error("Checkpoint root must be exact, owned and not shared writable");
  const metadata = resource.metadata as Record<string, unknown> | null, manifest = metadata?.manifest;
  if (typeof manifest !== "string" || typeof metadata?.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.manifestSha256)) throw new Error("Checkpoint requires its recorded manifest digest");
  const original = path.isAbsolute(manifest) ? manifest : path.join(resource.externalId, manifest);
  if (path.normalize(original) !== original || original === resource.externalId || !within(resource.externalId, original)) throw new Error("Checkpoint manifest leaves its exact root");
  const file = path.join(physicalRoot, path.relative(resource.externalId, original)), observed = await observeLegacyEvidenceFile(file, false, 8 * 1024 * 1024);
  if (observed.sha256 !== metadata.manifestSha256) throw new Error("Checkpoint manifest differs from its recorded digest");
  const content = await readArchiveBytes(file, 8 * 1024 * 1024);
  if (createHash("sha256").update(content).digest("hex") !== observed.sha256) throw new Error("Checkpoint manifest changed while reading");
  const members = new Map<string, string>();
  for (const line of content.toString().split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line), relative = match?.[2]?.replace(/^\.\//, "");
    if (!match || !relative || path.isAbsolute(relative) || path.normalize(relative) !== relative || relative === "." || relative.split(path.sep).includes("..") || members.has(relative) || members.size >= 10000) throw new Error("Checkpoint manifest contains an invalid or duplicate member");
    members.set(relative, match[1]!);
  }
  if (!members.size) throw new Error("Checkpoint manifest is empty");
  return { manifest: { ...observed, path: original }, members };
}
function assertCheckpointMembers(inventory: Tree["target"]["inventory"], members: Map<string, string>) {
  for (const [relative, sha256] of members) {
    const entry = inventory.find(entry => entry.path === relative);
    if (!entry || entry.kind !== "file" || entry.sha256 !== sha256) throw new Error("Checkpoint bytes differ from their recorded manifest");
  }
}

/** The directory receipt, existing owner path selection and full frozen tree
 * identify the capture. A common path prefix never invents a parent receipt. */
export async function prepareRegisteredCaptures(input: { resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; ownedPaths: string[]; protectedPaths: string[] }, observation: ResourceObservation) {
  const roots = input.resources.filter(resource => resource.state !== "released" && directories.has(resource.kind));
  if (!roots.length) return [];
  const result: Array<Tree | Child> = [];
  for (const resource of roots) {
    const root = resource.externalId;
    if (!path.isAbsolute(root) || path.normalize(root) !== root || !input.ownedPaths.includes(root)) throw new Error("Registered directory must be selected by its exact existing owner path scope");
    if (input.protectedPaths.some(file => overlaps(root, file)) || roots.some(other => other.id !== resource.id && overlaps(root, other.externalId))) throw new Error("Registered directory overlaps a protected or another capture root");
    for (const entry of input.plan) {
      if (entry.disposition === "retain-archive" && overlaps(root, entry.archive.root) || entry.disposition === "retain-archive-member" && within(root, entry.file.path)) throw new Error("Retained archive must survive outside registered cleanup roots");
    }
    const edges = captureAdapterDependencies(root, input.resources, input.plan);
    const browsers = input.plan.filter(entry => entry.disposition === "retire-browser" && entry.capture.type === "registered" && entry.capture.parentResourceId === resource.id);
    edges.stoppedConsumers.push(...browsers.map(entry => entry.id));
    const checkpoint = resource.kind === "source-checkpoint" ? await checkpointManifest(resource) : undefined;
    if (!checkpoint) await privateRoot(root);
    else for (let directory = root; ; directory = path.dirname(directory)) {
      if (await missing(path.join(directory, ".git"))) throw new Error("Checkpoint cannot replace an explicit Git worktree plan");
      if (directory === path.dirname(directory)) break;
    }
    await observation.rootIdle(root);
    const children = input.resources.filter(other => other.id !== resource.id && path.isAbsolute(other.externalId) && within(root, other.externalId));
    if (children.some(child => child.externalId === root || !files.has(child.kind) && !browsers.some(browser => browser.id === child.id) || child.state === "released")) throw new Error("Registered root contains a resource without an exact contained-file plan");
    const inventory = await finalizationInventory(root, [root], new Map(browsers.map(browser => [browser.externalId, browser.id])), new Map(children.filter(child => files.has(child.kind)).map(child => [child.externalId, child.id])));
    if (inventory.some(entry => entry.path.split(path.sep).includes(".git"))) throw new Error("Registered directory contains Git metadata requiring a worktree plan");
    if (checkpoint) assertCheckpointMembers(inventory, checkpoint.members);
    for (const entry of inventory) {
      const stat = await lstat(path.join(root, entry.path));
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 && entry.kind !== "symlink") throw new Error("Registered inventory contains unowned or shared writable material");
    }
    const directory = path.join(path.dirname(root), `.drafted-finalization-${randomUUID()}`);
    const tree = RegisteredTreePlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retire-tree", treeKind: checkpoint ? "source-checkpoint" : "registered-directory", ...(checkpoint ? { manifest: checkpoint.manifest } : {}),
      ...edges, target: { type: "tree", path: root, inventory, sourcePaths: [root],
        quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } });
    result.push(tree);
    for (const child of children) {
      if (browsers.some(browser => browser.id === child.id)) continue;
      const entry = inventory.find(entry => entry.path === path.relative(root, child.externalId));
      if (!entry || entry.kind !== "file") throw new Error("Contained file receipt is not an exact regular inventory member");
      const metadata = child.metadata as Record<string, unknown> | null;
      const sizes = [metadata?.bytes, metadata?.size, metadata?.byteSize].filter(value => value !== undefined);
      if (metadata?.sha256 !== undefined && metadata.sha256 !== entry.sha256 || sizes.some(size => size !== entry.size)) throw new Error("Contained evidence does not match its recorded bytes");
      result.push(ContainedFilePlan.parse({ ...finalizationResourceIdentity(child), disposition: "retire-contained", parentResourceId: tree.id, dependencies: [tree.id],
        target: { type: "file", path: child.externalId, dev: entry.dev, ino: entry.ino, mode: entry.mode, size: entry.size, sha256: entry.sha256 } }));
    }
    await assertFinalizationTree(tree.target);
    await observation.rootIdle(root);
    if (checkpoint) {
      const fresh = await checkpointManifest(resource);
      if (finalizationDigest(fresh.manifest) !== finalizationDigest(checkpoint.manifest)) throw new Error("Checkpoint changed during process observation");
      await assertFinalizationTree(tree.target);
    }
  }
  return result;
}

/** This query is local authority, not a filesystem observer. It also runs on
 * renewals so another task cannot acquire a recorded path inside the capture. */
export async function assertRegisteredCaptureSharing(prisma: Pick<PrismaClient, "remoteTaskResource">, taskId: string, plan: FinalizationResourcePlan[]) {
  const { assertClerkCleanupSharing } = await import("./cleanup-clerk.ts");
  await assertClerkCleanupSharing(prisma, taskId, plan);
  const roots = plan.filter(entry => entry.disposition === "retire-tree" || entry.disposition === "retire-worktree" || entry.disposition === "retire-file" || entry.disposition === "retire-vault");
  const scopes = roots.flatMap(entry => [entry.target.path, entry.target.quarantine.directory, ...(entry.disposition === "retire-worktree" ? [entry.administrationCapture.path, entry.administrationCapture.quarantine.directory] : [])]);
  for (const browser of plan) if (browser.disposition === "retire-browser" && browser.capture.type === "standalone") scopes.push(browser.capture.target.path, browser.capture.target.quarantine.directory);
  if (!scopes.length) return;
  const ancestors = new Set<string>();
  for (const scope of scopes) for (let cursor = scope; ; cursor = path.dirname(cursor)) { ancestors.add(cursor); if (cursor === path.dirname(cursor)) break; }
  const shared = await prisma.remoteTaskResource.findFirst({ where: { taskId: { not: taskId }, OR: [
    { externalId: { in: plan.filter(entry => entry.disposition === "retire-vault").map(entry => entry.externalId) } },
    { externalId: { in: [...ancestors] } }, ...scopes.map(scope => ({ externalId: { startsWith: `${scope}${path.sep}` } })),
  ] } });
  if (shared) throw new Error("Registered capture overlaps another task's recorded resource");
}

export async function assertRegisteredCaptures(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; removed: boolean; adapterObservation?: z.infer<typeof CleanupObserverBatchResult> }, observation: ResourceObservation) {
  const trees = input.plan.filter((entry): entry is Tree => entry.disposition === "retire-tree");
  const children = input.plan.filter((entry): entry is Child => entry.disposition === "retire-contained");
  if (children.some(child => !trees.some(tree => tree.id === child.parentResourceId) || child.dependencies.length !== 1 || child.dependencies[0] !== child.parentResourceId)) throw new Error("Contained resource has no exact prepared parent");
  for (const tree of trees) {
    if (!directories.has(tree.kind) || tree.target.path !== tree.externalId || tree.target.sourcePaths.length !== 1 || tree.target.sourcePaths[0] !== tree.target.path) throw new Error("Registered capture root identity changed");
    if (trees.some(other => other.id !== tree.id && overlaps(tree.target.path, other.target.path))) throw new Error("Registered capture roots overlap");
    const record = input.resources.find(record => record.id === tree.id)!;
    const captured = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: tree.id, target: tree.target });
    if ((input.removed || record.state === "released") && !captured.captured) throw new Error("Registered directory has no verified retained capture");
    await assertFinalizationTree(tree.target, captured.physicalPath);
    if (tree.treeKind === "source-checkpoint") {
      const checkpoint = await checkpointManifest(record, captured.physicalPath);
      if (finalizationDigest(checkpoint.manifest) !== finalizationDigest(tree.manifest)) throw new Error("Prepared checkpoint manifest identity changed");
      assertCheckpointMembers(tree.target.inventory, checkpoint.members);
    } else if (tree.kind === "source-checkpoint") throw new Error("Checkpoint lacks its exact manifest plan");
    if (captured.captured) assertCapturedDependencies(tree, input.resources, input.adapterObservation);
    for (const child of children.filter(child => child.parentResourceId === tree.id)) {
      const current = input.resources.find(record => record.id === child.id)!;
      const relative = path.relative(tree.target.path, child.target.path), member = tree.target.inventory.find(member => member.path === relative);
      if (!files.has(child.kind) || child.externalId !== child.target.path || !within(tree.target.path, child.target.path) || child.target.path === tree.target.path || !member || member.kind !== "file"
        || (["dev", "ino", "mode", "size", "sha256"] as const).some(key => member[key] !== child.target[key])) throw new Error("Contained file differs from its complete prepared inventory");
      if ((input.removed || current.state === "released") && !captured.captured) throw new Error("Contained file has no retained parent capture");
      if (input.removed && current.state !== "released") throw new Error("Contained file retirement has not been recorded");
      await assertFinalizationPath(child.target.path);
      if (captured.captured && await missing(child.target.path)) throw new Error("Contained file was recreated after capture");
    }
    if (input.removed && record.state !== "released") throw new Error("Registered directory retirement has not been recorded");
    await observation.rootIdle(tree.target.path);
    if (captured.captured) await observation.rootIdle(captured.physicalPath);
    const fresh = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: tree.id, target: tree.target });
    if (fresh.captured !== captured.captured || fresh.physicalPath !== captured.physicalPath) throw new Error("Registered capture changed during observation");
  }
}
