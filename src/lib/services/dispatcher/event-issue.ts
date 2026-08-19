import {
  DispatchEventType,
  type DispatchEvent,
} from "../../../types/dispatcher/index.ts";

export function eventIssueId(event: DispatchEvent): string | null {
  switch (event.type) {
    case DispatchEventType.TrackerCommentMentioned:
      return event.webhook.data.issueId ?? event.webhook.data.issue?.id ?? null;
    case DispatchEventType.TrackerIssueDescribeRequested:
      return event.webhook.data.issueId ?? event.webhook.data.issue?.id ?? null;
    case DispatchEventType.TrackerIssueReflectionRequested:
    case DispatchEventType.TrackerIssueOrchestrationRequested:
    case DispatchEventType.TrackerIssueEndRequested:
      return event.webhook.data.id;
  }
}
