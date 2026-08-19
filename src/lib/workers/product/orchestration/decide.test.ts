import { describe, expect, test } from "bun:test";

import {
  agentIssueFixture,
  agentIssueRuntimeDescription,
} from "../../../../test-support/agent-issue.ts";
import type { AgentIssue } from "../../../../types/sessions/index.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/tracker/index.ts";
import {
  decideOrchestration,
  isSafeBranchName,
} from "./decide.ts";

function issue(
  overrides: Partial<SourceIssueWithAgentIssues> = {},
): SourceIssueWithAgentIssues {
  return {
    id: "issue-id",
    identifier: "CUBE-2774",
    branchName: "webhook-orchestration-cube-2774",
    title: "Webhook orchestration",
    description: null,
    state: { name: "Planning" },
    labels: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

function decide(issueOverride: Partial<SourceIssueWithAgentIssues> = {}) {
  return decideOrchestration({
    issue: issue(issueOverride),
    agentTeamKey: "AGENT",
    orchestrateOnState: "Planning",
  });
}

function relation(related: AgentIssue) {
  return { type: "related", agentIssue: related };
}

describe("decideOrchestration", () => {
  test("launches a Planning issue with no Agents relation", () => {
    expect(decide()).toEqual({
      kind: "launch",
      branchName: "webhook-orchestration-cube-2774",
    });
  });

  test("ignores an issue that moved out of Planning", () => {
    expect(
      decide({ state: { name: "On Course" } }).kind,
    ).toBe("ignored");
  });

  test.each(["Connected", "Ended", "Disconnected", "Error"] as const)(
    "launches when a one-shot Agents issue is %s",
    (stateName) => {
      const related = agentIssueFixture({
        description: agentIssueRuntimeDescription("one-shot"),
        state: { id: "state-id", name: stateName, type: "started" },
      });

      expect(
        decide({ relations: { nodes: [relation(related)] } }),
      ).toEqual({
        kind: "launch",
        branchName: "webhook-orchestration-cube-2774",
      });
    },
  );

  test("ignores a non-terminal coordinator session", () => {
    const related = agentIssueFixture({
      description: agentIssueRuntimeDescription(null),
    });

    expect(decide({ relations: { nodes: [relation(related)] } })).toEqual({
      kind: "ignored",
      detail:
        "related Agents issue AGENT-89 may hold a live session (state: Connected)",
    });
  });

  test("launches for an ended coordinator session", () => {
    const related = agentIssueFixture({
      description: agentIssueRuntimeDescription(null),
      state: { id: "ended-id", name: "Ended", type: "completed" },
    });

    expect(decide({ relations: { nodes: [relation(related)] } }).kind).toBe(
      "launch",
    );
  });

  test("checks blocking sessions in inverse relations", () => {
    const related = agentIssueFixture({
      description: agentIssueRuntimeDescription(null),
    });

    expect(
      decide({ inverseRelations: { nodes: [relation(related)] } }).kind,
    ).toBe("ignored");
  });

  test("fails closed for unknown states and unparsable descriptions", () => {
    const unknown = agentIssueFixture({
      state: {
        id: "unknown-id",
        name: "Unknown" as AgentIssue["state"]["name"],
        type: "started",
      },
    });
    expect(decide({ relations: { nodes: [relation(unknown)] } }).kind).toBe(
      "ignored",
    );
    expect(
      decide({
        relations: { nodes: [relation(agentIssueFixture())] },
      }).kind,
    ).toBe("ignored");
  });

  test("ignores relations from other teams", () => {
    const related = agentIssueFixture({
      team: { id: "other-team-id", key: "OTHER" },
    });

    expect(decide({ relations: { nodes: [relation(related)] } }).kind).toBe(
      "launch",
    );
  });

  test("deduplicates an Agents issue present in both relation directions", () => {
    const related = agentIssueFixture({
      description: agentIssueRuntimeDescription(null),
    });

    expect(
      decide({
        relations: { nodes: [relation(related)] },
        inverseRelations: { nodes: [relation(related)] },
      }),
    ).toEqual({
      kind: "ignored",
      detail:
        "related Agents issue AGENT-89 may hold a live session (state: Connected)",
    });
  });

  test("fails closed for missing or unsafe branch names", () => {
    expect(
      decide({ branchName: null }).kind,
    ).toBe("failed");
    expect(isSafeBranchName("../../main")).toBe(false);
    expect(isSafeBranchName("valid/feature-cube-2774")).toBe(true);
  });
});
