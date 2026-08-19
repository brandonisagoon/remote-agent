import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  configureMachines,
  getDefaultMachineId,
  getMachine,
  MachineRecordSchema,
  MachineSchema,
  type Machine,
  type MachineRecord,
} from "./machines/index.ts";
import type { Harness } from "../types/runtime/index.ts";

/** Linear caps webhook payloads well below this size. */
export const MAX_REQUEST_BYTES = 1_000_000;

const CommandSchema = z.array(z.string().min(1)).min(1);
const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !path.isAbsolute(value), "must be relative to the repository");
const WorkflowSchema = z.object({
  prompt: RepositoryRelativePathSchema,
  harness: z.enum(["claude", "codex"]),
  model: z.string().min(1).optional(),
});
const RepositorySchema = z.object({
  root: z.string().min(1),
  worktreeRoot: z.string().min(1),
  bootstrapCommand: CommandSchema,
  workflows: z.object({
    describe: WorkflowSchema,
    orchestrate: WorkflowSchema,
    reflect: z.object({ prompt: RepositoryRelativePathSchema }),
  }),
});
const ServiceFileSchema = z.object({
  serviceName: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  hosts: z.array(MachineRecordSchema).min(1),
  repository: RepositorySchema,
});

export interface WorkflowConfig {
  prompt: string;
  harness: Harness;
  model: string | null;
}

export interface RepositoryConfig {
  root: string;
  worktreeRoot: string;
  bootstrapCommand: string[];
  workflows: {
    describe: WorkflowConfig;
    orchestrate: WorkflowConfig;
    reflect: { prompt: string };
  };
}

export interface ServerConfig {
  serviceName: string;
  configFile: string;
  installRoot: string;
  hostname: string;
  port: number;
  publicUrl: string;
  databaseUrl: string;
  webhookSecret: string;
  apiKey: string;
  githubWebhookSecret: string;
  linearApiKey: string;
  agentUserId: string;
  agentHandle: string | null;
  agentTeamKey: string;
  bbBaseUrl: string;
  bbProjectId: string;
  hosts: readonly MachineRecord[];
  machine: Machine;
  zedRemoteHost: string | null;
  codexExecutable: string;
  routerModel: string | null;
  routerTimeoutMs: number;
  bbReconcileIntervalMs: number;
  webhookMaxAgeMs: number;
  deployScript: string;
  deployBranch: string;
  deployJobLabel: string;
  reflectOnState: string;
  orchestrateOnState: string;
  describeReactionEmoji: string;
  repository: RepositoryConfig;
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

function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? path.join(homedir(), value.slice(2))
      : value;
}

function absolute(value: string, base: string = process.cwd()): string {
  return path.resolve(base, expandHome(value));
}

function readServiceFile(file: string) {
  try {
    return ServiceFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(
      `invalid remote-agent config ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function readConfig(): ServerConfig {
  const configFile = absolute(
    optional("REMOTE_AGENT_CONFIG") ?? "remote-agent.config.json",
  );
  const file = readServiceFile(configFile);
  const hosts = configureMachines(file.hosts);
  const machineValue = optional("REMOTE_AGENT_MACHINE") ?? getDefaultMachineId();
  const parsedMachine = MachineSchema.safeParse(machineValue);
  if (!parsedMachine.success) {
    throw new Error(`REMOTE_AGENT_MACHINE ${parsedMachine.error.message}`);
  }
  getMachine({ id: parsedMachine.data });

  const zedRemoteHost = optional("REMOTE_AGENT_ZED_HOST");
  if (hosts.some((host) => host.zedConnection === "ssh") && !zedRemoteHost) {
    throw new Error(
      "REMOTE_AGENT_ZED_HOST is required when an SSH host is configured",
    );
  }

  const installRoot = absolute(
    optional("REMOTE_AGENT_INSTALL_ROOT") ??
      path.join("~/Library/Application Support", file.serviceName),
  );
  const repositoryRoot = absolute(file.repository.root);
  const worktreeRoot = absolute(file.repository.worktreeRoot, repositoryRoot);

  return {
    serviceName: file.serviceName,
    configFile,
    installRoot,
    hostname: optional("REMOTE_AGENT_HOST") ?? "127.0.0.1",
    port: integer("REMOTE_AGENT_PORT", 9000),
    publicUrl: required("REMOTE_AGENT_PUBLIC_URL"),
    databaseUrl:
      optional("REMOTE_AGENT_DATABASE_URL") ??
      `file:${path.join(installRoot, "state", "remote-agent.sqlite")}`,
    webhookSecret: required("LINEAR_WEBHOOK_SECRET"),
    apiKey: required("REMOTE_AGENT_API_KEY"),
    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    linearApiKey: required("LINEAR_API_KEY"),
    agentUserId: required("LINEAR_AGENT_USER_ID"),
    agentHandle: optional("LINEAR_AGENT_HANDLE"),
    agentTeamKey: optional("LINEAR_AGENT_TEAM_KEY") ?? "AGENT",
    bbBaseUrl: optional("REMOTE_AGENT_BB_URL") ?? "http://127.0.0.1:38886",
    bbProjectId: required("REMOTE_AGENT_BB_PROJECT_ID"),
    hosts,
    machine: parsedMachine.data,
    zedRemoteHost,
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
      path.join(installRoot, "app", "scripts", "deploy.sh"),
    deployBranch: optional("REMOTE_AGENT_DEPLOY_BRANCH") ?? "main",
    deployJobLabel:
      optional("REMOTE_AGENT_DEPLOY_JOB") ?? `dev.${file.serviceName}.deploy`,
    reflectOnState: optional("REMOTE_AGENT_REFLECT_ON_STATE") ?? "Pull Request",
    orchestrateOnState:
      optional("REMOTE_AGENT_ORCHESTRATE_ON_STATE") ?? "Planning",
    describeReactionEmoji:
      optional("REMOTE_AGENT_DESCRIBE_ON_REACTION") ?? "pencil2",
    repository: {
      root: repositoryRoot,
      worktreeRoot,
      bootstrapCommand: [...file.repository.bootstrapCommand],
      workflows: {
        describe: {
          ...file.repository.workflows.describe,
          model: file.repository.workflows.describe.model ?? null,
        },
        orchestrate: {
          ...file.repository.workflows.orchestrate,
          model: file.repository.workflows.orchestrate.model ?? null,
        },
        reflect: { ...file.repository.workflows.reflect },
      },
    },
    endOnState: optional("REMOTE_AGENT_END_ON_STATE") ?? "End",
  };
}
