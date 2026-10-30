import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { queueInstruction } from "../sessions/inbox.ts";
import { cleanupCandidates } from "./cleanup-candidates.ts";
import { resolveSessionToolingCapability } from "./tooling-capabilities.ts";

export const CLEANUP_INSTRUCTION = "finalization-cleanup-instruction";
export const CLEANUP_REQUEST = "finalization-cleanup-request";
export const CleanupEnqueueInput = z.object({ requestKey: z.string().trim().min(1).max(180) }).strict();
export const AutomaticCleanup = z.object({ kind: z.literal("primary-inbox"), initialInstructionId: z.string() }).strict();
export type CleanupInboxStore = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeInstruction" | "runtimeMetadataEvent" | "runtimeLifecycleEvent" | "runtimeSessionResourceLink" | "runtimeSourceMessage">;
const Pending = ["preparing", "queued", "dispatching", "unknown"];
const Marker = z.object({ version: z.literal(1), taskId: z.string(), sessionId: z.string(), requestKey: z.string(),
  worktree: z.string(), repositoryId: z.string(), machineId: z.string(), toolingRevision: z.string(), pinnedToolingRoot: z.string().nullable(),
  contractRevision: z.number().int(), contractDigest: z.string(), capability: z.object({ checkout: z.string(), adapter: z.string().nullable(), capabilityRevision: z.string(), taskToolingRevision: z.string() }).passthrough(),
}).strict();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
export const cleanupInboxDependencies = { capability: resolveSessionToolingCapability };

async function marker(store: CleanupInboxStore, instructionId: string, sessionId: string) {
  const event = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source: "cleanup-inbox", action: CLEANUP_INSTRUCTION, key: instructionId } });
  return event ? Marker.parse(JSON.parse(event.value!)) : null;
}
async function currentMarker(store: CleanupInboxStore, saved: z.infer<typeof Marker>) {
  const task = await store.remoteTask.findUniqueOrThrow({ where: { id: saved.taskId } });
  if (task.primarySessionId !== saved.sessionId || task.worktreePath !== saved.worktree || task.repositoryId !== saved.repositoryId || task.machineId !== saved.machineId
    || task.toolingRevision !== saved.toolingRevision || task.pinnedToolingRoot !== saved.pinnedToolingRoot || task.ownerPaused || task.phase === "closed") throw new Error("Scheduled cleanup original ownership changed or is paused");
  const contract = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: saved.sessionId, source: `owner:${task.id}`, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  if (!contract || contract.sequence !== saved.contractRevision || hash(contract.value ?? "") !== saved.contractDigest || JSON.parse(contract.value ?? "null")?.boundary !== "merge") throw new Error("Scheduled cleanup acceptance changed");
  return task;
}
async function family(store: CleanupInboxStore, task: RemoteTask) {
  return store.runtimeSession.findMany({ where: { cwd: task.worktreePath!, repositoryId: task.repositoryId, machineId: task.machineId } });
}

// Closed delegates cannot receive more work. Keep their uncertain delivery
// history intact; live runtime activity is still checked before cleanup effects.
function pendingFamilyIds(task: RemoteTask, sessions: Array<{ id: string; status: string; role: string | null }>) {
  return sessions.filter(session => session.id === task.primarySessionId || session.role !== "delegate" || session.status !== "closed").map(session => session.id);
}

/** An automatic request is a durable inbox instruction, never effect authority.
 * Its immutable capability is resolved outside the enqueue transaction. */
export async function enqueueTaskCleanup(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; requestKey: string }, dependencies = cleanupInboxDependencies) {
  CleanupEnqueueInput.parse({ requestKey: input.requestKey });
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const requestWhere = { runtimeSessionId: task.primarySessionId!, source: `finalizer:${task.id}`, action: CLEANUP_REQUEST, key: input.requestKey };
  const prior = task.primarySessionId && await input.prisma.runtimeMetadataEvent.findFirst({ where: requestWhere });
  const result = async (store: CleanupInboxStore, instructionId: string) => {
    const instruction = await store.runtimeInstruction.findUniqueOrThrow({ where: { id: instructionId } });
    if (instruction.sessionId !== task.primarySessionId) throw new Error("Cleanup request changed primary");
    return { taskId: task.id, sessionId: instruction.sessionId, instructionId: instruction.id, state: instruction.state, queued: true as const };
  };
  if (prior) return result(input.prisma, JSON.parse(prior.value!).instructionId);
  if (!(await cleanupCandidates(input.prisma, input.config, [task])).has(task.id)) throw new Error("Task has no current accepted cleanup scheduling candidate");
  const resolved = await dependencies.capability({ prisma: input.prisma, config: input.config, sessionId: task.primarySessionId!, capability: "cleanup" });
  if (!resolved.receipt.adapter || resolved.receipt.capability !== "cleanup" || resolved.receipt.taskToolingRevision !== task.toolingRevision) throw new Error("Configured cleanup capability has no exact adapter");
  const contract = await input.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { runtimeSessionId: task.primarySessionId!, source: `owner:${task.id}`, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  const saved = Marker.parse({ version: 1, taskId: task.id, sessionId: task.primarySessionId!, requestKey: `finalize:${task.id}`,
    worktree: task.worktreePath, repositoryId: task.repositoryId, machineId: task.machineId, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot,
    contractRevision: contract.sequence, contractDigest: hash(contract.value ?? ""), capability: resolved.receipt });
  const text = [resolved.instructions, "", "Automatic cleanup continuation for this original primary.",
    `Use the same finalization identity ${saved.requestKey}. This scheduling instruction is not acceptance or cleanup proof.`,
    "First inspect current task activity. If another instruction or delegate needs work, stop this cleanup turn and allow the existing inbox to deliver it. Never cancel or acknowledge another instruction to make cleanup proceed.",
    `Run the existing lifecycle command using only the resolved immutable cleanup adapter: bun --no-env-file ${quote(resolved.receipt.adapter)} task destroy --task ${quote(task.id)} --socket ${quote(input.config.controlIpcPath)}.`,
    "The command validates accepted delivery, retention, ownership and pause locally. Do not hand-delete resources or replace the original pin. Report unresolved resources truthfully; interrupted cleanup resumes through the same command.",
  ].join("\n");
  return input.prisma.$transaction(async tx => {
    await currentMarker(tx, saved);
    if (!(await cleanupCandidates(tx as PrismaClient, input.config, [await tx.remoteTask.findUniqueOrThrow({ where: { id: task.id } })])).has(task.id)) throw new Error("Cleanup scheduling authority changed during capability resolution");
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where: requestWhere });
    if (duplicate) return result(tx, JSON.parse(duplicate.value!).instructionId);
    const existing = await tx.runtimeInstruction.findMany({ where: { sessionId: task.primarySessionId!, state: { in: Pending } }, orderBy: { sequence: "asc" } });
    let instructionId: string | undefined;
    for (const instruction of existing) if (await marker(tx, instruction.id, instruction.sessionId)) { instructionId = instruction.id; break; }
    if (!instructionId) {
      instructionId = `cleanup:${hash(`${task.id}:${input.requestKey}`)}`;
      await queueInstruction(tx, { sessionId: task.primarySessionId!, requestId: instructionId, text });
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: task.primarySessionId!, source: "cleanup-inbox", action: CLEANUP_INSTRUCTION, key: instructionId, value: JSON.stringify(saved) } });
    }
    await tx.runtimeMetadataEvent.create({ data: { ...requestWhere, value: JSON.stringify({ instructionId }) } });
    return result(tx, instructionId);
  });
}

/** Used inside the existing inbox claim transaction. Only this synthetic
 * cleanup instruction is cancelled when genuine queued work takes precedence. */
export async function cleanupInstructionAllows(store: CleanupInboxStore, receipt: { id: string; sessionId: string }) {
  const saved = await marker(store, receipt.id, receipt.sessionId);
  if (!saved) {
    // A delegate's existing inbox claim cannot cross a running automatic
    // cleanup turn. The queued instruction itself is retained for next drain.
    const session = await store.runtimeSession.findUnique({ where: { id: receipt.sessionId } });
    const task = session && await store.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
    if (task?.primarySessionId && receipt.sessionId !== task.primarySessionId && task.repositoryId === session!.repositoryId && task.machineId === session!.machineId) {
      const active = await store.runtimeInstruction.findMany({ where: { sessionId: task.primarySessionId, state: "dispatching" } });
      for (const instruction of active) if (await marker(store, instruction.id, instruction.sessionId)) return false;
    }
    return true;
  }
  let task: RemoteTask;
  try { task = await currentMarker(store, saved); }
  catch {
    await store.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "queued" }, data: { state: "cancelled", detail: "Scheduled cleanup ownership or accepted delivery changed; no cleanup effects ran." } });
    return false;
  }
  const sessions = await family(store, task), ids = pendingFamilyIds(task, sessions);
  const pending = await store.runtimeInstruction.findMany({ where: { sessionId: { in: ids }, id: { not: receipt.id }, state: { in: Pending } } });
  if (pending.some(instruction => instruction.sessionId === receipt.sessionId)) {
    await store.runtimeInstruction.updateMany({ where: { id: receipt.id, state: "queued" }, data: { state: "cancelled", detail: "Cleanup deferred to another original-primary instruction; that instruction is preserved." } });
    return false;
  }
  return !pending.length && !sessions.some(session => session.id !== task.primarySessionId && !["idle", "closed"].includes(session.status));
}

/** Exact started-turn correlation is durable; live runtime observation is
 * checked when the request supplies it. Missing/terminal correlation is never
 * converted into permission for a manual retry of an automatic operation. */
export async function automaticCleanupTurn(store: CleanupInboxStore, task: RemoteTask, required = false, runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">) {
  const instructions = await store.runtimeInstruction.findMany({ where: { sessionId: task.primarySessionId!, state: "dispatching" } });
  const selected = [];
  for (const instruction of instructions) if (await marker(store, instruction.id, instruction.sessionId)) selected.push(instruction);
  if (!selected.length && !required) return undefined;
  if (selected.length !== 1) throw new Error("Automatic cleanup requires its exact executing original-primary instruction");
  const instruction = selected[0]!, saved = (await marker(store, instruction.id, instruction.sessionId))!;
  await currentMarker(store, saved);
  const turn = await store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: instruction.sessionId }, orderBy: { sequence: "desc" } });
  if (!instruction.executionRequestId || turn?.requestId !== instruction.executionRequestId || turn.phase !== "started") throw new Error("Automatic cleanup turn correlation is unavailable or terminal");
  if (runtime) {
    const observed = runtime.observeSessionActivity?.(instruction.sessionId);
    if (observed?.state !== "executing" || observed.requestId !== instruction.executionRequestId) throw new Error("Automatic cleanup is not the current executing turn");
  }
  const sessions = await family(store, task), ids = pendingFamilyIds(task, sessions);
  if (await store.runtimeInstruction.count({ where: { sessionId: { in: ids }, id: { not: instruction.id }, state: { in: Pending } } })) throw new Error("Automatic cleanup yields to pending task instructions");
  if (sessions.some(session => session.id !== task.primarySessionId && !["idle", "closed"].includes(session.status)
    || session.id !== task.primarySessionId && runtime?.observeSessionActivity && runtime.observeSessionActivity(session.id).state !== "unknown")) throw new Error("Automatic cleanup yields to active delegates");
  return AutomaticCleanup.parse({ kind: "primary-inbox", initialInstructionId: instruction.id });
}
