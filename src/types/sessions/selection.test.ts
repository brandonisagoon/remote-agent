import { describe, expect, test } from "bun:test";

import { RouteDecisionSchema } from "./selection.ts";

describe("RouteDecisionSchema", () => {
  test("defaults the advisory reply fields for older decisions", () => {
    expect(RouteDecisionSchema.parse({
      targetAgentIssueIdentifier: "AGENT-9",
      reasonCode: "only_eligible_candidate",
      confidence: 1,
    })).toEqual({
      targetAgentIssueIdentifier: "AGENT-9",
      reasonCode: "only_eligible_candidate",
      confidence: 1,
      expectedActions: [],
      replyToCommentId: null,
    });
  });

  test("rejects actions outside the normalized vocabulary", () => {
    expect(() => RouteDecisionSchema.parse({
      targetAgentIssueIdentifier: "AGENT-9",
      reasonCode: "workflow_match",
      confidence: 0.8,
      expectedActions: ["delete_issue"],
      replyToCommentId: null,
    })).toThrow();
  });
});
