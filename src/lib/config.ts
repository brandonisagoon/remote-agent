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
const ConfigIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !path.isAbsolute(value), "must be relative to the repository");
const WorkflowSchema = z.object({
  prompt: RepositoryRelativePathSchema,
  harness: z.enum(["claude", "codex"]),
  model: z.string().min(1).optional(),
});
const TagDefinitionSchema = z.object({
  description: z.string().min(1).optional(),
  options: z.array(z.string().min(1)).min(1).optional(),
  cardinality: z.enum(["one", "many"]).default("one"),
  routerVisible: z.boolean().default(false),
});
const RepositoryTriggersSchema = z
  .object({
    reflectOnState: z.string().min(1).default("Pull Request"),
    orchestrateOnState: z.string().min(1).default("Planning"),
    describeOnReaction: z.string().min(1).default("pencil2"),
  })
  .default({
    reflectOnState: "Pull Request",
    orchestrateOnState: "Planning",
    describeOnReaction: "pencil2",
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
  metadata: z
    .object({
      tags: z.record(ConfigIdSchema, TagDefinitionSchema).default({}),
    })
    .default({ tags: {} }),
  sessionDefaults: z
    .object({
      tags: z.record(ConfigIdSchema, z.array(z.string().min(1))).default({}),
    })
    .default({ tags: {} }),
  triggers: RepositoryTriggersSchema,
});
const LinearConnectionSchema = z.object({
  provider: z.literal("linear"),
  apiKey: z.string().min(1),
  agentUserId: z.string().min(1),
  agentHandle: z.string().min(1).optional(),
});
const RoutingConditionSchema = z.record(
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
);
const WebhookSchema = z.object({
  connection: ConfigIdSchema,
  webhookSecret: z.string().min(1),
  webhookMaxAgeMs: PositiveIntegerSchema.default(60_000),
  repositoryRouting: z.record(
    ConfigIdSchema,
    z.object({
      when: z.array(RoutingConditionSchema).min(1).optional(),
    }),
  ),
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
    ipcPath: z.string().min(1).optional(),
    githubWebhookSecret: z.string().min(1),
    webhooks: z.record(ConfigIdSchema, WebhookSchema),
  }),
  acpx: z
    .object({
      stateDir: z.string().min(1).optional(),
      permissionMode: z
        .enum(["approve-all", "approve-reads", "deny-all"])
        .default("approve-all"),
      nonInteractivePermissions: z.enum(["deny", "fail"]).default("deny"),
      agents: z
        .object({
          codex: CommandSchema.optional(),
          claude: CommandSchema.optional(),
        })
        .default({}),
    })
    .default({
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      agents: {},
    }),
  connections: z.record(ConfigIdSchema, LinearConnectionSchema),
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
  acp: z
    .object({
      hostId: z.string().min(1).optional(),
      provider: z.enum(["codex", "claude-code"]).default("codex"),
      model: z.string().min(1).optional(),
    })
    .default({ provider: "codex" }),
  hosts: z.array(MachineRecordSchema).min(1),
  repositories: z.record(ConfigIdSchema, RepositorySchema),
}).superRefine((file, context) => {
  const repositoryIds = new Set(Object.keys(file.repositories));
  if (repositoryIds.size === 0) {
    context.addIssue({ code: "custom", path: ["repositories"], message: "at least one repository is required" });
  }
  if (Object.keys(file.connections).length === 0) {
    context.addIssue({ code: "custom", path: ["connections"], message: "at least one connection is required" });
  }
  for (const [webhookId, webhook] of Object.entries(file.server.webhooks)) {
    if (webhookId === "github") {
      context.addIssue({ code: "custom", path: ["server", "webhooks", webhookId], message: "github is reserved for the deployment webhook" });
    }
    if (!file.connections[webhook.connection]) {
      context.addIssue({ code: "custom", path: ["server", "webhooks", webhookId, "connection"], message: `unknown connection: ${webhook.connection}` });
    }
    const targets = Object.entries(webhook.repositoryRouting);
    if (targets.length === 0) {
      context.addIssue({ code: "custom", path: ["server", "webhooks", webhookId, "repositoryRouting"], message: "at least one repository routing target is required" });
    }
    for (const [repositoryId, target] of targets) {
      if (!repositoryIds.has(repositoryId)) {
        context.addIssue({ code: "custom", path: ["server", "webhooks", webhookId, "repositoryRouting", repositoryId], message: `unknown repository: ${repositoryId}` });
      }
      if (targets.length > 1 && !target.when) {
        context.addIssue({ code: "custom", path: ["server", "webhooks", webhookId, "repositoryRouting", repositoryId], message: "an unconditional target must be the webhook's only repository" });
      }
    }
  }
  for (const [repositoryId, repository] of Object.entries(file.repositories)) {
    for (const [key, values] of Object.entries(repository.sessionDefaults.tags)) {
      const definition = repository.metadata.tags[key];
      if (!definition) {
        context.addIssue({ code: "custom", path: ["repositories", repositoryId, "sessionDefaults", "tags", key], message: `unknown repository tag: ${key}` });
        continue;
      }
      if (definition.cardinality === "one" && values.length > 1) {
        context.addIssue({ code: "custom", path: ["repositories", repositoryId, "sessionDefaults", "tags", key], message: "single-cardinality tag accepts at most one default" });
      }
      if (definition.options) {
        for (const value of values) {
          if (!definition.options.includes(value)) {
            context.addIssue({ code: "custom", path: ["repositories", repositoryId, "sessionDefaults", "tags", key], message: `value is not configured: ${value}` });
          }
        }
      }
    }
  }
});

export type ServiceFile = z.infer<typeof ServiceFileSchema>;

export interface WorkflowConfig {
  prompt: string;
  harness: Harness;
  model: string | null;
}

export interface RepositoryConfig {
  id: string;
  root: string;
  worktreeRoot: string;
  bootstrapCommand: string[];
  workflows: {
    describe: WorkflowConfig;
    orchestrate: WorkflowConfig;
    reflect: { prompt: string };
  };
  metadata: {
    tags: Record<string, TagDefinitionConfig>;
  };
  sessionDefaults: { tags: Record<string, string[]> };
  triggers: {
    reflectOnState: string;
    orchestrateOnState: string;
    describeOnReaction: string;
  };
}

export interface TagDefinitionConfig {
  description?: string;
  options?: string[];
  cardinality: "one" | "many";
  routerVisible: boolean;
}

export interface LinearConnectionConfig {
  id: string;
  provider: "linear";
  apiKey: string;
  agentUserId: string;
  agentHandle: string | null;
}

export interface WebhookConfig {
  id: string;
  connectionId: string;
  webhookSecret: string;
  webhookMaxAgeMs: number;
  repositoryRouting: Record<string, { when?: Array<Record<string, string[]>> }>;
}

export interface ServerConfig {
  serviceName: string;
  configFile: string;
  installRoot: string;
  hostname: string;
  port: number;
  publicUrl: string;
  databaseUrl: string;
  acpIpcPath: string;
  webhookSecret: string;
  apiKey: string;
  githubWebhookSecret: string;
  linearApiKey: string;
  agentUserId: string;
  agentHandle: string | null;
  agentTeamKey: string;
  hosts: readonly MachineRecord[];
  machine: Machine;
  zedRemoteHost: string | null;
  codexExecutable: string;
  routerModel: string | null;
  routerTimeoutMs: number;
  acpxStateDir: string;
  acpxPermissionMode: "approve-all" | "approve-reads" | "deny-all";
  acpxNonInteractivePermissions: "deny" | "fail";
  acpxAgentCommands: Partial<Record<"codex" | "claude", string[]>>;
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
  connections: Readonly<Record<string, LinearConnectionConfig>>;
  webhooks: Readonly<Record<string, WebhookConfig>>;
  repositories: Readonly<Record<string, RepositoryConfig>>;
  /** Present only on an event/session-scoped view. */
  activeConnectionId: string;
  /** Present only on an inbound webhook-scoped view. */
  activeWebhookId: string;
  /** Present only on an event/session-scoped view. */
  activeRepositoryId: string;
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
  const repositories = Object.fromEntries(
    Object.entries(file.repositories).map(([id, repository]) => {
      const root = absolute(repository.root, path.dirname(configFile));
      const worktreeRoot = absolute(repository.worktreeRoot, root);
      return [id, {
        id,
        root,
        worktreeRoot,
        bootstrapCommand: [...repository.bootstrapCommand],
        workflows: {
          describe: {
            ...repository.workflows.describe,
            model: repository.workflows.describe.model ?? null,
          },
          orchestrate: {
            ...repository.workflows.orchestrate,
            model: repository.workflows.orchestrate.model ?? null,
          },
          reflect: { ...repository.workflows.reflect },
        },
        metadata: {
          tags: Object.fromEntries(
            Object.entries(repository.metadata.tags).map(([key, definition]) => [
              key,
              {
                ...(definition.description
                  ? { description: definition.description }
                  : {}),
                ...(definition.options
                  ? { options: [...definition.options] }
                  : {}),
                cardinality: definition.cardinality,
                routerVisible: definition.routerVisible,
              },
            ]),
          ),
        },
        sessionDefaults: {
          tags: Object.fromEntries(
            Object.entries(repository.sessionDefaults.tags).map(([key, values]) => [
              key,
              [...values],
            ]),
          ),
        },
        triggers: { ...repository.triggers },
      } satisfies RepositoryConfig];
    }),
  );
  const connections = Object.fromEntries(
    Object.entries(file.connections).map(([id, connection]) => [id, {
      id,
      provider: connection.provider,
      apiKey: connection.apiKey,
      agentUserId: connection.agentUserId,
      agentHandle: connection.agentHandle ?? null,
    } satisfies LinearConnectionConfig]),
  );
  const webhooks = Object.fromEntries(
    Object.entries(file.server.webhooks).map(([id, webhook]) => [id, {
      id,
      connectionId: webhook.connection,
      webhookSecret: webhook.webhookSecret,
      webhookMaxAgeMs: webhook.webhookMaxAgeMs,
      repositoryRouting: Object.fromEntries(
        Object.entries(webhook.repositoryRouting).map(([repositoryId, target]) => [
          repositoryId,
          target.when
            ? {
                when: target.when.map((condition) => Object.fromEntries(
                  Object.entries(condition).map(([key, values]) => [key, [...values]]),
                )),
              }
            : {},
        ]),
      ),
    } satisfies WebhookConfig]),
  );
  const firstRepository = Object.values(repositories)[0]!;
  const firstConnection = Object.values(connections)[0]!;
  const firstWebhook = Object.values(webhooks)[0];

  return {
    serviceName: file.serviceName,
    configFile,
    installRoot,
    hostname: file.server.host,
    port: file.server.port,
    publicUrl: file.server.publicUrl,
    databaseUrl: resolveDatabaseUrl(file.server.databaseUrl, path.dirname(configFile)),
    acpIpcPath: absolute(
      file.server.ipcPath ?? path.join(installRoot, "remote-agent.sock"),
      path.dirname(configFile),
    ),
    webhookSecret: firstWebhook?.webhookSecret ?? "unused",
    apiKey: file.server.apiKey,
    githubWebhookSecret: file.server.githubWebhookSecret,
    linearApiKey: firstConnection.apiKey,
    agentUserId: firstConnection.agentUserId,
    agentHandle: firstConnection.agentHandle,
    // Legacy, unmounted Agent-team projection helpers still compile against
    // this alias. It is no longer configurable or used by production routes.
    agentTeamKey: "AGENT",
    hosts,
    machine,
    zedRemoteHost,
    codexExecutable: file.runtime.codexExecutable,
    routerModel: file.runtime.routerModel ?? null,
    routerTimeoutMs: file.runtime.routerTimeoutMs,
    acpxStateDir: absolute(file.acpx.stateDir ?? path.join(installRoot, "acpx")),
    acpxPermissionMode: file.acpx.permissionMode,
    acpxNonInteractivePermissions: file.acpx.nonInteractivePermissions,
    acpxAgentCommands: {
      ...(file.acpx.agents.codex
        ? { codex: [...file.acpx.agents.codex] }
        : {}),
      ...(file.acpx.agents.claude
        ? { claude: [...file.acpx.agents.claude] }
        : {}),
    },
    webhookMaxAgeMs: firstWebhook?.webhookMaxAgeMs ?? 60_000,
    deployScript:
      file.deployment.script ?? path.join(installRoot, "app", "scripts", "deploy.sh"),
    deployBranch: file.deployment.branch,
    deployJobLabel:
      file.deployment.jobLabel ?? `dev.${file.serviceName}.deploy`,
    reflectOnState: firstRepository.triggers.reflectOnState,
    orchestrateOnState: firstRepository.triggers.orchestrateOnState,
    describeReactionEmoji: firstRepository.triggers.describeOnReaction,
    repository: firstRepository,
    endOnState: "End",
    acp: {
      ...(file.acp.hostId ? { hostId: file.acp.hostId } : {}),
      providerId: file.acp.provider,
      ...(file.acp.model ? { model: file.acp.model } : {}),
    },
    connections,
    webhooks,
    repositories,
    activeConnectionId: firstConnection.id,
    activeWebhookId: firstWebhook?.id ?? "",
    activeRepositoryId: firstRepository.id,
  };
}

export function getRepositoryConfig(
  config: ServerConfig,
  repositoryId: string,
): RepositoryConfig {
  const repository = config.repositories[repositoryId];
  if (!repository) throw new Error(`unknown repository: ${repositoryId}`);
  return repository;
}

export function getLinearConnection(
  config: ServerConfig,
  connectionId: string,
): LinearConnectionConfig {
  const connection = config.connections[connectionId];
  if (!connection) throw new Error(`unknown Linear connection: ${connectionId}`);
  return connection;
}

export function getWebhookConfig(
  config: ServerConfig,
  webhookId: string,
): WebhookConfig {
  const webhook = config.webhooks[webhookId];
  if (!webhook) throw new Error(`unknown webhook: ${webhookId}`);
  return webhook;
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveRepositoryForCwd(
  config: ServerConfig,
  cwd: string,
): RepositoryConfig {
  const absoluteCwd = path.resolve(cwd);
  const candidates = Object.values(config.repositories).flatMap((repository) => {
    const roots = [repository.root, repository.worktreeRoot]
      .filter((root) => pathContains(root, absoluteCwd))
      .sort((a, b) => b.length - a.length);
    return roots[0] ? [{ repository, matchLength: roots[0].length }] : [];
  }).sort((a, b) => b.matchLength - a.matchLength);
  if (candidates.length === 0) {
    throw new Error(`cwd is not inside a configured repository: ${absoluteCwd}`);
  }
  if (
    candidates[1] &&
    candidates[1].matchLength === candidates[0]!.matchLength &&
    candidates[1].repository.id !== candidates[0]!.repository.id
  ) {
    throw new Error(`cwd matches multiple configured repositories: ${absoluteCwd}`);
  }
  return candidates[0]!.repository;
}

export function routeWebhookRepository(
  config: ServerConfig,
  webhookId: string,
  attributes: Readonly<Record<string, string | readonly string[] | null | undefined>>,
): RepositoryConfig {
  const webhook = getWebhookConfig(config, webhookId);
  const matchingRepositoryIds = new Set(
    Object.entries(webhook.repositoryRouting)
      .filter(([, target]) =>
        !target.when || target.when.some((condition) =>
          Object.entries(condition).every(([key, expected]) => {
            const actual = attributes[key];
            const values: readonly string[] = Array.isArray(actual)
              ? actual
              : typeof actual === "string"
                ? [actual]
                : [];
            return values.some((value) => expected.includes(value));
          }),
        ),
      )
      .map(([repositoryId]) => repositoryId),
  );
  if (matchingRepositoryIds.size !== 1) {
    throw new Error(
      matchingRepositoryIds.size === 0
        ? `webhook ${webhookId} did not match a repository routing rule`
        : `webhook ${webhookId} matched multiple repositories`,
    );
  }
  const repositoryId = [...matchingRepositoryIds][0]!;
  return getRepositoryConfig(config, repositoryId);
}

/**
 * Produces an immutable event/session-scoped view for legacy integration
 * helpers while the Agent-team projection is being removed. Every alias is
 * derived from explicit connection and repository IDs, so concurrent events
 * from different Linear workspaces cannot share credentials or workflows.
 */
export function scopeConfig(
  config: ServerConfig,
  input: { connectionId: string; repositoryId: string; webhookId?: string },
): ServerConfig {
  const connection = getLinearConnection(config, input.connectionId);
  const repository = getRepositoryConfig(config, input.repositoryId);
  return {
    ...config,
    activeConnectionId: connection.id,
    activeWebhookId: input.webhookId ?? config.activeWebhookId,
    activeRepositoryId: repository.id,
    linearApiKey: connection.apiKey,
    agentUserId: connection.agentUserId,
    agentHandle: connection.agentHandle,
    agentTeamKey: config.agentTeamKey,
    repository,
    reflectOnState: repository.triggers.reflectOnState,
    orchestrateOnState: repository.triggers.orchestrateOnState,
    describeReactionEmoji: repository.triggers.describeOnReaction,
    endOnState: config.endOnState,
  };
}
