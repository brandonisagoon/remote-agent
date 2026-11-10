import { z } from "zod";
import type { PrismaClient, RemoteTask, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { savedWorkMap } from "./work-map-state.ts";
import { completionObservation } from "./completion-observation.ts";
import { finalizationDigest } from "./finalization-resources.ts";

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Contract = z.object({ boundary: z.literal("merge"), repository: z.string(), baseBranch: z.string(), reviewRequired: z.boolean().optional() });
const Delivery = z.object({ contractRevision: z.number().int().positive(),
  snapshot: z.object({ head: Sha, branch: z.string(), clean: z.literal(true), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  commit: z.object({ observed: z.literal(true), sha: Sha, clean: z.literal(true) }),
  pullRequest: z.object({ observed: z.literal(true), matchesHead: z.literal(true), url: z.string().url() }),
  review: z.object({ observed: z.boolean(), approved: z.boolean() }),
  merge: z.object({ observed: z.literal(true), merged: z.literal(true), sha: Sha }),
});
type Store = Pick<PrismaClient, "runtimeMetadataEvent">;

/** A completed merge can make app compute unnecessary before the final
 * verification receipt is refreshed. This reads only server-observed delivery
 * and current owner authority; verification is deliberately not asserted here.
 * Physical coverage, writers and active requests are separate mandatory guards. */
export async function mergedComputeStopScope(prisma: Store, task: RemoteTask, sourceRevision: string | undefined, resources: RemoteTaskResource[]) {
  if (!sourceRevision || task.ownerPaused || task.phase === "closed" || !task.primarySessionId
    || resources.some(resource => resource.kind === "browser" && resource.state !== "released")) return null;
  const contract = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}`, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  const policy = Contract.safeParse(JSON.parse(contract?.value ?? "null"));
  if (!contract || !policy.success) return null;
  const revoked = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}`,
    action: { in: ["completion-retirement-authority", "delivered-retirement-revoked"] }, sequence: { gt: contract.sequence } }, orderBy: { sequence: "desc" } });
  if (revoked && (revoked.action === "delivered-retirement-revoked" || JSON.parse(revoked.value ?? "null")?.action === "revoke")) return null;
  const map = await savedWorkMap(prisma, task);
  if (map?.saved.input.remainingConsumers.length) return null;
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `observer:${task.id}`, action: "completion-observation" }, orderBy: { sequence: "desc" } });
  const delivery = Delivery.safeParse(JSON.parse(event?.value ?? "null"));
  if (!event || event.sequence <= contract.sequence || !delivery.success || delivery.data.contractRevision !== contract.sequence
    || event.key !== String(contract.sequence) || delivery.data.snapshot.head !== sourceRevision || delivery.data.snapshot.branch !== task.branchName
    || delivery.data.commit.sha !== sourceRevision || policy.data.reviewRequired && !delivery.data.review.approved) return null;
  return { contractRevision: contract.sequence, contractDigest: finalizationDigest(JSON.parse(contract.value!)),
    snapshot: delivery.data.snapshot, mergeCommit: delivery.data.merge.sha, workMapRevision: map?.revision ?? null };
}
export type MergedComputeStopScope = NonNullable<Awaited<ReturnType<typeof mergedComputeStopScope>>>;

/** Effect selection calls this outside SQL. A matching HEAD alone must not
 * hide new dirty/untracked implementation or a changed whole-worktree proof. */
export async function verifyMergedComputeStopSource(task: Pick<RemoteTask, "worktreePath">, scope: MergedComputeStopScope, read = completionObservation.snapshot) {
  if (!task.worktreePath || finalizationDigest(await read(task.worktreePath)) !== finalizationDigest(scope.snapshot)) throw new Error("Merged app stop source changed; preserve the app for remaining work");
}
