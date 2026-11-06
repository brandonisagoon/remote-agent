import type { WorkflowConfig } from "../../../../../lib/config.ts";
import { composeForPrompt } from "../../../../../lib/skills/compose.ts";
import type { WorkerContext, WorkerResult } from "../../../../../types/dispatcher/index.ts";
import { deliverInstructions } from "../../../services/sessions/inbox.ts";
import { taskForSession } from "../../../services/tasks/store.ts";
import { getActiveToolingRelease } from "../../../services/tasks/tooling-releases.ts";
import { verifyStoredToolingRelease } from "../../../services/tasks/tooling-release-verification.ts";
import { ToolingReleaseManifestSchema } from "../../../services/tasks/tooling.ts";
import { buildWorkflowSessionName } from "./launch.ts";

const continuing = new Set<string>();

/** A start workflow following a plan continues the existing conversation.
 * The inbox reservation holds later messages until provider/model setup and
 * the workflow change have committed together with the execution prompt. */
export async function continuePlanningSession(input: {
  context: WorkerContext;
  workflow: WorkflowConfig;
  issueIdentifier: string;
  /** Shared launch-prompt construction; continuation supplies its facts. */
  seed: (continuation: { previousWorkflowId: string | null; taskId?: string; branchName?: string }) => string;
  /** Durable launch-intent provenance, recorded before provider changes. */
  intent?: Record<string, unknown>;
  compose?: typeof composeForPrompt;
  verifyRelease?: typeof verifyStoredToolingRelease;
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
    // An owner pause or closure is a decision, not a failure: report it once.
    if (task && (task.ownerPaused || task.phase === "closed")) {
      return result("ignored", `Task ${task.id} is ${task.ownerPaused ? "owner-paused" : "closed"}; workflow ${workflow.id} was not started on runtime_session:${session.id}`);
    }
    if (task && task.primarySessionId !== session.id) {
      throw new Error("Task is not available for automated workflow continuation; preserve its current owner");
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
    // A prepared prompt was composed for one provider/model; a retry keeps
    // them rather than replaying it on a different provider after config drift.
    const recorded = previous ? await prisma.runtimeMetadataEvent.findFirst({ where: {
      runtimeSessionId: session.id, action: "workflow-continuation", key: instructionId }, orderBy: { sequence: "asc" } }) : null;
    const original = recorded?.value ? JSON.parse(recorded.value) as { provider?: "codex" | "claude"; model?: string | null; tooling?: { releaseId?: string; generation?: number; revision?: string } | null } : null;
    const provider = original?.provider ?? workflow.providerId ?? config.acp.providerId;
    const model = original ? original.model ?? null : workflow.model;
    // A new continuation is an independent preparation boundary. A retry
    // preserves its already-recorded prompt/provider and original task pin.
    const selection = task && !previous ? await getActiveToolingRelease({ prisma, config, repositoryId: task.repositoryId }) : null;
    if (selection) await (input.verifyRelease ?? verifyStoredToolingRelease)(prisma, selection.release);
    // A saved prompt retains its original release even after activation. It
    // still needs intact executable code before provider setup or delivery.
    // Do not substitute the active release when that provenance is missing.
    if (previous && original?.tooling != null) {
      const retained = original.tooling;
      if (!task || typeof retained.releaseId !== "string" || typeof retained.revision !== "string"
        || !Number.isSafeInteger(retained.generation) || retained.generation! < 1) throw new Error("Prepared workflow tooling provenance is invalid");
      const release = await prisma.toolingRelease.findUnique({ where: { id: retained.releaseId } });
      if (!release || release.repositoryId !== task.repositoryId || release.revision !== retained.revision)
        throw new Error("Prepared workflow tooling release is unavailable or changed");
      await (input.verifyRelease ?? verifyStoredToolingRelease)(prisma, { ...release, manifest: ToolingReleaseManifestSchema.parse(release.manifest) });
    }
    const prompt = previous?.text ?? await (input.compose ?? composeForPrompt)(
      session.cwd,
      input.seed({ previousWorkflowId: session.workflowId, ...(task ? { taskId: task.id, branchName: task.branchName } : {}) }),
      provider, config.repository.skillsRoot, selection?.release.checkout ?? task?.pinnedToolingRoot ?? session.cwd,
    );
    // Recheck after composition, which may take time. The reservation blocks
    // inbox delivery during the following asynchronous provider operations.
    await assertIdle();
    await prisma.$transaction(async (tx) => {
      await tx.runtimeInstruction.upsert({ where: { id: instructionId },
        create: { id: instructionId, sessionId: session.id, text: prompt, state: "preparing" },
        update: { state: "preparing", detail: null },
      });
      if (!recorded) await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, action: "workflow-continuation", key: instructionId,
        value: JSON.stringify({ provider, model, previousWorkflowId: session.workflowId, workflowId: workflow.id, intent: input.intent ?? null, tooling: selection ? { releaseId: selection.release.id, generation: selection.generation, revision: selection.release.revision } : null }), source: `worker:${context.runId}` } });
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
    if (model) {
      const option = ready.configOptions.find((entry) => entry.category === "model" || entry.id === "model");
      if (!option) throw new Error(`Provider ${provider} does not expose a model setting`);
      const updated = await runtime.setConfigOption(session.id, option.id, model);
      if (!updated.some((entry) => entry.id === option.id && entry.currentValue === model)) {
        throw new Error(`Provider did not accept workflow model ${model}`);
      }
    }
    if (provider === "claude") await runtime.setMode(session.id, "default");
    await prisma.$transaction(async (tx) => {
      if (task) {
        const available = await tx.remoteTask.updateMany({ where: {
          id: task.id, primarySessionId: session.id,
          ownerPaused: false, phase: { not: "closed" },
        }, data: { phase: "preparing", recoveryDetail: `Workflow ${workflow.id} queued on the existing session` } });
        if (!available.count) throw new Error("Task identity changed during workflow preparation");
      }
      const changed = await tx.runtimeSession.updateMany({ where: {
        id: session.id, workflowId: session.workflowId, status: "idle",
      }, data: { workflowId: workflow.id, name: buildWorkflowSessionName(workflow.id, issueIdentifier) } });
      if (!changed.count) throw new Error("Session changed during workflow preparation");
      await tx.runtimeInstruction.update({ where: { id: instructionId }, data: { state: "queued", detail: null } });
    });
    void (input.wakeDelivery?.() ?? deliverInstructions(prisma, runtime, config)).catch(() => undefined);
    return result("delivered", `runtime_session:${session.id} continued from ${session.workflowId} to ${workflow.id}; execution queued in its existing worktree`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (reserved) await prisma.runtimeInstruction.updateMany({
      where: { id: instructionId, state: "preparing" }, data: { state: "preparation-failed", detail },
    });
    const current = await taskForSession(prisma, session.id).catch(() => null);
    if (current && (current.ownerPaused || current.phase === "closed")) return result("ignored", `Task ${current.id} became ${current.ownerPaused ? "owner-paused" : "closed"} during preparation; workflow ${workflow.id} was not started: ${detail}`);
    return result("failed", `Workflow continuation failed: ${detail}`);
  } finally {
    continuing.delete(key);
  }
}
