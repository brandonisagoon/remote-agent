import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { retirementDigest } from "./retirement-receipts.ts";

export const CLEANUP_PROGRESS = "finalization-cleanup-progress";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CleanupProgressInput = z.object({ requestKey: z.string().min(1).max(180), operationRevision: z.number().int().positive(), operationDigest: Digest,
  outcomes: z.array(z.object({ key: z.string().min(1).max(200), outcome: z.string().min(1).max(80), detail: z.string().max(8000).optional() }).strict()).max(2000),
}).strict();
export const CleanupProgress = z.object({ operationRevision: z.number().int().positive(), operationDigest: Digest,
  resources: z.array(z.object({ id: z.string(), key: z.string(), state: z.string(), outcome: z.enum(["released", "retained", "blocked", "pending"]), detail: z.string().max(1000).optional() }).strict()).max(2000),
}).strict();
function detail(value: string | undefined) {
  return value?.replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "[redacted authorization]")
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").trim().slice(0, 1000);
}

/** Adapter messages are diagnostic only. Terminal progress always comes from
 * the current server resource receipt and authenticated archive proof. */
export async function recordCleanupProgress(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; progress: z.infer<typeof CleanupProgressInput> }) {
  const request = CleanupProgressInput.parse(input.progress);
  return input.prisma.$transaction(async tx => {
    const task = await tx.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
    if (!task.primarySessionId) throw new Error("Cleanup progress requires the original primary");
    const active = await assertPreparedCleanup({ prisma: tx, config: input.config, sessionId: task.primarySessionId, requestKey: request.requestKey });
    if (request.operationRevision !== active.operationRevision || request.operationDigest !== retirementDigest(active.operation)) throw new Error("Cleanup progress operation changed");
    const known = new Set(active.binding.resources.map(resource => resource.key));
    if (new Set(request.outcomes.map(outcome => outcome.key)).size !== request.outcomes.length || request.outcomes.some(outcome => !known.has(outcome.key))) throw new Error("Cleanup progress names an unknown or duplicate resource");
    const { retainedArchiveResourceIds } = await import("./archive-retention.ts");
    const retained = await retainedArchiveResourceIds(tx, input.config, active.prepared);
    const value = CleanupProgress.parse({ operationRevision: active.operationRevision, operationDigest: request.operationDigest,
      resources: active.binding.resources.map(resource => {
        const reported = request.outcomes.find(outcome => outcome.key === resource.key);
        const outcome = resource.state === "released" ? "released" : retained.has(resource.id) ? "retained" : reported ? "blocked" : "pending";
        return { id: resource.id, key: resource.key, state: resource.state, outcome, ...(reported?.detail ? { detail: detail(reported.detail) } : {}) };
      }) });
    const where = { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: CLEANUP_PROGRESS, key: request.requestKey };
    const prior = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    if (prior?.value === JSON.stringify(value)) return { revision: prior.sequence, ...value };
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(value) } });
    return { revision: event.sequence, ...value };
  });
}

export async function cleanupProgressProjection(prisma: Pick<PrismaClient, "runtimeMetadataEvent" | "remoteTaskResource">, task: { id: string; primarySessionId: string | null }, operation: { operationRevision: number; operationDigest: string }) {
  if (!task.primarySessionId) return {};
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: CLEANUP_PROGRESS, key: `finalize:${task.id}` }, orderBy: { sequence: "desc" } });
  if (!event?.value) return {};
  let decoded: unknown;
  try { decoded = JSON.parse(event.value); } catch { return {}; }
  const parsed = CleanupProgress.safeParse(decoded);
  if (!parsed.success || parsed.data.operationRevision !== operation.operationRevision || parsed.data.operationDigest !== operation.operationDigest) return {};
  const resources = await prisma.remoteTaskResource.findMany({ where: { taskId: task.id } });
  // Diagnostic history cannot turn a newer required receipt into success.
  const current = parsed.data.resources.map(entry => {
    const resource = resources.find(resource => resource.id === entry.id && resource.key === entry.key);
    return { ...entry, state: resource?.state ?? "unknown", outcome: resource?.state === "released" ? "released" as const : resource?.state === entry.state ? entry.outcome : "pending" as const };
  });
  return { cleanupProgress: { revision: event.sequence, ...parsed.data, resources: current } };
}
