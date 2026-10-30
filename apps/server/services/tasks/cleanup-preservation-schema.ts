import path from "node:path";
import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().max(4096).refine(file => path.isAbsolute(file) && path.normalize(file) === file);
export const PreservationSelection = z.object({ resourceId: z.string().min(1), kind: z.enum(["clerk-user", "docker-volume"]), id: z.string().min(1) }).strict();
export const PreservationInput = z.object({ instruction: z.object({ id: z.string().min(1), sequence: z.number().int().positive() }).strict(), inventoryResourceId: z.string().min(1),
  targets: z.array(PreservationSelection).min(1).max(16) }).strict();
export const PreservationProof = z.object({
  instruction: z.object({ id: z.string().min(1), sequence: z.number().int().positive(), sessionId: z.string().min(1), textSha256: Digest }).strict(),
  inventory: z.object({ resourceId: z.string().min(1), identityDigest: Digest, archiveResourceId: z.string().min(1),
    file: z.object({ path: Absolute, dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative(), size: z.number().int().nonnegative(), sha256: Digest }).strict() }).strict(),
  targets: z.array(PreservationSelection).min(1).max(16),
}).strict();
export type PreservationProof = z.infer<typeof PreservationProof>;
