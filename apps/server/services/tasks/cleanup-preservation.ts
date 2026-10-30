import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { z } from "zod";
import { readArchiveBytes } from "./archive-observation.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";
import { PreservationInput, PreservationProof } from "./cleanup-preservation-schema.ts";
import { RetainedAdapterPlan, assertRetainedMaterialPlan, finalizationDigest, finalizationResourceIdentity, type FinalizationResourcePlan, type FinalizationResourceRecord } from "./finalization-resources.ts";
import type { CleanupTarget } from "./cleanup-observer-schema.ts";

type Database = Pick<PrismaClient, "remoteTaskResource"> & Partial<Pick<PrismaClient, "runtimeInstruction">>;
type Retained = z.infer<typeof RetainedAdapterPlan>;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const Inventory = z.object({ task: z.string(), sharedIdentity: z.object({ id: z.string(), disposition: z.literal("preserve per owner; no Clerk write or provider request performed") }).passthrough(),
  objectBucket: z.object({ id: z.string(), backingVolume: z.string(), disposition: z.literal("offline retained; provider absence NOT proven") }).passthrough(),
  volumes: z.array(z.object({ Name: z.string(), CreatedAt: z.string(), Labels: z.record(z.string(), z.string()) }).passthrough()).max(100) }).passthrough();
function references(taskId: string, sessionId: string, proof: PreservationProof, resources: FinalizationResourceRecord[], plan: FinalizationResourcePlan[]) {
  if (proof.instruction.sessionId !== sessionId || !proof.instruction.id.startsWith(`task:${taskId}:owner-`)
    || new Set(proof.targets.map(target => `${target.resourceId}:${target.kind}:${target.id}`)).size !== proof.targets.length) throw new Error("Preservation source belongs to another original task or contains duplicate targets");
  const record = resources.find(record => record.id === proof.inventory.resourceId), member = plan.find(entry => entry.id === proof.inventory.resourceId);
  if (!record || record.state === "released" || record.kind !== "resource-inventory" || record.purpose !== "tooling" || finalizationResourceIdentity(record).identityDigest !== proof.inventory.identityDigest
    || record.externalId !== proof.inventory.file.path || !member || member.disposition !== "retain-archive-member" || member.archive.resourceId !== proof.inventory.archiveResourceId
    || member.file.path !== proof.inventory.file.path || member.file.sha256 !== proof.inventory.file.sha256 || member.file.size !== proof.inventory.file.size) throw new Error("Preservation inventory is not an exact retained archive member");
}
async function instruction(database: Database, taskId: string, sessionId: string, expected: { id: string; sequence: number; textSha256?: string }) {
  if (!database.runtimeInstruction) throw new Error("Preservation source inspection is unavailable");
  const row = await database.runtimeInstruction.findUnique({ where: { sequence: expected.sequence } });
  if (!row || row.id !== expected.id || row.sessionId !== sessionId || !row.id.startsWith(`task:${taskId}:owner-`) || Buffer.byteLength(row.text) > 1024 * 1024
    || expected.textSha256 && sha(row.text) !== expected.textSha256) throw new Error("Original preservation instruction changed");
  return { id: row.id, sequence: row.sequence, sessionId, textSha256: sha(row.text) };
}
async function inventory(taskId: string, proof: PreservationProof) {
  const file = await observeLegacyEvidenceFile(proof.inventory.file.path, true, 2 * 1024 * 1024);
  if (finalizationDigest(file) !== finalizationDigest(proof.inventory.file)) throw new Error("Retained preservation inventory changed");
  const bytes = await readArchiveBytes(file.path, 2 * 1024 * 1024);
  if (sha(bytes) !== file.sha256) throw new Error("Retained preservation inventory changed during reading");
  const result = Inventory.parse(JSON.parse(bytes.toString()));
  if (result.task !== taskId || finalizationDigest(await observeLegacyEvidenceFile(file.path, true, 2 * 1024 * 1024)) !== finalizationDigest(file)) throw new Error("Preservation inventory does not belong to the same unchanged task");
  return result;
}
function correspondence(taskId: string, resource: FinalizationResourceRecord, target: CleanupTarget, saved: z.infer<typeof Inventory>) {
  if (!target.presentAtPrepare || target.scope.taskId !== taskId || target.scope.purpose !== resource.purpose) throw new Error("Preserved target needs its exact independently observed original identity");
  if (target.kind === "clerk-user") {
    if (resource.kind !== "clerk-test-user" || resource.externalId !== target.id || saved.sharedIdentity.id !== target.id) throw new Error("Preserved Clerk identity differs from the recorded owner inventory");
    return;
  }
  if (target.kind !== "docker-volume" || !["docker-compose", "docker-compose-project"].includes(resource.kind) || !target.identity || saved.objectBucket.backingVolume !== target.id) throw new Error("Unsupported preserved storage target");
  const volumes = saved.volumes.filter(volume => volume.Name === target.id);
  if (volumes.length !== 1 || volumes[0]!.CreatedAt !== target.identity.createdAt || finalizationDigest(volumes[0]!.Labels) !== target.identity.labelsDigest
    || volumes[0]!.Labels["dev.drafted.task"] !== taskId || volumes[0]!.Labels["dev.drafted.purpose"] !== resource.purpose
    || volumes[0]!.Labels["com.docker.compose.project"] !== resource.externalId || target.scope.project !== resource.externalId) throw new Error("Preserved volume creation or task ownership differs from the retained inventory");
}

/** A recognized retained owner inventory is a restriction even if an adopter
 * omits the optional selection. Do not silently turn that omission into delete
 * authority for the two explicitly preserved original resources. */
async function requiredSelection(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[] }) {
  const recognized: Array<{ inventoryResourceId: string; targets: PreservationProof["targets"] }> = [];
  for (const member of input.plan) {
    if (member.disposition !== "retain-archive-member") continue;
    const record = input.resources.find(record => record.id === member.id);
    if (!record || record.kind !== "resource-inventory" || record.purpose !== "tooling" || member.kind !== "resource-inventory" || member.purpose !== "tooling") continue;
    assertRetainedMaterialPlan(member, input.plan);
    if (finalizationResourceIdentity(record).identityDigest !== member.identityDigest || record.state === "released") throw new Error("Retained inventory resource changed");
    const file = await observeLegacyEvidenceFile(member.file.path, false, 2 * 1024 * 1024), bytes = await readArchiveBytes(file.path, 2 * 1024 * 1024);
    if (file.sha256 !== member.file.sha256 || file.size !== member.file.size || sha(bytes) !== file.sha256) throw new Error("Retained inventory bytes changed");
    let value: unknown;
    try { value = JSON.parse(bytes.toString()); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    const candidate = value as { sharedIdentity?: { disposition?: unknown }; objectBucket?: { disposition?: unknown } } | null;
    if (candidate?.sharedIdentity?.disposition !== "preserve per owner; no Clerk write or provider request performed" && candidate?.objectBucket?.disposition !== "offline retained; provider absence NOT proven") continue;
    const saved = Inventory.parse(value);
    if (saved.task !== input.taskId || finalizationDigest(await observeLegacyEvidenceFile(file.path, true, 2 * 1024 * 1024)) !== finalizationDigest(file)) throw new Error("Preserved inventory belongs to another task or changed during inspection");
    const users = input.resources.filter(resource => resource.kind === "clerk-test-user" && resource.externalId === saved.sharedIdentity.id);
    const stores = input.resources.filter(resource => ["docker-compose", "docker-compose-project"].includes(resource.kind) && resource.externalId === `drafted-${input.taskId}-${resource.purpose}`
      && saved.objectBucket.backingVolume === `${resource.externalId}-objects`);
    if (users.length !== 1 || stores.length !== 1) throw new Error("Preserved inventory does not identify one exact original user and objects store");
    recognized.push({ inventoryResourceId: member.id, targets: [{ resourceId: users[0]!.id, kind: "clerk-user", id: saved.sharedIdentity.id }, { resourceId: stores[0]!.id, kind: "docker-volume", id: saved.objectBucket.backingVolume }] });
  }
  if (recognized.length > 1) throw new Error("Preservation has conflicting retained source inventories");
  return recognized[0];
}

/** The authenticated adoption selects a restriction from an existing original
 * instruction and retained inventory. It cannot add any deletion authority. */
export async function preparePreservationEvidence(input: { prisma: Database; taskId: string; sessionId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; selection?: z.infer<typeof PreservationInput> }) {
  const required = await requiredSelection(input);
  if (!input.selection) {
    if (required) throw new Error("Recorded preservation requires the complete exact target selection");
    return undefined;
  }
  const selection = PreservationInput.parse(input.selection);
  const ordered = (targets: PreservationProof["targets"]) => [...targets].sort((a, b) => `${a.resourceId}:${a.kind}:${a.id}`.localeCompare(`${b.resourceId}:${b.kind}:${b.id}`));
  if (required && (required.inventoryResourceId !== selection.inventoryResourceId || finalizationDigest(ordered(required.targets)) !== finalizationDigest(ordered(selection.targets)))) throw new Error("Recorded preservation requires the complete exact target selection");
  const record = input.resources.find(record => record.id === selection.inventoryResourceId);
  if (!record) throw new Error("Preservation inventory resource is missing");
  const member = input.plan.find(entry => entry.id === record.id);
  if (!member || member.disposition !== "retain-archive-member") throw new Error("Preservation inventory must already have its exact retained archive proof");
  const proof = PreservationProof.parse({ instruction: await instruction(input.prisma, input.taskId, input.sessionId, selection.instruction),
    inventory: { resourceId: record.id, identityDigest: finalizationResourceIdentity(record).identityDigest, archiveResourceId: member.archive.resourceId, file: await observeLegacyEvidenceFile(record.externalId, true, 2 * 1024 * 1024) }, targets: selection.targets });
  references(input.taskId, input.sessionId, proof, input.resources, input.plan); await inventory(input.taskId, proof);
  return proof;
}
export async function partitionPreservedAdapters(input: { taskId: string; sessionId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; proof?: PreservationProof }) {
  if (!input.proof) return;
  const proof = PreservationProof.parse(input.proof); references(input.taskId, input.sessionId, proof, input.resources, input.plan);
  const saved = await inventory(input.taskId, proof), resourceIds = new Set(proof.targets.map(target => target.resourceId));
  for (const id of resourceIds) {
    const index = input.plan.findIndex(entry => entry.id === id), adapter = input.plan[index], resource = input.resources.find(record => record.id === id);
    if (!resource || resource.state !== "ready" || !adapter || adapter.disposition !== "retire-adapter") throw new Error("Preservation selection has no exact Ready observed adapter");
    const selected = proof.targets.filter(target => target.resourceId === id).map(selection => {
      const targets = adapter.targets.filter(target => target.kind === selection.kind && target.id === selection.id);
      if (targets.length !== 1) throw new Error("Preservation selection differs from its exact observed target");
      correspondence(input.taskId, resource, targets[0]!, saved); return targets[0]!.identityDigest;
    });
    input.plan[index] = RetainedAdapterPlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retain-adapter", adapterPlan: adapter, retainedTargetDigests: selected.sort(), preservation: proof });
  }
}
export async function assertPreservedAdapters(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[] }) {
  const cache = new Map<string, z.infer<typeof Inventory>>();
  for (const entry of input.plan.filter((entry): entry is Retained => entry.disposition === "retain-adapter")) {
    const resource = input.resources.find(record => record.id === entry.id)!;
    references(input.taskId, entry.adapterPlan.observer.task.primarySessionId, entry.preservation, input.resources, input.plan);
    const digest = finalizationDigest(entry.preservation), saved = cache.get(digest) ?? await inventory(input.taskId, entry.preservation); cache.set(digest, saved);
    const { disposition: _d, adapterPlan: _a, retainedTargetDigests: _t, preservation: _p, ...identity } = entry;
    const { disposition: _ad, dependencies: _deps, stoppedConsumers: _stopped, adapter: _kind, targets: _targets, observer: _observer, ...inner } = entry.adapterPlan;
    if (finalizationDigest(identity) !== finalizationDigest(inner) || resource.state !== "ready") throw new Error("Preserved adapter identity or Ready receipt state changed");
    const selected = entry.preservation.targets.filter(target => target.resourceId === entry.id).map(selection => {
      const target = entry.adapterPlan.targets.find(target => target.kind === selection.kind && target.id === selection.id);
      if (!target) throw new Error("Preserved target is absent from its frozen adapter");
      correspondence(input.taskId, resource, target, saved); return target.identityDigest;
    }).sort();
    if (finalizationDigest(selected) !== finalizationDigest(entry.retainedTargetDigests) || new Set(selected).size !== selected.length) throw new Error("Preserved target partition changed");
    for (const bucket of input.plan.filter(candidate => candidate.disposition === "retain-backed" && candidate.storage.resourceId === entry.id)) {
      if (bucket.disposition !== "retain-backed" || bucket.members.bucket !== saved.objectBucket.id || bucket.storage.targetDigests.some(digest => !entry.retainedTargetDigests.includes(digest))) throw new Error("Preserved bucket differs from the exact recorded offline inventory");
    }
  }
}
/** Cheap original instruction and registry identity checks for local renewals.
 * Full boundaries separately hash the retained file and inspect live targets. */
export async function assertPreservationSources(prisma: Database, taskId: string, sessionId: string, plan: FinalizationResourcePlan[]) {
  const proofs = new Map(plan.filter((entry): entry is Retained => entry.disposition === "retain-adapter").map(entry => [finalizationDigest(entry.preservation), entry.preservation]));
  if (!proofs.size) return;
  const resources = await prisma.remoteTaskResource.findMany({ where: { taskId } });
  for (const entry of plan.filter(entry => entry.disposition === "retain-adapter" || entry.disposition === "retain-backed")) if (resources.find(record => record.id === entry.id)?.state !== "ready") throw new Error("Preserved resource must keep its original Ready state");
  for (const proof of proofs.values()) { references(taskId, sessionId, proof, resources, plan); await instruction(prisma, taskId, sessionId, proof.instruction); }
}
