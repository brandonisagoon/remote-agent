import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { getRepositoryConfig } from "../../../../lib/config.ts";
import { composeForPrompt } from "../../../../lib/skills/compose.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { spawnAgentThread } from "../launches/spawn.ts";
import { beginTask } from "./store.ts";
import { prepareTooling } from "./tooling.ts";
import { provisionTaskWorktree } from "./provision.ts";

export async function launchTask(input: { config: ServerConfig; prisma: PrismaClient; runtime: AgentSessionRuntime; requestKey: string; repositoryId: string; branchName: string; prompt: string; provider: "codex" | "claude" }) {
  const repository = getRepositoryConfig(input.config, input.repositoryId);
  if (!repository.tooling) throw new Error("Select a repository with external tooling");
  const task = await beginTask(input.prisma, { requestKey: input.requestKey, repository, machineId: input.config.machine, branchName: input.branchName });
  if (task.primarySessionId) return task;
  try {
    const worktreePath = await provisionTaskWorktree(input.prisma, task.id, repository, task.id);
    let toolingRoot: string | undefined;
    let prompt: string;
    try {
      toolingRoot = await prepareTooling({ ...repository, tooling: { root: task.toolingRoot, revision: task.toolingRevision } }, input.config.installRoot);
      prompt = await composeForPrompt(worktreePath, `Use {{SKILL:prepare}}.\nTask: ${task.id}\nPinned tooling: ${toolingRoot}\n\n${input.prompt}`, input.provider, repository.skillsRoot, toolingRoot);
      await input.prisma.remoteTask.update({ where: { id: task.id }, data: { pinnedToolingRoot: toolingRoot, phase: "preparing", environmentStatus: "preparing", recoveryDetail: null } });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "blocked", environmentStatus: "degraded", recoveryDetail: detail } });
      prompt = `Task ${task.id} has its product worktree, but tooling preparation failed: ${detail}\nUse inspect_task, read this worktree's AGENTS.md, and investigate the setup failure. Tooling source is ${task.toolingRoot} at exact commit ${task.toolingRevision}. Preserve that revision and all product work. Repair missing local dependencies when possible; do not change tracked product configuration or use shared/production services. Report the actual blocker if access is missing. Verify readiness before implementing the request.\n\n${input.prompt}`;
    }
    await spawnAgentThread({ config: { ...input.config, activeRepositoryId: repository.id, repository }, prisma: input.prisma, agentRuntime: input.runtime, launchKey: task.requestKey, provider: input.provider, prompt, machine: input.config.machine, worktreePath, lifecycle: "persistent", role: "primary", taskId: task.id, toolingRoot });
    return input.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
  } catch (error) {
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "blocked", recoveryDetail: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}
