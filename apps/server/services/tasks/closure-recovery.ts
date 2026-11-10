import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { cleanupFamily } from "./closed-cleanup.ts";
import { canonical, closedFamilyDigest as digest, closedTextDigest } from "../sessions/closed-family-ownership.ts";

type Store = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionRelation" | "runtimeInstruction" | "runtimeLifecycleEvent" | "runtimeMetadataEvent">;
type Context = { prisma: PrismaClient; runtime: AgentSessionRuntime; taskId: string; machineId: string };
const action = "task-closure-settlement";

async function snapshot(db: Store, taskId: string, machineId: string) {
  const task = await db.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  if (task.phase !== "closed" || task.ownerPaused || task.machineId !== machineId || !task.primarySessionId || !task.worktreePath) throw new Error("Closure recovery requires the original unpaused closed task");
  const sessions = (await cleanupFamily(db, task, task.primarySessionId)).sort((a, b) => a.id.localeCompare(b.id));
  if (sessions.length > 64 || sessions.some(s => s.repositoryId !== task.repositoryId || s.machineId !== machineId)) throw new Error("Closure recovery has ambiguous family ownership");
  const primary = sessions.find(s => s.id === task.primarySessionId);
  if (!primary || primary.role !== "primary" || primary.cwd !== task.worktreePath) throw new Error("Closure recovery primary changed");
  const ids = sessions.map(s => s.id);
  if (await db.remoteTask.count({ where: { id: { not: task.id }, primarySessionId: { in: ids } } })) throw new Error("Closure recovery family contains another task owner");
  const relations = await db.runtimeSessionRelation.findMany({ where: { relationship: { in: ["spawned-by", "notifies-parent"] }, OR: [{ sourceSessionId: { in: ids } }, { targetSessionId: { in: ids } }] }, orderBy: { id: "asc" }, take: 257 });
  if (relations.length > 256 || relations.some(r => !ids.includes(r.sourceSessionId) || !ids.includes(r.targetSessionId))) throw new Error("Closure recovery has foreign family provenance");
  const instructions = await db.runtimeInstruction.findMany({ where: { sessionId: { in: ids }, state: { in: ["queued", "preparing", "dispatching", "unknown", "steered"] } }, orderBy: { sequence: "asc" }, take: 257 });
  if (instructions.length > 256 || instructions.some(i => i.state !== "queued" || i.executionRequestId || i.createdAt.getTime() !== i.updatedAt.getTime())) throw new Error("Closure recovery preserves uncertain instruction execution");
  const lifecycle = instructions.length ? await db.runtimeLifecycleEvent.findMany({ where: { runtimeSessionId: { in: ids }, OR: instructions.map(i => ({ requestId: { startsWith: i.id } })) }, take: 1 }) : [];
  const resolutions = instructions.length ? await db.runtimeMetadataEvent.count({ where: { runtimeSessionId: { in: ids }, action: "instruction-resolved", key: { in: instructions.map(i => i.id) } } }) : 0;
  if (lifecycle.length || resolutions) throw new Error("Closure recovery cannot cancel a previously attempted instruction");
  return { task, sessions, relations, instructions, ids };
}

/** Retry logical closure under its existing persisted fence. Never signal,
 * adopt or start a provider, and never turn an unknown execution into success.
 * Actual physical compute reclamation remains the collector's next operation. */
export async function settleClosedTaskFamily(input: Context) {
  const before = await snapshot(input.prisma, input.taskId, input.machineId);
  if (before.sessions.every(s => s.status === "closed" && s.closedAt) && !before.instructions.length) return { state: "settled" as const, changed: false };
  if (!input.runtime.releaseIdleTransports) throw new Error("Closure recovery requires a stopped-provider observer");
  const original = digest(before);
  await input.runtime.releaseIdleTransports({ sessionIds: before.ids, mode: "stopped-only",
    check: async () => { if (digest(await snapshot(input.prisma, input.taskId, input.machineId)) !== original) throw new Error("Closure recovery ownership changed"); },
    commit: async (evidence, assertUnchanged) => {
      if (!evidence || !assertUnchanged || evidence.length !== before.ids.length || new Set(evidence.map(e => e.sessionId)).size !== before.ids.length
        || evidence.some(e => !before.ids.includes(e.sessionId))) throw new Error("Closure recovery needs every original provider proof");
      for (const instruction of before.instructions) {
        const proof = evidence.find(e => e.sessionId === instruction.sessionId)!;
        const used = Date.parse(proof.lastUsedAt), prompted = Date.parse(proof.lastPromptAt ?? "");
        if (!Number.isFinite(used) || !Number.isFinite(prompted) || prompted > used || used >= instruction.createdAt.getTime() || used > Date.now() || proof.lastRequestId === instruction.id) throw new Error("Closure recovery lacks never-dispatched provider evidence");
      }
      await input.prisma.$transaction(async tx => {
        if (digest(await snapshot(tx, input.taskId, input.machineId)) !== original) throw new Error("Closure recovery changed before settlement");
        await assertUnchanged();
        const at = new Date();
        for (const session of before.sessions) if (session.status !== "closed" || !session.closedAt) {
          const changed = await tx.runtimeSession.updateMany({ where: { id: session.id, updatedAt: session.updatedAt, status: session.status }, data: { status: "closed", closedAt: session.closedAt ?? at, recoveryDetail: "Original task closure reconciled after provider absence; execution history preserved" } });
          if (changed.count !== 1) throw new Error("Closure recovery session changed");
        }
        for (const instruction of before.instructions) {
          const changed = await tx.runtimeInstruction.updateMany({ where: { id: instruction.id, state: "queued", updatedAt: instruction.updatedAt, executionRequestId: null }, data: { state: "cancelled", detail: "Original closed task; provider and journal prove this instruction was never dispatched" } });
          if (changed.count !== 1) throw new Error("Closure recovery instruction changed");
        }
        await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.task.primarySessionId!, source: `closure:${input.taskId}`, action, key: original,
          value: JSON.stringify(canonical({ version: 1, origin: "persisted-task-closure", task: before.task, sessions: before.sessions, relations: before.relations,
            instructions: before.instructions.map(({ text, ...row }) => ({ ...row, textSHA256: closedTextDigest(text), disposition: "cancelled-never-dispatched" })),
            providers: evidence.map(({ messages, ...proof }) => proof), at })) } });
        await assertUnchanged();
      });
    } });
  return { state: "settled" as const, changed: true };
}

type Result = { state: "settled"; changed: boolean } | { state: "pending"; reason: string };
const pending = new WeakMap<PrismaClient, Map<string, Promise<Result>>>();
export async function reconcileClosedTaskFamily(input: Context): Promise<Result> {
  let tasks = pending.get(input.prisma);
  if (!tasks) { tasks = new Map(); pending.set(input.prisma, tasks); }
  const key = JSON.stringify([input.machineId, input.taskId]), active = tasks.get(key);
  if (active) return active;
  const work = reconcileOnce(input); tasks.set(key, work);
  try { return await work; } finally { if (tasks.get(key) === work) tasks.delete(key); }
}
async function reconcileOnce(input: Context): Promise<Result> {
  let result: { state: "settled"; changed: boolean } | { state: "pending"; reason: string };
  try { result = await settleClosedTaskFamily(input); }
  catch (error) { result = { state: "pending", reason: error instanceof Error ? error.message.slice(0, 1000) : "Closure recovery proof unavailable" }; }
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId || task.phase !== "closed" || task.machineId !== input.machineId) return result;
  const where = { runtimeSessionId: task.primarySessionId, source: `closure:${task.id}`, action: "task-closure-recovery", key: task.id };
  const value = JSON.stringify({ version: 1, state: result.state, ...(result.state === "pending" ? { reason: result.reason } : {}) });
  const last = await input.prisma.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
  if (last?.value !== value) await input.prisma.runtimeMetadataEvent.create({ data: { ...where, value } });
  return result;
}
