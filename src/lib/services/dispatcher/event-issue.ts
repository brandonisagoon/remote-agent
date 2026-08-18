import {
  DispatchEventType,
  type DispatchEvent,
} from "../../../types/dispatcher/index.ts";

export function eventIssueId(event: DispatchEvent): string | null {
  switch (event.type) {
    case DispatchEventType.LinearCommentMentioned:
      return event.webhook.data.issueId ?? event.webhook.data.issue?.id ?? null;
    case DispatchEventType.LinearIssueDescribeRequested:
      return event.webhook.data.issueId ?? event.webhook.data.issue?.id ?? null;
    case DispatchEventType.LinearIssueReflectionRequested:
    case DispatchEventType.LinearIssueOrchestrationRequested:
    case DispatchEventType.LinearIssueEndRequested:
      return event.webhook.data.id;
  }
}
