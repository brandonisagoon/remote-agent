import path from "node:path";

import type { Harness } from "../../../../types/runtime/index.ts";

export const DESCRIBE_AGENT_HARNESS = "claude" satisfies Harness;
export const DESCRIBE_AGENT_MODEL = "opus";

export const DESCRIBE_ISSUE_SCRIPT = path.join(
  "scripts",
  "workspace",
  "linear",
  "describe-issue.sh",
);
export const DESCRIBE_LINEAR_ISSUE_ACTION = path.join(
  "scripts",
  "workspace",
  "linear",
  "actions",
  "describe-linear-issue.txt",
);

const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export function describePaths(workspaceRepoRoot: string) {
  return {
    describeIssueScript: path.join(workspaceRepoRoot, DESCRIBE_ISSUE_SCRIPT),
    promptFile: path.join(workspaceRepoRoot, DESCRIBE_LINEAR_ISSUE_ACTION),
  };
}

export function buildDescribeSessionName(issueIdentifier: string): string {
  if (!ISSUE_IDENTIFIER_PATTERN.test(issueIdentifier)) {
    throw new Error(`Invalid issue identifier: ${issueIdentifier}`);
  }
  return `linear-describe-${issueIdentifier.toLowerCase()}`;
}
