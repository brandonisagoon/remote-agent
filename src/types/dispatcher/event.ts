import type {
  TrackerCommentWebhook,
  TrackerIssueWebhook,
  TrackerReactionWebhook,
} from "../../lib/integrations/tracker/index.ts";

export const DispatchEventType = {
  TrackerCommentMentioned: "tracker.comment.mentioned",
  /** A repository workflow's trigger matched an incoming event. */
  TrackerWorkflowTriggered: "tracker.workflow.triggered",
  TrackerIssueEndRequested: "tracker.issue.end-requested",
} as const;

export type DispatchEventTypeValue =
  (typeof DispatchEventType)[keyof typeof DispatchEventType];

export type DispatchEvent =
  | {
      type: typeof DispatchEventType.TrackerCommentMentioned;
      webhook: TrackerCommentWebhook;
      /** Set when the comment's thread is registered to a session: delivery
          bypasses the semantic router. */
      routedSessionId?: string;
      threadRelationship?: "thread" | "question";
    }
  | {
      type: typeof DispatchEventType.TrackerWorkflowTriggered;
      webhook: TrackerIssueWebhook | TrackerReactionWebhook;
      workflowId: string;
    }
  | {
      type: typeof DispatchEventType.TrackerIssueEndRequested;
      webhook: TrackerIssueWebhook;
    };
