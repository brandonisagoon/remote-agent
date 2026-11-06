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
import { getSourceIssueForUpdate, getSourceIssueForWorkflow } from "../../../integrations/linear/session-store/source-issue/read.ts";
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
import { getActiveToolingRelease } from "../../../services/tasks/tooling-releases.ts";
import { provisionTaskWorktree } from "../../../services/tasks/provision.ts";
import { continuePlanningSession } from "./continue-plan.ts";
import { deliverManagedMerge } from "./merge-delivery.ts";
import { buildWorkflowLaunchPrompt, executionConflict, launchIntentRecord, launchOrdering, quotedSourceDescription, resolveLaunchIntent, type LaunchIntent, type SourceComment } from "./launch-intent.ts";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import { fetchIssueCommentTimeline } from "../../../integrations/linear/comments.ts";
import { nativeLaunchControl } from "../../../services/launches/native-takeover.ts";

type WorkflowEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerWorkflowTriggered }
>;

export interface WorkflowWorkerDependencies {
  assertLaunch?: typeof assertNativeLaunch;
  getIssue: (
    config: Parameters<typeof getSourceIssueForWorkflow>[0],
    query: { id: string },
  ) => Promise<WorkflowSourceIssue | null>;
  /** Full comment timeline, or null when it cannot be read completely. */
  readComments?: (config: Parameters<typeof getSourceIssueForWorkflow>[0], issueId: string) => Promise<SourceComment[] | null>;
  react: typeof reactToIssue;
  postWorktreeComment: typeof postWorktreeLinkComment;
  compose?: typeof composeForPrompt;
  provision?: typeof provisionWorktree;
  launch?: typeof spawnAgentThread;
  forward?: typeof forwardMessage;
  hasLiveSession?: typeof hasLivePersistentSessionForResource;
  continuePlan?: typeof continuePlanningSession;
  verifyRelease?: Parameters<typeof prepareTaskPrompt>[0]["verifyRelease"];
}

/** The fetched issue; its change time and state type order the trigger. */
export type WorkflowSourceIssue = SourceIssueWithAgentIssues & {
  updatedAt?: string | null;
  state: { name: string; type?: string | null };
};

const defaultDependencies: WorkflowWorkerDependencies = {
  // Same workflow query, typed with the change time and state type it reads.
  getIssue: getSourceIssueForUpdate,
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
    which carries the actual instructions. A source description is always
    quoted as untrusted task data after the context, never inlined. */
export function buildWorkflowSeedPrompt(
  workflow: WorkflowConfig,
  context: Record<string, string>,
  sourceDescription?: string | null,
): string {
  const details = Object.entries(context).map(([name, value]) => `- ${name}: ${value}`);
  return [
    `Use ${renderSkillToken(workflow.skill)} to handle this workflow.`,
    "",
    "Workflow context",
    `- workflow: ${workflow.id}`,
    ...details,
    ...(sourceDescription !== undefined ? ["", quotedSourceDescription(sourceDescription)] : []),
  ].join("\n");
}

function issueReferenceFromEvent(event: WorkflowEvent): string | null {
  const data = event.webhook.data;
  if ("emoji" in data) {
    return data.issue?.identifier ?? data.issueId ?? data.issue?.id ?? null;
  }
  return data.identifier;
}

/** Persisted owner pause or closure outranks any trigger. Another family's
 * pause blocks a new family for the same issue; resuming stays explicit. */
async function taskLaunchBlocker(prisma: PrismaClient, scope: {
  connectionId: string; repositoryId: string; machineId: string; issueIdentifier: string; requestKey: string;
}): Promise<string | null> {
  const { requestKey, ...family } = scope;
  const tasks = await prisma.remoteTask.findMany({ where: { ...family, OR: [{ phase: { not: "closed" } }, { requestKey }] },
    select: { id: true, requestKey: true, phase: true, ownerPaused: true } });
  const own = tasks.find((task) => task.requestKey === requestKey);
  if (own?.phase === "closed") return `Task ${own.id} for this launch request is closed; preserving it`;
  const paused = tasks.find((task) => task.ownerPaused);
  if (paused) return `Owner paused task ${paused.id} for ${scope.issueIdentifier}; resume it explicitly before launching work`;
  return null;
}

const launching = new Set<string>();

/** A later owner trigger retries a launch that failed before dispatch: the
 * same issue, scope, workflow and branch, a recorded worktree, no primary,
 * and an original worker run that ended failed. It never adopts paused,
 * closed, running or native-owned work, or picks between several. */
async function failedLaunchForRetry(prisma: PrismaClient, scope: {
  connectionId: string; repositoryId: string; machineId: string; issueIdentifier: string; requestKey: string;
}, workflowId: string, branchName: string): Promise<{ task: { id: string; requestKey: string }; originalTrigger?: string } | { conflict: string } | null> {
  const { requestKey, ...family } = scope;
  const candidates = await prisma.remoteTask.findMany({ where: { ...family, branchName, requestKey: { not: requestKey },
    phase: "blocked", ownerPaused: false, primarySessionId: null, worktreePath: { not: null } } });
  const runs = await prisma.workerRun.findMany({ where: { id: { in: candidates.map((task) => task.requestKey) }, workerKey: `product.workflow:${workflowId}`, status: "failed" } });
  const failed = candidates.filter((task) => runs.some((run) => run.id === task.requestKey));
  if (!failed.length) return null;
  if (failed.length > 1) return { conflict: `Multiple failed launches for ${scope.issueIdentifier} need reconciliation; nothing was retried` };
  if (await nativeLaunchControl(prisma, scope)) return null;
  const task = failed[0]!;
  const detail = runs.find((run) => run.id === task.requestKey)?.detail ?? "";
  const recorded = /launch intent (\{.*\})$/.exec(detail)?.[1];
  let originalTrigger: string | undefined;
  try { if (recorded) { const intent = JSON.parse(recorded); originalTrigger = `${intent.trigger} by ${intent.actorId ?? "an unknown actor"} at ${intent.occurredAt ?? "an unknown time"}`; } } catch { /* provenance is optional */ }
  return { task: { id: task.id, requestKey: task.requestKey }, ...(originalTrigger ? { originalTrigger } : {}) };
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
            seed: buildWorkflowSeedPrompt(workflow, { sourceIssueIdentifier: issue.identifier, sourceIssueState: issue.state.name }, issue.description) });
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
            }, issue.description);
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

      let intent: LaunchIntent = resolveLaunchIntent({ config: context.config, workflow, webhook: event.webhook, requestKey: context.runId });
      const launchIssue = { identifier: issue.identifier, title: issue.title, description: issue.description ?? null,
        updatedAt: issue.updatedAt ?? null, state: issue.state };
      // Unverified execution, a closed source or a newer state never reaches
      // native resume, plan continuation or a fresh launch.
      const conflict = executionConflict(intent, launchIssue, event.webhook);
      if (conflict) return result("ignored", conflict, issue.identifier);
      const intentSummary = `${intent.mode}; owner authority ${intent.authority.verified ? "verified" : "not established"}`;
      const ordering = launchOrdering(context.config, intent, launchIssue, intent.mode === "execution"
        ? await (dependencies.readComments ?? ((config, id) => fetchIssueCommentTimeline(config.linearApiKey, id)))(context.config, issue.id)
        : []);

      if (!dependencies.assertLaunch && event.webhook.type === "Reaction") {
        const resumed = await freshReactionNativeLaunch({ prisma: context.prisma, config: context.config, runtime: context.agentRuntime! },
          { connectionId: context.config.activeConnectionId, repositoryId: repository.id, issueId: issue.id, issueIdentifier: issue.identifier }, context.runId, event.webhook.data,
          task => (dependencies.compose ?? composeForPrompt)(task.worktreePath!, buildWorkflowLaunchPrompt({ workflow, intent, issue: launchIssue, ordering,
            details: { taskId: task.id }, continuation: { kind: "native-resume" } }),
            provider, repository.skillsRoot, task.pinnedToolingRoot!));
        if (resumed) return result("delivered", `Fresh owner reaction queued on original runtime_session:${resumed}`, issue.identifier);
      }
      try { await (dependencies.assertLaunch ?? assertNativeLaunch)(context.prisma, { connectionId: context.config.activeConnectionId, repositoryId: repository.id, issueIdentifier: issue.identifier }, context.runId); }
      catch (error) { if (error instanceof NativeLaunchWithdrawnError) return result("ignored", error.message, issue.identifier); throw error; }

      // A planning primary is an existing conversation to continue, not a
      // duplicate implementation launch. Resolve it before the generic guard.
      const continuation = await (dependencies.continuePlan ?? continuePlanningSession)({
        context, workflow, issueIdentifier: issue.identifier, compose: dependencies.compose, verifyRelease: dependencies.verifyRelease,
        intent: launchIntentRecord(intent),
        seed: ({ previousWorkflowId, ...details }) => buildWorkflowLaunchPrompt({ workflow, intent, issue: launchIssue, ordering,
          details, continuation: { kind: "plan", previousWorkflowId } }),
      });
      if (continuation) {
        if (continuation.status === "delivered") await dependencies.react(context.config.linearApiKey, issue.id, acknowledgementReaction(event));
        return continuation;
      }

      // Otherwise start a fresh worktree and persistent primary.
      let taskScope = { connectionId: context.config.activeConnectionId, repositoryId: repository.id,
        machineId: context.config.machine, issueIdentifier: issue.identifier, requestKey: context.runId };
      if (repository.tooling) {
        const blocker = await taskLaunchBlocker(context.prisma, taskScope);
        if (blocker) return result("ignored", blocker, issue.identifier);
      }
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
      if (repository.tooling) {
        const retry = await failedLaunchForRetry(context.prisma, taskScope, workflow.id, branchName);
        if (retry && "conflict" in retry) return result("ignored", retry.conflict, issue.identifier);
        if (retry) {
          taskScope = { ...taskScope, requestKey: retry.task.requestKey };
          intent = { ...intent, requestKey: retry.task.requestKey, retryKey: context.runId, ...(retry.originalTrigger ? { originalTrigger: retry.originalTrigger } : {}) };
        }
      }
      const lock = `${context.config.controlIpcPath}:${taskScope.requestKey}`;
      if (launching.has(lock)) return result(WorkerRunStatus.Existing, `launch request ${taskScope.requestKey} is already launching in this process`, issue.identifier);
      launching.add(lock);
      try {
      const selection = repository.tooling ? await getActiveToolingRelease({ prisma: context.prisma, config: context.config, repositoryId: repository.id }) : null;
      const task = repository.tooling ? await beginTask(context.prisma, {
        requestKey: taskScope.requestKey,
        repository,
        selection,
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
        // Never overwrite an owner pause or closure saved since the blocker check.
        if (task) await context.prisma.remoteTask.updateMany({ where: { id: task.id, ownerPaused: false, phase: { not: "closed" } },
          data: { phase: "blocked", recoveryDetail: `Branch already exists outside this task: ${branchName}` } });
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
        const seed = buildWorkflowLaunchPrompt({ workflow, intent, issue: launchIssue, ordering,
          details: { branchName, ...(task ? { taskId: task.id } : {}) }, preparation: Boolean(task) });
        const { prompt, toolingRoot } = task
          ? await prepareTaskPrompt({ prisma: context.prisma, task, repository, installRoot: context.config.installRoot, worktreePath, provider, seed, compose: dependencies.compose, planning: intent.mode === "planning", release: selection?.release ?? null, verifyRelease: dependencies.verifyRelease })
          : { prompt: await (dependencies.compose ?? composeForPrompt)(worktreePath, seed, provider, repository.skillsRoot, worktreePath), toolingRoot: worktreePath };
        await (dependencies.assertLaunch ?? assertNativeLaunch)(context.prisma, { connectionId: context.config.activeConnectionId, repositoryId: repository.id, issueIdentifier: issue.identifier }, context.runId);
        // Composition can take a while: an owner pause or closure saved
        // meanwhile wins over this trigger. The runtime rechecks at dispatch.
        if (task) {
          const blocker = await taskLaunchBlocker(context.prisma, taskScope);
          if (blocker) return result("ignored", blocker, issue.identifier);
          // Durable intent before the uncertain launch; a later retry reads it.
          await context.prisma.workerRun.updateMany({ where: { id: context.runId, status: "pending" },
            data: { detail: `launching task ${task.id}; launch intent ${JSON.stringify(launchIntentRecord(intent))}` } });
        }
        launched = await (dependencies.launch ?? spawnAgentThread)({
          config: context.config,
          prisma: context.prisma,
          agentRuntime: context.agentRuntime!,
          launchKey: taskScope.requestKey,
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
        if (task) {
          const blocker = await taskLaunchBlocker(context.prisma, taskScope);
          if (blocker) return result("ignored", blocker, issue.identifier);
          await context.prisma.remoteTask.updateMany({ where: { id: task.id, phase: { not: "closed" }, ownerPaused: false },
            data: { phase: "blocked", recoveryDetail: error instanceof Error ? error.message : String(error) } });
        }
        return result(
          "failed",
          `workflow launch failed: ${error instanceof Error ? error.message : String(error)}${task ? `; launch intent ${JSON.stringify(launchIntentRecord(intent))}` : ""}`,
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
        `runtime_session:${launched.session.id} started by workflow ${workflow.id} (${intentSummary}${intent.retryKey ? `; retried failed launch ${intent.requestKey}` : ""}); reaction ${reacted ? "posted" : "failed"}; worktree link comment ${commentOutcome}`,
        issue.identifier,
      );
      } finally { launching.delete(lock); }
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
