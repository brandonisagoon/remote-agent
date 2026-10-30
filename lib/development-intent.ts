import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Key = z.string().min(1).max(180);
const Review = z.object({ id: z.string(), key: Key, identityDigest: Digest }).strict();
const ResourceIdentity = z.object({ id: z.string(), key: Key, identityDigest: Digest }).strict();
export const DevelopmentReference = z.object({ intentRevision: z.number().int().positive(), intentDigest: Digest }).strict();
export const DevelopmentAuthorityInput = DevelopmentReference.extend({ resourceKeys: z.array(Key).max(1000).refine(keys => new Set(keys).size === keys.length, "Development resource keys must be unique") }).strict();
export const DevelopmentCompleteInput = DevelopmentReference.extend({ resourcesEpoch: Digest, resources: z.array(ResourceIdentity).max(1000) }).strict();
export const DevelopmentProjection = z.object({ version: z.literal(1), revision: z.number().int().positive(), digest: Digest,
  requestKey: Key, action: z.enum(["stop", "resume"]), reason: z.enum(["owner-pause", "owner-resume", "review-handoff"]),
  review: Review.optional(), state: z.enum(["pending", "complete"]), blocked: z.string().optional(),
}).strict();
export const DevelopmentAuthority = z.object({ version: z.literal(1), task: z.object({ id: z.string(), primarySessionId: z.string(), worktreePath: z.string(), toolingRevision: z.string() }).strict(),
  intent: DevelopmentProjection.omit({ version: true, state: true, blocked: true }), resourcesEpoch: Digest, resources: z.array(ResourceIdentity).max(1000),
}).strict();
export const AutomationInput = z.union([
  z.object({ action: z.enum(["pause", "resume", "close"]), cleanup: z.literal(true).optional() }).strict(),
  z.object({ action: z.enum(["pause", "resume"]), development: z.literal(true), requestKey: Key }).strict(),
  z.object({ action: z.literal("stop-development"), requestKey: Key, review: Review.omit({ id: true }) }).strict(),
]);
