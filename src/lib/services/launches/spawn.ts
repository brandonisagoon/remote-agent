import type { ServerConfig } from "../../config.ts";
import type { PrismaClient } from "../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../types/runtime/index.ts";
import type {
  Machine,
  SessionLifecycle,
  SessionRole,
} from "../../../types/sessions/index.ts";

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
  /** Launch provenance recorded on the session (plan capture resolves the
      live workflow configuration through it). */
  workflowId?: string;
  /** Session mode set before the initial prompt enqueues (e.g. "plan"). */
  mode?: string;
}

/** Ensure one durable, metadata-complete acpx session and enqueue its initial
 * prompt. Linear is a linked input/output integration, not the registry. */
export async function spawnAgentThread(
  input: SpawnAgentThreadInput,
) {
  const session = await input.agentRuntime.ensureSession({
    sessionKey: input.launchKey,
    name: input.title ?? `${input.issueIdentifier} · ${input.role}`,
    agent: input.harness,
    cwd: input.worktreePath,
    worktreePath: input.worktreePath,
    executionTarget: input.machine,
    repositoryId: input.config.activeRepositoryId,
    machineId: input.machine,
    role: input.role,
    lifecycle: input.lifecycle,
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    relations: input.parentSessionId
      ? [{ relationship: "spawned-by", targetSessionId: input.parentSessionId }]
      : [],
    resourceLinks: [{
      provider: "linear",
      connectionId: input.config.activeConnectionId,
      resourceType: "issue-identifier",
      externalId: input.issueIdentifier,
      relationship: "handles",
    }],
    model: input.model,
  });

  try {
    // Mode must land before the prompt: a plan-capture session that starts
    // its turn outside plan mode never produces an exit-plan approval.
    if (input.mode) await input.agentRuntime.setMode(session.id, input.mode);
    await input.agentRuntime.enqueue({
      sessionId: session.id,
      text: input.prompt,
      requestId: `launch:${input.launchKey}`,
    });
    return { session, agentIssue: null };
  } catch (error) {
    await input.agentRuntime
      .close(session.id, "Initial launch enqueue failed")
      .catch(() => undefined);
    throw error;
  }
}
