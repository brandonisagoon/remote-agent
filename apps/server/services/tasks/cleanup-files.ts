import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CleanupObserverBatchResult } from "./cleanup-observer-schema.ts";
import { assertCapturedDependencies, captureAdapterDependencies } from "./cleanup-filesystem.ts";
import { inspectPreparedFileCapture, observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { StandaloneFilePlan, assertFinalizationPath, finalizationDigest, finalizationResourceIdentity,
  type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const missing = (file: string) => lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
export function hasStandaloneFileResource(resource: FinalizationResourceRecord) {
  return ["evidence", "private-file", "scenario-fixture"].includes(resource.kind) && path.isAbsolute(resource.externalId);
}
export async function prepareStandaloneFiles(input: { resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; ownedPaths: string[]; protectedPaths: string[] }, observation: ResourceObservation) {
  const result: z.infer<typeof StandaloneFilePlan>[] = [], idle = observation.linkedRootIdle ?? observation.rootIdle;
  for (const resource of input.resources.filter(resource => resource.state !== "released" && hasStandaloneFileResource(resource) && !input.plan.some(entry => entry.id === resource.id))) {
    const file = resource.externalId;
    if (path.normalize(file) !== file || !input.ownedPaths.includes(file) || input.protectedPaths.some(root => overlaps(root, file))
      || input.resources.some(other => other.id !== resource.id && path.isAbsolute(other.externalId) && overlaps(other.externalId, file))) throw new Error("Standalone file needs its exact unshared owned path");
    for (const entry of input.plan) if (entry.disposition === "retain-archive" && overlaps(entry.archive.root, file)) throw new Error("Retained archive members cannot become standalone cleanup targets");
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
      if (await missing(path.join(directory, ".git"))) throw new Error("Standalone file capture cannot replace an explicit Git worktree plan");
      if (directory === path.dirname(directory)) break;
    }
    await assertFinalizationPath(file);
    const parent = await lstat(path.dirname(file)), frozen = await observeLegacyEvidenceFile(file);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o022 || parent.dev !== frozen.dev || frozen.mode & 0o022) throw new Error("Standalone file or its parent is shared or unowned");
    const metadata = resource.metadata as Record<string, unknown> | null;
    const recordedHash = resource.kind === "scenario-fixture" && metadata?.sha256 && typeof metadata.sha256 === "object"
      ? z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).parse(metadata.sha256)[path.basename(file)] : metadata?.sha256;
    if (resource.kind === "scenario-fixture" && metadata?.sha256 !== undefined && recordedHash === undefined) throw new Error("Scenario fixture digest map lacks its exact registered file");
    if (recordedHash !== undefined && recordedHash !== frozen.sha256
      || [metadata?.bytes, metadata?.size, metadata?.byteSize].some(size => size !== undefined && size !== frozen.size)) throw new Error("Standalone file differs from its recorded bytes");
    const edges = captureAdapterDependencies(file, input.resources, input.plan), directory = path.join(path.dirname(file), `.drafted-evidence-${randomUUID()}`);
    if (input.protectedPaths.some(root => overlaps(root, directory)) || input.resources.some(other => path.isAbsolute(other.externalId) && overlaps(other.externalId, directory))
      || input.plan.some(entry => entry.disposition === "retain-archive" && overlaps(entry.archive.root, directory))) throw new Error("Standalone capture destination overlaps retained or protected material");
    captureAdapterDependencies(directory, input.resources, input.plan);
    const plan = StandaloneFilePlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retire-file", ...edges,
      target: { type: "file", ...frozen, quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } });
    result.push(plan);
  }
  if (result.length) {
    if (observation.pathsIdle) await observation.pathsIdle(result.map(entry => entry.target.path));
    else for (const entry of result) await idle(entry.target.path);
    for (const entry of result) {
      const { type: _type, quarantine: _quarantine, ...expected } = entry.target;
      if (finalizationDigest(await observeLegacyEvidenceFile(entry.target.path)) !== finalizationDigest(expected)) throw new Error("Standalone file changed during preparation");
    }
  }
  return result;
}
export async function assertStandaloneFiles(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; removed: boolean; adapterObservation?: z.infer<typeof CleanupObserverBatchResult> }, observation: ResourceObservation) {
  const idle = observation.linkedRootIdle ?? observation.rootIdle, paths: string[] = [], states: Array<{ entry: z.infer<typeof StandaloneFilePlan>; removed: boolean; captured: "captured" | "intact" | "pending" }> = [];
  for (const entry of input.plan.filter(entry => entry.disposition === "retire-file")) {
    const resource = input.resources.find(resource => resource.id === entry.id)!;
    if (!hasStandaloneFileResource(resource) || entry.externalId !== entry.target.path) throw new Error("Standalone file capture scope changed");
    const removed = input.removed || resource.state === "released", captured = await inspectPreparedFileCapture({ taskId: input.taskId, resourceId: entry.id, target: entry.target }, removed);
    if (captured === "captured") assertCapturedDependencies(entry, input.resources, input.adapterObservation);
    paths.push(entry.target.path);
    if (captured === "captured") paths.push(entry.target.quarantine.path);
    states.push({ entry, removed, captured });
    if (input.removed && resource.state !== "released") throw new Error("Standalone file retirement has not been recorded");
  }
  if (paths.length) {
    if (observation.pathsIdle) await observation.pathsIdle(paths);
    else for (const file of paths) await idle(file);
    for (const { entry, removed, captured } of states) if (await inspectPreparedFileCapture({ taskId: input.taskId, resourceId: entry.id, target: entry.target }, removed) !== captured) throw new Error("Standalone file capture changed during observation");
  }
}
