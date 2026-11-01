import type { z } from "zod";
import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { CleanupObserverInput, CleanupObserverResource, cleanupDigest } from "./cleanup-observer-schema.ts";
import { StudioSourceInput, validateStudioSourceResult } from "./studio-source-schema.ts";
import { resolveCleanupObserver, runCleanupResourceObserver } from "./cleanup-resource-observer.ts";
import { finalizationResourceIdentity, finalizationResourceObservation, inspectFinalizationQuarantine, type FinalizationTreeTarget } from "./finalization-resources.ts";
import { assertGeneratedCacheMounts } from "./generated-cache-mounts.ts";
export const generatedCacheOwnerObservation = { resolve: resolveCleanupObserver, observe: runCleanupResourceObserver };
/** Server-selected source ownership only. Input paths cannot choose a command,
 * owner record, replacement container, or a different cleanup operation. */
export async function observeGeneratedCacheOwner(input: { prisma: Pick<PrismaClient,"remoteTaskResource">; config: ServerConfig; task: RemoteTask;
  preparedRevision: number; requestKey: string; operationRevision: number; operationDigest: string; ownerSha256?: string; target?: z.infer<typeof FinalizationTreeTarget> }, dependencies = generatedCacheOwnerObservation) {
  const resources = (await input.prisma.remoteTaskResource.findMany({ where: { taskId:input.task.id }, orderBy:{ id:"asc" } })).map(resource => CleanupObserverResource.parse({
    id:resource.id,key:resource.key,kind:resource.kind,purpose:resource.purpose,externalId:resource.externalId,state:resource.state,expiresAt:resource.expiresAt?.toISOString() ?? null,metadata:resource.metadata,
  }));
  const groups = resources.filter(r => r.kind === "docker-compose-project" && r.purpose === "development");
  if (groups.length !== 1 || !input.task.worktreePath) throw Error("Generated cache requires one original enrolled Studio owner");
  const resource = groups[0]!;
  const authorityDigest = cleanupDigest({ version:1,taskId:input.task.id,sessionId:input.task.primarySessionId,requestKey:input.requestKey,preparedRevision:input.preparedRevision,
    cleanup:{operationRevision:input.operationRevision,operationDigest:input.operationDigest},resources:[{ id:resource.id,key:resource.key,identityDigest:finalizationResourceIdentity(resource).identityDigest }] });
  const capture = input.target ? await inspectFinalizationQuarantine({ taskId:input.task.id,resourceId:`original-worktree:${input.task.id}`,target:input.target }) : undefined;
  const paths = [...new Set([input.task.worktreePath,...(capture?.captured ? [capture.physicalPath] : [])])];
  const request = StudioSourceInput.parse({ version:1,mode:"studio-source",authorityDigest,...(capture?.captured ? {physicalRoot:capture.physicalPath} : {}), ...(input.ownerSha256 ? {ownerSha256:input.ownerSha256} : {}), observation:CleanupObserverInput.parse({
    version:1,stage:"prepare",task:{ id:input.task.id,primarySessionId:input.task.primarySessionId,worktreePath:input.task.worktreePath,toolingRevision:input.task.toolingRevision },resource,resources }) });
  await assertGeneratedCacheMounts(paths);
  await finalizationResourceObservation.pathsIdle!(paths);
  const capability = await dependencies.resolve({ task:input.task,config:input.config });
  const observed = validateStudioSourceResult(request,await dependencies.observe({ capability,request }));
  await finalizationResourceObservation.pathsIdle!(paths);
  const fresh = await input.prisma.remoteTaskResource.findMany({ where:{taskId:input.task.id},orderBy:{id:"asc"} });
  if (cleanupDigest(fresh.map(resource => CleanupObserverResource.parse({ id:resource.id,key:resource.key,kind:resource.kind,purpose:resource.purpose,externalId:resource.externalId,state:resource.state,expiresAt:resource.expiresAt?.toISOString() ?? null,metadata:resource.metadata }))) !== cleanupDigest(resources)) throw Error("Generated source resource inventory changed");
  return observed.ownerSha256;
}
