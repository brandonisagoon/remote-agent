import type { ServerConfig } from "../../../../../config.ts";
import { linearGraphql } from "../../../../../integrations/linear/index.ts";

const DELETE_AGENT_ISSUE_RELATION = `
  mutation DeleteAgentIssueRelation($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`;

export async function deleteAgentIssueRelation(
  config: ServerConfig,
  query: { id: string },
): Promise<void> {
  const data = await linearGraphql<{
    issueRelationDelete: { success: boolean };
  }>(config.linearApiKey, DELETE_AGENT_ISSUE_RELATION, query);
  if (!data.issueRelationDelete.success) {
    throw new Error("Linear did not delete the Agents issue relation");
  }
}
