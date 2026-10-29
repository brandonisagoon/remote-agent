import { z } from "zod";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";

export const projectionRetryPolicy = { maxAttempts: 5, initialDelayMs: 1_000, maxDelayMs: 60_000 } as const;
export const ProjectionRetryStage = z.enum(["notify", "project", "stall"]);
type Stage = z.infer<typeof ProjectionRetryStage>;
type Identity = { sessionId: string; eventId: string; stage: Stage };
const ACTION = "projection-delivery-retry";
const SOURCE = "runtime-event-projection:v1:";
const State = z.object({
  state: z.enum(["backoff", "exhausted", "ready", "recovered"]), attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().nullable(), lastError: z.string().nullable(), failedAt: z.number(),
});
const active = new WeakMap<PrismaClient, Set<string>>();
const keyFor = (identity: Identity) => JSON.stringify([identity.sessionId, identity.stage, identity.eventId]);
const whereFor = (identity: Identity) => ({ runtimeSessionId: identity.sessionId, action: ACTION, source: `${SOURCE}${identity.stage}`, key: identity.eventId });

/** Known delivery failures have a durable, finite automatic retry budget.
 * This retries only idempotent projection/enqueue work, never provider turns.
 * A crash before acknowledgement still uses the caller's original effect ID. */
export async function runRuntimeProjectionAttempt(prisma: PrismaClient, identity: Identity, deliver: () => Promise<unknown>, now: () => number = Date.now): Promise<boolean> {
  const running = active.get(prisma) ?? new Set<string>();
  active.set(prisma, running);
  const key = keyFor(identity);
  if (running.has(key)) return false;
  running.add(key);
  try {
    const where = whereFor(identity);
    const prior = await prisma.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    const saved = prior ? State.parse(JSON.parse(prior.value!)) : null;
    if (saved?.state === "exhausted" || saved?.state === "backoff" && (saved.nextAttemptAt ?? Infinity) > now()) return false;
    let failure: unknown;
    let failed = false;
    try { await deliver(); }
    catch (error) { failure = error; failed = true; }
    // Healthy events need no retry log; recovered projection cursors and inbox
    // IDs remain their own acknowledgements. Only a known failure is retried.
    if (!failed && (!saved || saved.state === "recovered")) return true;
    await prisma.$transaction(async (tx) => {
      const latest = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
      // An explicit recovery decision made during delivery wins over stale work.
      if ((latest?.sequence ?? null) !== (prior?.sequence ?? null)) return;
      const at = now();
      const attempts = failed ? (saved?.state === "recovered" ? 0 : saved?.attempts ?? 0) + 1 : saved!.attempts;
      const exhausted = failed && attempts >= projectionRetryPolicy.maxAttempts;
      const value: z.infer<typeof State> = {
        state: failed ? exhausted ? "exhausted" : "backoff" : "recovered", attempts,
        nextAttemptAt: failed && !exhausted ? at + Math.min(projectionRetryPolicy.maxDelayMs, projectionRetryPolicy.initialDelayMs * 2 ** (attempts - 1)) : null,
        lastError: failed ? (failure instanceof Error ? failure.message : String(failure)).slice(0, 2_000) : null,
        failedAt: saved && saved.state !== "recovered" ? saved.failedAt : at,
      };
      await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(value) } });
    });
    if (failed) console.error(`[runtime-events] ${identity.stage} delivery failed for ${identity.eventId}:`, failure);
    return !failed;
  } finally { running.delete(key); }
}

export async function listRuntimeProjectionRetries(prisma: PrismaClient, sessionIds: string[]) {
  const events = await prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: { in: sessionIds }, action: ACTION, source: { in: ProjectionRetryStage.options.map((stage) => `${SOURCE}${stage}`) } }, orderBy: { sequence: "desc" } });
  const seen = new Set<string>();
  const pending: Array<Identity & Omit<z.infer<typeof State>, "state"> & { state: "backoff" | "exhausted" | "ready"; sequence: number }> = [];
  for (const event of events) {
    const stage = ProjectionRetryStage.parse(event.source!.slice(SOURCE.length));
    const identity = { sessionId: event.runtimeSessionId, eventId: event.key!, stage };
    const key = keyFor(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    const value = State.parse(JSON.parse(event.value!));
    if (value.state !== "recovered") pending.push({ ...identity, ...value, state: value.state, sequence: event.sequence });
  }
  return pending;
}

/** The diagnostic publisher observed that this condition no longer exists.
 * Clear its retry status without delivering an effect or replenishing work. */
export async function resolveRuntimeProjectionRetry(prisma: PrismaClient, identity: Identity, now: () => number = Date.now): Promise<void> {
  if (active.get(prisma)?.has(keyFor(identity))) return;
  const where = whereFor(identity);
  await prisma.$transaction(async (tx) => {
    const prior = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    if (!prior) return;
    const saved = State.parse(JSON.parse(prior.value!));
    if (saved.state === "recovered") return;
    await tx.runtimeMetadataEvent.create({ data: { ...where, occurredAt: new Date(now()), value: JSON.stringify({ ...saved, state: "recovered", nextAttemptAt: null, lastError: null }) } });
  });
}

/** Explicit supervisor recovery replenishes only this event's projection
 * budget. It never changes an inbox outcome, resumes control or starts a turn. */
export async function retryTaskRuntimeProjection(prisma: PrismaClient, input: {
  taskId: string; sessionId: string; eventId: string; stage: Stage; requestKey: string; reason: string;
}, now: () => number = Date.now) {
  const identity: Identity = input;
  if (active.get(prisma)?.has(keyFor(identity))) throw new Error("Projection delivery is still running; inspect its outcome before retrying");
  return prisma.$transaction(async (tx) => {
    const task = await tx.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
    const session = await tx.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
    if (!task.primarySessionId || (task.ownerPaused || task.phase === "closed") || session.status === "closed") throw new Error("Projection recovery requires an open task and session");
    const primary = session.id === task.primarySessionId ? session : await tx.runtimeSession.findUniqueOrThrow({ where: { id: task.primarySessionId } });
    if (primary.role !== "primary" || primary.status === "closed" || primary.cwd !== task.worktreePath || primary.repositoryId !== task.repositoryId || primary.machineId !== task.machineId) throw new Error("Projection task primary is closed or its ownership changed");
    if (session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) throw new Error("Projection session does not belong to this task");
    if (session.id !== task.primarySessionId && !(session.role === "delegate" && await tx.runtimeSessionRelation.findFirst({ where: { sourceSessionId: session.id, targetSessionId: task.primarySessionId, relationship: "spawned-by", endedAt: null } }))) throw new Error("Projection session is not this task's primary or delegate");
    const decisionWhere = { runtimeSessionId: session.id, action: "projection-retry-request", source: `task-supervisor:${task.id}`, key: input.requestKey };
    const payload = JSON.stringify({ eventId: input.eventId, stage: input.stage, reason: input.reason });
    const decision = await tx.runtimeMetadataEvent.findFirst({ where: decisionWhere });
    if (decision) {
      if (decision.value !== payload) throw new Error("Projection requestKey belongs to a different recovery decision");
      return { retried: true as const, decisionRevision: decision.sequence };
    }
    const where = whereFor(identity);
    const prior = await tx.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
    if (!prior) throw new Error("No failed projection delivery exists for this event");
    const saved = State.parse(JSON.parse(prior.value!));
    if (saved.state !== "exhausted") throw new Error("Projection is not exhausted; its current retry or acknowledgement remains authoritative");
    if (input.stage !== "stall" && !(await tx.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id, id: input.eventId } }))) throw new Error("Projection event is unavailable; inspect journal retention before recovery");
    await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify({ ...saved, state: "ready", attempts: 0, nextAttemptAt: now() }) } });
    const receipt = await tx.runtimeMetadataEvent.create({ data: { ...decisionWhere, value: payload } });
    return { retried: true as const, decisionRevision: receipt.sequence };
  });
}
