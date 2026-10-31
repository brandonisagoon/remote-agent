import path from "node:path";
import { z } from "zod";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0"));
const File = z.object({ file: Absolute, sha256: Digest, dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative() }).strict();
export const LegacyComposeRetentionInput = z.object({ preparedRevision: z.number().int().positive(),
  cleanup: z.object({ operationRevision: z.number().int().positive(), operationDigest: Digest }).strict(),
}).strict();
export const LegacyComposeRetentionObservation = z.object({ journal: File, config: File, cutover: File,
  sourceResourceId: z.string().min(1), sourceIdentityDigest: Digest, bindingDigest: Digest,
  retainedTargetDigests: z.array(Digest).length(3).refine(values => new Set(values).size === values.length),
}).strict();
export const LegacyComposeRetentionReceipt = z.object({ version: z.literal(1), revision: z.number().int().positive(), digest: Digest,
  taskId: z.string().min(1), sessionId: z.string().min(1), requestKey: z.string().min(1),
  preparedRevision: z.number().int().positive(), preparedDigest: Digest, cleanup: LegacyComposeRetentionInput.shape.cleanup,
  resources: z.array(z.object({ id: z.string().min(1), key: z.string().min(1), identityDigest: Digest }).strict()).min(1).max(16),
}).strict();
export type LegacyComposeRetentionReceipt = z.infer<typeof LegacyComposeRetentionReceipt>;
