import type { ServerConfig } from "../../../../config.ts";
import { linearGraphql } from "../../index.ts";
import { getMachine } from "../../../../machines/index.ts";
import {
  AgentIssueSchema,
  type AgentIssue,
} from "../../../../../types/sessions/index.ts";
import { AgentIssueNotFoundError } from "./errors.ts";
import { parseAgentIssueRuntime } from "./metadata/index.ts";
import { AGENT_ISSUE_FIELDS } from "./graphql-fields.ts";
import type {
  QueryAgentIssueInput,
  QueryAgentIssuesInput,
} from "./types.ts";

const SEARCH_AGENT_ISSUES = `
  query SearchAgentIssues($query: String!) {
    searchIssues(term: $query, first: 50) {
      nodes { ${AGENT_ISSUE_FIELDS} }
    }
  }
`;

const GET_AGENT_ISSUE = `
  query AgentIssueById($id: String!) {
    issue(id: $id) { ${AGENT_ISSUE_FIELDS} }
  }
`;

const GET_MACHINE_AGENT_ISSUES = `
  query MachineAgentIssues($teamKey: String!, $machine: String!) {
    issues(
      first: 250
      filter: {
        team: { key: { eq: $teamKey } }
        labels: { name: { eq: $machine } }
      }
    ) {
      nodes { ${AGENT_ISSUE_FIELDS} }
    }
  }
`;

export async function getAgentIssue(
  config: ServerConfig,
  query: QueryAgentIssueInput,
): Promise<AgentIssue> {
  const data = await linearGraphql<{
    issue: unknown | null;
  }>(config.linearApiKey, GET_AGENT_ISSUE, { id: query.id });
  if (!data.issue) throw new AgentIssueNotFoundError(query.id);
  return AgentIssueSchema.parse(data.issue);
}

export async function getAgentIssues(
  config: ServerConfig,
  query: QueryAgentIssuesInput,
): Promise<AgentIssue[]> {
  if ("machine" in query) {
    const machine = getMachine({ id: query.machine });
    const data = await linearGraphql<{
      issues: { nodes: unknown[] };
    }>(config.linearApiKey, GET_MACHINE_AGENT_ISSUES, {
      teamKey: config.agentTeamKey,
      machine: machine.label,
    });
    return AgentIssueSchema.array().parse(data.issues.nodes);
  }

  const searchTerm = "searchTerm" in query
    ? query.searchTerm
    : query.harnessSessionId;
  const data = await linearGraphql<{
    searchIssues: { nodes: unknown[] };
  }>(config.linearApiKey, SEARCH_AGENT_ISSUES, {
    query: `"${searchTerm}"`,
  });
  const candidates = AgentIssueSchema.array()
    .parse(data.searchIssues.nodes)
    .filter((issue) => issue.team.key === config.agentTeamKey);

  if ("harnessSessionId" in query) {
    return candidates.filter(
      (issue) =>
        parseAgentIssueRuntime(issue.description)?.harnessSessionId ===
        query.harnessSessionId,
    );
  }
  return candidates;
}
