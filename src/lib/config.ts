import path from "node:path";
import { homedir } from "node:os";

import {
  DEFAULT_MACHINE_ID,
  MachineSchema,
  type Machine,
} from "./machines/index.ts";

// Read directly from env with explicit defaults, matching
// apps/api/src/lib/config.ts.
//
// Every required value is resolved at startup so a misconfigured environment is
// a loud boot failure. That is load-bearing for deploys: the service never
// comes up half-configured, so the health-check gate fails and rolls back.

/** Linear caps webhook payloads well below this; the limit stops an unbounded
 * body from being buffered before the signature is even checked. */
export const MAX_REQUEST_BYTES = 1_000_000;

export interface ServerConfig {
  hostname: string;
  port: number;
  /** Public origin used for signed links back into this service. */
  publicUrl: string;
  databaseUrl: string;
  webhookSecret: string;
  apiKey: string;
  githubWebhookSecret: string;
  linearApiKey: string;
  agentUserId: string;
  agentHandle: string | null;
  /** Linear team key used as the durable session registry. */
  agentTeamKey: string;
  /** bb server API used for durable session ownership. */
  bbBaseUrl: string;
  /** bb project containing Cubic agent threads. */
  bbProjectId: string;
  /** bb host IDs keyed by remote-agent machine identity. */
  bbHostIds: Partial<Record<Machine, string>>;
  /** Host identity used for sessions registered by this service. */
  machine: Machine;
  /** SSH host used by Zed deep links for remote sessions. */
  zedRemoteHost: string;
  /** Codex executable used for the one-off semantic router. */
  codexExecutable: string;
  /** Optional model override for the one-off router. */
  routerModel: string | null;
  routerTimeoutMs: number;
  bbReconcileIntervalMs: number;
  webhookMaxAgeMs: number;
  deployScript: string;
  deployBranch: string;
  /** launchd job that runs deploys, independent of this service. */
  deployJobLabel: string;
  /** Linear workflow state name that opens a reflection thread. */
  reflectOnState: string;
  /** Linear workflow state name that starts planning orchestration. */
  orchestrateOnState: string;
  /** Linear issue-reaction emoji that starts description augmentation. */
  describeReactionEmoji: string;
  /** Full monorepo checkout used to create issue worktrees. */
  workspaceRepoRoot: string;
  /** Agents workflow state name that requests session termination. */
  endOnState: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function readConfig(): ServerConfig {
  const home = homedir();

  return {
    hostname: optional("REMOTE_AGENT_HOST") ?? "127.0.0.1",
    port: integer("REMOTE_AGENT_PORT", 9000),
    publicUrl:
      optional("REMOTE_AGENT_PUBLIC_URL") ?? "https://agents.cubicsurveys.dev",
    databaseUrl:
      optional("REMOTE_AGENT_DATABASE_URL") ??
      `file:${path.join(home, "Desktop", "remote-agent", "state", "remote-agent.sqlite")}`,
    webhookSecret: required("LINEAR_WEBHOOK_SECRET"),
    apiKey: required("REMOTE_AGENT_API_KEY"),
    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    linearApiKey: required("LINEAR_API_KEY"),
    agentUserId: required("LINEAR_AGENT_USER_ID"),
    agentHandle: optional("LINEAR_AGENT_HANDLE"),
    agentTeamKey: optional("LINEAR_AGENT_TEAM_KEY") ?? "AGENT",
    bbBaseUrl: optional("REMOTE_AGENT_BB_URL") ?? "http://127.0.0.1:38886",
    bbProjectId: required("REMOTE_AGENT_BB_PROJECT_ID"),
    bbHostIds: {
      "macbook-air": required("REMOTE_AGENT_BB_HOST_MACBOOK_AIR"),
      ...(optional("REMOTE_AGENT_BB_HOST_MACBOOK_PRO")
        ? { "macbook-pro": optional("REMOTE_AGENT_BB_HOST_MACBOOK_PRO")! }
        : {}),
    },
    machine: machine("REMOTE_AGENT_MACHINE"),
    zedRemoteHost: optional("REMOTE_AGENT_ZED_HOST") ?? "cubic-remote",
    codexExecutable: optional("REMOTE_AGENT_CODEX_EXECUTABLE") ?? "codex",
    routerModel: optional("REMOTE_AGENT_ROUTER_MODEL"),
    routerTimeoutMs: integer("REMOTE_AGENT_ROUTER_TIMEOUT_MS", 30_000),
    bbReconcileIntervalMs: integer(
      "REMOTE_AGENT_BB_RECONCILE_INTERVAL_MS",
      60_000,
    ),
    webhookMaxAgeMs: integer("LINEAR_WEBHOOK_MAX_AGE_MS", 60_000),
    deployScript:
      optional("REMOTE_AGENT_DEPLOY_SCRIPT") ??
      path.join(home, "Desktop", "remote-agent", "app", "scripts", "deploy.sh"),
    deployBranch: optional("REMOTE_AGENT_DEPLOY_BRANCH") ?? "main",
    deployJobLabel:
      optional("REMOTE_AGENT_DEPLOY_JOB") ??
      "dev.cubicsurveys.remote-agent-poll",
    reflectOnState: optional("REMOTE_AGENT_REFLECT_ON_STATE") ?? "Pull Request",
    orchestrateOnState:
      optional("REMOTE_AGENT_ORCHESTRATE_ON_STATE") ?? "Planning",
    describeReactionEmoji:
      optional("REMOTE_AGENT_DESCRIBE_ON_REACTION") ?? "pencil2",
    workspaceRepoRoot:
      optional("REMOTE_AGENT_WORKSPACE_REPO") ??
      path.join(home, "Desktop", "cubic"),
    endOnState: optional("REMOTE_AGENT_END_ON_STATE") ?? "End",
  };
}

function machine(name: string): Machine {
  const value = optional(name) ?? DEFAULT_MACHINE_ID;
  const parsed = MachineSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name} must be ${MachineSchema.options.join(" or ")}`);
  }
  return parsed.data;
}
