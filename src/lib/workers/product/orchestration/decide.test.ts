import { describe, expect, test } from "bun:test";

import type { SourceIssueWithAgentIssues } from "../../../integrations/linear/session-store/source-issue/types.ts";
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
    orchestrateOnState: "Planning",
  });
}

describe("decideOrchestration", () => {
  test("launches a Planning issue without consulting Linear session mirrors", () => {
    expect(decide()).toEqual({
      kind: "launch",
      branchName: "webhook-orchestration-cube-2774",
    });
  });

  test("ignores an issue that moved out of Planning", () => {
    expect(decide({ state: { name: "On Course" } }).kind).toBe("ignored");
  });

  test("fails closed for missing or unsafe branch names", () => {
    expect(decide({ branchName: null }).kind).toBe("failed");
    expect(isSafeBranchName("../../main")).toBe(false);
    expect(isSafeBranchName("valid/feature-cube-2774")).toBe(true);
  });
});
