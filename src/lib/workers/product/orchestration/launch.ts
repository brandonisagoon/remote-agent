import path from "node:path";


export const OPEN_ISSUE_SCRIPT = path.join(
  "scripts",
  "workspace",
  "linear",
  "open-issue.sh",
);
export const ORCHESTRATE_PLAN_LINEAR_ACTION = path.join(
  "scripts",
  "workspace",
  "linear",
  "actions",
  "orchestrate-plan-linear.txt",
);
export const ORCHESTRATE_PLAN_LINEAR_TUNNEL_ACTION = path.join(
  "scripts",
  "workspace",
  "linear",
  "actions",
  "orchestrate-plan-linear-tunnel.txt",
);

const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export function orchestrationPaths(workspaceRepoRoot: string) {
  return {
    openIssueScript: path.join(workspaceRepoRoot, OPEN_ISSUE_SCRIPT),
    promptFile: path.join(
      workspaceRepoRoot,
      ORCHESTRATE_PLAN_LINEAR_TUNNEL_ACTION,
    ),
  };
}

export function buildOrchestrationSessionName(issueIdentifier: string): string {
  if (!ISSUE_IDENTIFIER_PATTERN.test(issueIdentifier)) {
    throw new Error(`Invalid issue identifier: ${issueIdentifier}`);
  }
  return `linear-orchestrate-${issueIdentifier.toLowerCase()}`;
}
