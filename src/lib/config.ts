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

const PositiveIntegerSchema = z.number().int().positive();
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
  server: z.object({
    publicUrl: z.string().min(1),
    apiKey: z.string().min(1),
    host: z.string().min(1).default("127.0.0.1"),
    port: PositiveIntegerSchema.default(9000),
    databaseUrl: z.string().min(1).optional(),
  }),
  bb: z.object({
    projectId: z.string().min(1),
    url: z.string().min(1).default("http://127.0.0.1:38886"),
    reconcileIntervalMs: PositiveIntegerSchema.default(60_000),
  }),
  linear: z.object({
    webhookSecret: z.string().min(1),
    apiKey: z.string().min(1),
    agentUserId: z.string().min(1),
    agentHandle: z.string().min(1).optional(),
    agentTeamKey: z.string().min(1).default("AGENT"),
    webhookMaxAgeMs: PositiveIntegerSchema.default(60_000),
  }),
  github: z.object({ webhookSecret: z.string().min(1) }),
  runtime: z
    .object({
      machine: MachineSchema.optional(),
      zedRemoteHost: z.string().min(1).optional(),
      codexExecutable: z.string().min(1).default("codex"),
      routerModel: z.string().min(1).optional(),
      routerTimeoutMs: PositiveIntegerSchema.default(30_000),
    })
    .default({ codexExecutable: "codex", routerTimeoutMs: 30_000 }),
  deployment: z
    .object({
      installRoot: z.string().min(1).optional(),
      gitRemote: z.string().min(1).optional(),
      branch: z.string().min(1).default("main"),
      script: z.string().min(1).optional(),
      jobLabel: z.string().min(1).optional(),
      tunnelName: z.string().min(1).optional(),
    })
    .default({ branch: "main" }),
  triggers: z
    .object({
      reflectOnState: z.string().min(1).default("Pull Request"),
      orchestrateOnState: z.string().min(1).default("Planning"),
      endOnState: z.string().min(1).default("End"),
      describeOnReaction: z.string().min(1).default("pencil2"),
    })
    .default({
      reflectOnState: "Pull Request",
      orchestrateOnState: "Planning",
      endOnState: "End",
      describeOnReaction: "pencil2",
    }),
  acp: z
    .object({
      hostId: z.string().min(1).optional(),
      provider: z.enum(["codex", "claude-code"]).default("codex"),
      model: z.string().min(1).optional(),
    })
    .default({ provider: "codex" }),
  hosts: z.array(MachineRecordSchema).min(1),
  repository: RepositorySchema,
});

export type ServiceFile = z.infer<typeof ServiceFileSchema>;

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
  acp: {
    hostId?: string;
    providerId: "codex" | "claude-code";
    model?: string;
  };
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

export function configFilePath(): string {
  return absolute(process.env.REMOTE_AGENT_CONFIG?.trim() || "remote-agent.config.json");
}

export function readServiceFile(file: string = configFilePath()): ServiceFile {
  try {
    return ServiceFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(
      `invalid remote-agent config ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveDatabaseUrl(value: string | undefined, stateRoot: string): string {
  if (!value) return `file:${path.join(stateRoot, "remote-agent.sqlite")}`;
  if (!value.startsWith("file:")) return value;
  const file = value.slice("file:".length);
  return `file:${absolute(file, stateRoot)}`;
}

export function readConfig(): ServerConfig {
  const configFile = configFilePath();
  const file = readServiceFile(configFile);
  const hosts = configureMachines(file.hosts);
  const machine = file.runtime.machine ?? getDefaultMachineId();
  getMachine({ id: machine });

  const zedRemoteHost = file.runtime.zedRemoteHost ?? null;
  if (hosts.some((host) => host.zedConnection === "ssh") && !zedRemoteHost) {
    throw new Error(
      "runtime.zedRemoteHost is required when an SSH host is configured",
    );
  }

  const installRoot = absolute(
    file.deployment.installRoot ??
      path.join("~/Library/Application Support", file.serviceName),
  );
  const repositoryRoot = absolute(file.repository.root, path.dirname(configFile));
  const worktreeRoot = absolute(file.repository.worktreeRoot, repositoryRoot);

  return {
    serviceName: file.serviceName,
    configFile,
    installRoot,
    hostname: file.server.host,
    port: file.server.port,
    publicUrl: file.server.publicUrl,
    databaseUrl: resolveDatabaseUrl(file.server.databaseUrl, path.dirname(configFile)),
    webhookSecret: file.linear.webhookSecret,
    apiKey: file.server.apiKey,
    githubWebhookSecret: file.github.webhookSecret,
    linearApiKey: file.linear.apiKey,
    agentUserId: file.linear.agentUserId,
    agentHandle: file.linear.agentHandle ?? null,
    agentTeamKey: file.linear.agentTeamKey,
    bbBaseUrl: file.bb.url,
    bbProjectId: file.bb.projectId,
    hosts,
    machine,
    zedRemoteHost,
    codexExecutable: file.runtime.codexExecutable,
    routerModel: file.runtime.routerModel ?? null,
    routerTimeoutMs: file.runtime.routerTimeoutMs,
    bbReconcileIntervalMs: file.bb.reconcileIntervalMs,
    webhookMaxAgeMs: file.linear.webhookMaxAgeMs,
    deployScript:
      file.deployment.script ?? path.join(installRoot, "app", "scripts", "deploy.sh"),
    deployBranch: file.deployment.branch,
    deployJobLabel:
      file.deployment.jobLabel ?? `dev.${file.serviceName}.deploy`,
    reflectOnState: file.triggers.reflectOnState,
    orchestrateOnState: file.triggers.orchestrateOnState,
    describeReactionEmoji: file.triggers.describeOnReaction,
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
    endOnState: file.triggers.endOnState,
    acp: {
      ...(file.acp.hostId ? { hostId: file.acp.hostId } : {}),
      providerId: file.acp.provider,
      ...(file.acp.model ? { model: file.acp.model } : {}),
    },
  };
}
