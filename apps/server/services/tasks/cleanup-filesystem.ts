import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { z } from "zod";
import type { CleanupObserverBatchResult } from "./cleanup-observer-schema.ts";
import { ContainedFilePlan, RegisteredTreePlan, assertFinalizationPath, assertFinalizationTree, finalizationInventory, finalizationResourceIdentity, inspectFinalizationQuarantine,
  type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

type Tree = Extract<FinalizationResourcePlan, { disposition: "retire-tree" }>;
type Child = Extract<FinalizationResourcePlan, { disposition: "retire-contained" }>;
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const missing = (file: string) => lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
const directories = new Set(["directory", "private-directory"]);
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

async function privateRoot(root: string) {
  await assertFinalizationPath(root);
  const stat = await lstat(root), parent = await lstat(path.dirname(root));
  if (path.parse(root).root === root || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700
    || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0 || parent.dev !== stat.dev) throw new Error("Registered capture requires an exact private owned root and parent on one filesystem");
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    if (await missing(path.join(cursor, ".git"))) throw new Error("Registered directory capture cannot include a Git checkout; use its explicit worktree plan");
    if (cursor === path.dirname(cursor)) break;
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
      if (entry.disposition === "retire-adapter") for (const target of entry.targets) {
        const required = "runtimeFile" in target.scope ? target.scope.runtimeFile : target.kind === "native-family" ? target.proof.file : undefined;
        if (required && within(root, required)) throw new Error("Independent final confirmation inputs must survive outside filesystem capture");
      }
    }
    await privateRoot(root);
    await observation.rootIdle(root);
    const children = input.resources.filter(other => other.id !== resource.id && path.isAbsolute(other.externalId) && within(root, other.externalId));
    if (children.some(child => child.externalId === root || !files.has(child.kind) || child.state === "released")) throw new Error("Registered root contains a resource without an exact contained-file plan");
    const inventory = await finalizationInventory(root, [root], new Map(), new Map(children.map(child => [child.externalId, child.id])));
    if (inventory.some(entry => entry.path.split(path.sep).includes(".git"))) throw new Error("Registered directory contains Git metadata requiring a worktree plan");
    for (const entry of inventory) {
      const stat = await lstat(path.join(root, entry.path));
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 && entry.kind !== "symlink") throw new Error("Registered inventory contains unowned or shared writable material");
    }
    const dependencies = new Set<string>(), stoppedConsumers = new Set<string>();
    for (const adapter of input.plan.filter(entry => entry.disposition === "retire-adapter")) {
      const record = input.resources.find(other => other.id === adapter.id)!;
      if (![...referencePaths(record.metadata), ...referencePaths(adapter.targets)].some(file => within(root, file))) continue;
      if (adapter.targets.some(target => target.kind === "native-family")) stoppedConsumers.add(adapter.id);
      else dependencies.add(adapter.id);
    }
    const directory = path.join(path.dirname(root), `.drafted-finalization-${randomUUID()}`);
    const tree = RegisteredTreePlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retire-tree", treeKind: "registered-directory",
      dependencies: [...dependencies].sort(), stoppedConsumers: [...stoppedConsumers].sort(), target: { type: "tree", path: root, inventory, sourcePaths: [root],
        quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } });
    result.push(tree);
    for (const child of children) {
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
  }
  return result;
}

/** This query is local authority, not a filesystem observer. It also runs on
 * renewals so another task cannot acquire a recorded path inside the capture. */
export async function assertRegisteredCaptureSharing(prisma: Pick<PrismaClient, "remoteTaskResource">, taskId: string, plan: FinalizationResourcePlan[]) {
  const roots = plan.filter((entry): entry is Tree => entry.disposition === "retire-tree");
  if (!roots.length) return;
  const scopes = roots.flatMap(entry => [entry.target.path, entry.target.quarantine.directory]);
  const ancestors = new Set<string>();
  for (const scope of scopes) for (let cursor = scope; ; cursor = path.dirname(cursor)) { ancestors.add(cursor); if (cursor === path.dirname(cursor)) break; }
  const shared = await prisma.remoteTaskResource.findFirst({ where: { taskId: { not: taskId }, OR: [
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
    if (captured.captured) for (const id of tree.dependencies) {
      if (input.resources.find(record => record.id === id)?.state !== "released") throw new Error("Captured directory still has an unreleased dependent adapter");
    }
    if (captured.captured) for (const id of tree.stoppedConsumers) {
      const observed = input.adapterObservation?.observations.find(entry => entry.resourceId === id);
      const families = observed?.targets.filter(target => target.kind === "native-family") ?? [];
      if (!observed || !families.length || families.some(target => observed.presentTargetDigests.includes(target.identityDigest))) throw new Error("Captured directory still has an active or unverified native consumer");
    }
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
