import { observeGeneratedCacheOwner } from "./generated-cache-owner.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { inspectCleanupSupplementAuthority, CLEANUP_OPERATION } from "./cleanup-lifecycle.ts";
import { assertRegisteredPathSharing } from "./cleanup-filesystem.ts";
import { LegacyEvidenceProof } from "./legacy-evidence-schema.ts";
import { ArchiveRetentionProof } from "./archive-retention-schema.ts";
import { activeCleanupRoots } from "./cleanup-scope.ts";
import { FINALIZATION_PREPARED, FINALIZATION_CONFIRMED, type PreparedFinalization } from "./finalization-receipts.ts";
import { finalizationDigest, finalizationResourceObservation, type ResourceObservation } from "./finalization-resources.ts";
import { assertLegacyOriginalWorkFiles, prepareLegacyOriginalWorkFiles } from "./legacy-original-work-files.ts";
import { LEGACY_ORIGINAL_WORK, LegacyOriginalWorkAdoption, LegacyOriginalWorkProof, LegacyOriginalWorkReceipt } from "./legacy-original-work-schema.ts";

type Database = Pick<PrismaClient, "remoteTask" | "remoteTaskResource" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeMetadataEvent">;
type Active = Awaited<ReturnType<typeof inspectCleanupSupplementAuthority>>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (a: string, b: string) => a === b || b.startsWith(a + path.sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const where = (prepared: PreparedFinalization) => ({ runtimeSessionId: prepared.sessionId, source: `owner:${prepared.taskId}`, action: LEGACY_ORIGINAL_WORK, key: prepared.requestKey });
const bindingDigest = (active: Active) => finalizationDigest({ ...active.binding, resources: active.binding.resources.map(({ state: _state, ...resource }) => resource) });

/** Cheap projection: raw historical receipts and all proof references stay
 * exact. Physical archive/source/admin observation belongs at full boundaries. */
export async function legacyOriginalWorkReceipt(prisma: Pick<PrismaClient, "runtimeMetadataEvent">, prepared: PreparedFinalization, preparedRevision: number) {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: where(prepared) });
  if (!event) return undefined;
  const proof = LegacyOriginalWorkProof.parse(JSON.parse(event.value!));
  const preparation = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: preparedRevision } });
  const operation = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: proof.operationRevision } });
  if (!preparation?.value || preparation.action !== FINALIZATION_PREPARED || preparation.source !== `finalizer:${prepared.taskId}` || preparation.runtimeSessionId !== prepared.sessionId || preparation.key !== prepared.requestKey
    || !operation?.value || operation.action !== CLEANUP_OPERATION || operation.source !== `finalizer:${prepared.taskId}` || operation.runtimeSessionId !== prepared.sessionId || operation.key !== prepared.requestKey
    || proof.taskId !== prepared.taskId || proof.sessionId !== prepared.sessionId || proof.requestKey !== prepared.requestKey || proof.preparedRevision !== preparedRevision
    || proof.preparedRawDigest !== hash(preparation.value) || proof.preparedDigest !== finalizationDigest(prepared) || finalizationDigest(JSON.parse(preparation.value)) !== proof.preparedDigest
    || proof.operationRawDigest !== hash(operation.value) || proof.operationDigest !== finalizationDigest(JSON.parse(operation.value))
    || proof.input.expectedPreparedRevision !== preparedRevision || proof.input.expectedPreparedRawDigest !== proof.preparedRawDigest
    || proof.input.expectedOperationRevision !== proof.operationRevision || proof.input.expectedOperationRawDigest !== proof.operationRawDigest || proof.input.expectedOperationDigest !== proof.operationDigest
    || proof.input.finalizationRequestKey !== prepared.requestKey || proof.originalWork.target.path !== prepared.worktree || proof.originalWork.snapshot.head !== prepared.revision
    || proof.originalWork.snapshot.branch !== prepared.branch || !proof.originalWork.snapshot.clean || proof.originalWork.snapshot.fingerprint !== prepared.delivery.receipts.snapshot.fingerprint
    || proof.originalWork.restore.gitDirectory !== prepared.gitDirectory || proof.originalWork.archive.root !== proof.input.archive.archiveRoot
    || proof.originalWork.archive.manifestPath !== proof.input.archive.manifestPath || proof.originalWork.archive.manifestSha256 !== proof.input.archive.manifestSha256) throw new Error("Original source supplement differs from its unchanged preparation or operation");
  return LegacyOriginalWorkReceipt.parse({ revision: event.sequence, digest: finalizationDigest(proof), proof });
}

async function assertStorage(prisma: Database, active: Active, proof: LegacyOriginalWorkProof) {
  const original = proof.originalWork, storage = [original.archive.root, original.target.quarantine.directory, original.administration.administrationCapture.quarantine.directory];
  const resources = await prisma.remoteTaskResource.findMany({ where: { taskId: active.task.id } });
  const roots = [active.prepared.worktree, active.prepared.gitDirectory, active.binding.repositoryRoot, active.binding.toolingRoot, active.binding.pinnedToolingRoot,
    ...activeCleanupRoots(resources), ...resources.filter(resource => path.isAbsolute(resource.externalId)).map(resource => resource.externalId)].filter((value): value is string => Boolean(value));
  // Retained evidence/provenance may be outside registered resources. It must
  // not be swallowed by the new archive or source/admin destinations.
  for (const reference of active.binding.authority) {
    if (!["legacy-evidence-retained", "finalization-archive-retention"].includes(reference.action)) continue;
    const event = await prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: reference.revision } });
    if (hash(event.value ?? "") !== reference.digest) throw new Error("Original retained evidence changed");
    const saved = JSON.parse(event.value!);
    if (typeof saved.archiveRoot === "string") roots.push(saved.archiveRoot);
    for (const entry of saved.resources ?? []) if (typeof entry.archive?.root === "string") roots.push(entry.archive.root);
  }
  if (storage.some((file, index) => roots.some(root => overlaps(root, file)) || storage.some((other, j) => j !== index && overlaps(file, other)))) throw new Error("Original archive or capture storage overlaps protected material or cleanup roots");
  const scopes = [original.target.path, original.administration.administrationCapture.path, ...storage];
  await assertRegisteredPathSharing(prisma, active.task.id, scopes);
  // File-only retention proofs intentionally have no TaskResource. Preserve
  // those claims too, including captures kept after the other task closed.
  const retained = await prisma.runtimeMetadataEvent.findMany({ where: { action: { in: [LEGACY_ORIGINAL_WORK, "legacy-evidence-retained", "finalization-archive-retention"] },
    NOT: { source: { in: [`owner:${active.task.id}`, `finalizer-archives:${active.task.id}`] } } }, take: 10_001 });
  if (retained.length > 10_000) throw new Error("Original retained path claims exceed the local verification bound");
  for (const event of retained) {
    const value = JSON.parse(event.value ?? "null"); let taskId: string, expectedSource: string, protectedPaths: string[];
    if (event.action === LEGACY_ORIGINAL_WORK) {
      const saved = LegacyOriginalWorkProof.parse(value); taskId = saved.taskId; expectedSource = `owner:${taskId}`;
      protectedPaths = [saved.originalWork.archive.root, saved.originalWork.target.quarantine.directory, saved.originalWork.administration.administrationCapture.quarantine.directory];
    } else if (event.action === "legacy-evidence-retained") {
      const saved = LegacyEvidenceProof.parse(value); taskId = saved.taskId; expectedSource = `owner:${taskId}`;
      protectedPaths = [saved.archiveRoot, ...saved.entries.map(entry => entry.target.quarantine.directory)];
    } else {
      const saved = ArchiveRetentionProof.parse(value); taskId = saved.taskId; expectedSource = `finalizer-archives:${taskId}`;
      protectedPaths = saved.resources.map(resource => resource.archive.root);
    }
    if (event.source !== expectedSource || taskId === active.task.id || protectedPaths.some(root => scopes.some(scope => overlaps(root, scope)))) throw new Error("Original source capture overlaps or cannot verify another task's retained proof");
  }

  const ancestors = new Set<string>();
  for (const scope of scopes) for (let cursor = scope; ; cursor = path.dirname(cursor)) { ancestors.add(cursor); if (cursor === path.dirname(cursor)) break; }
  if (await prisma.remoteTask.findFirst({ where: { id: { not: active.task.id }, OR: [{ worktreePath: { in: [...ancestors] } }, ...scopes.map(scope => ({ worktreePath: { startsWith: scope + path.sep } }))] } })) throw new Error("Original source capture overlaps another registered worktree");
}

/** Shared by the owner adoption CAS and the normal finalizer's compact renewal.
 * It gives no effect authority; the caller still uses its original operation. */
export async function assertLegacyOriginalWorkAuthority(prisma: Database, active: Active, receipt: LegacyOriginalWorkReceipt, config?: ServerConfig) {
  if (active.kind !== "v1" || receipt.digest !== finalizationDigest(receipt.proof) || receipt.proof.bindingDigest !== bindingDigest(active) || receipt.proof.toolingRevision !== active.binding.toolingRevision
    || receipt.proof.preparedRevision !== active.preparation.sequence || receipt.proof.operationRevision !== active.operationRevision || receipt.proof.operationDigest !== finalizationDigest(active.operation)) throw new Error("Original source supplement authority or task identity changed");
  const current = await legacyOriginalWorkReceipt(prisma, active.prepared, active.preparation.sequence);
  if (!current || finalizationDigest(current) !== finalizationDigest(receipt)) throw new Error("Original source supplement was replaced");
  await assertStorage(prisma, active, receipt.proof);
  if (receipt.proof.originalWork.generatedData) {
    if (!config) throw Error("Generated source renewal needs the server-configured native observer");
    await observeGeneratedCacheOwner({ prisma, config, task:active.task,preparedRevision:active.preparation.sequence,requestKey:active.prepared.requestKey,
      operationRevision:active.operationRevision,operationDigest:finalizationDigest(active.operation),target:receipt.proof.originalWork.target,ownerSha256:receipt.proof.originalWork.generatedData.ownerSha256 });
    // Compact authorization is a physical boundary too: root/package identity
    // alone cannot establish that writable cache bytes remain unchanged.
    await assertLegacyOriginalWorkFiles({ taskId:active.task.id,originalWork:receipt.proof.originalWork,removed:false },legacyOriginalWorkDependencies.observation);
  }
}

export const legacyOriginalWorkDependencies = { observation: finalizationResourceObservation as ResourceObservation };
export async function adoptLegacyOriginalWork(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; adoption: LegacyOriginalWorkAdoption }) {
  const adoption = LegacyOriginalWorkAdoption.parse(input.adoption);
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Original source adoption requires its original primary");
  const context = { prisma: input.prisma, config: input.config, sessionId: task.primarySessionId, requestKey: adoption.finalizationRequestKey };
  const active = await inspectCleanupSupplementAuthority(context);
  if (active.kind !== "v1" || active.task.id !== input.taskId || active.preparation.sequence !== adoption.expectedPreparedRevision || hash(active.preparation.value!) !== adoption.expectedPreparedRawDigest
    || active.operationRevision !== adoption.expectedOperationRevision || finalizationDigest(active.operation) !== adoption.expectedOperationDigest) throw new Error("Original source adoption requires its exact prepared operation");
  const operation = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: active.operationRevision } });
  if (hash(operation.value!) !== adoption.expectedOperationRawDigest) throw new Error("Original cleanup operation bytes changed");
  if (await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: active.binding.sessionId, source: `finalizer:${input.taskId}`, key: active.prepared.requestKey, action: FINALIZATION_CONFIRMED } })) throw new Error("Confirmed cleanup cannot adopt original source");
  const existing = await legacyOriginalWorkReceipt(input.prisma, active.prepared, active.preparation.sequence);
  if (existing) {
    if (finalizationDigest(existing.proof.input) !== finalizationDigest(adoption)) throw new Error("Original source already has a different immutable adoption");
    await assertLegacyOriginalWorkAuthority(input.prisma, active, existing, input.config);
    await assertLegacyOriginalWorkFiles({ taskId: input.taskId, originalWork: existing.proof.originalWork, removed: false }, legacyOriginalWorkDependencies.observation);
    await assertLegacyOriginalWorkAuthority(input.prisma, await inspectCleanupSupplementAuthority(context), existing, input.config);
    return existing;
  }
  const originalWork = await prepareLegacyOriginalWorkFiles({ taskId: input.taskId, worktree: active.prepared.worktree, branch: active.prepared.branch, approvedHead: active.prepared.revision,
    fingerprint: active.prepared.delivery.receipts.snapshot.fingerprint, archive: adoption.archive,
    observeGeneratedOwner: () => observeGeneratedCacheOwner({ prisma:input.prisma,config:input.config,task:active.task,preparedRevision:active.preparation.sequence,requestKey:active.prepared.requestKey,operationRevision:active.operationRevision,operationDigest:finalizationDigest(active.operation) }) }, legacyOriginalWorkDependencies.observation);
  const proof = LegacyOriginalWorkProof.parse({ version: 1, input: adoption, taskId: input.taskId, sessionId: active.binding.sessionId, toolingRevision: active.binding.toolingRevision,
    requestKey: active.prepared.requestKey, preparedRevision: active.preparation.sequence, preparedDigest: finalizationDigest(active.prepared), preparedRawDigest: hash(active.preparation.value!),
    operationRevision: active.operationRevision, operationDigest: finalizationDigest(active.operation), operationRawDigest: hash(operation.value!), bindingDigest: bindingDigest(active), originalWork });
  await assertStorage(input.prisma, active, proof);
  return input.prisma.$transaction(async tx => {
    const fresh = await inspectCleanupSupplementAuthority({ ...context, prisma: tx });
    if (fresh.kind !== "v1" || bindingDigest(fresh) !== proof.bindingDigest || fresh.preparation.value !== active.preparation.value || fresh.operationRevision !== proof.operationRevision || finalizationDigest(fresh.operation) !== proof.operationDigest) throw new Error("Original source authority changed during observation");
    if (await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: active.binding.sessionId, source: `finalizer:${input.taskId}`, key: active.prepared.requestKey, action: FINALIZATION_CONFIRMED } })) throw new Error("Cleanup confirmed during original source adoption");
    const freshOperation = await tx.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: proof.operationRevision } });
    if (freshOperation.value !== operation.value || hash(freshOperation.value ?? "") !== proof.operationRawDigest) throw new Error("Original cleanup operation bytes changed during adoption");
    await assertStorage(tx, fresh, proof);
    if (await legacyOriginalWorkReceipt(tx, active.prepared, active.preparation.sequence)) throw new Error("Original source was adopted concurrently; retry the same request");
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where(active.prepared), value: JSON.stringify(proof) } });
    return LegacyOriginalWorkReceipt.parse({ revision: event.sequence, digest: finalizationDigest(proof), proof });
  });
}
