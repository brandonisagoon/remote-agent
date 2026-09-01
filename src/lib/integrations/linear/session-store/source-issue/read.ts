import type { ServerConfig } from "../../../../config.ts";
import { linearGraphql } from "../../client.ts";
import { AGENT_ISSUE_FIELDS } from "../agent-issue/graphql-fields.ts";
import type { SourceIssueWithAgentIssues } from "./types.ts";

const GET_SOURCE_ISSUE = `
  query SourceIssue($id: String!) {
    issue(id: $id) { id }
  }
`;

const GET_SOURCE_ISSUE_WITH_AGENT_ISSUES = `
  query SourceIssueWithAgentIssues($id: String!) {
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

const GET_SOURCE_ISSUE_FOR_ROUTING = `
  query SourceIssueForRouting($id: String!) {
    issue(id: $id) {
      identifier
      title
      description
      state { name }
      labels { nodes { name } }
    }
  }
`;

const GET_SOURCE_ISSUE_FOR_WORKFLOW = `
  query SourceIssueForWorkflow($id: String!) {
    issue(id: $id) {
      id
      identifier
      branchName
      title
      description
      state { name }
      labels { nodes { name parent { name } } }
    }
  }
`;

export async function getSourceIssue(
  config: ServerConfig,
  query: { id: string },
): Promise<{ id: string } | null> {
  const data = await linearGraphql<{
    issue: { id: string } | null;
  }>(config.linearApiKey, GET_SOURCE_ISSUE, query);
  return data.issue;
}

export async function getSourceIssueWithAgentIssues(
  config: ServerConfig,
  query: { id: string },
): Promise<SourceIssueWithAgentIssues | null> {
  const data = await linearGraphql<{
    issue: SourceIssueWithAgentIssues | null;
  }>(config.linearApiKey, GET_SOURCE_ISSUE_WITH_AGENT_ISSUES, query);
  return data.issue;
}

export async function getSourceIssueForRouting(
  config: ServerConfig,
  query: { id: string },
): Promise<{
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
} | null> {
  const data = await linearGraphql<{
    issue: {
      identifier: string;
      title: string;
      description: string | null;
      state: { name: string };
      labels: { nodes: Array<{ name: string }> };
    } | null;
  }>(config.linearApiKey, GET_SOURCE_ISSUE_FOR_ROUTING, query);
  return data.issue;
}

export async function getSourceIssueForWorkflow(
  config: ServerConfig,
  query: { id: string },
): Promise<SourceIssueWithAgentIssues | null> {
  const data = await linearGraphql<{
    issue: Omit<SourceIssueWithAgentIssues, "relations" | "inverseRelations"> | null;
  }>(config.linearApiKey, GET_SOURCE_ISSUE_FOR_WORKFLOW, query);
  return data.issue
    ? {
        ...data.issue,
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      }
    : null;
}
