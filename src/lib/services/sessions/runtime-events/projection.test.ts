import { describe, expect, test } from "bun:test";

import type { AgentRuntimeLifecycleEvent } from "../../../../types/runtime/index.ts";
import { AgentIssueState } from "../../../../types/sessions/index.ts";
import { agentIssueStateForRuntimeEvent } from "./projection.ts";

function event(
  phase: AgentRuntimeLifecycleEvent["phase"],
): AgentRuntimeLifecycleEvent {
  return {
    kind: "turn",
    id: `request:${phase}`,
    sessionId: "runtime-1",
    requestId: "request",
    createdAt: 1,
    phase,
  };
}

describe("acpx runtime event projection", () => {
  test("maps active and completed turns to Connected", () => {
    expect(agentIssueStateForRuntimeEvent(event("started"), "persistent")).toBe(
      AgentIssueState.Connected,
    );
    expect(agentIssueStateForRuntimeEvent(event("completed"), "one-shot")).toBe(
      AgentIssueState.Connected,
    );
  });

  test("maps failures and lifecycle-aware cancellation", () => {
    expect(agentIssueStateForRuntimeEvent(event("failed"), "persistent")).toBe(
      AgentIssueState.Error,
    );
    expect(agentIssueStateForRuntimeEvent(event("cancelled"), "persistent")).toBe(
      AgentIssueState.Disconnected,
    );
    expect(agentIssueStateForRuntimeEvent(event("cancelled"), "one-shot")).toBe(
      AgentIssueState.Ended,
    );
  });
});
