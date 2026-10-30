import { z } from "zod";
import type { CleanupAdapterPlan } from "./cleanup-adapter-resources.ts";
import type { CleanupObserverBatchResult, CleanupTarget } from "./cleanup-observer-schema.ts";
import { BackedResourcePlan, RetainedBackedPlan, finalizationDigest, finalizationResourceIdentity, type FinalizationResourcePlan, type FinalizationResourceRecord } from "./finalization-resources.ts";

type Backed = z.infer<typeof BackedResourcePlan> | z.infer<typeof RetainedBackedPlan>;
type Input = { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[] };
const metadata = (record: FinalizationResourceRecord) => z.record(z.string(), z.unknown()).parse(record.metadata ?? {});
const unique = (values: string[]) => values.length === new Set(values).size;
export const hasBackedResource = (record: FinalizationResourceRecord) => ["fixture", "s3-object", "s3-bucket"].includes(record.kind);

function scope(input: Input, resource: FinalizationResourceRecord, adapter: CleanupAdapterPlan, target: CleanupTarget) {
  const record = input.resources.find(record => record.id === adapter.id);
  if (!record || finalizationResourceIdentity(record).identityDigest !== adapter.identityDigest || record.purpose !== resource.purpose
    || target.scope.taskId !== input.taskId || target.scope.purpose !== resource.purpose) throw new Error("Backing store differs from the original task and purpose");
  return { resourceId: adapter.id, targetDigests: [target.identityDigest] };
}
function composeVolume(input: Input, resource: FinalizationResourceRecord, project: string, volume: string, owner?: { key: string; id: string }) {
  const candidates = input.plan.flatMap(entry => entry.disposition === "retain-adapter" ? [entry.adapterPlan] : entry.disposition === "retire-adapter" ? [entry] : []).filter(entry => entry.adapter === "compose" && entry.externalId === project && entry.purpose === resource.purpose);
  if (candidates.length !== 1) throw new Error("Fixture needs one exact observed Compose backing resource");
  const adapter = candidates[0]!, record = input.resources.find(record => record.id === adapter.id)!, meta = metadata(record);
  if (owner && (record.id !== owner.id || record.key !== owner.key)) throw new Error("Object receipt names another owner Compose record");
  const declared = Array.isArray(meta.volumes) ? meta.volumes : meta.volumes && typeof meta.volumes === "object" ? Object.keys(meta.volumes) : [];
  const targets = adapter.targets.filter(target => target.kind === "docker-volume" && target.id === volume && target.scope.project === project);
  if (!declared.includes(volume) || targets.length !== 1) throw new Error("Fixture backing volume is not one exact declared and observed member");
  return scope(input, resource, adapter, targets[0]!);
}

/** These are logical receipts for material already inside an existing exact
 * storage target. No new provider operation, key deletion or export is granted.
 * All original metadata and existing archive obligations remain in the plan. */
export function prepareBackedResources(input: Input): Backed[] {
  return input.resources.filter(resource => hasBackedResource(resource) && resource.state !== "released").map(resource => derive(input, resource));
}
function derive(input: Input, resource: FinalizationResourceRecord): Backed {
  if (!["development", "review"].includes(resource.purpose)) throw new Error("Unsupported stored fixture purpose");
  const meta = metadata(resource), identity = finalizationResourceIdentity(resource);
  if (resource.kind === "fixture") {
    const chats = z.array(z.uuid()).min(1).max(100).parse(meta.chats), owner = typeof meta.owner === "string" ? /^(user_[A-Za-z0-9]+)(?: \(existing synthetic pilot identity; no new Clerk user, no metadata changes\))?$/.exec(meta.owner)?.[1] : undefined;
    if (!owner || !unique(chats) || meta.store !== (resource.purpose === "development" ? "task Redis only" : "review Redis only")) throw new Error("Fixture has no exact recorded task Redis members and preserved shared identity");
    const project = `drafted-${input.taskId}${resource.purpose === "review" ? "-review" : ""}`;
    return BackedResourcePlan.parse({ ...identity, disposition: "retire-backed", storage: composeVolume(input, resource, project, `${project}-redis`), members: { kind: "redis-chats", chatIds: chats, preservedUserId: owner } });
  }
  if (resource.kind === "s3-object" && Array.isArray(meta.objects)) {
    const bucket = typeof meta.bucket === "string" ? /^(drafted-[a-z0-9-]+) \(task R2\)$/.exec(meta.bucket)?.[1] : undefined;
    const objects = z.array(z.object({ key: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()).min(1).max(1000).parse(meta.objects).map(({ key, sha256 }) => ({ key, sha256 }));
    if (!bucket || !unique(objects.map(object => object.key)) || !resource.externalId.startsWith(`${bucket}/`) || objects.some(object => !`${bucket}/${object.key}`.startsWith(resource.externalId))) throw new Error("Stored objects differ from their exact recorded bucket and prefix");
    const candidates = input.plan.flatMap(entry => entry.disposition === "retire-adapter" && entry.adapter === "runtime" && entry.purpose === resource.purpose
      ? entry.targets.filter(target => target.kind === "r2-bucket" && target.id === bucket && target.name === bucket).map(target => ({ entry, target })) : []);
    if (candidates.length !== 1) throw new Error("Stored objects need one exact observed runtime bucket");
    return BackedResourcePlan.parse({ ...identity, disposition: "retire-backed", storage: scope(input, resource, candidates[0]!.entry, candidates[0]!.target), members: { kind: "s3-objects", bucket, objects } });
  }
  const bucket = z.string().regex(/^drafted-dra[1-9][0-9]*$/).parse(resource.kind === "s3-bucket" ? resource.externalId : meta.bucket);
  const project = `drafted-${input.taskId}-${resource.purpose}`, volume = `${project}-objects`;
  if (meta.volume !== volume) throw new Error("Bucket receipt does not name its exact task objects volume");
  let owner: { key: string; id: string } | undefined;
  if (resource.kind === "s3-object") {
    const match = typeof meta.ownerReceipt === "string" ? /^([^\s()]+) \(([^\s()]+)\)$/.exec(meta.ownerReceipt) : null;
    if (!match) throw new Error("Legacy object has no exact recorded backing receipt");
    owner = { key: match[1]!, id: match[2]! };
  }
  const storage = composeVolume(input, resource, project, volume, owner);
  const parent = input.plan.find(entry => entry.id === storage.resourceId);
  const retained = parent?.disposition === "retain-adapter" && storage.targetDigests.every(digest => parent.retainedTargetDigests.includes(digest));
  if (resource.kind === "s3-bucket") {
    if (retained && resource.state !== "ready") throw new Error("Preserved bucket must keep its original Ready state");
    return (retained ? RetainedBackedPlan : BackedResourcePlan).parse({ ...identity, disposition: retained ? "retain-backed" : "retire-backed", storage, members: { kind: "s3-bucket", bucket } });
  }
  if (retained) throw new Error("Stored object retirement cannot claim absence of intentionally preserved storage");
  const key = z.string().min(1).max(4096).parse(meta.key);
  if (resource.externalId !== `${bucket}/${key}`) throw new Error("Legacy object receipt key changed");
  // The old probe has no established retained object copy or content digest.
  // Preserve that unknown; a quoted synthetic-content note is not a file hash.
  return BackedResourcePlan.parse({ ...identity, disposition: "retire-backed", storage, members: { kind: "s3-objects", bucket, objects: [{ key, sha256: null }] } });
}

export function assertBackedResources(input: Input & { removed: boolean; adapterObservation?: z.infer<typeof CleanupObserverBatchResult> }) {
  for (const entry of input.plan.filter((entry): entry is Backed => entry.disposition === "retire-backed" || entry.disposition === "retain-backed")) {
    const record = input.resources.find(record => record.id === entry.id);
    if (!record || finalizationDigest(derive(input, record)) !== finalizationDigest(entry)) throw new Error("Stored resource correspondence changed since preparation");
    const observed = input.adapterObservation?.observations.find(observation => observation.resourceId === entry.storage.resourceId);
    if (!observed || entry.storage.targetDigests.some(digest => !observed.targets.some(target => target.identityDigest === digest))) throw new Error("Stored resource backing targets were not independently observed");
    if (entry.disposition === "retain-backed") {
      if (record.state !== "ready" || entry.storage.targetDigests.some(digest => !observed.presentTargetDigests.includes(digest))) throw new Error("Preserved bucket storage is missing or its Ready state changed");
    } else {
      if ((input.removed || record.state === "released") && entry.storage.targetDigests.some(digest => observed.presentTargetDigests.includes(digest))) throw new Error("Stored resource still has a present backing target");
      if (input.removed && record.state !== "released") throw new Error("Stored resource retirement was not recorded");
    }
  }
}
