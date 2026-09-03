import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerConfig } from "../../../config.ts";
import type { RouteCandidate } from "../../../../types/sessions/index.ts";
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
    name: "primary",
    routing: "May receive Linear input when all server eligibility checks pass.",
  },
  {
    name: "delegate",
    routing: "A subagent owned by another session; never receives Linear input.",
  },
  {
    name: "viewer",
    routing: "Observes work without owning it; never receives Linear input.",
  },
  {
    name: "unassigned",
    routing: "Has no routing responsibility; never receives Linear input.",
  },
] as const;

const SKILL_TEXT = readFileSync(
  path.join(import.meta.dir, "select-session", "SKILL.md"),
  "utf8",
);

/** The acpx CLI entry; overridable so tests can substitute a fake agent. */
function acpxCliPath(): string {
  const override = process.env.REMOTE_AGENT_ACPX_CLI;
  if (override) return override;
  return fileURLToPath(new URL("dist/cli.js", import.meta.resolve("acpx/package.json")));
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
 * tools and no repository context. Candidate eligibility is established
 * before this call and revalidated after it.
 */
export async function selectSessionWithRouter(
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
      const classified = await runRouter(config, input);
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

  return runRouter(config, input);
}

/**
 * Routes through acpx (one-shot `exec`, no session state) so any ACP-capable
 * harness can act as the router — the daemon carries no per-CLI invocation
 * knowledge. Context and the output schema travel in the prompt; the decision
 * is the agent's final message, validated with zod.
 */
async function runRouter(
  config: ServerConfig,
  input: RoutingInput,
): Promise<RouteDecision> {
  const runDir = mkdtempSync(path.join(tmpdir(), "remote-agent-router-"));

  try {
    const schema = outputSchema(input.candidates, input.replyTargets ?? []);
    const context = {
      sourceIssueIdentifier: input.sourceIssueIdentifier,
      sourceIssue: input.sourceIssue
        ? {
            ...input.sourceIssue,
            description: bounded(input.sourceIssue.description, 2_000),
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
    };

    const prompt = [
      SKILL_TEXT,
      "",
      "<routing-context>",
      JSON.stringify(context),
      "</routing-context>",
      "",
      "<output-schema>",
      JSON.stringify(schema),
      "</output-schema>",
      "",
      "Select the best eligible session from the routing context. Respond with ONLY a JSON object conforming to the output schema — no prose, no code fences.",
    ].join("\n");

    const args = [
      "--format",
      "quiet",
      "--deny-all",
      "--no-fs",
      "--no-terminal",
      "--allowed-tools",
      "",
      "--auth-policy",
      "fail",
      "--cwd",
      runDir,
      "--timeout",
      String(Math.max(1, Math.ceil(config.routerTimeoutMs / 1000))),
    ];
    if (config.routerModel) args.push("--model", config.routerModel);
    args.push(config.routerProviderId, "exec", prompt);

    const child = Bun.spawn([process.execPath, acpxCliPath(), ...args], {
      cwd: runDir,
      env: { ...process.env, REMOTE_AGENT_SUPPRESS_HOOKS: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Backstop for a wedged acpx; its own --timeout should fire first.
    const timer = setTimeout(() => child.kill(9), config.routerTimeoutMs + 5_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer));

    if (exitCode === 137 || exitCode === 9) {
      throw new RouterTimeoutError("session router timed out");
    }
    if (exitCode !== 0) {
      throw new Error(
        `session router exited ${exitCode}: ${boundedTail(stderr || stdout, 2_000)}`,
      );
    }

    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error(`session router returned no JSON: ${boundedTail(stdout, 500)}`);
    }
    return RouteDecisionSchema.parse(JSON.parse(stdout.slice(start, end + 1)));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
