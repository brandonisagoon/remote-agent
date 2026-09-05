import {
  DispatchEventType,
  type DispatchEvent,
} from "../../../types/dispatcher/index.ts";

export function eventIssueId(event: DispatchEvent): string | null {
  switch (event.type) {
    case DispatchEventType.TrackerCommentMentioned:
      return event.webhook.data.issueId ?? event.webhook.data.issue?.id ?? null;
    case DispatchEventType.TrackerWorkflowTriggered: {
      // Reaction payloads reference an issue; issue payloads are one.
      const data = event.webhook.data as {
        id?: string;
        issueId?: string | null;
        issue?: { id?: string } | null;
      };
      if (data.issueId || data.issue) return data.issueId ?? data.issue?.id ?? null;
      return data.id ?? null;
    }
    case DispatchEventType.TrackerIssueEndRequested:
      return event.webhook.data.id;
  }
}
