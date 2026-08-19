import type { ServerConfig } from "../../../../config.ts";
import { linearGraphql } from "../../index.ts";
import {
  AgentIssueSchema,
  type AgentIssue,
} from "../../../../../types/sessions/index.ts";
import { AGENT_ISSUE_FIELDS } from "./graphql-fields.ts";
import type { CreateAgentIssueInput } from "./types.ts";

const CREATE_AGENT_ISSUE = `
  mutation CreateAgentIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { ${AGENT_ISSUE_FIELDS} }
    }
  }
`;

export async function createAgentIssue(
  config: ServerConfig,
  input: CreateAgentIssueInput,
): Promise<AgentIssue> {
  const data = await linearGraphql<{
    issueCreate: {
      success: boolean;
      issue: unknown | null;
    };
  }>(config.linearApiKey, CREATE_AGENT_ISSUE, { input });
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error("Linear did not create the Agents issue");
  }
  return AgentIssueSchema.parse(data.issueCreate.issue);
}
