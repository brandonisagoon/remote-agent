import { z } from "zod";
import type { Prisma } from "../../../../generated/prisma/client.ts";

export const ReportableCapability = z.enum(["development-credentials", "cleanup", "runtime", "browser"]);
export const CapabilityOutcome = z.object({
  version: z.literal(1), capability: ReportableCapability, state: z.enum(["blocked", "resolved"]),
  taskId: z.string(), sessionId: z.string(), worktreePath: z.string(), taskToolingRevision: z.string(),
  capabilityRevision: z.string(),
  connectionId: z.string().nullable().default(null), issueIdentifier: z.string().nullable().default(null),
  lastResolvedGeneration: z.number().int().nonnegative().default(0),
}).strict();
export const capabilityOutcomeSource = (taskId: string) => `tooling-capability-resolution:${taskId}`;
export const capabilityOutcomeConsumer = (taskId: string, capability: string) => `tooling-capability-resolution:v1:${taskId}:${capability}`;
export const capabilityFailureCode = "tooling-capability-unavailable";

/** A resolver observation, not a fabricated execution or an adapter operation.
 * The caller rechecks ownership in this transaction. Unchanged retries share
 * one durable fact; successful reads only record recovery of an actual failure. */
export async function recordCapabilityOutcome(tx: Prisma.TransactionClient, outcome: z.input<typeof CapabilityOutcome>) {
  const value = CapabilityOutcome.parse(outcome);
  const consumer = capabilityOutcomeConsumer(value.taskId, value.capability);
  const cursor = await tx.runtimeEventCursor.upsert({ where: { runtimeSessionId_consumer: { runtimeSessionId: value.sessionId, consumer } },
    create: { runtimeSessionId: value.sessionId, consumer }, update: { generation: { increment: 0 } } });
  const previous = cursor.sourceCursor ? CapabilityOutcome.parse(JSON.parse(cursor.sourceCursor)) : null;
  if (!previous && value.state === "resolved"
    || previous && JSON.stringify({ ...previous, lastResolvedGeneration: 0 }) === JSON.stringify({ ...value, lastResolvedGeneration: 0 })) return;
  value.lastResolvedGeneration = value.state === "resolved" ? Number(cursor.generation) + 1 : previous?.lastResolvedGeneration ?? 0;
  await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: value.sessionId, source: capabilityOutcomeSource(value.taskId),
    action: "tooling-capability-resolution", key: value.capability, value: JSON.stringify(value) } });
  await tx.runtimeEventCursor.update({ where: { id: cursor.id }, data: { sourceCursor: JSON.stringify(value), generation: { increment: 1 } } });
}
