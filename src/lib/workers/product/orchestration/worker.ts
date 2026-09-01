import { existsSync, readFileSync } from "node:fs";

import {
  DispatchEventType,
  WorkerRunStatus,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../../types/dispatcher/index.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/tracker/index.ts";
import { getSourceIssueWithAgentIssues } from "../../../integrations/tracker/index.ts";
import { TrackerReaction, reactToIssue } from "../../../integrations/tracker/index.ts";
import { postWorktreeLinkComment } from "./comment.ts";
import { decideOrchestration } from "./decide.ts";
import { buildOrchestrationSessionName } from "./launch.ts";
import {
  provisionWorktree,
  spawnAgentThread,
} from "../../../services/launches/index.ts";
import {
  renderWorkflowPrompt,
  workflowPromptPath,
} from "../../../workflows/repository.ts";

type OrchestrationEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerIssueOrchestrationRequested }
>;

export interface OrchestrationWorkerDependencies {
  exists: (file: string) => boolean;
  readPrompt: (file: string) => string;
  getIssue: (
    config: Parameters<typeof getSourceIssueWithAgentIssues>[0],
    query: { id: string },
  ) => Promise<SourceIssueWithAgentIssues | null>;
  react: typeof reactToIssue;
  postWorktreeComment: typeof postWorktreeLinkComment;
  provision?: typeof provisionWorktree;
  launch?: typeof spawnAgentThread;
}

const defaultDependencies: OrchestrationWorkerDependencies = {
  exists: existsSync,
  readPrompt: (file) => readFileSync(file, "utf8").trimEnd(),
  getIssue: getSourceIssueWithAgentIssues,
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
      return event.type === DispatchEventType.TrackerIssueOrchestrationRequested;
    },
    async execute(event, context) {
      const repository = context.config.repository;
      const workflow = repository.workflows.orchestrate;
      const promptFile = workflowPromptPath(repository, "orchestrate");
      if (!dependencies.exists(promptFile)) {
        return result(
          "failed",
          `required orchestration prompt is missing: ${promptFile}`,
        );
      }

      const issueIdentifier = event.webhook.data.identifier;
      const issue = await dependencies.getIssue(context.config, {
        id: issueIdentifier,
      });
      if (!issue) return result("failed", "source issue not found");

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
        repository.root,
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

      const sourcePrompt = dependencies.readPrompt(promptFile);
      if (!sourcePrompt) return result("failed", "orchestration prompt is empty");
      const prompt = renderWorkflowPrompt(sourcePrompt, {
        sourceIssueIdentifier: issue.identifier,
        sourceIssueTitle: issue.title,
        branchName: decision.branchName,
      });

      let launched: Awaited<ReturnType<typeof spawnAgentThread>>;
      try {
        const worktreePath = await (
          dependencies.provision ?? provisionWorktree
        )({
          repository,
          branchName: decision.branchName,
        });
        launched = await (dependencies.launch ?? spawnAgentThread)({
          config: context.config,
          prisma: context.prisma,
          agentRuntime: context.agentRuntime!,
          launchKey: context.runId,
          machine: context.config.machine,
          worktreePath,
          issueIdentifier,
          branchName: decision.branchName,
          harness: workflow.harness,
          ...(workflow.model ? { model: workflow.model } : {}),
          lifecycle: "persistent",
          role: "primary",
          title: buildOrchestrationSessionName(issueIdentifier),
          prompt,
        });
      } catch (error) {
        return result(
          "failed",
          `acpx launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const reacted = await dependencies.react(
        context.config.linearApiKey,
        issue.id,
        TrackerReaction.PlanUpdate,
      );
      const commentOutcome = await dependencies.postWorktreeComment({
        config: context.config,
        issueId: issue.id,
        branchName: decision.branchName,
        runtimeSessionId: launched.session.id,
      });
      return result(
        "delivered",
        `runtime_session:${launched.session.id} started; memo reaction ${reacted ? "posted" : "failed"}; worktree link comment ${commentOutcome}`,
        issue.identifier,
      );
    },
  };
}

export const orchestrationWorker = createOrchestrationWorker();
