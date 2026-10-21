import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { getRepositoryConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { spawnAgentThread } from "../launches/spawn.ts";
import { beginTask } from "./store.ts";
import { prepareTaskPrompt } from "./preparation.ts";
import { provisionTaskWorktree } from "./provision.ts";

export async function launchTask(input: { config: ServerConfig; prisma: PrismaClient; runtime: AgentSessionRuntime; requestKey: string; repositoryId: string; branchName: string; prompt: string; provider: "codex" | "claude" }) {
  const repository = getRepositoryConfig(input.config, input.repositoryId);
  if (!repository.tooling) throw new Error("Select a repository with external tooling");
  const task = await beginTask(input.prisma, { requestKey: input.requestKey, repository, machineId: input.config.machine, branchName: input.branchName });
  if (task.primarySessionId) return task;
  try {
    const worktreePath = await provisionTaskWorktree(input.prisma, task.id, repository, task.id);
    const { prompt, toolingRoot } = await prepareTaskPrompt({ ...input, repository, task, worktreePath,
      installRoot: input.config.installRoot, seed: `Use {{SKILL:prepare}}.\nTask: ${task.id}\n\n${input.prompt}` });
    await spawnAgentThread({ config: { ...input.config, activeRepositoryId: repository.id, repository }, prisma: input.prisma, agentRuntime: input.runtime, launchKey: task.requestKey, provider: input.provider, prompt, machine: input.config.machine, worktreePath, lifecycle: "persistent", role: "primary", taskId: task.id, toolingRoot });
    return input.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
  } catch (error) {
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "blocked", recoveryDetail: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}
