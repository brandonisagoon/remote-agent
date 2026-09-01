import type { SourceIssueWithAgentIssues } from "../../../integrations/linear/session-store/source-issue/types.ts";

export type OrchestrationDecision =
  | { kind: "launch"; branchName: string }
  | { kind: "ignored"; detail: string }
  | { kind: "failed"; detail: string };

export function decideOrchestration(input: {
  issue: SourceIssueWithAgentIssues;
  orchestrateOnState: string;
}): OrchestrationDecision {
  const { issue, orchestrateOnState } = input;
  if (issue.state.name !== orchestrateOnState) {
    return {
      kind: "ignored",
      detail: `issue state is ${issue.state.name}, not ${orchestrateOnState}`,
    };
  }

  const branchName = issue.branchName?.trim();
  if (!branchName) {
    return { kind: "failed", detail: "source issue has no branch name" };
  }
  if (!isSafeBranchName(branchName)) {
    return { kind: "failed", detail: `unsafe branch name: ${branchName}` };
  }

  return { kind: "launch", branchName };
}

export function isSafeBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) {
    return false;
  }
  if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith("."));
}
