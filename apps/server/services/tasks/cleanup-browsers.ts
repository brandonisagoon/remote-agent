import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CleanupObserverBatchResult, CleanupTarget } from "./cleanup-observer-schema.ts";
import { captureAdapterDependencies, privateRoot } from "./cleanup-filesystem.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { BrowserRetirementPlan, assertFinalizationPath, assertFinalizationTree, finalizationDigest, finalizationInventory, finalizationResourceIdentity, inspectFinalizationQuarantine,
  type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

type Browser = z.infer<typeof BrowserRetirementPlan>;
type Session = Extract<CleanupTarget, { kind: "browser-session" }>;
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const Owner = z.object({ taskId: z.string(), profile: z.string(), nonce: z.string().uuid(), session: z.string().optional() }).strict();
const Metadata = z.object({ namespace: z.literal("drafted"), session: z.string(), ownerFile: z.string(), ownerSha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function targetOf(plan: Browser) {
  const session = plan.session;
  if (session.adapter !== "browser" || session.kind !== "browser-profile" || session.targets.length !== 1 || session.targets[0]!.kind !== "browser-session" || session.dependencies.length || session.stoppedConsumers.length) throw new Error("Browser has no exact capability-backed session proof");
  const { disposition: _disposition, dependencies: _dependencies, session: _session, capture: _capture, ...identity } = plan;
  const { disposition: __disposition, dependencies: __dependencies, stoppedConsumers: __stopped, adapter: __adapter, targets: __targets, observer: __observer, ...sessionIdentity } = session;
  if (finalizationDigest(identity) !== finalizationDigest(sessionIdentity)) throw new Error("Browser session and filesystem resource identities differ");
  return session.targets[0];
}
async function profile(taskId: string, resource: FinalizationResourceRecord, target: Session, physicalRoot = path.dirname(resource.externalId)) {
  const meta = Metadata.parse(resource.metadata);
  const expectedSession = resource.key === "browser-profile" && resource.purpose === "browser" ? taskId : resource.key === "browser-profile:review" && resource.purpose === "review" ? `${taskId}-review` : null;
  const root = path.dirname(resource.externalId), remap = (file: string) => path.join(physicalRoot, path.relative(root, file));
  if (!expectedSession || meta.session !== expectedSession || target.id !== expectedSession || target.scope.taskId !== taskId || target.scope.purpose !== resource.purpose || target.scope.namespace !== "drafted"
    || path.basename(resource.externalId) !== "profile" || meta.ownerFile !== path.join(root, "profile-owner.json") || target.profile.path !== resource.externalId || target.profile.ownerFile !== meta.ownerFile || target.profile.ownerSha256 !== meta.ownerSha256) throw new Error("Browser marker, profile or session does not belong to this exact task resource");
  await assertFinalizationPath(physicalRoot); await assertFinalizationPath(remap(resource.externalId));
  const stat = await lstat(remap(resource.externalId));
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.dev !== target.profile.dev || stat.ino !== target.profile.ino || stat.mode !== target.profile.mode) throw new Error("Browser profile directory identity changed");
  const markerPath = remap(meta.ownerFile), marker = await observeLegacyEvidenceFile(markerPath, true, 16_384);
  const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(16_385), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), held = await handle.stat();
    if (!held.isFile() || held.dev !== marker.dev || held.ino !== marker.ino || held.size !== marker.size || bytesRead !== marker.size) throw new Error("Browser ownership marker changed while read");
    bytes = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  if (finalizationDigest(await observeLegacyEvidenceFile(markerPath, true, 16_384)) !== finalizationDigest(marker)) throw new Error("Browser ownership marker was replaced while read");
  const owner = Owner.parse(JSON.parse(bytes.toString()));
  if (marker.sha256 !== meta.ownerSha256 || hash(bytes) !== marker.sha256 || owner.taskId !== taskId || owner.profile !== resource.externalId || owner.session && owner.session !== meta.session) throw new Error("Browser ownership marker changed");
  // Only the immutable configured observer capability executes browser code.
  // Historical metadata.toolingRoot remains an unchanged receipt field.
}
export async function prepareBrowserCaptures(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; ownedPaths: string[]; protectedPaths: string[] }, observation: ResourceObservation) {
  const result: Browser[] = [];
  for (const resource of input.resources.filter(resource => resource.kind === "browser-profile" && resource.state !== "released")) {
    const session = input.plan.find(entry => entry.id === resource.id);
    if (!session || session.disposition !== "retire-adapter" || session.adapter !== "browser" || session.targets.length !== 1 || session.targets[0]?.kind !== "browser-session" || session.dependencies.length || session.stoppedConsumers.length) throw new Error("Browser cleanup requires its supported immutable capability observation");
    const root = path.dirname(resource.externalId), target = session.targets[0];
    await profile(input.taskId, resource, target); await privateRoot(root);
    const parents = input.resources.filter(entry => ["directory", "private-directory"].includes(entry.kind) && entry.state !== "released" && path.isAbsolute(entry.externalId) && within(entry.externalId, root));
    if (parents.length > 1) throw new Error("Browser has ambiguous registered capture roots");
    if (parents.length) {
      result.push(BrowserRetirementPlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retire-browser", dependencies: [parents[0]!.id], session,
        capture: { type: "registered", parentResourceId: parents[0]!.id, root: parents[0]!.externalId } }));
      continue;
    }
    if (!input.ownedPaths.includes(root) || input.protectedPaths.some(file => overlaps(root, file))
      || input.resources.some(other => other.id !== resource.id && path.isAbsolute(other.externalId) && overlaps(root, other.externalId))
      || input.plan.some(entry => entry.disposition === "retain-archive" && overlaps(root, entry.archive.root))) throw new Error("Standalone browser requires its exact nonoverlapping owner-selected marker/profile root");
    const edges = captureAdapterDependencies(root, input.resources, input.plan.filter(entry => entry.id !== resource.id));
    if (edges.dependencies.length || edges.stoppedConsumers.length) throw new Error("Standalone browser root has another resource consumer requiring a registered parent plan");
    await observation.rootIdle(root);
    const inventory = await finalizationInventory(root, [root], new Map([[resource.externalId, resource.id]]), new Map());
    for (const entry of inventory) {
      const stat = await lstat(path.join(root, entry.path));
      if (stat.uid !== process.getuid?.() || entry.kind !== "symlink" && stat.mode & 0o022) throw new Error("Browser root contains unowned or shared writable material");
    }
    const directory = path.join(path.dirname(root), `.drafted-finalization-${randomUUID()}`);
    if (input.protectedPaths.some(file => overlaps(directory, file)) || input.resources.some(other => path.isAbsolute(other.externalId) && overlaps(directory, other.externalId))
      || input.plan.some(entry => entry.disposition === "retain-archive" && overlaps(directory, entry.archive.root))) throw new Error("Browser retention destination overlaps protected or registered material");
    captureAdapterDependencies(directory, input.resources, input.plan.filter(entry => entry.id !== resource.id));
    const plan = BrowserRetirementPlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retire-browser", dependencies: [], session,
      capture: { type: "standalone", target: { type: "tree", path: root, sourcePaths: [root], inventory, quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } } });
    if (plan.capture.type !== "standalone") throw new Error("Browser capture type changed");
    await assertFinalizationTree(plan.capture.target); await observation.rootIdle(root); result.push(plan);
  }
  return result;
}
export async function assertBrowserCaptures(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; removed: boolean; adapterObservation?: z.infer<typeof CleanupObserverBatchResult> }, observation: ResourceObservation) {
  for (const browser of input.plan.filter((entry): entry is Browser => entry.disposition === "retire-browser")) {
    const resource = input.resources.find(entry => entry.id === browser.id)!, session = targetOf(browser);
    let target, captureResourceId: string;
    if (browser.capture.type === "registered") {
      const capture = browser.capture, selected = input.plan.find(entry => entry.id === capture.parentResourceId);
      if (!selected || selected.disposition !== "retire-tree" || selected.target.path !== browser.capture.root || browser.dependencies.length !== 1 || browser.dependencies[0] !== selected.id || !selected.stoppedConsumers.includes(browser.id)) throw new Error("Browser no longer belongs to its exact prepared registered parent");
      target = selected.target; captureResourceId = selected.id;
    } else {
      target = browser.capture.target; captureResourceId = browser.id;
      if (browser.dependencies.length || target.path !== path.dirname(resource.externalId) || target.sourcePaths.length !== 1 || target.sourcePaths[0] !== target.path) throw new Error("Standalone browser capture scope changed");
    }
    const root = path.dirname(resource.externalId);
    if (!within(target.path, root)) throw new Error("Browser root escapes its retained capture");
    const capture = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: captureResourceId, target });
    if ((input.removed || resource.state === "released") && !capture.captured) throw new Error("Browser has no verified retained capture");
    await assertFinalizationTree(target, capture.physicalPath);
    const opaque = target.inventory.find(entry => entry.path === path.relative(target.path, resource.externalId));
    if (!opaque || opaque.kind !== "opaque" || opaque.dependencyResourceId !== resource.id || opaque.dev !== session.profile.dev || opaque.ino !== session.profile.ino || opaque.mode !== session.profile.mode) throw new Error("Browser profile is not an exact opaque inventory member");
    await profile(input.taskId, resource, session, path.join(capture.physicalPath, path.relative(target.path, root)));
    if (capture.captured || input.removed || resource.state === "released") {
      const observed = input.adapterObservation?.observations.find(entry => entry.resourceId === browser.id);
      if (!observed || !observed.absent || observed.presentTargetDigests.length) throw new Error("Captured browser session absence has not been independently verified");
    }
    if (browser.capture.type === "standalone") { await observation.rootIdle(target.path); if (capture.captured) await observation.rootIdle(capture.physicalPath); }
    const fresh = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: captureResourceId, target });
    if (fresh.captured !== capture.captured || fresh.physicalPath !== capture.physicalPath) throw new Error("Browser capture changed during verification");
    if (input.removed && resource.state !== "released") throw new Error("Browser retirement has not been recorded");
  }
}
