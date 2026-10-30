import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { CleanupObserverResource, cleanupDigest } from "./cleanup-observer-schema.ts";
import { CleanupWritersInput, evidenceWriterIds, validateCleanupWritersResult } from "./cleanup-writers-schema.ts";
import { resolveCleanupObserver, runCleanupResourceObserver } from "./cleanup-resource-observer.ts";
import { finalizationDigest } from "./finalization-resources.ts";

type Database = Pick<PrismaClient, "remoteTaskResource">;
export const evidenceWriterObservation = { resolve: resolveCleanupObserver, observe: runCleanupResourceObserver };

/** Reuses the configured, immutable read-only inspector. A stale Allocated
 * endpoint is neither proof of a running writer nor permission to ignore one.
 * No accepted preparation, retention proof or resource receipt is modified. */
export async function assertLegacyEvidenceWriters(input: { prisma: Database; config: ServerConfig; task: RemoteTask;
  entry: { resourceId: string; target: { path: string } } }, dependencies = evidenceWriterObservation) {
  const read = async (database: Database) => (await database.remoteTaskResource.findMany({ where: { taskId: input.task.id }, orderBy: { id: "asc" } })).map(resource => CleanupObserverResource.parse({
    id: resource.id, key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId, state: resource.state,
    expiresAt: resource.expiresAt?.toISOString() ?? null, metadata: resource.metadata,
  }));
  const resources = await read(input.prisma), epoch = cleanupDigest(resources);
  const writerResourceIds = evidenceWriterIds(resources, input.entry.resourceId);
  if (writerResourceIds.length) {
    // Unknown writer recipes keep the original refusal. The supported native
    // link is only a hint: the child independently validates its private proof.
    if (writerResourceIds.some(id => { const resource = resources.find(value => value.id === id)!; const metadata = resource.metadata as Record<string, any> | null;
      return resource.kind !== "local-http" || !metadata?.observed?.legacyNative;
    })) throw new Error("Directory evidence writers require independently verified stopped native identities");
    const request = CleanupWritersInput.parse({ version: 1, mode: "stopped-writers", task: { id: input.task.id, primarySessionId: input.task.primarySessionId,
      worktreePath: input.task.worktreePath, toolingRevision: input.task.toolingRevision }, resources,
      evidence: { resourceId: input.entry.resourceId, path: input.entry.target.path, planDigest: finalizationDigest(input.entry.target) }, writerResourceIds });
    const capability = await dependencies.resolve({ task: input.task, config: input.config });
    validateCleanupWritersResult(request, await dependencies.observe({ capability, request }));
  }
  const assertUnchanged = async (database: Database = input.prisma) => {
    if (cleanupDigest(await read(database)) !== epoch) throw new Error("Directory evidence writer inventory changed during observation");
  };
  await assertUnchanged();
  return assertUnchanged;
}
