import { describe, expect, test } from "bun:test";

import type { MessageDispatchResult } from "../../../../types/messages/index.ts";
import { TrackerReaction } from "../../../integrations/tracker/index.ts";
import { selectOutcomeReactions } from "./reactions.ts";

function result(
  overrides: Partial<MessageDispatchResult> = {},
): MessageDispatchResult {
  return {
    status: "delivered",
    detail: null,
    targetAgentIssueIdentifier: "AGENT-9",
    decision: {
      targetAgentIssueIdentifier: "AGENT-9",
      reasonCode: "only_eligible_candidate",
      confidence: 1,
      expectedActions: [],
      replyToCommentId: null,
    },
    ...overrides,
  };
}

describe("selectOutcomeReactions", () => {
  test("uses only eyes for a delivered FYI", () => {
    expect(selectOutcomeReactions(result())).toEqual([TrackerReaction.Delivered]);
  });

  test("maps a delivered action set in stable order", () => {
    expect(selectOutcomeReactions(result({
      decision: {
        targetAgentIssueIdentifier: "AGENT-9",
        reasonCode: "workflow_match",
        confidence: 0.9,
        expectedActions: ["code_change", "reply", "plan_update", "reply"],
        replyToCommentId: "comment-1",
      },
    }))).toEqual([
      TrackerReaction.Delivered,
      TrackerReaction.Reply,
      TrackerReaction.PlanUpdate,
      TrackerReaction.CodeChange,
    ]);
  });

  test("uses warning for unrouted outcomes", () => {
    for (const status of ["no_candidate", "ambiguous", "ignored"] as const) {
      expect(selectOutcomeReactions(result({ status }))).toEqual([
        TrackerReaction.Unrouted,
      ]);
    }
  });

  test("uses failure for rejected and operational failures", () => {
    for (const status of [
      "failed",
      "router_timeout",
      "rejected",
      "stale_target",
    ] as const) {
      expect(selectOutcomeReactions(result({ status }))).toEqual([
        TrackerReaction.Failed,
      ]);
    }
  });
});
