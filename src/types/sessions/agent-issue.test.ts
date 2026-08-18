import { describe, expect, test } from "bun:test";

import {
  AgentIssueLabel,
  AgentIssueLabelGroup,
  AgentIssueSchema,
  AgentIssueState,
  AgentIssueStateSchema,
  isReconcilableAgentIssueState,
  isTerminalAgentIssueState,
} from "./agent-issue.ts";

describe("Agent issue domain", () => {
  test("defines the complete managed state vocabulary", () => {
    for (const state of Object.values(AgentIssueState)) {
      expect(AgentIssueStateSchema.safeParse(state).success).toBeTrue();
    }
    expect(AgentIssueStateSchema.safeParse("Planning").success).toBeFalse();
  });

  test("owns the terminal and reconcilable state groupings", () => {
    const states = Object.values(AgentIssueState);

    expect(states.filter(isTerminalAgentIssueState)).toEqual([
      AgentIssueState.Ended,
      AgentIssueState.Duplicate,
      AgentIssueState.Deleted,
    ]);
    expect(states.filter(isReconcilableAgentIssueState)).toEqual([
      AgentIssueState.Registered,
      AgentIssueState.Connected,
      AgentIssueState.Disconnected,
      AgentIssueState.Error,
    ]);
  });

  test("validates the Linear-backed issue shape", () => {
    const result = AgentIssueSchema.safeParse({
      id: "issue-id",
      identifier: "AGENT-1",
      title: "Primary Codex session",
      description: null,
      team: { id: "team-id", key: "AGENT" },
      assignee: { id: "agent-user-id" },
      state: {
        id: "state-id",
        name: AgentIssueState.Connected,
        type: "started",
      },
      labels: {
        nodes: [
          {
            id: "label-id",
            name: AgentIssueLabel.Role.Primary,
            parent: {
              id: "group-id",
              name: AgentIssueLabelGroup.Role,
            },
          },
        ],
      },
    });

    expect(result.success).toBeTrue();
  });
});
