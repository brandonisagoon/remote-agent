import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient, ToolingOperation, ToolingRelease } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { BeginToolingOperationRequest, ToolingOperationBinding, ToolingReleaseRecord, ToolingReleaseSelection } from "../../../../types/tooling-release.ts";
import { SERVER_TOOLING_PROTOCOL, ToolingReleaseManifestSchema, prepareToolingRelease, verifyPreparedToolingRelease, type PreparedToolingRelease } from "./tooling.ts";

/** Internal implementation-completeness guard. Externally callable activation
 * stays unavailable until integration verifies every DRA-29/30 consumer binds
 * operations. This is not configuration and not a per-task capability. */
export const TOOLING_ACTIVATION_ENABLED = false;

export type ToolingActivationErrorCode = "invalid-request" | "repository-unavailable" | "request-conflict" | "generation-conflict"
  | "pending-restart" | "restart-required" | "preparation-failed" | "state-format-incompatible";
export class ToolingActivationError extends Error {
  constructor(readonly code: ToolingActivationErrorCode, message: string, readonly detail?: { generation?: number; release?: ToolingReleaseRecord }) { super(message); }
}
export type ToolingOperationErrorCode = "invalid-request" | "ownership" | "no-active-release" | "request-conflict" | "unsupported-protocol";
export class ToolingOperationError extends Error {
  constructor(readonly code: ToolingOperationErrorCode, message: string) { super(message); }
}

type Store = Pick<PrismaClient, "toolingRelease" | "toolingSelection" | "toolingPendingActivation" | "toolingActivation" | "toolingOperation">;
const UNIQUE_VIOLATION = "P2002";
const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().flatMap(key => (value as Record<string, unknown>)[key] === undefined ? [] : [[key, canonical((value as Record<string, unknown>)[key])]]));
  return value;
}
/** Canonical JSON SHA-256: object key order never changes the digest. */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function record(row: ToolingRelease): ToolingReleaseRecord {
  return { id: row.id, repositoryId: row.repositoryId, revision: row.revision, tree: row.tree, policyBlob: row.policyBlob, checkout: row.checkout,
    manifest: ToolingReleaseManifestSchema.parse(row.manifest) };
}
const releaseId = (prepared: Pick<PreparedToolingRelease, "repositoryId" | "revision">) => `tr_${canonicalDigest({ repositoryId: prepared.repositoryId, revision: prepared.revision }).slice(0, 32)}`;

async function selectionOf(store: Store, repositoryId: string): Promise<ToolingReleaseSelection | null> {
  const selection = await store.toolingSelection.findUnique({ where: { repositoryId } });
  if (!selection) return null;
  const release = await store.toolingRelease.findUniqueOrThrow({ where: { id: selection.releaseId } });
  return { repositoryId, generation: selection.generation, release: record(release) };
}

/** Null means no release-aware activation exists; callers must not silently
 * substitute a boot pin for an operation binding. */
export async function getActiveToolingRelease(input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string }): Promise<ToolingReleaseSelection | null> {
  return selectionOf(input.prisma, input.repositoryId);
}

const ActivationRequest = z.strictObject({
  repositoryId: z.string().min(1).max(128),
  requestKey: z.string().min(1).max(256),
  revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/, "revision must be an exact full commit ID"),
  expectedGeneration: z.number().int().min(0),
});
const RETAINED = ["bound", "running", "unknown"];

/** Reader compatibility from durable evidence. The candidate must read every
 * format the active release writes; any release still bound to an unfinished
 * operation must also read what the candidate writes (rollback/retained code).
 * Legacy releases without a manifest are not records and cannot be checked. */
async function assertStateFormats(store: Store, repositoryId: string, candidate: PreparedToolingRelease) {
  const retained = new Set((await store.toolingOperation.findMany({ where: { repositoryId, status: { in: RETAINED } }, select: { releaseId: true }, distinct: ["releaseId"] })).map(row => row.releaseId));
  const active = await store.toolingSelection.findUnique({ where: { repositoryId } });
  const ids = new Set([...retained, ...(active ? [active.releaseId] : [])]);
  for (const id of ids) {
    const release = record(await store.toolingRelease.findUniqueOrThrow({ where: { id } }));
    if (release.revision === candidate.revision) continue;
    for (const [family, format] of Object.entries(release.manifest.stateFormats)) {
      const next = candidate.manifest.stateFormats[family];
      if (!next) continue;
      if (!next.read.includes(format.write)) throw new ToolingActivationError("state-format-incompatible", `${family} format ${format.write} written by release ${release.revision} is unreadable by ${candidate.revision}`);
      if (retained.has(id) && !format.read.includes(next.write)) throw new ToolingActivationError("state-format-incompatible", `${family} write format ${next.write} is unreadable by release ${release.revision}, which still has unfinished operations; defer until they finish`);
    }
  }
}

async function replay(store: Store, requestKey: string, digest: string): Promise<ToolingReleaseSelection | null> {
  const receipt = await store.toolingActivation.findUnique({ where: { requestKey } });
  if (!receipt) return null;
  if (receipt.requestDigest !== digest) throw new ToolingActivationError("request-conflict", "Activation request key was already used with a different request");
  const release = record(await store.toolingRelease.findUniqueOrThrow({ where: { id: receipt.releaseId } }));
  if (receipt.outcome === "restart-required" && !receipt.promotedAt) throw new ToolingActivationError("restart-required", `Release ${release.revision} changes team policy; it becomes generation ${receipt.generation} at the next server start`, { generation: receipt.generation, release });
  return { repositoryId: receipt.repositoryId, generation: receipt.generation, release };
}

/** Owner activation. Preparation happens before the transaction; any failure
 * leaves the active selection unchanged. Policy changes are deferred to boot. */
export async function activateToolingRelease(input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string; requestKey: string; revision: string; expectedGeneration: number },
  dependencies: { prepare: typeof prepareToolingRelease } = { prepare: prepareToolingRelease }): Promise<ToolingReleaseSelection> {
  const parsed = ActivationRequest.safeParse({ repositoryId: input.repositoryId, requestKey: input.requestKey, revision: input.revision, expectedGeneration: input.expectedGeneration });
  if (!parsed.success) throw new ToolingActivationError("invalid-request", parsed.error.issues.map(issue => issue.message).join("; "));
  const request = parsed.data, digest = canonicalDigest(request);
  const prior = await replay(input.prisma, request.requestKey, digest);
  if (prior) return prior;
  const repository = input.config.repositories[request.repositoryId];
  if (!repository?.tooling) throw new ToolingActivationError("repository-unavailable", `Repository ${request.repositoryId} has no configured tooling source`);
  const assertGeneration = async (store: Store) => {
    const current = await store.toolingSelection.findUnique({ where: { repositoryId: request.repositoryId } });
    if ((current?.generation ?? 0) !== request.expectedGeneration) throw new ToolingActivationError("generation-conflict", `Active generation is ${current?.generation ?? 0}, not ${request.expectedGeneration}`);
    if (await store.toolingPendingActivation.findUnique({ where: { repositoryId: request.repositoryId } })) throw new ToolingActivationError("pending-restart", "A policy-changing activation is waiting for server restart");
  };
  await assertGeneration(input.prisma);
  let prepared: PreparedToolingRelease;
  try { prepared = await dependencies.prepare({ repositoryId: request.repositoryId, toolingRoot: repository.tooling.root, installRoot: input.config.installRoot, revision: request.revision }); }
  catch (error) { throw new ToolingActivationError("preparation-failed", error instanceof Error ? error.message : String(error)); }
  if (prepared.revision !== request.revision || prepared.repositoryId !== request.repositoryId) throw new ToolingActivationError("preparation-failed", "Prepared release identity changed");
  const restart = !repository.tooling.policyBlob || prepared.policyBlob !== repository.tooling.policyBlob;
  try {
    return await input.prisma.$transaction(async (tx) => {
      const raced = await replay(tx, request.requestKey, digest);
      if (raced) return raced;
      await assertGeneration(tx);
      await assertStateFormats(tx, request.repositoryId, prepared);
      const id = releaseId(prepared);
      const values = { repositoryId: prepared.repositoryId, revision: prepared.revision, tree: prepared.tree, policyBlob: prepared.policyBlob, checkout: prepared.checkout,
        manifest: prepared.manifest as unknown as Prisma.InputJsonValue, lockfileDigest: prepared.lockfileDigest, bunVersion: prepared.bunVersion };
      const existing = await tx.toolingRelease.findUnique({ where: { id } });
      if (!existing) await tx.toolingRelease.create({ data: { id, ...values } });
      else if (existing.repositoryId !== values.repositoryId || existing.revision !== values.revision || existing.tree !== values.tree || existing.policyBlob !== values.policyBlob
        || existing.checkout !== values.checkout || existing.lockfileDigest !== values.lockfileDigest || canonicalDigest(existing.manifest) !== canonicalDigest(values.manifest)) {
        throw new ToolingActivationError("preparation-failed", `Recorded release ${prepared.revision} differs from its re-prepared identity`);
      }
      const generation = request.expectedGeneration + 1;
      const receipt = { requestKey: request.requestKey, repositoryId: request.repositoryId, requestDigest: digest, revision: request.revision,
        expectedGeneration: request.expectedGeneration, releaseId: id, generation };
      if (restart) {
        await tx.toolingPendingActivation.create({ data: { repositoryId: request.repositoryId, requestKey: request.requestKey, releaseId: id, expectedGeneration: request.expectedGeneration } });
        await tx.toolingActivation.create({ data: { ...receipt, outcome: "restart-required" } });
        return null;
      }
      const now = new Date();
      if (request.expectedGeneration === 0) await tx.toolingSelection.create({ data: { repositoryId: request.repositoryId, generation, releaseId: id, activatedAt: now } });
      else if ((await tx.toolingSelection.updateMany({ where: { repositoryId: request.repositoryId, generation: request.expectedGeneration }, data: { generation, releaseId: id, activatedAt: now } })).count !== 1) {
        throw new ToolingActivationError("generation-conflict", "Active generation changed during activation");
      }
      await tx.toolingActivation.create({ data: { ...receipt, outcome: "activated" } });
      return { repositoryId: request.repositoryId, generation, release: record((await tx.toolingRelease.findUniqueOrThrow({ where: { id } }))) };
    }).then(async result => result ?? (await replay(input.prisma, request.requestKey, digest))!);
  } catch (error) {
    if (error instanceof ToolingActivationError) throw error;
    // A concurrent identical request may have committed first (lost race or
    // lost acknowledgement): return its exact recorded result.
    const winner = await replay(input.prisma, request.requestKey, digest);
    if (winner) return winner;
    if (isUniqueViolation(error)) throw new ToolingActivationError("generation-conflict", "Another activation won this generation");
    throw error;
  }
}

/** Server boot, before policy resolution: promote a pending policy-changing
 * activation (only after its checkout re-verifies), then return the exact
 * selected revision per repository. Never resolves a moving ref. */
export async function bootToolingSelections(input: { prisma: PrismaClient; configuredRepositoryIds: string[]; log?: (message: string) => void },
  verify: typeof verifyPreparedToolingRelease = verifyPreparedToolingRelease): Promise<Record<string, string>> {
  const log = input.log ?? ((message: string) => console.warn(message));
  for (const pending of await input.prisma.toolingPendingActivation.findMany()) {
    try {
      const release = await input.prisma.toolingRelease.findUniqueOrThrow({ where: { id: pending.releaseId } });
      await verify(release);
      await input.prisma.$transaction(async (tx) => {
        const current = await tx.toolingSelection.findUnique({ where: { repositoryId: pending.repositoryId } });
        if ((current?.generation ?? 0) !== pending.expectedGeneration) throw new Error(`Pending activation ${pending.requestKey} expected generation ${pending.expectedGeneration}`);
        const generation = pending.expectedGeneration + 1, now = new Date();
        if (current) {
          if ((await tx.toolingSelection.updateMany({ where: { repositoryId: pending.repositoryId, generation: pending.expectedGeneration }, data: { generation, releaseId: release.id, activatedAt: now } })).count !== 1) throw new Error("Active generation changed during promotion");
        } else await tx.toolingSelection.create({ data: { repositoryId: pending.repositoryId, generation, releaseId: release.id, activatedAt: now } });
        await tx.toolingActivation.update({ where: { requestKey: pending.requestKey }, data: { promotedAt: now } });
        await tx.toolingPendingActivation.delete({ where: { repositoryId: pending.repositoryId } });
      });
    } catch (error) {
      log(`Tooling activation ${pending.requestKey} remains pending: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const revisions: Record<string, string> = {};
  for (const selection of await input.prisma.toolingSelection.findMany({ where: { repositoryId: { in: input.configuredRepositoryIds } } })) {
    revisions[selection.repositoryId] = (await input.prisma.toolingRelease.findUniqueOrThrow({ where: { id: selection.releaseId } })).revision;
  }
  return revisions;
}

/** After `readConfig` with the boot selections: the resolved policy must be
 * exactly the durable release's committed policy. */
export async function assertBootToolingPolicy(input: { prisma: PrismaClient; config: ServerConfig }): Promise<void> {
  for (const [repositoryId, repository] of Object.entries(input.config.repositories)) {
    const selection = await selectionOf(input.prisma, repositoryId);
    if (!selection) continue;
    const tooling = repository.tooling;
    if (!tooling || tooling.revision !== selection.release.revision || tooling.policyBlob !== selection.release.policyBlob) {
      throw new Error(`Repository ${repositoryId} policy does not match durable tooling generation ${selection.generation} (${selection.release.revision})`);
    }
  }
}

const OperationRequest = z.strictObject({
  requestKey: z.string().min(1).max(256),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  existingOperationId: z.string().min(1).max(512).optional(),
  resourceKey: z.string().min(1).max(512).optional(),
});

async function binding(store: Store, row: ToolingOperation): Promise<ToolingOperationBinding> {
  return { contract: "remote-agent.tooling-operation/v1", operationId: row.id, requestKey: row.requestKey, inputDigest: row.inputDigest, repositoryId: row.repositoryId,
    taskId: row.taskId, sessionId: row.sessionId, turnId: row.turnId, kind: row.kind, existingOperationId: row.existingOperationId, resourceKey: row.resourceKey,
    generation: row.generation, release: record(await store.toolingRelease.findUniqueOrThrow({ where: { id: row.releaseId } })),
    status: z.enum(["bound", "running", "unknown", "completed"]).parse(row.status) };
}

/** Persist operation identity before any effect. A new request binds the
 * active selection; a retry returns its original binding regardless of later
 * activations. Operation-specific authority remains the caller's (DRA-29). */
export async function bindToolingOperation(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; sessionId: string; turnId: string | null; request: BeginToolingOperationRequest }): Promise<ToolingOperationBinding> {
  const parsed = OperationRequest.safeParse(input.request);
  if (!parsed.success) throw new ToolingOperationError("invalid-request", parsed.error.issues.map(issue => issue.message).join("; "));
  const request = parsed.data;
  if (input.turnId !== null && (typeof input.turnId !== "string" || !input.turnId || input.turnId.length > 256)) throw new ToolingOperationError("invalid-request", "Invalid turn identity");
  const task = await input.prisma.remoteTask.findUnique({ where: { id: input.taskId } });
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  if (!task || !session || task.primarySessionId !== session.id || session.role !== "primary" || session.repositoryId !== task.repositoryId
    || session.machineId !== task.machineId || task.machineId !== input.config.machine) throw new ToolingOperationError("ownership", "Only the task's own primary session may bind a tooling operation");
  const retained = async (store: Store) => {
    const row = await store.toolingOperation.findUnique({ where: { taskId_requestKey: { taskId: task.id, requestKey: request.requestKey } } });
    if (!row) return null;
    if (row.sessionId !== session.id || row.kind !== request.kind || row.inputDigest !== request.inputDigest
      || row.existingOperationId !== (request.existingOperationId ?? null) || row.resourceKey !== (request.resourceKey ?? null)) {
      throw new ToolingOperationError("request-conflict", "Operation request key was already used with a different request");
    }
    return binding(store, row);
  };
  const prior = await retained(input.prisma);
  if (prior) return prior;
  try {
    return await input.prisma.$transaction(async (tx) => {
      const raced = await retained(tx);
      if (raced) return raced;
      const selection = await selectionOf(tx, task.repositoryId);
      if (!selection) throw new ToolingOperationError("no-active-release", `Repository ${task.repositoryId} has no release-aware active tooling generation`);
      const protocol = Math.min(SERVER_TOOLING_PROTOCOL.max, selection.release.manifest.serverProtocol.max);
      if (protocol < Math.max(SERVER_TOOLING_PROTOCOL.min, selection.release.manifest.serverProtocol.min)) throw new ToolingOperationError("unsupported-protocol", "Active release has no operation protocol in common with this server");
      const row = await tx.toolingOperation.create({ data: { id: randomUUID(), taskId: task.id, requestKey: request.requestKey, inputDigest: request.inputDigest, kind: request.kind,
        repositoryId: task.repositoryId, sessionId: session.id, turnId: input.turnId, existingOperationId: request.existingOperationId ?? null, resourceKey: request.resourceKey ?? null,
        generation: selection.generation, releaseId: selection.release.id, protocol } });
      return binding(tx, row);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await retained(input.prisma);
    if (winner) return winner;
    throw error;
  }
}

export async function readToolingOperation(input: { prisma: PrismaClient; operationId: string }): Promise<ToolingOperationBinding | null> {
  const row = await input.prisma.toolingOperation.findUnique({ where: { id: input.operationId } });
  return row ? binding(input.prisma, row) : null;
}
