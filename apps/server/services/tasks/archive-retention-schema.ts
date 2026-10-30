import { z } from "zod";
import { FinalizationInventoryEntry, RetainedArchivePlan } from "./finalization-resources.ts";
import { SavedArchiveSelection } from "./archive-observation.ts";

export const ARCHIVE_RETENTION = "finalization-archive-retention";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ArchiveRetentionResource = RetainedArchivePlan.extend({ kind: z.enum(["evidence-archive", "private-backup"]), state: z.string().refine(value => value !== "released") }).strict();
const Identity = {
  version: z.literal(1), taskId: z.string(), sessionId: z.string(), requestKey: z.string(),
  preparedRevision: z.number().int().positive(), preparedDigest: Digest, contractRevision: z.number().int().positive(),
  identityDigest: Digest, toolingRevision: z.string(),
  resources: z.array(ArchiveRetentionResource).min(1).max(1000),
};
export const ArchiveRetentionProof = z.object({ ...Identity,
  archives: z.array(z.object({ rootResourceId: z.string(), selection: SavedArchiveSelection,
    inventory: z.array(FinalizationInventoryEntry).min(1).max(250_000), inventoryDigest: Digest,
    ancillary: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: Digest }).strict()).max(10_000),
    manifestEntries: z.number().int().positive(),
  }).strict()).min(1).max(20),
}).strict();
export type ArchiveRetentionProof = z.infer<typeof ArchiveRetentionProof>;
export const ArchiveRetentionReceipt = z.object({ ...Identity, proofRevision: z.number().int().positive(), proofDigest: Digest }).strict();
export type ArchiveRetentionReceipt = z.infer<typeof ArchiveRetentionReceipt>;
export const ArchiveRetentionCheck = z.object({ proofRevision: z.number().int().positive(), proofDigest: Digest, preparedRevision: z.number().int().positive(), requestKey: z.string() }).strict();
export type ArchiveRetentionCheck = z.infer<typeof ArchiveRetentionCheck>;
