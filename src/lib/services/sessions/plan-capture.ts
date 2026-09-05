import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import type { PrismaClient } from "../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../config.ts";
import {
  getSourceIssueForPlanCapture,
  updateSourceIssue,
} from "../../integrations/linear/session-store/source-issue/index.ts";
import type { AgentPermissionInterceptor } from "../../../types/runtime/index.ts";

/** The plan lives in the source issue's description under this header,
    updated in place on re-plans. The header is the anchor — plan content is
    never stored in our database. */
export const PLAN_SECTION_HEADER = "## Implementation Plan";

/** claude-agent-acp surfaces ExitPlanMode as a permission request whose tool
    call has kind "switch_mode" and the finished plan markdown in
    rawInput.plan. Both must hold — kind alone also matches ordinary
    mode-switch confirmations. */
export function planFromPermissionRequest(
  raw: RequestPermissionRequest,
): string | null {
  if (raw.toolCall?.kind !== "switch_mode") return null;
  const rawInput = raw.toolCall.rawInput;
  if (!rawInput || typeof rawInput !== "object") return null;
  const plan = (rawInput as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.trim() ? plan.trim() : null;
}

/** Replaces the plan section in place, or appends it below the original
    description. The section runs from the header to the next h2 heading. */
export function splicePlanSection(
  description: string | null,
  plan: string,
): string {
  const section = `${PLAN_SECTION_HEADER}\n\n${plan.trim()}`;
  const existing = (description ?? "").replace(/\r\n/g, "\n");
  const headerPattern = /^## Implementation Plan[ \t]*$/m;
  const match = headerPattern.exec(existing);
  if (!match) {
    const base = existing.trimEnd();
    return base ? `${base}\n\n${section}\n` : `${section}\n`;
  }
  const start = match.index;
  const nextHeading = /^## /m.exec(existing.slice(start + match[0].length));
  const end = nextHeading
    ? start + match[0].length + nextHeading.index
    : existing.length;
  const before = existing.slice(0, start).trimEnd();
  const after = existing.slice(end).trimStart();
  return [before, section, after].filter(Boolean).join("\n\n") + "\n";
}

export interface PlanCaptureDependencies {
  getIssue?: typeof getSourceIssueForPlanCapture;
  updateIssue?: typeof updateSourceIssue;
}

/** Permission interceptor that persists a session's plan to Linear when the
    session was started by a workflow with plan capture enabled. Always
    returns undefined: the runtime's approve-all policy still answers the
    request, so a Linear outage never strands the agent — the plan survives
    in the transcript and the failure is logged. */
export function createPlanCaptureInterceptor(
  context: { prisma: PrismaClient; config: ServerConfig },
  dependencies: PlanCaptureDependencies = {},
): AgentPermissionInterceptor {
  const getIssue = dependencies.getIssue ?? getSourceIssueForPlanCapture;
  const updateIssue = dependencies.updateIssue ?? updateSourceIssue;
  return async ({ sessionId, raw }) => {
    try {
      const plan = planFromPermissionRequest(raw);
      if (!plan) return undefined;
      const session = await context.prisma.runtimeSession.findUnique({
        where: { id: sessionId },
        select: { workflowId: true, repositoryId: true },
      });
      if (!session?.workflowId) return undefined;
      const workflow = context.config.repositories[session.repositoryId]
        ?.workflows[session.workflowId];
      if (!workflow?.plan?.captureToIssue) return undefined;
      const link = await context.prisma.runtimeSessionResourceLink.findFirst({
        where: {
          runtimeSessionId: sessionId,
          provider: "linear",
          resourceType: "issue-identifier",
          relationship: "handles",
          endedAt: null,
        },
      });
      if (!link) {
        console.error(
          `plan capture: session ${sessionId} has no linked source issue`,
        );
        return undefined;
      }
      const issue = await getIssue(context.config, { id: link.externalId });
      if (!issue) {
        console.error(`plan capture: source issue ${link.externalId} not found`);
        return undefined;
      }
      await updateIssue(
        context.config,
        { id: issue.id },
        { description: splicePlanSection(issue.description, plan) },
      );
      // The state transition happens only after the plan write succeeded:
      // "verified persistence" as ordering, not as an agent-side rule.
      if (workflow.plan.thenState) {
        const state = issue.team.states.nodes.find(
          (entry) => entry.name === workflow.plan!.thenState,
        );
        if (state) {
          await updateIssue(context.config, { id: issue.id }, { stateId: state.id });
        } else {
          console.error(
            `plan capture: state '${workflow.plan.thenState}' not found on the issue's team`,
          );
        }
      }
      return undefined;
    } catch (error) {
      console.error(
        `plan capture failed for session ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  };
}
