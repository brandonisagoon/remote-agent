import { z } from "zod";

const Size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const EvidenceReceiptMetadata = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bytes: Size.optional(), byteSize: Size.optional(), size: Size.optional(), sizeBytes: Size.optional(),
}).passthrough().superRefine((value, context) => {
  const sizes = [value.bytes, value.byteSize, value.size, value.sizeBytes].filter(size => size !== undefined);
  if (new Set(sizes).size > 1) context.addIssue({ code: "custom", message: "Evidence size receipts conflict; preserve it for reconciliation" });
});

/** Compare historical aliases without changing the stored receipt or its digest.
 * Missing fields remain missing for the separate legacy adoption protocol. */
export function recordedEvidenceIdentity(metadata: unknown) {
  const value = EvidenceReceiptMetadata.parse(metadata ?? {});
  const size = value.bytes ?? value.byteSize ?? value.size ?? value.sizeBytes;
  return { ...(value.sha256 !== undefined ? { sha256: value.sha256 } : {}), ...(size !== undefined ? { size } : {}) };
}

/** New file receipts must already be readable by the cleanup adapter. Historical
 * incomplete receipts retain their separate, proof-bound adoption path. */
export function validateEvidenceReceipt(metadata: unknown, historical = false) {
  const identity = recordedEvidenceIdentity(metadata);
  if (!historical && (identity.sha256 === undefined || identity.size === undefined)) {
    throw new Error("New evidence files require a recorded SHA-256 and byte size; use the directory artifact adapter for directories");
  }
  return identity;
}
