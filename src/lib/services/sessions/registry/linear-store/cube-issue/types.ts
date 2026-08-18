import type { AgentIssue } from "../../../../../../types/sessions/index.ts";

export interface CubeIssueWithAgentIssues {
  id: string;
  identifier: string;
  branchName: string | null;
  title: string;
  description: string | null;
  state: { name: string };
  labels: {
    nodes: Array<{
      name: string;
      parent: { name: string } | null;
    }>;
  };
  relations: {
    nodes: Array<{
      type: string;
      agentIssue: AgentIssue;
    }>;
  };
  inverseRelations: {
    nodes: Array<{
      type: string;
      agentIssue: AgentIssue;
    }>;
  };
}
