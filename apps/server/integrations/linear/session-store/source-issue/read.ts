import type { ServerConfig } from "../../../../../../lib/config.ts";
import { linearGraphql } from "../../client.ts";
import { AGENT_ISSUE_FIELDS } from "../agent-issue/graphql-fields.ts";
import type { SourceIssueWithAgentIssues } from "./types.ts";

const GET_SOURCE_ISSUE = `
  query SourceIssue($id: String!) {
    issue(id: $id) { id }
  }
`;

/** Resolve live parentage for a newly added child before its primary has read
 * the work graph. A webhook's identifier alone never grants task ownership. */
export async function getSourceIssueParent(config: ServerConfig, query: { id: string }) {
  const data = await linearGraphql<{ issue: { id: string; identifier: string; parent: { id: string; identifier: string } | null } | null }>(
    config.linearApiKey,
    `query SourceIssueParent($id: String!) { issue(id: $id) { id identifier parent { id identifier } } }`,
    query,
  );
  return data.issue;
}

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
      updatedAt
      id
      identifier
      branchName
      title
      description
      state { id name type }
      team { states { nodes { id name type } } }
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

const GET_SOURCE_ISSUE_FOR_PLAN_CAPTURE = `
  query SourceIssueForPlanCapture($id: String!) {
    issue(id: $id) {
      id
      description
      team { states { nodes { id name } } }
    }
  }
`;

export interface SourceIssueForPlanCapture {
  id: string;
  description: string | null;
  team: { states: { nodes: Array<{ id: string; name: string }> } };
}

export async function getSourceIssueForPlanCapture(
  config: ServerConfig,
  query: { id: string },
): Promise<SourceIssueForPlanCapture | null> {
  const data = await linearGraphql<{
    issue: SourceIssueForPlanCapture | null;
  }>(config.linearApiKey, GET_SOURCE_ISSUE_FOR_PLAN_CAPTURE, query);
  return data.issue;
}

export async function getSourceIssueForWorkflow(
  config: ServerConfig,
  query: { id: string },
): Promise<SourceIssueWithAgentIssues | null> {
  return getSourceIssueForUpdate(config, query);
}

export async function getSourceIssueForUpdate(
  config: ServerConfig,
  query: { id: string },
): Promise<SourceIssueForUpdate | null> {
  const data = await linearGraphql<{
    issue: Omit<SourceIssueForUpdate, "relations" | "inverseRelations"> | null;
  }>(config.linearApiKey, GET_SOURCE_ISSUE_FOR_WORKFLOW, query);
  return data.issue
    ? {
        ...data.issue,
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      }
    : null;
}

export type SourceIssueForUpdate = SourceIssueWithAgentIssues & {
  updatedAt?: string;
  state: { id: string; name: string; type: string };
  team: { states: { nodes: Array<{ id: string; name: string; type: string }> } };
};
