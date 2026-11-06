import { createHash } from "node:crypto";
import path from "node:path";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type {
  AgentRuntimeLifecycleEvent,
  AgentRuntimeSession,
  AgentRuntimeStatus,
  AgentRuntimeUsage,
  EnsureAgentSessionInput,
} from "../../../../types/runtime/index.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { Prisma } from "../../../../generated/prisma/client.ts";
import type { ResolvedSessionLabel } from "./session-metadata.ts";

function json<T>(value: unknown): T | null {
  return value == null ? null : (value as T);
}

function storedJson(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object;
}

function status(value: string): AgentRuntimeStatus {
  if (
    value === "provisioning" ||
    value === "idle" ||
    value === "active" ||
    value === "error" ||
    value === "closed"
  ) return value;
  return "error";
}

function agent(value: string): "codex" | "claude" {
  return value === "claude" ? "claude" : "codex";
}

export function runtimeScopeKey(input: {
  sessionKey: string;
  agent: string;
  cwd: string;
  repositoryId?: string;
}): string {
  return createHash("sha256")
    .update("remote-agent-runtime:v2\0")
    .update(input.repositoryId ?? "legacy")
    .update("\0")
    .update(input.agent)
    .update("\0")
    .update(path.resolve(input.cwd))
    .update("\0")
    .update(input.sessionKey)
    .digest("hex");
}

type RuntimeRow = Awaited<
  ReturnType<PrismaClient["runtimeSession"]["findUnique"]>
> & {};

export function toAgentRuntimeSession(row: NonNullable<RuntimeRow>): AgentRuntimeSession {
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    acpxRecordId: row.acpxRecordId,
    acpxSessionId: row.acpxSessionId,
    agentSessionId: row.agentSessionId,
    agent: agent(row.agentCommand),
    repositoryId: row.repositoryId,
    machineId: row.machineId,
    role: row.role,
    lifecycle: row.lifecycle,
    workflowId: row.workflowId,
    cwd: row.cwd,
    name: row.name,
    worktreePath: row.worktreePath,
    executionTarget: row.executionTarget,
    status: status(row.status),
    configOptions:
      json<SessionConfigOption[]>(row.latestConfigOptions) ?? [],
    usage: json<AgentRuntimeUsage>(row.latestUsage),
    closedAt: row.closedAt,
  };
}

export async function beginRuntimeSession(
  prisma: PrismaClient,
  input: EnsureAgentSessionInput,
  metadata: { labels?: ResolvedSessionLabel[] } = {},
): Promise<AgentRuntimeSession> {
  const cwd = path.resolve(input.cwd);
  const repositoryId = input.repositoryId ?? "legacy";
  const machineId = input.machineId ?? input.executionTarget ?? "unknown";
  const role = input.role ?? null;
  const lifecycle = input.lifecycle ?? null;
  // Persisted under the storage-internal `tags` rows.
  const tags = [...(metadata.labels ?? [])].sort(
    (a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
  );
  const relations = [...(input.relations ?? [])].sort((a, b) =>
    a.relationship.localeCompare(b.relationship) ||
    a.targetSessionId.localeCompare(b.targetSessionId)
  );
  const resourceLinks = [...(input.resourceLinks ?? [])].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
  const scopeKey = runtimeScopeKey({
    sessionKey: input.sessionKey,
    agent: input.agent,
    cwd,
    repositoryId,
  });
  const creationMetadataHash = createHash("sha256")
    .update(JSON.stringify({
      repositoryId,
      machineId,
      role,
      lifecycle,
      tags: tags.map(({ key, value }) => ({ key, value })),
      relations,
      resourceLinks,
    }))
    .digest("hex");
  const row = await prisma.runtimeSession.upsert({
    where: { scopeKey },
    create: {
      scopeKey,
      agentCommand: input.agent,
      repositoryId,
      machineId,
      role,
      lifecycle,
      // Provenance, deliberately outside creationMetadataHash: it does not
      // participate in scope-identity conflicts.
      workflowId: input.workflowId ?? null,
      creationMetadataHash,
      cwd,
      name: input.name ?? input.sessionKey,
      worktreePath: input.worktreePath ?? cwd,
      executionTarget: input.executionTarget,
      status: "provisioning",
      tags: tags.length ? { create: tags } : undefined,
      outgoingRelations: relations.length
        ? { create: relations.map((relation) => ({
            relationship: relation.relationship,
            targetSessionId: relation.targetSessionId,
          })) }
        : undefined,
      resourceLinks: resourceLinks.length ? { create: resourceLinks } : undefined,
    },
    update: {},
  });
  if (row.creationMetadataHash && row.creationMetadataHash !== creationMetadataHash) {
    throw new Error(
      `runtime session scope conflicts with its original identity or metadata: ${input.sessionKey}`,
    );
  }
  if (row.status === "closed") {
    throw new Error(
      `runtime session scope is closed; use a new session key: ${input.sessionKey}`,
    );
  }
  return toAgentRuntimeSession(row);
}

/** A session is open only while it is not closed AND has no closure
 * timestamp. Legacy rows that a late provider write left `idle` with
 * `closedAt` set are still closed. */
const OPEN_SESSION = { status: { not: "closed" }, closedAt: null } as const;

/** A conditional write found the session already closed (status or
 * closure timestamp). Callers that started a provider must release it. */
export class RuntimeSessionClosedError extends Error {
  constructor(id: string) {
    super(`runtime session is closed: ${id}`);
    this.name = "RuntimeSessionClosedError";
  }
}

export async function attachRuntimeSession(
  prisma: PrismaClient,
  input: {
    id: string;
    acpxRecordId: string;
    acpxSessionId?: string;
    agentSessionId?: string;
    configOptions?: SessionConfigOption[];
  },
): Promise<AgentRuntimeSession> {
  // Attaching a provider handle marks the session idle. A close that landed
  // while the provider was starting stays authoritative.
  const changed = await prisma.runtimeSession.updateMany({
    where: { id: input.id, ...OPEN_SESSION },
    data: {
      acpxRecordId: input.acpxRecordId,
      acpxSessionId: input.acpxSessionId,
      agentSessionId: input.agentSessionId,
      status: "idle",
      recoveryDetail: null,
      ...(input.configOptions
        ? { latestConfigOptions: storedJson(input.configOptions) }
        : {}),
    },
  });
  if (!changed.count) {
    await prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.id } });
    throw new RuntimeSessionClosedError(input.id);
  }
  return toAgentRuntimeSession(
    await prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.id } }),
  );
}

/**
 * Persists provider-driven session state.
 *
 * Closure is terminal. Any write that does not itself close the session is
 * conditional in the database on the row still being open at write time, so
 * a provider completion that races a close is a zero-row no-op (returns
 * false) rather than reviving the session as idle/active/error. A closing
 * write keeps an earlier closure timestamp instead of replacing it.
 */
export async function updateRuntimeSessionState(
  prisma: PrismaClient,
  id: string,
  data: {
    status?: AgentRuntimeStatus;
    configOptions?: SessionConfigOption[];
    usage?: AgentRuntimeUsage;
    recoveryDetail?: string | null;
    closedAt?: Date | null;
    agentSessionId?: string;
  },
): Promise<boolean> {
  const fields = {
    ...(data.status ? { status: data.status } : {}),
    ...(data.configOptions
      ? { latestConfigOptions: storedJson(data.configOptions) }
      : {}),
    ...(data.usage ? { latestUsage: storedJson(data.usage) } : {}),
    ...(data.recoveryDetail !== undefined
      ? { recoveryDetail: data.recoveryDetail }
      : {}),
    ...(data.agentSessionId ? { agentSessionId: data.agentSessionId } : {}),
  };
  if (data.status === "closed") {
    const first = await prisma.runtimeSession.updateMany({
      where: { id, closedAt: null },
      data: { ...fields, ...(data.closedAt !== undefined ? { closedAt: data.closedAt } : {}) },
    });
    if (first.count) return true;
    const again = await prisma.runtimeSession.updateMany({ where: { id }, data: fields });
    if (!again.count) throw new Error(`runtime session not found: ${id}`);
    return true;
  }
  if (data.closedAt !== undefined) {
    throw new Error("closedAt can only be recorded by a closing status write");
  }
  const changed = await prisma.runtimeSession.updateMany({
    where: { id, ...OPEN_SESSION },
    data: fields,
  });
  if (changed.count) return true;
  // Zero rows: either the session closed first (expected no-op) or it never
  // existed, which stays an error as before.
  await prisma.runtimeSession.findUniqueOrThrow({ where: { id } });
  return false;
}

export async function prepareRuntimeAgentSwitch(
  prisma: PrismaClient,
  input: { id: string; agent: "codex" | "claude" },
): Promise<AgentRuntimeSession> {
  // Switching providers restarts an open session only. A closure (including
  // a legacy idle row with closedAt) is never cleared here.
  const changed = await prisma.runtimeSession.updateMany({
    where: { id: input.id, ...OPEN_SESSION },
    data: {
      agentCommand: input.agent,
      acpxRecordId: null,
      acpxSessionId: null,
      agentSessionId: null,
      status: "provisioning",
      latestConfigOptions: Prisma.JsonNull,
      latestUsage: Prisma.JsonNull,
      recoveryDetail: null,
    },
  });
  if (!changed.count) {
    await prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.id } });
    throw new RuntimeSessionClosedError(input.id);
  }
  return toAgentRuntimeSession(
    await prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.id } }),
  );
}

export async function findRuntimeSession(
  prisma: PrismaClient,
  id: string,
): Promise<AgentRuntimeSession | null> {
  const row = await prisma.runtimeSession.findUnique({ where: { id } });
  return row ? toAgentRuntimeSession(row) : null;
}

export async function listRuntimeSessions(
  prisma: PrismaClient,
  input: { cwd?: string; repositoryId?: string; includeClosed?: boolean } = {},
): Promise<AgentRuntimeSession[]> {
  const rows = await prisma.runtimeSession.findMany({
    where: {
      ...(input.cwd ? { cwd: path.resolve(input.cwd) } : {}),
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      ...(!input.includeClosed ? { status: { not: "closed" } } : {}),
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toAgentRuntimeSession);
}

export async function hasLivePersistentSessionForResource(
  prisma: PrismaClient,
  input: {
    repositoryId: string;
    provider: string;
    connectionId: string;
    resourceType: string;
    externalId: string;
  },
): Promise<boolean> {
  return (await prisma.runtimeSessionResourceLink.count({
    where: {
      provider: input.provider,
      connectionId: input.connectionId,
      resourceType: input.resourceType,
      externalId: input.externalId,
      relationship: "handles",
      endedAt: null,
      runtimeSession: {
        repositoryId: input.repositoryId,
        lifecycle: { not: "one-shot" },
        status: { notIn: ["closed", "error"] },
      },
    },
  })) > 0;
}

export async function attachRuntimeSessionToMirror(
  prisma: PrismaClient,
  input: { runtimeSessionId: string; sessionMirrorId: string },
): Promise<void> {
  // Legacy webhook producers may report a runtime identity before this process
  // has imported it into the local registry. Linking is therefore best-effort;
  // sessions provisioned through acpx always have a matching row. The catch
  // covers sessionMirrorId's @unique: another session already holding this
  // mirror is a stale-producer race, not a reason to fail the caller.
  await prisma.runtimeSession
    .updateMany({
      where: { id: input.runtimeSessionId },
      data: { sessionMirrorId: input.sessionMirrorId },
    })
    .catch(() => undefined);
}

export async function getRuntimeEventCursor(
  prisma: PrismaClient,
  input: { runtimeSessionId: string; consumer: string },
): Promise<{ sourceCursor: string | null; generation: bigint }> {
  const cursor = await prisma.runtimeEventCursor.findUnique({
    where: {
      runtimeSessionId_consumer: input,
    },
  });
  return cursor
    ? { sourceCursor: cursor.sourceCursor, generation: cursor.generation }
    : { sourceCursor: null, generation: 0n };
}

export async function advanceRuntimeEventCursor(
  prisma: PrismaClient,
  input: {
    runtimeSessionId: string;
    consumer: string;
    sourceCursor: string;
    generation: bigint;
  },
): Promise<void> {
  await prisma.runtimeEventCursor.upsert({
    where: {
      runtimeSessionId_consumer: {
        runtimeSessionId: input.runtimeSessionId,
        consumer: input.consumer,
      },
    },
    create: input,
    update: {
      sourceCursor: input.sourceCursor,
      generation: input.generation,
    },
  });
}

export async function appendRuntimeLifecycleEvent(
  prisma: PrismaClient,
  event: Omit<AgentRuntimeLifecycleEvent, "sequence">,
): Promise<AgentRuntimeLifecycleEvent> {
  const row = await prisma.runtimeLifecycleEvent.upsert({
    where: { id: event.id },
    create: {
      id: event.id,
      runtimeSessionId: event.sessionId,
      requestId: event.requestId,
      phase: event.phase,
      error: event.error,
      output: event.output,
      occurredAt: new Date(event.createdAt),
    },
    update: {},
  });
  return { ...event, sequence: row.sequence };
}

export async function listRuntimeLifecycleEvents(
  prisma: PrismaClient,
  pending?: { consumer: string; afterSequence: number; throughSequence: number; take: number; afterConsumer?: string; excludedSessionIds?: string[] },
): Promise<AgentRuntimeLifecycleEvent[]> {
  // Retain journal evidence, but never make every poll replay acknowledged
  // history. Cursor joins also bound what is loaded before JSON conversion.
  const ids = pending ? await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT event.id FROM RuntimeLifecycleEvent AS event
    LEFT JOIN RuntimeEventCursor AS cursor ON cursor.runtimeSessionId = event.runtimeSessionId AND cursor.consumer = ${pending.consumer}
    LEFT JOIN RuntimeEventCursor AS prerequisite ON prerequisite.runtimeSessionId = event.runtimeSessionId AND prerequisite.consumer = ${pending.afterConsumer ?? ""}
    WHERE event.sequence > COALESCE(cursor.generation, 0)
      AND event.sequence > ${pending.afterSequence}
      AND event.sequence <= ${pending.throughSequence}
      AND (${pending.afterConsumer ?? null} IS NULL OR event.sequence <= COALESCE(prerequisite.generation, 0))
      AND ${pending.excludedSessionIds?.length ? Prisma.sql`event.runtimeSessionId NOT IN (${Prisma.join(pending.excludedSessionIds)})` : Prisma.sql`1=1`}
    ORDER BY event.sequence ASC LIMIT ${pending.take}` : null;
  if (ids && !ids.length) return [];
  const rows = await prisma.runtimeLifecycleEvent.findMany({
    ...(ids ? { where: { id: { in: ids.map((row) => row.id) } } } : {}),
    orderBy: { sequence: "asc" },
  });
  return rows.map((row) => ({
    kind: "turn",
    id: row.id,
    sessionId: row.runtimeSessionId,
    requestId: row.requestId,
    createdAt: row.occurredAt.getTime(),
    sequence: row.sequence,
    phase:
      row.phase === "started" ||
      row.phase === "completed" ||
      row.phase === "failed" ||
      row.phase === "cancelled"
        ? row.phase
        : "failed",
    ...(row.error ? { error: row.error } : {}),
    ...(row.output != null ? { output: row.output } : {}),
  }));
}

export async function pruneRuntimeLifecycleEvents(
  prisma: PrismaClient,
  input: { runtimeSessionId: string; throughSequence: number },
): Promise<void> {
  await prisma.runtimeLifecycleEvent.deleteMany({
    where: {
      runtimeSessionId: input.runtimeSessionId,
      sequence: { lte: input.throughSequence },
    },
  });
}
