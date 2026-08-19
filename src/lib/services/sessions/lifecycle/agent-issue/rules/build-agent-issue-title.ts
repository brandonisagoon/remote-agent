import {
  AgentIssueLabel,
  type SessionRuntime,
} from "../../../../../../types/sessions/index.ts";

export function buildAgentIssueTitle(
  runtime: SessionRuntime,
  sourceIssueIdentifier: string | null,
): string {
  const harness =
    runtime.harness === "claude"
      ? AgentIssueLabel.Harness.Claude
      : AgentIssueLabel.Harness.Codex;
  const role =
    runtime.role[0]!.toUpperCase() + runtime.role.slice(1);
  const suffix = runtime.harnessSessionId.slice(-8);
  return `${sourceIssueIdentifier ?? "Unrelated"} · ${role} · ${harness} · ${suffix}`;
}
