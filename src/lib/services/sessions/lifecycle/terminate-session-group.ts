import type { ServerConfig } from "../../../config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import {
  AgentIssueState,
  isTerminalAgentIssueState,
  type AgentIssue,
  type SessionRuntime,
} from "../../../../types/sessions/index.ts";
import {
  agentIssueLabelIdsWithRouting,
  agentIssueRuntimeWithLabels,
  getAgentCatalog,
  getAgentIssues,
  getAgentStateId,
  parseAgentIssueRuntime,
  updateAgentIssue,
} from "../../../integrations/tracker/index.ts";
import { enqueueAgentIssueWrite } from "./agent-issue/mutations/index.ts";

interface SessionGroupMember {
  issue: AgentIssue;
  runtime: SessionRuntime | null;
}

export interface EndSessionGroupResult {
  ended: number;
  runtimeSessionIds: string[];
}

export async function endSessionGroup(
  config: ServerConfig,
  target: AgentIssue,
): Promise<EndSessionGroupResult> {
  const [catalog, candidates] = await Promise.all([
    getAgentCatalog(config),
    getAgentIssues(config, { machine: config.machine }),
  ]);
  const group = buildSessionGroup(target, candidates);
  const ordered = orderForTermination(group, target.id);
  const endedStateId = getAgentStateId(catalog, {
    name: AgentIssueState.Ended,
  });

  let ended = 0;
  for (const member of ordered) {
    if (isTerminalAgentIssueState(member.issue.state.name)) continue;
    await enqueueAgentIssueWrite(
      member.runtime?.harnessSessionId ?? member.issue.id,
      () =>
        updateAgentIssue(
          config,
          { id: member.issue.id },
          {
            stateId: endedStateId,
            labelIds: agentIssueLabelIdsWithRouting(
              catalog,
              member.issue,
              false,
            ),
          },
        ),
    );
    ended += 1;
  }

  return {
    ended,
    runtimeSessionIds: sessionsForTermination(ordered, target.id),
  };
}

export async function terminateRuntimeSessions(
  runtime: AgentSessionRuntime,
  runtimeSessionIds: string[],
): Promise<number> {
  let terminated = 0;
  for (const runtimeSessionId of runtimeSessionIds) {
    const session = await runtime.getSession(runtimeSessionId);
    if (!session || session.status === "closed") continue;
    if (session.status === "active") {
      await runtime.cancel(runtimeSessionId, "Session ended from Linear");
    }
    await runtime.close(runtimeSessionId, "Session ended from Linear");
    terminated += 1;
  }
  return terminated;
}

function buildSessionGroup(
  target: AgentIssue,
  candidates: AgentIssue[],
): SessionGroupMember[] {
  const group: SessionGroupMember[] = [member(target)];
  const remaining = candidates
    .filter(
      (issue) =>
        issue.id !== target.id &&
        !isTerminalAgentIssueState(issue.state.name),
    )
    .map(member)
    .filter(
      (entry): entry is SessionGroupMember & { runtime: SessionRuntime } =>
        entry.runtime !== null,
    );

  let added = true;
  while (added) {
    added = false;
    for (const candidate of remaining) {
      if (group.some((entry) => entry.issue.id === candidate.issue.id)) {
        continue;
      }
      if (group.some((entry) => belongsToSessionGroup(candidate, entry))) {
        group.push(candidate);
        added = true;
      }
    }
  }
  return group;
}

function member(issue: AgentIssue): SessionGroupMember {
  const parsed = parseAgentIssueRuntime(issue.description);
  return {
    issue,
    runtime: parsed ? agentIssueRuntimeWithLabels(issue, parsed) : null,
  };
}

function belongsToSessionGroup(
  candidate: SessionGroupMember & { runtime: SessionRuntime },
  existing: SessionGroupMember,
): boolean {
  const runtime = existing.runtime;
  if (!runtime) return false;

  return (
    candidate.runtime.harnessSessionId === runtime.harnessSessionId ||
    candidate.runtime.harnessSessionId.startsWith(
      `${runtime.harnessSessionId}:`,
    ) ||
    (candidate.runtime.runtimeSessionId !== null &&
      candidate.runtime.runtimeSessionId === runtime.runtimeSessionId) ||
    (candidate.runtime.role === "delegate" &&
      candidate.runtime.worktreePath === runtime.worktreePath)
  );
}

function orderForTermination(
  group: SessionGroupMember[],
  targetId: string,
): SessionGroupMember[] {
  return [...group].sort((left, right) => {
    if (left.issue.id === targetId) return 1;
    if (right.issue.id === targetId) return -1;
    if (
      left.runtime?.role === "delegate" &&
      right.runtime?.role !== "delegate"
    ) {
      return -1;
    }
    if (
      right.runtime?.role === "delegate" &&
      left.runtime?.role !== "delegate"
    ) {
      return 1;
    }
    return left.issue.identifier.localeCompare(right.issue.identifier);
  });
}

function sessionsForTermination(
  ordered: SessionGroupMember[],
  targetId: string,
): string[] {
  const targetSession = ordered.find((entry) => entry.issue.id === targetId)
    ?.runtime?.runtimeSessionId;
  const sessions = new Set(
    ordered
      .filter((entry) => entry.issue.id !== targetId)
      .map((entry) => entry.runtime?.runtimeSessionId)
      .filter((value): value is string => Boolean(value)),
  );
  if (targetSession) {
    sessions.delete(targetSession);
    sessions.add(targetSession);
  }
  return [...sessions];
}
