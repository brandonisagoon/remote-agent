import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { RepositoryConfig } from "../../../../lib/config.ts";
import { composeForPrompt } from "../../../../lib/skills/compose.ts";
import { prepareTooling } from "./tooling.ts";

/** A created task worktree is enough to start its repair agent. Missing
 * tooling must not turn an otherwise recoverable launch into a dead end. */
export async function prepareTaskPrompt(input: {
  prisma: PrismaClient; task: RemoteTask; repository: RepositoryConfig;
  installRoot: string; worktreePath: string; provider: "codex" | "claude";
  seed: string; compose?: typeof composeForPrompt;
}): Promise<{ prompt: string; toolingRoot?: string }> {
  const { task } = input;
  let toolingRoot: string | undefined;
  try {
    toolingRoot = await prepareTooling({ ...input.repository, tooling: { root: task.toolingRoot, revision: task.toolingRevision } }, input.installRoot);
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { pinnedToolingRoot: toolingRoot } });
    const prompt = await (input.compose ?? composeForPrompt)(input.worktreePath, input.seed, input.provider, input.repository.skillsRoot, toolingRoot);
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "preparing", environmentStatus: "preparing", recoveryDetail: null } });
    return { prompt, toolingRoot };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "blocked", environmentStatus: "degraded", recoveryDetail: detail } });
    return { toolingRoot, prompt: `Task ${task.id} has its product worktree, but tooling preparation failed: ${detail}\nUse inspect_task, read this worktree's AGENTS.md, and investigate the setup failure. Tooling source is ${task.toolingRoot} at exact commit ${task.toolingRevision}. Preserve that revision and all product work. Repair missing local dependencies when possible; do not change tracked product configuration or use shared/production services. Report the actual blocker if access is missing. Skill tokens below may be unresolved because composition failed. Verify readiness before implementing the request.\n\n${input.seed}` };
  }
}
