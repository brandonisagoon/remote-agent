import { prepareTaskFinalization } from "./finalization.ts";
import type { FinalizationContext } from "./finalization-receipts.ts";

/** Renew the same checked preparation without sending its inventory again.
 * Keep the existing authority path, including pause, revocation, resource and
 * original-administration checks. This response cannot prepare a new cleanup. */
export async function renewCleanupAuthority(input: FinalizationContext) {
  const receipt = await prepareTaskFinalization({ ...input, cleanup: true, authorityOnly: true });
  if (!("cleanup" in receipt) || !receipt.cleanup) throw new Error("Cleanup renewal requires an existing bound operation");
  return {
    version: 1 as const,
    taskId: receipt.taskId,
    sessionId: receipt.sessionId,
    requestKey: receipt.requestKey,
    preparedRevision: receipt.preparedRevision,
    cleanup: receipt.cleanup,
  };
}
