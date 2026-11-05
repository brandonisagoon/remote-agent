import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, getLinearConnection, type ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { pauseTaskFamily } from "../tasks/automation-pause.ts";

export class NativeLaunchWithdrawnError extends Error {
  constructor() { super("Managed launch withdrawn by native ownership; preserve its work and history"); }
}
const Id = z.string().trim().min(1).max(256);
export const NativeSource = z.object({ connectionId: Id, repositoryId: Id, issueId: Id, issueIdentifier: Id }).strict();
export const NativeTakeoverInput = z.object({ source: NativeSource, requestKey: Id, expectedRevision: z.number().int().nonnegative(),
  nativeChat: z.object({ threadId: Id, hostId: Id }).strict() }).strict();
export const NativeLaunchGrant = z.object({ expectedRevision: z.number().int().positive(), issueId: Id }).strict();
type Source = z.infer<typeof NativeSource>;
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (source: Pick<Source, "connectionId" | "repositoryId" | "issueIdentifier">) => ({ connectionId_repositoryId_issueIdentifier: { connectionId: source.connectionId, repositoryId: source.repositoryId, issueIdentifier: source.issueIdentifier } });
const locks = new WeakMap<PrismaClient, Map<string, Promise<unknown>>>();
function sourceLock<T>(prisma: PrismaClient, source: Pick<Source, "connectionId" | "repositoryId" | "issueIdentifier">, work: () => Promise<T>): Promise<T> {
  let entries = locks.get(prisma); if (!entries) { entries = new Map(); locks.set(prisma, entries); }
  const key = hash([source.connectionId, source.repositoryId, source.issueIdentifier]), previous = entries.get(key);
  const running = (previous ?? Promise.resolve()).catch(() => {}).then(work);
  entries.set(key, running);
  return running.finally(() => { if (entries!.get(key) === running) entries!.delete(key); });
}
const activeWork = new WeakMap<PrismaClient, Map<string, Map<string, number>>>();
const workKey = (connectionId: string, repositoryId: string, issue: string) => hash([connectionId, repositoryId, issue]);
export async function withNativeLaunchWork<T>(prisma: PrismaClient, source: { connectionId: string; repositoryId: string; issue: string }, runId: string, work: () => Promise<T>) {
  let entries = activeWork.get(prisma); if (!entries) { entries = new Map(); activeWork.set(prisma, entries); }
  const key = workKey(source.connectionId, source.repositoryId, source.issue);
  let runs = entries.get(key); if (!runs) { runs = new Map(); entries.set(key, runs); }
  runs.set(runId, (runs.get(runId) ?? 0) + 1);
  try { return await work(); }
  finally { const remaining = runs.get(runId)! - 1; if (remaining) runs.set(runId, remaining); else runs.delete(runId); if (!runs.size) entries.delete(key); }
}
const processStartedAt = new Date();
async function pendingNativeWork(prisma: PrismaClient, source: Source) {
  const entries = activeWork.get(prisma);
  const active = [...new Set([source.issueId, source.issueIdentifier].flatMap(issue => [...entries?.get(workKey(source.connectionId, source.repositoryId, issue))?.keys() ?? []]))];
  // A pre-process pending receipt cannot prove whether its old preparation
  // stopped. Never promote missing in-memory state into a liveness receipt.
  const unverified = await prisma.workerRun.findMany({ where: { status: "pending", workerKey: { startsWith: "product.workflow:" }, createdAt: { lt: processStartedAt },
    receipt: { connectionId: source.connectionId, repositoryId: source.repositoryId, resourceId: { in: [source.issueId, source.issueIdentifier] } } }, select: { id: true } });
  return { active, unverified: unverified.map(run => run.id), pending: [...new Set([...active, ...unverified.map(run => run.id)])] };
}
export async function nativeLaunchControl(prisma: Pick<PrismaClient, "nativeTakeover">, source: Pick<Source, "connectionId" | "repositoryId" | "issueIdentifier">) {
  return prisma.nativeTakeover.findUnique({ where: identity(source) });
}
function sourceConfig(config: ServerConfig, source: Source) {
  getRepositoryConfig(config, source.repositoryId); getLinearConnection(config, source.connectionId);
}
function sameSource(control: { issueId: string; machineId: string }, source: Source, config: ServerConfig) {
  if (control.issueId !== source.issueId || control.machineId !== config.machine) throw new Error("Native takeover source or owning host changed");
}
export async function inspectNativeTakeover({ prisma, config }: Context, source: Source) {
  sourceConfig(config, source);
  const control = await nativeLaunchControl(prisma, source);
  if (!control) return { source, revision: 0, state: "unfenced", control: null, events: [] };
  sameSource(control, source, config);
  const tasks = await prisma.remoteTask.findMany({ where: { connectionId: source.connectionId, repositoryId: source.repositoryId, issueIdentifier: source.issueIdentifier, machineId: config.machine, phase: { not: "closed" } }, select: { id: true, primarySessionId: true, ownerPaused: true } });
  const workerState = await pendingNativeWork(prisma, source), pendingWorkerRunIds = workerState.pending;
  return { source, revision: control.revision, state: control.mode === "native" ? control.settled && !pendingWorkerRunIds.length && tasks.every(task => task.ownerPaused) ? "native" : "pending" : control.grantedSessionId ? "managed" : "launch-pending", control, tasks, pendingWorkerRunIds, activeWorkerRunIds: workerState.active, unverifiedWorkerRunIds: workerState.unverified,
    events: await prisma.nativeTakeoverEvent.findMany({ where: { controlId: control.id }, orderBy: { sequence: "desc" }, take: 20 }) };
}

/** Persist the fence and task pauses together before any cancellation. A retry
 * renews only its current decision; an old key cannot reapply over newer intent. */
export function takeNativeOwnership(context: Context, raw: z.infer<typeof NativeTakeoverInput>) {
  const input = NativeTakeoverInput.parse(raw);
  return sourceLock(context.prisma, input.source, () => performTakeover(context, input));
}
async function performTakeover(context: Context, raw: z.infer<typeof NativeTakeoverInput>) {
  const input = NativeTakeoverInput.parse(raw), { prisma, config, runtime } = context;
  sourceConfig(config, input.source);
  const sourceKey = hash(["linear", input.source.connectionId, input.source.repositoryId, input.source.issueId]);
  const inputDigest = hash(input);
  const decision = await prisma.$transaction(async tx => {
    const placement = await tx.taskPlacement.findUnique({ where: { sourceKey: `linear:${input.source.connectionId}:${input.source.issueId}` } });
    if (placement && (placement.machineId !== config.machine || placement.repositoryId !== input.source.repositoryId)) throw new Error("Use the recorded source execution host");
    const current = await nativeLaunchControl(tx, input.source);
    if (current) {
      sameSource(current, input.source, config);
      const prior = await tx.nativeTakeoverEvent.findUnique({ where: { controlId_requestKey: { controlId: current.id, requestKey: `native:${input.requestKey}` } } });
      if (prior) {
        if (prior.inputDigest !== inputDigest || prior.kind !== "native") throw new Error("Native takeover request key belongs to different input");
        if (current.mode === "native" && current.revision === prior.revision) await tx.remoteTask.updateMany({ where: { connectionId: input.source.connectionId, repositoryId: input.source.repositoryId, issueIdentifier: input.source.issueIdentifier, machineId: config.machine, phase: { not: "closed" } }, data: { ownerPaused: true } });
        return { control: current, appliedRevision: prior.revision };
      }
    }
    if ((current?.revision ?? 0) !== input.expectedRevision) throw new Error("Native takeover revision changed; inspect the current owner decision");
    const revision = input.expectedRevision + 1;
    const data = { mode: "native", grantKey: null, grantedSessionId: null, settled: false, revision, decidedAt: new Date() };
    const control = current ? await tx.nativeTakeover.update({ where: { id: current.id, revision: current.revision }, data })
      : await tx.nativeTakeover.create({ data: { ...input.source, sourceKey, machineId: config.machine, ...data } });
    const tasks = await tx.remoteTask.findMany({ where: { connectionId: input.source.connectionId, repositoryId: input.source.repositoryId, issueIdentifier: input.source.issueIdentifier, machineId: config.machine, phase: { not: "closed" } }, select: { id: true, ownerPaused: true, primarySessionId: true } });
    const receipts = await tx.webhookReceipt.findMany({ where: { connectionId: input.source.connectionId, repositoryId: input.source.repositoryId, resourceId: { in: [input.source.issueId, input.source.issueIdentifier] } }, select: { id: true, deliveryId: true, trigger: true, runs: { select: { id: true, workerKey: true } } } });
    // Logical withdrawal is the durable source fence. Forwarded deliveries may
    // still be acknowledged normally; comments/results are never discarded.
    await tx.remoteTask.updateMany({ where: { id: { in: tasks.map(task => task.id) } }, data: { ownerPaused: true } });
    await tx.nativeTakeoverEvent.create({ data: { controlId: control.id, requestKey: `native:${input.requestKey}`, inputDigest, revision, kind: "native",
      value: { nativeChat: input.nativeChat, tasks, acceptedReceipts: receipts,
        withdrawnRunIds: receipts.flatMap(receipt => receipt.runs.filter(run => run.workerKey.startsWith("product.workflow:") && getRepositoryConfig(config, input.source.repositoryId).workflows[run.workerKey.slice("product.workflow:".length)]?.deliver === "start-session").map(run => run.id)),
        pendingIngressDeliveries: placement ? await tx.taskDelivery.findMany({ where: { placementId: placement.id, state: { not: "acknowledged" } }, select: { id: true, sequence: true, kind: true, state: true } }) : [] } } });
    return { control, appliedRevision: revision };
  });
  if (decision.control.revision !== decision.appliedRevision || decision.control.mode !== "native") return { ...await inspectNativeTakeover(context, input.source), superseded: true };
  const assertCurrent = async () => {
    const current = await nativeLaunchControl(prisma, input.source);
    if (current?.id !== decision.control.id || current.revision !== decision.appliedRevision || current.mode !== "native") throw new Error("Native ownership was superseded; no stale cancellation is allowed");
  };
  const tasks = await prisma.remoteTask.findMany({ where: { connectionId: input.source.connectionId, repositoryId: input.source.repositoryId, issueIdentifier: input.source.issueIdentifier, machineId: config.machine, phase: { not: "closed" } } });
  const pauses: Array<{ taskId: string } & Awaited<ReturnType<typeof pauseTaskFamily>>> = [];
  for (const task of tasks) { await assertCurrent(); pauses.push({ taskId: task.id, ...await pauseTaskFamily(task, runtime, assertCurrent) }); }
  await assertCurrent();
  const linked = await prisma.runtimeSession.findMany({ where: { machineId: config.machine, repositoryId: input.source.repositoryId, status: { not: "closed" }, resourceLinks: { some: {
    provider: "linear", connectionId: input.source.connectionId, resourceType: "issue-identifier", relationship: "handles", externalId: input.source.issueIdentifier, endedAt: null,
  } } } });
  const unresolvedSessionIds = linked.filter(session => !tasks.some(task => task.worktreePath === session.cwd) &&
    (["active", "provisioning"].includes(session.status) || ["executing", "queued"].includes(runtime.observeSessionActivity?.(session.id).state ?? ""))).map(session => session.id);
  const stillPaused = await prisma.remoteTask.count({ where: { id: { in: tasks.map(task => task.id) }, ownerPaused: false } }) === 0;
  const workerState = await pendingNativeWork(prisma, input.source), pendingWorkerRunIds = workerState.pending;
  const settled = !pendingWorkerRunIds.length && stillPaused && !unresolvedSessionIds.length && pauses.every(pause => !pause.pendingSessionIds.length && !pause.failures.length);
  await prisma.$transaction(async tx => {
    const changed = await tx.nativeTakeover.updateMany({ where: { id: decision.control.id, revision: decision.appliedRevision, mode: "native" }, data: { settled } });
    if (!changed.count) throw new Error("Native ownership changed during family reconciliation");
    const value = { pauses, pendingWorkerRunIds, activeWorkerRunIds: workerState.active, unverifiedWorkerRunIds: workerState.unverified, unresolvedSessionIds, settled }, digest = hash(value);
    await tx.nativeTakeoverEvent.upsert({ where: { controlId_requestKey: { controlId: decision.control.id, requestKey: `reconcile:${decision.appliedRevision}:${digest}` } }, update: {},
      create: { controlId: decision.control.id, requestKey: `reconcile:${decision.appliedRevision}:${digest}`, inputDigest: digest, revision: decision.appliedRevision, kind: "reconciled", value } });
  });
  return inspectNativeTakeover(context, input.source);
}

/** Last-mile execution guard. Once fenced, only the exact fresh owner grant can
 * run; an old webhook/run cannot consume it even after native ownership ends. */
export async function assertNativeLaunch(prisma: Pick<PrismaClient, "nativeTakeover">, source: Pick<Source, "connectionId" | "repositoryId" | "issueIdentifier">, launchKey: string) {
  const control = await nativeLaunchControl(prisma, source);
  if (control && (control.mode !== "managed" || control.grantKey !== launchKey)) throw new NativeLaunchWithdrawnError();
}

/** The existing explicit owner launch is the fresh intent. It is not a blanket
 * release: a grant is bound to one launch key and the exact current revision. */
export function grantNativeLaunch(context: Context, source: Source, launchKey: string, expectedRevision: number, requestDigest = hash({ source, launchKey, expectedRevision })) {
  return sourceLock(context.prisma, source, () => performGrant(context, source, launchKey, expectedRevision, requestDigest));
}
async function performGrant(context: Context, source: Source, launchKey: string, expectedRevision: number, requestDigest: string) {
  const { prisma, config } = context; sourceConfig(config, source);
  const workerState = await pendingNativeWork(prisma, source);
  return prisma.$transaction(async tx => {
    const current = await nativeLaunchControl(tx, source);
    if (!current) throw new Error("There is no native ownership decision for this grant");
    sameSource(current, source, config);
    const requestKey = `launch:${launchKey}`, inputDigest = hash({ source, launchKey, expectedRevision, requestDigest });
    const prior = await tx.nativeTakeoverEvent.findUnique({ where: { controlId_requestKey: { controlId: current.id, requestKey } } });
    if (prior) {
      if (prior.inputDigest !== inputDigest || prior.revision !== current.revision || current.grantKey !== launchKey || current.mode !== "managed") throw new Error("Owner launch grant is changed or superseded");
      return current;
    }
    if (current.revision !== expectedRevision || !current.settled || workerState.pending.length) throw new Error("Native ownership revision changed or its family has not settled");
    const revision = current.revision + 1;
    const granted = await tx.nativeTakeover.update({ where: { id: current.id, revision: expectedRevision }, data: { revision, mode: "managed", grantKey: launchKey, grantedSessionId: null, decidedAt: new Date() } });
    await tx.nativeTakeoverEvent.create({ data: { controlId: current.id, requestKey, inputDigest, revision, kind: "managed", value: { source, launchKey, expectedRevision, requestDigest } } });
    return granted;
  });
}


export async function bindNativeLaunchSession(prisma: Pick<PrismaClient, "nativeTakeover">, source: Pick<Source, "connectionId" | "repositoryId" | "issueIdentifier">, launchKey: string, sessionId: string) {
  const control = await nativeLaunchControl(prisma, source);
  if (!control) return;
  const changed = await prisma.nativeTakeover.updateMany({ where: { id: control.id, revision: control.revision, mode: "managed", grantKey: launchKey,
    OR: [{ grantedSessionId: null }, { grantedSessionId: sessionId }] }, data: { grantedSessionId: sessionId } });
  if (!changed.count) throw new Error("Native launch grant changed before session binding");
}

/** Rechecked after every asynchronous setup step at the actual turn boundary.
 * A grant belongs to one original primary and its recorded descendants. */
export async function assertNativeSession(prisma: Pick<PrismaClient, "nativeTakeover" | "runtimeSession" | "runtimeSessionRelation" | "runtimeSessionResourceLink" | "remoteTask">, sessionId: string) {
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: sessionId } });
  const links = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: sessionId, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  const task = await prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
  const sources = links.map(link => ({ connectionId: link.connectionId, repositoryId: session.repositoryId, issueIdentifier: link.externalId }));
  if (task?.connectionId && task.issueIdentifier) sources.push({ connectionId: task.connectionId, repositoryId: task.repositoryId, issueIdentifier: task.issueIdentifier });
  for (const source of sources) {
    const control = await nativeLaunchControl(prisma, source);
    if (!control) continue;
    if (control.machineId !== session.machineId || control.mode !== "managed" || !control.grantedSessionId) throw new Error("Native ownership prevents managed execution");
    let current = sessionId; const seen = new Set<string>();
    while (current !== control.grantedSessionId) {
      if (seen.has(current) || seen.size >= 64) throw new Error("Native launch lineage is unverified");
      seen.add(current);
      const parents = await prisma.runtimeSessionRelation.findMany({ where: { sourceSessionId: current, relationship: "spawned-by", endedAt: null } });
      if (parents.length !== 1) throw new Error("Session is outside the current owner launch grant");
      const parent = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: parents[0]!.targetSessionId } });
      if (parent.repositoryId !== session.repositoryId || parent.machineId !== session.machineId) throw new Error("Native launch lineage owner changed");
      current = parent.id;
    }
  }
}


export function isFreshNativeReaction(config: ServerConfig, repositoryId: string, decidedAt: Date,
  reaction: { createdAt?: string | null; userId?: string | null; user?: { id: string } | null }) {
  const actor = reaction.userId ?? reaction.user?.id;
  const authorized = actor && config.webhooks[config.activeWebhookId]?.repositoryRouting[repositoryId]?.when
    ?.some(condition => condition["linear.userId"]?.includes(actor));
  const created = reaction.createdAt ? Date.parse(reaction.createdAt) : NaN;
  return Boolean(authorized && Number.isFinite(created) && created > decidedAt.getTime() && created <= Date.now());
}

/** Called only on the authenticated/routed owner reaction path. Original event
 * time is required: webhook arrival time cannot prove a new owner instruction. */
export async function freshReactionNativeLaunch(context: Context, source: Source, launchKey: string,
  reaction: { id: string; createdAt?: string | null; userId?: string | null; user?: { id: string } | null },
  prompt: (task: { id: string; primarySessionId: string | null; worktreePath: string | null; pinnedToolingRoot: string | null }) => Promise<string>) {
  const control = await nativeLaunchControl(context.prisma, source);
  if (!control) return null;
  const ownGrant = control.mode === "managed" && control.grantKey === launchKey;
  let expectedRevision = control.revision;
  if (ownGrant) {
    const saved = await context.prisma.nativeTakeoverEvent.findUniqueOrThrow({ where: { controlId_requestKey: { controlId: control.id, requestKey: `launch:${launchKey}` } } });
    expectedRevision = z.object({ expectedRevision: z.number().int().positive() }).parse(saved.value).expectedRevision;
  } else if (!isFreshNativeReaction(context.config, source.repositoryId, control.decidedAt, reaction)) return null;
  const tasks = await context.prisma.remoteTask.findMany({ where: { connectionId: source.connectionId, repositoryId: source.repositoryId,
    machineId: context.config.machine, issueIdentifier: source.issueIdentifier, phase: { not: "closed" } } });
  if (tasks.length > 1) throw new Error("Multiple original families require reconciliation");
  const task = tasks[0];
  if (task) {
    if (!task.primarySessionId || !task.worktreePath || !task.pinnedToolingRoot) throw new Error("Original family is not ready for owner continuation");
    const session = await context.runtime.getSession(task.primarySessionId);
    if (!session) throw new Error("Original family is unavailable");
    if (ownGrant && control.grantedSessionId === session.id && !task.ownerPaused) {
      const queued = await context.prisma.runtimeInstruction.findUnique({ where: { id: `native-reaction:${reaction.id}` } });
      return queued ? session.id : null;
    }
    if (session.status !== "idle" || ["executing", "queued"].includes(context.runtime.observeSessionActivity?.(session.id).state ?? "")) throw new Error("Original family is still working; no duplicate owner launch");
    // Compose before the grant; a slow composer never releases the old fence.
    const planning = Boolean(context.config.repository.workflows[session.workflowId ?? ""]?.plan?.captureToIssue);
    const text = planning ? null : await prompt(task);
    await grantNativeLaunch(context, source, launchKey, expectedRevision, hash({ reaction, text }));
    await bindNativeLaunchSession(context.prisma, source, launchKey, session.id);
    await context.prisma.$transaction(async tx => {
      await assertNativeLaunch(tx, source, launchKey);
      const changed = await tx.remoteTask.updateMany({ where: { id: task.id, primarySessionId: session.id, worktreePath: task.worktreePath, phase: { not: "closed" } }, data: { ownerPaused: false } });
      if (!changed.count) throw new Error("Original family changed during owner continuation");
      if (text) {
        const { queueInstruction } = await import("../sessions/inbox.ts");
        await queueInstruction(tx, { sessionId: session.id, requestId: `native-reaction:${reaction.id}`, text });
      }
    });
    return planning ? null : session.id;
  }
  await grantNativeLaunch(context, source, launchKey, expectedRevision);
  return null;
}
