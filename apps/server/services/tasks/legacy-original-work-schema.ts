import path from "node:path";
import { z } from "zod";
import { BundleOriginalWorkInput, OriginalWork } from "./original-work-schema.ts";
import { FinalizationInventoryEntry } from "./finalization-resources.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
/** File evidence is deliberately not a synthetic TaskResource. Only the
 * authenticated owner route may select its root and ignored source paths. */
export const LegacyOriginalArchiveInput = BundleOriginalWorkInput.omit({ archiveResourceId: true, retainedResults: true, additionalArchives: true }).extend({ archiveRoot: Absolute }).strict();
export type LegacyOriginalArchiveInput = z.infer<typeof LegacyOriginalArchiveInput>;
export const LegacyOriginalWorkAdoption = z.object({
  kind: z.literal("original-work"), requestKey: z.string().min(1).max(180), finalizationRequestKey: z.string().min(1).max(180),
  expectedPreparedRevision: z.number().int().positive(), expectedPreparedRawDigest: Digest,
  expectedOperationRevision: z.number().int().positive(), expectedOperationRawDigest: Digest, expectedOperationDigest: Digest,
  archive: LegacyOriginalArchiveInput,
}).strict();
export type LegacyOriginalWorkAdoption = z.infer<typeof LegacyOriginalWorkAdoption>;
export const LegacyOriginalWork = OriginalWork.omit({ archive: true, additionalArchives: true, retainedResults: true, retainedArchiveMembers: true }).extend({
  archive: z.object({ root: Absolute, manifestPath: Absolute, manifestSha256: Digest,
    inventory: z.array(FinalizationInventoryEntry).min(1).max(250_000), inventoryDigest: Digest }).strict(),
  administration: OriginalWork.shape.administration.unwrap(),
}).strict();
export type LegacyOriginalWork = z.infer<typeof LegacyOriginalWork>;
export const LegacyOriginalWorkProof = z.object({
  version: z.literal(1), input: LegacyOriginalWorkAdoption,
  taskId: z.string().min(1), sessionId: z.string().min(1), toolingRevision: z.string().regex(/^[a-f0-9]{40}$/),
  requestKey: z.string().min(1), preparedRevision: z.number().int().positive(), preparedDigest: Digest, preparedRawDigest: Digest,
  operationRevision: z.number().int().positive(), operationDigest: Digest, operationRawDigest: Digest,
  bindingDigest: Digest, originalWork: LegacyOriginalWork,
}).strict();
export type LegacyOriginalWorkProof = z.infer<typeof LegacyOriginalWorkProof>;
export const LegacyOriginalWorkReceipt = z.object({ revision: z.number().int().positive(), digest: Digest, proof: LegacyOriginalWorkProof }).strict();
export type LegacyOriginalWorkReceipt = z.infer<typeof LegacyOriginalWorkReceipt>;
export const LEGACY_ORIGINAL_WORK = "finalization-legacy-original-work";
