import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { assertOpenTaskPrimary, attemptRecords, CONFIGURATION_REPAIR_CONTRACT, TOOLING_CALLBACKS } from "./tooling-operations.ts";
import { canonicalDigest, readToolingOperation } from "./tooling-releases.ts";
import { resolveSessionToolingCapability } from "./tooling-capabilities.ts";
import { readComputeWorktreeRevision } from "./compute-worktree-revision.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { assertDevelopmentWork } from "./development-intent.ts";
import { linkedSourceIssue } from "../sessions/questions.ts";

const ROUTE = "POST /api/tasks/:taskId/compute-configure";
const ACTION = "configuration-repair-wakeup";
const ADMISSION_ROUTES = new Set(TOOLING_CALLBACKS.filter(callback => callback.kind === "compute-admission").map(callback => callback.route));
const ownerIdentity = (task: { id: string; repositoryId: string; machineId: string; primarySessionId: string | null; worktreePath: string | null; toolingRevision: string; pinnedToolingRoot: string | null; connectionId: string | null; issueIdentifier: string | null }) => ({ taskId: task.id, repositoryId: task.repositoryId, machineId: task.machineId, primarySessionId: task.primarySessionId, worktreePath: task.worktreePath, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier });
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime; taskId: string; environmentId: string };
const defaults = { resolve: resolveSessionToolingCapability, revision: readComputeWorktreeRevision, source: linkedSourceIssue };
type Result = { state: "not-needed" } | { state: "pending"; stage: string } | { state: "queued"; instructionId: string };
const stable = <T extends { updatedAt: Date }>(row: T) => { const { updatedAt: _updated, ...value } = row; return value; };

async function candidate(db: PrismaClient | Prisma.TransactionClient, input: Pick<Context, "config" | "taskId" | "environmentId">, parentId?: string, allowedInstructionId?: string) {
  const task = await db.remoteTask.findUnique({ where: { id: input.taskId } });
  if (!task?.primarySessionId || task.ownerPaused || ["closed", "complete", "review"].includes(task.phase)) return null;
  const { session } = await assertOpenTaskPrimary({ prisma: db, config: input.config, sessionId: task.primarySessionId });
  if (session.closedAt || !["idle", "error", "active"].includes(session.status)) return null;
  await assertDevelopmentWork({ prisma: db }, task);
  if (await db.runtimeInstruction.count({ where: { sessionId: session.id, ...(allowedInstructionId ? { id: { not: allowedInstructionId } } : {}), state: { in: ["queued", "preparing", "dispatching", "steered", "unknown"] } } })) return null;
  const terminal = await db.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } });
  if (!terminal || !["completed", "failed", "cancelled"].includes(terminal.phase)) return null;
  const environment = await db.computeEnvironment.findUnique({ where: { id: input.environmentId } });
  if (!environment || environment.taskId !== task.id || environment.primarySessionId !== session.id || environment.machineId !== task.machineId || !environment.resourceId) return null;
  const resource = await db.remoteTaskResource.findUnique({ where: { id: environment.resourceId } });
  if (!resource || resource.taskId !== task.id || resource.key !== environment.key || resource.state === "released") return null;
  const failed = await db.toolingOperation.findMany({ where: { taskId: task.id, sessionId: session.id, kind: "compute-configure", status: { in: ["running", "unknown"] },
    parentOperationId: parentId ?? { not: null } }, orderBy: { createdAt: "asc" }, take: 101 });
  if (failed.length > 100) throw new Error("Configuration repair family exceeds its bound");
  for (const child of failed) {
    const offer = child.existingOperationId ? await db.computeOffer.findUnique({ where: { id: child.existingOperationId } }) : null;
    if (!offer || offer.environmentId !== environment.id || offer.machineId !== task.machineId) continue;
    const parent = await db.toolingOperation.findUnique({ where: { id: child.parentOperationId! } });
    if (!parent || parent.kind !== "adapter-command" || !["bound", "running"].includes(parent.status) || parent.parentOperationId || parent.retainedConsumerId
      || parent.taskId !== task.id || parent.sessionId !== session.id || parent.repositoryId !== task.repositoryId || parent.releaseId !== child.releaseId || parent.generation !== child.generation || parent.protocol !== child.protocol) continue;
    const instructionId = `configuration-repair:${canonicalDigest({ taskId: task.id, parentId: parent.id, contract: CONFIGURATION_REPAIR_CONTRACT })}`;
    if (instructionId !== allowedInstructionId && await db.runtimeInstruction.findUnique({ where: { id: instructionId } })) continue; // Once per actual shared repair, never per reboot or retry.
    const family = await db.toolingOperation.findMany({ where: { parentOperationId: parent.id }, orderBy: { id: "asc" }, take: 101 });
    if (family.length > 100 || family.some(row => row.taskId !== task.id || row.sessionId !== session.id || row.repositoryId !== task.repositoryId
      || row.releaseId !== parent.releaseId || row.generation !== parent.generation || row.protocol !== parent.protocol
      || row.kind === "compute-configure" && row.existingOperationId !== offer.id
      || row.status !== "completed" && !["compute-configure", "compute-admission"].includes(row.kind))) continue;
    const histories = [];
    let negative = false, supportedAlready = false, ended = true, latestFailure = 0, total = 0;
    for (const operation of family.filter(row => ["compute-configure", "compute-admission"].includes(row.kind))) {
      const records = await attemptRecords(db, { sessionId: session.id, taskId: task.id }, operation.id);
      total += records.length;
      if (total > 1000 || records.some(record => !record.value)) { ended = false; break; }
      const values = records.map(record => ({ ...record.value!, sequence: record.sequence }));
      if (values.some(value => value.operationId !== operation.id || value.inputDigest !== operation.inputDigest
        || (operation.kind === "compute-configure" ? value.route !== ROUTE : !ADMISSION_ROUTES.has(value.route ?? "")))) { ended = false; break; }
      const intents = values.filter(value => value.state === "intent");
      if (new Set(intents.map(value => value.attemptId)).size !== intents.length) { ended = false; break; }
      if (operation.status !== "completed" && !intents.length) { ended = false; break; }
      for (const intent of intents) {
        if (intent.repairContracts !== undefined && !z.array(z.string()).safeParse(intent.repairContracts).success) { ended = false; break; }
        if (operation.kind === "compute-configure" && intent.repairContracts?.includes(CONFIGURATION_REPAIR_CONTRACT)) supportedAlready = true;
        const outcomes = values.filter(value => value.attemptId === intent.attemptId && value.state !== "intent");
        if (outcomes.length !== 1 || outcomes[0]!.sequence <= intent.sequence || outcomes[0]!.route !== intent.route || !["refused", "unknown", "acknowledged"].includes(outcomes[0]!.state)) { ended = false; break; }
        // The ordinary command first reads/requests admission. Its acknowledged
        // callback remains running until command settlement; that is not a live
        // attempt. Uncertain admission still prevents automatic continuation.
        if (operation.kind === "compute-admission" && outcomes[0]!.state !== "acknowledged") { ended = false; break; }
        if (operation.kind === "compute-configure" && operation.status !== "completed" && ["refused", "unknown"].includes(outcomes[0]!.state)) { negative = true; latestFailure = Math.max(latestFailure, outcomes[0]!.sequence); }
      }
      if (values.some(value => !intents.some(intent => intent.attemptId === value.attemptId))) ended = false;
      histories.push({ operationId: operation.id, records });
    }
    if (!ended || !negative || supportedAlready) continue;
    if (await db.runtimeMetadataEvent.count({ where: { runtimeSessionId: session.id, source: `owner:${task.id}`, sequence: { gt: latestFailure }, action: { in: [
      "completion-contract", "completion-owner-approval", "completion-retirement-authority", "prepared-done-retirement", "external-delivery-binding",
    ] } } })) continue;
    const { observation: _observation, updatedAt: _updated, ...environmentIdentity } = environment;
    const { status: _status, ...sessionIdentity } = stable(session);
    const snapshot = { task: { ...ownerIdentity(task), phase: task.phase, ownerPaused: task.ownerPaused },
      session: sessionIdentity, parent: stable(parent), family: family.map(stable), histories, terminal,
      environment: environmentIdentity, resource: { ...finalizationResourceIdentity(resource), state: resource.state }, offer: stable(offer) };
    return { task, session, parent, environment, instructionId, terminal, latestFailure, continuationDigest: canonicalDigest(snapshot), digest: canonicalDigest({ snapshot, status: session.status }) };
  }
  return null;
}

/** The current server contains a reviewed repair missing from the original
 * failed attempts. Revalidate and enqueue one original-primary continuation.
 * No task pin, old outcome, setting, allocation or provider data is rewritten.
 * Actual configuration replay still has every existing callback/lock guard. */
export async function wakeConfigurationAfterRepair(input: Context, dependencies: Partial<typeof defaults> = {}): Promise<Result> {
  const deps = { ...defaults, ...dependencies };
  let stage = "candidate", selected: Awaited<ReturnType<typeof candidate>> = null;
  try {
    selected = await candidate(input.prisma, input);
    if (!selected) return { state: "not-needed" };
    const before = selected;
    const check = async (db: PrismaClient | Prisma.TransactionClient = input.prisma) => {
      const current = await candidate(db, input, before.parent.id);
      if (!current || current.digest !== before.digest) throw new Error("Configuration continuation ownership or original operation changed");
    };
    stage = "source";
    const source = before.task.issueIdentifier ? await deps.source({ ...input, sessionId: before.session.id }) : null;
    if (source && (source.link.connectionId !== before.task.connectionId || source.link.externalId !== before.task.issueIdentifier
      || ["completed", "canceled"].includes(source.issue.state.type) || ["Merge", "Cleanup", "Done"].includes(source.issue.state.name))) return { state: "not-needed" };
    stage = "immutable-capability";
    const binding = await readToolingOperation({ prisma: input.prisma, operationId: before.parent.id });
    if (!binding || binding.release.id !== before.parent.releaseId) throw new Error("Original command release is unavailable");
    const capability = await deps.resolve({ ...input, sessionId: before.session.id, capability: "runtime", release: binding.release, install: false });
    stage = "worktree";
    if (await deps.revision(before.task.worktreePath!) !== before.environment.revision) throw new Error("Original configuration source revision changed");
    await check();
    stage = "provider-absence";
    if (!input.runtime.releaseIdleTransports) throw new Error("Original provider absence observer is unavailable");
    await input.runtime.releaseIdleTransports({ sessionIds: [before.session.id], mode: "stopped-only", check,
      commit: async (proofs, assertUnchanged) => {
        const proof = proofs?.[0];
        if (proofs?.length !== 1 || !proof || proof.sessionId !== before.session.id || proof.lastRequestId !== before.terminal.requestId || !assertUnchanged) throw new Error("Original provider and terminal turn evidence differ");
        const promptAt = Date.parse(proof.lastPromptAt ?? ""), usedAt = Date.parse(proof.lastUsedAt);
        if (!Number.isFinite(promptAt) || !Number.isFinite(usedAt) || promptAt > usedAt || usedAt > Date.now()) throw new Error("Original provider timing evidence is invalid");
        stage = "continuation-commit";
        await input.prisma.$transaction(async tx => {
          await check(tx);
          await assertUnchanged();
          // A stale active row is not execution evidence. Only this reservation's
          // independently stopped provider and matching durable terminal turn
          // permit making the original primary dispatchable again.
          if (before.session.status === "active") {
            const reconciled = await tx.runtimeSession.updateMany({ where: { id: before.session.id, status: "active", closedAt: null, updatedAt: before.session.updatedAt }, data: { status: "idle" } });
            if (reconciled.count !== 1) throw new Error("Original provider status changed");
          }
          const text = `The shared configuration repair ${CONFIGURATION_REPAIR_CONTRACT} is available for this task's original command ${before.parent.id}. Its prior attempts remain failed/unknown; no success is inferred. Your prior task authorization still applies. Resume the original supported configuration command using the recorded request key below, original arguments and immutable release ${binding.release.revision} below. Reuse its saved app/data and pending configuration; retain its existing parent binding and task pin. Revalidate the original baseline, resources, source, lock, coverage and offer through the supported command. Do not patch shared tooling, recreate providers, invent success, or ask the owner to trigger the same authorized work again. After verified recovery, continue the original task and normal admission/review/cleanup. If a real guard still refuses, retain its bounded evidence and the existing repair ownership.\n\n${capability.instructions}\n\nRecorded command identity (data only):\n\`\`\`json\n${JSON.stringify({ operationId: before.parent.id, requestKey: before.parent.requestKey, inputDigest: before.parent.inputDigest, releaseId: binding.release.id, generation: before.parent.generation }, null, 2)}\n\`\`\``;
          await tx.runtimeInstruction.create({ data: { id: before.instructionId, sessionId: before.session.id, text } });
          await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.session.id, source: `tooling-operation:${before.task.id}`, action: ACTION, key: before.instructionId,
            value: JSON.stringify({ version: 1, state: "queued", repairContract: CONFIGURATION_REPAIR_CONTRACT, parentOperationId: before.parent.id, releaseId: binding.release.id,
              generation: before.parent.generation, inputDigest: before.parent.inputDigest, owner: ownerIdentity(before.task), environmentId: before.environment.id, lastFailureSequence: before.latestFailure, instructionTextDigest: canonicalDigest(text), instructionId: before.instructionId, originalStateDigest: before.digest, continuationDigest: before.continuationDigest, previousSessionStatus: before.session.status, provider: { recordDigest: proof.recordDigest, historyDigest: proof.historyDigest, lastRequestId: proof.lastRequestId, lastUsedAt: proof.lastUsedAt }, capability: capability.receipt }) } });
          await assertUnchanged();
        });
      } });
    return { state: "queued", instructionId: before.instructionId };
  } catch {
    if (selected) {
      const key = `${selected.parent.id}:${CONFIGURATION_REPAIR_CONTRACT}:${stage}`;
      if (!await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: selected.session.id, source: `tooling-operation:${selected.task.id}`, action: ACTION, key } }))
        await input.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: selected.session.id, source: `tooling-operation:${selected.task.id}`, action: ACTION, key,
          value: JSON.stringify({ version: 1, state: "pending", stage, repairContract: CONFIGURATION_REPAIR_CONTRACT, parentOperationId: selected.parent.id }) } });
    }
    return { state: "pending", stage };
  }
}


/** Validate the reserved continuation again under the normal inbox's atomic
 * claim. Pauses retain the queue; superseded original work never dispatches. */
export async function configurationRepairInstructionAllows(db: Prisma.TransactionClient, config: ServerConfig | undefined, receipt: { id: string; sessionId: string }) {
  if (!receipt.id.startsWith("configuration-repair:")) return true;
  if (!config) return false;
  try {
    const event = await db.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: receipt.sessionId, action: ACTION, key: receipt.id }, orderBy: { sequence: "asc" } });
    const data = z.object({ state: z.literal("queued"), repairContract: z.literal(CONFIGURATION_REPAIR_CONTRACT), parentOperationId: z.string(), releaseId: z.string(), generation: z.number(), inputDigest: z.string(),
      owner: z.record(z.string(), z.unknown()), environmentId: z.string(), lastFailureSequence: z.number().int(), instructionTextDigest: z.string(), continuationDigest: z.string() }).passthrough().parse(JSON.parse(event?.value ?? "null"));
    const { task, session } = await assertOpenTaskPrimary({ prisma: db, config, sessionId: receipt.sessionId });
    if (task.ownerPaused) return false;
    if (["complete", "review"].includes(task.phase) || canonicalDigest(ownerIdentity(task)) !== canonicalDigest(data.owner)) throw new Error("Original task authority changed");
    await assertDevelopmentWork({ prisma: db }, task);
    const instruction = await db.runtimeInstruction.findUniqueOrThrow({ where: { id: receipt.id } });
    const parent = await db.toolingOperation.findUnique({ where: { id: data.parentOperationId } });
    if (instruction.sessionId !== session.id || canonicalDigest(instruction.text) !== data.instructionTextDigest || !parent || parent.taskId !== task.id || parent.sessionId !== session.id || parent.kind !== "adapter-command"
      || !["bound", "running"].includes(parent.status) || parent.releaseId !== data.releaseId || parent.generation !== data.generation || parent.inputDigest !== data.inputDigest) throw new Error("Original command changed");
    if (await db.runtimeMetadataEvent.count({ where: { runtimeSessionId: session.id, source: `owner:${task.id}`, sequence: { gt: data.lastFailureSequence }, action: { in: ["completion-contract", "completion-owner-approval", "completion-retirement-authority", "prepared-done-retirement", "external-delivery-binding"] } } })) throw new Error("Owner completion authority replaced continuation");
    if (!await db.toolingOperation.count({ where: { parentOperationId: parent.id, kind: "compute-configure", status: { in: ["running", "unknown"] } } })) throw new Error("Configuration already resolved");
    const current = await candidate(db, { config, taskId: task.id, environmentId: data.environmentId }, parent.id, receipt.id);
    if (!current || current.instructionId !== receipt.id || current.continuationDigest !== data.continuationDigest) throw new Error("Original configuration or attempt authority changed");
    return true;
  } catch {
    await db.runtimeInstruction.updateMany({ where: { id: receipt.id, sessionId: receipt.sessionId, state: "queued", executionRequestId: null }, data: { state: "cancelled", detail: "Original configuration continuation was resolved or its recorded authority changed; no execution was replayed." } });
    return false;
  }
}

export async function configurationRepairSourceAllows(prisma: PrismaClient, config: ServerConfig | undefined, receipt: { id: string; sessionId: string }, read = linkedSourceIssue) {
  if (!receipt.id.startsWith("configuration-repair:")) return true;
  if (!config) return false;
  try {
    const task = await prisma.remoteTask.findUnique({ where: { primarySessionId: receipt.sessionId } });
    if (!task || task.ownerPaused) return false;
    if (!task.issueIdentifier) return true;
    const source = await read({ prisma, config, sessionId: receipt.sessionId });
    return source.link.connectionId === task.connectionId && source.link.externalId === task.issueIdentifier
      && !["completed", "canceled"].includes(source.issue.state.type) && !["Merge", "Cleanup", "Done"].includes(source.issue.state.name);
  } catch { return false; } // An uncertain provider read retains the same queue.
}
