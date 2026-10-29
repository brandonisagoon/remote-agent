import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { RepositoryConfig } from "../../../../lib/config.ts";
import { composeForPrompt, withToolingInstructions } from "../../../../lib/skills/compose.ts";
import { prepareTooling } from "./tooling.ts";
import { describeUnavailableSkills, resolveToolingCompatibility } from "./tooling-compatibility.ts";

const credentialRecovery = "If required development credentials appear missing, the owning primary can call resolve_tooling_capability with capability development-credentials. This resolves only the owner-configured committed recovery instructions and adapter without repinning the task. Inspect names and integrity before claiming missing access; export only task-required keys into a private task file, never print values or use production fallback, and verify the actual provider operation. Resolution does not itself decrypt or export anything.";

/** A created task worktree is enough to start its repair agent. Missing
 * tooling must not turn an otherwise recoverable launch into a dead end. */
export async function prepareTaskPrompt(input: {
  prisma: PrismaClient; task: RemoteTask; repository: RepositoryConfig;
  installRoot: string; worktreePath: string; provider: "codex" | "claude";
  seed: string; compose?: typeof composeForPrompt;
}): Promise<{ prompt: string; toolingRoot?: string }> {
  const { task } = input;
  const assertAvailable = async () => {
    const current = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    if ((current.ownerPaused || current.phase === "closed")) throw new Error("Task preparation is closed; preserve its existing work");
  };
  await assertAvailable();
  let toolingRoot: string | undefined;
  try {
    toolingRoot = await prepareTooling({ ...input.repository, tooling: { root: task.toolingRoot, revision: task.toolingRevision } }, input.installRoot);
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { pinnedToolingRoot: toolingRoot } });
    const prompt = await (input.compose ?? composeForPrompt)(input.worktreePath, input.seed, input.provider, input.repository.skillsRoot, toolingRoot);
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "preparing", environmentStatus: "preparing", recoveryDetail: null } });
    return { prompt: `${credentialRecovery}\n\n${prompt}`, toolingRoot };
  } catch (error) {
    await assertAvailable();
    const detail = error instanceof Error ? error.message : String(error);
    let compatibilityFailure: string;
    try {
      const compatibility = await resolveToolingCompatibility({ ...input, capability: "prepare", pinnedToolingRoot: toolingRoot });
      await assertAvailable();
      // The task predates its primary session. Persist the capability receipt
      // before launch, independently of the unchanged task tooling pin.
      await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "preparing", environmentStatus: "degraded",
        recoveryDetail: JSON.stringify({ error: detail, compatibility: compatibility.receipt }) } });
      return { toolingRoot, prompt: `${credentialRecovery}\n\nTooling composition failed: ${detail}\n\n${compatibility.prompt}` };
    } catch (failure) { compatibilityFailure = failure instanceof Error ? failure.message : String(failure); }
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "blocked", environmentStatus: "degraded", recoveryDetail: `${detail}; ${compatibilityFailure}` } });
    const prompt = `Task ${task.id} has its product worktree, but tooling preparation failed: ${detail}\nCompatibility unavailable: ${compatibilityFailure}\nUse inspect_task, read this worktree's AGENTS.md, and investigate the setup failure. Tooling source is ${task.toolingRoot} at exact commit ${task.toolingRevision}. Preserve that revision and all product work. Repair missing local dependencies when possible; do not change tracked product configuration or use shared/production services. Report the actual blocker if access is missing. No requested skill was successfully composed; restore its instructions before implementation. Verify readiness before implementing the request.\n\n${describeUnavailableSkills(input.seed)}`;
    const recoveryPrompt = `${credentialRecovery}\n\n${prompt}`;
    return { toolingRoot, prompt: toolingRoot ? withToolingInstructions(recoveryPrompt, input.worktreePath, toolingRoot) : recoveryPrompt };
  }
}
