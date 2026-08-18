import { existsSync } from "node:fs";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../../types/dispatcher/index.ts";
import type { CubeIssueWithAgentIssues } from "../../../services/sessions/registry/index.ts";
import { getCubeIssueWithAgentIssues } from "../../../services/sessions/registry/index.ts";
import { Reaction, reactToIssue } from "../../../integrations/linear/index.ts";
import {
  composeSkill,
  skillInvocation,
  type ComposeOptions,
  type ComposeResult,
} from "../../../workflows/skills.ts";
import {
  DESCRIBE_AGENT_HARNESS,
  DESCRIBE_AGENT_MODEL,
  buildDescribeSessionName,
  describePaths,
} from "./launch.ts";
import { spawnAgentThread } from "../../../services/launches/index.ts";
import { productLabelSnippets } from "./product-labels.ts";

type DescribeEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.LinearIssueDescribeRequested }
>;

export interface DescribeWorkerDependencies {
  exists: (file: string) => boolean;
  getIssue: (
    config: Parameters<typeof getCubeIssueWithAgentIssues>[0],
    query: { id: string },
  ) => Promise<CubeIssueWithAgentIssues | null>;
  compose: (options: ComposeOptions) => Promise<ComposeResult>;
  react: typeof reactToIssue;
  launch?: typeof spawnAgentThread;
}

const defaultDependencies: DescribeWorkerDependencies = {
  exists: existsSync,
  getIssue: getCubeIssueWithAgentIssues,
  compose: composeSkill,
  react: reactToIssue,
};

function result(
  status: WorkerResult["status"],
  detail: string,
  targetAgentIssueIdentifier: string | null = null,
): WorkerResult {
  return { status, detail, targetAgentIssueIdentifier };
}

export function createDescribeWorker(
  dependencies: DescribeWorkerDependencies = defaultDependencies,
): Worker<DescribeEvent> {
  return {
    key: "product.describe",
    supports(event): event is DescribeEvent {
      return event.type === DispatchEventType.LinearIssueDescribeRequested;
    },
    async execute(event, context) {
      const paths = describePaths(context.config.workspaceRepoRoot);
      for (const file of [paths.promptFile]) {
        if (!dependencies.exists(file)) {
          return result("failed", `required describe file is missing: ${file}`);
        }
      }

      const data = event.webhook.data;
      const issueRef =
        data.issue?.identifier ?? data.issueId ?? data.issue?.id ?? null;
      if (!issueRef) return result("failed", "reaction has no issue reference");

      const issue = await dependencies.getIssue(context.config, {
        id: issueRef,
      });
      if (!issue) return result("failed", "cube issue not found");
      if (
        issue.identifier
          .toUpperCase()
          .startsWith(`${context.config.agentTeamKey.toUpperCase()}-`)
      ) {
        return result("ignored", "agent_team_issue");
      }

      let composed: ComposeResult;
      try {
        const snippets = productLabelSnippets(issue.labels.nodes);
        const allSnippets = snippets.length === 0;
        composed = await dependencies.compose({
          skillset: "describe-linear-issue",
          selection: {
            snippets,
            hooks: [],
            flags: [],
            allSnippets,
            allHooks: true,
          },
          root: context.config.workspaceRepoRoot,
        });
      } catch (error) {
        return result(
          "failed",
          `describe skill composition failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        !composed.compatibility.harnesses.includes(DESCRIBE_AGENT_HARNESS)
      ) {
        return result(
          "failed",
          `composed skill is incompatible with ${DESCRIBE_AGENT_HARNESS}: ${composed.skill}`,
        );
      }

      const prompt = `Use ${skillInvocation(DESCRIBE_AGENT_HARNESS, composed.skill)} to augment ${issue.identifier}.`;
      let launched: Awaited<ReturnType<typeof spawnAgentThread>>;
      try {
        launched = await (dependencies.launch ?? spawnAgentThread)({
          config: context.config,
          prisma: context.prisma,
          bbClient: context.bbClient!,
          machine: context.config.machine,
          worktreePath: context.config.workspaceRepoRoot,
          issueIdentifier: issue.identifier,
          harness: DESCRIBE_AGENT_HARNESS,
          model: DESCRIBE_AGENT_MODEL,
          lifecycle: "one-shot",
          role: "primary",
          title: buildDescribeSessionName(issue.identifier),
          prompt,
        });
      } catch (error) {
        return result(
          "failed",
          `bb launch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const reacted = await dependencies.react(
        context.config.linearApiKey,
        issue.id,
        Reaction.Describing,
      );
      return result(
        "delivered",
        `bb_thread:${launched.thread.id} started with ${composed.skill}; pencil reaction ${reacted ? "posted" : "failed"}`,
        issue.identifier,
      );
    },
  };
}

export const describeWorker = createDescribeWorker();
