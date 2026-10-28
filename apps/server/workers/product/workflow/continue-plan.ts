import type { WorkflowConfig } from "../../../../../lib/config.ts";
import { composeForPrompt } from "../../../../../lib/skills/compose.ts";
import type { WorkerContext, WorkerResult } from "../../../../../types/dispatcher/index.ts";
import { deliverInstructions } from "../../../services/sessions/inbox.ts";
import { taskForSession } from "../../../services/tasks/store.ts";
import { buildWorkflowSessionName } from "./launch.ts";

const continuing = new Set<string>();

/** A start workflow following a plan continues the existing conversation.
 * The inbox reservation holds later messages until provider/model setup and
 * the workflow change have committed together with the execution prompt. */
export async function continuePlanningSession(input: {
  context: WorkerContext;
  workflow: WorkflowConfig;
  issueIdentifier: string;
  seed: string;
  compose?: typeof composeForPrompt;
  /** The runtime owner drains the durable inbox; maintenance callers can
   * leave delivery to that owner's existing loop. */
  wakeDelivery?: () => Promise<void>;
}): Promise<WorkerResult | null> {
  const { context, workflow, issueIdentifier } = input;
  const { prisma, config, agentRuntime: runtime } = context;
  if (workflow.plan || !runtime) return null;
  const sessions = await prisma.runtimeSession.findMany({ where: {
    repositoryId: config.repository.id, machineId: config.machine,
    role: "primary", lifecycle: "persistent", status: { not: "closed" },
    resourceLinks: { some: {
      provider: "linear", connectionId: config.activeConnectionId,
      resourceType: "issue-identifier", externalId: issueIdentifier,
      relationship: "handles", endedAt: null,
    } },
  } });
  const planned = sessions.filter((session) => session.workflowId !== workflow.id &&
    config.repository.workflows[session.workflowId ?? ""]?.plan?.captureToIssue);
  if (!planned.length) return null;
  const result = (status: WorkerResult["status"], detail: string): WorkerResult =>
    ({ status, detail, targetResourceId: issueIdentifier });
  if (sessions.length !== 1) return result("failed", "Multiple primary sessions handle this issue; reconcile before continuing its plan");
  const session = planned[0]!;
  const key = `${config.controlIpcPath}:${session.id}`;
  if (continuing.has(key)) return result("existing", `runtime_session:${session.id} is already changing workflows`);
  continuing.add(key);
  const instructionId = `workflow:${session.id}:${session.workflowId}:${workflow.id}`;
  let reserved = false;
  try {
    const previous = await prisma.runtimeInstruction.findUnique({ where: { id: instructionId } });
    if (previous && !["preparing", "preparation-failed"].includes(previous.state)) {
      return result("existing", `runtime_session:${session.id} already received workflow ${workflow.id}; instruction ${previous.state}`);
    }
    const task = await taskForSession(prisma, session.id);
    if (task && (task.primarySessionId !== session.id || task.controlMode !== "agent" || task.phase === "closed")) {
      throw new Error("Task is not available for automated workflow continuation; preserve its current owner and control");
    }
    if (config.repository.tooling && !task?.pinnedToolingRoot) throw new Error("Planning session has no pinned tooling source");
    const assertIdle = async () => {
      const current = await runtime.getSession(session.id);
      if (current?.status !== "idle") throw new Error(`Planning session is ${current?.status ?? "unavailable"}; wait until it is idle before continuing`);
      if (await prisma.runtimeInstruction.count({ where: {
        sessionId: session.id, id: { not: instructionId },
        OR: [
          { state: { in: ["dispatching", "unknown", "preparing"] } },
          { state: "queued", ...(previous ? { sequence: { lt: previous.sequence } } : {}) },
        ],
      } })) throw new Error("Planning session has pending or uncertain instructions; resolve them before changing workflows");
      if (await prisma.runtimeSession.count({ where: {
        cwd: session.cwd, id: { not: session.id }, status: { in: ["active", "provisioning"] },
      } })) throw new Error("Another session is still working in this worktree; wait before continuing the plan");
    };
    await assertIdle();
    const provider = workflow.providerId ?? config.acp.providerId;
    const prompt = previous?.text ?? await (input.compose ?? composeForPrompt)(
      session.cwd,
      `${input.seed}\n- previousWorkflow: ${session.workflowId}\n- continuation: The owner requested execution after planning. Use the existing plan and worktree; this is no longer a planning-only turn.${task ? `\n- taskId: ${task.id}\n- branchName: ${task.branchName}` : ""}`,
      provider, config.repository.skillsRoot, task?.pinnedToolingRoot ?? session.cwd,
    );
    // Recheck after composition, which may take time. The reservation blocks
    // inbox delivery during the following asynchronous provider operations.
    await assertIdle();
    await prisma.runtimeInstruction.upsert({ where: { id: instructionId },
      create: { id: instructionId, sessionId: session.id, text: prompt, state: "preparing" },
      update: { state: "preparing", detail: null },
    });
    reserved = true;
    if (session.agentCommand !== provider) {
      // Retain the previous provider transcript identity when switchAgent
      // replaces its backing record. Remote Agent's public session ID stays.
      await prisma.runtimeMetadataEvent.create({ data: {
        runtimeSessionId: session.id, action: "workflow-handoff", key: "previous-provider",
        value: JSON.stringify({ workflowId: session.workflowId, agent: session.agentCommand,
          acpxRecordId: session.acpxRecordId, acpxSessionId: session.acpxSessionId, agentSessionId: session.agentSessionId }),
        source: `worker:${context.runId}`,
      } });
    }
    const ready = await runtime.switchAgent(session.id, provider);
    if (workflow.model) {
      const option = ready.configOptions.find((entry) => entry.category === "model" || entry.id === "model");
      if (!option) throw new Error(`Provider ${provider} does not expose a model setting`);
      const updated = await runtime.setConfigOption(session.id, option.id, workflow.model);
      if (!updated.some((entry) => entry.id === option.id && entry.currentValue === workflow.model)) {
        throw new Error(`Provider did not accept workflow model ${workflow.model}`);
      }
    }
    if (provider === "claude") await runtime.setMode(session.id, "default");
    await prisma.$transaction(async (tx) => {
      if (task) {
        const available = await tx.remoteTask.updateMany({ where: {
          id: task.id, primarySessionId: session.id, controlMode: "agent", controlGeneration: task.controlGeneration,
          phase: { not: "closed" },
        }, data: { phase: "preparing", recoveryDetail: `Workflow ${workflow.id} queued on the existing session` } });
        if (!available.count) throw new Error("Task control changed during workflow preparation");
      }
      const changed = await tx.runtimeSession.updateMany({ where: {
        id: session.id, workflowId: session.workflowId, status: "idle",
      }, data: { workflowId: workflow.id, name: buildWorkflowSessionName(workflow.id, issueIdentifier) } });
      if (!changed.count) throw new Error("Session changed during workflow preparation");
      await tx.runtimeInstruction.update({ where: { id: instructionId }, data: { state: "queued", detail: null } });
    });
    void (input.wakeDelivery?.() ?? deliverInstructions(prisma, runtime)).catch(() => undefined);
    return result("delivered", `runtime_session:${session.id} continued from ${session.workflowId} to ${workflow.id}; execution queued in its existing worktree`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (reserved) await prisma.runtimeInstruction.updateMany({
      where: { id: instructionId, state: "preparing" }, data: { state: "preparation-failed", detail },
    });
    return result("failed", `Workflow continuation failed: ${detail}`);
  } finally {
    continuing.delete(key);
  }
}
