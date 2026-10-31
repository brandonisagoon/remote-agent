import { activeCleanupRoots } from "./cleanup-scope.ts";
import { retainedArchiveResourceIds } from "./archive-retention.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PrismaClient, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { FINALIZATION_PREPARED, PreparedFinalization } from "./finalization-receipts.ts";
import { prepareTaskFinalization } from "./finalization.ts";
import { lstat } from "node:fs/promises";
import { finalizationDigest, assertFinalizationPath, finalizationResourceObservation } from "./finalization-resources.ts";
import { inspectLegacyEvidenceCapture, observeLegacyArchive, observeLegacyEvidenceFile, within } from "./legacy-evidence-files.ts";
import { LEGACY_EVIDENCE_CONFIRMED, LEGACY_EVIDENCE_RETAINED, LegacyEvidenceAdoptionInput, LegacyEvidenceOperationInput, LegacyEvidenceProof, LegacyEvidenceReceipt } from "./legacy-evidence-schema.ts";

import { isEvidenceTree, matchLegacyEvidenceTrees, observeLegacyEvidenceTree } from "./legacy-evidence-tree.ts";
import { assertLegacyEvidenceWriters } from "./legacy-evidence-writers.ts";
import { assertLocalCompletion } from "./local-completion.ts";

type Database = Pick<PrismaClient, "remoteTask" | "remoteTaskResource" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeMetadataEvent">;
type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string };
export const legacyEvidenceDependencies = { prepare: prepareTaskFinalization, writers: assertLegacyEvidenceWriters };

export function legacyEvidenceResourceDigest(resource: RemoteTaskResource) {
  const metadata = resource.metadata && typeof resource.metadata === "object" && !Array.isArray(resource.metadata) ? resource.metadata as Record<string, unknown> : {};
  const { observed: _observed, observedAt: _at, ...immutable } = metadata;
  return finalizationDigest({ id: resource.id, taskId: resource.taskId, key: resource.key, kind: resource.kind, purpose: resource.purpose,
    externalId: resource.externalId, expiresAt: resource.expiresAt?.toISOString() ?? null, createdAt: resource.createdAt.toISOString(), metadata: immutable });
}

async function preparation(prisma: Database, config: ServerConfig, taskId: string, revision: number, requestKey: string, existing = false) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const session = task.primarySessionId ? await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } }) : null;
  const closed = task.phase === "closed" || session?.status === "closed" || Boolean(session?.closedAt);
  if (!session || task.ownerPaused || closed && !existing || session.role !== "primary" || task.machineId !== config.machine || session.machineId !== task.machineId || session.repositoryId !== task.repositoryId || session.cwd !== task.worktreePath) throw new Error("Legacy evidence requires the open original primary and unchanged owner authority");
  if (closed) {
    const { assertPreparedCleanup } = await import("./cleanup-lifecycle.ts");
    const active = await assertPreparedCleanup({ prisma, config, sessionId: session.id, requestKey });
    if (active.preparation.sequence !== revision) throw new Error("Legacy evidence cleanup preparation changed");
  }
  const event = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: revision } });
  if (!event || event.action !== FINALIZATION_PREPARED || event.runtimeSessionId !== session.id || event.source !== `finalizer:${taskId}` || event.key !== requestKey) throw new Error("Legacy evidence requires the exact existing finalization preparation");
  const raw = JSON.parse(event.value!);
  if (raw.version !== undefined) throw new Error("Legacy evidence retention only supplements version 1 preparation");
  const prepared = PreparedFinalization.parse(raw);
  if (prepared.taskId !== task.id || prepared.sessionId !== session.id || prepared.requestKey !== requestKey || prepared.taskWorktree !== task.worktreePath || prepared.branch !== task.branchName || prepared.repositoryId !== task.repositoryId || prepared.machineId !== task.machineId || prepared.connectionId !== task.connectionId || prepared.issueIdentifier !== task.issueIdentifier || prepared.delivery.receipts.contractRevision !== prepared.contractRevision) throw new Error("Legacy evidence preparation identity or verified delivery changed");
  if (prepared.localCompletion) await assertLocalCompletion(prisma, prepared);
  else {
    if (prepared.delivery.boundary !== "merge" || !prepared.delivery.receipts.merge.merged || !prepared.delivery.receipts.merge.sha) throw new Error("Legacy evidence preparation identity or verified merge changed");
    const contract = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: "completion-contract", source: `owner:${taskId}` }, orderBy: { sequence: "desc" } });
    if (contract?.sequence !== prepared.contractRevision || JSON.parse(contract.value ?? "null")?.boundary !== "merge") throw new Error("Legacy evidence completion authority was revoked or replaced");
    const linked = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: prepared.connectionId, resourceType: "issue-identifier", externalId: prepared.issueIdentifier, relationship: "handles", ...(closed ? {} : { endedAt: null }) } });
    if (!linked) throw new Error("Legacy evidence source ownership changed");
  }
  const identityDigest = finalizationDigest({ taskId, sessionId: session.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier,
    worktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot,
    repositoryRoot: getRepositoryConfig(config, task.repositoryId).root });
  return { task, session, event, prepared, identityDigest };
}

function recordedProof(resource: RemoteTaskResource) {
  const metadata = resource.metadata as Record<string, unknown> | null;
  if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata))) throw new Error("Evidence receipt metadata is malformed");
  const sha = metadata?.sha256;
  if (sha !== undefined && (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha))) throw new Error("Recorded evidence digest is malformed");
  const sizes = ["bytes", "size", "byteSize"].filter((key) => metadata?.[key] !== undefined).map((key) => metadata![key]);
  if (sizes.some((size) => typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) || sizes.some((size) => size !== sizes[0])) throw new Error("Recorded evidence sizes conflict or are invalid");
  return { ...(sha !== undefined ? { sha256: sha as string } : {}), ...(sizes.length ? { size: sizes[0] as number } : {}) };
}
function cleanupRoots(task: Awaited<ReturnType<typeof preparation>>["task"], prepared: PreparedFinalization, resources: RemoteTaskResource[], evidenceParents = true, retainedResourceIds = new Set<string>()) {
  const protectedRoots = [prepared.worktree, prepared.registeredWorktree, prepared.gitCwd, prepared.gitDirectory, task.toolingRoot, task.pinnedToolingRoot].filter((value): value is string => Boolean(value));
  return [...new Set([...protectedRoots, ...activeCleanupRoots(resources, retainedResourceIds, evidenceParents)])];
}
function receipt(sequence: number, proof: LegacyEvidenceProof): LegacyEvidenceReceipt { return { proofRevision: sequence, proofDigest: finalizationDigest(proof), proof }; }

async function assertUnsharedDirectory(prisma: Database, taskId: string, resourceId: string, source: string) {
  const ancestors: string[] = [];
  for (let cursor = source; ; cursor = path.dirname(cursor)) { ancestors.push(cursor); if (cursor === path.dirname(cursor)) break; }
  const shared = await prisma.remoteTaskResource.findFirst({ where: { id: { not: resourceId }, OR: [
    { externalId: source }, { externalId: { startsWith: source + path.sep } },
    { taskId: { not: taskId }, externalId: { in: ancestors } },
  ] } });
  if (shared) throw new Error("Directory evidence overlaps another task or resource");
}

async function loadProof(prisma: Database, config: ServerConfig, taskId: string, revision: number) {
  const event = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: revision } });
  if (!event || event.action !== LEGACY_EVIDENCE_RETAINED || event.source !== `owner:${taskId}`) throw new Error("Legacy evidence has no authenticated retention proof");
  const proof = LegacyEvidenceProof.parse(JSON.parse(event.value!));
  const current = await preparation(prisma, config, taskId, proof.preparedRevision, proof.finalizationRequestKey, true);
  const latest = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: current.session.id, source: `owner:${taskId}`, action: LEGACY_EVIDENCE_RETAINED }, orderBy: { sequence: "desc" } });
  if (latest?.sequence !== event.sequence || event.runtimeSessionId !== current.session.id || event.key !== proof.input.requestKey || proof.taskId !== taskId || proof.sessionId !== current.session.id || proof.identityDigest !== current.identityDigest || proof.preparedDigest !== finalizationDigest(JSON.parse(current.event.value!)) || proof.contractRevision !== current.prepared.contractRevision) throw new Error("Legacy evidence proof or preparation authority changed");
  const resources = await prisma.remoteTaskResource.findMany({ where: { taskId } });
  const retainedIds = await retainedArchiveResourceIds(prisma, config, current.prepared);
  const roots = cleanupRoots(current.task, current.prepared, resources, true, retainedIds);
  const wholeRoots = cleanupRoots(current.task, current.prepared, resources, false, retainedIds);
  if (roots.some((root) => within(root, proof.archiveRoot) || within(proof.archiveRoot, root)) || proof.entries.some((entry) => wholeRoots.some((root) => (!isEvidenceTree(entry) && within(root, entry.target.path)) || within(root, entry.target.quarantine.directory)))) throw new Error("Retained evidence now overlaps a task cleanup root");
  for (const entry of proof.entries) {
    if (isEvidenceTree(entry)) { await assertUnsharedDirectory(prisma, taskId, entry.resourceId, entry.target.path); await assertUnsharedDirectory(prisma, taskId, entry.resourceId, entry.target.quarantine.directory); }
    const record = resources.find((resource) => resource.id === entry.resourceId);
    if (!record || record.taskId !== taskId || legacyEvidenceResourceDigest(record) !== entry.identityDigest) throw new Error("Legacy evidence resource receipt changed");
    if (record.state === "released") {
      const confirmed = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: proof.sessionId, source: `legacy-evidence:${taskId}`, action: LEGACY_EVIDENCE_CONFIRMED, key: entry.resourceId } });
      if (confirmed?.value !== JSON.stringify({ proofRevision: event.sequence, proofDigest: finalizationDigest(proof), preparedRevision: proof.preparedRevision, resourceId: entry.resourceId, identityDigest: entry.identityDigest })) throw new Error("Evidence was marked released without independent retirement confirmation");
    }
  }
  return { ...current, receipt: receipt(event.sequence, proof) };
}

// Local authority only: physical saved-copy/capture checks stay at adoption and
// every evidence operation. The cleanup supplement reuses this exact binding.
export const inspectLegacyEvidenceAuthority = loadProof;

/** Only the owner's authenticated route can adopt old receipts. The old
 * preparation and metadata remain byte-for-byte untouched; missing hashes are
 * explicitly new observations, never retroactive historical evidence. */
export async function adoptLegacyEvidence(input: Context & { adoption: LegacyEvidenceAdoptionInput }) {
  const adoption = LegacyEvidenceAdoptionInput.parse(input.adoption);
  const current = await preparation(input.prisma, input.config, input.taskId, adoption.expectedPreparedRevision, adoption.finalizationRequestKey);
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: current.session.id, source: `owner:${input.taskId}`, action: LEGACY_EVIDENCE_RETAINED }, orderBy: { sequence: "desc" } });
  if (prior) {
    const loaded = await loadProof(input.prisma, input.config, input.taskId, prior.sequence);
    if (finalizationDigest(loaded.receipt.proof.input) !== finalizationDigest(adoption)) throw new Error("Legacy evidence already has a different immutable retention proof");
    for (const entry of loaded.receipt.proof.entries) await inspectLegacyEvidenceCapture(loaded.receipt.proof, entry, false);
    await input.prisma.$transaction(async tx => {
      await loadProof(tx, input.config, input.taskId, prior.sequence);
      const { supplementCleanupEvidence } = await import("./cleanup-lifecycle.ts");
      await supplementCleanupEvidence({ prisma: tx, config: input.config, sessionId: current.session.id, requestKey: current.prepared.requestKey }, prior.sequence);
    });
    return loaded.receipt;
  }
  const resources = await input.prisma.remoteTaskResource.findMany({ where: { taskId: input.taskId } });
  const evidence = resources.filter((resource) => resource.kind === "evidence" && resource.state !== "released");
  const ids = adoption.entries.map((entry) => entry.resourceId);
  if (new Set(ids).size !== ids.length || finalizationDigest([...ids].sort()) !== finalizationDigest(evidence.map((resource) => resource.id).sort())) throw new Error("Adoption must name the complete exact unreleased evidence inventory");
  const retainedIds = await retainedArchiveResourceIds(input.prisma, input.config, current.prepared);
  const archive = await observeLegacyArchive(adoption.manifest, input.taskId, cleanupRoots(current.task, current.prepared, resources, true, retainedIds));
  const entries: LegacyEvidenceProof["entries"] = [];
  const wholeRoots = cleanupRoots(current.task, current.prepared, resources, false, retainedIds);
  const paths = new Set<string>();
  for (const request of adoption.entries) {
    const resource = evidence.find((record) => record.id === request.resourceId)!;
    if (!["browser", "development", "review"].includes(resource.purpose) || resource.createdAt > current.event.occurredAt || paths.has(resource.externalId)) throw new Error("Evidence lacks original prepared provenance or has an ambiguous source path");
    paths.add(resource.externalId);
    const recorded = recordedProof(resource);
    const common = { resourceId: resource.id, key: resource.key, kind: "evidence" as const, purpose: resource.purpose as "browser" | "development" | "review", externalId: resource.externalId, createdAt: resource.createdAt.toISOString(), identityDigest: legacyEvidenceResourceDigest(resource), recorded };
    if ("type" in request && request.type === "tree") {
      if (recorded.sha256 !== undefined || recorded.size !== undefined) throw new Error("Directory evidence cannot reinterpret a historical file hash or byte count");
      const protectedRoots = [current.prepared.worktree, current.prepared.registeredWorktree, current.prepared.gitCwd, current.prepared.gitDirectory, current.task.toolingRoot, current.task.pinnedToolingRoot].filter((value): value is string => Boolean(value));
      if (protectedRoots.some(root => within(root, resource.externalId) || within(resource.externalId, root)) || evidence.some(other => other.id !== resource.id && (within(other.externalId, resource.externalId) || within(resource.externalId, other.externalId)))) throw new Error("Directory evidence overlaps protected or other evidence material");
      await assertUnsharedDirectory(input.prisma, input.taskId, resource.id, resource.externalId);
      const source = await observeLegacyEvidenceTree(resource.externalId), retained = await observeLegacyEvidenceTree(request.retainedPath, true);
      if (source.inventoryDigest !== request.inventoryDigest || !within(archive.archiveRoot, retained.path) || retained.path === archive.archiveRoot) throw new Error("Directory evidence inventory or retained scope changed");
      matchLegacyEvidenceTrees(source, retained, archive.members);
      const parentPath = path.dirname(archive.archiveRoot); await assertFinalizationPath(parentPath);
      const parent = await lstat(parentPath);
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o7777) !== 0o700 || parent.dev !== source.inventory[0]!.dev) throw new Error("Directory quarantine needs an existing private parent on the same filesystem");
      const sourceParentPath = path.dirname(source.path); await assertFinalizationPath(sourceParentPath);
      const sourceParent = await lstat(sourceParentPath);
      if (!sourceParent.isDirectory() || sourceParent.uid !== process.getuid?.() || (sourceParent.mode & 0o022) !== 0) throw new Error("Directory evidence source parent is not exclusively owned");
      const directory = path.join(parentPath, `.drafted-finalization-${randomUUID()}`);
      await assertUnsharedDirectory(input.prisma, input.taskId, resource.id, directory);
      if (wholeRoots.some(root => within(root, directory) || within(directory, root))) throw new Error("Directory quarantine must survive outside every cleanup root");
      entries.push({ ...common, digestProvenance: "observed-at-adoption", target: { type: "tree", path: source.path, sourcePaths: [source.path], inventory: source.inventory, sourceParent: { path: sourceParentPath, dev: sourceParent.dev, ino: sourceParent.ino, mode: sourceParent.mode }, quarantineParent: { path: parentPath, dev: parent.dev, ino: parent.ino, mode: parent.mode }, quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } }, retained });
    } else {
      const fileRequest = request as Extract<LegacyEvidenceAdoptionInput["entries"][number], { sha256: string }>;
      const source = await observeLegacyEvidenceFile(resource.externalId);
      if (wholeRoots.some((root) => within(root, source.path))) throw new Error("Legacy evidence capture must survive outside whole-tree cleanup roots");
      const retained = archive.members.get(fileRequest.retainedPath);
      if (!retained || retained.path === source.path || retained.dev === source.dev && retained.ino === source.ino || retained.size !== fileRequest.size || retained.sha256 !== fileRequest.sha256 || source.size !== retained.size || source.sha256 !== retained.sha256 || recorded.sha256 !== undefined && recorded.sha256 !== source.sha256 || recorded.size !== undefined && recorded.size !== source.size) throw new Error("Original evidence, recorded proof and retained archive do not agree");
      const directory = path.join(path.dirname(source.path), `.drafted-evidence-${randomUUID()}`);
      entries.push({ ...common, digestProvenance: recorded.sha256 ? "recorded-receipt" : "observed-at-adoption", target: { ...source, type: "file", quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } }, retained });
    }
  }
  const proof = LegacyEvidenceProof.parse({ version: 1, input: adoption, taskId: input.taskId, sessionId: current.session.id,
    preparedRevision: current.event.sequence, preparedDigest: finalizationDigest(JSON.parse(current.event.value!)), finalizationRequestKey: adoption.finalizationRequestKey,
    identityDigest: current.identityDigest, contractRevision: current.prepared.contractRevision, archiveRoot: archive.archiveRoot, manifest: archive.manifest, ...(archive.manifests ? { manifests: archive.manifests } : {}), entries });
  for (const entry of entries) await inspectLegacyEvidenceCapture(proof, entry, false);
  return input.prisma.$transaction(async (tx) => {
    const changed = await preparation(tx, input.config, input.taskId, proof.preparedRevision, proof.finalizationRequestKey);
    if (changed.identityDigest !== proof.identityDigest || finalizationDigest(JSON.parse(changed.event.value!)) !== proof.preparedDigest) throw new Error("Legacy evidence authority changed during observation");
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: current.session.id, source: `owner:${input.taskId}`, action: LEGACY_EVIDENCE_RETAINED } });
    if (duplicate) {
      const saved = LegacyEvidenceProof.parse(JSON.parse(duplicate.value!));
      if (finalizationDigest(saved.input) !== finalizationDigest(adoption)) throw new Error("Legacy evidence retention was concurrently replaced");
      return (await loadProof(tx, input.config, input.taskId, duplicate.sequence)).receipt;
    }
    const records = await tx.remoteTaskResource.findMany({ where: { taskId: input.taskId, kind: "evidence", state: { not: "released" } } });
    if (records.length !== entries.length || entries.some((entry) => !records.some((record) => record.id === entry.resourceId && legacyEvidenceResourceDigest(record) === entry.identityDigest))) throw new Error("Legacy evidence inventory changed during observation");
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.session.id, source: `owner:${input.taskId}`, action: LEGACY_EVIDENCE_RETAINED, key: adoption.requestKey, value: JSON.stringify(proof) } });
    const { supplementCleanupEvidence } = await import("./cleanup-lifecycle.ts");
    await supplementCleanupEvidence({ prisma: tx, config: input.config, sessionId: current.session.id, requestKey: current.prepared.requestKey }, event.sequence);
    return receipt(event.sequence, proof);
  });
}

/** The normal primary gets only the frozen owner proof. Inspection grants no
 * cleanup permission; both effect boundaries revalidate ordinary finalization. */
export async function manageLegacyEvidence(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; operation: LegacyEvidenceOperationInput }, dependencies: { prepare: typeof prepareTaskFinalization; writers?: typeof assertLegacyEvidenceWriters } = legacyEvidenceDependencies) {
  const operation = LegacyEvidenceOperationInput.parse(input.operation);
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  if (!task) throw new Error("Legacy evidence requires the original primary");
  const loaded = await loadProof(input.prisma, input.config, task.id, operation.proofRevision);
  const result = loaded.receipt, proof = result.proof;
  if (operation.proofDigest !== result.proofDigest || operation.preparedRevision !== proof.preparedRevision || operation.finalizationRequestKey !== proof.finalizationRequestKey) throw new Error("Legacy evidence operation does not match its immutable proof");
  const entry = proof.entries.find((candidate) => candidate.key === operation.resourceKey);
  if (!entry) throw new Error("Resource is outside the authenticated evidence inventory");
  const confirmWhere = { runtimeSessionId: input.sessionId, source: `legacy-evidence:${task.id}`, action: LEGACY_EVIDENCE_CONFIRMED, key: entry.resourceId };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: confirmWhere });
  const confirmation = { proofRevision: result.proofRevision, proofDigest: result.proofDigest, preparedRevision: proof.preparedRevision, resourceId: entry.resourceId, identityDigest: entry.identityDigest };
  if (prior && prior.value !== JSON.stringify(confirmation)) throw new Error("Legacy evidence confirmation linkage changed");
  const prepareAuthority = async () => {
    const { hasPreparedCleanup } = await import("./cleanup-lifecycle.ts");
    const bound = await hasPreparedCleanup(input.prisma, task.id, input.sessionId, proof.finalizationRequestKey);
    // An established operation already pins the accepted task and retention
    // epoch. Each file still gets independent copy/capture checks below; full
    // worktree/archive observation remains at the outer finalizer boundaries.
    // Legacy callers without an operation retain their original full checks.
    return dependencies.prepare({ prisma: input.prisma, config: input.config, sessionId: input.sessionId, requestKey: proof.finalizationRequestKey,
      ...(bound ? { cleanup: true, authorityOnly: true } : {}) });
  };
  if (operation.action !== "inspect") {
    const prepared = await prepareAuthority();
    if (prepared.preparedRevision !== proof.preparedRevision || "version" in prepared) throw new Error("Legacy evidence finalization authority changed");
  }
  await inspectLegacyEvidenceCapture(proof, entry, operation.action === "confirm" || Boolean(prior));
  // Hash saved copies first; fresh writer and open-handle observations should
  // be next to the final authority check, not before a potentially long scan.
  let assertWritersUnchanged: Awaited<ReturnType<typeof assertLegacyEvidenceWriters>> | undefined;
  if (isEvidenceTree(entry) && operation.action !== "inspect") {
    assertWritersUnchanged = await (dependencies.writers ?? assertLegacyEvidenceWriters)({ prisma: input.prisma, config: input.config, task, entry });
    await finalizationResourceObservation.rootIdle(entry.target.path);
    await finalizationResourceObservation.rootIdle(entry.target.quarantine.path);
  }
  if (operation.action !== "inspect") {
    const fresh = await prepareAuthority();
    if (fresh.preparedRevision !== proof.preparedRevision || "version" in fresh) throw new Error("Legacy evidence finalization authority changed during observation");
    await loadProof(input.prisma, input.config, task.id, operation.proofRevision);
    await assertWritersUnchanged?.();
  }
  if (operation.action !== "confirm") return { ...result, resourceId: entry.resourceId, ...(prior ? { confirmedRevision: prior.sequence } : {}) };
  return input.prisma.$transaction(async (tx) => {
    await assertWritersUnchanged?.(tx);
    await loadProof(tx, input.config, task.id, result.proofRevision);
    const currentTask = await tx.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    const { hasPreparedCleanup, assertPreparedCleanup } = await import("./cleanup-lifecycle.ts");
    if (currentTask.phase !== "complete" || await hasPreparedCleanup(tx, task.id, input.sessionId, proof.finalizationRequestKey)) {
      const active = await assertPreparedCleanup({ prisma: tx, config: input.config, sessionId: input.sessionId, requestKey: proof.finalizationRequestKey });
      if (active.preparation.sequence !== proof.preparedRevision) throw new Error("Legacy evidence cleanup preparation changed before confirmation");
    }
    const existing = await tx.runtimeMetadataEvent.findFirst({ where: confirmWhere });
    if (existing && existing.value !== JSON.stringify(confirmation)) throw new Error("Legacy evidence confirmation linkage changed");
    const record = await tx.remoteTaskResource.findUniqueOrThrow({ where: { id: entry.resourceId } });
    if (record.state === "released" && !existing) throw new Error("Evidence was marked released without independent retirement confirmation");
    if (record.state !== "released") await tx.remoteTaskResource.update({ where: { id: record.id }, data: { state: "released" } });
    const event = existing ?? await tx.runtimeMetadataEvent.create({ data: { ...confirmWhere, value: JSON.stringify(confirmation) } });
    return { ...result, resourceId: entry.resourceId, confirmedRevision: event.sequence };
  });
}

/** Server event projection, never a resource.metadata exemption. Fail closed
 * if the original preparation, owner, task pin or any evidence receipt drifts. */
export async function legacyEvidenceProjection(prisma: PrismaClient, config: ServerConfig, task: { id: string; primarySessionId: string | null }) {
  if (!task.primarySessionId) return {};
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}`, action: LEGACY_EVIDENCE_RETAINED }, orderBy: { sequence: "desc" } });
  if (!event) return {};
  try { return { legacyEvidenceRetentionRequired: true as const, legacyEvidenceRetention: (await loadProof(prisma, config, task.id, event.sequence)).receipt }; }
  catch { return { legacyEvidenceRetentionRequired: true as const }; }
}

export async function assertLegacyEvidenceResourceUpdate(prisma: Database, resource: RemoteTaskResource, next: { state: string; metadata?: unknown; expiresAt: Date | null }) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: resource.taskId } });
  if (!task.primarySessionId) return;
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}`, action: LEGACY_EVIDENCE_RETAINED }, orderBy: { sequence: "desc" } });
  if (!event) return;
  const proof = LegacyEvidenceProof.parse(JSON.parse(event.value!));
  if (next.state === "released" && path.isAbsolute(resource.externalId)) for (const tree of proof.entries.filter(isEvidenceTree)) {
    if (tree.resourceId !== resource.id && within(resource.externalId, tree.target.path)) {
      const captured = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `legacy-evidence:${task.id}`, action: LEGACY_EVIDENCE_CONFIRMED, key: tree.resourceId } });
      const expected = { proofRevision: event.sequence, proofDigest: finalizationDigest(proof), preparedRevision: proof.preparedRevision, resourceId: tree.resourceId, identityDigest: tree.identityDigest };
      if (captured?.value !== JSON.stringify(expected)) throw new Error("Parent cleanup requires confirmed directory evidence capture");
    }
  }
  const entry = proof.entries.find((candidate) => candidate.resourceId === resource.id);
  if (!entry) return;
  if (next.state !== resource.state && (next.state === "released" || resource.state === "released") || legacyEvidenceResourceDigest({ ...resource, ...next, metadata: (next.metadata ?? resource.metadata) as RemoteTaskResource["metadata"] }) !== entry.identityDigest) throw new Error("Authenticated legacy evidence must retain its original receipt; use independently verified evidence confirmation to release it");
}
