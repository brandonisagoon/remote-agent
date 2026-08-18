import { describe, expect, test } from "bun:test";

import type {
  AgentIssue,
  RuntimeSessionEvent,
  SessionRuntime,
} from "../../../../../../types/sessions/index.ts";
import { resolveAgentIssueState } from "./index.ts";

describe("resolveAgentIssueState", () => {
  const runtime: SessionRuntime = {
    harnessSessionId: "session-1",
    parentSessionId: null,
    worktreePath: "/tmp/worktree",
    branchName: "example-cube-2600",
    harness: "claude",
    machine: "macbook-air",
    role: "primary",
    bbThreadId: null,
  };
  const event = (type: RuntimeSessionEvent["type"]): RuntimeSessionEvent =>
    ({
      type,
      eventId: `event-${type}`,
      occurredAt: "2026-07-31T12:00:00.000Z",
      generation: 1,
      runtime,
      ...(type === "workflow.started" || type === "workflow.ended"
        ? { workflow: "plan-linear" as const }
        : {}),
    }) as RuntimeSessionEvent;

  test("terminal events win over invalid runtime metadata", () => {
    expect(resolveAgentIssueState(event("session.ended"), false, null)).toBe(
      "Ended",
    );
    expect(resolveAgentIssueState(event("subagent.ended"), false, null)).toBe(
      "Ended",
    );
    expect(
      resolveAgentIssueState(event("session.disconnected"), false, null),
    ).toBe("Disconnected");
  });

  test("a resumed session revives an Ended record", () => {
    const existing = {
      state: { id: "ended", name: "Ended", type: "completed" },
    } as AgentIssue;
    expect(
      resolveAgentIssueState(event("session.started"), true, existing),
    ).toBe("Connected");
  });

  test.each(["Error", "Disconnected"] as const)(
    "a routable workflow event promotes %s to Connected",
    (state) => {
      const existing = {
        state: { id: state.toLowerCase(), name: state, type: "started" },
      } as AgentIssue;
      expect(
        resolveAgentIssueState(event("workflow.started"), true, existing),
      ).toBe("Connected");
    },
  );

  test("workflow events preserve states that must not be revived", () => {
    const ended = {
      state: { id: "ended", name: "Ended", type: "completed" },
    } as AgentIssue;
    const connected = {
      state: { id: "connected", name: "Connected", type: "started" },
    } as AgentIssue;
    const error = {
      state: { id: "error", name: "Error", type: "started" },
    } as AgentIssue;

    expect(resolveAgentIssueState(event("workflow.started"), true, ended)).toBe(
      "Ended",
    );
    expect(
      resolveAgentIssueState(event("workflow.ended"), true, connected),
    ).toBe("Connected");
    expect(
      resolveAgentIssueState(event("workflow.started"), false, error),
    ).toBe("Error");
  });
});
