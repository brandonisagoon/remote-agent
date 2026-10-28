import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";

const active = new WeakMap<AgentSessionRuntime, Set<string>>();
const flushing = new WeakSet<AgentSessionRuntime>();

export async function queueInstruction(prisma: Pick<PrismaClient, "runtimeInstruction">, input: { sessionId: string; text: string; requestId?: string }) {
  const id = input.requestId ?? randomUUID();
  const receipt = await prisma.runtimeInstruction.upsert({ where: { id }, update: {}, create: { id, sessionId: input.sessionId, text: input.text } });
  if (receipt.sessionId !== input.sessionId || receipt.text !== input.text) throw new Error("Instruction request ID already belongs to another instruction");
  return receipt;
}

/** Called only by the daemon that owns the runtime. A claimed instruction
 * without a terminal journal entry after restart stays unknown, not replayed. */
export async function deliverInstructions(prisma: PrismaClient, runtime: AgentSessionRuntime) {
  if (flushing.has(runtime)) return;
  flushing.add(runtime);
  const running = active.get(runtime) ?? new Set<string>();
  active.set(runtime, running);
  try {
    const unsettled = await prisma.runtimeInstruction.findMany({ where: { state: { in: ["dispatching", "unknown"] } } });
    for (const receipt of unsettled) {
      if (running.has(receipt.id)) continue;
      const event = await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: receipt.sessionId, requestId: receipt.id, phase: { in: ["completed", "cancelled", "failed"] } }, orderBy: { sequence: "desc" } });
      await prisma.runtimeInstruction.update({ where: { id: receipt.id }, data: event
        ? { state: event.phase, detail: event.error }
        : { state: "unknown", detail: "Delivery was interrupted. Inspect session history before resolving; automatic replay is disabled." } });
    }
    // A busy/paused/uncertain session can have more than a page of queued
    // instructions. Do not let that backlog hide unrelated owners' work.
    // Visit each session once per pass, retaining its oldest queued message.
    const visited = new Set<string>();
    while (true) {
      const queued = await prisma.runtimeInstruction.findMany({
        where: { state: "queued", sessionId: { notIn: [...visited] } },
        orderBy: { sequence: "asc" }, take: 100,
      });
      if (!queued.length) break;
      for (const receipt of queued) {
        if (visited.has(receipt.sessionId)) continue;
        visited.add(receipt.sessionId);
        if (running.has(receipt.id)) continue;
        if (await prisma.runtimeInstruction.count({ where: { sessionId: receipt.sessionId, state: { in: ["dispatching", "unknown", "preparing"] } } })) continue;
        const session = await runtime.getSession(receipt.sessionId);
        if (!session || session.status === "closed") {
          await prisma.runtimeInstruction.update({ where: { id: receipt.id }, data: { state: "failed", detail: "Session is unavailable or closed" } });
          continue;
        }
        if (session.status === "active" || session.status === "provisioning") continue;
        const task = await prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
        if (task && task.controlMode !== "agent") continue;
        running.add(receipt.id);
        void (async () => {
          try {
            const turn = runtime.startTurn({ sessionId: receipt.sessionId, requestId: receipt.id, text: receipt.text, beforeStart: async () => {
              const claim = await prisma.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "queued" }, data: { state: "dispatching", detail: null } });
              return claim.count > 0;
            } });
            for await (const _ of turn.events) { /* Persisted lifecycle journal is authoritative on restart. */ }
            const result = await turn.result;
            await prisma.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "dispatching" }, data: { state: result.status, detail: result.error ?? null } });
          } catch {
            await prisma.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "dispatching" }, data: { state: "unknown", detail: "Delivery failed without a confirmed outcome. Inspect history before resolving." } }).catch(() => undefined);
          } finally { running.delete(receipt.id); }
        })();
      }
    }
  } finally { flushing.delete(runtime); }
}

export function startInstructionDelivery(prisma: PrismaClient, runtime: AgentSessionRuntime) {
  const tick = () => void deliverInstructions(prisma, runtime).catch(() => console.error("Instruction inbox reconciliation failed"));
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
