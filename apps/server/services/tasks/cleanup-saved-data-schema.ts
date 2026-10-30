import path from "node:path";
import { z } from "zod";
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
export const SavedDataSelection = z.object({ resourceId: z.string().min(1), manifestPath: Absolute, manifestSha256: Sha,
  scratchResourceIds: z.array(z.string().min(1)).max(1000) }).strict();
export const SavedDataSelections = z.array(SavedDataSelection).max(20).superRefine((values, ctx) => {
  const ids = values.flatMap(value => [value.resourceId, ...value.scratchResourceIds]);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Saved-data and scratch selections must be unique" });
});
export const SavedDataManifest = z.object({ format: z.string().regex(/^DRA-[0-9]+ private preservation manifest v1$/), task: z.string(), primarySession: z.string(), policyPin: z.string().regex(/^[a-f0-9]{40}$/), archiveRoot: Absolute,
  artifacts: z.array(z.object({ path: z.string().min(1), sha256: Sha, bytes: z.number().int().nonnegative(), use: z.string().optional() }).strict()).min(1).max(10000),
}).passthrough();
export const SavedDataScratch = z.object({ task: z.string(), scratch: z.array(z.object({ purpose: z.enum(["development", "review"]), type: z.enum(["mysql", "redis"]), id: Sha, name: z.string().min(1), image: z.string().min(1), sourceId: Sha,
  volume: z.object({ Name: z.string().min(1), CreatedAt: z.string().min(1), Labels: z.record(z.string(), z.string()) }).passthrough(),
}).passthrough()).max(100) }).passthrough();
export const SavedScratchBinding = z.object({ containerResourceId: z.string(), volumeResourceId: z.string(), containerId: Sha, volume: z.string().min(1), name: z.string().min(1), image: z.string().min(1), createdAt: z.string().min(1),
  sourcePurpose: z.enum(["development", "review"]), sourceId: Sha, operation: z.string().min(1), labelsDigest: Sha }).strict();
