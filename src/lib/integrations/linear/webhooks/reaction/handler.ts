import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../config.ts";
import type { AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { bunCommandClient } from "../../../../transports/command/index.ts";
import { DispatchEventType } from "../../../../../types/dispatcher/index.ts";
import {
  ReactionWebhookResultKind,
  type LinearReactionWebhook,
  type ReactionWebhookResult,
} from "../../webhook-types/index.ts";
import { dispatchEvent } from "../../../../services/dispatcher/index.ts";
import { createWebhookReceipt } from "../receipt-store.ts";
import { reactionEmojiTokens } from "./emoji.ts";
import { matchWorkflows } from "../../../../workflows/match.ts";

function reactionTarget(data: LinearReactionWebhook["data"]): string {
  if (data.commentId || data.comment) return "comment";
  if (data.issueId || data.issue) return "issue";
  return "unknown";
}

export async function handleReactionWebhook(input: {
  prisma: PrismaClient;
  config: ServerConfig;
  agentRuntime: AgentSessionRuntime;
  deliveryId: string;
  webhook: LinearReactionWebhook;
}): Promise<ReactionWebhookResult> {
  const { prisma, config, agentRuntime, deliveryId, webhook } = input;
  const data = webhook.data;
  const authorId = data.userId ?? data.user?.id ?? null;
  const target = reactionTarget(data);

  console.info(
    JSON.stringify({
      event: "linear_reaction_webhook",
      deliveryId,
      action: webhook.action,
      emoji: data.emoji,
      target,
      userId: authorId,
    }),
  );

  if (webhook.action !== "create") {
    return {
      kind: ReactionWebhookResultKind.Ignored,
      reason: "not_create",
    };
  }
  if (target !== "issue") {
    return {
      kind: ReactionWebhookResultKind.Ignored,
      reason: "comment_target",
    };
  }
  if (authorId === config.agentUserId) {
    return {
      kind: ReactionWebhookResultKind.Ignored,
      reason: "self_authored",
    };
  }
  const matched = matchWorkflows({
    config,
    on: "issue.reaction",
    fields: { "reaction.emoji": reactionEmojiTokens(data.emoji) },
  });
  if (matched.length === 0) {
    return {
      kind: ReactionWebhookResultKind.Ignored,
      reason: "no_matching_workflow",
    };
  }

  const sourceIssueIdentifier = data.issue?.identifier ?? null;
  const receipt = await createWebhookReceipt(prisma, {
    webhookId: config.activeWebhookId,
    connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId,
    linearDeliveryId: deliveryId,
    eventType: "reaction",
    trigger: matched.map((workflow) => workflow.id).join(","),
    sourceIssueIdentifier,
    sourceCommentId: null,
    status: "accepted",
    detail: null,
  });
  if (!receipt) return { kind: ReactionWebhookResultKind.Duplicate };

  for (const workflow of matched) {
    void dispatchEvent({
      prisma,
      config,
      commandClient: bunCommandClient,
      agentRuntime,
      receiptId: receipt.id,
      event: {
        type: DispatchEventType.TrackerWorkflowTriggered,
        webhook,
        workflowId: workflow.id,
      },
    });
  }
  return {
    kind: ReactionWebhookResultKind.Triggered,
    workflowIds: matched.map((workflow) => workflow.id),
  };
}
