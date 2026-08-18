import type { ServerConfig } from "../../../../../config.ts";
import { linearGraphql } from "../../../../../integrations/linear/index.ts";
import {
  AgentIssueSchema,
  type AgentIssue,
} from "../../../../../../types/sessions/index.ts";
import { AGENT_ISSUE_FIELDS } from "./graphql-fields.ts";
import type {
  QueryAgentIssueInput,
  UpdateAgentIssueInput,
} from "./types.ts";

const UPDATE_AGENT_ISSUE = `
  mutation UpdateAgentIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { ${AGENT_ISSUE_FIELDS} }
    }
  }
`;

export async function updateAgentIssue(
  config: ServerConfig,
  query: QueryAgentIssueInput,
  input: UpdateAgentIssueInput,
): Promise<AgentIssue> {
  const data = await linearGraphql<{
    issueUpdate: {
      success: boolean;
      issue: unknown | null;
    };
  }>(config.linearApiKey, UPDATE_AGENT_ISSUE, {
    id: query.id,
    input,
  });
  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error("Linear did not update the Agents issue");
  }
  return AgentIssueSchema.parse(data.issueUpdate.issue);
}
