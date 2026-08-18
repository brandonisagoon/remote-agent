import { existsSync, readFileSync } from "node:fs";

import {
  DispatchEventType,
  WorkerRunStatus,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../../types/dispatcher/index.ts";
import type { CubeIssueWithAgentIssues } from "../../../services/sessions/registry/index.ts";
import { getCubeIssueWithAgentIssues } from "../../../services/sessions/registry/index.ts";
import { Reaction, reactToIssue } from "../../../integrations/linear/index.ts";
import { postWorktreeLinkComment } from "./comment.ts";
import { decideOrchestration } from "./decide.ts";
import { buildOrchestrationSessionName, orchestrationPaths } from "./launch.ts";
import {
  provisionWorktree,
  spawnAgentThread,
} from "../../../services/launches/index.ts";

type OrchestrationEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.LinearIssueOrchestrationRequested }
>;

export interface OrchestrationWorkerDependencies {
  exists: (file: string) => boolean;
  readPrompt: (file: string) => string;
  getIssue: (
    config: Parameters<typeof getCubeIssueWithAgentIssues>[0],
    query: { id: string },
  ) => Promise<CubeIssueWithAgentIssues | null>;
  react: typeof reactToIssue;
  postWorktreeComment: typeof postWorktreeLinkComment;
  provision?: typeof provisionWorktree;
  launch?: typeof spawnAgentThread;
}

const defaultDependencies: OrchestrationWorkerDependencies = {
  exists: existsSync,
  readPrompt: (file) => readFileSync(file, "utf8").trimEnd(),
  getIssue: getCubeIssueWithAgentIssues,
  react: reactToIssue,
  postWorktreeComment: postWorktreeLinkComment,
};

function result(
  status: WorkerResult["status"],
  detail: string,
  targetAgentIssueIdentifier: string | null = null,
): WorkerResult {
  return { status, detail, targetAgentIssueIdentifier };
}

function commandFailure(
  prefix: string,
  output: { stdout: string; stderr: string },
) {
  const detail = output.stderr.trim() || output.stdout.trim();
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function createOrchestrationWorker(
  dependencies: OrchestrationWorkerDependencies = defaultDependencies,
): Worker<OrchestrationEvent> {
  return {
    key: "product.orchestration",
    supports(event): event is OrchestrationEvent {
      return event.type === DispatchEventType.LinearIssueOrchestrationRequested;
    },
    async execute(event, context) {
      const paths = orchestrationPaths(context.config.workspaceRepoRoot);
      for (const file of [paths.promptFile]) {
        if (!dependencies.exists(file)) {
          return result(
            "failed",
            `required orchestration file is missing: ${file}`,
          );
        }
      }

      const issueIdentifier = event.webhook.data.identifier;
      const issue = await dependencies.getIssue(context.config, {
        id: issueIdentifier,
      });
      if (!issue) return result("failed", "cube issue not found");

      const decision = decideOrchestration({
        issue,
        agentTeamKey: context.config.agentTeamKey,
        orchestrateOnState: context.config.orchestrateOnState,
      });
      if (decision.kind !== "launch") {
        return result(decision.kind, decision.detail);
      }

      const branchResult = await context.commandClient.run("git", [
        "-C",
        context.config.workspaceRepoRoot,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${decision.branchName}`,
      ]);
      if (branchResult.ok) {
        return result(
          WorkerRunStatus.Existing,
          `branch already exists: ${decision.branchName}`,
        );
      }
      if (branchResult.stderr.trim()) {
        return result(
          "failed",
          commandFailure("git show-ref failed", branchResult),
        );
      }

      const prompt = dependencies.readPrompt(paths.promptFile);
      if (!prompt) return result("failed", "orchestration prompt is empty");

      let launched: Awaited<ReturnType<typeof spawnAgentThread>>;
      try {
        const worktreePath = await (
          dependencies.provision ?? provisionWorktree
        )({
          repoRoot: context.config.workspaceRepoRoot,
          branchName: decision.branchName,
        });
        launched = await (dependencies.launch ?? spawnAgentThread)({
          config: context.config,
          prisma: context.prisma,
          bbClient: context.bbClient!,
          machine: context.config.machine,
          worktreePath,
          issueIdentifier,
          branchName: decision.branchName,
          harness: "codex",
          lifecycle: "persistent",
          role: "primary",
          title: buildOrchestrationSessionName(issueIdentifier),
          prompt,
        });
      } catch (error) {
        return result(
          "failed",
          `bb launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const reacted = await dependencies.react(
        context.config.linearApiKey,
        issue.id,
        Reaction.PlanUpdate,
      );
      const commentOutcome = await dependencies.postWorktreeComment({
        config: context.config,
        issueId: issue.id,
        branchName: decision.branchName,
        bbThreadId: launched.thread.id,
      });
      return result(
        "delivered",
        `bb_thread:${launched.thread.id} started; memo reaction ${reacted ? "posted" : "failed"}; worktree link comment ${commentOutcome}`,
        issue.identifier,
      );
    },
  };
}

export const orchestrationWorker = createOrchestrationWorker();
