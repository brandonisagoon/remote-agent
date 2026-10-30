import path from "node:path";
import { z } from "zod";
import { FinalizationInventoryEntry, FinalizationTreeTarget } from "./finalization-resources.ts";

export const LEGACY_EVIDENCE_RETAINED = "legacy-evidence-retained";
export const LEGACY_EVIDENCE_CONFIRMED = "legacy-evidence-confirmed";
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().min(1).refine((value) => path.isAbsolute(value) && path.normalize(value) === value, "An exact absolute path is required");
const Stat = { dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative() };
export const LegacyEvidenceFile = z.object({ path: Absolute, ...Stat, size: z.number().int().nonnegative(), sha256: Sha }).strict();
export const LegacyEvidenceTarget = LegacyEvidenceFile.extend({ type: z.literal("file"), quarantine: z.object({ directory: Absolute, path: Absolute, journal: Absolute }).strict() }).strict();
export const LegacyEvidenceDirectory = z.object({ path: Absolute, ...Stat }).strict();
export const LegacyEvidenceTreeTarget = FinalizationTreeTarget.extend({ sourceParent: LegacyEvidenceDirectory, quarantineParent: LegacyEvidenceDirectory }).strict();
export const LegacyEvidenceRetainedTree = z.object({ type: z.literal("tree"), path: Absolute, inventory: z.array(FinalizationInventoryEntry).min(1).max(10_025), inventoryDigest: Sha }).strict();
export const LegacyEvidenceManifest = z.object({ path: Absolute, sha256: Sha, format: z.literal("task-backup-evidence-v1").optional() }).strict();
export const LegacyEvidenceAdoptionEntry = z.union([
  z.object({ resourceId: z.string().min(1), retainedPath: Absolute, sha256: Sha, size: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("tree"), resourceId: z.string().min(1), retainedPath: Absolute, inventoryDigest: Sha }).strict(),
]);
export const LegacyEvidenceAdoptionInput = z.object({
  requestKey: z.string().trim().min(1).max(180), finalizationRequestKey: z.string().trim().min(1).max(180),
  expectedPreparedRevision: z.number().int().positive(),
  manifest: LegacyEvidenceManifest,
  entries: z.array(LegacyEvidenceAdoptionEntry).min(1).max(1000),
}).strict();
export type LegacyEvidenceAdoptionInput = z.infer<typeof LegacyEvidenceAdoptionInput>;
const EntryIdentity = {
  resourceId: z.string(), key: z.string(), kind: z.literal("evidence"), purpose: z.enum(["browser", "development", "review"]),
  externalId: Absolute, createdAt: z.string().datetime(), identityDigest: Sha,
  recorded: z.object({ sha256: Sha.optional(), size: z.number().int().nonnegative().optional() }).strict(),
};
export const LegacyEvidenceEntry = z.union([
  z.object({ ...EntryIdentity, digestProvenance: z.enum(["recorded-receipt", "observed-at-adoption"]), target: LegacyEvidenceTarget, retained: LegacyEvidenceFile }).strict(),
  z.object({ ...EntryIdentity, digestProvenance: z.literal("observed-at-adoption"), target: LegacyEvidenceTreeTarget, retained: LegacyEvidenceRetainedTree }).strict(),
]);
export type LegacyEvidenceEntry = z.infer<typeof LegacyEvidenceEntry>;
export const LegacyEvidenceProof = z.object({
  version: z.literal(1), input: LegacyEvidenceAdoptionInput,
  taskId: z.string(), sessionId: z.string(), preparedRevision: z.number().int().positive(), preparedDigest: Sha,
  finalizationRequestKey: z.string(), identityDigest: Sha, contractRevision: z.number().int().positive(),
  archiveRoot: Absolute, manifest: LegacyEvidenceFile, manifests: z.array(LegacyEvidenceFile).min(1).max(4).optional(),
  entries: z.array(LegacyEvidenceEntry).min(1).max(1000),
}).strict();
export type LegacyEvidenceProof = z.infer<typeof LegacyEvidenceProof>;
export const LegacyEvidenceReceipt = z.object({ proofRevision: z.number().int().positive(), proofDigest: Sha, proof: LegacyEvidenceProof }).strict();
export type LegacyEvidenceReceipt = z.infer<typeof LegacyEvidenceReceipt>;
export const LegacyEvidenceOperationInput = z.object({
  resourceKey: z.string().min(1), action: z.enum(["inspect", "authorize", "confirm"]),
  proofRevision: z.number().int().positive(), proofDigest: Sha, preparedRevision: z.number().int().positive(), finalizationRequestKey: z.string().min(1),
}).strict();
export type LegacyEvidenceOperationInput = z.infer<typeof LegacyEvidenceOperationInput>;
