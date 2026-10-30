import { ensureTaskCleanupTransports } from "./cleanup-transport.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { queueInstruction } from "../sessions/inbox.ts";
import { cleanupCandidates } from "./cleanup-candidates.ts";
import { externalOwnerHistory, latestExternalBinding } from "./external-deliveries.ts";
import { resolveSessionToolingCapability } from "./tooling-capabilities.ts";

export const CLEANUP_INSTRUCTION = "finalization-cleanup-instruction";
export const CLEANUP_REQUEST = "finalization-cleanup-request";
export const CLEANUP_SUPERSEDED = "finalization-cleanup-superseded";
export const CleanupEnqueueInput = z.object({ requestKey: z.string().trim().min(1).max(180) }).strict();
export const AutomaticCleanup = z.object({ kind: z.literal("primary-inbox"), initialInstructionId: z.string() }).strict();
export type CleanupInboxStore = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeInstruction" | "runtimeMetadataEvent" | "runtimeLifecycleEvent" | "runtimeSessionResourceLink" | "runtimeSourceMessage">;
const Pending = ["preparing", "queued", "dispatching", "unknown"];
const MarkerIdentity = z.object({ version: z.literal(1), taskId: z.string(), sessionId: z.string(), requestKey: z.string(),
  worktree: z.string(), repositoryId: z.string(), machineId: z.string(), toolingRevision: z.string(), pinnedToolingRoot: z.string().nullable(),
  capability: z.object({ checkout: z.string(), adapter: z.string().nullable(), capabilityRevision: z.string(), taskToolingRevision: z.string() }).passthrough(),
}).strict();
const Marker = z.union([
  MarkerIdentity.extend({ contractRevision: z.number().int(), contractDigest: z.string() }).strict(),
  MarkerIdentity.extend({ externalBinding: z.object({ revision: z.number().int().positive(), digest: z.string(), ownerHistoryRevision: z.number().int().nonnegative() }).strict() }).strict(),
]);
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
  if ("externalBinding" in saved) {
    const event = await latestExternalBinding(store, task.id, saved.sessionId);
    if (!event || event.sequence !== saved.externalBinding.revision || hash(event.value ?? "") !== saved.externalBinding.digest
      || await externalOwnerHistory(store, task.id, saved.sessionId) !== saved.externalBinding.ownerHistoryRevision) throw new Error("Scheduled cleanup external acceptance changed");
    return task;
  }
  const contract = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: saved.sessionId, source: `owner:${task.id}`, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  if (!contract || contract.sequence !== saved.contractRevision || hash(contract.value ?? "") !== saved.contractDigest || JSON.parse(contract.value ?? "null")?.boundary !== "merge") throw new Error("Scheduled cleanup acceptance changed");
  return task;
}
async function family(store: CleanupInboxStore, task: RemoteTask) {
  return store.runtimeSession.findMany({ where: { cwd: task.worktreePath!, repositoryId: task.repositoryId, machineId: task.machineId } });
}

function cleanupCommand(saved: z.infer<typeof Marker>, resolved: Awaited<ReturnType<typeof resolveSessionToolingCapability>>, socket: string) {
  if (!resolved.receipt.adapter) throw new Error("Cleanup capability has no adapter");
  return [resolved.instructions, "", "Automatic cleanup continuation for this original primary.",
    `Use the same finalization identity ${saved.requestKey}. This scheduling instruction is not acceptance or cleanup proof.`,
    "First inspect current task activity. If another instruction or delegate needs work, stop this cleanup turn and allow the existing inbox to deliver it. Never cancel or acknowledge another instruction to make cleanup proceed.",
    `Run the existing lifecycle command using only the resolved immutable cleanup adapter: bun --no-env-file ${quote(resolved.receipt.adapter)} task destroy --task ${quote(saved.taskId)} --socket ${quote(socket)}.`,
    "The command validates accepted delivery, retention, ownership and pause locally. Do not hand-delete resources or replace the original pin. Report unresolved resources truthfully; interrupted cleanup resumes through the same command.",
  ].join("\n");
}

/** Replace only an unstarted synthetic instruction. Old instructions, markers,
 * request receipts and accepted cleanup authority remain immutable history. */
export async function refreshQueuedCleanupInstruction(input: { prisma: PrismaClient; runtime: AgentSessionRuntime; config: ServerConfig; receipt: { id: string; sessionId: string } }, dependencies = cleanupInboxDependencies) {
  const where = { runtimeSessionId: input.receipt.sessionId, source: "cleanup-inbox", action: CLEANUP_INSTRUCTION, key: input.receipt.id };
  const foundEvent = await input.prisma.runtimeMetadataEvent.findFirst({ where });
  if (!foundEvent) return true;
  const event = foundEvent;
  const instruction = await input.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: input.receipt.id } });
  if (instruction.state !== "queued" || instruction.sourceMessageId || instruction.executionRequestId) return false;
  const saved = Marker.parse(JSON.parse(event.value!)), original = JSON.stringify(instruction);
  if (saved.sessionId !== input.receipt.sessionId || instruction.sessionId !== saved.sessionId || saved.requestKey !== `finalize:${saved.taskId}`) throw new Error("Queued cleanup identity changed");
  const configured = () => hash(JSON.stringify({ machine: input.config.machine, installRoot: input.config.installRoot, socket: input.config.controlIpcPath,
    repository: input.config.repositories[saved.repositoryId] }));
  const configurationDigest = configured();
  async function eligible(store: CleanupInboxStore) {
    const task = await currentMarker(store, saved), sessions = await family(store, task), ids = pendingFamilyIds(task, sessions);
    const primary = sessions.find(session => session.id === saved.sessionId);
    if (!primary || primary.status !== "idle" || primary.role !== "primary" || sessions.some(session => !["idle", "closed"].includes(session.status)
      || input.runtime.observeSessionActivity && input.runtime.observeSessionActivity(session.id).state !== "unknown")) throw new Error("Queued cleanup waits for idle original work");
    if (await store.runtimeInstruction.count({ where: { sessionId: { in: ids }, id: { not: instruction.id }, state: { in: Pending } } })) throw new Error("Queued cleanup preserves pending original work");
    if (!(await cleanupCandidates(store as PrismaClient, input.config, [task])).has(task.id)) throw new Error("Queued cleanup acceptance changed");
    return task;
  }
  await currentMarker(input.prisma, saved);
  const resolved = structuredClone(await dependencies.capability({ prisma: input.prisma, config: input.config, sessionId: saved.sessionId, capability: "cleanup" }));
  const capability = resolved.receipt;
  if (!capability.adapter || capability.contract !== "remote-agent.tooling-capability/v1" || capability.capability !== "cleanup"
    || capability.source !== "configured-host" || capability.taskToolingRevision !== saved.toolingRevision
    || capability.capabilityRevision !== input.config.repositories[saved.repositoryId]?.tooling?.revision || configured() !== configurationDigest) throw new Error("Configured cleanup capability changed during resolution");
  const capabilityDigest = hash(JSON.stringify(capability));
  async function unchanged(store: CleanupInboxStore) {
    const current = await store.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } });
    const currentEvent = await store.runtimeMetadataEvent.findFirst({ where });
    if (JSON.stringify(current) !== original || currentEvent?.sequence !== event.sequence || currentEvent.value !== event.value) throw new Error("Queued cleanup changed during capability resolution");
    await eligible(store);
    if (configured() !== configurationDigest) throw new Error("Configured cleanup capability changed during resolution");
  }
  // Resolution may await checkout preparation. Even an unchanged adapter must
  // not return ready using a stale pause, instruction or acceptance snapshot.
  if (hash(JSON.stringify(Object.entries(capability).sort())) === hash(JSON.stringify(Object.entries(saved.capability).sort()))) {
    await unchanged(input.prisma); return true;
  }
  const next = Marker.parse({ ...saved, capability }), nextValue = JSON.stringify(next);
  const successorId = `cleanup:${hash(JSON.stringify({ previous: instruction.id, instruction: hash(original), marker: event.sequence, markerDigest: hash(event.value!), capabilityDigest }))}`;
  const text = cleanupCommand(next, resolved, input.config.controlIpcPath);
  return input.prisma.$transaction(async tx => {
    const current = await tx.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } });
    if (current.state !== "queued") return false; // Lost acknowledgment/concurrent winner: never add another successor.
    await unchanged(tx);
    const receipt = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: saved.sessionId, source: `task:${saved.taskId}`, action: "tooling-capability", key: `${saved.taskId}:${capabilityDigest}` } });
    if (configured() !== configurationDigest || receipt?.value !== JSON.stringify(capability)) throw new Error("Current cleanup capability receipt changed before refresh");
    const cancelled = await tx.runtimeInstruction.updateMany({ where: { id: instruction.id, state: "queued", updatedAt: instruction.updatedAt },
      data: { state: "cancelled", detail: `Superseded by cleanup instruction ${successorId} using reviewed tooling ${capability.capabilityRevision}; original command and authority are retained.` } });
    if (cancelled.count !== 1) throw new Error("Queued cleanup changed before supersession");
    await queueInstruction(tx, { sessionId: saved.sessionId, requestId: successorId, text });
    await tx.runtimeMetadataEvent.create({ data: { ...where, key: successorId, value: nextValue } });
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: saved.sessionId, source: "cleanup-inbox", action: CLEANUP_SUPERSEDED, key: instruction.id,
      value: JSON.stringify({ version: 1, taskId: saved.taskId, sessionId: saved.sessionId, requestKey: saved.requestKey,
        previous: { instructionId: instruction.id, instructionSha256: hash(original), markerRevision: event.sequence, markerSha256: hash(event.value!) },
        successor: { instructionId: successorId, textSha256: hash(text), markerSha256: hash(nextValue), capabilitySha256: capabilityDigest } }) } });
    return false; // The next normal inbox pass selects the new item.
  });
}

/** Upgrade an already queued cleanup instruction before opening its provider.
 * The exact immutable marker and still-queued row are rechecked at every held
 * transport effect and commit. No new scheduling request or instruction exists. */
export async function prepareQueuedCleanupTransport(input: { prisma: PrismaClient; runtime: AgentSessionRuntime; config?: ServerConfig; receipt: { id: string; sessionId: string } }) {
  const where = { runtimeSessionId: input.receipt.sessionId, source: "cleanup-inbox", action: CLEANUP_INSTRUCTION, key: input.receipt.id };
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where });
  if (!event) return true;
  if (!input.config) return false;
  if (!await refreshQueuedCleanupInstruction({ ...input, config: input.config })) return false;
  if (!input.runtime.releaseIdleTransports) return true;
  const saved = Marker.parse(JSON.parse(event.value!)), instruction = await input.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: input.receipt.id } });
  if (instruction.state !== "queued" || instruction.sessionId !== saved.sessionId || saved.sessionId !== input.receipt.sessionId) return false;
  const frozenInstruction = JSON.stringify(instruction);
  const check = async (prisma: PrismaClient) => {
    const currentEvent = await prisma.runtimeMetadataEvent.findFirst({ where });
    const currentInstruction = await prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } });
    if (currentEvent?.sequence !== event.sequence || currentEvent.value !== event.value || JSON.stringify(currentInstruction) !== frozenInstruction) throw new Error("Queued cleanup identity changed before provider transition");
    await currentMarker(prisma, saved);
  };
  await check(input.prisma);
  await ensureTaskCleanupTransports({ ...input, config: input.config, taskId: saved.taskId, queuedInstruction: { id: instruction.id, check } });
  await check(input.prisma);
  return true;
}

// Closed delegates cannot receive more work. Keep their uncertain delivery
// history intact; live runtime activity is still checked before cleanup effects.
function pendingFamilyIds(task: RemoteTask, sessions: Array<{ id: string; status: string; role: string | null }>) {
  return sessions.filter(session => session.id === task.primarySessionId || session.role !== "delegate" || session.status !== "closed").map(session => session.id);
}

/** An automatic request is a durable inbox instruction, never effect authority.
 * Its immutable capability is resolved outside the enqueue transaction. */
export async function enqueueTaskCleanup(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; requestKey: string; runtime?: AgentSessionRuntime }, dependencies = cleanupInboxDependencies) {
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
  if (input.runtime) await ensureTaskCleanupTransports({ ...input, runtime: input.runtime });
  const external = await latestExternalBinding(input.prisma, task.id, task.primarySessionId!);
  const contract = external ? null : await input.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { runtimeSessionId: task.primarySessionId!, source: `owner:${task.id}`, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  const acceptance = external ? { externalBinding: { revision: external.sequence, digest: hash(external.value ?? ""), ownerHistoryRevision: await externalOwnerHistory(input.prisma, task.id, task.primarySessionId!) } }
    : { contractRevision: contract!.sequence, contractDigest: hash(contract!.value ?? "") };
  const saved = Marker.parse({ version: 1, taskId: task.id, sessionId: task.primarySessionId!, requestKey: `finalize:${task.id}`,
    worktree: task.worktreePath, repositoryId: task.repositoryId, machineId: task.machineId, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot,
    ...acceptance, capability: resolved.receipt });
  const text = cleanupCommand(saved, resolved, input.config.controlIpcPath);
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
