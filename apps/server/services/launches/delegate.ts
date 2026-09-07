import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type {
  AgentRuntimeSession,
  AgentSessionRuntime,
} from "../../../../types/runtime/index.ts";

export interface DelegateSessionInput {
  parentSessionId: string;
  prompt: string;
  provider?: "codex" | "claude";
  model?: string;
  name?: string;
  cwd?: string;
}

/** Spawns a child session that inherits its parent's lineage: repository,
    machine, worktree, provider (unless overridden), and the parent's live
    resource links (the issue it handles, its connection) — so routing,
    mirroring, and lifecycle treat the child as part of the same work. The
    caller supplies only what a delegate intrinsically needs; nothing
    Linear- or connection-specific. Recurses: a delegate may delegate. */
export async function delegateSession(
  input: DelegateSessionInput,
  dependencies: { prisma: PrismaClient; runtime: AgentSessionRuntime },
): Promise<AgentRuntimeSession> {
  const parent = await dependencies.runtime.getSession(input.parentSessionId);
  if (!parent) throw new Error(`unknown session: ${input.parentSessionId}`);
  if (parent.status === "closed") {
    throw new Error(`session is closed: ${input.parentSessionId}`);
  }

  const inherited = await dependencies.prisma.runtimeSessionResourceLink.findMany({
    where: {
      runtimeSessionId: parent.id,
      endedAt: null,
      // Threads stay with the session that owns them; issue/connection
      // membership carries down.
      resourceType: { not: "comment-thread" },
    },
  });

  const cwd = input.cwd ?? parent.worktreePath ?? parent.cwd;
  const child = await dependencies.runtime.ensureSession({
    sessionKey: `delegate:${parent.id}:${randomUUID()}`,
    name: `${parent.name ?? parent.id} › ${input.name ?? "delegate"}`,
    agent: input.provider ?? parent.agent,
    cwd,
    worktreePath: cwd,
    executionTarget: parent.executionTarget ?? parent.machineId,
    repositoryId: parent.repositoryId,
    machineId: parent.machineId,
    role: "delegate",
    lifecycle: "one-shot",
    ...(parent.workflowId ? { workflowId: parent.workflowId } : {}),
    ...(input.model ? { model: input.model } : {}),
    relations: [{ relationship: "spawned-by", targetSessionId: parent.id }],
    resourceLinks: inherited.map((link) => ({
      provider: link.provider,
      connectionId: link.connectionId,
      resourceType: link.resourceType,
      externalId: link.externalId,
      relationship: link.relationship,
    })),
  });

  try {
    await dependencies.runtime.enqueue({
      sessionId: child.id,
      text: input.prompt,
      requestId: `delegate:${child.id}`,
    });
  } catch (error) {
    await dependencies.runtime
      .close(child.id, "Delegate launch enqueue failed")
      .catch(() => undefined);
    throw error;
  }
  return child;
}
