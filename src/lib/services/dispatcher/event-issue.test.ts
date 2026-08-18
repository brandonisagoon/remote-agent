import { describe, expect, test } from "bun:test";

import {
  DispatchEventType,
  type DispatchEvent,
} from "../../../types/dispatcher/index.ts";
import { eventIssueId } from "./event-issue.ts";

describe("event issue id", () => {
  test("extracts the issue UUID from issue and reaction events", () => {
    const issueEvent = {
      type: DispatchEventType.LinearIssueOrchestrationRequested,
      webhook: { data: { id: "issue-uuid" } },
    } as DispatchEvent;
    const reactionEvent = {
      type: DispatchEventType.LinearIssueDescribeRequested,
      webhook: { data: { issueId: "reaction-issue-uuid" } },
    } as DispatchEvent;

    expect(eventIssueId(issueEvent)).toBe("issue-uuid");
    expect(eventIssueId(reactionEvent)).toBe("reaction-issue-uuid");
  });

  test("falls back to the reaction issue object", () => {
    const event = {
      type: DispatchEventType.LinearIssueDescribeRequested,
      webhook: { data: { issue: { id: "nested-issue-uuid" } } },
    } as DispatchEvent;

    expect(eventIssueId(event)).toBe("nested-issue-uuid");
  });
});
