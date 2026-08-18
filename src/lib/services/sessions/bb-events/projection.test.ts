import { describe, expect, test } from "bun:test";

import type { BbEvent } from "../../../../types/runtime/index.ts";
import {
  agentIssueStateForBbEvent,
  shouldProjectBbEvent,
} from "./projection.ts";

function event(type: string): BbEvent {
  return {
    id: "evt_1",
    threadId: "thr_1",
    seq: 1,
    createdAt: 1,
    type,
    scope: { kind: "thread" },
    data: {},
  };
}

describe("bb event projection", () => {
  test("maps active lifecycle events to Connected", () => {
    expect(agentIssueStateForBbEvent(event("thread/started"), "persistent"))
      .toBe("Connected");
    expect(agentIssueStateForBbEvent(event("turn/completed"), "persistent"))
      .toBe("Connected");
  });

  test("distinguishes one-shot and persistent termination", () => {
    expect(agentIssueStateForBbEvent(event("thread/stopped"), "one-shot"))
      .toBe("Ended");
    expect(agentIssueStateForBbEvent(event("thread/stopped"), "persistent"))
      .toBe("Disconnected");
  });

  test("maps provider failures and ignores unrelated deltas", () => {
    expect(agentIssueStateForBbEvent(event("turn/failed"), "persistent"))
      .toBe("Error");
    expect(
      agentIssueStateForBbEvent(
        { ...event("turn/completed"), data: { status: "failed" } },
        "persistent",
      ),
    ).toBe("Error");
    expect(
      agentIssueStateForBbEvent(event("item/agentMessage/delta"), "persistent"),
    ).toBeNull();
  });

  test("rejects high-volume deltas before they can read from Linear", () => {
    expect(shouldProjectBbEvent(event("item/reasoning/textDelta"))).toBe(false);
    expect(shouldProjectBbEvent(event("thread/tokenUsage/updated"))).toBe(false);
    expect(shouldProjectBbEvent(event("item/toolCall/progress"))).toBe(false);
    expect(shouldProjectBbEvent(event("turn/completed"))).toBe(true);
    expect(
      shouldProjectBbEvent({
        ...event("system/userQuestion/lifecycle"),
        data: { status: "pending" },
      }),
    ).toBe(true);
  });
});
