import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  configureMachines,
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
  name: z.string().min(1).optional(),
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
const RoutingConditionSchema = z.record(
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
);
const WebhookSchema = z.object({
  /** The machine whose daemon serves this endpoint. */
  machineId: MachineSchema,
  /** Path segment of the inbound endpoint: publicUrl + /webhooks/<slug>. */
  slug: ConfigIdSchema,
  secret: z.string().min(1),
  webhookMaxAgeMs: PositiveIntegerSchema.default(60_000),
  /** "*" subscribes every repository, present and future. */
  repositories: z.union([
    z.literal("*"),
    z.record(
      ConfigIdSchema,
      z.object({
        when: z.array(RoutingConditionSchema).min(1).optional(),
      }),
    ),
  ]).default("*"),
});
const RouterSchema = z
  .object({
    /** Harness that runs the session-routing prompt (Codex-only today). */
    harnessId: z.enum(["codex", "claude"]).default("codex"),
    model: z.string().min(1).optional(),
    timeoutMs: PositiveIntegerSchema.default(30_000),
  })
  .default({ harnessId: "codex", timeoutMs: 30_000 });
const LinearConnectionSchema = z.object({
  provider: z.literal("linear"),
  name: z.string().min(1),
  apiKey: z.string().min(1),
  agentUserId: z.string().min(1),
  agentHandle: z.string().min(1).optional(),
  webhook: WebhookSchema.optional(),
  /** Routes this connection's incoming events to sessions. */
  router: RouterSchema,
});
const ConnectionSchema = LinearConnectionSchema;
const AcpxSchema = z
  .object({
    stateDir: z.string().min(1).optional(),
    permissionMode: z
      .enum(["approve-all", "approve-reads", "deny-all"])
      .default("approve-all"),
    nonInteractivePermissions: z.enum(["deny", "fail"]).default("deny"),
    // Presence enables the harness in the UI; command (optional) overrides
    // acpx's built-in adapter launch profile.
    agents: z
      .object({
        codex: z.object({ command: CommandSchema.optional() }).optional(),
        claude: z.object({ command: CommandSchema.optional() }).optional(),
      })
      .default({}),
  })
  .default({
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agents: {},
  });

export const ServiceFileSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(2),
  serviceName: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  machine: z.object({
    id: MachineSchema,
    name: z.string().min(1),
    acceptsTrackerInput: z.boolean().default(true),
    server: z.object({
      publicUrl: z.string().min(1),
      apiKey: z.string().min(1),
      listen: z.object({
        host: z.string().min(1).default("127.0.0.1"),
        port: PositiveIntegerSchema.default(9000),
      }).default({ host: "127.0.0.1", port: 9000 }),
      databaseUrl: z.string().min(1).optional(),
      acpSocketPath: z.string().min(1).optional(),
      controlSocketPath: z.string().min(1).optional(),
    }),
    zed: z.object({
      connection: z.enum(["local", "ssh"]).default("local"),
      remoteHost: z.string().min(1).optional(),
    }).default({ connection: "local" }),
    acpx: AcpxSchema,
    acp: z.object({
      hostId: z.string().min(1).optional(),
      provider: z.enum(["codex", "claude-code"]).default("codex"),
      model: z.string().min(1).optional(),
    }).default({ provider: "codex" }),
    installation: z.object({
      root: z.string().min(1).optional(),
      gitRemote: z.string().min(1).optional(),
      branch: z.string().min(1).default("main"),
      script: z.string().min(1).optional(),
      tunnelName: z.string().min(1).optional(),
    }).default({ branch: "main" }),
    updates: z.object({
      channel: z.enum(["stable", "beta"]).default("stable"),
    }).default({ channel: "stable" }),
  }),
  connections: z.record(ConfigIdSchema, ConnectionSchema),
  repositories: z.record(ConfigIdSchema, RepositorySchema),
}).superRefine((file, context) => {
  const repositoryIds = new Set(Object.keys(file.repositories));
  if (repositoryIds.size === 0) {
    context.addIssue({ code: "custom", path: ["repositories"], message: "at least one repository is required" });
  }
  if (file.machine.zed.connection === "ssh" && !file.machine.zed.remoteHost) {
    context.addIssue({ code: "custom", path: ["machine", "zed", "remoteHost"], message: "remoteHost is required for an SSH Zed connection" });
  }
  const webhookSlugs = new Set<string>();
  for (const [connectionId, connection] of Object.entries(file.connections)) {
    const webhook = connection.webhook;
    if (!webhook) continue;
    if (webhook.machineId !== file.machine.id) {
      context.addIssue({ code: "custom", path: ["connections", connectionId, "webhook", "machineId"], message: `unknown machine: ${webhook.machineId}` });
    }
    if (webhookSlugs.has(webhook.slug)) {
      context.addIssue({ code: "custom", path: ["connections", connectionId, "webhook", "slug"], message: `duplicate webhook slug: ${webhook.slug}` });
    }
    webhookSlugs.add(webhook.slug);
    if (webhook.repositories !== "*") {
      const targets = Object.keys(webhook.repositories);
      if (targets.length === 0) {
        context.addIssue({ code: "custom", path: ["connections", connectionId, "webhook", "repositories"], message: "a webhook requires at least one repository (or \"*\")" });
      }
      for (const repositoryId of targets) {
        if (!repositoryIds.has(repositoryId)) {
          context.addIssue({ code: "custom", path: ["connections", connectionId, "webhook", "repositories", repositoryId], message: `unknown repository: ${repositoryId}` });
        }
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
  name: string;
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
  name: string;
  apiKey: string;
  agentUserId: string;
  agentHandle: string | null;
  router: { harnessId: "codex" | "claude"; model: string | null; timeoutMs: number };
}

export type ConnectionConfig = LinearConnectionConfig;

export interface WebhookConfig {
  id: string;
  provider: "linear";
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
  controlIpcPath: string;
  webhookSecret: string;
  apiKey: string;
  linearApiKey: string;
  agentUserId: string;
  agentHandle: string | null;
  agentTeamKey: string;
  hosts: readonly MachineRecord[];
  machine: Machine;
  zedRemoteHost: string | null;
  routerHarnessId: "codex" | "claude";
  routerModel: string | null;
  routerTimeoutMs: number;
  acpxStateDir: string;
  acpxPermissionMode: "approve-all" | "approve-reads" | "deny-all";
  acpxNonInteractivePermissions: "deny" | "fail";
  acpxAgentCommands: Partial<Record<"codex" | "claude", string[]>>;
  webhookMaxAgeMs: number;
  deployScript: string;
  deployBranch: string;
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
  connections: Readonly<Record<string, ConnectionConfig>>;
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
    return parseServiceFile(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(
      `invalid remote-agent config ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseServiceFile(value: unknown): ServiceFile {
  if (
    typeof value === "object" &&
    value !== null &&
    !("schemaVersion" in value)
  ) {
    throw new Error(
      "schemaVersion 2 is required; migrate server/runtime/hosts into the singular machine object",
    );
  }
  return ServiceFileSchema.parse(value);
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
  const machine = file.machine.id;
  const hosts = configureMachines([{
    id: machine,
    label: file.machine.name,
    zedConnection: file.machine.zed.connection,
    acceptsTrackerInput: file.machine.acceptsTrackerInput,
    default: true,
  }]);
  const zedRemoteHost = file.machine.zed.remoteHost ?? null;

  const installRoot = absolute(
    file.machine.installation.root ??
      path.join("~/Library/Application Support", file.serviceName),
  );
  const repositories = Object.fromEntries(
    Object.entries(file.repositories).map(([id, repository]) => {
      const root = absolute(repository.root, path.dirname(configFile));
      const worktreeRoot = absolute(repository.worktreeRoot, root);
      return [id, {
        id,
        name: repository.name ?? id,
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
      provider: "linear" as const,
      name: connection.name,
      apiKey: connection.apiKey,
      agentUserId: connection.agentUserId,
      agentHandle: connection.agentHandle ?? null,
      router: {
        harnessId: connection.router.harnessId,
        model: connection.router.model ?? null,
        timeoutMs: connection.router.timeoutMs,
      },
    } satisfies LinearConnectionConfig]),
  );
  // Webhooks nest inside connections in the file; the resolved view stays a
  // slug-keyed map so routing lookups are unchanged. "*" expands to every
  // repository as an unconditional target.
  const webhooks = Object.fromEntries(
    Object.entries(file.connections).flatMap(([connectionId, connection]) => {
      const webhook = connection.webhook;
      if (!webhook) return [];
      const targets = webhook.repositories === "*"
        ? Object.keys(file.repositories).map((repositoryId) => [repositoryId, {}] as const)
        : Object.entries(webhook.repositories).map(([repositoryId, target]) => [
            repositoryId,
            target.when
              ? {
                  when: target.when.map((condition) => Object.fromEntries(
                    Object.entries(condition).map(([key, values]) => [key, [...values]]),
                  )),
                }
              : {},
          ] as const);
      return [[webhook.slug, {
        id: webhook.slug,
        provider: connection.provider,
        connectionId,
        webhookSecret: webhook.secret,
        webhookMaxAgeMs: webhook.webhookMaxAgeMs,
        repositoryRouting: Object.fromEntries(targets),
      } satisfies WebhookConfig]];
    }),
  );
  const firstRepository = Object.values(repositories)[0]!;
  const firstConnection = Object.values(connections)[0];
  const firstWebhook = Object.values(webhooks)[0];

  return {
    serviceName: file.serviceName,
    configFile,
    installRoot,
    hostname: file.machine.server.listen.host,
    port: file.machine.server.listen.port,
    publicUrl: file.machine.server.publicUrl,
    databaseUrl: resolveDatabaseUrl(file.machine.server.databaseUrl, path.dirname(configFile)),
    acpIpcPath: absolute(
      file.machine.server.acpSocketPath ?? path.join(installRoot, "remote-agent.sock"),
      path.dirname(configFile),
    ),
    controlIpcPath: absolute(
      file.machine.server.controlSocketPath ?? path.join(installRoot, "control.sock"),
      path.dirname(configFile),
    ),
    webhookSecret: firstWebhook?.webhookSecret ?? "unused",
    apiKey: file.machine.server.apiKey,
    linearApiKey: firstConnection?.apiKey ?? "unused",
    agentUserId: firstConnection?.agentUserId ?? "unused",
    agentHandle: firstConnection?.agentHandle ?? null,
    // Legacy, unmounted Agent-team projection helpers still compile against
    // this alias. It is no longer configurable or used by production routes.
    agentTeamKey: "AGENT",
    hosts,
    machine,
    zedRemoteHost,
    routerHarnessId: firstConnection?.router.harnessId ?? "codex",
    routerModel: firstConnection?.router.model ?? null,
    routerTimeoutMs: firstConnection?.router.timeoutMs ?? 30_000,
    acpxStateDir: absolute(file.machine.acpx.stateDir ?? path.join(installRoot, "acpx")),
    acpxPermissionMode: file.machine.acpx.permissionMode,
    acpxNonInteractivePermissions: file.machine.acpx.nonInteractivePermissions,
    acpxAgentCommands: {
      ...(file.machine.acpx.agents.codex?.command
        ? { codex: [...file.machine.acpx.agents.codex.command] }
        : {}),
      ...(file.machine.acpx.agents.claude?.command
        ? { claude: [...file.machine.acpx.agents.claude.command] }
        : {}),
    },
    webhookMaxAgeMs: firstWebhook?.webhookMaxAgeMs ?? 60_000,
    deployScript:
      file.machine.installation.script ?? path.join(installRoot, "app", "scripts", "deploy.sh"),
    deployBranch: file.machine.installation.branch,
    reflectOnState: firstRepository.triggers.reflectOnState,
    orchestrateOnState: firstRepository.triggers.orchestrateOnState,
    describeReactionEmoji: firstRepository.triggers.describeOnReaction,
    repository: firstRepository,
    endOnState: "End",
    acp: {
      ...(file.machine.acp.hostId ? { hostId: file.machine.acp.hostId } : {}),
      providerId: file.machine.acp.provider,
      ...(file.machine.acp.model ? { model: file.machine.acp.model } : {}),
    },
    connections,
    webhooks,
    repositories,
    activeConnectionId: firstConnection?.id ?? "",
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
  if (!connection || connection.provider !== "linear") {
    throw new Error(`unknown Linear connection: ${connectionId}`);
  }
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
    routerHarnessId: connection.router.harnessId,
    routerModel: connection.router.model,
    routerTimeoutMs: connection.router.timeoutMs,
    agentTeamKey: config.agentTeamKey,
    repository,
    reflectOnState: repository.triggers.reflectOnState,
    orchestrateOnState: repository.triggers.orchestrateOnState,
    describeReactionEmoji: repository.triggers.describeOnReaction,
    endOnState: config.endOnState,
  };
}
