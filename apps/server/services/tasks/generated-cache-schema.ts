import path from "node:path";
import { z } from "zod";
const Hash = z.string().regex(/^[a-f0-9]{64}$/), NumberId = z.number().int().nonnegative().safe();
const Absolute = z.string().max(4096).refine(v => path.isAbsolute(v) && path.normalize(v) === v);
const Relative = z.string().max(4096).refine(v => v === "." || !!v && !path.isAbsolute(v) && path.normalize(v) === v && !v.split(path.sep).includes(".."));
const Identity = { dev: NumberId, ino: NumberId, mode: NumberId, uid: NumberId, gid: NumberId, size: NumberId, mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/), nlink: NumberId };
export const GeneratedCacheEntry = z.discriminatedUnion("kind", [
  z.strictObject({ ...Identity, path: Relative, kind: z.literal("directory") }),
  z.strictObject({ ...Identity, path: Relative, kind: z.literal("file"), sha256: Hash }),
]);
export const GeneratedCacheRoot = z.strictObject({ path: Absolute, entries: z.array(GeneratedCacheEntry).min(2).max(4352), bytes: NumberId.max(64 * 1024 * 1024), digest: Hash,
  packageFiles: z.array(z.strictObject({ path: Absolute, dev: NumberId, ino: NumberId, mode: NumberId, size: NumberId, sha256: Hash })).min(2).max(10) });
export const GeneratedCacheData = z.strictObject({ ownerSha256: Hash, roots: z.array(GeneratedCacheRoot).min(1).max(10) });
export type GeneratedCacheData = z.infer<typeof GeneratedCacheData>;
