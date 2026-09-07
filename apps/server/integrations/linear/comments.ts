import { linearGraphql } from "./client.ts";

const CREATE_ISSUE_COMMENT = `
  mutation CreateIssueComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

const CREATE_THREADED_ISSUE_COMMENT = `
  mutation CreateThreadedIssueComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id }
    }
  }
`;

const UPDATE_ISSUE_COMMENT = `
  mutation UpdateIssueComment($commentId: String!, $body: String!) {
    commentUpdate(id: $commentId, input: { body: $body }) {
      success
    }
  }
`;

const ISSUE_COMMENT_BODY = `
  query IssueCommentBody($commentId: String!) {
    comment(id: $commentId) { body }
  }
`;

const ISSUE_COMMENTS = `
  query IssueComments($issueId: String!) {
    issue(id: $issueId) {
      comments(first: 250) {
        nodes { body }
      }
    }
  }
`;

/** Returns the created comment's ID (so callers can register its thread),
    or null on failure. */
export async function createIssueComment(
  apiKey: string,
  issueId: string,
  body: string,
): Promise<string | null> {
  try {
    const data = await linearGraphql<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(apiKey, CREATE_ISSUE_COMMENT, { issueId, body });
    return data.commentCreate.success ? (data.commentCreate.comment?.id ?? null) : null;
  } catch (error) {
    console.error(`Failed to create comment on issue ${issueId}:`, error);
    return null;
  }
}

export interface CreatedIssueComment {
  id: string;
}

export async function createThreadedIssueComment(
  apiKey: string,
  input: { issueId: string; body: string; parentId?: string },
): Promise<CreatedIssueComment | null> {
  try {
    const data = await linearGraphql<{
      commentCreate: {
        success: boolean;
        comment: CreatedIssueComment | null;
      };
    }>(apiKey, CREATE_THREADED_ISSUE_COMMENT, {
      input: {
        issueId: input.issueId,
        body: input.body,
        ...(input.parentId ? { parentId: input.parentId } : {}),
      },
    });
    return data.commentCreate.success ? data.commentCreate.comment : null;
  } catch (error) {
    console.error(`Failed to create comment on issue ${input.issueId}:`, error);
    return null;
  }
}

export async function updateIssueComment(
  apiKey: string,
  commentId: string,
  body: string,
): Promise<boolean> {
  try {
    const data = await linearGraphql<{
      commentUpdate: { success: boolean };
    }>(apiKey, UPDATE_ISSUE_COMMENT, { commentId, body });
    return data.commentUpdate.success;
  } catch (error) {
    console.error(`Failed to update comment ${commentId}:`, error);
    return false;
  }
}

export async function fetchIssueCommentBody(
  apiKey: string,
  commentId: string,
): Promise<string | null> {
  try {
    const data = await linearGraphql<{
      comment: { body: string } | null;
    }>(apiKey, ISSUE_COMMENT_BODY, { commentId });
    return data.comment?.body ?? null;
  } catch (error) {
    console.error(`Failed to fetch comment ${commentId}:`, error);
    return null;
  }
}

export async function issueHasCommentContaining(
  apiKey: string,
  issueId: string,
  marker: string,
): Promise<boolean> {
  try {
    const data = await linearGraphql<{
      issue: { comments: { nodes: Array<{ body: string }> } } | null;
    }>(apiKey, ISSUE_COMMENTS, { issueId });
    if (!data.issue) return true;
    return data.issue.comments.nodes.some((comment) =>
      comment.body.includes(marker),
    );
  } catch (error) {
    console.error(`Failed to inspect comments on issue ${issueId}:`, error);
    return true;
  }
}
