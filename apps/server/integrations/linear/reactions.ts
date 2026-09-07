import { linearGraphql } from "./client.ts";

/**
 * Acknowledge a routed comment with an emoji reaction.
 *
 * A reaction rather than a reply: it confirms the comment landed without
 * adding noise to the issue thread, and — critically — it cannot re-enter our
 * own webhook as a new comment, so there is no feedback loop to guard against.
 */
export const TrackerReaction = {
  Received: "mailbox_with_mail",
  Delivered: "eyes",
  Reply: "speech_balloon",
  PlanUpdate: "memo",
  CodeChange: "rocket",
  Describing: "pencil2",
  Unrouted: "warning",
  Failed: "x",
} as const;

const CREATE_REACTION = `
  mutation CreateReaction($commentId: String!, $emoji: String!) {
    reactionCreate(input: { commentId: $commentId, emoji: $emoji }) {
      success
    }
  }
`;

const CREATE_ISSUE_REACTION = `
  mutation CreateIssueReaction($issueId: String!, $emoji: String!) {
    reactionCreate(input: { issueId: $issueId, emoji: $emoji }) {
      success
    }
  }
`;

/**
 * Best-effort: a failed reaction must never fail the delivery it is reporting
 * on. The comment has already reached the agent by this point; losing the
 * acknowledgement is cosmetic, and throwing here would flip a successful
 * delivery into a recorded failure.
 */
export async function reactToComment(
  apiKey: string,
  commentId: string,
  emoji: string,
): Promise<boolean> {
  try {
    const data = await linearGraphql<{ reactionCreate: { success: boolean } }>(
      apiKey,
      CREATE_REACTION,
      { commentId, emoji },
    );
    return data.reactionCreate.success;
  } catch (error) {
    console.error(`Failed to react to comment ${commentId}:`, error);
    return false;
  }
}

/** Best-effort acknowledgement that work has started on an issue. */
export async function reactToIssue(
  apiKey: string,
  issueId: string,
  emoji: string,
): Promise<boolean> {
  try {
    const data = await linearGraphql<{ reactionCreate: { success: boolean } }>(
      apiKey,
      CREATE_ISSUE_REACTION,
      { issueId, emoji },
    );
    return data.reactionCreate.success;
  } catch (error) {
    console.error(`Failed to react to issue ${issueId}:`, error);
    return false;
  }
}
