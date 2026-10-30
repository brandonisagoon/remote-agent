import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { assertRequestActive } from "../../request-lifetime.ts";

export class CleanupTransportBlockedError extends Error {}
const Action = "cleanup-provider-transport";
const identity = (task: { id: string; primarySessionId: string | null; worktreePath: string | null; repositoryId: string; machineId: string; toolingRoot: string | null; toolingRevision: string | null; pinnedToolingRoot: string | null; branchName: string | null; connectionId: string | null; issueIdentifier: string | null }) => ({
  taskId: task.id, sessionId: task.primarySessionId, cwd: task.worktreePath, repositoryId: task.repositoryId, machineId: task.machineId,
  toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, branch: task.branchName,
  connectionId: task.connectionId, issueIdentifier: task.issueIdentifier,
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const Binding = z.object({ version: z.literal(1), mode: z.enum(["cleanup", "work"]), identityDigest: z.string(), sessionId: z.string(),
  cwd: z.string(), sourceDev: z.number(), sourceIno: z.number(), executionCwd: z.string(), dev: z.number(), ino: z.number(), previousRevision: z.number().int().nonnegative(),
}).strict();
type Context = { prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime; taskId: string;
  queuedInstruction?: { id: string; check: (prisma: PrismaClient) => Promise<void> } };
const latest = (prisma: PrismaClient, sessionId: string) => prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source: "runtime", action: Action }, orderBy: { sequence: "desc" } });

async function taskIdentity(input: Pick<Context, "prisma" | "config" | "taskId">) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const primary = task.primarySessionId && await input.prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!primary || primary.role !== "primary" || primary.status === "closed" || !task.worktreePath || primary.cwd !== task.worktreePath
    || primary.repositoryId !== task.repositoryId || primary.machineId !== task.machineId || task.machineId !== input.config.machine
    || task.ownerPaused || task.phase === "closed") throw new Error("Cleanup transport requires the unpaused original open task primary");
  let linkId: string | null = null;
  if (task.issueIdentifier) {
    if (!task.connectionId) throw new Error("Cleanup transport source connection is missing");
    const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: primary.id, provider: "linear", connectionId: task.connectionId,
      resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
    if (!link) throw new Error("Cleanup transport source ownership was revoked");
    linkId = link.id;
  }
  return { task, primary, identityDigest: digest({ ...identity(task), linkId }) };
}
async function idleFamily(input: Context) {
  await input.queuedInstruction?.check(input.prisma);
  const current = await taskIdentity(input);
  const all = await input.prisma.runtimeSession.findMany({ where: { OR: [{ cwd: current.task.worktreePath! }, { cwd: { startsWith: `${current.task.worktreePath!}${path.sep}` } }] }, orderBy: { id: "asc" } });
  if (all.some(session => session.cwd !== current.task.worktreePath || session.repositoryId !== current.task.repositoryId || session.machineId !== current.task.machineId
    || !["idle", "closed"].includes(session.status))) throw new Error("Cleanup transport refuses active, uncertain or foreign checkout sessions");
  const relations = await input.prisma.runtimeSessionRelation.findMany({ where: { sourceSessionId: { in: all.filter(session => session.id !== current.primary.id).map(session => session.id) }, relationship: "spawned-by", endedAt: null }, orderBy: { id: "asc" } });
  const owned = new Set([current.primary.id]);
  for (let depth = 0; depth < all.length; depth++) for (const relation of relations) if (owned.has(relation.targetSessionId)) owned.add(relation.sourceSessionId);
  const historical = all.filter(session => !owned.has(session.id) && session.status === "closed");
  const sessions = all.filter(session => owned.has(session.id));
  if (sessions.length + historical.length !== all.length || sessions.some(session => session.id !== current.primary.id && session.role !== "delegate")) throw new Error("Checkout session is not in the original primary's owned provider family");
  const pending = await input.prisma.runtimeInstruction.count({ where: { sessionId: { in: sessions.filter(session => session.status !== "closed").map(session => session.id) },
    ...(input.queuedInstruction ? { id: { not: input.queuedInstruction.id } } : {}), state: { in: ["preparing", "queued", "dispatching", "unknown"] } } });
  if (pending) throw new Error("Cleanup transport preserves pending original-family instructions");
  return { ...current, sessions, historical, familyDigest: digest({ relations, sessions: all.map(session => ({ id: session.id, cwd: session.cwd, role: session.role, status: session.status,
    acpxRecordId: session.acpxRecordId, acpxSessionId: session.acpxSessionId, agentSessionId: session.agentSessionId })) }) };
}
async function checkDirectory(value: z.infer<typeof Binding>) {
  const stat = await lstat(value.executionCwd);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700
    || stat.dev !== value.dev || stat.ino !== value.ino || await realpath(value.executionCwd) !== value.executionCwd) throw new Error("Cleanup execution directory identity changed");
}

/** Owner adoption and existing cleanup scheduling use this transition, not a
 * second executor. Transport release grants no delivery or cleanup authority. */
export async function releaseTaskCleanupTransports(input: Context) {
  assertRequestActive();
  if (!input.runtime.releaseIdleTransports) throw new Error("Runtime does not support safe idle transport release");
  const before = await idleFamily(input), prior = await latest(input.prisma, before.primary.id);
  const checkHistory = async (historical: typeof before.historical) => {
    for (const session of historical) {
      if (!input.runtime.assertClosedProviderAbsent) throw new Error("Historical checkout provider absence cannot be verified");
      await input.runtime.assertClosedProviderAbsent(session.id);
    }
  };
  await checkHistory(before.historical);
  const priorValue = prior && Binding.parse(JSON.parse(prior.value!));
  if (priorValue && priorValue.identityDigest !== before.identityDigest) throw new Error("Original cleanup transport identity changed");
  if (priorValue?.mode === "cleanup") { await checkDirectory(priorValue); }
  let result: { revision: number; executionCwd: string } | undefined;
  await input.runtime.releaseIdleTransports({ sessionIds: before.sessions.map(session => session.id),
    check: async () => {
      assertRequestActive();
      const after = await idleFamily(input);
      if (after.identityDigest !== before.identityDigest || after.familyDigest !== before.familyDigest || (await latest(input.prisma, before.primary.id))?.sequence !== prior?.sequence) throw new Error("Cleanup transport ownership changed during release");
      await checkHistory(after.historical);
      assertRequestActive();
    },
    commit: async () => {
      assertRequestActive();
      if (priorValue?.mode === "cleanup") { result = { revision: prior!.sequence, executionCwd: priorValue.executionCwd }; return; }
      const base = await realpath(input.config.acpxStateDir);
      const executionCwd = path.join(base, "cleanup-transports", createHash("sha256").update(before.task.id).digest("hex"));
      if (within(before.task.worktreePath!, executionCwd) || within(executionCwd, before.task.worktreePath!)) throw new Error("Cleanup execution directory overlaps original checkout");
      assertRequestActive();
      await mkdir(path.dirname(executionCwd), { recursive: true, mode: 0o700 });
      await mkdir(executionCwd, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      const stat = await lstat(executionCwd), source = await lstat(before.task.worktreePath!);
      if (!source.isDirectory() || source.isSymbolicLink() || await realpath(before.task.worktreePath!) !== before.task.worktreePath) throw new Error("Original source checkout identity is unavailable");
      const value = Binding.parse({ version: 1, mode: "cleanup", identityDigest: before.identityDigest, sessionId: before.primary.id, cwd: before.task.worktreePath,
        executionCwd, sourceDev: source.dev, sourceIno: source.ino, dev: stat.dev, ino: stat.ino, previousRevision: prior?.sequence ?? 0 });
      await checkDirectory(value);
      const saved = await input.prisma.$transaction(async tx => {
        const now = await idleFamily({ ...input, prisma: tx as PrismaClient });
        if (now.identityDigest !== before.identityDigest || now.familyDigest !== before.familyDigest || (await latest(tx as PrismaClient, before.primary.id))?.sequence !== prior?.sequence) throw new Error("Cleanup transport changed before binding");
        assertRequestActive();
        const saved = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.primary.id, source: "runtime", action: Action, key: `${before.task.id}:${prior?.sequence ?? 0}`, value: JSON.stringify(value) } });
        assertRequestActive();
        return saved;
      });
      result = { revision: saved.sequence, executionCwd };
    },
  });
  return { taskId: before.task.id, sessionId: before.primary.id, ...result!, released: true as const };
}

/** A read-only execution selection; it never substitutes for finalizer effect
 * authority. Only the existing, claimed automatic cleanup instruction qualifies. */
export async function cleanupExecutionDirectory(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; requestId?: string }) {
  const session = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  const task = await input.prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
  if (!task?.primarySessionId) return undefined;
  const event = await latest(input.prisma, task.primarySessionId);
  if (!event) {
    if (input.requestId) {
      const instruction = await input.prisma.runtimeInstruction.findFirst({ where: { sessionId: input.sessionId, executionRequestId: input.requestId, state: "dispatching" } });
      if (instruction && await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: "cleanup-inbox", action: "finalization-cleanup-instruction", key: instruction.id } })) {
        throw new CleanupTransportBlockedError("Queued cleanup requires its original provider transport transition before execution");
      }
    }
    return undefined;
  }
  const value = Binding.parse(JSON.parse(event.value!));
  const current = await taskIdentity({ ...input, taskId: task.id });
  if (value.identityDigest !== current.identityDigest) throw new Error("Original cleanup transport identity changed");
  if (value.mode === "work") return undefined;
  if (input.sessionId !== task.primarySessionId || !input.requestId) throw new CleanupTransportBlockedError("Checkout provider is released for cleanup; preserve ordinary work until return-to-work");
  const instruction = await input.prisma.runtimeInstruction.findFirst({ where: { sessionId: input.sessionId, executionRequestId: input.requestId, state: "dispatching" } });
  const marker = instruction && await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: "cleanup-inbox", action: "finalization-cleanup-instruction", key: instruction.id } });
  if (!marker) throw new CleanupTransportBlockedError("Only the original claimed cleanup instruction may resume the released provider");
  await checkDirectory(value);
  return value.executionCwd;
}

/** An explicit owner return restores ordinary execution only while the exact
 * original checkout still exists. No queued work is deleted or acknowledged. */
export async function returnTaskTransportToWork(input: Context & { revision: number }) {
  assertRequestActive();
  if (!input.runtime.releaseIdleTransports) throw new Error("Runtime cannot release idle transports");
  const before = await taskIdentity(input), prior = await latest(input.prisma, before.primary.id);
  if (!prior) throw new Error("Return-to-work requires the current transport revision");
  const value = Binding.parse(JSON.parse(prior.value!));
  if (prior.sequence !== input.revision && !(value.mode === "work" && value.previousRevision === input.revision)) throw new Error("Return-to-work requires the current transport revision");
  if (value.identityDigest !== before.identityDigest) throw new Error("Original cleanup transport identity changed");
  const original = await lstat(value.cwd);
  if (!original.isDirectory() || original.isSymbolicLink() || original.dev !== value.sourceDev || original.ino !== value.sourceIno || await realpath(value.cwd) !== value.cwd) throw new Error("Original checkout is no longer available for work");
  await input.runtime.releaseIdleTransports({ sessionIds: [before.primary.id], check: async () => {
    assertRequestActive();
    const now = await taskIdentity(input);
    if (now.identityDigest !== before.identityDigest || (await latest(input.prisma, before.primary.id))?.sequence !== prior.sequence) throw new Error("Return-to-work authority changed");
    assertRequestActive();
  }, commit: async () => {
    assertRequestActive();
    if (value.mode === "work") return;
    await input.prisma.$transaction(async tx => {
      const now = await taskIdentity({ ...input, prisma: tx as PrismaClient });
      if (now.identityDigest !== before.identityDigest || (await latest(tx as PrismaClient, before.primary.id))?.sequence !== prior.sequence) throw new Error("Return-to-work changed before binding");
      assertRequestActive();
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: before.primary.id, source: "runtime", action: Action,
        key: `${before.task.id}:${prior.sequence}`, value: JSON.stringify({ ...value, mode: "work", previousRevision: prior.sequence }) } });
      assertRequestActive();
    });
  } });
  return { taskId: before.task.id, sessionId: before.primary.id, returned: true as const };
}

/** Optional runtime capability: adapters without a warm process implementation
 * retain the old flow, whose independent root-idle checks still apply. */
export async function ensureTaskCleanupTransports(input: Context) {
  assertRequestActive();
  if (!input.runtime.releaseIdleTransports) return;
  const current = await taskIdentity(input), prior = await latest(input.prisma, current.primary.id);
  if (prior) {
    const value = Binding.parse(JSON.parse(prior.value!));
    if (value.identityDigest !== current.identityDigest) throw new Error("Original cleanup transport identity changed");
    if (value.mode === "cleanup") { await checkDirectory(value); return; }
  }
  return releaseTaskCleanupTransports(input);
}

/** Called at both existing inbox selection and transactional claim. Ordinary
 * follow-ups stay queued, with no provider startup or invented terminal result. */
export async function cleanupTransportAllowsInstruction(prisma: Pick<PrismaClient, "runtimeSession" | "remoteTask" | "runtimeMetadataEvent">, receipt: { id: string; sessionId: string }) {
  const session = await prisma.runtimeSession.findUnique({ where: { id: receipt.sessionId } });
  const task = session && await prisma.remoteTask.findUnique({ where: { worktreePath: session.cwd } });
  if (!task?.primarySessionId) return true;
  const event = await latest(prisma as PrismaClient, task.primarySessionId);
  if (!event || Binding.parse(JSON.parse(event.value!)).mode === "work") return true;
  if (receipt.sessionId !== task.primarySessionId) return false;
  return Boolean(await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: receipt.sessionId, source: "cleanup-inbox", action: "finalization-cleanup-instruction", key: receipt.id } }));
}

export async function inspectCleanupTransport(input: Omit<Context, "runtime">) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const event = task.primarySessionId && await latest(input.prisma, task.primarySessionId);
  if (!event) return { readOnly: true as const, taskId: task.id, sessionId: task.primarySessionId, revision: 0, mode: "work" as const };
  const value = Binding.parse(JSON.parse(event.value!));
  let blocked: string | null = null;
  try {
    if ((await taskIdentity(input)).identityDigest !== value.identityDigest) throw new Error("Original cleanup transport identity changed");
    if (value.mode === "cleanup") await checkDirectory(value);
  } catch (error) { blocked = error instanceof Error ? error.message : "Cleanup transport state is unverified"; }
  return { readOnly: true as const, taskId: task.id, sessionId: task.primarySessionId, revision: event.sequence, mode: value.mode, executionCwd: value.executionCwd, blocked };
}
