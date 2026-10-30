import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CleanupObserverBatchResult, CleanupTarget } from "./cleanup-observer-schema.ts";
import { captureAdapterDependencies } from "./cleanup-filesystem.ts";
import { inspectPreparedFileCapture, observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { BrowserVaultPlan, assertFinalizationPath, finalizationDigest, finalizationResourceIdentity,
  type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

type Vault = z.infer<typeof BrowserVaultPlan>;
type Target = Extract<CleanupTarget, { kind: "browser-auth-entry" }>;
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const Metadata = z.object({ entry: z.string().regex(/^[A-Za-z0-9_-]+$/), namespace: z.literal("drafted"), origin: z.url() }).passthrough();
const vaultRoot = (observation: ResourceObservation) => observation.browserVaultRoot?.() ?? path.join(homedir(), ".agent-browser", "auth");

async function scope(taskId: string, resource: FinalizationResourceRecord, target: Target, observation: ResourceObservation) {
  const meta = Metadata.parse(resource.metadata), root = vaultRoot(observation), file = path.join(root, `${meta.entry}.json`), key = path.join(path.dirname(root), ".encryption-key");
  if (resource.kind !== "browser-auth" || resource.purpose !== "browser" || resource.externalId !== `agent-browser:drafted:${meta.entry}`
    || /^dra[1-9][0-9]*-([a-z0-9]{8})-clerk$/.exec(meta.entry)?.[1] !== taskId.slice(0, 8) || target.id !== meta.entry || !target.presentAtPrepare
    || target.scope.taskId !== taskId || target.scope.purpose !== "browser" || target.scope.namespace !== "drafted" || target.scope.keyFile !== key
    || target.file.path !== file || target.origin !== new URL(meta.origin).origin) throw new Error("Browser vault proof differs from its exact original task entry");
  await assertFinalizationPath(root); await assertFinalizationPath(key);
  const parent = await lstat(root), credentialKey = await observeLegacyEvidenceFile(key, true, 4096);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || parent.mode & 0o077 || parent.dev !== target.file.dev
    || credentialKey.sha256 !== target.scope.keySha256) throw new Error("Browser vault parent or retained encryption key changed");
  return { file, root };
}
function selectedTarget(plan: Vault) {
  const selected = plan.vault;
  if (selected.adapter !== "vault" || selected.kind !== "browser-auth" || selected.targets.length !== 1 || selected.targets[0]?.kind !== "browser-auth-entry" || selected.dependencies.length || selected.stoppedConsumers.length) throw new Error("Browser vault needs one exact configured observation");
  const { disposition: _d, dependencies: _deps, vault: _v, target: _t, ...identity } = plan;
  const { disposition: __d, dependencies: __deps, stoppedConsumers: __stopped, adapter: __adapter, targets: __targets, observer: __observer, ...observed } = selected;
  if (finalizationDigest(identity) !== finalizationDigest(observed)) throw new Error("Browser vault resource observation changed");
  const { type: _type, quarantine: _q, ...file } = plan.target;
  if (finalizationDigest(file) !== finalizationDigest(selected.targets[0].file)) throw new Error("Browser vault capture differs from the observed encrypted file");
  return selected.targets[0];
}
async function idle(paths: string[], observation: ResourceObservation) {
  if (observation.pathsIdle) await observation.pathsIdle(paths); else for (const file of paths) await observation.rootIdle(file);
}

/** The tool's auth vault is global, even with a drafted browser namespace.
 * Capture only the exact encrypted entry; never unlink a mutable name or infer
 * ownership of its parent/key/other entries from that namespace. */
export async function prepareVaultCaptures(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; ownedPaths: string[]; protectedPaths: string[] }, observation: ResourceObservation) {
  const result: Vault[] = [];
  for (const resource of input.resources.filter(record => record.kind === "browser-auth" && record.state !== "released")) {
    const selected = input.plan.find(entry => entry.id === resource.id);
    if (!selected || selected.disposition !== "retire-adapter" || selected.adapter !== "vault" || selected.targets.length !== 1 || selected.targets[0]?.kind !== "browser-auth-entry") throw new Error("Browser vault has no configured exact entry observation");
    const target = selected.targets[0], { file, root } = await scope(input.taskId, resource, target, observation);
    if (!input.ownedPaths.includes(file) || input.protectedPaths.some(other => overlaps(file, other))
      || input.resources.some(other => other.id !== resource.id && (other.externalId === resource.externalId || path.isAbsolute(other.externalId) && overlaps(file, other.externalId)))
      || input.plan.some(other => other.disposition === "retain-archive" && overlaps(file, other.archive.root))) throw new Error("Browser vault entry is outside its exact unshared adopted file scope");
    const identity = await observeLegacyEvidenceFile(file, true, 1024 * 1024);
    if (finalizationDigest(identity) !== finalizationDigest(target.file)) throw new Error("Browser vault encrypted bytes changed after observation");
    const directory = path.join(root, `.drafted-evidence-${randomUUID()}`);
    if (input.protectedPaths.some(other => overlaps(directory, other)) || input.resources.some(other => path.isAbsolute(other.externalId) && overlaps(directory, other.externalId))
      || input.plan.some(other => other.disposition === "retain-archive" && overlaps(directory, other.archive.root))) throw new Error("Browser vault quarantine overlaps retained or registered material");
    captureAdapterDependencies(directory, input.resources, input.plan);
    const entry = BrowserVaultPlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retire-vault", dependencies: [], vault: selected,
      target: { ...identity, type: "file", quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } });
    selectedTarget(entry); await idle([file], observation);
    if (finalizationDigest(await observeLegacyEvidenceFile(file, true, 1024 * 1024)) !== finalizationDigest(identity)) throw new Error("Browser vault entry changed during writer observation");
    result.push(entry);
  }
  return result;
}

export async function assertVaultCaptures(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; removed: boolean; adapterObservation?: z.infer<typeof CleanupObserverBatchResult> }, observation: ResourceObservation) {
  for (const entry of input.plan.filter((entry): entry is Vault => entry.disposition === "retire-vault")) {
    const resource = input.resources.find(record => record.id === entry.id)!, target = selectedTarget(entry);
    await scope(input.taskId, resource, target, observation);
    const removed = input.removed || resource.state === "released", capture = await inspectPreparedFileCapture({ taskId: input.taskId, resourceId: entry.id, target: entry.target }, removed);
    if (capture === "captured" && !input.adapterObservation?.observations.find(item => item.resourceId === entry.id)?.absent) throw new Error("Captured browser vault entry has no independent active-path absence");
    if (input.removed && resource.state !== "released") throw new Error("Browser vault retirement has not been recorded");
    await idle([entry.target.path, entry.target.quarantine.path], observation);
    if (await inspectPreparedFileCapture({ taskId: input.taskId, resourceId: entry.id, target: entry.target }, removed) !== capture) throw new Error("Browser vault capture changed during observation");
  }
}
