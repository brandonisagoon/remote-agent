import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import type { FinalizationContext } from "./finalization-receipts.ts";
import { automaticCleanupTurn } from "./cleanup-inbox.ts";
import { assertPreparedCleanup, hasPreparedCleanup } from "./cleanup-lifecycle.ts";
import { retirementDigest } from "./retirement-receipts.ts";
import { preparationStage, withPreparationDiagnostics } from "./preparation-diagnostics.ts";
import { PreparationFailure, preparationFailure } from "./preparation-errors.ts";

export const PreparationAttempt = z.object({ version: z.literal(1), attemptId: z.uuid(), boundary: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,119}$/) }).strict();
export type PreparationAttempt = z.infer<typeof PreparationAttempt>;
const ACCEPTED = "finalization-preparation-accepted", STATUS = "finalization-preparation-status", ALIAS = "finalization-preparation-request";
const source = (taskId: string) => `preparation:${taskId}`;
const Input = z.object({ requestKey: z.string(), cleanup: z.literal(true), finalizationVersion: z.literal(2).optional() }).strict();
const Accepted = z.object({ version: z.literal(1), taskId: z.string(), sessionId: z.string(), input: Input, attempt: PreparationAttempt, epoch: z.string(), acceptedAt: z.string() }).strict();
const State = z.object({ state: z.enum(["pending", "running", "ready", "failed"]), stage: z.string(), event: z.enum(["start", "end"]).optional(), activeStage: z.string().nullable().optional(), outcome: z.enum(["succeeded", "failed"]).optional(), failedStage: z.string().optional(), diagnostic: PreparationFailure.optional(), worker: z.string().optional(), elapsedMs: z.number().optional(), result: z.unknown().optional(), error: z.string().optional(), retryable: z.boolean().optional() }).strict();
type Context = FinalizationContext & { cleanup: true };
type WorkerInput = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime };
const execution = new AsyncLocalStorage<{ sessionId: string; requestKey: string }>();
const fullScans = new WeakMap<PrismaClient, Map<string, "synchronous" | "journal">>();
const executionKey = (input: FinalizationContext) => input.sessionId;
const activeWorkers = new WeakMap<PrismaClient, { tick(): void; stop(): Promise<void> }>();

/** Local receipt/turn checks only. Acceptance is scheduling, never authority. */
async function epoch(input: Context) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  if (input.requestKey !== `finalize:${task.id}` || task.ownerPaused || task.phase === "closed" || session.status === "closed" || session.role !== "primary"
    || task.machineId !== input.config.machine || session.machineId !== task.machineId || session.repositoryId !== task.repositoryId || session.cwd !== task.worktreePath) throw new Error("Preparation original task ownership changed, paused or closed");
  await automaticCleanupTurn(input.prisma, task, false, input.runtime);
  if (await hasPreparedCleanup(input.prisma, task.id, session.id, input.requestKey)) await assertPreparedCleanup(input);
  const turn = await input.prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } });
  const owners = await input.prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: session.id, source: `owner:${task.id}` }, orderBy: { sequence: "asc" } });
  const resources = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id }, orderBy: { id: "asc" } });
  const stableResources = resources.map(({ createdAt: _created, updatedAt: _updated, metadata, ...resource }) => {
    let stable: unknown = metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const { observed: _observed, observedAt: _at, ...fields } = metadata as Record<string, unknown>;
      stable = fields;
    }
    return { ...resource, expiresAt: resource.expiresAt?.toISOString() ?? null, metadata: stable };
  });
  return { task, digest: retirementDigest({ task: [task.id, task.primarySessionId, task.repositoryId, task.machineId, task.connectionId, task.issueIdentifier, task.branchName, task.worktreePath, task.baseCommit, task.toolingRoot, task.toolingRevision, task.pinnedToolingRoot],
    repositoryRoot: getRepositoryConfig(input.config, task.repositoryId).root, session: [session.id, session.role, session.cwd, session.repositoryId, session.machineId], turn: turn && [turn.sequence, turn.requestId, turn.phase],
    owners: owners.map(event => [event.sequence, event.action, event.key, event.value]), resources: stableResources }) };
}
async function latest(prisma: PrismaClient, accepted: { sequence: number; runtimeSessionId: string; source: string }) {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: accepted.runtimeSessionId, source: accepted.source, action: STATUS, key: String(accepted.sequence) }, orderBy: { sequence: "desc" } });
  return event ? State.parse(JSON.parse(event.value!)) : { state: "pending" as const, stage: "queued" };
}
async function unsettled(prisma: PrismaClient, sessionId: string | null = null, limit = 2000) {
  const pending = await prisma.$queryRaw<Array<{ sequence: number }>>`
    SELECT a.sequence FROM RuntimeMetadataEvent a
    WHERE a.action = ${ACCEPTED} AND (${sessionId} IS NULL OR a.runtimeSessionId = ${sessionId}) AND NOT EXISTS (
      SELECT 1 FROM RuntimeMetadataEvent s WHERE s.action = ${STATUS}
      AND s.runtimeSessionId = a.runtimeSessionId AND s.source = a.source AND s.key = CAST(a.sequence AS TEXT)
      AND json_extract(s.value, '$.state') IN ('ready', 'failed'))
    ORDER BY a.sequence ASC LIMIT ${limit}`;
  return pending.length ? prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: pending.map(row => row.sequence) } }, orderBy: { sequence: "asc" } }) : [];
}
async function append(input: WorkerInput, accepted: { sequence: number; runtimeSessionId: string; source: string }, value: z.infer<typeof State>) {
  return input.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: accepted.runtimeSessionId, source: accepted.source, action: STATUS, key: String(accepted.sequence), value: JSON.stringify(value) } });
}

/** Same-attempt retries join durable work. A different boundary never replays a
 * completed observation; active scans are serialized by the existing worker. */
export async function requestFinalizationPreparation(input: Context, attempt: PreparationAttempt, hooks: { afterAcceptanceGuard?: () => Promise<void> } = {}) {
  const responseStarted = performance.now();
  let freshRequest = false;
  PreparationAttempt.parse(attempt);
  if (fullScans.get(input.prisma)?.get(executionKey(input)) === "synchronous") throw new Error("Full preparation is already running synchronously; retry after it finishes");
  const observed = await epoch(input);
  await hooks.afterAcceptanceGuard?.();
  const accepted = await input.prisma.$transaction(async tx => {
    const aliasWhere = { runtimeSessionId: input.sessionId, source: source(observed.task.id), action: ALIAS, key: attempt.attemptId };
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: aliasWhere });
    if (prior) {
      const alias = JSON.parse(prior.value!);
      if (retirementDigest(alias.attempt) !== retirementDigest(attempt)) throw new Error("Preparation attempt belongs to another boundary");
      return tx.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: alias.acceptedRevision } });
    }
    freshRequest = true;
    const all = await unsettled(tx as PrismaClient, input.sessionId);
    if (all.length >= 2000) throw new Error("Too many pending preparation boundaries; finish existing attempts first");
    let joined: typeof all[number] | undefined;
    for (const candidate of all) {
      const saved = Accepted.parse(JSON.parse(candidate.value!));
      if (saved.attempt.boundary !== attempt.boundary || saved.epoch !== observed.digest || retirementDigest(saved.input) !== retirementDigest({ requestKey: input.requestKey, cleanup: true, ...(input.finalizationVersion ? { finalizationVersion: input.finalizationVersion } : {}) })) continue;
      const state = await latest(tx as PrismaClient, candidate);
      if (state.state === "pending" || state.state === "running") { joined = candidate; break; }
    }
    const record = joined ?? await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: input.sessionId, source: aliasWhere.source, action: ACCEPTED, key: attempt.attemptId,
      value: JSON.stringify(Accepted.parse({ version: 1, taskId: observed.task.id, sessionId: input.sessionId, input: { requestKey: input.requestKey, cleanup: true, ...(input.finalizationVersion ? { finalizationVersion: input.finalizationVersion } : {}) }, attempt, epoch: observed.digest, acceptedAt: new Date().toISOString() })) } });
    await tx.runtimeMetadataEvent.create({ data: { ...aliasWhere, value: JSON.stringify({ attempt, acceptedRevision: record.sequence }) } });
    return record;
  });
  const saved = Accepted.parse(JSON.parse(accepted.value!));
  if (saved.taskId !== observed.task.id || saved.sessionId !== input.sessionId || saved.epoch !== observed.digest || retirementDigest(saved.input) !== retirementDigest({ requestKey: input.requestKey, cleanup: true, ...(input.finalizationVersion ? { finalizationVersion: input.finalizationVersion } : {}) })) throw new Error("Preparation attempt authority or turn changed; old observations cannot authorize a new boundary");
  const state = await latest(input.prisma, accepted);
  if (state.state === "ready") await assertPreparedCleanup(input);
  if (freshRequest || state.state === "ready") await input.prisma.runtimeMetadataEvent.create({ data: {
    runtimeSessionId: input.sessionId, source: accepted.source, action: "finalization-preparation-response", key: attempt.attemptId,
    value: JSON.stringify({ acceptedRevision: accepted.sequence, stage: "response", event: "end", state: state.state, elapsedMs: Math.round(performance.now() - responseStarted) }),
  } });
  return { preparation: { version: 1 as const, requestKey: input.requestKey, taskId: saved.taskId, sessionId: input.sessionId, attemptId: attempt.attemptId, boundary: attempt.boundary,
    acceptedRevision: accepted.sequence, state: state.state, stage: state.state === "running" ? state.failedStage ?? state.activeStage ?? state.stage : state.stage, elapsedMs: Date.now() - Date.parse(saved.acceptedAt), ...(state.error ? { error: state.error, retryable: state.retryable } : {}) },
    ...(state.state === "ready" ? { receipt: state.result } : {}) };
}

export async function executeFullPreparation<T>(input: FinalizationContext, work: () => Promise<T>): Promise<T> {
  const owned = execution.getStore();
  if (input.authorityOnly || owned?.sessionId === input.sessionId && owned.requestKey === input.requestKey) return work();
  const active = fullScans.get(input.prisma) ?? new Map<string, "synchronous" | "journal">();
  fullScans.set(input.prisma, active);
  const key = executionKey(input);
  if (active.has(key)) throw new Error("Full preparation is already running; no overlapping scan was started");
  active.set(key, "synchronous");
  try { await assertNoPendingPreparation(input); return await work(); }
  finally { active.delete(key); }
}

export async function assertNoPendingPreparation(input: FinalizationContext) {
  const accepted = await unsettled(input.prisma, input.sessionId, 1);
  for (const record of accepted) {
    const saved = Accepted.parse(JSON.parse(record.value!));
    const state = await latest(input.prisma, record);
    if (state.state === "pending" || state.state === "running") throw new Error(`Full preparation is pending (attempt ${saved.attempt.attemptId}); inspect that attempt instead of starting a concurrent scan`);
  }
}

/** Owned by the existing projection lifecycle: no timer, task turn, deletion,
 * or provider executor. The process already holds exclusive runtime ownership.
 * Only one full preparation runs at a time; HTTP abandonment cannot cancel or
 * duplicate it. A new process resumes interrupted read-only verification. */
export function preparationJournalWorker(input: WorkerInput, prepare?: (input: FinalizationContext) => Promise<unknown>) {
  if (activeWorkers.has(input.prisma)) throw new Error("Preparation journal already has a worker");
  const worker = randomUUID();
  let stopped = false, running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      const records = await unsettled(input.prisma, null, 1);
      for (const record of records) {
        if (stopped) return;
        const prior = await latest(input.prisma, record);
        if (prior.state === "ready" || prior.state === "failed") continue;
        const saved = Accepted.parse(JSON.parse(record.value!));
        const context: Context = { ...input, ...saved.input, sessionId: saved.sessionId };
        const scans = fullScans.get(input.prisma) ?? new Map<string, "synchronous" | "journal">();
        fullScans.set(input.prisma, scans);
        const key = executionKey(context);
        // Acceptance may have raced an older synchronous request. Claim the
        // same local reservation immediately before any expensive observation.
        if (scans.has(key)) return;
        scans.set(key, "journal");
        let stage = "ownership";
        const start = performance.now();
        try {
          if ((await epoch(context)).digest !== saved.epoch) throw new Error("Preparation original authority or turn changed");
          await append(input, record, { state: "running", stage, worker });
          const result = await withPreparationDiagnostics(async diagnostic => {
            stage = diagnostic.failedStage ?? diagnostic.activeStage ?? diagnostic.stage;
            await append(input, record, { state: "running", ...diagnostic, worker });
          }, () => preparationStage("verification", async () => {
            const actual = prepare ?? (await import("./finalization.ts")).prepareTaskFinalization;
            return execution.run({ sessionId: context.sessionId, requestKey: context.requestKey }, () => actual(context));
          }));
          stage = "response";
          await input.prisma.$transaction(async tx => {
            const local = { ...context, prisma: tx as PrismaClient };
            if ((await epoch(local)).digest !== saved.epoch) throw new Error("Preparation original authority or turn changed during verification");
            await assertPreparedCleanup(local);
            await append({ ...input, prisma: tx as PrismaClient }, record, { state: "ready", stage, worker, elapsedMs: Math.round(performance.now() - start), result });
          });
        } catch (error) {
          const diagnostic = preparationFailure(error);
          // Keep the released client's strict progress shape: its existing error
          // field carries exactly the same safe code/reason as the durable row.
          await append(input, record, { state: "failed", stage, diagnostic, worker, elapsedMs: Math.round(performance.now() - start), error: `Preparation failed during ${stage}: [${diagnostic.code}] ${diagnostic.reason} Full verification did not grant cleanup authority.`, retryable: true });
          console.error(`[preparation] ${record.sequence} failed at ${stage}: [${diagnostic.code}] ${diagnostic.reason}`);
        } finally { scans.delete(key); }
        return;
      }
    })().catch(error => { const diagnostic = preparationFailure(error); console.error(`[preparation] journal reconciliation failed: [${diagnostic.code}] ${diagnostic.reason}`); }).finally(() => { running = undefined; });
  };
  const result = { tick, async stop() { stopped = true; await running; activeWorkers.delete(input.prisma); }, async idle() { await running; } };
  activeWorkers.set(input.prisma, result);
  return result;
}
