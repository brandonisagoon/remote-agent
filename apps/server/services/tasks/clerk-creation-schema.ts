import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
/** A server-observed original creation fact, scoped to one existing cleanup
 * operation. It supplies provenance only; it is never independent authority. */
export const ClerkCreationWitness = z.object({
  version: z.literal(1), taskId: z.string().min(1), sessionId: z.string().min(1),
  resourceId: z.string().min(1), resourceDigest: Digest,
  preparedRevision: z.number().int().positive(), operationRevision: z.number().int().positive(), operationDigest: Digest,
  instanceId: z.string().regex(/^ins_[A-Za-z0-9]+$/), userId: z.string().regex(/^user_[A-Za-z0-9]+$/), emailDigest: Digest,
  evidenceRevision: z.number().int().positive(), evidenceDigest: Digest,
}).strict();
export type ClerkCreationWitness = z.infer<typeof ClerkCreationWitness>;
export const legacyCreatedInstance = (value: unknown) => typeof value === "string"
  ? /^Clerk test instance \(sk_test\/pk_test guarded\), kid (ins_[A-Za-z0-9]+)$/.exec(value)?.[1] : undefined;

