import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { RetirementGrant } from "./retirement-receipts.ts";
import { assertExternalBindingAuthority, latestExternalBinding } from "./external-deliveries.ts";
import { ExternalBinding } from "./external-delivery-schema.ts";
import { readLocalCompletion } from "./local-completion.ts";

/** Scheduling hint only. First preparation still independently proves the
 * accepted delivery, exact Git identity and retention before any effect. */
export async function cleanupCandidates(prisma: PrismaClient, config: ServerConfig, tasks: Array<{ id: string; primarySessionId: string | null; phase: string; ownerPaused: boolean; repositoryId: string; machineId: string; worktreePath: string | null; connectionId: string | null; issueIdentifier: string | null }>) {
  const candidates = tasks.filter(task => task.primarySessionId && task.worktreePath && ((task.connectionId === null && task.issueIdentifier === null) || (task.connectionId && task.issueIdentifier)) && !task.ownerPaused && task.phase !== "closed" && task.machineId === config.machine);
  if (!candidates.length) return new Set<string>();
  const sessionIds = candidates.map(task => task.primarySessionId!);
  const [sessions, links, events] = await Promise.all([
    prisma.runtimeSession.findMany({ where: { id: { in: sessionIds } } }),
    prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: { in: sessionIds }, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } }),
    prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: { in: sessionIds }, source: { in: candidates.map(task => `owner:${task.id}`) }, action: { in: ["completion-contract", "completion-verification", "completion-retirement-authority", "prepared-done-retirement", "delivered-retirement-revoked"] } }, orderBy: { sequence: "desc" } }),
  ]);
  const result = new Set<string>();
  for (const task of candidates) {
    const session = sessions.find(session => session.id === task.primarySessionId);
    if (!session || session.status === "closed" || session.role !== "primary" || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId
      || task.issueIdentifier !== null && !links.some(link => link.runtimeSessionId === session.id && link.connectionId === task.connectionId && link.externalId === task.issueIdentifier)) continue;
    const latest = (action: string) => events.find(event => event.runtimeSessionId === session.id && event.source === `owner:${task.id}` && event.action === action);
    try {
      if (task.connectionId === null && task.issueIdentifier === null) {
        await readLocalCompletion(prisma, task.id, session.id);
        result.add(task.id); continue;
      }
      const adopted = await latestExternalBinding(prisma, task.id, session.id);
      if (adopted) {
        await assertExternalBindingAuthority(prisma, config, ExternalBinding.parse(JSON.parse(adopted.value!)), adopted.sequence);
        result.add(task.id);
        continue;
      }
      const contract = latest("completion-contract"), value = JSON.parse(contract?.value ?? "null");
      if (!contract || value?.boundary !== "merge") continue;
      const verification = JSON.parse(latest("completion-verification")?.value ?? "null");
      if (value.verificationRequired !== false && (verification?.contractRevision !== contract.sequence || verification.verification?.passed !== true)) continue;
      const retirement = latest("completion-retirement-authority"), done = latest("prepared-done-retirement"), revoked = latest("delivered-retirement-revoked");
      if (retirement && !RetirementGrant.safeParse(JSON.parse(retirement.value ?? "null")).success || revoked && (!done || revoked.sequence > done.sequence)) continue;
      result.add(task.id);
    } catch { /* Malformed authority never schedules an effect. */ }
  }
  return result;
}
