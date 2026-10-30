import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import { linearGraphql } from "./client.ts";

/** Canonical source for comment controls and document-anchored comments. */
export async function readDeliveryComment(credential: LinearCredential, id: string) {
  type Issue = { id: string; identifier: string; title?: string };
  const data = await linearGraphql<{ comment: { id: string; body: string; parentId: string | null;
    createdAt?: string; updatedAt?: string; editedAt?: string | null; user: { id: string } | null; issue: Issue | null; documentContent: { issue: Issue | null } | null } | null }>(credential,
    "query DeliveryComment($id: String!) { comment(id: $id) { id body parentId createdAt updatedAt editedAt user { id } issue { id identifier title } documentContent { issue { id identifier title } } } }", { id });
  return data.comment ? { ...data.comment, issue: data.comment.issue ?? data.comment.documentContent?.issue ?? null } : null;
}

const COMMENT_CONTEXT = `
  query CommentContext($id: String!) {
    comment(id: $id) {
      quotedText
      issue { identifier }
      parent { body user { name } }
      documentContent { issue { identifier } }
    }
  }
`;

export interface CommentContext {
  sourceIssueIdentifier: string | null;
  /** The description text this comment is anchored to, if any. */
  quotedText: string | null;
  /** The comment being replied to, if this is a threaded reply. */
  parentBody: string | null;
  parentAuthor: string | null;
}

/**
 * Resolve which issue a comment belongs to.
 *
 * Needed because a comment on an issue's **description** is a documentContent
 * comment, and Linear's webhook sends it with `data.issue` absent. Plans live in
 * the description, so commenting on the plan text produces exactly this shape —
 * and without resolving it the mention was recorded and then silently dropped,
 * leaving the row at "pending" forever with no reaction and no error.
 *
 * The issue is still reachable one level down, via documentContent.
 */
export async function fetchCommentContext(
  apiKey: LinearCredential,
  commentId: string,
): Promise<CommentContext> {
  const empty: CommentContext = {
    sourceIssueIdentifier: null,
    quotedText: null,
    parentBody: null,
    parentAuthor: null,
  };

  try {
    const data = await linearGraphql<{
      comment: {
        quotedText: string | null;
        issue: { identifier: string } | null;
        parent: { body: string; user: { name: string } | null } | null;
        documentContent: { issue: { identifier: string } | null } | null;
      } | null;
    }>(apiKey, COMMENT_CONTEXT, { id: commentId });

    const comment = data.comment;
    if (!comment) return empty;

    return {
      sourceIssueIdentifier:
        comment.issue?.identifier ?? comment.documentContent?.issue?.identifier ?? null,
      quotedText: comment.quotedText?.trim() || null,
      parentBody: comment.parent?.body?.trim() || null,
      parentAuthor: comment.parent?.user?.name ?? null,
    };
  } catch (error) {
    console.error(`Failed to read context for comment ${commentId}:`, error);
    return empty;
  }
}
