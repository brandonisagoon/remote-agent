import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient, ToolingOperation, ToolingRelease } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { BeginToolingOperationRequest, ToolingOperationBinding, ToolingReleaseRecord, ToolingReleaseSelection, ToolingStateFormat } from "../../../../types/tooling-release.ts";
import { SERVER_TOOLING_PROTOCOL, ToolingReleaseManifestSchema, prepareToolingRelease, verifyPreparedToolingRelease, type PreparedToolingRelease } from "./tooling.ts";

/** Integrated operation consumers now support owner activation. The route is
 * bearer TCP only; enabling this source feature neither deploys a server nor
 * changes any selection. Deployment remains a separate owner action. */
export const TOOLING_ACTIVATION_ENABLED = true;

export type ToolingActivationErrorCode = "invalid-request" | "repository-unavailable" | "request-conflict" | "generation-conflict"
  | "restart-required" | "preparation-failed" | "state-format-incompatible" | "legacy-inventory-unavailable";
export class ToolingActivationError extends Error {
  constructor(readonly code: ToolingActivationErrorCode, message: string, readonly detail?: { generation?: number; release?: ToolingReleaseRecord }) { super(message); }
}
export type ToolingOperationErrorCode = "invalid-request" | "ownership" | "no-active-release" | "request-conflict" | "unsupported-protocol"
  | "not-found" | "invalid-transition" | "transition-conflict" | "evidence-required" | "invalid-parent" | "parent-unavailable"
  | "operation-closed" | "consumer-unavailable";
/** The only operation kind that may parent callback bindings. */
export const ADAPTER_COMMAND_KIND = "adapter-command";
export class ToolingOperationError extends Error {
  constructor(readonly code: ToolingOperationErrorCode, message: string) { super(message); }
}

/** Readers of pre-protocol releases. They strip unknown top-level fields and
 * read only version 1; they are never treated as preserving unknown data. */
export const LEGACY_STATE_FORMATS: Readonly<Record<string, ToolingStateFormat>> = { "drafted.runtime": { read: [1], write: 1, preservesUnknown: false } };

type Store = Pick<PrismaClient, "toolingRelease" | "toolingSelection" | "toolingActivation" | "toolingOperation" | "toolingStateWrite" | "toolingLegacyBoundary" | "toolingLegacyConsumer" | "toolingRetainedConsumer">;
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
/** Retained consumers that still execute their producing release. */
const LIVE_CONSUMER = ["pending", "confirmed"];

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
  // A retained consumer keeps executing its producing release, which may still
  // persist any version it declares writable; the candidate must read those.
  const retainedConsumers = await store.toolingRetainedConsumer.findMany({ where: { repositoryId, status: { in: LIVE_CONSUMER } }, select: { releaseId: true }, distinct: ["releaseId"], take: 1001 });
  if (retainedConsumers.length > 1000) throw new ToolingActivationError("state-format-incompatible", "Retained consumer inventory exceeds its bound");
  for (const { releaseId } of retainedConsumers) {
    const retained = record(await store.toolingRelease.findUniqueOrThrow({ where: { id: releaseId } }));
    if (retained.revision === candidate.revision) continue;
    for (const [family, format] of Object.entries(retained.manifest.stateFormats)) {
      for (const version of format.writeVersions ?? [format.write]) need(family, version, `retained consumers of release ${retained.revision}`);
    }
  }
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
  parentOperationId: z.string().min(1).max(256).optional(),
  resourceKey: z.string().min(1).max(512).optional(),
});

async function binding(store: Store, row: ToolingOperation): Promise<ToolingOperationBinding> {
  return { contract: "remote-agent.tooling-operation/v1", operationId: row.id, requestKey: row.requestKey, inputDigest: row.inputDigest, repositoryId: row.repositoryId,
    taskId: row.taskId, sessionId: row.sessionId, turnId: row.turnId, kind: row.kind, existingOperationId: row.existingOperationId, parentOperationId: row.parentOperationId, retainedConsumerId: row.retainedConsumerId, resourceKey: row.resourceKey,
    generation: row.generation, release: record(await store.toolingRelease.findUniqueOrThrow({ where: { id: row.releaseId } })),
    status: z.enum(["bound", "running", "unknown", "completed"]).parse(row.status) };
}

/** Persist operation identity before any effect. A new root request binds the
 * active selection; a callback with `parentOperationId` inherits its open
 * adapter-command parent's release, generation and protocol. An exact retry
 * returns its original binding (historical identity, regardless of later
 * activations or parent lifecycle); current authority stays with the route. */
export async function bindToolingOperation(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; sessionId: string; turnId: string | null; request: BeginToolingOperationRequest }): Promise<ToolingOperationBinding> {
  return bindOperation(input, null);
}

/** Server-only: bind a server-started continuation of a confirmed retained
 * consumer. It inherits that consumer's producing release, generation and
 * protocol, even after its producer completed or a newer release became
 * active. Callers (DRA-29) verify domain intent, pause and owner; this is
 * never exposed as caller-selected release in the begin route. */
export async function bindRetainedToolingOperation(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; sessionId: string; turnId: string | null; request: BeginToolingOperationRequest; retainedConsumerId: string }): Promise<ToolingOperationBinding> {
  if (typeof input.retainedConsumerId !== "string" || !input.retainedConsumerId || input.retainedConsumerId.length > 256) throw new ToolingOperationError("invalid-request", "Invalid retained consumer identity");
  if (input.request.parentOperationId) throw new ToolingOperationError("invalid-request", "A retained continuation cannot also name a parent operation");
  return bindOperation(input, input.retainedConsumerId);
}

async function bindOperation(input: { prisma: PrismaClient; config: ServerConfig; taskId: string; sessionId: string; turnId: string | null; request: BeginToolingOperationRequest }, retainedConsumerId: string | null): Promise<ToolingOperationBinding> {
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
      || row.existingOperationId !== (request.existingOperationId ?? null) || row.parentOperationId !== (request.parentOperationId ?? null)
      || row.retainedConsumerId !== retainedConsumerId || row.resourceKey !== (request.resourceKey ?? null)) {
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
      let inherited: { releaseId: string; generation: number; protocol: number };
      if (retainedConsumerId) {
        const consumer = await tx.toolingRetainedConsumer.findUnique({ where: { id: retainedConsumerId } });
        if (!consumer || consumer.taskId !== task.id || consumer.repositoryId !== task.repositoryId) throw new ToolingOperationError("ownership", "Retained consumer belongs to another task or repository");
        if (consumer.status !== "confirmed") throw new ToolingOperationError("consumer-unavailable", `Retained consumer is ${consumer.status}; only a confirmed consumer can start a continuation`);
        inherited = { releaseId: consumer.releaseId, generation: consumer.generation, protocol: consumer.protocol };
      } else if (request.parentOperationId) {
        // A callback executes its command's immutable release, read inside this
        // transaction; the active selection is never consulted for a child.
        const parent = await tx.toolingOperation.findUnique({ where: { id: request.parentOperationId } });
        if (!parent || parent.taskId !== task.id || parent.sessionId !== session.id || parent.repositoryId !== task.repositoryId || parent.kind !== ADAPTER_COMMAND_KIND) {
          throw new ToolingOperationError("invalid-parent", "Parent must be an adapter-command binding of the same task, session and repository");
        }
        if (parent.status !== "bound" && parent.status !== "running") throw new ToolingOperationError("parent-unavailable", `Parent command is ${parent.status}; it cannot start new callback effects`);
        inherited = { releaseId: parent.releaseId, generation: parent.generation, protocol: parent.protocol };
      } else {
        const selection = await selectionOf(tx, task.repositoryId);
        if (!selection) throw new ToolingOperationError("no-active-release", `Repository ${task.repositoryId} has no release-aware active tooling generation`);
        const protocol = Math.min(SERVER_TOOLING_PROTOCOL.max, selection.release.manifest.serverProtocol.max);
        if (protocol < Math.max(SERVER_TOOLING_PROTOCOL.min, selection.release.manifest.serverProtocol.min)) throw new ToolingOperationError("unsupported-protocol", "Active release has no operation protocol in common with this server");
        inherited = { releaseId: selection.release.id, generation: selection.generation, protocol };
      }
      const row = await tx.toolingOperation.create({ data: { id: randomUUID(), taskId: task.id, requestKey: request.requestKey, inputDigest: request.inputDigest, kind: request.kind,
        repositoryId: task.repositoryId, sessionId: session.id, turnId: input.turnId, existingOperationId: request.existingOperationId ?? null,
        parentOperationId: request.parentOperationId ?? null, retainedConsumerId, resourceKey: request.resourceKey ?? null, ...inherited } });
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

/**
 * SERVER-ONLY validated-proof seam, not a generic transition (TRANSITIONS is
 * unchanged): an `unknown` command-parented `compute-admission` child returns
 * to `running` so its own command can continue. Only for a transaction client:
 * the caller must, in the SAME transaction, have verified its exact domain
 * proof and appended the reconciliation records it names here by sequence, so
 * status and journal commit (or roll back) together. This seam re-reads those
 * stored records and requires: each is this operation's `reconciled` outcome
 * linking to `acknowledgedAttemptId` with the operation's request digest, and
 * was written after that acknowledgment; an open adapter-command parent of
 * the same task, session and repository; identical lineage (release,
 * generation) and a release whose protocol this server still speaks.
 */
const RECONCILED_OUTCOME = z.object({ version: z.literal(1), role: z.literal("outcome"), state: z.enum(["acknowledged", "reconciled"]), operationId: z.string(), attemptId: z.string(),
  inputDigest: z.string(), route: z.string(), status: z.number().nullable().optional(), acknowledgedAttemptId: z.string().optional() }).passthrough();
export async function reconcileUnknownAdmissionChild(tx: Prisma.TransactionClient, input: { operationId: string; acknowledgedAttemptId: string; reconciliationEvents: readonly number[] }): Promise<ToolingOperationBinding> {
  if (!input.acknowledgedAttemptId.trim() || !input.reconciliationEvents.length) throw new ToolingOperationError("evidence-required", "Reconciliation requires its stored records and the acknowledged attempt they rely on");
  const row = await tx.toolingOperation.findUnique({ where: { id: input.operationId } });
  if (!row) throw new ToolingOperationError("not-found", "Tooling operation not found");
  if (row.status !== "unknown" || row.kind !== "compute-admission" || !row.parentOperationId) throw new ToolingOperationError("invalid-transition", `Operation ${row.id} (${row.kind}, ${row.status}) is not an unknown command-parented compute-admission child`);
  const parent = await tx.toolingOperation.findUnique({ where: { id: row.parentOperationId } });
  if (!parent || parent.kind !== "adapter-command" || !["bound", "running"].includes(parent.status) || parent.taskId !== row.taskId || parent.sessionId !== row.sessionId
    || parent.repositoryId !== row.repositoryId || parent.releaseId !== row.releaseId || parent.generation !== row.generation) {
    throw new ToolingOperationError("invalid-transition", `Operation ${row.id} has no open adapter-command parent of the same task, session, repository and lineage`);
  }
  const release = await tx.toolingRelease.findUnique({ where: { id: row.releaseId } });
  const manifest = release ? ToolingReleaseManifestSchema.safeParse(release.manifest) : null;
  if (!release || release.repositoryId !== row.repositoryId || !manifest?.success
    || Math.min(SERVER_TOOLING_PROTOCOL.max, manifest.data.serverProtocol.max) < Math.max(SERVER_TOOLING_PROTOCOL.min, manifest.data.serverProtocol.min)) {
    throw new ToolingOperationError("invalid-transition", `Operation ${row.id} lineage has no release this server's protocol supports`);
  }
  // The stored evidence link, read back in this transaction.
  const where = { runtimeSessionId: row.sessionId, source: `tooling-operation:${row.taskId}`, action: "tooling-operation-association", key: `outcome:${row.id}` };
  const acknowledged = (await tx.runtimeMetadataEvent.findMany({ where, orderBy: { sequence: "desc" }, take: 1001 }))
    .flatMap(event => { const value = RECONCILED_OUTCOME.safeParse(JSON.parse(event.value ?? "null")).data; return value?.state === "acknowledged" && value.attemptId === input.acknowledgedAttemptId ? [{ ...value, sequence: event.sequence }] : []; });
  const ack = acknowledged[0];
  if (acknowledged.length !== 1 || !ack || ack.operationId !== row.id || ack.inputDigest !== row.inputDigest || typeof ack.status !== "number" || ack.status < 200 || ack.status >= 300) {
    throw new ToolingOperationError("evidence-required", `Operation ${row.id} has no single exact acknowledgment ${input.acknowledgedAttemptId}`);
  }
  for (const sequence of new Set(input.reconciliationEvents)) {
    const event = await tx.runtimeMetadataEvent.findUnique({ where: { sequence } });
    const value = event ? RECONCILED_OUTCOME.safeParse(JSON.parse(event.value ?? "null")).data : undefined;
    if (!event || event.runtimeSessionId !== where.runtimeSessionId || event.source !== where.source || event.action !== where.action || event.key !== where.key || event.sequence <= ack.sequence
      || !value || value.state !== "reconciled" || value.operationId !== row.id || value.inputDigest !== row.inputDigest || value.acknowledgedAttemptId !== input.acknowledgedAttemptId) {
      throw new ToolingOperationError("evidence-required", `Reconciliation record ${sequence} is not this operation's stored link to acknowledgment ${input.acknowledgedAttemptId}`);
    }
  }
  const updated = await tx.toolingOperation.updateMany({ where: { id: row.id, status: "unknown", kind: "compute-admission", parentOperationId: parent.id, releaseId: parent.releaseId, generation: parent.generation }, data: { status: "running" } });
  if (updated.count !== 1) throw new ToolingOperationError("transition-conflict", `Operation ${row.id} changed during reconciliation`);
  return binding(tx as unknown as Store, (await tx.toolingOperation.findUniqueOrThrow({ where: { id: row.id } })));
}

/** Boot recovery only, for a transaction client: an operation whose callback
 * was interrupted by its server process's exit moves `running -> unknown`
 * (compare-and-swap), in the same transaction that recorded the attempt's
 * unknown result. Never touches bound or completed operations. */
export async function markToolingOperationInterrupted(tx: Prisma.TransactionClient, input: { operationId: string }): Promise<void> {
  const updated = await tx.toolingOperation.updateMany({ where: { id: input.operationId, status: "running" }, data: { status: "unknown" } });
  if (updated.count !== 1) throw new ToolingOperationError("transition-conflict", `Operation ${input.operationId} is no longer running`);
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
 * unrelated operations and activation are unaffected. A retry returns its
 * original receipt only if the write is still eligible now (not superseded by
 * a newer version, operation still open); history stays readable through
 * readToolingStateVersion. Writes must equal the release's declared version. */
export async function registerToolingStateWrite(input: { prisma: PrismaClient; operationId: string; family: string; scopeKey: string; version: number }): Promise<ToolingStateVersion> {
  const key = StateKey.parse({ family: input.family, scopeKey: input.scopeKey });
  if (!Number.isInteger(input.version) || input.version < 1) throw new ToolingStateFormatError("invalid-request", "State format version must be a positive integer");
  const attempt = () => input.prisma.$transaction(async (tx) => {
    const { row, release } = await operationContext(tx, input.operationId);
    // A retried registration is revalidated like a new one: an identity replay
    // never authorizes bytes that the current state has moved past.
    const existing = await tx.toolingStateWrite.findUnique({ where: { operationId_family_scopeKey_version: { operationId: row.id, ...key, version: input.version } } });
    if (row.status !== "bound" && row.status !== "running") throw new ToolingStateFormatError("operation-closed", `Operation ${row.id} is ${row.status}; it cannot register new state writes`);
    const format = release.manifest.stateFormats[key.family];
    if (!format) throw new ToolingStateFormatError("undeclared-format", `Release ${release.revision} does not declare ${key.family}`);
    const writable = format.writeVersions ?? [format.write];
    if (!writable.includes(input.version)) throw new ToolingStateFormatError("wrong-write-version", `Release ${release.revision} may write ${key.family} versions ${writable.join(", ")}, not ${input.version}`);
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
    // Retained consumers keep reading after their producing operation completes.
    for (const reader of await retainedReaders(tx, row.taskId, key.family, key.scopeKey)) {
      if (reader.releaseId === row.releaseId) continue;
      if (!reader.format || !reader.format.read.includes(input.version)) throw new ToolingStateFormatError("deferred", `Retained ${reader.consumerKind} ${reader.consumerId} (release ${reader.revision}) cannot read ${key.family} version ${input.version}; defer this write until it is resolved`);
    }
    const legacyReader = LEGACY_STATE_FORMATS[key.family];
    const legacy = await tx.toolingLegacyConsumer.findFirst({ where: { repositoryId: row.repositoryId, taskId: row.taskId, status: "retained" } });
    if (legacy && (!legacyReader || !legacyReader.read.includes(input.version))) throw new ToolingStateFormatError("deferred", `Retained pre-protocol consumer ${legacy.consumerKind}:${legacy.consumerId} cannot read ${key.family} version ${input.version}`);
    if (existing) return existing;
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

export type ToolingRetainedConsumerStatus = "pending" | "confirmed" | "resolved";
export interface ToolingRetainedConsumer {
  id: string;
  operationId: string;
  taskId: string;
  repositoryId: string;
  consumerKind: string;
  consumerId: string;
  scopeKey: string;
  generation: number;
  protocol: number;
  release: ToolingReleaseRecord;
  status: ToolingRetainedConsumerStatus;
  evidence: { kind: string; reference: string } | null;
  resolution: { kind: string; reference: string } | null;
}
/** One live retained reader of a state. `format` null is an explicit blocker
 * (its release does not declare the family), never an empty consumer. */
export interface ToolingRetainedReader {
  id: string;
  operationId: string;
  consumerKind: string;
  consumerId: string;
  scopeKey: string;
  status: "pending" | "confirmed";
  releaseId: string;
  revision: string;
  generation: number;
  format: ToolingStateFormat | null;
}
const ConsumerInput = z.strictObject({ consumerKind: Identifier, consumerId: z.string().min(1).max(512), scopeKey: z.string().min(1).max(512) });
const StoredEvidence = Evidence.nullable();

async function consumerRecord(store: Pick<Store, "toolingRelease">, row: Awaited<ReturnType<Store["toolingRetainedConsumer"]["findUniqueOrThrow"]>>): Promise<ToolingRetainedConsumer> {
  return { id: row.id, operationId: row.operationId, taskId: row.taskId, repositoryId: row.repositoryId, consumerKind: row.consumerKind, consumerId: row.consumerId, scopeKey: row.scopeKey,
    generation: row.generation, protocol: row.protocol, release: record(await store.toolingRelease.findUniqueOrThrow({ where: { id: row.releaseId } })),
    status: z.enum(["pending", "confirmed", "resolved"]).parse(row.status), evidence: StoredEvidence.parse(row.evidence ?? null), resolution: StoredEvidence.parse(row.resolution ?? null) };
}

async function retainedReaders(store: Pick<Store, "toolingRetainedConsumer" | "toolingRelease">, taskId: string, family: string, scopeKey: string): Promise<ToolingRetainedReader[]> {
  const rows = await store.toolingRetainedConsumer.findMany({ where: { taskId, status: { in: LIVE_CONSUMER }, ...(scopeKey === "task" ? {} : { scopeKey: { in: [scopeKey, "task"] } }) },
    orderBy: { createdAt: "asc" }, take: 1001 });
  if (rows.length > 1000) throw new ToolingStateFormatError("deferred", `Retained consumer inventory for task ${taskId} exceeds its bound`);
  const releases = new Map<string, ToolingReleaseRecord>();
  const readers: ToolingRetainedReader[] = [];
  for (const row of rows) {
    const release = releases.get(row.releaseId) ?? record(await store.toolingRelease.findUniqueOrThrow({ where: { id: row.releaseId } }));
    releases.set(row.releaseId, release);
    readers.push({ id: row.id, operationId: row.operationId, consumerKind: row.consumerKind, consumerId: row.consumerId, scopeKey: row.scopeKey, status: row.status as "pending" | "confirmed",
      releaseId: row.releaseId, revision: release.revision, generation: row.generation, format: release.manifest.stateFormats[family] ?? null });
  }
  return readers;
}

/** Record, before its effect, that a resource/observer/process will keep
 * executing this operation's release. Idempotent per operation and consumer;
 * task, repository, release, generation and protocol come from the stored
 * operation. Several producers' rows may be pending at once. */
export async function retainToolingConsumer(input: { prisma: PrismaClient; operationId: string; consumerKind: string; consumerId: string; scopeKey: string }): Promise<ToolingRetainedConsumer> {
  const parsed = ConsumerInput.safeParse({ consumerKind: input.consumerKind, consumerId: input.consumerId, scopeKey: input.scopeKey });
  if (!parsed.success) throw new ToolingOperationError("invalid-request", parsed.error.issues.map(issue => issue.message).join("; "));
  const value = parsed.data;
  const existing = async (store: Store) => {
    const row = await store.toolingRetainedConsumer.findUnique({ where: { operationId_consumerKind_consumerId: { operationId: input.operationId, consumerKind: value.consumerKind, consumerId: value.consumerId } } });
    if (row && row.scopeKey !== value.scopeKey) throw new ToolingOperationError("request-conflict", "Retained consumer was already recorded with a different state scope");
    return row ? consumerRecord(store, row) : null;
  };
  const prior = await existing(input.prisma);
  if (prior) return prior;
  try {
    return await input.prisma.$transaction(async (tx) => {
      const raced = await existing(tx);
      if (raced) return raced;
      const operation = await tx.toolingOperation.findUnique({ where: { id: input.operationId } });
      if (!operation) throw new ToolingOperationError("not-found", "Tooling operation not found");
      if (operation.status !== "bound" && operation.status !== "running") throw new ToolingOperationError("operation-closed", `Operation ${operation.id} is ${operation.status}; retain consumers before its effect`);
      const row = await tx.toolingRetainedConsumer.create({ data: { id: randomUUID(), operationId: operation.id, repositoryId: operation.repositoryId, taskId: operation.taskId, ...value,
        releaseId: operation.releaseId, generation: operation.generation, protocol: operation.protocol } });
      return consumerRecord(tx, row);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await existing(input.prisma);
    if (winner) return winner;
    throw error;
  }
}

const sameEvidence = (stored: unknown, evidence: { kind: string; reference: string }) => StoredEvidence.safeParse(stored ?? null).data?.kind === evidence.kind && StoredEvidence.safeParse(stored ?? null).data?.reference === evidence.reference;

/** pending -> confirmed after the caller verified the original protocol
 * evidence. Atomically resolves the previously confirmed producer of the same
 * task/kind/consumer only; other pending (uncertain) rows stay retained. */
export async function confirmToolingConsumer(input: { prisma: PrismaClient; id: string; evidence: { kind: string; reference: string } }): Promise<ToolingRetainedConsumer> {
  const evidence = Evidence.safeParse(input.evidence);
  if (!evidence.success) throw new ToolingOperationError("evidence-required", "Confirming a retained consumer requires its original protocol evidence");
  return input.prisma.$transaction(async (tx) => {
    const row = await tx.toolingRetainedConsumer.findUnique({ where: { id: input.id } });
    if (!row) throw new ToolingOperationError("not-found", "Retained consumer not found");
    if (row.status === "confirmed" && sameEvidence(row.evidence, evidence.data)) return consumerRecord(tx, row);
    const now = new Date();
    if ((await tx.toolingRetainedConsumer.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "confirmed", evidence: evidence.data, confirmedAt: now } })).count !== 1) {
      throw new ToolingOperationError("transition-conflict", `Retained consumer is ${row.status}, not pending`);
    }
    await tx.toolingRetainedConsumer.updateMany({ where: { taskId: row.taskId, consumerKind: row.consumerKind, consumerId: row.consumerId, status: "confirmed", id: { not: row.id } },
      data: { status: "resolved", resolution: { kind: "superseded", reference: row.id }, resolvedAt: now } });
    return consumerRecord(tx, await tx.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: row.id } }));
  });
}

/** pending|confirmed -> resolved with proof that the consumer failed, had no
 * effect, stopped or is absent. The row and its snapshot are kept. */
export async function resolveToolingConsumer(input: { prisma: PrismaClient; id: string; evidence: { kind: string; reference: string } }): Promise<ToolingRetainedConsumer> {
  const evidence = Evidence.safeParse(input.evidence);
  if (!evidence.success) throw new ToolingOperationError("evidence-required", "Resolving a retained consumer requires its protocol evidence");
  return input.prisma.$transaction(async (tx) => {
    const row = await tx.toolingRetainedConsumer.findUnique({ where: { id: input.id } });
    if (!row) throw new ToolingOperationError("not-found", "Retained consumer not found");
    if (row.status === "resolved" && sameEvidence(row.resolution, evidence.data)) return consumerRecord(tx, row);
    if ((await tx.toolingRetainedConsumer.updateMany({ where: { id: row.id, status: { in: LIVE_CONSUMER } }, data: { status: "resolved", resolution: evidence.data, resolvedAt: new Date() } })).count !== 1) {
      throw new ToolingOperationError("transition-conflict", `Retained consumer is ${row.status}`);
    }
    return consumerRecord(tx, await tx.toolingRetainedConsumer.findUniqueOrThrow({ where: { id: row.id } }));
  });
}

/** Bounded live (pending/confirmed) retained readers of one task state, with
 * their exact release format. Scope "task" matches every row; a resource
 * scope matches its own rows and task-global rows. */
export async function readToolingRetainedConsumers(input: { prisma: PrismaClient; taskId: string; family: string; scopeKey: string }): Promise<ToolingRetainedReader[]> {
  const key = StateKey.parse({ family: input.family, scopeKey: input.scopeKey });
  return retainedReaders(input.prisma, input.taskId, key.family, key.scopeKey);
}
