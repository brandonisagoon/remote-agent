import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { assertPreparedCleanup, assertCompletedCleanup } from "./cleanup-lifecycle.ts";
import { LocalCompletion } from "./local-completion.ts";
import { retirementDigest } from "./retirement-receipts.ts";

export const LocalCleanupReport = z.object({ version: z.literal(1), kind: z.literal("local-completion/v1"), taskId: z.string(), sessionId: z.string(), requestKey: z.string(),
  operationRevision: z.number().int().positive(), preparedRevision: z.number().int().positive(), confirmedRevision: z.number().int().positive(),
  localCompletion: LocalCompletion, body: z.string(),
}).strict();
type Store = Pick<PrismaClient, "runtimeMetadataEvent">;
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
const where = (active: Active) => ({ runtimeSessionId: active.prepared.sessionId, source: `finalizer:${active.task.id}`, action: "finalization-cleanup-report", key: active.prepared.requestKey });

/** Same confirmation transaction and outbox identity as linked reporting.
 * This durable local fact is never represented as a Linear publication. */
export async function recordLocalCleanupReport(prisma: Store, active: Active, confirmedRevision: number) {
  if (active.kind !== "v1" || !active.prepared.localCompletion) throw Error("Local cleanup reporting requires its exact accepted local preparation");
  const prepared = active.prepared;
  const frozen = LocalCleanupReport.parse({ version: 1, kind: "local-completion/v1", taskId: prepared.taskId, sessionId: prepared.sessionId, requestKey: prepared.requestKey,
    operationRevision: active.operationRevision, preparedRevision: active.preparation.sequence, confirmedRevision, localCompletion: prepared.localCompletion,
    body: `Cleanup is confirmed for task ${prepared.taskId} under its verified ${prepared.localCompletion.boundary} completion. Required resources are retired, recorded retained evidence is preserved, and the exact original worktree and Git registration are absent. No source issue, pull request or merge is claimed.` });
  const prior = await prisma.runtimeMetadataEvent.findFirst({ where: where(active) });
  if (prior && retirementDigest(JSON.parse(prior.value!)) !== retirementDigest(frozen)) throw Error("Local cleanup reporting receipt changed");
  const event = prior ?? await prisma.runtimeMetadataEvent.create({ data: { ...where(active), value: JSON.stringify(frozen) } });
  return { published: false as const, recorded: true as const, reportId: `metadata:${event.sequence}` };
}

export async function readLocalCleanupReport(prisma: Store, active: Awaited<ReturnType<typeof assertCompletedCleanup>>) {
  if (active.kind !== "v1" || !active.prepared.localCompletion) throw Error("Local cleanup reporting requires its exact accepted local preparation");
  const event = await prisma.runtimeMetadataEvent.findFirstOrThrow({ where: where(active) });
  const frozen = LocalCleanupReport.parse(JSON.parse(event.value!));
  if (frozen.taskId !== active.task.id || frozen.sessionId !== active.prepared.sessionId || frozen.requestKey !== active.prepared.requestKey
    || frozen.operationRevision !== active.operationRevision || frozen.preparedRevision !== active.preparation.sequence || frozen.confirmedRevision !== active.confirmed.sequence
    || retirementDigest(frozen.localCompletion) !== retirementDigest(active.prepared.localCompletion)) throw Error("Local cleanup reporting authority changed");
  return { published: false as const, recorded: true as const, reportId: `metadata:${event.sequence}` };
}
