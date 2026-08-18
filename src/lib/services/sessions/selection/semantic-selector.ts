import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ServerConfig } from "../../../config.ts";
import {
  AgentIssueLabel,
  type RouteCandidate,
} from "../../../../types/sessions/index.ts";
import {
  RouteActionSchema,
  RouteDecisionSchema,
  RouteReasonSchema,
  type RouteDecision,
  type ReplyTarget,
  type RoutingInput,
} from "../../../../types/sessions/selection.ts";

export class RouterTimeoutError extends Error {}

const ROLE_CATALOG = [
  {
    name: AgentIssueLabel.Role.Primary,
    routing: "May receive Linear input when all server eligibility checks pass.",
  },
  {
    name: AgentIssueLabel.Role.Delegate,
    routing: "A subagent owned by another session; never receives Linear input.",
  },
  {
    name: AgentIssueLabel.Role.Viewer,
    routing: "Observes work without owning it; never receives Linear input.",
  },
  {
    name: AgentIssueLabel.Role.Unassigned,
    routing: "Has no routing responsibility; never receives Linear input.",
  },
] as const;

function toml(value: string): string {
  return JSON.stringify(value);
}

export function outputSchema(
  candidates: RouteCandidate[],
  replyTargets: ReplyTarget[],
) {
  return {
    type: "object",
    properties: {
      targetAgentIssueIdentifier: {
        type: ["string", "null"],
        enum: [
          null,
          ...candidates.map((candidate) => candidate.agentIssueIdentifier),
        ],
      },
      reasonCode: {
        type: "string",
        enum: RouteReasonSchema.options,
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      expectedActions: {
        type: "array",
        items: {
          type: "string",
          enum: RouteActionSchema.options,
        },
      },
      replyToCommentId: {
        type: ["string", "null"],
        enum: [
          null,
          ...replyTargets.map((target) => target.commentId),
        ],
      },
    },
    required: [
      "targetAgentIssueIdentifier",
      "reasonCode",
      "confidence",
      "expectedActions",
      "replyToCommentId",
    ],
    additionalProperties: false,
  };
}

function bounded(value: string | null, limit: number): string | null {
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function boundedTail(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit
    ? `…${trimmed.slice(-limit)}`
    : trimmed;
}

/**
 * Let a one-off model make the semantic choice while exposing no Linear write
 * tools and no broad repository context. Candidate eligibility is established
 * before this call and revalidated after it.
 */
export async function selectSessionWithCodex(
  config: ServerConfig,
  input: RoutingInput,
): Promise<RouteDecision> {
  if (input.candidates.length === 0) {
    return {
      targetAgentIssueIdentifier: null,
      reasonCode: "no_eligible_candidate",
      confidence: 1,
      expectedActions: [],
      replyToCommentId: null,
    };
  }

  if (input.candidates.length === 1) {
    const candidate = input.candidates[0]!;
    const replyTargets = input.replyTargets ?? [];
    const deterministic: RouteDecision = {
      targetAgentIssueIdentifier: candidate.agentIssueIdentifier,
      reasonCode: "only_eligible_candidate",
      confidence: 1,
      expectedActions: replyTargets.length > 0 ? ["reply"] : [],
      replyToCommentId: replyTargets[0]?.commentId ?? null,
    };

    if (replyTargets.length === 0) return deterministic;

    try {
      const classified = await runCodexRouter(config, input);
      return {
        ...deterministic,
        expectedActions: classified.expectedActions,
        replyToCommentId: classified.replyToCommentId,
      };
    } catch (error) {
      console.warn(
        `[router] single-candidate action classification failed; falling back to reply heuristic: ${error instanceof Error ? error.message : String(error)}`,
      );
      return deterministic;
    }
  }

  return runCodexRouter(config, input);
}

async function runCodexRouter(
  config: ServerConfig,
  input: RoutingInput,
): Promise<RouteDecision> {
  const runDir = mkdtempSync(path.join(tmpdir(), "remote-agent-router-"));
  const outputFile = path.join(runDir, "decision.json");
  const schemaFile = path.join(runDir, "schema.json");
  const contextFile = path.join(runDir, "context.json");
  const skillDir = path.join(runDir, ".agents", "skills", "route-linear-session");
  const sourceSkill = path.join(
    import.meta.dir,
    "select-session",
    "SKILL.md",
  );
  const mcpScript = path.join(import.meta.dir, "mcp.ts");

  try {
    mkdirSync(skillDir, { recursive: true });
    cpSync(sourceSkill, path.join(skillDir, "SKILL.md"));
    writeFileSync(
      schemaFile,
      JSON.stringify(
        outputSchema(input.candidates, input.replyTargets ?? []),
      ),
    );
    writeFileSync(
      contextFile,
      JSON.stringify({
        cubeIssueIdentifier: input.cubeIssueIdentifier,
        cubeIssue: input.cubeIssue
          ? {
              ...input.cubeIssue,
              description: bounded(input.cubeIssue.description, 2_000),
            }
          : null,
        comment: bounded(input.comment, 8_000),
        workerContext: input.workerContext,
        roleCatalog: ROLE_CATALOG,
        candidates: input.candidates.map((candidate) => ({
          agentIssueIdentifier: candidate.agentIssueIdentifier,
          status: candidate.status,
          labels: candidate.labels,
          harness: candidate.runtime.harness,
          role: candidate.runtime.role,
          machine: candidate.runtime.machine,
        })),
        replyTargets: (input.replyTargets ?? []).map((target) => ({
          ...target,
          excerpt: bounded(target.excerpt, 500) ?? "",
        })),
      }),
      { mode: 0o600 },
    );

    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--cd",
      runDir,
      "--output-schema",
      schemaFile,
      "--output-last-message",
      outputFile,
      "--config",
      `mcp_servers.linear_session.command=${toml(process.execPath)}`,
      "--config",
      `mcp_servers.linear_session.args=[${toml(mcpScript)}]`,
      "--config",
      `mcp_servers.linear_session.env={REMOTE_AGENT_ROUTING_CONTEXT_FILE=${toml(contextFile)}}`,
      "--config",
      "mcp_servers.linear_session.required=true",
      "--config",
      'mcp_servers.linear_session.enabled_tools=["get_routing_context"]',
      "--config",
      'mcp_servers.linear_session.default_tools_approval_mode="approve"',
      "--config",
      "features.hooks=false",
    ];
    if (config.routerModel) args.push("--model", config.routerModel);
    args.push(
      "Use $route-linear-session. Call get_routing_context, select the best eligible session, and return only the schema-conforming decision.",
    );

    const child = Bun.spawn([config.codexExecutable, ...args], {
      cwd: runDir,
      env: {
        HOME: process.env.HOME ?? "",
        CODEX_HOME: process.env.CODEX_HOME ?? "",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        REMOTE_AGENT_SUPPRESS_HOOKS: "1",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });

    const timer = setTimeout(() => child.kill(9), config.routerTimeoutMs);
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer));

    if (exitCode === 137 || exitCode === 9) {
      throw new RouterTimeoutError("Codex router timed out");
    }
    if (exitCode !== 0) {
      throw new Error(
        `Codex router exited ${exitCode}: ${boundedTail(stderr, 2_000)}`,
      );
    }

    return RouteDecisionSchema.parse(
      JSON.parse(readFileSync(outputFile, "utf8")),
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
