import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { PreparedFinalization } from "./finalization-receipts.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { archiveMember, observeSavedArchive, type SavedArchiveSelection } from "./archive-observation.ts";
import { ARCHIVE_RETENTION, ArchiveRetentionProof, ArchiveRetentionReceipt, ArchiveRetentionCheck } from "./archive-retention-schema.ts";
import { latestRetirement, RetirementGrant, retirementDigest } from "./retirement-receipts.ts";
import { activeCleanupRoots } from "./cleanup-scope.ts";
import { PreparationDiagnosticError } from "./preparation-errors.ts";
import { assertLocalCompletion } from "./local-completion.ts";

type Database = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "remoteTaskResource" | "runtimeMetadataEvent" | "runtimeSessionResourceLink">;
type Context = { prisma: PrismaClient; config: ServerConfig; preparedRevision: number; taskId: string };
const within = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const archiveResources = (resources: RemoteTaskResource[]) => resources.filter(resource => ["evidence-archive", "private-backup"].includes(resource.kind) && ["development", "review", "browser"].includes(resource.purpose));
const where = (taskId: string, sessionId: string) => ({ runtimeSessionId: sessionId, source: `finalizer-archives:${taskId}`, action: ARCHIVE_RETENTION });

/** Read-only identity checks also support closed-task upkeep. A confirmed close
 * cannot widen the archive scope or erase the original preparation/grant. */
async function context(prisma: Database, config: ServerConfig, taskId: string, preparedRevision: number) {
  const event = await prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: preparedRevision } });
  const raw = JSON.parse(event.value!);
  if (raw.version !== undefined) throw new Error("Saved archive retention supplements only version 1 preparation");
  const prepared = PreparedFinalization.parse(raw);
  if (event.action !== "finalization-prepared" || event.source !== `finalizer:${taskId}` || event.runtimeSessionId !== prepared.sessionId || event.key !== prepared.requestKey || prepared.taskId !== taskId) throw new Error("Saved archives require the exact existing preparation");
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: prepared.sessionId } });
  const confirmed = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: "finalization-confirmed", source: event.source, key: event.key } });
  const closed = task.phase === "closed" || session.status === "closed" || Boolean(session.closedAt);
  let continuation = false;
  if (closed && !confirmed) {
    const { assertPreparedCleanup } = await import("./cleanup-lifecycle.ts");
    const active = await assertPreparedCleanup({ prisma, config, sessionId: session.id, requestKey: prepared.requestKey });
    if (active.preparation.sequence !== event.sequence) throw new Error("Saved archive preparation changed");
    continuation = active.closedContinuation;
  } else if (!["complete", "closed"].includes(task.phase)) {
    const { inspectPreparedCleanupAuthority } = await import("./cleanup-lifecycle.ts");
    await inspectPreparedCleanupAuthority({ prisma, config, sessionId: session.id, requestKey: prepared.requestKey });
  }
  if (task.primarySessionId !== session.id || session.role !== "primary" || task.ownerPaused
    || closed && !continuation && (!confirmed || JSON.parse(confirmed.value!).preparedRevision !== event.sequence)
    || task.machineId !== config.machine || session.machineId !== task.machineId || session.repositoryId !== task.repositoryId || session.cwd !== task.worktreePath
    || prepared.taskWorktree !== task.worktreePath || prepared.branch !== task.branchName || prepared.repositoryId !== task.repositoryId || prepared.machineId !== task.machineId
    || prepared.connectionId !== task.connectionId || prepared.issueIdentifier !== task.issueIdentifier) throw new Error("Saved archive task or original primary changed");
  if (prepared.localCompletion) await assertLocalCompletion(prisma, prepared);
  else {
    const contract = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, source: `owner:${taskId}`, action: "completion-contract" }, orderBy: { sequence: "desc" } });
    if (contract?.sequence !== prepared.contractRevision || JSON.parse(contract.value ?? "null")?.boundary !== "merge") throw new Error("Saved archive completion authority changed");
    const link = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: prepared.connectionId, resourceType: "issue-identifier", externalId: prepared.issueIdentifier, relationship: "handles", ...(task.phase === "closed" || session.status === "closed" ? {} : { endedAt: null }) } });
    if (!link) throw new Error("Saved archive source ownership changed");
  }
  if (prepared.retirementAuthority) {
    const latest = await latestRetirement(prisma, taskId, session.id), grant = latest && RetirementGrant.safeParse(JSON.parse(latest.value!));
    if (!latest || !grant?.success || latest.sequence !== prepared.retirementAuthority.revision || retirementDigest(grant.data) !== prepared.retirementAuthority.digest) throw new Error("Saved archive retirement authority changed");
  }
  const resources = await prisma.remoteTaskResource.findMany({ where: { taskId }, orderBy: { id: "asc" } });
  const identityDigest = finalizationDigest({ taskId, sessionId: session.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier,
    worktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot,
    repositoryRoot: getRepositoryConfig(config, task.repositoryId).root });
  return { task, session, event, prepared, resources, identityDigest, preparedDigest: sha(event.value!) };
}

function receipt(revision: number, proof: ArchiveRetentionProof): ArchiveRetentionReceipt {
  const { archives: _archives, ...identity } = proof;
  return ArchiveRetentionReceipt.parse({ ...identity, proofRevision: revision, proofDigest: finalizationDigest(proof) });
}

function assertRecords(current: Awaited<ReturnType<typeof context>>, proof: ArchiveRetentionProof) {
  if (proof.taskId !== current.task.id || proof.sessionId !== current.session.id || proof.requestKey !== current.prepared.requestKey || proof.preparedRevision !== current.event.sequence
    || proof.preparedDigest !== current.preparedDigest || proof.contractRevision !== current.prepared.contractRevision || proof.identityDigest !== current.identityDigest || proof.toolingRevision !== current.task.toolingRevision) throw new Error("Saved archive preparation or tooling identity changed");
  const records = archiveResources(current.resources).filter(resource => resource.state !== "released" || proof.resources.some(entry => entry.id === resource.id));
  if (records.length !== proof.resources.length || new Set(proof.resources.map(entry => entry.id)).size !== proof.resources.length) throw new Error("Saved archive resource inventory changed");
  for (const entry of proof.resources) {
    const record = records.find(resource => resource.id === entry.id);
    if (!record || record.state !== entry.state || finalizationResourceIdentity(record).identityDigest !== entry.identityDigest) throw new Error("Saved archive resource receipt changed");
  }
  const cleanup = activeCleanupRoots(current.resources, new Set(proof.resources.map(resource => resource.id)));
  if (proof.archives.some(archive => cleanup.some(root => within(root, archive.selection.root) || within(archive.selection.root, root)))) throw new Error("Saved archive now overlaps an active cleanup resource");
}

async function load(prisma: Database, config: ServerConfig, taskId: string, revision: number) {
  const event = await prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: revision } });
  const proof = ArchiveRetentionProof.parse(JSON.parse(event.value!));
  const current = await context(prisma, config, taskId, proof.preparedRevision);
  const latest = await prisma.runtimeMetadataEvent.findFirst({ where: where(taskId, current.session.id), orderBy: { sequence: "desc" } });
  if (event.action !== ARCHIVE_RETENTION || event.source !== `finalizer-archives:${taskId}` || event.runtimeSessionId !== current.session.id || event.key !== proof.requestKey || latest?.sequence !== event.sequence) throw new Error("Saved archive retention proof changed");
  assertRecords(current, proof);
  return { ...current, proof, receipt: receipt(event.sequence, proof) };
}

async function verifyFiles(proof: ArchiveRetentionProof) {
  for (const archive of proof.archives) {
    const observed = await observeSavedArchive(archive.selection);
    if (observed.inventoryDigest !== archive.inventoryDigest || finalizationDigest(observed.inventory) !== finalizationDigest(archive.inventory)
      || finalizationDigest(observed.ancillary) !== finalizationDigest(archive.ancillary) || observed.manifestEntries !== archive.manifestEntries) throw new Error("Retained archive contents or inode inventory changed");
  }
}

/** Called only after ordinary finalization authority has been verified. This
 * adds an immutable retention observation, never replaces an existing v1 event. */
export async function ensureArchiveRetention(input: Context): Promise<ArchiveRetentionReceipt | undefined> {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Saved archives require the original primary");
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: where(task.id, task.primarySessionId), orderBy: { sequence: "desc" } });
  if (prior) {
    const loaded = await load(input.prisma, input.config, task.id, prior.sequence);
    if (loaded.event.sequence !== input.preparedRevision) throw new Error("Saved archives belong to another preparation");
    await verifyFiles(loaded.proof); await load(input.prisma, input.config, task.id, prior.sequence);
    return loaded.receipt;
  }
  const candidates = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id, kind: { in: ["evidence-archive", "private-backup"] }, purpose: { in: ["development", "review", "browser"] }, state: { not: "released" } } });
  if (!candidates.length) return undefined;
  const current = await context(input.prisma, input.config, task.id, input.preparedRevision);
  if (current.task.phase === "closed" || current.session.status === "closed") throw new Error("New archive retention requires the open prepared primary");
  if (candidates.some(resource => resource.createdAt > current.event.occurredAt)) throw new Error("Saved archive was not registered before the existing preparation");
  const Manifest = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), entries: z.number().int().nonnegative().optional() }).passthrough();
  const Root = z.object({ archival: z.literal(true), manifest: Manifest, addenda: z.array(Manifest).max(20).optional(), finalCleanupReceipt: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).passthrough();
  type RootMetadata = Pick<z.infer<typeof Root>, "manifest" | "addenda" | "finalCleanupReceipt"> & { format?: "task-private-backup/v1" };
  const roots = candidates.flatMap(resource => {
    if (resource.kind === "private-backup") {
      const metadata = z.object({ manifest: z.string() }).passthrough().parse(resource.metadata);
      const match = /^(MANIFEST\.json) \(sha256 ([a-f0-9]{64})\)$/.exec(metadata.manifest);
      if (!match) throw new Error("Private backup requires its exact recorded manifest digest");
      return [{ resource, metadata: { manifest: { path: match[1]!, sha256: match[2]! }, format: "task-private-backup/v1" as const } as RootMetadata }];
    }
    const parsed = Root.safeParse(resource.metadata);
    return parsed.success ? [{ resource, metadata: { manifest: parsed.data.manifest, addenda: parsed.data.addenda, finalCleanupReceipt: parsed.data.finalCleanupReceipt } as RootMetadata }] : [];
  });
  if (!roots.length || roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && within(root.resource.externalId, other.resource.externalId)))) throw new Error("Saved archives require separate exact registered manifest roots");
  const archives: ArchiveRetentionProof["archives"] = [];
  for (const { resource, metadata } of roots) {
    const root = resource.externalId;
    if (!path.isAbsolute(root) || path.normalize(root) !== root || [current.prepared.worktree, current.prepared.gitCwd, current.prepared.gitDirectory, current.task.toolingRoot, current.task.pinnedToolingRoot].filter((value): value is string => Boolean(value)).some(file => within(file, root) || within(root, file))) throw new Error("Saved archive overlaps a protected repository or cleanup root");
    if (activeCleanupRoots(current.resources, new Set(candidates.map(candidate => candidate.id))).some(other => within(root, other) || within(other, root))) throw new Error("Saved archive overlaps another active cleanup resource");
    const manifests = [metadata.manifest, ...(metadata.addenda ?? [])].map(({ path, sha256, entries }) => ({ path, sha256, ...(entries === undefined ? {} : { entries }) }));
    if (current.prepared.localCompletion) throw new PreparationDiagnosticError("LOCAL_RETENTION_UNSUPPORTED");
    const selection: SavedArchiveSelection = metadata.format === "task-private-backup/v1"
      ? { format: metadata.format, root, manifests: [manifests[0]!], taskId: task.id, issueIdentifier: current.prepared.issueIdentifier }
      : { root, manifests, taskId: task.id, issueIdentifier: current.prepared.issueIdentifier, mergeCommit: current.prepared.delivery.receipts.merge.sha! };
    const observed = await observeSavedArchive(selection);
    if (metadata.finalCleanupReceipt) {
      const absolute = archiveMember(root, metadata.finalCleanupReceipt.path), file = observed.inventory.find(entry => path.join(root, entry.path) === absolute);
      if (!file || file.kind !== "file" || file.sha256 !== metadata.finalCleanupReceipt.sha256) throw new Error("Saved cleanup receipt differs from its registered digest");
    }
    archives.push({ rootResourceId: resource.id, selection, ...observed });
  }
  const resources = candidates.map(resource => {
    const containing = archives.filter(archive => within(archive.selection.root, resource.externalId));
    if (containing.length !== 1) throw new Error("Saved archive receipt is outside its verified root");
    const archive = containing[0]!, relative = path.relative(archive.selection.root, resource.externalId) || ".";
    const member = archive.inventory.find(entry => entry.path === relative), metadata: { sha256?: string } = resource.kind === "private-backup"
      ? {} : z.object({ archival: z.literal(true), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).passthrough().parse(resource.metadata);
    if (resource.kind === "private-backup" && (archive.rootResourceId !== resource.id || relative !== "." || !("format" in archive.selection))) throw new Error("Private backup receipt must be its independently verified root");
    if (!member || !["file", "directory"].includes(member.kind) || metadata.sha256 && (member.kind !== "file" || member.sha256 !== metadata.sha256)) throw new Error("Saved archive receipt has no matching verified member");
    const first = archive.selection.manifests[0]!;
    return { ...finalizationResourceIdentity(resource), kind: resource.kind as "evidence-archive" | "private-backup", disposition: "retain-archive" as const, state: resource.state,
      archive: { root: archive.selection.root, manifestPath: archiveMember(archive.selection.root, first.path), manifestSha256: first.sha256, inventoryDigest: archive.inventoryDigest } };
  });
  const proof = ArchiveRetentionProof.parse({ version: 1, taskId: task.id, sessionId: current.session.id, requestKey: current.prepared.requestKey, preparedRevision: current.event.sequence, preparedDigest: current.preparedDigest,
    contractRevision: current.prepared.contractRevision, identityDigest: current.identityDigest, toolingRevision: current.task.toolingRevision, resources, archives });
  return input.prisma.$transaction(async tx => {
    const fresh = await context(tx, input.config, task.id, input.preparedRevision); assertRecords(fresh, proof);
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where: where(task.id, current.session.id), orderBy: { sequence: "desc" } });
    if (duplicate) { if (finalizationDigest(JSON.parse(duplicate.value!)) !== finalizationDigest(proof)) throw new Error("Saved archive proof was concurrently replaced"); return receipt(duplicate.sequence, proof); }
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where(task.id, current.session.id), key: proof.requestKey, value: JSON.stringify(proof) } });
    return receipt(event.sequence, proof);
  });
}

/** Database-only gate for transactions; callers verify bytes outside the lock. */
export async function retainedArchiveResourceIds(prisma: Database, config: ServerConfig, prepared: PreparedFinalization) {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: where(prepared.taskId, prepared.sessionId), orderBy: { sequence: "desc" } });
  if (!event) return new Set<string>();
  const loaded = await load(prisma, config, prepared.taskId, event.sequence);
  if (loaded.prepared.requestKey !== prepared.requestKey || finalizationDigest(loaded.prepared) !== finalizationDigest(prepared)) throw new Error("Saved archive preparation changed");
  return new Set(loaded.proof.resources.map(resource => resource.id));
}

export async function verifyPreparedArchives(prisma: PrismaClient, config: ServerConfig, prepared: PreparedFinalization) {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: where(prepared.taskId, prepared.sessionId), orderBy: { sequence: "desc" } });
  if (!event) return undefined;
  const loaded = await load(prisma, config, prepared.taskId, event.sequence);
  if (finalizationDigest(loaded.prepared) !== finalizationDigest(prepared)) throw new Error("Saved archive preparation changed");
  await verifyFiles(loaded.proof); await load(prisma, config, prepared.taskId, event.sequence);
  return loaded.receipt;
}

export async function verifyArchiveRetention(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; check: ArchiveRetentionCheck }) {
  const check = ArchiveRetentionCheck.parse(input.check), task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  if (!task) throw new Error("Saved archive inspection requires its original primary");
  const loaded = await load(input.prisma, input.config, task.id, check.proofRevision);
  if (loaded.receipt.proofDigest !== check.proofDigest || loaded.receipt.preparedRevision !== check.preparedRevision || loaded.receipt.requestKey !== check.requestKey) throw new Error("Saved archive check does not match its immutable proof");
  await verifyFiles(loaded.proof); await load(input.prisma, input.config, task.id, check.proofRevision);
  return loaded.receipt;
}

export async function archiveRetentionProjection(prisma: PrismaClient, config: ServerConfig, task: { id: string; primarySessionId: string | null }) {
  if (!task.primarySessionId) return {};
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: where(task.id, task.primarySessionId), orderBy: { sequence: "desc" } });
  if (!event) return {};
  try { return { archiveRetentionRequired: true as const, archiveRetention: (await load(prisma, config, task.id, event.sequence)).receipt }; }
  catch { return { archiveRetentionRequired: true as const }; }
}

export async function assertArchiveResourceUpdate(prisma: Database, resource: RemoteTaskResource, next: { state: string; metadata?: unknown; expiresAt: Date | null }) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: resource.taskId } });
  if (!task.primarySessionId) return;
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: where(task.id, task.primarySessionId), orderBy: { sequence: "desc" } });
  if (!event) return;
  const proof = ArchiveRetentionProof.parse(JSON.parse(event.value!)), saved = proof.resources.find(entry => entry.id === resource.id);
  if (saved && (next.state !== saved.state || finalizationResourceIdentity({ ...resource, ...next, metadata: next.metadata ?? resource.metadata }).identityDigest !== saved.identityDigest)) throw new Error("Verified retained archives must keep their original resource receipts");
}
