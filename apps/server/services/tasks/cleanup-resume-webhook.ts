import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { LinearIssueWebhook } from "../../integrations/linear/webhook-types/index.ts";
import { CLEANUP_RESUME, CleanupResumeReceipt, cleanupResumeRequestKey } from "./cleanup-resume-schema.ts";

/** An authenticated cleanup continuation must not look like another human
 * Merge approval. Match its persisted source and actor, including lost-ack
 * delivery, before the ordinary workflow dispatcher creates any receipt. */
export async function isCleanupResumeWebhook(prisma: PrismaClient, config: ServerConfig, webhook: LinearIssueWebhook) {
  if (webhook.actor?.id !== config.agentUserId || webhook.data.state?.name !== "Merge" || !webhook.updatedFrom?.stateId) return false;
  const tasks = await prisma.remoteTask.findMany({ where: { repositoryId: config.activeRepositoryId, connectionId: config.activeConnectionId, issueIdentifier: webhook.data.identifier, machineId: config.machine } });
  for (const task of tasks) {
    if (!task.primarySessionId) continue;
    const events = await prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}`, action: CLEANUP_RESUME }, orderBy: { sequence: "desc" } });
    for (const event of events) {
      let value: unknown;
      try { value = JSON.parse(event.value ?? "null"); } catch { continue; }
      const receipt = CleanupResumeReceipt.safeParse(value);
      if (!receipt.success) continue;
      const saved = receipt.data, identity = saved.binding.identity;
      if (saved.serviceActorId === webhook.actor.id && saved.binding.issueId === webhook.data.id && identity.issueIdentifier === webhook.data.identifier
        && identity.taskId === task.id && identity.sessionId === task.primarySessionId && identity.repositoryId === config.activeRepositoryId && identity.connectionId === config.activeConnectionId && identity.machineId === config.machine
        && saved.sourceStateId === webhook.updatedFrom.stateId && (!webhook.data.state.id || webhook.data.state.id === saved.targetStateId)
        && event.key === saved.input.requestKey && event.key === cleanupResumeRequestKey(saved.input)
        && webhook.webhookTimestamp >= event.occurredAt.getTime()) return true;
    }
  }
  return false;
}
