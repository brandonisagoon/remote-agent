import type { ServerConfig } from "../../../../../config.ts";
import { linearGraphql } from "../../../../../integrations/linear/index.ts";
import { AgentIssueNotFoundError } from "../agent-issue/index.ts";
import type { AgentIssueRelation } from "./types.ts";

const GET_AGENT_ISSUE_RELATIONS = `
  query AgentIssueRelations($id: String!) {
    issue(id: $id) {
      relations {
        nodes {
          id
          type
          cubeIssue: relatedIssue { identifier }
        }
      }
    }
  }
`;

export async function getAgentIssueRelations(
  config: ServerConfig,
  query: { agentIssueId: string },
): Promise<AgentIssueRelation[]> {
  const data = await linearGraphql<{
    issue: { relations: { nodes: AgentIssueRelation[] } } | null;
  }>(config.linearApiKey, GET_AGENT_ISSUE_RELATIONS, {
    id: query.agentIssueId,
  });
  if (!data.issue) throw new AgentIssueNotFoundError(query.agentIssueId);
  return data.issue.relations.nodes;
}
