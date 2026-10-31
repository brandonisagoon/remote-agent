import { z } from "zod";
import { PreparedLinkedFinalization } from "./finalization-receipts.ts";
import { ExternalDeliveryObservation } from "./external-delivery-schema.ts";
import { FinalizationResourcePlan } from "./finalization-resources.ts";
import { OriginalWork } from "./original-work-schema.ts";

export const CleanupSnapshot = z.object({ head: z.string(), branch: z.string(), clean: z.boolean(), fingerprint: z.string() }).strict();
export const PreparedExternalFinalization = PreparedLinkedFinalization.omit({ delivery: true, localCompletion: true }).extend({
  contractRevision: z.number().int().nullable(),
  version: z.literal(2), bindingRevision: z.number().int().positive(), bindingDigest: z.string(), resourcePlanDigest: z.string(),
  baseCommit: z.string().nullable(), toolingRevision: z.string(), pinnedToolingRoot: z.string().nullable(), cleanupSnapshot: CleanupSnapshot,
  delivery: z.object({ kind: z.literal("external-merges/v1"), observationRevision: z.number().int().positive(), deliveries: z.array(ExternalDeliveryObservation).min(1) }).strict(),
  resources: z.array(FinalizationResourcePlan), originalWork: OriginalWork.optional(),
  deliveredRetirement: z.object({ kind: z.literal("present-day-owner"), bindingRevision: z.number().int().positive(), bindingDigest: z.string(), recordedBranch: z.string(), sourceStateId: z.string() }).strict().optional(),
  doneHandoff: z.object({ requestKey: z.string(), body: z.string(), expectedState: z.enum(["Merge", "Done"]), state: z.literal("Done") }).strict(),
}).strict();
export type PreparedExternalFinalization = z.infer<typeof PreparedExternalFinalization>;

export const ExternalConfirmation = z.object({ version: z.literal(2), preparedRevision: z.number().int().positive(), resourceProofs: z.array(z.number().int().positive()),
  originalWorkAdministration: z.object({ revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
