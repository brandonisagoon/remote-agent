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
import { matchesReactionEmoji } from "./emoji.ts";

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
  if (!matchesReactionEmoji(data.emoji, config.describeReactionEmoji)) {
    return {
      kind: ReactionWebhookResultKind.Ignored,
      reason: "emoji_mismatch",
    };
  }

  const sourceIssueIdentifier = data.issue?.identifier ?? null;
  const agentIssue = sourceIssueIdentifier
    ?.toUpperCase()
    .startsWith(`${config.agentTeamKey.toUpperCase()}-`);
  const receipt = await createWebhookReceipt(prisma, {
    linearDeliveryId: deliveryId,
    eventType: "reaction",
    trigger: "describe",
    sourceIssueIdentifier,
    sourceCommentId: null,
    status: agentIssue ? "ignored" : "accepted",
    detail: agentIssue ? "agent_team_issue" : null,
  });
  if (!receipt) return { kind: ReactionWebhookResultKind.Duplicate };
  if (agentIssue) {
    return {
      kind: ReactionWebhookResultKind.Ignored,
      reason: "agent_team_issue",
    };
  }

  void dispatchEvent({
    prisma,
    config,
    commandClient: bunCommandClient,
    agentRuntime,
    receiptId: receipt.id,
    event: {
      type: DispatchEventType.TrackerIssueDescribeRequested,
      webhook,
    },
  });
  return { kind: ReactionWebhookResultKind.Describing };
}
