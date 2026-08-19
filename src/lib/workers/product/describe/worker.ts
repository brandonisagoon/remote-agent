import { existsSync, readFileSync } from "node:fs";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../../types/dispatcher/index.ts";
import { TrackerReaction, reactToIssue } from "../../../integrations/tracker/index.ts";
import { spawnAgentThread } from "../../../services/launches/index.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/tracker/index.ts";
import { getSourceIssueWithAgentIssues } from "../../../integrations/tracker/index.ts";
import {
  renderWorkflowPrompt,
  workflowPromptPath,
} from "../../../workflows/repository.ts";
import { buildDescribeSessionName } from "./launch.ts";

type DescribeEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerIssueDescribeRequested }
>;

export interface DescribeWorkerDependencies {
  exists: (file: string) => boolean;
  readPrompt: (file: string) => string;
  getIssue: (
    config: Parameters<typeof getSourceIssueWithAgentIssues>[0],
    query: { id: string },
  ) => Promise<SourceIssueWithAgentIssues | null>;
  react: typeof reactToIssue;
  launch?: typeof spawnAgentThread;
}

const defaultDependencies: DescribeWorkerDependencies = {
  exists: existsSync,
  readPrompt: (file) => readFileSync(file, "utf8").trim(),
  getIssue: getSourceIssueWithAgentIssues,
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
      return event.type === DispatchEventType.TrackerIssueDescribeRequested;
    },
    async execute(event, context) {
      const repository = context.config.repository;
      const workflow = repository.workflows.describe;
      const promptFile = workflowPromptPath(repository, "describe");
      if (!dependencies.exists(promptFile)) {
        return result("failed", `required describe prompt is missing: ${promptFile}`);
      }

      const data = event.webhook.data;
      const issueRef =
        data.issue?.identifier ?? data.issueId ?? data.issue?.id ?? null;
      if (!issueRef) return result("failed", "reaction has no issue reference");

      const issue = await dependencies.getIssue(context.config, { id: issueRef });
      if (!issue) return result("failed", "source issue not found");
      if (
        issue.identifier
          .toUpperCase()
          .startsWith(`${context.config.agentTeamKey.toUpperCase()}-`)
      ) {
        return result("ignored", "agent_team_issue");
      }

      const sourcePrompt = dependencies.readPrompt(promptFile).trim();
      if (!sourcePrompt) return result("failed", "describe workflow prompt is empty");
      const prompt = renderWorkflowPrompt(sourcePrompt, {
        sourceIssueIdentifier: issue.identifier,
        sourceIssueTitle: issue.title,
        sourceIssueLabels: issue.labels.nodes.map((label) => label.name).join(", "),
      });

      let launched: Awaited<ReturnType<typeof spawnAgentThread>>;
      try {
        launched = await (dependencies.launch ?? spawnAgentThread)({
          config: context.config,
          prisma: context.prisma as PrismaClient,
          bbClient: context.bbClient!,
          machine: context.config.machine,
          worktreePath: repository.root,
          issueIdentifier: issue.identifier,
          harness: workflow.harness,
          ...(workflow.model ? { model: workflow.model } : {}),
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
        TrackerReaction.Describing,
      );
      return result(
        "delivered",
        `bb_thread:${launched.thread.id} started from ${promptFile}; pencil reaction ${reacted ? "posted" : "failed"}`,
        issue.identifier,
      );
    },
  };
}

export const describeWorker = createDescribeWorker();
