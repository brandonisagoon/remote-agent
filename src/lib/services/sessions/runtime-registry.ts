import { createHash } from "node:crypto";
import path from "node:path";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type {
  AgentRuntimeLifecycleEvent,
  AgentRuntimeSession,
  AgentRuntimeStatus,
  AgentRuntimeUsage,
  EnsureAgentSessionInput,
} from "../../../types/runtime/index.ts";
import type { PrismaClient } from "../../../generated/prisma/client.ts";
import { Prisma } from "../../../generated/prisma/client.ts";

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
}): string {
  return createHash("sha256")
    .update("remote-agent-runtime:v1\0")
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
): Promise<AgentRuntimeSession> {
  const cwd = path.resolve(input.cwd);
  const scopeKey = runtimeScopeKey({
    sessionKey: input.sessionKey,
    agent: input.agent,
    cwd,
  });
  const row = await prisma.runtimeSession.upsert({
    where: { scopeKey },
    create: {
      scopeKey,
      agentCommand: input.agent,
      cwd,
      name: input.name ?? input.sessionKey,
      worktreePath: input.worktreePath ?? cwd,
      executionTarget: input.executionTarget,
      status: "provisioning",
    },
    update: {
      worktreePath: input.worktreePath ?? cwd,
      executionTarget: input.executionTarget,
      recoveryDetail: null,
      ...(input.name ? { name: input.name } : {}),
    },
  });
  if (row.status === "closed") {
    throw new Error(
      `runtime session scope is closed; use a new session key: ${input.sessionKey}`,
    );
  }
  return toAgentRuntimeSession(row);
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
  const row = await prisma.runtimeSession.update({
    where: { id: input.id },
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
  return toAgentRuntimeSession(row);
}

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
): Promise<void> {
  await prisma.runtimeSession.update({
    where: { id },
    data: {
      ...(data.status ? { status: data.status } : {}),
      ...(data.configOptions
        ? { latestConfigOptions: storedJson(data.configOptions) }
        : {}),
      ...(data.usage ? { latestUsage: storedJson(data.usage) } : {}),
      ...(data.recoveryDetail !== undefined
        ? { recoveryDetail: data.recoveryDetail }
        : {}),
      ...(data.closedAt !== undefined ? { closedAt: data.closedAt } : {}),
      ...(data.agentSessionId ? { agentSessionId: data.agentSessionId } : {}),
    },
  });
}

export async function prepareRuntimeAgentSwitch(
  prisma: PrismaClient,
  input: { id: string; agent: "codex" | "claude" },
): Promise<AgentRuntimeSession> {
  const row = await prisma.runtimeSession.update({
    where: { id: input.id },
    data: {
      agentCommand: input.agent,
      acpxRecordId: null,
      acpxSessionId: null,
      agentSessionId: null,
      status: "provisioning",
      latestConfigOptions: Prisma.JsonNull,
      latestUsage: Prisma.JsonNull,
      recoveryDetail: null,
      closedAt: null,
    },
  });
  return toAgentRuntimeSession(row);
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
  input: { cwd?: string; includeClosed?: boolean } = {},
): Promise<AgentRuntimeSession[]> {
  const rows = await prisma.runtimeSession.findMany({
    where: {
      ...(input.cwd ? { cwd: path.resolve(input.cwd) } : {}),
      ...(!input.includeClosed ? { status: { not: "closed" } } : {}),
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toAgentRuntimeSession);
}

export async function attachRuntimeSessionToAgentIssue(
  prisma: PrismaClient,
  input: { runtimeSessionId: string; agentIssueRecordId: string },
): Promise<void> {
  // Legacy webhook producers may report a runtime identity before this process
  // has imported it into the local registry. Linking is therefore best-effort;
  // sessions provisioned through acpx always have a matching row.
  await prisma.runtimeSession.updateMany({
    where: { id: input.runtimeSessionId },
    data: { agentIssueRecordId: input.agentIssueRecordId },
  });
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
      occurredAt: new Date(event.createdAt),
    },
    update: {},
  });
  return { ...event, sequence: row.sequence };
}

export async function listRuntimeLifecycleEvents(
  prisma: PrismaClient,
): Promise<AgentRuntimeLifecycleEvent[]> {
  const rows = await prisma.runtimeLifecycleEvent.findMany({
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
