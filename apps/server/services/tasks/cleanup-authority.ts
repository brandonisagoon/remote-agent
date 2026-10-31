import { prepareTaskFinalization } from "./finalization.ts";
import type { FinalizationContext } from "./finalization-receipts.ts";
import { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { cleanupResourceScope } from "./cleanup-resource-scope.ts";
import { retirementDigest } from "./retirement-receipts.ts";

/** Renew the same checked preparation without sending its inventory again.
 * Keep the existing authority path, including pause, revocation, resource and
 * original-administration checks. This response cannot prepare a new cleanup. */
export async function renewCleanupAuthority(input: FinalizationContext & { resourceKeys?: string[]; nativePids?: number[] }) {
  const receipt = await prepareTaskFinalization({ ...input, cleanup: true, authorityOnly: true });
  if (!("cleanup" in receipt) || !receipt.cleanup) throw new Error("Cleanup renewal requires an existing bound operation");
  const result = {
    version: 1 as const,
    taskId: receipt.taskId,
    sessionId: receipt.sessionId,
    requestKey: receipt.requestKey,
    preparedRevision: receipt.preparedRevision,
    cleanup: receipt.cleanup,
  };
  if (!input.resourceKeys) { if (input.nativePids) throw new Error("Native PID exclusions need selected resources"); return result; }
  if (receipt.confirmedRevision !== undefined) throw new Error("Confirmed cleanup cannot authorize legacy resource effects");
  return input.prisma.$transaction(async tx => {
    const active = await assertPreparedCleanup({ ...input, prisma: tx });
    if (active.preparation.sequence !== result.preparedRevision || active.operationRevision !== result.cleanup.operationRevision
      || retirementDigest(active.operation) !== result.cleanup.operationDigest) throw new Error("Cleanup operation changed during resource scope observation");
    const confirmed = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: `finalizer:${active.task.id}`, action: "finalization-confirmed", key: input.requestKey } });
    if (confirmed) throw new Error("Confirmed cleanup cannot authorize legacy resource effects");
    const resources = await cleanupResourceScope(tx, input.config, active, input.resourceKeys!, input.nativePids);
    const nativeApps = active.binding.resources.some(resource => input.resourceKeys!.includes(resource.key) && resource.kind === "local-http")
      ? { version: 1 as const, recordedBefore: active.preparation.occurredAt.toISOString(), ...(input.nativePids ? { pids: [...input.nativePids].sort((a, b) => a - b) } : {}) } : undefined;
    return { ...result, resources, ...(nativeApps ? { nativeApps } : {}) };
  });
}
