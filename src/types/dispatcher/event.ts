import type {
  LinearCommentWebhook,
  LinearIssueWebhook,
  LinearReactionWebhook,
} from "../webhooks/linear/index.ts";

export const DispatchEventType = {
  LinearCommentMentioned: "linear.comment.mentioned",
  LinearIssueReflectionRequested:
    "linear.issue.reflection-requested",
  LinearIssueOrchestrationRequested:
    "linear.issue.orchestration-requested",
  LinearIssueDescribeRequested: "linear.issue.describe-requested",
  LinearIssueEndRequested: "linear.issue.end-requested",
} as const;

export type DispatchEventTypeValue =
  (typeof DispatchEventType)[keyof typeof DispatchEventType];

interface DispatchEventPayloadByType {
  [DispatchEventType.LinearCommentMentioned]: LinearCommentWebhook;
  [DispatchEventType.LinearIssueReflectionRequested]: LinearIssueWebhook;
  [DispatchEventType.LinearIssueOrchestrationRequested]: LinearIssueWebhook;
  [DispatchEventType.LinearIssueDescribeRequested]: LinearReactionWebhook;
  [DispatchEventType.LinearIssueEndRequested]: LinearIssueWebhook;
}

export type DispatchEvent = {
  [Type in DispatchEventTypeValue]: {
    type: Type;
    webhook: DispatchEventPayloadByType[Type];
  };
}[DispatchEventTypeValue];
