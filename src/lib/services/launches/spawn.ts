import type { ServerConfig } from "../../config.ts";
import type { PrismaClient } from "../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../types/runtime/index.ts";
import type {
  Machine,
  SessionLifecycle,
  SessionRole,
} from "../../../types/sessions/index.ts";
import { upsertAgentIssueFromEvent } from "../sessions/index.ts";

export interface SpawnAgentThreadInput {
  config: ServerConfig;
  prisma: PrismaClient;
  agentRuntime: AgentSessionRuntime;
  launchKey: string;
  issueIdentifier: string;
  harness: "codex" | "claude";
  model?: string;
  prompt: string;
  machine: Machine;
  worktreePath: string;
  branchName?: string | null;
  lifecycle: SessionLifecycle;
  role: SessionRole;
  title?: string;
  parentSessionId?: string;
}

export interface SpawnAgentThreadDependencies {
  register: typeof upsertAgentIssueFromEvent;
}

const defaultDependencies: SpawnAgentThreadDependencies = {
  register: upsertAgentIssueFromEvent,
};

/** Ensure one durable acpx session for this launch attempt, register its
 * canonical Linear mirror, and enqueue the initial prompt. */
export async function spawnAgentThread(
  input: SpawnAgentThreadInput,
  dependencies: SpawnAgentThreadDependencies = defaultDependencies,
) {
  const session = await input.agentRuntime.ensureSession({
    sessionKey: input.launchKey,
    name: input.title ?? `${input.issueIdentifier} · ${input.role}`,
    agent: input.harness,
    cwd: input.worktreePath,
    worktreePath: input.worktreePath,
    executionTarget: input.machine,
    model: input.model,
  });

  const now = new Date();
  try {
    const agentIssue = await dependencies.register(
      input.config,
      {
        eventId: `runtime-launch:${session.id}`,
        occurredAt: now.toISOString(),
        generation: now.getTime(),
        type: "session.started",
        runtime: {
          harnessSessionId: session.id,
          parentSessionId: input.parentSessionId ?? null,
          worktreePath: input.worktreePath,
          branchName: input.branchName ?? null,
          harness: input.harness,
          machine: input.machine,
          role: input.role,
          lifecycle: input.lifecycle,
          sourceIssueIdentifier: input.issueIdentifier,
          runtimeSessionId: session.id,
        },
      },
      input.prisma,
    );
    await input.agentRuntime.enqueue({
      sessionId: session.id,
      text: input.prompt,
      requestId: `launch:${input.launchKey}`,
    });
    return { session, agentIssue };
  } catch (error) {
    await input.agentRuntime
      .close(session.id, "Launch registration failed")
      .catch(() => undefined);
    throw error;
  }
}
