import type { ServerConfig } from "../../../../config.ts";
import { linearGraphql } from "../../client.ts";

const UPDATE_SOURCE_ISSUE = `
  mutation UpdateSourceIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
    }
  }
`;

export async function updateSourceIssue(
  config: ServerConfig,
  query: { id: string },
  input: { description?: string; stateId?: string },
): Promise<void> {
  const data = await linearGraphql<{
    issueUpdate: { success: boolean };
  }>(config.linearApiKey, UPDATE_SOURCE_ISSUE, { id: query.id, input });
  if (!data.issueUpdate.success) {
    throw new Error("Linear did not update the source issue");
  }
}
