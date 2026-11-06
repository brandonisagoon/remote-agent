import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient, ToolingOperation, ToolingRelease } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { BeginToolingOperationRequest, ToolingOperationBinding, ToolingReleaseRecord, ToolingReleaseSelection, ToolingStateFormat } from "../../../../types/tooling-release.ts";
import { SERVER_TOOLING_PROTOCOL, ToolingReleaseManifestSchema, prepareToolingRelease, verifyPreparedToolingRelease, type PreparedToolingRelease } from "./tooling.ts";

/** Internal implementation-completeness guard. Externally callable activation
 * stays unavailable until integration verifies every DRA-29/30 consumer binds
 * operations. This is not configuration and not a per-task capability. */
export const TOOLING_ACTIVATION_ENABLED = false;

export type ToolingActivationErrorCode = "invalid-request" | "repository-unavailable" | "request-conflict" | "generation-conflict"
  | "restart-required" | "preparation-failed" | "state-format-incompatible" | "legacy-inventory-unavailable";
export class ToolingActivationError extends Error {
  constructor(readonly code: ToolingActivationErrorCode, message: string, readonly detail?: { generation?: number; release?: ToolingReleaseRecord }) { super(message); }
}
export type ToolingOperationErrorCode = "invalid-request" | "ownership" | "no-active-release" | "request-conflict" | "unsupported-protocol"
  | "not-found" | "invalid-transition" | "transition-conflict" | "evidence-required";
export class ToolingOperationError extends Error {
  constructor(readonly code: ToolingOperationErrorCode, message: string) { super(message); }
}

/** Readers of pre-protocol releases. They strip unknown top-level fields and
 * read only version 1; they are never treated as preserving unknown data. */
export const LEGACY_STATE_FORMATS: Readonly<Record<string, ToolingStateFormat>> = { "drafted.runtime": { read: [1], write: 1, preservesUnknown: false } };

type Store = Pick<PrismaClient, "toolingRelease" | "toolingSelection" | "toolingActivation" | "toolingOperation" | "toolingStateWrite" | "toolingLegacyBoundary" | "toolingLegacyConsumer">;
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

/** Latest actual written format per task/family/scope across a repository. */
async function latestStateWrites(store: Pick<Store, "toolingStateWrite">, where: { repositoryId?: string; taskId?: string; family?: string; scopeKey?: string }) {
  const latest = new Map<string, Awaited<ReturnType<Store["toolingStateWrite"]["findMany"]>>[number]>();
  for (const row of await store.toolingStateWrite.findMany({ where, orderBy: { sequence: "asc" } })) latest.set(JSON.stringify([row.taskId, row.family, row.scopeKey]), row);
  return [...latest.values()];
}

/** Rollback/forward safety from durable evidence, not manifests alone: the
 * candidate must read every actually committed format version (including
 * after its writer completed) and, while pre-protocol consumers are retained,
 * the legacy formats. A family it does not declare never passes silently.
 * Potential candidate writes are restricted per state at registration time. */
async function assertStateFormats(store: Store, repositoryId: string, candidate: PreparedToolingRelease) {
  const need = (family: string, version: number, why: string) => {
    const format = candidate.manifest.stateFormats[family];
    if (!format) throw new ToolingActivationError("state-format-incompatible", `${candidate.revision} does not declare state format ${family}, required by ${why}`);
    if (!format.read.includes(version)) throw new ToolingActivationError("state-format-incompatible", `${candidate.revision} cannot read ${family} version ${version}, required by ${why}`);
  };
  for (const row of await latestStateWrites(store, { repositoryId })) need(row.family, row.version, `task ${row.taskId} state ${row.scopeKey}`);
  if (await store.toolingLegacyConsumer.count({ where: { repositoryId, status: "retained" } })) {
    for (const [family, format] of Object.entries(LEGACY_STATE_FORMATS)) need(family, format.write, "retained pre-protocol consumers");
  }
}

async function replay(store: Store, requestKey: string, digest: string): Promise<ToolingReleaseSelection | null> {
  const receipt = await store.toolingActivation.findUnique({ where: { requestKey } });
  if (!receipt) return null;
  if (receipt.requestDigest !== digest) throw new ToolingActivationError("request-conflict", "Activation request key was already used with a different request");
  const release = record(await store.toolingRelease.findUniqueOrThrow({ where: { id: receipt.releaseId } }));
  if (receipt.outcome === "restart-required") throw new ToolingActivationError("restart-required", `Release ${release.revision} changes team policy; live activation was rejected and the selection is unchanged`, { generation: receipt.generation, release });
  return { repositoryId: receipt.repositoryId, generation: receipt.generation, release };
}

export interface ToolingLegacyConsumerInput {
  taskId: string;
  consumerKind: string;
  consumerId: string;
  /** Exact original executable/observer receipt, or an explicit diagnosis. */
  provenance: { revision: string; checkout: string; receipt: unknown } | { unavailable: string };
}
/** DRA-29 enumerates existing consumers inside the first activation
 * transaction. It must not infer provenance from the current configuration. */
export type ToolingLegacyInventory = (tx: Prisma.TransactionClient, input: { repositoryId: string; legacyRevision: string | null }) => Promise<ToolingLegacyConsumerInput[]>;
const legacyInventoryUnavailable: ToolingLegacyInventory = async () => {
  throw new ToolingActivationError("legacy-inventory-unavailable", "First activation requires the integrated legacy consumer inventory");
};
const Identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const LegacyConsumerInput = z.strictObject({ taskId: z.string().min(1).max(256), consumerKind: Identifier, consumerId: z.string().min(1).max(512),
  provenance: z.union([z.strictObject({ revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), checkout: z.string().startsWith("/").max(4096), receipt: z.unknown() }),
    z.strictObject({ unavailable: z.string().min(1).max(2000) })]) });

/** Owner activation. Preparation happens before the transaction; any failure
 * leaves the active selection unchanged. A policy change is rejected as
 * restart-required and is never queued or promoted later. Generation 1
 * atomically records the bootstrap boundary and legacy consumer inventory. */
export async function activateToolingRelease(input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string; requestKey: string; revision: string; expectedGeneration: number },
  dependencies: { prepare?: typeof prepareToolingRelease; inventoryLegacyConsumers?: ToolingLegacyInventory } = {}): Promise<ToolingReleaseSelection> {
  const prepare = dependencies.prepare ?? prepareToolingRelease, inventory = dependencies.inventoryLegacyConsumers ?? legacyInventoryUnavailable;
  const parsed = ActivationRequest.safeParse({ repositoryId: input.repositoryId, requestKey: input.requestKey, revision: input.revision, expectedGeneration: input.expectedGeneration });
  if (!parsed.success) throw new ToolingActivationError("invalid-request", parsed.error.issues.map(issue => issue.message).join("; "));
  const request = parsed.data, digest = canonicalDigest(request);
  const prior = await replay(input.prisma, request.requestKey, digest);
  if (prior) return prior;
  const repository = input.config.repositories[request.repositoryId];
  if (!repository?.tooling) throw new ToolingActivationError("repository-unavailable", `Repository ${request.repositoryId} has no configured tooling source`);
  const legacyRevision = repository.tooling.revision;
  const assertGeneration = async (store: Store) => {
    const current = await store.toolingSelection.findUnique({ where: { repositoryId: request.repositoryId } });
    if ((current?.generation ?? 0) !== request.expectedGeneration) throw new ToolingActivationError("generation-conflict", `Active generation is ${current?.generation ?? 0}, not ${request.expectedGeneration}`);
  };
  await assertGeneration(input.prisma);
  let prepared: PreparedToolingRelease;
  try { prepared = await prepare({ repositoryId: request.repositoryId, toolingRoot: repository.tooling.root, installRoot: input.config.installRoot, revision: request.revision }); }
  catch (error) { throw new ToolingActivationError("preparation-failed", error instanceof Error ? error.message : String(error)); }
  if (prepared.revision !== request.revision || prepared.repositoryId !== request.repositoryId) throw new ToolingActivationError("preparation-failed", "Prepared release identity changed");
  const restart = !repository.tooling.policyBlob || prepared.policyBlob !== repository.tooling.policyBlob;
  try {
    const result = await input.prisma.$transaction(async (tx) => {
      const raced = await replay(tx, request.requestKey, digest);
      if (raced) return raced;
      await assertGeneration(tx);
      const id = releaseId(prepared);
      const values = { repositoryId: prepared.repositoryId, revision: prepared.revision, tree: prepared.tree, policyBlob: prepared.policyBlob, checkout: prepared.checkout,
        manifest: prepared.manifest as unknown as Prisma.InputJsonValue, lockfileDigest: prepared.lockfileDigest, bunVersion: prepared.bunVersion };
      const existing = await tx.toolingRelease.findUnique({ where: { id } });
      if (!existing) await tx.toolingRelease.create({ data: { id, ...values } });
      else if (existing.repositoryId !== values.repositoryId || existing.revision !== values.revision || existing.tree !== values.tree || existing.policyBlob !== values.policyBlob
        || existing.checkout !== values.checkout || existing.lockfileDigest !== values.lockfileDigest || canonicalDigest(existing.manifest) !== canonicalDigest(values.manifest)) {
        throw new ToolingActivationError("preparation-failed", `Recorded release ${prepared.revision} differs from its re-prepared identity`);
      }
      const receipt = { requestKey: request.requestKey, repositoryId: request.repositoryId, requestDigest: digest, revision: request.revision, expectedGeneration: request.expectedGeneration, releaseId: id };
      if (restart) {
        // A durable rejection: replay returns it, nothing is queued or blocked.
        await tx.toolingActivation.create({ data: { ...receipt, outcome: "restart-required", generation: request.expectedGeneration } });
        return null;
      }
      const generation = request.expectedGeneration + 1, now = new Date();
      if (request.expectedGeneration === 0) {
        if (await tx.toolingLegacyBoundary.findUnique({ where: { repositoryId: request.repositoryId } })) throw new ToolingActivationError("generation-conflict", "Bootstrap boundary already exists for this repository");
        const consumers = (await inventory(tx, { repositoryId: request.repositoryId, legacyRevision })).map(value => LegacyConsumerInput.parse(value));
        if (new Set(consumers.map(value => `${value.consumerKind}\0${value.consumerId}`)).size !== consumers.length) throw new ToolingActivationError("invalid-request", "Legacy consumer inventory contains duplicates");
        await tx.toolingLegacyBoundary.create({ data: { repositoryId: request.repositoryId, activationRequestKey: request.requestKey, legacyRevision, recordedAt: now } });
        for (const value of consumers) {
          await tx.toolingLegacyConsumer.create({ data: { id: randomUUID(), repositoryId: request.repositoryId, taskId: value.taskId, consumerKind: value.consumerKind, consumerId: value.consumerId,
            ...("unavailable" in value.provenance ? { provenance: "unavailable", detail: value.provenance.unavailable }
              : { provenance: "exact", revision: value.provenance.revision, checkout: value.provenance.checkout,
                ...(value.provenance.receipt == null ? {} : { receipt: value.provenance.receipt as Prisma.InputJsonValue }) }) } });
        }
        await assertStateFormats(tx, request.repositoryId, prepared);
        await tx.toolingSelection.create({ data: { repositoryId: request.repositoryId, generation, releaseId: id, activatedAt: now } });
      } else {
        await assertStateFormats(tx, request.repositoryId, prepared);
        if ((await tx.toolingSelection.updateMany({ where: { repositoryId: request.repositoryId, generation: request.expectedGeneration }, data: { generation, releaseId: id, activatedAt: now } })).count !== 1) {
          throw new ToolingActivationError("generation-conflict", "Active generation changed during activation");
        }
      }
      await tx.toolingActivation.create({ data: { ...receipt, outcome: "activated", generation } });
      return { repositoryId: request.repositoryId, generation, release: record((await tx.toolingRelease.findUniqueOrThrow({ where: { id } }))) };
    });
    return result ?? (await replay(input.prisma, request.requestKey, digest))!;
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

/** Server boot, before policy resolution. Read-only: validates each retained
 * selection's prepared checkout and returns its exact revision. Never writes,
 * promotes or resolves a moving ref. */
export async function bootToolingSelections(input: { prisma: PrismaClient; configuredRepositoryIds: string[] },
  verify: typeof verifyPreparedToolingRelease = verifyPreparedToolingRelease): Promise<Record<string, string>> {
  const revisions: Record<string, string> = {};
  for (const selection of await input.prisma.toolingSelection.findMany({ where: { repositoryId: { in: input.configuredRepositoryIds } } })) {
    const release = await input.prisma.toolingRelease.findUnique({ where: { id: selection.releaseId } });
    if (!release || release.repositoryId !== selection.repositoryId) throw new Error(`Repository ${selection.repositoryId} tooling generation ${selection.generation} has no matching release record`);
    try { await verify(release); }
    catch (error) { throw new Error(`Repository ${selection.repositoryId} tooling generation ${selection.generation} (${release.revision}) failed verification: ${error instanceof Error ? error.message : String(error)}`); }
    revisions[selection.repositoryId] = release.revision;
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

const TRANSITIONS: Readonly<Record<ToolingOperationBinding["status"], readonly ToolingOperationBinding["status"][]>> = {
  bound: ["running", "completed"], running: ["unknown", "completed"], unknown: ["completed"], completed: [],
};
const Evidence = z.strictObject({ kind: Identifier, reference: z.string().min(1).max(512) });

/** Compare-and-swap lifecycle change. Completion always requires the caller's
 * existing protocol receipt (offer/claim/cleanup proof/receipt reference); an
 * unknown outcome never becomes success generically. Rows are never deleted. */
export async function transitionToolingOperation(input: { prisma: PrismaClient; operationId: string; from: ToolingOperationBinding["status"]; to: ToolingOperationBinding["status"]; evidence?: { kind: string; reference: string } }): Promise<ToolingOperationBinding> {
  if (!(input.from in TRANSITIONS) || !TRANSITIONS[input.from].includes(input.to)) throw new ToolingOperationError("invalid-transition", `Tooling operation cannot move from ${input.from} to ${input.to}`);
  let evidence: z.infer<typeof Evidence> | undefined;
  if (input.to === "completed") {
    const parsed = Evidence.safeParse(input.evidence);
    if (!parsed.success) throw new ToolingOperationError("evidence-required", "Completing a tooling operation requires its existing protocol evidence");
    evidence = parsed.data;
  } else if (input.evidence !== undefined) throw new ToolingOperationError("invalid-request", "Only completion records evidence");
  const updated = await input.prisma.toolingOperation.updateMany({ where: { id: input.operationId, status: input.from },
    data: { status: input.to, ...(evidence ? { completionEvidence: evidence } : {}) } });
  const row = await input.prisma.toolingOperation.findUnique({ where: { id: input.operationId } });
  if (!row) throw new ToolingOperationError("not-found", "Tooling operation not found");
  if (updated.count !== 1) throw new ToolingOperationError("transition-conflict", `Tooling operation is ${row.status}, not ${input.from}`);
  return binding(input.prisma, row);
}

export type ToolingStateFormatErrorCode = "not-found" | "invalid-request" | "operation-closed" | "undeclared-format" | "wrong-write-version" | "would-rewind" | "unreadable-state" | "deferred";
export class ToolingStateFormatError extends Error {
  constructor(readonly code: ToolingStateFormatErrorCode, message: string) { super(message); }
}
export interface ToolingStateVersion { version: number; preservesUnknown: boolean; operationId: string; releaseId: string; sequence: number }
const StateKey = z.strictObject({ family: z.string().regex(/^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63}){1,3}$/), scopeKey: z.string().min(1).max(512) });

async function operationContext(store: Store, operationId: string) {
  const row = await store.toolingOperation.findUnique({ where: { id: operationId } });
  if (!row) throw new ToolingStateFormatError("not-found", "Tooling operation not found");
  return { row, release: record(await store.toolingRelease.findUniqueOrThrow({ where: { id: row.releaseId } })) };
}

/** Latest actually registered format for one task state, or null. */
export async function readToolingStateVersion(input: { prisma: PrismaClient; taskId: string; family: string; scopeKey: string }): Promise<ToolingStateVersion | null> {
  const key = StateKey.parse({ family: input.family, scopeKey: input.scopeKey });
  const row = (await latestStateWrites(input.prisma, { taskId: input.taskId, ...key }))[0];
  return row ? { version: row.version, preservesUnknown: row.preservesUnknown, operationId: row.operationId, releaseId: row.releaseId, sequence: row.sequence } : null;
}

/** Before an operation reads (and possibly rewrites) task state: its bound
 * release must read the actual latest version. With no evidence yet, a legacy
 * family is assumed to be at its pre-protocol version (fail closed). */
export async function assertToolingStateReadable(input: { prisma: PrismaClient; operationId: string; family: string; scopeKey: string }): Promise<{ version: number | null; source: "recorded" | "legacy-assumed" | "none" }> {
  const key = StateKey.parse({ family: input.family, scopeKey: input.scopeKey });
  const { row, release } = await operationContext(input.prisma, input.operationId);
  const latest = await readToolingStateVersion({ prisma: input.prisma, taskId: row.taskId, ...key });
  const legacy = LEGACY_STATE_FORMATS[key.family];
  const version = latest?.version ?? legacy?.write ?? null;
  if (version === null) return { version: null, source: "none" };
  const format = release.manifest.stateFormats[key.family];
  if (!format) throw new ToolingStateFormatError("undeclared-format", `Operation ${row.id} release ${release.revision} does not declare ${key.family}`);
  if (!format.read.includes(version)) throw new ToolingStateFormatError("unreadable-state", `Operation ${row.id} release ${release.revision} cannot read ${key.family} version ${version} for task ${row.taskId} state ${key.scopeKey}`);
  return { version, source: latest ? "recorded" : "legacy-assumed" };
}

/** Register a format write BEFORE persisting it. Writes are restricted per
 * affected task state: a version an unfinished consumer of another release
 * (or a retained legacy consumer) of that state cannot read is deferred;
 * unrelated operations and activation are unaffected. Idempotent per
 * operation/family/scope/version; evidence is retained after completion. */
export async function registerToolingStateWrite(input: { prisma: PrismaClient; operationId: string; family: string; scopeKey: string; version: number }): Promise<ToolingStateVersion> {
  const key = StateKey.parse({ family: input.family, scopeKey: input.scopeKey });
  if (!Number.isInteger(input.version) || input.version < 1) throw new ToolingStateFormatError("invalid-request", "State format version must be a positive integer");
  const attempt = () => input.prisma.$transaction(async (tx) => {
    const { row, release } = await operationContext(tx, input.operationId);
    const existing = await tx.toolingStateWrite.findUnique({ where: { operationId_family_scopeKey_version: { operationId: row.id, ...key, version: input.version } } });
    if (existing) return existing;
    if (row.status !== "bound" && row.status !== "running") throw new ToolingStateFormatError("operation-closed", `Operation ${row.id} is ${row.status}; it cannot register new state writes`);
    const format = release.manifest.stateFormats[key.family];
    if (!format) throw new ToolingStateFormatError("undeclared-format", `Release ${release.revision} does not declare ${key.family}`);
    if (format.write !== input.version) throw new ToolingStateFormatError("wrong-write-version", `Release ${release.revision} writes ${key.family} version ${format.write}, not ${input.version}`);
    const latest = (await latestStateWrites(tx, { taskId: row.taskId, ...key }))[0];
    const current = latest?.version ?? LEGACY_STATE_FORMATS[key.family]?.write;
    if (current !== undefined && current > input.version) throw new ToolingStateFormatError("would-rewind", `${key.family} for task ${row.taskId} state ${key.scopeKey} is already version ${current}`);
    if (current !== undefined && !format.read.includes(current)) throw new ToolingStateFormatError("unreadable-state", `Release ${release.revision} cannot read ${key.family} version ${current}`);
    const others = await tx.toolingOperation.findMany({ where: { taskId: row.taskId, status: { in: RETAINED }, id: { not: row.id }, releaseId: { not: row.releaseId } } });
    for (const other of others) {
      if (other.resourceKey !== null && key.scopeKey !== "task" && other.resourceKey !== key.scopeKey) continue;
      const reader = record(await tx.toolingRelease.findUniqueOrThrow({ where: { id: other.releaseId } })).manifest.stateFormats[key.family];
      if (!reader || !reader.read.includes(input.version)) throw new ToolingStateFormatError("deferred", `Unfinished operation ${other.id} cannot read ${key.family} version ${input.version}; defer this write until it finishes`);
    }
    const legacyReader = LEGACY_STATE_FORMATS[key.family];
    const legacy = await tx.toolingLegacyConsumer.findFirst({ where: { repositoryId: row.repositoryId, taskId: row.taskId, status: "retained" } });
    if (legacy && (!legacyReader || !legacyReader.read.includes(input.version))) throw new ToolingStateFormatError("deferred", `Retained pre-protocol consumer ${legacy.consumerKind}:${legacy.consumerId} cannot read ${key.family} version ${input.version}`);
    return tx.toolingStateWrite.create({ data: { repositoryId: row.repositoryId, taskId: row.taskId, ...key, version: input.version, preservesUnknown: format.preservesUnknown, operationId: row.id, releaseId: row.releaseId } });
  });
  let written;
  try { written = await attempt(); }
  catch (error) { if (!isUniqueViolation(error)) throw error; written = await attempt(); }
  return { version: written.version, preservesUnknown: written.preservesUnknown, operationId: written.operationId, releaseId: written.releaseId, sequence: written.sequence };
}

export type ToolingLegacyConsumerState =
  | { status: "no-boundary" }
  | { status: "not-legacy"; boundaryRequestKey: string }
  | { status: "legacy"; id: string; taskId: string; revision: string; checkout: string; receipt: unknown }
  | { status: "unavailable"; id: string; taskId: string; detail: string }
  | { status: "resolved"; id: string; taskId: string; resolution: unknown };

/** Exact pre-boundary provenance for a consumer. Never substitutes the active
 * release: no boundary means legacy rules still apply; a consumer absent from
 * the inventory was created after the boundary and needs its own binding. */
export async function readToolingLegacyConsumer(input: { prisma: PrismaClient; repositoryId: string; consumerKind: string; consumerId: string }): Promise<ToolingLegacyConsumerState> {
  const boundary = await input.prisma.toolingLegacyBoundary.findUnique({ where: { repositoryId: input.repositoryId } });
  if (!boundary) return { status: "no-boundary" };
  const row = await input.prisma.toolingLegacyConsumer.findUnique({ where: { repositoryId_consumerKind_consumerId: { repositoryId: input.repositoryId, consumerKind: input.consumerKind, consumerId: input.consumerId } } });
  if (!row) return { status: "not-legacy", boundaryRequestKey: boundary.activationRequestKey };
  if (row.status === "resolved") return { status: "resolved", id: row.id, taskId: row.taskId, resolution: row.resolution };
  if (row.provenance === "unavailable") return { status: "unavailable", id: row.id, taskId: row.taskId, detail: row.detail ?? "Original provenance unavailable" };
  return { status: "legacy", id: row.id, taskId: row.taskId, revision: row.revision!, checkout: row.checkout!, receipt: row.receipt };
}

export async function readToolingLegacyBoundary(input: { prisma: PrismaClient; repositoryId: string }) {
  return input.prisma.toolingLegacyBoundary.findUnique({ where: { repositoryId: input.repositoryId } });
}

/** CAS retained -> resolved with the existing protocol evidence that the
 * legacy consumer finished. The row and its original snapshot are kept. */
export async function resolveToolingLegacyConsumer(input: { prisma: PrismaClient; id: string; evidence: { kind: string; reference: string } }): Promise<void> {
  const evidence = Evidence.safeParse(input.evidence);
  if (!evidence.success) throw new ToolingOperationError("evidence-required", "Resolving a legacy consumer requires its existing protocol evidence");
  const updated = await input.prisma.toolingLegacyConsumer.updateMany({ where: { id: input.id, status: "retained" }, data: { status: "resolved", resolution: evidence.data, resolvedAt: new Date() } });
  if (updated.count !== 1) throw new ToolingOperationError((await input.prisma.toolingLegacyConsumer.findUnique({ where: { id: input.id } })) ? "transition-conflict" : "not-found", "Legacy consumer is not retained");
}
