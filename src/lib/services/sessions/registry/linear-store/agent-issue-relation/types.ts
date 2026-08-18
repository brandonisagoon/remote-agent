export interface CreateAgentIssueRelationInput {
  agentIssueId: string;
  cubeIssueId: string;
  type: "related";
}

export interface AgentIssueRelation {
  id: string;
  type: string;
  cubeIssue: { identifier: string };
}
