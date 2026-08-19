import type { ServerConfig } from "../../../config.ts";
import { getMachine } from "../../../machines/index.ts";
import {
  agentIssueRuntimeWithLabels,
  getSourceIssueWithAgentIssues,
  parseAgentIssueRuntime,
  parseAgentIssueSourceIdentifier,
} from "../../../integrations/tracker/index.ts";
import type {
  TrackerRoutingContext,
  RouteCandidate,
} from "../../../../types/sessions/index.ts";
import {
  AgentIssueLabel,
  AgentIssueState,
} from "../../../../types/sessions/index.ts";

export async function fetchRouteCandidates(
  config: ServerConfig,
  sourceIssueIdentifier: string,
): Promise<RouteCandidate[]> {
  return (
    (await fetchTrackerRoutingContext(config, sourceIssueIdentifier))
      ?.candidates ?? []
  );
}

export async function fetchTrackerRoutingContext(
  config: ServerConfig,
  sourceIssueIdentifier: string,
): Promise<TrackerRoutingContext | null> {
  const sourceIssue = await getSourceIssueWithAgentIssues(config, {
    id: sourceIssueIdentifier,
  });
  if (!sourceIssue) return null;

  const agentIssues = [
    ...sourceIssue.relations.nodes.map((relation) => relation.agentIssue),
    ...sourceIssue.inverseRelations.nodes.map((relation) => relation.agentIssue),
  ];
  const unique = new Map(
    agentIssues.map((agentIssue) => [agentIssue.id, agentIssue]),
  );

  const candidates = [...unique.values()].flatMap((agentIssue) => {
    if (agentIssue.team.key !== config.agentTeamKey) return [];
    const parsed = parseAgentIssueRuntime(agentIssue.description);
    if (!parsed) return [];
    if (
      parseAgentIssueSourceIdentifier(agentIssue.description) !==
      sourceIssueIdentifier
    ) {
      return [];
    }
    return [
      {
        agentIssueId: agentIssue.id,
        agentIssueIdentifier: agentIssue.identifier,
        status: agentIssue.state.name,
        assigneeId: agentIssue.assignee?.id ?? null,
        labels: agentIssue.labels.nodes.map((label) => label.name),
        runtime: agentIssueRuntimeWithLabels(agentIssue, parsed),
      },
    ];
  });
  return {
    sourceIssue: {
      identifier: sourceIssue.identifier,
      title: sourceIssue.title,
      description: sourceIssue.description,
      status: sourceIssue.state.name,
      labels: sourceIssue.labels.nodes.map((label) => label.name),
    },
    candidates,
  };
}

export function isEligibleCandidate(
  config: ServerConfig,
  candidate: RouteCandidate,
): boolean {
  const labels = new Set(candidate.labels);
  const machine = getMachine({ id: candidate.runtime.machine });
  return (
    candidate.status === AgentIssueState.Connected &&
    candidate.assigneeId === config.agentUserId &&
    machine.acceptsTrackerInput &&
    candidate.runtime.role === "primary" &&
    labels.has(AgentIssueLabel.Routing.AcceptsInput) &&
    labels.has(machine.label) &&
    Boolean(candidate.runtime.bbThreadId)
  );
}
