import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { queueInstruction } from "../sessions/inbox.ts";

export const RuntimeHealthInput = z.strictObject({ resourceKey: z.string().min(1).max(100), requestKey: z.string().min(1).max(150),
  state: z.enum(["waiting", "failed", "recovered"]), detail: z.string().min(1).max(2000), notify: z.boolean() });
/** A saved-runtime observation updates environment readiness, not task phase,
 * delivery status or ownership. Only settled outcomes notify the same primary. */
export async function recordRuntimeHealth(prisma: PrismaClient, sessionId: string, raw: z.infer<typeof RuntimeHealthInput>) {
  const input = RuntimeHealthInput.parse(raw), inputDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return prisma.$transaction(async tx => {
    const session = await tx.runtimeSession.findUniqueOrThrow({ where: { id: sessionId } });
    const task = await tx.remoteTask.findUnique({ where: { primarySessionId: sessionId }, include: { resources: true } });
    if (!task || session.role !== "primary" || session.status === "closed" || task.ownerPaused || ["closed", "complete"].includes(task.phase)
      || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) throw new Error("Runtime health requires the original unpaused managed task");
    if (task.connectionId && task.issueIdentifier) {
      const control = await tx.nativeTakeover.findUnique({ where: { connectionId_repositoryId_issueIdentifier: { connectionId: task.connectionId, repositoryId: task.repositoryId, issueIdentifier: task.issueIdentifier } } });
      if (control && (control.mode !== "managed" || control.grantedSessionId !== sessionId)) throw new Error("Runtime health cannot race native ownership");
    }
    const existing = await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: sessionId, source: "runtime-health", action: "runtime-health", key: input.requestKey } });
    if (existing.length) {
      if (existing.length !== 1 || JSON.parse(existing[0]!.value ?? "null")?.inputDigest !== inputDigest) throw new Error("Runtime health request key belongs to different evidence");
      return { recorded: true, eventId: existing[0]!.sequence };
    }
    const resource = task.resources.find(r => r.key === input.resourceKey && r.kind === "task-runtime" && r.purpose === "development");
    const progress = z.object({ progress: z.object({ step: z.literal("launcher-recovery"), detail: z.literal(input.detail) }) }).safeParse(resource?.metadata);
    const expected = { recovered: "ready", failed: "failed", waiting: "allocated" }[input.state];
    if (!resource || resource.state !== expected || !progress.success) throw new Error("Runtime health must match its current observed resource receipt");
    await tx.remoteTask.update({ where: { id: task.id, ownerPaused: false, primarySessionId: sessionId }, data: { environmentStatus: input.state === "recovered" ? "ready" : "degraded", recoveryDetail: input.detail } });
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: sessionId, source: "runtime-health", action: "runtime-health", key: input.requestKey,
      value: JSON.stringify({ version: 1, taskId: task.id, resourceId: resource.id, inputDigest, ...input }) } });
    if (input.notify) await queueInstruction(tx, { sessionId, requestId: `runtime-health:${task.id}:${event.sequence}`,
      text: `The existing maintenance workflow observed this task's application: ${input.detail}\nThis is an informational recovery result, not a new owner assignment. Inspect the original runtime and its registered recovery history. Preserve the task, saved data and owner controls. Report the meaningful outcome through the existing source issue; do not create another task or repeat a completed restart.` });
    return { recorded: true, eventId: event.sequence };
  });
}
