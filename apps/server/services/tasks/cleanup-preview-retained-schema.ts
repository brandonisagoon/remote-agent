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


// Secret-free identity of an existing credential outside deleting scopes.
export const IndependentPreviewCredential = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("origin-certificate"), file: Absolute, ...Node, sha256: Hash }),
  z.strictObject({ kind: z.literal("runtime-file"), file: Absolute, ...Node, sha256: Hash }),
  z.strictObject({ kind: z.literal("environment"), sha256: Hash }),
]);
export type IndependentPreviewCredential = z.infer<typeof IndependentPreviewCredential>;
export const PreviewDeletionConfirmation = z.strictObject({
  taskId: z.string().min(1), resourceId: z.string().min(1), resourceIdentityDigest: Hash,
  purpose: z.enum(["development", "review", "browser"]), hostname: z.string().min(1), tunnelId: z.string().min(1),
  zoneId: z.string().regex(/^[a-f0-9]{32}$/i), accountId: z.string().regex(/^[a-f0-9]{32}$/i), configFile: Absolute.optional(), sourceDigest: Hash.optional(),
  credential: IndependentPreviewCredential,
  deletions: z.array(z.strictObject({ resourceId: z.string().min(1), targetDigest: Hash, path: Absolute })).min(1).max(1000).optional(),
});
export type PreviewDeletionConfirmation = z.infer<typeof PreviewDeletionConfirmation>;
