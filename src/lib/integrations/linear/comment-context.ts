import { linearGraphql } from "./client.ts";

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
  cubeIssueIdentifier: string | null;
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
  apiKey: string,
  commentId: string,
): Promise<CommentContext> {
  const empty: CommentContext = {
    cubeIssueIdentifier: null,
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
      cubeIssueIdentifier:
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
