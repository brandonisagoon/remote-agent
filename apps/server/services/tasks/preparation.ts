import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { RepositoryConfig } from "../../../../lib/config.ts";
import type { ToolingReleaseRecord } from "../../../../types/tooling-release.ts";
import { composeForPrompt, withToolingInstructions } from "../../../../lib/skills/compose.ts";
import { prepareTooling } from "./tooling.ts";
import { describeUnavailableSkills, resolveToolingCompatibility } from "./tooling-compatibility.ts";

const credentialRecovery = "If required development credentials appear missing, the owning primary can call resolve_tooling_capability with capability development-credentials. This resolves only the owner-configured committed recovery instructions and adapter without repinning the task. Inspect names and integrity before claiming missing access; export only task-required keys into a private task file, never print values or use production fallback, and verify the actual provider operation. Resolution does not itself decrypt or export anything.";

/** A plan-mode session must not repair setup: leaving plan mode can publish a
 * plan and transition the issue. This leads every planning fallback prompt. */
export const PLANNING_SETUP_BLOCKER = "Planning launch — setup failed. This session plans in read-only plan mode. Do not repair, install, export or edit any file, and do not leave plan mode to repair anything: leaving plan mode can publish a plan and change the issue state. Report this setup blocker once with the details below, then stop. Any setup or repair steps below are reference for a later execution launch, not instructions for this session.";

/** A pause or closure saved while preparing. It always propagates: no
 * fallback may overwrite that state or start a recovery agent. */
export class TaskPreparationUnavailable extends Error {
  constructor() { super("Task preparation is closed; preserve its existing work"); }
}

/** A created task worktree is enough to start its repair agent. Missing
    tooling must not turn an otherwise recoverable launch into a dead end. */
export async function prepareTaskPrompt(input: {
  prisma: PrismaClient; task: RemoteTask; repository: RepositoryConfig;
  installRoot: string; worktreePath: string; provider: "codex" | "claude";
  seed: string; compose?: typeof composeForPrompt;
  /** The selection the task was pinned from. Its already prepared immutable
   * checkout is used as-is; preparation never reinstalls a release. */
  release?: ToolingReleaseRecord | null;
  /** Test seam; production resolves the named capability. */
  resolveCompatibility?: typeof resolveToolingCompatibility;
  /** A read-only planning launch: fallbacks report the blocker, never repair. */
  planning?: boolean;
}): Promise<{ prompt: string; toolingRoot?: string }> {
  const { task } = input;
  const release = input.release && input.release.revision === task.toolingRevision && input.release.repositoryId === task.repositoryId ? input.release : undefined;
  const assertAvailable = async () => {
    const current = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    if ((current.ownerPaused || current.phase === "closed")) throw new TaskPreparationUnavailable();
  };
  // Every phase/environment write is conditional on the task still being open.
  const writeOpen = async (data: { phase: string; environmentStatus: string; recoveryDetail: string | null }) => {
    const updated = await input.prisma.remoteTask.updateMany({ where: { id: task.id, ownerPaused: false, phase: { not: "closed" } }, data });
    if (!updated.count) throw new TaskPreparationUnavailable();
  };
  await assertAvailable();
  let toolingRoot: string | undefined;
  try {
    toolingRoot = release ? release.checkout : await prepareTooling({ ...input.repository, tooling: { root: task.toolingRoot, revision: task.toolingRevision } }, input.installRoot);
    await input.prisma.remoteTask.update({ where: { id: task.id }, data: { pinnedToolingRoot: toolingRoot } });
    const prompt = await (input.compose ?? composeForPrompt)(input.worktreePath, input.seed, input.provider, input.repository.skillsRoot, toolingRoot);
    // Composition takes time; never overwrite a pause or closure saved meanwhile.
    await writeOpen({ phase: "preparing", environmentStatus: "preparing", recoveryDetail: null });
    return { prompt: `${credentialRecovery}\n\n${prompt}`, toolingRoot };
  } catch (error) {
    if (error instanceof TaskPreparationUnavailable) throw error;
    await assertAvailable();
    const detail = error instanceof Error ? error.message : String(error);
    let compatibilityFailure: string;
    try {
      const { release: _selected, ...rest } = input;
      const compatibility = await (input.resolveCompatibility ?? resolveToolingCompatibility)({ ...rest, capability: "prepare", pinnedToolingRoot: toolingRoot, ...(release ? { release } : {}) });
      // The task predates its primary session. Persist the capability receipt
      // before launch, independently of the unchanged task tooling pin.
      await writeOpen({ phase: "preparing", environmentStatus: "degraded", recoveryDetail: JSON.stringify({ error: detail, compatibility: compatibility.receipt }) });
      const fallback = `${credentialRecovery}\n\nTooling composition failed: ${detail}\n\n${compatibility.prompt}`;
      return { toolingRoot, prompt: input.planning ? `${PLANNING_SETUP_BLOCKER}\n\n${fallback}` : fallback };
    } catch (failure) {
      if (failure instanceof TaskPreparationUnavailable) throw failure;
      compatibilityFailure = failure instanceof Error ? failure.message : String(failure);
    }
    await writeOpen({ phase: "blocked", environmentStatus: "degraded", recoveryDetail: `${detail}; ${compatibilityFailure}` });
    if (input.planning) {
      // No repair instructions at all: the planning session only reports.
      return { toolingRoot, prompt: `${PLANNING_SETUP_BLOCKER}\n\nTask ${task.id} has its product worktree, but tooling preparation failed: ${detail}\nCompatibility unavailable: ${compatibilityFailure}\nTooling source is ${task.toolingRoot} at exact commit ${task.toolingRevision}. No requested skill was successfully composed.\n\n${describeUnavailableSkills(input.seed)}` };
    }
    const prompt = `Task ${task.id} has its product worktree, but tooling preparation failed: ${detail}\nCompatibility unavailable: ${compatibilityFailure}\nUse inspect_task, read this worktree's AGENTS.md, and investigate the setup failure. Tooling source is ${task.toolingRoot} at exact commit ${task.toolingRevision}. Preserve that revision and all product work. Repair missing local dependencies when possible; do not change tracked product configuration or use shared/production services. Report the actual blocker if access is missing. No requested skill was successfully composed; restore its instructions before implementation. Verify readiness before implementing the request.\n\n${describeUnavailableSkills(input.seed)}`;
    const recoveryPrompt = `${credentialRecovery}\n\n${prompt}`;
    return { toolingRoot, prompt: toolingRoot ? withToolingInstructions(recoveryPrompt, input.worktreePath, toolingRoot) : recoveryPrompt };
  }
}
