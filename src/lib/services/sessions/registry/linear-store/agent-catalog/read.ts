import type { ServerConfig } from "../../../../../config.ts";
import { linearGraphql } from "../../../../../integrations/linear/index.ts";
import {
  AgentCatalogSchema,
  type AgentIssueStateValue,
  type AgentCatalog,
} from "../../../../../../types/sessions/index.ts";

const AGENT_TEAM_CATALOG = `
  query AgentTeamCatalog($key: String!) {
    teams(filter: { key: { eq: $key } }, first: 1) {
      nodes {
        id
        states { nodes { id name type } }
        labels { nodes { id name parent { id name } } }
      }
    }
  }
`;

export async function getAgentCatalog(
  config: ServerConfig,
): Promise<AgentCatalog> {
  const data = await linearGraphql<{
    teams: {
      nodes: Array<{
        id: string;
        states: { nodes: unknown[] };
        labels: { nodes: unknown[] };
      }>;
    };
  }>(config.linearApiKey, AGENT_TEAM_CATALOG, {
    key: config.agentTeamKey,
  });
  const team = data.teams.nodes[0];
  if (!team) {
    throw new Error(`Linear team ${config.agentTeamKey} was not found`);
  }
  return AgentCatalogSchema.parse({
    teamId: team.id,
    states: team.states.nodes,
    labels: team.labels.nodes,
  });
}

export function getAgentStateId(
  catalog: AgentCatalog,
  query: { name: AgentIssueStateValue },
): string {
  const state = catalog.states.find((entry) => entry.name === query.name);
  if (!state) {
    throw new Error(`Agents workflow state ${query.name} was not found`);
  }
  return state.id;
}
