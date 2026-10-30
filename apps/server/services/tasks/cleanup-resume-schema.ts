import { z } from "zod";
import { createHash } from "node:crypto";
import { ExternalTaskIdentity } from "./external-delivery-schema.ts";
import { RetirementDelivery } from "./retirement-receipts.ts";

export const CLEANUP_RESUME = "completion-cleanup-resume";
export const CLEANUP_RESUME_CONFIRMED = "completion-cleanup-resume-confirmed";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CleanupResumeInput = z.object({ requestKey: z.string().min(1).max(200), preparedRevision: z.number().int().positive(),
  expectedBindingDigest: Digest, expectedState: z.literal("Blocked"), expectedStateId: z.string().min(1).max(200), expectedUpdatedAt: z.iso.datetime(),
  basis: z.string().trim().min(1).max(4000) }).strict();
export type CleanupResumeInput = z.infer<typeof CleanupResumeInput>;
/** Each new Blocked revision permits an authenticated continuation of the same
 * preparation. Replays remain attached to their original source revision. */
export function cleanupResumeRequestKey(input: Pick<CleanupResumeInput, "preparedRevision" | "expectedStateId" | "expectedUpdatedAt">) {
  const digest = createHash("sha256").update(JSON.stringify([input.expectedStateId, input.expectedUpdatedAt])).digest("hex");
  return `resume-cleanup:${input.preparedRevision}:${digest}`;
}
export const CleanupResumeBinding = z.object({ identity: ExternalTaskIdentity, issueId: z.string(),
  preparedRevision: z.number().int().positive(), preparedDigest: Digest, finalizationRequestKey: z.string(),
  contractRevision: z.number().int().positive(), contractDigest: Digest,
  verificationRevision: z.number().int().positive(), verificationDigest: Digest,
  delivery: RetirementDelivery,
}).strict();
export type CleanupResumeBinding = z.infer<typeof CleanupResumeBinding>;
export const CleanupResumeReceipt = z.object({ version: z.literal(1), input: CleanupResumeInput, binding: CleanupResumeBinding,
  serviceActorId: z.string().min(1), sourceStateId: z.string().min(1), sourceUpdatedAt: z.iso.datetime(), targetStateId: z.string().min(1),
}).strict();
export type CleanupResumeReceipt = z.infer<typeof CleanupResumeReceipt>;
