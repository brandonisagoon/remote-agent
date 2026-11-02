import path from "node:path";
import { z } from "zod";
import { CleanupObserverInput, cleanupDigest } from "./cleanup-observer-schema.ts";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const StudioSourceInput = z.strictObject({ version: z.literal(1), mode: z.literal("studio-source"), observation: CleanupObserverInput,
  physicalRoot: z.string().max(4096).refine(p => path.isAbsolute(p) && path.normalize(p) === p).optional(),
  authorityDigest: Hash, ownerSha256: Hash.optional() });
export type StudioSourceInput = z.infer<typeof StudioSourceInput>;
export const StudioSourceResult = z.strictObject({ version: z.literal(1), mode: z.literal("studio-source"), requestDigest: Hash,
  ownerSha256: Hash, stoppedContainerIds: z.array(Hash).max(3), absentContainerIds: z.array(Hash).max(3) });
export function validateStudioSourceResult(input: StudioSourceInput, value: unknown) {
  const result = StudioSourceResult.parse(value);
  if (result.requestDigest !== cleanupDigest(input) || input.ownerSha256 && result.ownerSha256 !== input.ownerSha256
    || new Set([...result.stoppedContainerIds, ...result.absentContainerIds]).size !== 3) throw Error("Studio source observation changed ownership or request");
  return result;
}
