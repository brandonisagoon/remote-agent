import path from "node:path";
import { z } from "zod";
import { CleanupObserverResource, cleanupDigest } from "./cleanup-observer-schema.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
export const evidenceWriterKinds = ["native-app", "launch-agent", "launch-agents", "docker-container", "docker-compose-project", "task-runtime", "local-http"];
export function evidenceWriterIds(resources: z.infer<typeof CleanupObserverResource>[], evidenceId: string) {
  const evidence = resources.find(resource => resource.id === evidenceId);
  return resources.filter(resource => resource.purpose === evidence?.purpose && resource.state !== "released" && evidenceWriterKinds.includes(resource.kind)).map(resource => resource.id).sort();
}

/** A transient observation of the current original inventory. It neither
 * changes an accepted plan nor grants provider, process or filesystem effects. */
export const CleanupWritersInput = z.strictObject({ version: z.literal(1), mode: z.literal("stopped-writers"),
  task: z.strictObject({ id: z.string().min(1), primarySessionId: z.string().min(1), worktreePath: Absolute, toolingRevision: z.string().regex(/^[a-f0-9]{40}$/) }),
  resources: z.array(CleanupObserverResource).min(1).max(1000),
  evidence: z.strictObject({ resourceId: z.string().min(1), path: Absolute, planDigest: Hash }),
  writerResourceIds: z.array(z.string().min(1)).min(1).max(1000),
}).superRefine((input, ctx) => {
  const evidence = input.resources.find(resource => resource.id === input.evidence.resourceId);
  if (new Set(input.resources.map(resource => resource.id)).size !== input.resources.length || new Set(input.resources.map(resource => resource.key)).size !== input.resources.length
    || evidence?.kind !== "evidence" || evidence.externalId !== input.evidence.path
    || cleanupDigest([...input.writerResourceIds].sort()) !== cleanupDigest(evidenceWriterIds(input.resources, input.evidence.resourceId))) {
    ctx.addIssue({ code: "custom", message: "Writer observation requires the exact complete directory evidence scope" });
  }
});
export type CleanupWritersInput = z.infer<typeof CleanupWritersInput>;
export const CleanupWritersResult = z.strictObject({ version: z.literal(1), mode: z.literal("stopped-writers"), requestDigest: Hash,
  writers: z.array(z.strictObject({ resourceId: z.string().min(1), resourceDigest: Hash, anchorKey: z.string().min(1),
    proof: z.strictObject({ version: z.literal(1), file: Absolute, sha256: Hash }), planDigest: Hash, stopped: z.literal(true) })).min(1).max(1000),
});
export function validateCleanupWritersResult(request: CleanupWritersInput, value: unknown) {
  const result = CleanupWritersResult.parse(value);
  if (result.requestDigest !== cleanupDigest(request) || cleanupDigest(result.writers.map(writer => writer.resourceId).sort()) !== cleanupDigest([...request.writerResourceIds].sort())
    || result.writers.some(writer => writer.resourceDigest !== cleanupDigest(request.resources.find(resource => resource.id === writer.resourceId)))) throw new Error("Directory writer observation does not match the exact current request");
  return result;
}
