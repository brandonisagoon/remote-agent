import type { ServerConfig } from "../lib/config.ts";
import { configureMachines } from "../lib/machines/index.ts";

export const TEST_HOSTS = [
  {
    id: "macbook-air",
    label: "Test MacBook Air",
    editorConnection: "ssh" as const,
    acceptsTrackerInput: true,
    default: true,
  },
  {
    id: "macbook-pro",
    label: "Test MacBook Pro",
    editorConnection: "local" as const,
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
    skillsRoot: "agent-skills",
    workflows: {
      plan: {
        id: "plan",
        connectionId: null,
        on: "issue.state-changed" as const,
        when: [{ "issue.state": ["Planning"] }],
        skill: { skillset: "orchestrate", flags: [] },
        deliver: "start-session" as const,
        providerId: "codex" as const,
        model: null,
      },
      review: {
        id: "review",
        connectionId: null,
        on: "issue.state-changed" as const,
        when: [{ "issue.state": ["Pull Request"] }],
        skill: { skillset: "reflect", flags: [] },
        deliver: "message-session" as const,
        providerId: null,
        model: null,
      },
      describe: {
        id: "describe",
        connectionId: null,
        on: "issue.reaction" as const,
        when: [{ "reaction.emoji": ["pencil2"] }],
        skill: { skillset: "describe", flags: [] },
        deliver: "start-session" as const,
        providerId: "claude" as const,
        model: "opus",
      },
    },
    labels: {},
    sessionDefaults: { labels: {} },
  };
  const connections = overrides.connections ?? {
    "linear-test": {
      id: "linear-test",
      provider: "linear" as const,
      name: "Linear Test",
      apiKey: "test-linear-key",
      agentUserId: "11111111-2222-3333-4444-555555555555",
      agentHandle: "cubic-agent",
      router: { providerId: "codex", model: null, timeoutMs: 30_000 },
      editors: [{ name: "Zed", scheme: "zed", connection: "local" as const, remoteHost: null }],
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
    linearApiKey: "test-linear-key",
    agentUserId: "11111111-2222-3333-4444-555555555555",
    agentHandle: "cubic-agent",
    agentTeamKey: "AGENT",
    hosts: TEST_HOSTS,
    machine: "macbook-air",
    editors: [{ name: "Zed", scheme: "zed", connection: "local" as const, remoteHost: null }],
    routerProviderId: "codex" as const,
    routerModel: null,
    routerTimeoutMs: 30_000,
    webhookMaxAgeMs: 60_000,
    deployScript: "/nonexistent/deploy.sh",
    deployBranch: "main",
    repository,
    endOnState: "End",
    ...overrides,
    acpxStateDir:
      overrides.acpxStateDir ?? "/nonexistent/remote-agent/acpx",
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
