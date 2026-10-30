import { z } from "zod";
import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { CLEANUP_OPERATION, CleanupOperation } from "./cleanup-lifecycle.ts";
import { FINALIZATION_CONFIRMED, FINALIZATION_PREPARED } from "./finalization-receipts.ts";
import { retirementDigest } from "./retirement-receipts.ts";
import { normalizeRetirementPreviewTransition } from "./retirement-preview.ts";

// Validate only the saved identity envelope here. The effect guard still
// validates the complete versioned preparation and its current authority.
const SavedPreparation = z.object({
  taskId: z.string(), sessionId: z.string(), requestKey: z.string(), repositoryId: z.string(), machineId: z.string(),
  connectionId: z.string(), issueIdentifier: z.string(), taskWorktree: z.string(), branch: z.string(), version: z.literal(2).optional(),
  deliveredRetirement: z.object({ kind: z.literal("present-day-owner"), recordedBranch: z.string() }).optional(),
});
type Store = Pick<PrismaClient, "runtimeMetadataEvent" | "remoteTaskResource">;
function metadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { observed: _observed, observedAt: _observedAt, ...stable } = value as Record<string, unknown>;
  return stable;
}

/** Saved facts only. No turn, pause, revocation or current source state may
 * erase this history. This result is never a preparation or effect capability. */
export async function inspectSavedCleanup(prisma: Store, taskId: string) {
  const requestKey = `finalize:${taskId}`, source = `finalizer:${taskId}`;
  const events = await prisma.runtimeMetadataEvent.findMany({ where: { source, action: CLEANUP_OPERATION, key: requestKey }, take: 2 });
  if (!events.length) return undefined;
  if (events.length !== 1) throw new Error("Saved cleanup operation identity is ambiguous");
  const event = events[0]!, operation = CleanupOperation.parse(JSON.parse(event.value ?? "null")), binding = operation.binding;
  if (operation.requestKey !== requestKey || binding.taskId !== taskId || binding.sessionId !== event.runtimeSessionId) throw new Error("Saved cleanup operation belongs to another task or original primary");
  const preparation = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: binding.preparedRevision } });
  if (!preparation?.value || preparation.runtimeSessionId !== binding.sessionId || preparation.source !== source || preparation.action !== FINALIZATION_PREPARED
    || preparation.key !== requestKey || preparation.sequence >= event.sequence || createHash("sha256").update(preparation.value).digest("hex") !== binding.preparedDigest) throw new Error("Saved cleanup preparation identity or bytes changed");
  const prepared = SavedPreparation.parse(JSON.parse(preparation.value));
  if (prepared.taskId !== taskId || prepared.sessionId !== binding.sessionId || prepared.requestKey !== requestKey || prepared.repositoryId !== binding.repositoryId
    || prepared.machineId !== binding.machineId || prepared.connectionId !== binding.connectionId || prepared.issueIdentifier !== binding.issueIdentifier
    || prepared.taskWorktree !== binding.worktree || (prepared.version === 2 && prepared.deliveredRetirement ? prepared.deliveredRetirement.recordedBranch : prepared.branch) !== binding.branch) throw new Error("Saved cleanup preparation belongs to another original identity");
  const confirmed = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: binding.sessionId, source, action: FINALIZATION_CONFIRMED, key: requestKey } });
  if (confirmed && (confirmed.sequence <= event.sequence || JSON.parse(confirmed.value ?? "null")?.preparedRevision !== preparation.sequence)) throw new Error("Saved cleanup confirmation belongs to another preparation");
  const current = (await prisma.remoteTaskResource.findMany({ where: { taskId }, orderBy: { id: "asc" } })).map(resource => ({
    id: resource.id, key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId, state: resource.state,
    expiresAt: resource.expiresAt?.toISOString() ?? null, metadata: metadata(resource.metadata),
  }));
  const resources = binding.resources.map(saved => {
    const resource = current.find(value => value.id === saved.id);
    let identity: "matched" | "changed" | "missing" = resource ? "changed" : "missing";
    if (resource) {
      try {
        const stable = retirementDigest(resource.metadata) === retirementDigest(saved.metadata) ? resource.metadata : normalizeRetirementPreviewTransition(saved, resource, binding.resources, current);
        if (!(saved.state === "released" && resource.state !== "released") && retirementDigest({ ...resource, state: saved.state, metadata: stable }) === retirementDigest(saved)) identity = "matched";
      } catch { /* A changed identity is diagnostic; it is never a release. */ }
    }
    return { id: saved.id, key: saved.key, kind: saved.kind, purpose: saved.purpose, identity, recordedState: saved.state, state: identity === "matched" ? resource!.state : "unknown" };
  });
  return {
    operation,
    history: { readOnly: true as const, operationRevision: event.sequence, operationDigest: retirementDigest(operation), preparedRevision: preparation.sequence,
      originalSessionId: binding.sessionId, ...(confirmed ? { recordedConfirmationRevision: confirmed.sequence } : {}), resources,
      unboundResourceIds: current.filter(resource => !binding.resources.some(saved => saved.id === resource.id)).map(resource => resource.id) },
  };
}
