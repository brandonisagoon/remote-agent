import type { ServerConfig } from "../lib/config.ts";
import { configureMachines } from "../lib/machines/index.ts";

export const TEST_HOSTS = [
  {
    id: "macbook-air",
    label: "Test MacBook Air",
    zedConnection: "ssh" as const,
    acceptsTrackerInput: true,
    default: true,
  },
  {
    id: "macbook-pro",
    label: "Test MacBook Pro",
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
  const repository = overrides.repository ?? {
    id: "test-repository",
    name: "Test Repository",
    root: "/nonexistent/repository",
    worktreeRoot: "/nonexistent/.worktrees",
    bootstrapCommand: ["bash", "scripts/bootstrap.sh"],
    workflows: {
      describe: {
        prompt: "prompts/describe-issue.md",
        harness: "claude" as const,
        model: "opus",
      },
      orchestrate: {
        prompt: "prompts/orchestrate-plan.md",
        harness: "codex" as const,
        model: null,
      },
      reflect: { prompt: "prompts/reflect.md" },
    },
    metadata: { tags: {} },
    sessionDefaults: { tags: {} },
    triggers: {
      reflectOnState: "Pull Request",
      orchestrateOnState: "Planning",
      describeOnReaction: "pencil2",
    },
  };
  const connections = overrides.connections ?? {
    "linear-test": {
      id: "linear-test",
      provider: "linear" as const,
      name: "Linear Test",
      apiKey: "test-linear-key",
      agentUserId: "11111111-2222-3333-4444-555555555555",
      agentHandle: "cubic-agent",
    },
  };
  const webhooks = overrides.webhooks ?? {
    "linear-test": {
      id: "linear-test",
      provider: "linear" as const,
      connectionId: "linear-test",
      webhookSecret: "test-webhook-secret",
      webhookMaxAgeMs: 60_000,
      repositoryRouting: { [repository.id]: {} },
    },
  };
  return {
    serviceName: "remote-agent-test",
    configFile: "/nonexistent/remote-agent.config.json",
    installRoot: "/nonexistent/remote-agent",
    hostname: "127.0.0.1",
    port: 9000,
    publicUrl: "https://agents.example.com",
    databaseUrl: "file::memory:",
    acpIpcPath: "/nonexistent/remote-agent/daemon.sock",
    controlIpcPath: "/nonexistent/remote-agent/control.sock",
    webhookSecret: "test-webhook-secret",
    apiKey: "test-api-key",
    githubWebhookSecret: "test-github-secret",
    linearApiKey: "test-linear-key",
    agentUserId: "11111111-2222-3333-4444-555555555555",
    agentHandle: "cubic-agent",
    agentTeamKey: "AGENT",
    hosts: TEST_HOSTS,
    machine: "macbook-air",
    zedRemoteHost: "test-remote",
    codexExecutable: "codex",
    routerModel: null,
    routerTimeoutMs: 30_000,
    webhookMaxAgeMs: 60_000,
    deployScript: "/nonexistent/deploy.sh",
    deployBranch: "main",
    deployJobLabel: "dev.remote-agent-test.deploy",
    reflectOnState: "Pull Request",
    orchestrateOnState: "Planning",
    describeReactionEmoji: "pencil2",
    repository,
    endOnState: "End",
    ...overrides,
    acpxStateDir:
      overrides.acpxStateDir ?? "/nonexistent/remote-agent/acpx",
    acpxPermissionMode: overrides.acpxPermissionMode ?? "approve-all",
    acpxNonInteractivePermissions:
      overrides.acpxNonInteractivePermissions ?? "deny",
    acpxAgentCommands: overrides.acpxAgentCommands ?? {},
    acp: overrides.acp ?? { providerId: "codex" },
    connections,
    webhooks,
    repositories: overrides.repositories ?? { [repository.id]: repository },
    activeConnectionId: overrides.activeConnectionId ?? "linear-test",
    activeWebhookId: overrides.activeWebhookId ?? "linear-test",
    activeRepositoryId: overrides.activeRepositoryId ?? repository.id,
  };
}
