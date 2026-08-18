import {
  parseAgentIssueRuntime,
  type CubeIssueWithAgentIssues,
} from "../../../services/sessions/registry/index.ts";
import {
  AgentIssueStateSchema,
  isTerminalAgentIssueState,
  type AgentIssue,
} from "../../../../types/sessions/index.ts";

export type OrchestrationDecision =
  | { kind: "launch"; branchName: string }
  | { kind: "ignored"; detail: string }
  | { kind: "failed"; detail: string };

function checkAgentIssueBlock(agentIssue: AgentIssue): boolean {
  const state = AgentIssueStateSchema.safeParse(agentIssue.state.name);
  if (!state.success) return true;
  if (isTerminalAgentIssueState(state.data)) return false;
  return parseAgentIssueRuntime(agentIssue.description)?.lifecycle !== "one-shot";
}

function uniqueRelatedAgentIssues(
  issue: CubeIssueWithAgentIssues,
): AgentIssue[] {
  const relations = [
    ...issue.relations.nodes,
    ...issue.inverseRelations.nodes,
  ];
  return [
    ...new Map(
      relations.map(({ agentIssue }) => [agentIssue.id, agentIssue]),
    ).values(),
  ];
}

export function decideOrchestration(input: {
  issue: CubeIssueWithAgentIssues;
  agentTeamKey: string;
  orchestrateOnState: string;
}): OrchestrationDecision {
  const { issue, agentTeamKey, orchestrateOnState } = input;
  if (issue.state.name !== orchestrateOnState) {
    return {
      kind: "ignored",
      detail: `issue state is ${issue.state.name}, not ${orchestrateOnState}`,
    };
  }

  const blockingAgentIssue = uniqueRelatedAgentIssues(issue).find(
    (agentIssue) =>
      agentIssue.team.key === agentTeamKey &&
      checkAgentIssueBlock(agentIssue),
  );
  if (blockingAgentIssue) {
    return {
      kind: "ignored",
      detail: `related Agents issue ${blockingAgentIssue.identifier} may hold a live session (state: ${blockingAgentIssue.state.name})`,
    };
  }

  const branchName = issue.branchName?.trim();
  if (!branchName) {
    return { kind: "failed", detail: "cube issue has no branch name" };
  }
  if (!isSafeBranchName(branchName)) {
    return { kind: "failed", detail: `unsafe branch name: ${branchName}` };
  }

  return { kind: "launch", branchName };
}

export function isSafeBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) {
    return false;
  }
  if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith("."));
}
