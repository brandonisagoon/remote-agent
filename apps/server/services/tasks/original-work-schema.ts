import path from "node:path";
import { z } from "zod";
import { FinalizationInventoryEntry, FinalizationTreeTarget } from "./finalization-resources.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Absolute = z.string().max(4096).refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const Relative = z.string().min(1).max(4096).refine((value) => !path.isAbsolute(value) && path.normalize(value) === value && !value.split(path.sep).includes("..") && value !== ".");
/** All paths are explicit owner input; their contents are independently read.
 * Nothing in a resource's mutable metadata can select an archive exception. */
const ArchiveInput = z.object({ resourceId: z.string().min(1), manifestPath: Absolute, manifestSha256: Digest, format: z.enum(["sha256-lines", "files-v1"]) }).strict();
export const BundleOriginalWorkInput = z.object({
  archiveResourceId: z.string().min(1), manifestPath: Absolute, manifestSha256: Digest,
  bundlePath: Relative, bundleRef: z.string().regex(/^refs\/heads\/[a-zA-Z0-9][a-zA-Z0-9_./-]*$/),
  indexPatchPath: Relative, worktreePatchPath: Relative, untrackedArchivePath: Relative,
  expectedWorkingTree: Sha, retainedResults: z.array(z.object({ resourceId: z.string().min(1), provenancePath: Relative }).strict()).max(1000).optional(),
  additionalArchives: z.array(ArchiveInput).max(20).optional(), ownedPaths: z.array(Absolute).max(1000),
}).strict();
export const RecoveryWorkInput = z.object({
  format: z.literal("base-work-tar/v1"), archiveResourceId: z.string().min(1),
  manifestPath: Absolute, manifestSha256: Digest,
  checksumsPath: Relative, checksumsSha256: Digest, receiptPath: Relative, receiptSha256: Digest,
  ownedPaths: z.array(Absolute).max(1000),
  retainedArchiveMembers: z.array(z.object({ resourceId: z.string().min(1) }).strict()).max(1000).optional(),
}).strict();
export type RecoveryWorkInput = z.infer<typeof RecoveryWorkInput>;
export const OriginalWorkInput = z.union([BundleOriginalWorkInput, RecoveryWorkInput]);
export type OriginalWorkInput = z.infer<typeof OriginalWorkInput>;
export const OriginalWorkSnapshot = z.object({ head: Sha, branch: z.string(), clean: z.boolean(), fingerprint: Digest,
  indexPatchSha256: Digest, worktreePatchSha256: Digest,
  untracked: z.array(z.object({ path: Relative, size: z.number().int().nonnegative(), sha256: Digest, executable: z.boolean() }).strict()).max(10000),
}).strict();
export const OriginalWorkArchive = z.object({ resourceId: z.string(), identityDigest: Digest, root: Absolute, manifestPath: Absolute, manifestSha256: Digest,
  format: z.enum(["sha256-lines", "files-v1", "base-work-tar/v1"]).optional(),
  recovery: RecoveryWorkInput.optional(),
  inventory: z.array(FinalizationInventoryEntry).min(1).max(250_000), inventoryDigest: Digest }).strict();
const RestoreIdentity = { gitDirectory: Absolute, head: Sha, indexTree: Sha, workingTree: Sha, fingerprint: Digest };
export const OriginalWork = z.object({ version: z.literal(1), captureId: z.string().min(1),
  archive: OriginalWorkArchive,
  additionalArchives: z.array(OriginalWorkArchive).max(20).optional(),
  retainedResults: z.array(z.object({ resourceId: z.string(), identityDigest: Digest, provenancePath: Absolute, provenanceSha256: Digest }).strict()).max(1000).optional(),
  retainedArchiveMembers: z.array(z.object({ resourceId: z.string(), identityDigest: Digest, archiveResourceId: z.string(), path: Absolute, size: z.number().int().nonnegative(), sha256: Digest }).strict()).max(1000).optional(),
  snapshot: OriginalWorkSnapshot,
  restore: z.union([
    z.object({ ...RestoreIdentity, bundleSha256: Digest, prerequisiteCommits: z.array(Sha).max(1000) }).strict(),
    z.object({ ...RestoreIdentity, format: z.literal("base-work-tar/v1"), baseArchiveSha256: Digest, workArchiveSha256: Digest }).strict(),
  ]),
  target: FinalizationTreeTarget,
}).strict();
export type OriginalWork = z.infer<typeof OriginalWork>;
