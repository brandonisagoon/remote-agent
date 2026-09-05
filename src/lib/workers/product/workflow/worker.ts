import {
  DispatchEventType,
  WorkerRunStatus,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../../types/dispatcher/index.ts";
import type { WorkflowConfig } from "../../../config.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/linear/session-store/source-issue/types.ts";
import { getSourceIssueForWorkflow } from "../../../integrations/linear/session-store/source-issue/read.ts";
import { TrackerReaction, reactToIssue } from "../../../integrations/linear/reactions.ts";
import { forwardMessage } from "../../../services/messages/index.ts";
import {
  provisionWorktree,
  spawnAgentThread,
} from "../../../services/launches/index.ts";
import { hasLivePersistentSessionForResource } from "../../../services/sessions/runtime-registry.ts";
import { composeForPrompt, renderSkillToken } from "../../../skills/compose.ts";
import { postWorktreeLinkComment } from "./comment.ts";
import { isSafeBranchName } from "./branch.ts";
import { buildWorkflowSessionName } from "./launch.ts";

type WorkflowEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerWorkflowTriggered }
>;

export interface WorkflowWorkerDependencies {
  getIssue: (
    config: Parameters<typeof getSourceIssueForWorkflow>[0],
    query: { id: string },
  ) => Promise<SourceIssueWithAgentIssues | null>;
  react: typeof reactToIssue;
  postWorktreeComment: typeof postWorktreeLinkComment;
  compose?: typeof composeForPrompt;
  provision?: typeof provisionWorktree;
  launch?: typeof spawnAgentThread;
  forward?: typeof forwardMessage;
  hasLiveSession?: typeof hasLivePersistentSessionForResource;
}

const defaultDependencies: WorkflowWorkerDependencies = {
  getIssue: getSourceIssueForWorkflow,
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

/** The seed prompt embeds the workflow's skill token; the compose pipeline
    later swaps it for the harness-specific invocation of the composed skill,
    which carries the actual instructions. */
export function buildWorkflowSeedPrompt(
  workflow: WorkflowConfig,
  context: Record<string, string>,
): string {
  const details = Object.entries(context).map(([name, value]) => `- ${name}: ${value}`);
  return [
    `Use ${renderSkillToken(workflow.skill)} to handle this workflow.`,
    "",
    "Workflow context",
    `- workflow: ${workflow.id}`,
    ...details,
  ].join("\n");
}

function issueReferenceFromEvent(event: WorkflowEvent): string | null {
  const data = event.webhook.data;
  if ("emoji" in data) {
    return data.issue?.identifier ?? data.issueId ?? data.issue?.id ?? null;
  }
  return data.identifier;
}

export function createWorkflowWorker(
  dependencies: WorkflowWorkerDependencies = defaultDependencies,
): Worker<WorkflowEvent> {
  return {
    key: "product.workflow",
    supports(event): event is WorkflowEvent {
      return event.type === DispatchEventType.TrackerWorkflowTriggered;
    },
    async execute(event, context) {
      const repository = context.config.repository;
      const workflow = repository.workflows[event.workflowId];
      if (!workflow) {
        return result("failed", `workflow no longer configured: ${event.workflowId}`);
      }
      const harness = workflow.providerId ?? context.config.acp.providerId;

      const issueRef = issueReferenceFromEvent(event);
      if (!issueRef) return result("failed", "event has no issue reference");
      const issue = await dependencies.getIssue(context.config, { id: issueRef });
      if (!issue) return result("failed", "source issue not found");

      if (workflow.deliver === "message-session") {
        return (dependencies.forward ?? forwardMessage)({
          config: context.config,
          prisma: context.prisma,
          agentRuntime: context.agentRuntime!,
          sourceIssueIdentifier: issue.identifier,
          workerContext: {
            key: `product.workflow.${workflow.id}`,
            routingHint:
              "Prefer the Primary session that worked on the source issue; otherwise prefer the only eligible Primary.",
          },
          message: `Run the ${workflow.id} workflow for ${issue.identifier} (state: ${issue.state.name}).`,
          finalizeMessage: async (target) => {
            const seed = buildWorkflowSeedPrompt(workflow, {
              sourceIssueIdentifier: issue.identifier,
              sourceIssueState: issue.state.name,
            });
            return (dependencies.compose ?? composeForPrompt)(
              target.runtime.worktreePath,
              seed,
              harness,
              repository.skillsRoot,
            );
          },
        });
      }

      // start-session: fresh worktree, composed skill, persistent primary.
      if (await (dependencies.hasLiveSession ?? hasLivePersistentSessionForResource)(context.prisma, {
        repositoryId: repository.id,
        provider: "linear",
        connectionId: context.config.activeConnectionId,
        resourceType: "issue-identifier",
        externalId: issue.identifier,
      })) {
        return result("ignored", "a live persistent runtime session already handles this issue");
      }

      const branchName = issue.branchName?.trim();
      if (!branchName) return result("failed", "source issue has no branch name");
      if (!isSafeBranchName(branchName)) {
        return result("failed", `unsafe branch name: ${branchName}`);
      }
      const branchResult = await context.commandClient.run("git", [
        "-C",
        repository.root,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ]);
      if (branchResult.ok) {
        return result(WorkerRunStatus.Existing, `branch already exists: ${branchName}`);
      }
      if (branchResult.stderr.trim()) {
        return result("failed", commandFailure("git show-ref failed", branchResult));
      }

      let launched: Awaited<ReturnType<typeof spawnAgentThread>>;
      try {
        const worktreePath = await (dependencies.provision ?? provisionWorktree)({
          repository,
          branchName,
        });
        const seed = buildWorkflowSeedPrompt(workflow, {
          sourceIssueIdentifier: issue.identifier,
          sourceIssueTitle: issue.title,
          branchName,
        });
        const prompt = await (dependencies.compose ?? composeForPrompt)(
          worktreePath,
          seed,
          harness,
          repository.skillsRoot,
        );
        launched = await (dependencies.launch ?? spawnAgentThread)({
          config: context.config,
          prisma: context.prisma,
          agentRuntime: context.agentRuntime!,
          launchKey: context.runId,
          machine: context.config.machine,
          worktreePath,
          issueIdentifier: issue.identifier,
          branchName,
          harness,
          ...(workflow.model ? { model: workflow.model } : {}),
          lifecycle: "persistent",
          role: "primary",
          title: buildWorkflowSessionName(workflow.id, issue.identifier),
          prompt,
          workflowId: workflow.id,
          // Plan capture: the session plans in native plan mode; the daemon
          // persists the plan on exit-plan-mode approval.
          ...(workflow.plan?.captureToIssue ? { mode: "plan" } : {}),
        });
      } catch (error) {
        return result(
          "failed",
          `workflow launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Reaction-triggered workflows acknowledge with the describe emoji;
      // state-triggered ones with the plan memo.
      const reacted = await dependencies.react(
        context.config.linearApiKey,
        issue.id,
        workflow.on === "issue.reaction" ? TrackerReaction.Describing : TrackerReaction.PlanUpdate,
      );
      const commentOutcome = await dependencies.postWorktreeComment({
        config: context.config,
        issueId: issue.id,
        branchName,
        runtimeSessionId: launched.session.id,
        prisma: context.prisma,
      });
      return result(
        "delivered",
        `runtime_session:${launched.session.id} started by workflow ${workflow.id}; reaction ${reacted ? "posted" : "failed"}; worktree link comment ${commentOutcome}`,
        issue.identifier,
      );
    },
  };
}

export const workflowWorker = createWorkflowWorker();
