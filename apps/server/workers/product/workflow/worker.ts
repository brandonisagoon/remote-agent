import { assertNativeLaunch, freshReactionNativeLaunch, isFreshNativeReaction, withNativeLaunchWork, NativeLaunchWithdrawnError } from "../../../services/launches/native-takeover.ts";
import {
  DispatchEventType,
  WorkerRunStatus,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../../../types/dispatcher/index.ts";
import type { WorkflowConfig } from "../../../../../lib/config.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/linear/session-store/source-issue/types.ts";
import { getSourceIssueForWorkflow } from "../../../integrations/linear/session-store/source-issue/read.ts";
import { TrackerReaction, reactToIssue } from "../../../integrations/linear/reactions.ts";
import { forwardMessage } from "../../../services/messages/index.ts";
import {
  provisionWorktree,
  spawnAgentThread,
} from "../../../services/launches/index.ts";
import { hasLivePersistentSessionForResource } from "../../../services/sessions/runtime-registry.ts";
import { composeForPrompt, renderSkillToken } from "../../../../../lib/skills/compose.ts";
import { postWorktreeLinkComment } from "./comment.ts";
import { branchTemplateFor, isSafeBranchName, renderBranchName, renderWorktreeName } from "./branch.ts";
import { buildWorkflowSessionName } from "./launch.ts";
import { beginTask, taskForSession } from "../../../services/tasks/store.ts";
import { prepareTaskPrompt } from "../../../services/tasks/preparation.ts";
import { provisionTaskWorktree } from "../../../services/tasks/provision.ts";
import { continuePlanningSession } from "./continue-plan.ts";
import { deliverManagedMerge } from "./merge-delivery.ts";

type WorkflowEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerWorkflowTriggered }
>;

export interface WorkflowWorkerDependencies {
  assertLaunch?: typeof assertNativeLaunch;
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
  continuePlan?: typeof continuePlanningSession;
}

const defaultDependencies: WorkflowWorkerDependencies = {
  getIssue: getSourceIssueForWorkflow,
  react: reactToIssue,
  postWorktreeComment: postWorktreeLinkComment,
};

function result(
  status: WorkerResult["status"],
  detail: string,
  targetResourceId: string | null = null,
): WorkerResult {
  return { status, detail, targetResourceId };
}

function commandFailure(
  prefix: string,
  output: { stdout: string; stderr: string },
) {
  const detail = output.stderr.trim() || output.stdout.trim();
  return detail ? `${prefix}: ${detail}` : prefix;
}

/** The seed prompt embeds the workflow's skill token; the compose pipeline
    later swaps it for the provider-specific invocation of the composed skill,
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

/** Acknowledge the owner's actual trigger, not the workflow's display name. */
export function acknowledgementReaction(event: WorkflowEvent): string {
  const data = event.webhook.data;
  return "emoji" in data ? data.emoji : TrackerReaction.PlanUpdate;
}

export function createWorkflowWorker(
  dependencies: WorkflowWorkerDependencies = defaultDependencies,
): Worker<WorkflowEvent> {
  const worker: Worker<WorkflowEvent> = {
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
      const provider = workflow.providerId ?? context.config.acp.providerId;

      const issueRef = issueReferenceFromEvent(event);
      if (!issueRef) return result("failed", "event has no issue reference");
      // A saved withdrawal is local authority: do not make a provider lookup
      // just to reject an old or unprovably fresh accepted launch.
      if (workflow.deliver === "start-session" && !dependencies.assertLaunch) {
        const fence = await context.prisma.nativeTakeover.findFirst({ where: { connectionId: context.config.activeConnectionId, repositoryId: repository.id,
          OR: [{ issueId: issueRef }, { issueIdentifier: issueRef }] } });
        if (fence && !(fence.mode === "managed" && fence.grantKey === context.runId)
          && !(event.webhook.type === "Reaction" && isFreshNativeReaction(context.config, repository.id, fence.decidedAt, event.webhook.data))) return result("ignored", "Launch withdrawn by native ownership", fence.issueIdentifier);
      }
      const issue = await dependencies.getIssue(context.config, { id: issueRef });
      if (!issue) return result("failed", "source issue not found");

      if (workflow.deliver === "message-session") {
        if (repository.tooling && workflow.skill.skillset === "merge") {
          if (event.webhook.type !== "Issue" || event.webhook.data.state?.name !== "Merge") return result("failed", "Merge requires an owner-selected Merge state transition");
          return deliverManagedMerge({ context, workflow, issueIdentifier: issue.identifier, webhook: event.webhook,
            read: dependencies.getIssue, compose: dependencies.compose,
            seed: buildWorkflowSeedPrompt(workflow, { sourceIssueIdentifier: issue.identifier, sourceIssueState: issue.state.name, sourceIssueDescription: issue.description ?? "(No description)" }) });
        }
        return (dependencies.forward ?? forwardMessage)({
          requestId: `worker:${context.runId}`,
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
            const task = repository.tooling
              ? await taskForSession(context.prisma, target.runtime.sessionKey)
              : null;
            if (repository.tooling && !task?.pinnedToolingRoot) throw new Error("Session has no pinned tooling source; reconcile before composing follow-up skills");
            const seed = buildWorkflowSeedPrompt(workflow, {
              sourceIssueIdentifier: issue.identifier,
              sourceIssueState: issue.state.name,
              sourceIssueDescription: issue.description ?? "(No description)",
            });
            return (dependencies.compose ?? composeForPrompt)(
              target.runtime.worktreePath,
              seed,
              provider,
              repository.skillsRoot,
              task?.pinnedToolingRoot ?? target.runtime.worktreePath,
            );
          },
        });
      }

      if (!dependencies.assertLaunch && event.webhook.type === "Reaction") {
        const resumed = await freshReactionNativeLaunch({ prisma: context.prisma, config: context.config, runtime: context.agentRuntime! },
          { connectionId: context.config.activeConnectionId, repositoryId: repository.id, issueId: issue.id, issueIdentifier: issue.identifier }, context.runId, event.webhook.data,
          task => (dependencies.compose ?? composeForPrompt)(task.worktreePath!, buildWorkflowSeedPrompt(workflow, { sourceIssueIdentifier: issue.identifier, sourceIssueTitle: issue.title,
            sourceIssueDescription: issue.description ?? "(No description)", continuation: "The owner requested this workflow after native takeover. Continue the same original task and pinned tooling.", taskId: task.id }),
            provider, repository.skillsRoot, task.pinnedToolingRoot!));
        if (resumed) return result("delivered", `Fresh owner reaction queued on original runtime_session:${resumed}`, issue.identifier);
      }
      try { await (dependencies.assertLaunch ?? assertNativeLaunch)(context.prisma, { connectionId: context.config.activeConnectionId, repositoryId: repository.id, issueIdentifier: issue.identifier }, context.runId); }
      catch (error) { if (error instanceof NativeLaunchWithdrawnError) return result("ignored", error.message, issue.identifier); throw error; }

      // A planning primary is an existing conversation to continue, not a
      // duplicate implementation launch. Resolve it before the generic guard.
      const continuation = await (dependencies.continuePlan ?? continuePlanningSession)({
        context, workflow, issueIdentifier: issue.identifier, compose: dependencies.compose,
        seed: buildWorkflowSeedPrompt(workflow, {
          sourceIssueIdentifier: issue.identifier,
          sourceIssueTitle: issue.title,
          sourceIssueDescription: issue.description ?? "(No description)",
        }),
      });
      if (continuation) {
        if (continuation.status === "delivered") await dependencies.react(context.config.linearApiKey, issue.id, acknowledgementReaction(event));
        return continuation;
      }

      // Otherwise start a fresh worktree and persistent primary.
      if (await (dependencies.hasLiveSession ?? hasLivePersistentSessionForResource)(context.prisma, {
        repositoryId: repository.id,
        provider: "linear",
        connectionId: context.config.activeConnectionId,
        resourceType: "issue-identifier",
        externalId: issue.identifier,
      })) {
        return result("ignored", "a live persistent runtime session already handles this issue");
      }

      // Repository-owned convention rendered from provider facts.
      const connection = context.config.connections[context.config.activeConnectionId];
      const template = branchTemplateFor(repository.branchNaming, {
        provider: connection?.provider ?? "linear",
        workspace: connection?.workspace ?? null,
      });
      const branchName = renderBranchName(template, {
        branch: issue.branchName,
        issue: issue.identifier,
        title: issue.title,
      });
      if (!branchName) {
        return result(
          "failed",
          `branch template '${template}' rendered empty — the provider supplied no branch name for this resource`,
        );
      }
      if (!isSafeBranchName(branchName)) {
        return result("failed", `unsafe branch name: ${branchName}`);
      }
      const task = repository.tooling ? await beginTask(context.prisma, {
        requestKey: context.runId,
        repository,
        machineId: context.config.machine,
        connectionId: context.config.activeConnectionId,
        issueIdentifier: issue.identifier,
        branchName,
      }) : null;
      if (task?.primarySessionId) return result(WorkerRunStatus.Existing, `task ${task.id} already owns runtime_session:${task.primarySessionId}`);
      const branchResult = await context.commandClient.run("git", [
        "-C",
        repository.root,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ]);
      if (branchResult.ok && !task?.worktreePath) {
        if (task) await context.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "blocked", recoveryDetail: `Branch already exists outside this task: ${branchName}` } });
        return result(WorkerRunStatus.Existing, `branch already exists: ${branchName}`);
      }
      if (branchResult.stderr.trim()) {
        return result("failed", commandFailure("git show-ref failed", branchResult));
      }

      let launched: Awaited<ReturnType<typeof spawnAgentThread>>;
      let worktreePath = "";
      try {
        const directoryName = renderWorktreeName(
            repository.worktreeNaming[context.config.activeConnectionId] ??
              repository.worktreeNaming["*"] ??
              "{branch}",
            {
              branch: issue.branchName,
              issue: issue.identifier,
              title: issue.title,
            },
            branchName,
          );
        worktreePath = task
          ? await provisionTaskWorktree(context.prisma, task.id, repository, directoryName)
          : await (dependencies.provision ?? provisionWorktree)({ repository, branchName, directoryName });
        const seed = buildWorkflowSeedPrompt(workflow, {
          sourceIssueIdentifier: issue.identifier,
          sourceIssueTitle: issue.title,
          sourceIssueDescription: issue.description ?? "(No description)",
          branchName,
          ...(task ? { taskId: task.id, preparation: "Prepare and verify this environment before implementing. Report failures and resource ownership through the remote-agent task tools." } : {}),
        });
        const { prompt, toolingRoot } = task
          ? await prepareTaskPrompt({ prisma: context.prisma, task, repository, installRoot: context.config.installRoot, worktreePath, provider, seed, compose: dependencies.compose })
          : { prompt: await (dependencies.compose ?? composeForPrompt)(worktreePath, seed, provider, repository.skillsRoot, worktreePath), toolingRoot: worktreePath };
        await (dependencies.assertLaunch ?? assertNativeLaunch)(context.prisma, { connectionId: context.config.activeConnectionId, repositoryId: repository.id, issueIdentifier: issue.identifier }, context.runId);
        launched = await (dependencies.launch ?? spawnAgentThread)({
          config: context.config,
          prisma: context.prisma,
          agentRuntime: context.agentRuntime!,
          launchKey: context.runId,
          machine: context.config.machine,
          worktreePath,
          issueIdentifier: issue.identifier,
          branchName,
          provider,
          ...(workflow.model ? { model: workflow.model } : {}),
          lifecycle: "persistent",
          role: "primary",
          title: buildWorkflowSessionName(workflow.id, issue.identifier),
          prompt,
          workflowId: workflow.id,
          ...(task ? { taskId: task.id, toolingRoot } : {}),
          // Plan capture: the session plans in native plan mode; the server
          // persists the plan on exit-plan-mode approval.
          ...(workflow.plan?.captureToIssue ? { mode: "plan" } : {}),
        });
      } catch (error) {
        if (error instanceof NativeLaunchWithdrawnError) return result("ignored", error.message, issue.identifier);
        if (task) await context.prisma.remoteTask.update({ where: { id: task.id }, data: { phase: "blocked", recoveryDetail: error instanceof Error ? error.message : String(error) } });
        return result(
          "failed",
          `workflow launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const reacted = await dependencies.react(
        context.config.linearApiKey,
        issue.id,
        acknowledgementReaction(event),
      );
      const commentOutcome = await dependencies.postWorktreeComment({
        config: context.config,
        issueId: issue.id,
        worktreePath,
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
  return { ...worker, execute(event, context) {
    const issue = issueReferenceFromEvent(event);
    if (!issue || context.config.repository.workflows[event.workflowId]?.deliver !== "start-session") return worker.execute(event, context);
    return withNativeLaunchWork(context.prisma, { connectionId: context.config.activeConnectionId, repositoryId: context.config.repository.id, issue }, context.runId,
      () => worker.execute(event, context));
  } };
}

export const workflowWorker = createWorkflowWorker();
