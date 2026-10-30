import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import { linearGraphql, LinearGraphqlResponseError } from "./client.ts";
import { z } from "zod";

/** Owner acceptance needs author, issue, organization and edit identity;
 * a generic comment body or session-written resource receipt cannot supply it. */
export async function fetchQualifiedIssueComment(apiKey: LinearCredential, commentId: string) {
  const result = await linearGraphql<unknown>(apiKey,
    "query AcceptedComment($commentId: String!) { organization { id } comment(id: $commentId) { id body createdAt updatedAt user { id } issue { id identifier } } }", { commentId });
  return z.object({ organization: z.object({ id: z.string().min(1) }), comment: z.object({ id: z.string(), body: z.string(),
    createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), user: z.object({ id: z.string() }), issue: z.object({ id: z.string(), identifier: z.string() }) }) }).parse(result);
}

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
  apiKey: LinearCredential,
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
  apiKey: LinearCredential,
  input: { issueId: string; body: string; parentId?: string; id?: string },
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
        ...(input.id ? { id: input.id } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
      },
    });
    return data.commentCreate.success ? data.commentCreate.comment : null;
  } catch (error) {
    console.error(`Failed to create comment on issue ${input.issueId}:`, error);
    return null;
  }
}

// The exact HTTP-success GraphQL lookup failure observed for an uncreated
// reserved UUID. A message alone, partial data or another error is not absence.
const MissingComment = z.object({ data: z.null(), errors: z.tuple([z.object({
  message: z.literal("Entity not found: Comment"), path: z.tuple([z.literal("comment")]),
  locations: z.array(z.object({ line: z.number().int().positive(), column: z.number().int().positive() }).strict()).optional(),
  extensions: z.object({ type: z.literal("invalid input"), code: z.literal("INPUT_ERROR"), statusCode: z.literal(400), userError: z.literal(true), userPresentableMessage: z.literal("Could not find referenced Comment.") }).strict(),
}).strict()]) }).strict();
const CommentIdentity = z.object({ id: z.string().min(1), body: z.string(), parentId: z.string().min(1).nullable().optional(),
  issue: z.object({ id: z.string().min(1) }).nullable(), documentContent: z.object({ issue: z.object({ id: z.string().min(1) }).nullable() }).nullable().optional() });

/** Reconcile a client-assigned comment ID before create or after an uncertain
 * response. Only this read treats the exact missing-Comment error as null. */
export async function fetchIssueCommentIdentity(apiKey: LinearCredential, commentId: string): Promise<{ id: string; body: string; parentId?: string | null; issue: { id: string } | null } | null> {
  let raw: unknown;
  try {
    raw = await linearGraphql<unknown>(apiKey,
      "query QuestionComment($commentId: String!) { comment(id: $commentId) { id body parentId issue { id } documentContent { issue { id } } } }", { commentId });
  } catch (error) {
    if (error instanceof LinearGraphqlResponseError && MissingComment.safeParse(error.response).success) return null;
    throw error;
  }
  const data = z.object({ comment: CommentIdentity.nullable() }).parse(raw);
  if (data.comment && data.comment.id !== commentId) throw new Error("Linear returned a different comment identity");
  // Description-anchored threads are attached through documentContent. Use
  // the same issue identity for ingress, context and outbox reconciliation.
  return data.comment ? { ...data.comment, issue: data.comment.issue ?? data.comment.documentContent?.issue ?? null } : null;
}

export async function updateIssueComment(
  apiKey: LinearCredential,
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
  apiKey: LinearCredential,
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
  apiKey: LinearCredential,
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
