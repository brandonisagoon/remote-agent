import type { ServerConfig } from "../../../../../config.ts";
import { linearGraphql } from "../../../../../integrations/linear/index.ts";
import type { CreateAgentIssueRelationInput } from "./types.ts";

const CREATE_AGENT_ISSUE_RELATION = `
  mutation RelateAgentIssue($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id }
    }
  }
`;

export async function createAgentIssueRelation(
  config: ServerConfig,
  input: CreateAgentIssueRelationInput,
): Promise<void> {
  const data = await linearGraphql<{
    issueRelationCreate: { success: boolean };
  }>(config.linearApiKey, CREATE_AGENT_ISSUE_RELATION, {
    input: {
      issueId: input.agentIssueId,
      relatedIssueId: input.cubeIssueId,
      type: input.type,
    },
  });
  if (!data.issueRelationCreate.success) {
    throw new Error("Linear did not create the Agents issue relation");
  }
}
