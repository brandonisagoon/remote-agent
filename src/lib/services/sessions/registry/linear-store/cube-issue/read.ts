import type { ServerConfig } from "../../../../../config.ts";
import { linearGraphql } from "../../../../../integrations/linear/index.ts";
import { AGENT_ISSUE_FIELDS } from "../agent-issue/index.ts";
import type { CubeIssueWithAgentIssues } from "./types.ts";

const GET_CUBE_ISSUE = `
  query CubeIssue($id: String!) {
    issue(id: $id) { id }
  }
`;

const GET_CUBE_ISSUE_WITH_AGENT_ISSUES = `
  query CubeIssueWithAgentIssues($id: String!) {
    issue(id: $id) {
      id
      identifier
      branchName
      title
      description
      state { name }
      labels { nodes { name parent { name } } }
      relations {
        nodes {
          id
          type
          agentIssue: relatedIssue { ${AGENT_ISSUE_FIELDS} }
        }
      }
      inverseRelations {
        nodes {
          id
          type
          agentIssue: issue { ${AGENT_ISSUE_FIELDS} }
        }
      }
    }
  }
`;

export async function getCubeIssue(
  config: ServerConfig,
  query: { id: string },
): Promise<{ id: string } | null> {
  const data = await linearGraphql<{
    issue: { id: string } | null;
  }>(config.linearApiKey, GET_CUBE_ISSUE, query);
  return data.issue;
}

export async function getCubeIssueWithAgentIssues(
  config: ServerConfig,
  query: { id: string },
): Promise<CubeIssueWithAgentIssues | null> {
  const data = await linearGraphql<{
    issue: CubeIssueWithAgentIssues | null;
  }>(config.linearApiKey, GET_CUBE_ISSUE_WITH_AGENT_ISSUES, query);
  return data.issue;
}
