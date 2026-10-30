import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SavedDataManifest, SavedDataScratch, SavedScratchBinding } from "./cleanup-saved-data-schema.ts";

type Resource = { id: string; kind: string; purpose: string; externalId: string; state: string; metadata?: unknown };
export type SavedDataTask = { id: string; primarySessionId: string; toolingRevision: string };
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value ?? {});
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => hash(Buffer.from(JSON.stringify(canonical(value))));
export function savedDataMember(root: string, relative: string) {
  if (!relative || relative === "." || path.isAbsolute(relative) || path.normalize(relative) !== relative || relative.split(path.sep).includes("..") || relative.includes("\0")) throw new Error("Saved-data member has an unsafe path");
  return path.join(root, relative);
}
export function parseSavedDataManifest(task: SavedDataTask, resource: Resource, file: string, expectedHash: string, bytes: Uint8Array) {
  const metadata = object(resource.metadata), manifest = SavedDataManifest.parse(JSON.parse(Buffer.from(bytes).toString()));
  if (!["directory", "private-directory"].includes(resource.kind) || resource.purpose !== "tooling" || resource.state !== "ready" || !path.isAbsolute(resource.externalId) || path.normalize(resource.externalId) !== resource.externalId
    || file !== path.join(resource.externalId, "manifest.json") || metadata.sha256 !== expectedHash || hash(bytes) !== expectedHash || metadata.bytes !== bytes.byteLength
    || manifest.task !== task.id || manifest.primarySession !== task.primarySessionId || manifest.policyPin !== task.toolingRevision || manifest.archiveRoot !== resource.externalId
    || metadata.artifactCount !== manifest.artifacts.length) throw new Error("Saved-data manifest differs from its exact original task and receipt");
  const names = manifest.artifacts.map(member => { savedDataMember(resource.externalId, member.path); return member.path; });
  if (new Set(names).size !== names.length || names.includes("manifest.json")) throw new Error("Saved-data manifest has duplicate or recursive members");
  return manifest;
}
export function savedDataProofMember(manifest: z.infer<typeof SavedDataManifest>, name: string, bytes: Uint8Array) {
  const member = manifest.artifacts.find(item => item.path === name);
  if (!member || member.sha256 !== hash(bytes) || member.bytes !== bytes.byteLength) throw new Error("Saved-data proof member differs from its manifest");
  return JSON.parse(Buffer.from(bytes).toString()) as unknown;
}
/** Historical restore observations remain evidence, never a new restore claim.
 * Exact container/volume pairs are selected by the authenticated owner; scripts
 * and operation descriptions are retained as bytes and never executed. */
export function bindSavedScratch(task: SavedDataTask, archive: Resource, resources: Resource[], selected: string[], scratchValue: unknown, restoreValue: unknown, roundtripValue: unknown, manifest: z.infer<typeof SavedDataManifest>) {
  const scratch = SavedDataScratch.parse(scratchValue);
  const restore = z.object({ task: z.string(), originalsUnchanged: z.literal(true), results: z.array(z.object({ purpose: z.enum(["development", "review"]), type: z.enum(["mysql", "redis"]), scratchId: z.string(), sourceId: z.string() }).passthrough()).max(100) }).passthrough().parse(restoreValue);
  if (scratch.task !== task.id || restore.task !== task.id || new Set(selected).size !== selected.length || new Set(scratch.scratch.map(item => item.id)).size !== scratch.scratch.length || new Set(scratch.scratch.map(item => item.volume.Name)).size !== scratch.scratch.length) throw new Error("Saved scratch identity is ambiguous");
  const roundtrips = z.object({ task: z.literal(task.id), roundtrips: z.array(z.object({ purpose: z.enum(["development", "review"]), containerId: z.string(), restoredKeys: z.number().int().nonnegative(), allDumpByteHashesMatch: z.literal(true), network: z.literal("none") }).passthrough()).max(100) }).passthrough().parse(roundtripValue);
  const bindings: z.infer<typeof SavedScratchBinding>[] = [], used = new Set<string>();
  for (const item of scratch.scratch) {
    const containers = resources.filter(r => r.kind === "docker-container" && r.purpose === "tooling" && r.externalId === item.id);
    const volumes = resources.filter(r => r.kind === "docker-volume" && r.purpose === "tooling" && r.externalId === item.volume.Name);
    if (![...containers, ...volumes].some(r => selected.includes(r.id))) continue;
    if (containers.length !== 1 || volumes.length !== 1 || !selected.includes(containers[0]!.id) || !selected.includes(volumes[0]!.id)) throw new Error("Scratch selection requires its exact registered container and volume pair");
    const container = containers[0]!, volume = volumes[0]!, cm = object(container.metadata), vm = object(volume.metadata), labels = item.volume.Labels;
    if (item.id === item.sourceId || cm.archiveRoot !== archive.externalId || cm.name !== item.name || cm.image !== item.image || cm.volume !== item.volume.Name || cm.networkMode !== "none" || cm.sourceId !== item.sourceId || cm.sourcePurpose !== item.purpose
      || vm.createdAt !== item.volume.CreatedAt || vm.containerId !== item.id || vm.sourceId !== item.sourceId || vm.sourcePurpose !== item.purpose
      || labels["dev.drafted.task"] !== task.id || labels["dev.drafted.purpose"] !== "tooling" || labels["dev.drafted.source-purpose"] !== item.purpose || !labels["dev.drafted.operation"]
      || Object.keys(labels).length !== 4 || restore.results.filter(r => r.scratchId === item.id && r.sourceId === item.sourceId && r.purpose === item.purpose && r.type === item.type).length !== 1) throw new Error("Saved scratch correspondence or historical restore evidence changed");
    const evidence = object(restore.results.find(r => r.scratchId === item.id));
    if (item.type === "mysql") {
      const mysql = z.object({ tableCount: z.number().int().nonnegative(), tables: z.array(z.unknown()), dump: z.object({ file: z.string(), sha256: z.string(), bytes: z.number(), repeatMatched: z.literal(true) }), tableCheck: z.object({ file: z.string(), sha256: z.string(), bytes: z.number() }) }).passthrough().parse(evidence);
      if (mysql.tableCount !== mysql.tables.length || [mysql.dump, mysql.tableCheck].some(ref => !manifest.artifacts.some(member => member.path === ref.file && member.sha256 === ref.sha256 && member.bytes === ref.bytes))) throw new Error("Saved MySQL restore evidence changed");
    } else {
      const redis = z.object({ keyCount: z.number().int().nonnegative(), keys: z.array(z.unknown()) }).passthrough().parse(evidence);
      if (redis.keys.length !== redis.keyCount || roundtrips.roundtrips.filter(r => r.containerId === item.id && r.purpose === item.purpose && r.restoredKeys === redis.keyCount).length !== 1) throw new Error("Saved Redis byte-roundtrip evidence changed");
    }
    bindings.push(SavedScratchBinding.parse({ containerResourceId: container.id, volumeResourceId: volume.id, containerId: item.id, volume: item.volume.Name, name: item.name, image: item.image, createdAt: item.volume.CreatedAt,
      sourcePurpose: item.purpose, sourceId: item.sourceId, operation: labels["dev.drafted.operation"], labelsDigest: digest(labels) }));
    used.add(container.id); used.add(volume.id);
  }
  if (selected.some(id => !used.has(id))) throw new Error("Selected scratch record has no exact saved-data correspondence");
  return bindings;
}
