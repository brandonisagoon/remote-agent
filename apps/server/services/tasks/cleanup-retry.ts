import { z } from "zod";
import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { retirementDigest as sha } from "./retirement-receipts.ts";

export const CLEANUP_RETRY_INPUT = "finalization-cleanup-retry-input";
type Store = Pick<PrismaClient, "remoteTaskResource" | "runtimeMetadataEvent" | "runtimeInstruction" | "runtimeSourceMessage">;
const Saved = z.object({ version: z.literal(1), taskId: z.string(), sessionId: z.string(), instructionId: z.string(),
  inputs: z.string().regex(/^[a-f0-9]{64}$/), attempt: z.number().int().min(1).max(3), retry: z.literal("now").optional() }).strict();
const pending = ["preparing", "queued", "dispatching", "unknown"];
const ownerActions = ["completion-contract", "completion-verification", "completion-owner-approval", "completion-retirement-authority", "prepared-done-retirement", "delivered-retirement-revoked", "legacy-evidence-retained", "finalization-legacy-original-work", "external-delivery-binding"];
const proofActions = ["finalization-prepared", "finalization-cleanup-started", "finalization-confirmed", "finalization-original-administration", "finalization-cleanup-evidence-supplement"];
export class CleanupRetryDeferred extends Error {
  constructor(readonly retryAt: string) { super(`Cleanup retry deferred until ${retryAt}; recorded inputs and cleanup progress are unchanged.`); }
}

/** Scheduling evidence only. Never substitutes for current effect authority or
 * a fresh provider/filesystem observation. Attempt diagnostics are not inputs. */
async function inputs(store: Store, config: ServerConfig, task: RemoteTask) {
  const resources = await store.remoteTaskResource.findMany({ where: { taskId: task.id }, orderBy: { id: "asc" }, take: 1001 });
  if (resources.length > 1000) throw new Error("Cleanup retry resource inventory exceeds its bound");
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId!, OR: [
    { source: `owner:${task.id}`, action: { in: ownerActions } },
    { source: `finalizer:${task.id}`, action: { in: proofActions } },
    { source: `finalizer-archives:${task.id}`, action: "finalization-archive-retention" },
    { source: `legacy-evidence:${task.id}`, action: "legacy-evidence-confirmed" },
  ] }, orderBy: { sequence: "desc" }, take: 10001 });
  if (events.length > 10000) throw new Error("Cleanup retry proof history exceeds its bound");
  const seen = new Set<string>();
  const latest = events.filter(event => { const key = JSON.stringify([event.source, event.action, event.key]); if (seen.has(key)) return false; seen.add(key); return true; });
  const authors = Object.values(config.webhooks).filter(webhook => webhook.connectionId === task.connectionId)
    .flatMap(webhook => webhook.repositoryRouting[task.repositoryId]?.when?.flatMap(rule => rule["linear.userId"] ?? []) ?? []);
  // Only already delivered, subscribed source work counts. Informational native
  // dispositions have no executing request and are explicitly excluded too.
  const sources = await store.runtimeSourceMessage.findMany({ where: { provider: "linear", connectionId: task.connectionId ?? "", repositoryId: task.repositoryId,
    machineId: task.machineId, resourceIdentifier: task.issueIdentifier ?? "", sessionId: task.primarySessionId!, authorId: { in: authors },
    requestId: { not: null }, state: "handled", resolutions: { none: { outcome: "informational" } } }, orderBy: { sequence: "desc" }, take: 1001 });
  let ownerInput: string | null = null;
  for (const source of sources) {
    if (await store.runtimeInstruction.findFirst({ where: { sessionId: task.primarySessionId!, sourceMessageId: source.id, state: "completed", executionRequestId: source.requestId } })) { ownerInput = source.id; break; }
  }
  if (!ownerInput && sources.length > 1000) throw new Error("Cleanup retry source history exceeds its bound");
  return sha({ task: { id: task.id, primary: task.primarySessionId, repository: task.repositoryId, machine: task.machineId, connection: task.connectionId,
    issue: task.issueIdentifier, worktree: task.worktreePath, branch: task.branchName, base: task.baseCommit, toolingRoot: task.toolingRoot, pin: task.toolingRevision, pinnedRoot: task.pinnedToolingRoot },
    capability: { tooling: config.repositories[task.repositoryId]?.tooling ?? null, installRoot: config.installRoot, socket: config.controlIpcPath },
    resources: resources.map(({ id, key, kind, purpose, externalId, state, metadata, expiresAt }) => {
      const { observed, observedAt: _time, ...stable } = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
      const native = observed && typeof observed === "object" && !Array.isArray(observed) ? observed.legacyNative ?? null : null;
      return { id, key, kind, purpose, externalId, state, metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? stable : metadata, native, expiresAt: expiresAt?.toISOString() ?? null };
    }), proofs: latest.map(event => [event.sequence, event.source, event.action, event.key, sha(event.value)]), ownerInput });
}

export async function cleanupRetryEligibility(store: Store, config: ServerConfig, task: RemoteTask, now = Date.now(), retry?: "now") {
  const digest = await inputs(store, config, task);
  const waiting = await store.runtimeInstruction.findMany({ where: { sessionId: task.primarySessionId!, state: { in: pending } }, select: { id: true } });
  if (waiting.length && await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId!, source: "cleanup-inbox", action: "finalization-cleanup-instruction", key: { in: waiting.map(row => row.id) } } })) return { inputs: digest, attempt: 1 };
  const rows = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId!, source: "cleanup-inbox", action: CLEANUP_RETRY_INPUT }, orderBy: { sequence: "desc" }, take: 1001 });
  for (const row of rows) {
    const saved = Saved.parse(JSON.parse(row.value ?? "null"));
    if (saved.taskId !== task.id || saved.sessionId !== task.primarySessionId || saved.instructionId !== row.key) throw new Error("Cleanup retry history belongs to another original task");
    const instruction = await store.runtimeInstruction.findUniqueOrThrow({ where: { id: saved.instructionId } });
    if (instruction.sessionId !== saved.sessionId) throw new Error("Cleanup retry instruction changed ownership");
    // Dedup remains the inbox's responsibility. An unstarted cancellation or
    // capability supersession is not an attempted finalizer and costs no delay.
    if (pending.includes(instruction.state)) return { inputs: digest, attempt: 1 };
    if (!instruction.executionRequestId || !["completed", "failed", "cancelled"].includes(instruction.state)) continue;
    if (saved.inputs !== digest) return { inputs: digest, attempt: 1 };
    const retryAt = instruction.updatedAt.getTime() + 30 * 60_000 * 2 ** (saved.attempt - 1);
    if (!retry && now < retryAt) throw new CleanupRetryDeferred(new Date(retryAt).toISOString());
    return { inputs: digest, attempt: Math.min(3, saved.attempt + 1) };
  }
  if (rows.length > 1000) throw new Error("Cleanup retry unstarted history exceeds its bound");
  // Historical markers remain untouched. Their first normal post-upgrade
  // attempt establishes a snapshot; no historical physical proof is invented.
  return { inputs: digest, attempt: 1 };
}

export async function recordCleanupRetryInput(store: Store, task: RemoteTask, instructionId: string, selection: { inputs: string; attempt: number }, retry?: "now") {
  const value = Saved.parse({ version: 1, taskId: task.id, sessionId: task.primarySessionId, instructionId, ...selection, ...(retry ? { retry } : {}) });
  await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: task.primarySessionId!, source: "cleanup-inbox", action: CLEANUP_RETRY_INPUT, key: instructionId, value: JSON.stringify(value) } });
}
