import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { isCurrentMergeApproval } from "../tasks/completion.ts";
import { bindSourceTurn, sourceReplyInstructions } from "./source-messages.ts";
import { deliverMessageControls } from "./message-controls.ts";
import type { ServerConfig } from "../../../../lib/config.ts";

const active = new WeakMap<AgentSessionRuntime, Set<string>>();
const flushing = new WeakSet<AgentSessionRuntime>();

type InboxStore = Pick<PrismaClient, "remoteTask" | "runtimeInstruction" | "runtimeSession" | "runtimeSessionRelation" | "runtimeMetadataEvent">;

async function taskInstruction(store: InboxStore, taskId: string, instructionId: string) {
  const task = await store.remoteTask.findUnique({ where: { id: taskId } });
  if (!task?.primarySessionId || !task.worktreePath) throw new Error("Task has no primary session or worktree");
  const instruction = await store.runtimeInstruction.findUnique({ where: { id: instructionId } });
  const session = instruction && await store.runtimeSession.findUnique({ where: { id: instruction.sessionId } });
  if (!instruction || !session || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) {
    throw new Error("Instruction does not belong to this task");
  }
  if (session.id !== task.primarySessionId) {
    const relation = session.role === "delegate" && await store.runtimeSessionRelation.findFirst({ where: {
      sourceSessionId: session.id, targetSessionId: task.primarySessionId, relationship: "spawned-by", endedAt: null,
    } });
    if (!relation) throw new Error("Instruction is not owned by this task's primary or delegate");
  }
  return { task, instruction, session };
}

/** A human's explicit outcome decision is durable separately from delivery
 * state, so a lost HTTP response cannot authorize another retry after dispatch. */
export async function resolveTaskInstruction(prisma: PrismaClient, runtime: AgentSessionRuntime, input: {
  taskId: string; instructionId: string; action: "acknowledge" | "cancel" | "retry"; reason: string; requestKey?: string;
}) {
  const key = input.instructionId;
  const source = `task-supervisor:${input.taskId}`;
  const value = JSON.stringify({ requestKey: input.requestKey ?? null, action: input.action, reason: input.reason });
  const auditWhere = { action: "instruction-resolved", key, source };
  const inspect = async (store: InboxStore) => {
    const owned = await taskInstruction(store, input.taskId, input.instructionId);
    const decisions = await store.runtimeMetadataEvent.findMany({ where: { ...auditWhere, runtimeSessionId: owned.session.id } });
    const prior = decisions.find((decision) => JSON.parse(decision.value!).requestKey === (input.requestKey ?? null));
    if (prior) {
      if (prior.value !== value) throw new Error("Resolution request key already belongs to another decision");
      return { ...owned, resolved: true };
    }
    if (owned.task.phase === "closed" || owned.session.status === "closed") throw new Error("Task or session is closed");
    if (input.action === "retry" && owned.task.ownerPaused) throw new Error("Resume the owner-paused task before retrying an instruction");
    if (owned.instruction.state !== "unknown") throw new Error("Instruction is not awaiting resolution");
    return { ...owned, resolved: false };
  };
  const first = await inspect(prisma);
  if (first.resolved) return { resolved: true as const };
  if (!runtime.reconcileInterruptedSession) throw new Error("Runtime cannot verify interrupted provider liveness");
  await runtime.reconcileInterruptedSession(first.session.id);
  await prisma.$transaction(async (tx) => {
    const current = await inspect(tx);
    if (current.resolved) return;
    const changed = await tx.runtimeInstruction.updateMany({
      where: { id: input.instructionId, sessionId: current.session.id, state: "unknown", updatedAt: current.instruction.updatedAt },
      data: { state: { acknowledge: "acknowledged", cancel: "cancelled", retry: "queued" }[input.action], detail: input.reason },
    });
    if (!changed.count) throw new Error("Instruction changed during resolution; inspect and retry");
    if (current.instruction.sourceMessageId) {
      await tx.runtimeSourceMessage.update({ where: { id: current.instruction.sourceMessageId }, data: {
        state: { retry: "queued", acknowledge: "handled", cancel: "attention" }[input.action], detail: input.reason, projectionPending: true,
      } });
      await tx.runtimeMessageControl.updateMany({ where: { sourceMessageId: current.instruction.sourceMessageId, state: "unknown" }, data: { state: "resolved", detail: input.reason } });
    }
    await tx.runtimeMetadataEvent.create({ data: { ...auditWhere, runtimeSessionId: current.session.id, value } });
  });
  return { resolved: true as const };
}

async function instructionRequestId(prisma: PrismaClient, receipt: { id: string; sessionId: string }) {
  const decisions = await prisma.runtimeMetadataEvent.findMany({ where: {
    runtimeSessionId: receipt.sessionId, action: "instruction-resolved", key: receipt.id,
  }, orderBy: { sequence: "desc" } });
  const retry = decisions.find((decision) => JSON.parse(decision.value!).action === "retry");
  // Each explicitly authorized attempt gets its own lifecycle identity. A late
  // terminal event from the interrupted attempt cannot settle its replacement.
  return retry ? `${receipt.id}:retry:${retry.sequence}` : receipt.id;
}

async function instructionAuthorityAllows(prisma: Pick<PrismaClient, "runtimeMetadataEvent" | "remoteTask" | "runtimeInstruction">, receipt: { id: string; sessionId: string }) {
  const dispatch = await prisma.runtimeMetadataEvent.findFirst({ where: {
    runtimeSessionId: receipt.sessionId, action: "workflow-dispatch", key: receipt.id,
  }, orderBy: { sequence: "desc" } });
  if (!dispatch) return true;
  const saved = JSON.parse(dispatch.value ?? "null");
  if (saved?.state !== "Merge") return true;
  const task = typeof saved.taskId === "string" && await prisma.remoteTask.findUnique({ where: { id: saved.taskId } });
  const approval = saved.completionApproval;
  if (task && task.primarySessionId === receipt.sessionId && typeof approval?.requestKey === "string" && Number.isSafeInteger(approval.contractRevision)
    && await isCurrentMergeApproval(prisma, { taskId: task.id, sessionId: receipt.sessionId, approval })) return true;
  await prisma.runtimeInstruction.updateMany({ where: { id: receipt.id, sessionId: receipt.sessionId, state: "queued" },
    data: { state: "cancelled", detail: "Owner merge authority was revoked, replaced or is unverified; this instruction will not replay." } });
  return false;
}

export async function queueInstruction(prisma: Pick<PrismaClient, "runtimeInstruction" | "runtimeSourceMessage">, input: { sessionId: string; text: string; requestId?: string; sourceMessageId?: string }) {
  const id = input.requestId ?? randomUUID();
  const receipt = await prisma.runtimeInstruction.upsert({ where: { id }, update: {}, create: { id, sessionId: input.sessionId, text: input.text, sourceMessageId: input.sourceMessageId } });
  if (receipt.sessionId !== input.sessionId || receipt.text !== input.text) throw new Error("Instruction request ID already belongs to another instruction");
  if (input.sourceMessageId && receipt.sourceMessageId && receipt.sourceMessageId !== input.sourceMessageId) throw new Error("Instruction already belongs to another source message");
  if (input.sourceMessageId && !receipt.sourceMessageId) await prisma.runtimeInstruction.updateMany({ where: { id, sourceMessageId: null }, data: { sourceMessageId: input.sourceMessageId } });
  if (input.sourceMessageId) {
    const source = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: input.sourceMessageId } });
    if (source.sessionId && source.sessionId !== input.sessionId) throw new Error("Source message already belongs to another primary");
    if (!source.sessionId && source.state !== "routing") throw new Error("Source message already has a routing outcome; refusing a new instruction");
    const state = { completed: "handled", failed: "failed", unknown: "unknown", dispatching: "unknown", cancelled: "attention", acknowledged: "handled", steered: "processing" }[receipt.state] ?? "queued";
    await prisma.runtimeSourceMessage.updateMany({ where: { id: source.id, state: "routing" }, data: { sessionId: input.sessionId, state,
      ...(receipt.state !== "queued" ? { requestId: receipt.executionRequestId ?? receipt.id } : {}), projectionPending: true } });
  }
  return receipt;
}

async function sourceAuthorityAllows(prisma: PrismaClient, config: ServerConfig | undefined, receipt: { id: string; sourceMessageId: string | null }) {
  if (!receipt.sourceMessageId || !config) return true;
  try {
    const { tracker } = await import("../../integrations/tracker/port.ts");
    const source = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: receipt.sourceMessageId } });
    if (tracker.sourceMessages.provider !== source.provider) return false;
    await tracker.sourceMessages.validateOwner(config, prisma, source);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "source_ownership_revoked") {
      await prisma.$transaction(async (tx) => {
        const denied = await tx.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "queued" }, data: { state: "failed", detail: "Source-message ownership is no longer valid" } });
        if (denied.count) await tx.runtimeSourceMessage.update({ where: { id: receipt.sourceMessageId! }, data: { state: "failed", projectionPending: true } });
      });
    }
    return false;
  }
}

/** Called only by the daemon that owns the runtime. A claimed instruction
 * without a terminal journal entry after restart stays unknown, not replayed. */
export async function deliverInstructions(prisma: PrismaClient, runtime: AgentSessionRuntime, config?: ServerConfig) {
  if (flushing.has(runtime)) return;
  flushing.add(runtime);
  const running = active.get(runtime) ?? new Set<string>();
  active.set(runtime, running);
  try {
    const unsettled = await prisma.runtimeInstruction.findMany({ where: { state: { in: ["dispatching", "unknown"] } } });
    for (const receipt of unsettled) {
      if (running.has(receipt.id)) continue;
      const requestId = await instructionRequestId(prisma, receipt);
      const event = await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: receipt.sessionId, requestId, phase: { in: ["completed", "cancelled", "failed"] } }, orderBy: { sequence: "desc" } });
      if (!event && receipt.state === "unknown") continue; // Keep its original uncertainty timestamp and evidence.
      await prisma.$transaction(async (tx) => {
      const settled = await tx.runtimeInstruction.updateMany({ where: { id: receipt.id, state: receipt.state, updatedAt: receipt.updatedAt }, data: event
        ? { state: event.phase, detail: event.error }
        : { state: "unknown", detail: "Delivery was interrupted. Inspect session history before resolving; automatic replay is disabled." } });
      if (settled.count && receipt.sourceMessageId) await tx.runtimeSourceMessage.updateMany({ where: { id: receipt.sourceMessageId }, data: { state: event ? { completed: "handled", failed: "failed", cancelled: "attention" }[event.phase] : "unknown", projectionPending: true } });
      });
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
          await prisma.$transaction(async (tx) => {
            const failed = await tx.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "queued" }, data: { state: "failed", detail: "Session is unavailable or closed" } });
            if (failed.count && receipt.sourceMessageId) await tx.runtimeSourceMessage.update({ where: { id: receipt.sourceMessageId }, data: {
              state: "failed", detail: "Session is unavailable or closed", projectionPending: true,
            } });
          });
          continue;
        }
        if (session.status === "active" || session.status === "provisioning") continue;
        const task = await prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
        if (task && (task.ownerPaused || task.phase === "closed")) continue;
        if (!(await instructionAuthorityAllows(prisma, receipt))) continue;
        const requestId = await instructionRequestId(prisma, receipt);
        running.add(receipt.id);
        void (async () => {
          try {
            const turn = runtime.startTurn({ sessionId: receipt.sessionId, requestId, text: receipt.text + (receipt.sourceMessageId ? sourceReplyInstructions(receipt.sourceMessageId) : ""), beforeStart: async () => {
              if (!(await sourceAuthorityAllows(prisma, config, receipt))) return false;
              return prisma.$transaction(async (tx) => {
              const currentTask = await tx.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
              if (currentTask && (currentTask.ownerPaused || currentTask.phase === "closed")) return false;
              if (!(await instructionAuthorityAllows(tx, receipt))) return false;
              const claim = await tx.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "queued" }, data: { state: "dispatching", detail: null, executionRequestId: requestId } });
              if (claim.count && receipt.sourceMessageId) await bindSourceTurn(tx, receipt.sourceMessageId, receipt.sessionId, requestId);
              return claim.count > 0;
            });
            } });
            for await (const _ of turn.events) { /* Persisted lifecycle journal is authoritative on restart. */ }
            const result = await turn.result;
            const settled = await prisma.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "dispatching" }, data: { state: result.status, detail: result.error ?? null } });
            if (settled.count && receipt.sourceMessageId) await prisma.runtimeSourceMessage.update({ where: { id: receipt.sourceMessageId }, data: { state: { completed: "handled", failed: "failed", cancelled: "attention" }[result.status], projectionPending: true } });
          } catch {
            const uncertain = await prisma.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "dispatching" }, data: { state: "unknown", detail: "Delivery failed without a confirmed outcome. Inspect history before resolving." } }).catch(() => undefined);
            if (uncertain?.count && receipt.sourceMessageId) await prisma.runtimeSourceMessage.update({ where: { id: receipt.sourceMessageId }, data: { state: "unknown", projectionPending: true } }).catch(() => undefined);
          } finally { running.delete(receipt.id); }
        })();
      }
    }
  } finally { flushing.delete(runtime); }
}

export function startInstructionDelivery(prisma: PrismaClient, runtime: AgentSessionRuntime, config: ServerConfig) {
  const tick = () => void deliverMessageControls(prisma, runtime, async (message) => {
    const { tracker } = await import("../../integrations/tracker/port.ts");
    if (tracker.sourceMessages.provider !== message.provider) throw new Error("Source integration is unavailable");
    return tracker.sourceMessages.validateOwner(config, prisma, message);
  }).then(() => deliverInstructions(prisma, runtime, config)).catch(() => console.error("Instruction inbox reconciliation failed"));
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
