import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { FinalizationContext } from "./finalization-receipts.ts";
import type { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { CleanupObserverInput, CleanupObserverResult } from "./cleanup-observer-schema.ts";
import { CleanupObserverCapability, resolveCleanupObserver, runCleanupResourceObserver } from "./cleanup-resource-observer.ts";
import { LegacyComposeRetentionReceipt } from "./legacy-compose-retention-schema.ts";
import { assertRegisteredPathSharing } from "./cleanup-filesystem.ts";

const ACTION = "finalization-retained-compose";
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
type Database = Pick<PrismaClient, "runtimeMetadataEvent" | "remoteTaskResource" | "remoteTask">;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Entry = z.object({ id: z.string(), key: z.string(), identityDigest: Digest, observation: CleanupObserverResult }).strict();
const Proof = LegacyComposeRetentionReceipt.omit({ revision: true, digest: true, resources: true }).extend({ capability: CleanupObserverCapability, resources: z.array(Entry).min(1).max(16) }).strict();
const same = (a: unknown, b: unknown) => finalizationDigest(a) === finalizationDigest(b);
const where = (active: Active) => ({ runtimeSessionId: active.prepared.sessionId, source: `finalizer-retained:${active.task.id}`, action: ACTION, key: active.prepared.requestKey });
const scope = (active: Active) => ({ version: 1 as const, taskId: active.task.id, sessionId: active.prepared.sessionId, requestKey: active.prepared.requestKey,
  preparedRevision: active.preparation.sequence, preparedDigest: active.binding.preparedDigest,
  cleanup: { operationRevision: active.operationRevision, operationDigest: finalizationDigest(active.operation) } });
function candidates(active: Active) {
  if (active.kind !== "v1") return [];
  return active.binding.resources.filter(group => group.kind === "docker-compose-project" && group.purpose === "development" && group.state === "ready"
    && active.binding.resources.some(source => source.kind === "neon-branch-database" && source.purpose === group.purpose
      && (source.metadata as { supersedes?: unknown } | null)?.supersedes === `local PostGIS in ${group.key} (stopped by owner cutover; volume retained; not restarted)`));
}
function validate(active: Active, proof: z.infer<typeof Proof>) {
  if (active.kind !== "v1" || !same({ ...proof, capability: undefined, resources: undefined }, { ...scope(active), capability: undefined, resources: undefined })) throw new Error("Retained Compose proof belongs to another original operation");
  const selected = candidates(active);
  if (selected.length !== proof.resources.length || new Set(proof.resources.map(entry => entry.id)).size !== proof.resources.length) throw new Error("Retained Compose resource selection changed");
  for (const entry of proof.resources) {
    const resource = selected.find(resource => resource.id === entry.id), observed = entry.observation, retention = observed.retainedCompose;
    if (!resource || entry.key !== resource.key || entry.identityDigest !== finalizationResourceIdentity(resource).identityDigest
      || observed.taskId !== active.task.id || observed.resourceId !== resource.id || observed.resourceIdentityDigest !== entry.identityDigest || observed.adapter !== "compose"
      || observed.dependencies.length || observed.stoppedConsumers.length || !retention || !same(observed.presentTargetDigests, retention.retainedTargetDigests)) throw new Error("Retained Compose proof does not establish its exact stopped source partition");
    const source = active.binding.resources.find(resource => resource.id === retention.sourceResourceId);
    if (!source || finalizationResourceIdentity(source).identityDigest !== retention.sourceIdentityDigest || !["ready", "released"].includes(source.state)
      || source.kind !== "neon-branch-database" || source.purpose !== resource.purpose
      || (source.metadata as { supersedes?: unknown } | null)?.supersedes !== `local PostGIS in ${resource.key} (stopped by owner cutover; volume retained; not restarted)`
      || observed.targets.some(target => !target.kind.startsWith("docker-") || target.scope.taskId !== active.task.id || target.scope.purpose !== "development")
      || observed.targets.filter(target => retention.retainedTargetDigests.includes(target.identityDigest)).map(target => target.kind).sort().join(",") !== "docker-container,docker-network,docker-volume") throw new Error("Retained Compose migration correspondence changed");
  }
}
async function sharing(db: Database, active: Active, proof: z.infer<typeof Proof>) {
  const paths = proof.resources.flatMap(entry => { const value = entry.observation.retainedCompose!; return [value.journal.file, value.config.file, value.cutover.file]; });
  await assertRegisteredPathSharing(db, active.task.id, paths);
  const ancestors = new Set<string>();
  for (const file of paths) for (let cursor = file; ; cursor = path.dirname(cursor)) { ancestors.add(cursor); if (cursor === path.dirname(cursor)) break; }
  if (await db.remoteTask.findFirst({ where: { id: { not: active.task.id }, OR: [{ worktreePath: { in: [...ancestors] } }, ...paths.map(file => ({ worktreePath: { startsWith: file + path.sep } }))] } })) throw new Error("Retained Compose proof overlaps another task worktree");
  const claims = await db.remoteTaskResource.findMany({ where: { taskId: { not: active.task.id }, kind: { in: ["docker-compose-project", "docker-compose", "docker-container", "docker-network", "docker-volume", "task-runtime"] } }, take: 10001 });
  if (claims.length > 10000) throw new Error("Retained Compose ownership inventory exceeds its bound");
  const ids = new Set(proof.resources.flatMap(entry => [active.binding.resources.find(resource => resource.id === entry.id)!.externalId, ...entry.observation.targets.map(target => target.id)]));
  const matches = (value: string) => ids.has(value) || /^[a-f0-9]{12,63}$/.test(value) && [...ids].some(id => /^[a-f0-9]{64}$/.test(id) && id.startsWith(value));
  for (const claim of claims) {
    // Historical Docker receipts use strings, nested member objects and short
    // IDs. Conservatively preserve every exact claim without adopting its data.
    const pending: unknown[] = [claim.externalId, claim.metadata]; let count = 0;
    while (pending.length) {
      if (++count > 10000) throw new Error("Retained Compose claim metadata exceeds its bound");
      const value = pending.pop();
      if (typeof value === "string" && matches(value)) throw new Error("Retained Compose object has another task owner");
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(...Object.values(value));
    }
  }
}
async function saved(db: Database, active: Active) {
  const event = await db.runtimeMetadataEvent.findFirst({ where: where(active) });
  if (!event) return;
  const { legacyOriginalWorkReceipt } = await import("./legacy-original-work.ts");
  if (active.kind !== "v1" || !await legacyOriginalWorkReceipt(db, active.prepared, active.preparation.sequence)) throw new Error("Retained Compose requires its adopted original source archive and capture proof");
  let proof: z.infer<typeof Proof>;
  try { proof = Proof.parse(JSON.parse(event.value!)); } catch { throw new Error("Retained Compose proof is invalid"); }
  validate(active, proof); await sharing(db, active, proof);
  const receipt = LegacyComposeRetentionReceipt.parse({ ...scope(active), revision: event.sequence, digest: finalizationDigest(proof),
    resources: proof.resources.map(({ id, key, identityDigest }) => ({ id, key, identityDigest })) });
  return { event, proof, receipt };
}
/** Database-only projection used inside the original authority transaction. */
export async function legacyComposeRetentionReceipt(db: Database, active: Active) { return (await saved(db, active))?.receipt; }

export const legacyComposeFinalizationDependencies = { resolve: resolveCleanupObserver, observe: runCleanupResourceObserver,
  journalRoot: () => path.join(homedir(), ".local", "state", "drafted", "compose-cleanup") };
/** Same-operation read-only observation. An absent initial journal is not a
 * retained disposition; normal upkeep must first freeze and retire its group. */
export async function ensureLegacyComposeRetention(input: FinalizationContext, active: Active, create: boolean,
  dependencies = legacyComposeFinalizationDependencies) {
  if (active.kind !== "v1") return;
  const prior = await saved(input.prisma, active), selected = candidates(active);
  if (!selected.length) { if (prior) throw new Error("Retained Compose source disappeared from its original inventory"); return; }
  const { legacyOriginalWorkReceipt } = await import("./legacy-original-work.ts");
  // This new Ready-resource disposition must never unlock plain Git removal
  // before the existing owner has adopted recoverable original source.
  if (!await legacyOriginalWorkReceipt(input.prisma, active.prepared, active.preparation.sequence)) return;
  if (!prior && !create) throw new Error("Retained Compose requires its original observed disposition");
  if (!prior) for (const resource of selected) {
    const file = path.join(dependencies.journalRoot(), `${finalizationDigest({ taskId: active.task.id, resourceId: resource.id })}.json`);
    const present = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!present) return;
  }
  const capability = prior?.proof.capability ?? await dependencies.resolve({ task: active.task, config: input.config });
  const resources: z.infer<typeof Entry>[] = [];
  for (const resource of selected) {
    const previous = prior?.proof.resources.find(entry => entry.id === resource.id);
    const request = CleanupObserverInput.parse({ version: 1, task: { id: active.task.id, primarySessionId: active.prepared.sessionId,
      worktreePath: active.binding.worktree, toolingRevision: active.binding.toolingRevision }, resource, resources: active.binding.resources,
      retainedCompose: { preparedRevision: active.preparation.sequence, cleanup: scope(active).cleanup }, stage: previous ? "confirm" : "prepare",
      ...(previous ? { expectedTargets: previous.observation.targets } : {}) });
    const observation = CleanupObserverResult.parse(await dependencies.observe({ capability, request }));
    if (!observation.retainedCompose) throw new Error("Cleanup observer did not verify retained Compose data");
    if (!same(observation.presentTargetDigests, observation.retainedCompose.retainedTargetDigests)) {
      if (prior) throw new Error("Retained Compose has an unretired or recreated member");
      return; // Partial ordinary retirement is not a retention receipt.
    }
    const entry = { id: resource.id, key: resource.key, identityDigest: finalizationResourceIdentity(resource).identityDigest, observation };
    if (previous && !same(entry, previous)) throw new Error("Retained Compose observation changed after supplementation");
    resources.push(entry);
  }
  const proof = Proof.parse({ ...scope(active), capability, resources }); validate(active, proof);
  const { assertPreparedCleanup } = await import("./cleanup-lifecycle.ts");
  return input.prisma.$transaction(async tx => {
    const current = await assertPreparedCleanup({ ...input, prisma: tx }); validate(current, proof); await sharing(tx, current, proof);
    const existing = await saved(tx, current);
    if (existing) { if (!same(existing.proof, proof)) throw new Error("Retained Compose proof changed concurrently"); return existing.receipt; }
    if (!create || await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: `finalizer:${active.task.id}`, action: "finalization-confirmed", key: input.requestKey } })) throw new Error("Confirmed cleanup cannot adopt new retained Compose proof");
    await tx.runtimeMetadataEvent.create({ data: { ...where(current), value: JSON.stringify(proof) } });
    return (await saved(tx, current))!.receipt;
  });
}
