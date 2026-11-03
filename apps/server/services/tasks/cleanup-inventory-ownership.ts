import type { FinalizationContext } from "./finalization-receipts.ts";
import { inspectPreparedCleanupState } from "./cleanup-lifecycle.ts";
import { assertLocalCleanupFamily } from "./local-completion.ts";
import { retirementDigest } from "./retirement-receipts.ts";

/** Read-only scan liveness, never physical effect authority. The client still
 * checks every held inventory entry and uses full preparation/physical scopes
 * before capture, resource mutation, administration retirement and confirmation.
 * This endpoint neither observes physical targets nor creates a preparation. */
export async function checkCleanupInventoryOwnership(input: FinalizationContext & { ownershipEpoch?: string }) {
  return input.prisma.$transaction(async tx => {
    const active = await inspectPreparedCleanupState({ ...input, prisma: tx });
    if (input.finalizationVersion === 2 && active.kind !== "v2") throw Error("Inventory check requires its original finalization version");
    if (active.kind === "v1" && active.prepared.localCompletion && !active.closedContinuation) {
      await assertLocalCleanupFamily(tx, active.task, input.runtime);
    }
    if (input.ownershipEpoch !== undefined && input.ownershipEpoch !== active.authorityEpoch) throw Error("Inventory owner epoch changed during the scan");
    return { version: 1 as const, purpose: "inventory-read-only" as const,
      ownershipEpoch: active.authorityEpoch,
      taskId: active.task.id, sessionId: active.binding.sessionId, requestKey: active.prepared.requestKey,
      preparedRevision: active.preparation.sequence,
      cleanup: { operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation) } };
  });
}
