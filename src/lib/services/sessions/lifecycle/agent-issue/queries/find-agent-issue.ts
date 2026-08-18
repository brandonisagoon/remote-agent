import type { ServerConfig } from "../../../../../config.ts";
import type { AgentIssue } from "../../../../../../types/sessions/index.ts";
import {
  AgentIssueNotFoundError,
  getAgentIssue,
} from "../../../registry/index.ts";

export async function findAgentIssue(
  config: ServerConfig,
  query: { id: string },
): Promise<AgentIssue | null> {
  try {
    return await getAgentIssue(config, query);
  } catch (error) {
    if (error instanceof AgentIssueNotFoundError) return null;
    throw error;
  }
}
