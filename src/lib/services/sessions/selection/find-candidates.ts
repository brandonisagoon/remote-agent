import type { ServerConfig } from "../../../config.ts";
import { getMachine } from "../../../machines/index.ts";
import {
  agentIssueRuntimeWithLabels,
  getCubeIssueWithAgentIssues,
  parseAgentIssueRuntime,
  parseAgentIssueSourceIdentifier,
} from "../registry/index.ts";
import type {
  LinearRoutingContext,
  RouteCandidate,
} from "../../../../types/sessions/index.ts";
import {
  AgentIssueLabel,
  AgentIssueState,
} from "../../../../types/sessions/index.ts";

export async function fetchRouteCandidates(
  config: ServerConfig,
  cubeIssueIdentifier: string,
): Promise<RouteCandidate[]> {
  return (
    (await fetchLinearRoutingContext(config, cubeIssueIdentifier))
      ?.candidates ?? []
  );
}

export async function fetchLinearRoutingContext(
  config: ServerConfig,
  cubeIssueIdentifier: string,
): Promise<LinearRoutingContext | null> {
  const cubeIssue = await getCubeIssueWithAgentIssues(config, {
    id: cubeIssueIdentifier,
  });
  if (!cubeIssue) return null;

  const agentIssues = [
    ...cubeIssue.relations.nodes.map((relation) => relation.agentIssue),
    ...cubeIssue.inverseRelations.nodes.map((relation) => relation.agentIssue),
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
      cubeIssueIdentifier
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
    cubeIssue: {
      identifier: cubeIssue.identifier,
      title: cubeIssue.title,
      description: cubeIssue.description,
      status: cubeIssue.state.name,
      labels: cubeIssue.labels.nodes.map((label) => label.name),
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
    machine.acceptsLinearInput &&
    candidate.runtime.role === "primary" &&
    labels.has(AgentIssueLabel.Routing.AcceptsInput) &&
    labels.has(machine.linearLabel) &&
    Boolean(candidate.runtime.bbThreadId)
  );
}
