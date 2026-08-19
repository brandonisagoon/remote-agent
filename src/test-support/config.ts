import type { ServerConfig } from "../lib/config.ts";
import { configureMachines } from "../lib/machines/index.ts";

export const TEST_HOSTS = [
  {
    id: "macbook-air",
    label: "Test MacBook Air",
    bbHostId: "host_air",
    zedConnection: "ssh" as const,
    acceptsTrackerInput: true,
    default: true,
  },
  {
    id: "macbook-pro",
    label: "Test MacBook Pro",
    bbHostId: "host_pro",
    zedConnection: "local" as const,
    acceptsTrackerInput: false,
    default: false,
  },
];

/**
 * Baseline config for tests.
 *
 * Centralized so adding a field to ServerConfig doesn't break every test file
 * at once — which it did when deployScript/deployBranch were introduced.
 * Override only what a test actually cares about.
 */
export function testConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  configureMachines(overrides.hosts ?? TEST_HOSTS);
  return {
    serviceName: "remote-agent-test",
    configFile: "/nonexistent/remote-agent.config.json",
    installRoot: "/nonexistent/remote-agent",
    hostname: "127.0.0.1",
    port: 9000,
    publicUrl: "https://agents.example.com",
    databaseUrl: "file::memory:",
    webhookSecret: "test-webhook-secret",
    apiKey: "test-api-key",
    githubWebhookSecret: "test-github-secret",
    linearApiKey: "test-linear-key",
    agentUserId: "11111111-2222-3333-4444-555555555555",
    agentHandle: "cubic-agent",
    agentTeamKey: "AGENT",
    bbBaseUrl: "http://127.0.0.1:38886",
    bbProjectId: "proj_test",
    hosts: TEST_HOSTS,
    machine: "macbook-air",
    zedRemoteHost: "test-remote",
    codexExecutable: "codex",
    routerModel: null,
    routerTimeoutMs: 30_000,
    bbReconcileIntervalMs: 60_000,
    webhookMaxAgeMs: 60_000,
    deployScript: "/nonexistent/deploy.sh",
    deployBranch: "main",
    deployJobLabel: "dev.remote-agent-test.deploy",
    reflectOnState: "Pull Request",
    orchestrateOnState: "Planning",
    describeReactionEmoji: "pencil2",
    repository: {
      root: "/nonexistent/repository",
      worktreeRoot: "/nonexistent/.worktrees",
      bootstrapCommand: ["bash", "scripts/bootstrap.sh"],
      workflows: {
        describe: {
          prompt: "prompts/describe-issue.md",
          harness: "claude",
          model: "opus",
        },
        orchestrate: {
          prompt: "prompts/orchestrate-plan.md",
          harness: "codex",
          model: null,
        },
        reflect: { prompt: "prompts/reflect.md" },
      },
    },
    endOnState: "End",
    ...overrides,
  };
}
