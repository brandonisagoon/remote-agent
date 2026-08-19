import type {
  TrackerCommentWebhook,
  TrackerIssueWebhook,
  TrackerReactionWebhook,
} from "../../lib/integrations/tracker/index.ts";

export const DispatchEventType = {
  TrackerCommentMentioned: "tracker.comment.mentioned",
  TrackerIssueReflectionRequested:
    "tracker.issue.reflection-requested",
  TrackerIssueOrchestrationRequested:
    "tracker.issue.orchestration-requested",
  TrackerIssueDescribeRequested: "tracker.issue.describe-requested",
  TrackerIssueEndRequested: "tracker.issue.end-requested",
} as const;

export type DispatchEventTypeValue =
  (typeof DispatchEventType)[keyof typeof DispatchEventType];

interface DispatchEventPayloadByType {
  [DispatchEventType.TrackerCommentMentioned]: TrackerCommentWebhook;
  [DispatchEventType.TrackerIssueReflectionRequested]: TrackerIssueWebhook;
  [DispatchEventType.TrackerIssueOrchestrationRequested]: TrackerIssueWebhook;
  [DispatchEventType.TrackerIssueDescribeRequested]: TrackerReactionWebhook;
  [DispatchEventType.TrackerIssueEndRequested]: TrackerIssueWebhook;
}

export type DispatchEvent = {
  [Type in DispatchEventTypeValue]: {
    type: Type;
    webhook: DispatchEventPayloadByType[Type];
  };
}[DispatchEventTypeValue];
