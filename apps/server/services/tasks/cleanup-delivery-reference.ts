import { createHash } from "node:crypto";
import type { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { finalizationDigest, finalizationResourceIdentity, type FinalizationResourcePlan } from "./finalization-resources.ts";

type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
type Reference = Extract<FinalizationResourcePlan, { disposition: "retain-reference" }> & {
  reference: { type: "pull-request"; mergeCommit: string };
};
export type CleanupDeliveryRetention = {
  version: 1; requestKey: string; taskId: string; sessionId: string; preparedRevision: number;
  operationRevision: number; operationDigest: string; confirmedRevision?: number;
  resourcePlanDigest: string; resources: [Reference];
};

/** The caller has already validated the immutable preparation/operation and
 * current owner, revocation and resource epoch. This projection adds no grant
 * or event: the accepted PR is history, while every physical target keeps its
 * existing removal obligation. Old resource prose is neither delivery proof
 * nor a reason to overwrite a genuinely accepted delivery. */
export function cleanupDeliveryRetention(active: Active, confirmedRevision?: number): CleanupDeliveryRetention | undefined {
  if (active.kind !== "v1") return;
  const { prepared, preparation, operation, binding } = active;
  const frozen = operation.binding, receipts = prepared.delivery.receipts;
  if (!preparation.value || createHash("sha256").update(preparation.value).digest("hex") !== frozen.preparedDigest
    || preparation.sequence !== frozen.preparedRevision || prepared.taskId !== frozen.taskId || prepared.sessionId !== frozen.sessionId
    || prepared.requestKey !== operation.requestKey || prepared.requestKey !== `finalize:${prepared.taskId}`
    || prepared.delivery.boundary !== "merge" || !receipts.pullRequest.observed || !receipts.pullRequest.matchesHead
    || !receipts.merge.observed || !receipts.merge.merged || !/^[a-f0-9]{40}$/.test(receipts.merge.sha ?? "")
    || !/^[a-f0-9]{40}$/.test(prepared.revision) || !receipts.snapshot.clean || receipts.snapshot.head !== prepared.revision
    || receipts.snapshot.branch !== prepared.branch || !receipts.commit.observed || !receipts.commit.clean || receipts.commit.sha !== prepared.revision) return;
  const url = receipts.pullRequest.url;
  const match = url?.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/);
  if (!match || [".", ".."].includes(match[2]!) || !Number.isSafeInteger(Number(match[3]))) return;
  // Include aliases of any kind/state in the ambiguity check. Retention is
  // exactly one frozen Ready PR, not an exemption for a resource kind.
  const originals = frozen.resources.filter(resource => resource.externalId === url);
  const current = binding.resources.filter(resource => resource.externalId === url);
  if (originals.length !== 1 || current.length !== 1) return;
  const saved = originals[0]!, resource = current[0]!;
  if (saved.state !== "ready" || resource.state !== "ready" || !["pull-request", "github-pull-request"].includes(resource.kind)
    || !["browser", "development", "review"].includes(resource.purpose)) return;
  const identity = finalizationResourceIdentity(resource);
  if (finalizationResourceIdentity(saved).identityDigest !== identity.identityDigest) return;
  const resources: [Reference] = [{ ...identity, purpose: resource.purpose as Reference["purpose"], disposition: "retain-reference", reference: {
    deliveryId: `finalizer:${prepared.taskId}:${preparation.sequence}`, type: "pull-request", repository: `${match[1]}/${match[2]}`,
    number: Number(match[3]), reviewedHead: prepared.revision, mergeCommit: receipts.merge.sha!,
  } }];
  return { version: 1, requestKey: prepared.requestKey, taskId: prepared.taskId, sessionId: prepared.sessionId, preparedRevision: preparation.sequence,
    operationRevision: active.operationRevision, operationDigest: finalizationDigest(operation),
    ...(confirmedRevision !== undefined ? { confirmedRevision } : {}), resourcePlanDigest: finalizationDigest(resources), resources };
}
