import path from "node:path";
import { z } from "zod";
import { privateArchiveInventory, readArchiveBytes } from "./archive-observation.ts";
import { bindSavedScratch, parseSavedDataManifest, savedDataProofMember, type SavedDataTask } from "./cleanup-saved-data-binding.ts";
import { SavedDataSelections } from "./cleanup-saved-data-schema.ts";
import { finalizationDigest, finalizationResourceIdentity, RetainedDataPlan, type FinalizationResourcePlan, type FinalizationResourceRecord } from "./finalization-resources.ts";

type Plan = z.infer<typeof RetainedDataPlan>;
const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
export async function prepareSavedData(input: { task: SavedDataTask; resources: FinalizationResourceRecord[]; selections?: z.infer<typeof SavedDataSelections> }) {
  const plans: Plan[] = [];
  for (const selection of SavedDataSelections.parse(input.selections ?? [])) {
    const resource = input.resources.find(r => r.id === selection.resourceId);
    if (!resource) throw new Error("Saved-data selection is outside the original resource set");
    const bytes = await readArchiveBytes(selection.manifestPath, 8 * 1024 * 1024);
    const manifest = parseSavedDataManifest(input.task, resource, selection.manifestPath, selection.manifestSha256, bytes);
    const inventory = await privateArchiveInventory(resource.externalId, true);
    const files = new Map(inventory.filter(entry => entry.kind === "file").map(entry => [entry.path, entry]));
    const sidecar = files.get("manifest-digest.json");
    if (files.size !== manifest.artifacts.length + 1 + Number(Boolean(sidecar)) || files.get("manifest.json")?.sha256 !== selection.manifestSha256) throw new Error("Saved-data inventory differs from complete manifest coverage");
    for (const member of manifest.artifacts) {
      const file = files.get(member.path);
      if (!file || file.sha256 !== member.sha256 || file.size !== member.bytes) throw new Error("Saved-data member differs from its historical manifest");
    }
    if (sidecar) {
      const sidecarBytes = await readArchiveBytes(path.join(resource.externalId, "manifest-digest.json"), 4096);
      const expected = z.object({ file: z.literal("manifest.json"), sha256: z.literal(selection.manifestSha256), bytes: z.literal(bytes.length) }).strict();
      expected.parse(JSON.parse(sidecarBytes.toString()));
    }
    const scratch = savedDataProofMember(manifest, "scratch.json", await readArchiveBytes(path.join(resource.externalId, "scratch.json"), 2 * 1024 * 1024));
    const restore = savedDataProofMember(manifest, "restore-verification.json", await readArchiveBytes(path.join(resource.externalId, "restore-verification.json"), 2 * 1024 * 1024));
    const roundtrip = savedDataProofMember(manifest, "redis-restore-roundtrip.json", await readArchiveBytes(path.join(resource.externalId, "redis-restore-roundtrip.json"), 2 * 1024 * 1024));
    const bindings = bindSavedScratch(input.task, resource, input.resources, selection.scratchResourceIds, scratch, restore, roundtrip, manifest);
    plans.push(RetainedDataPlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retain-data", archive: { root: resource.externalId, manifestPath: selection.manifestPath,
      manifestSha256: selection.manifestSha256, ancillary: sidecar ? [{ path: "manifest-digest.json", size: sidecar.size, sha256: sidecar.sha256 }] : [], inventory, inventoryDigest: finalizationDigest(inventory), taskId: input.task.id, sessionId: input.task.primarySessionId, toolingRevision: input.task.toolingRevision, scratch: bindings } }));
  }
  return plans;
}
/** Only an exact selected scratch pair may use tooling-purpose Docker cleanup. */
export function assertSavedDataPlanLinks(plan: FinalizationResourcePlan[]) {
  for (const entry of plan) if (entry.disposition === "retire-adapter") {
    const saved = plan.find(p => p.id === entry.savedDataResourceId);
    if (entry.purpose !== "tooling") { if (entry.savedDataResourceId) throw new Error("Saved-data authority cannot expand another adapter"); continue; }
    if (entry.adapter !== "docker" || saved?.disposition !== "retain-data" || !["docker-container", "docker-volume"].includes(entry.kind)) throw new Error("Tooling cleanup requires exact saved-data proof");
    const matches = saved.archive.scratch.filter(item => entry.id === item.containerResourceId || entry.id === item.volumeResourceId), binding = matches[0];
    if (matches.length !== 1 || !binding || entry.targets.length !== 1 || entry.stoppedConsumers.length) throw new Error("Saved scratch adapter scope changed");
    const target = entry.targets[0]!;
    if (target.kind !== entry.kind || target.id !== entry.externalId || target.scope.taskId !== saved.archive.taskId || target.scope.purpose !== "tooling" || !("operation" in target.scope) || target.scope.operation !== binding.operation
      || target.id !== (entry.kind === "docker-container" ? binding.containerId : binding.volume)
      || JSON.stringify(entry.dependencies) !== JSON.stringify(entry.kind === "docker-volume" ? [binding.containerResourceId] : [])) throw new Error("Saved scratch target or dependency changed");
  }
  for (const saved of plan) if (saved.disposition === "retain-data") for (const binding of saved.archive.scratch) for (const id of [binding.containerResourceId, binding.volumeResourceId]) {
    if (!plan.some(entry => entry.id === id && entry.disposition === "retire-adapter" && entry.savedDataResourceId === saved.id)) throw new Error("Saved scratch selection is incomplete");
  }
}
export function assertSavedDataCaptureSeparation(plan: FinalizationResourcePlan[], extraPaths: string[] = []) {
  const roots = plan.filter((p): p is Plan => p.disposition === "retain-data").map(p => p.archive.root);
  const captures = [...extraPaths];
  for (const entry of plan) {
    if ("target" in entry && "path" in entry.target) { captures.push(entry.target.path); if ("quarantine" in entry.target) captures.push(entry.target.quarantine.directory); }
    if (entry.disposition === "retire-worktree") captures.push(entry.administrationCapture.path, entry.administrationCapture.quarantine.directory);
    if (entry.disposition === "retire-browser" && entry.capture.type === "standalone") captures.push(entry.capture.target.path, entry.capture.target.quarantine.directory);
  }
  if (roots.some((root, index) => roots.some((other, j) => j !== index && overlap(root, other)) || captures.some(file => overlap(root, file)))) throw new Error("Saved data overlaps an active cleanup capture");
}
export async function assertSavedData(input: { resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[] }) {
  assertSavedDataPlanLinks(input.plan); assertSavedDataCaptureSeparation(input.plan);
  for (const saved of input.plan) if (saved.disposition === "retain-data") {
    const actual = await prepareSavedData({ task: { id: saved.archive.taskId, primarySessionId: saved.archive.sessionId, toolingRevision: saved.archive.toolingRevision }, resources: input.resources,
      selections: [{ resourceId: saved.id, manifestPath: saved.archive.manifestPath, manifestSha256: saved.archive.manifestSha256, scratchResourceIds: saved.archive.scratch.flatMap(item => [item.containerResourceId, item.volumeResourceId]) }] });
    if (finalizationDigest(actual[0]) !== finalizationDigest(saved)) throw new Error("Frozen saved-data identity or bytes changed");
  }
}
