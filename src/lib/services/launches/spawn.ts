import type { ServerConfig } from "../../config.ts";
import type { PrismaClient } from "../../../generated/prisma/client.ts";
import type {
  BbClient,
  BbSpawnThreadInput,
} from "../../../types/runtime/index.ts";
import type {
  Machine,
  SessionLifecycle,
  SessionRole,
} from "../../../types/sessions/index.ts";
import { upsertAgentIssueFromEvent } from "../sessions/index.ts";
import { getMachine } from "../../machines/index.ts";
import { resolveLaunchModel } from "./resolve-model.ts";

export interface SpawnAgentThreadInput {
  config: ServerConfig;
  prisma: PrismaClient;
  bbClient: BbClient;
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
  parentThreadId?: string;
}

export function launchExecutionSettings(
  harness: SpawnAgentThreadInput["harness"],
): Pick<
  BbSpawnThreadInput,
  "permissionMode" | "reasoningLevel" | "serviceTier"
> {
  if (harness === "codex") {
    return {
      permissionMode: "full",
      reasoningLevel: "high",
      serviceTier: "default",
    };
  }

  return {
    permissionMode: "auto",
    reasoningLevel: "high",
    serviceTier: undefined,
  };
}

/** Spawn and immediately bind the canonical bb thread to its Agents mirror.
 * The in-session compatibility hook later enriches workflow/subagent metadata;
 * it is not on the critical path for routability. */
export async function spawnAgentThread(input: SpawnAgentThreadInput) {
  const providerId = input.harness === "claude" ? "claude-code" : "codex";
  const hostId = getMachine({ id: input.machine }).bbHostId;
  const model = await resolveLaunchModel({
    bbClient: input.bbClient,
    providerId,
    hostId,
    requested: input.model,
  });
  const thread = await input.bbClient.spawnThread({
    projectId: input.config.bbProjectId,
    hostId,
    worktreePath: input.worktreePath,
    providerId,
    model,
    parentThreadId: input.parentThreadId,
    title: input.title ?? `${input.issueIdentifier} · ${input.role}`,
    prompt: input.prompt,
    ...launchExecutionSettings(input.harness),
  });

  const now = new Date();
  try {
    const agentIssue = await upsertAgentIssueFromEvent(
      input.config,
      {
        eventId: `bb-launch:${thread.id}`,
        occurredAt: now.toISOString(),
        generation: now.getTime(),
        type: "session.started",
        runtime: {
          harnessSessionId: thread.id,
          // bb parentage is canonical in bb. A launch through this API is a
          // deliberately promoted/mirrored thread, not a harness subagent.
          parentSessionId: null,
          worktreePath: input.worktreePath,
          branchName: input.branchName ?? null,
          harness: input.harness,
          machine: input.machine,
          role: input.role,
          lifecycle: input.lifecycle,
          sourceIssueIdentifier: input.issueIdentifier,
          bbThreadId: thread.id,
        },
      },
      input.prisma,
      { bbClient: input.bbClient },
    );
    return { thread, agentIssue };
  } catch (error) {
    await input.bbClient.stopThread(thread.id).catch(() => undefined);
    await input.bbClient.archiveThread(thread.id).catch(() => undefined);
    throw error;
  }
}
