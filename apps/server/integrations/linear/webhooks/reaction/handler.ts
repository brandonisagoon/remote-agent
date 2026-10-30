import type { PrismaClient } from "../../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../../../types/runtime/index.ts";
import { bunCommandClient } from "../../../../transports/command/index.ts";
import { DispatchEventType } from "../../../../../../types/dispatcher/index.ts";
import {
  ReactionWebhookResultKind,
  type LinearReactionWebhook,
  type ReactionWebhookResult,
} from "../../webhook-types/index.ts";
import { dispatchEvent } from "../../../../services/dispatcher/index.ts";
import { createWebhookReceipt } from "../../../../services/receipts/store.ts";
import { reactionEmojiTokens } from "./emoji.ts";
import { matchWorkflows } from "../../../../workflows/match.ts";
import { readDeliveryComment } from "../../comment-context.ts";
import { handleCommentWebhook } from "../comment/handler.ts";
import { deliverMessageControls } from "../../../../services/sessions/message-controls.ts";
import { validateSourceMessageOwner } from "../../message-delivery.ts";

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
  if (target === "comment" && authorId && authorId !== config.agentUserId) {
    const workflows = matchWorkflows({ config, on: "comment.reaction", fields: { "reaction.emoji": reactionEmojiTokens(data.emoji) } })
      .filter((workflow) => workflow.deliver === "steer-session");
    if (!workflows.length) return { kind: ReactionWebhookResultKind.Ignored, reason: "no_matching_workflow" };
    const authorized = config.webhooks[config.activeWebhookId]?.repositoryRouting[config.activeRepositoryId]?.when
      ?.some((condition) => condition["linear.userId"]?.includes(authorId));
    if (!authorized) return { kind: ReactionWebhookResultKind.Ignored, reason: "unauthorized_control" };
    const commentId = data.commentId ?? data.comment!.id;
    const comment = await readDeliveryComment(config.linearApiKey, commentId);
    if (!comment?.issue || comment.user?.id !== authorId) return { kind: ReactionWebhookResultKind.Ignored, reason: "unauthorized_comment" };
    const id = `linear-steer:${config.activeConnectionId}:${data.id}`;
    await prisma.$transaction(async (tx) => {
    const control = await tx.runtimeMessageControl.upsert({ where: { id }, update: {}, create: {
      id, provider: "linear", connectionId: config.activeConnectionId, repositoryId: config.activeRepositoryId,
      machineId: config.machine, commentId, authorId,
    } });
    if (control.authorId !== authorId || control.commentId !== commentId || control.repositoryId !== config.activeRepositoryId || control.machineId !== config.machine) throw new Error("Control identity changed");
    await createWebhookReceipt(tx as PrismaClient, { provider: "linear", webhookId: config.activeWebhookId,
      connectionId: config.activeConnectionId, repositoryId: config.activeRepositoryId, deliveryId,
      eventType: "reaction", trigger: workflows.map((workflow) => workflow.id).join(","), resourceId: comment.issue!.identifier,
      commentId, status: "accepted", detail: `control:${id}` });
    });
    // A control can precede the comment webhook. Canonical source identity and
    // the comment-content hash converge onto the same durable instruction.
    await handleCommentWebhook({ ...input, deliveryId: `control-source:${id}`, configuredControl: true, webhook: {
      type: "Comment", action: "create", webhookTimestamp: webhook.webhookTimestamp,
      data: { id: comment.id, body: comment.body, parentId: comment.parentId, userId: authorId, user: { id: authorId }, issue: comment.issue },
    } });
    await deliverMessageControls(prisma, agentRuntime, (message) => validateSourceMessageOwner(config, prisma, message));
    return { kind: ReactionWebhookResultKind.Triggered, workflowIds: workflows.map((workflow) => workflow.id) };
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
    provider: "linear",
    deliveryId,
    eventType: "reaction",
    trigger: matched.map((workflow) => workflow.id).join(","),
    resourceId: sourceIssueIdentifier,
    commentId: null,
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
