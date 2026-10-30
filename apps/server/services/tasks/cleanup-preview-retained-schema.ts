import path from "node:path";
import { z } from "zod";

const Absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Node = { dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative() };
const File = z.strictObject({ path: Absolute, ...Node, size: z.number().int().nonnegative().max(64 * 1024), sha256: Hash });

/** Read-only references derived from an existing accepted tree plan. These are
 * neither replacement targets nor permission to recreate or remove a path. */
export const RetainedPreviewInput = z.strictObject({
  resourceId: z.string().min(1), identityDigest: Hash, planDigest: Hash,
  sourcePath: Absolute, quarantine: z.strictObject({ directory: Absolute, path: Absolute, journal: Absolute }),
  root: z.strictObject(Node), config: File, connector: File,
});
export type RetainedPreviewInput = z.infer<typeof RetainedPreviewInput>;
