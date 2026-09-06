export interface CreateAgentIssueRelationInput {
  agentIssueId: string;
  sourceIssueId: string;
  type: "related";
}

export interface AgentIssueRelation {
  id: string;
  type: string;
  sourceIssue: { identifier: string };
}
