import { z } from "zod";
const Identity = z.string().min(1).max(256), Sha = z.string().regex(/^[a-f0-9]{64}$/);
/** Deliberately not ComputeObservation: this cannot be used for a start claim,
 * traffic coverage, an inactivity decision or a stopped-generation transition. */
export const ComputeReclamation = z.object({ version: z.literal(1), kind: z.literal("compute-reclamation"),
  environmentId: Identity, taskId: Identity, primarySessionId: Identity, resourceId: Identity,
  resourceIdentity: Sha, allocationResourceIdentity: Sha, configurationDigest: Sha,
  observedAt: z.number().int().nonnegative(), state: z.enum(["running", "stopped", "absent", "unknown"]), proofDigest: Sha,
}).strict();
