import type { WorkflowConfig } from "../../../../../lib/config.ts";
import { composeForPrompt } from "../../../../../lib/skills/compose.ts";
import type { WorkerContext, WorkerResult } from "../../../../../types/dispatcher/index.ts";
import { getSourceIssueForWorkflow } from "../../../integrations/linear/session-store/source-issue/read.ts";
import { deliverInstructions, queueInstruction } from "../../../services/sessions/inbox.ts";
import { resolveToolingCompatibility, type CompatibilityReceipt } from "../../../services/tasks/tooling-compatibility.ts";
import { isCurrentMergeApproval, recordOwnerMergeApproval, type OwnerMergeApproval } from "../../../services/tasks/completion.ts";
import type { LinearIssueWebhook } from "../../../integrations/linear/webhook-types/issue.ts";

/** A merge transition continues its task's sole primary. Missing old-pin
 * packaging is handled as a named capability, never by selecting a new task. */
export async function deliverManagedMerge(input: {
  context: WorkerContext; workflow: WorkflowConfig; issueIdentifier: string; webhook: LinearIssueWebhook;
  seed: string; read?: typeof getSourceIssueForWorkflow; compose?: typeof composeForPrompt;
  recordApproval?: (input: Parameters<typeof recordOwnerMergeApproval>[0]) => Promise<OwnerMergeApproval>;
}): Promise<WorkerResult> {
  const { context, workflow, issueIdentifier } = input;
  const { prisma, config } = context;
  const result = (status: WorkerResult["status"], detail: string): WorkerResult => ({ status, detail, targetResourceId: issueIdentifier });
  try {
    if (workflow.on !== "issue.state-changed" || workflow.skill.skillset !== "merge") throw new Error("Merge compatibility requires an owner-selected Merge workflow");
    const tasks = await prisma.remoteTask.findMany({ where: {
      issueIdentifier, connectionId: config.activeConnectionId, repositoryId: config.activeRepositoryId,
      machineId: config.machine, phase: { not: "closed" }, primarySessionId: { not: null },
    } });
    if (tasks.length !== 1) throw new Error("Merge requires exactly one existing task primary for this source issue");
    const task = tasks[0]!;
    const assertAuthority = async () => {
      const current = await prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
      if ((current.ownerPaused || current.phase === "closed") || current.primarySessionId !== task.primarySessionId || current.worktreePath !== task.worktreePath) throw new Error("Merge task is closed or its ownership changed");
      const session = await prisma.runtimeSession.findFirst({ where: {
        id: task.primarySessionId!, role: "primary", status: { not: "closed" }, repositoryId: task.repositoryId,
        machineId: task.machineId, cwd: task.worktreePath ?? "",
        resourceLinks: { some: { provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: issueIdentifier, relationship: "handles", endedAt: null } },
      } });
      if (!session) throw new Error("Merge target is not the task's open owning primary");
      const issue = await (input.read ?? getSourceIssueForWorkflow)(config, { id: issueIdentifier });
      if (!issue || issue.identifier !== issueIdentifier || issue.state.name !== "Merge") throw new Error("Merge authority was revoked: source issue is no longer Merge");
      return { task: current, session };
    };
    const owned = await assertAuthority();
    const instructionId = `workflow-merge:${config.activeConnectionId}:${task.id}:${workflow.id}:${input.webhook.webhookTimestamp}`;
    const prior = await prisma.runtimeInstruction.findUnique({ where: { id: instructionId } });
    if (prior) {
      if (prior.sessionId !== owned.session.id) throw new Error("Merge dispatch identity belongs to another session");
      return result("existing", `Merge instruction ${instructionId} is ${prior.state}${prior.detail ? `: ${prior.detail}` : ""}; inspect this receipt rather than replaying effects`);
    }
    const approval = await (input.recordApproval ?? recordOwnerMergeApproval)({ prisma, config, taskId: task.id, runId: context.runId,
      workflowId: workflow.id, webhook: input.webhook, currentIssueState: "Merge" });
    if (!task.pinnedToolingRoot) throw new Error("Merge task has no recorded pinned tooling checkout; reconcile its preparation first");
    let prompt: string;
    let compatibility: CompatibilityReceipt | null = null;
    try {
      prompt = await (input.compose ?? composeForPrompt)(owned.session.cwd, input.seed, workflow.providerId ?? config.acp.providerId, config.repository.skillsRoot, task.pinnedToolingRoot);
    } catch {
      const recovered = await resolveToolingCompatibility({ task, repository: config.repository, installRoot: config.installRoot,
        capability: "merge", worktreePath: owned.session.cwd, seed: input.seed, pinnedToolingRoot: task.pinnedToolingRoot });
      prompt = recovered.prompt;
      compatibility = recovered.receipt;
    }
    prompt = `Before every resumed lifecycle step, inspect_task and read_source_issue. Proceed only while the task is open and the source issue is still Merge. Preserve the existing primary/worktree and all original task pins. Inspect existing commit/PR/merge/cleanup receipts before repeating an uncertain effect.\n\n${prompt}`;
    const current = await assertAuthority();
    await prisma.$transaction(async (tx) => {
      if (!(await isCurrentMergeApproval(tx, { taskId: task.id, sessionId: owned.session.id, approval }))) throw new Error("Completion authority was revoked or replaced before merge dispatch");
      const guard = await tx.remoteTask.updateMany({ where: { id: task.id, primarySessionId: task.primarySessionId, ownerPaused: false, phase: { not: "closed" } }, data: { recoveryDetail: `Merge instruction ${instructionId} queued${compatibility ? ` through ${compatibility.contract} at ${compatibility.capabilityRevision}` : ""}` } });
      if (!guard.count) throw new Error("Task identity changed before merge dispatch committed");
      await queueInstruction(tx, { sessionId: owned.session.id, requestId: instructionId, text: prompt });
      if (!(await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owned.session.id, action: "workflow-dispatch", key: instructionId } }))) {
        await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owned.session.id, action: "workflow-dispatch", key: instructionId,
          source: `worker:${context.runId}`, value: JSON.stringify({ workflowId: workflow.id, state: "Merge", taskId: task.id, completionApproval: { requestKey: approval.requestKey, contractRevision: approval.contractRevision }, taskToolingRevision: task.toolingRevision, compatibility }) } });
      }
    });
    if (context.agentRuntime) void deliverInstructions(prisma, context.agentRuntime).catch(() => undefined);
    return result("delivered", `Merge queued on the existing primary; instruction ${instructionId}${compatibility ? `; compatibility ${compatibility.capabilityRevision}` : ""}`);
  } catch (error) {
    return result("failed", `Merge continuation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
