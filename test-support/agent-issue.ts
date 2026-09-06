import type {
  AgentIssue,
  SessionRuntime,
} from "../types/sessions/index.ts";

export function agentIssueFixture(
  overrides: Partial<AgentIssue> = {},
): AgentIssue {
  return {
    id: "agent-id",
    identifier: "AGENT-89",
    title: "CUBE-2774 · Primary · Codex",
    description: null,
    team: { id: "agent-team-id", key: "AGENT" },
    assignee: null,
    state: { id: "connected-id", name: "Connected", type: "started" },
    labels: { nodes: [] },
    ...overrides,
  };
}

export function agentIssueRuntimeDescription(
  lifecycle: SessionRuntime["lifecycle"],
): string {
  const storedLifecycle = lifecycle ? `\`${lifecycle}\`` : "—";
  return `<!-- remote-agent-session:v1 -->
| Runtime field | Value |
| --- | --- |
| Harness session ID | \`session-id\` |
| Worktree | \`/tmp/worktree\` |
| Lifecycle | ${storedLifecycle} |
| Execution target | \`Test MacBook Air\` |
<!-- /remote-agent-session:v1 -->`;
}
