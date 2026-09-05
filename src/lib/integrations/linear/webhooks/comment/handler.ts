import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../config.ts";
import type { AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { mentionsAgent } from "../../index.ts";
import { bunCommandClient } from "../../../../transports/command/index.ts";
import { DispatchEventType } from "../../../../../types/dispatcher/index.ts";
import type { LinearCommentWebhook } from "../../webhook-types/index.ts";
import { dispatchEvent } from "../../../../services/dispatcher/index.ts";
import { findThreadSession } from "../../../../services/sessions/threads.ts";
import { createWebhookReceipt } from "../receipt-store.ts";

export type CommentWebhookResult =
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | {
      kind: "accepted";
      deliveryId: string;
      sourceIssueIdentifier: string | null;
    };

export async function handleCommentWebhook(input: {
  prisma: PrismaClient;
  config: ServerConfig;
  agentRuntime: AgentSessionRuntime;
  deliveryId: string;
  webhook: LinearCommentWebhook;
}): Promise<CommentWebhookResult> {
  const { prisma, config, agentRuntime, deliveryId, webhook } = input;
  const data = webhook.data;
  const authorId = data.userId ?? data.user?.id ?? null;
  const selfAuthored = authorId === config.agentUserId;
  const mentioned =
    !selfAuthored &&
    mentionsAgent(data.body, {
      agentUserId: config.agentUserId,
      agentHandle: config.agentHandle,
    });
  // Registered threads are conversations: replies deliver without a mention,
  // like replying to a person. Linear threads are single-level, so
  // parentId ?? id is the thread root.
  const threadRootCommentId = data.parentId ?? data.id;
  const registration = selfAuthored
    ? null
    : await findThreadSession(prisma, {
        provider: "linear",
        connectionId: config.activeConnectionId,
        threadRootCommentId,
      });
  const accepted = mentioned || registration !== null;
  const detail = selfAuthored
    ? "self_authored"
    : accepted
      ? null
      : "no_agent_mention";
  const receipt = await createWebhookReceipt(prisma, {
    webhookId: config.activeWebhookId,
    connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId,
    linearDeliveryId: deliveryId,
    eventType: "comment",
    trigger: mentioned ? "mention" : "thread",
    sourceIssueIdentifier: data.issue?.identifier ?? null,
    sourceCommentId: data.id,
    status: accepted ? "accepted" : "ignored",
    detail,
  });
  if (!receipt) return { kind: "duplicate" };
  if (!accepted) return { kind: "ignored", reason: detail! };

  void dispatchEvent({
    prisma,
    config,
    commandClient: bunCommandClient,
    agentRuntime,
    receiptId: receipt.id,
    event: {
      type: DispatchEventType.TrackerCommentMentioned,
      webhook,
      ...(registration
        ? {
            routedSessionId: registration.runtimeSessionId,
            threadRelationship: registration.relationship,
          }
        : {}),
    },
  });
  return {
    kind: "accepted",
    deliveryId,
    sourceIssueIdentifier: data.issue?.identifier ?? null,
  };
}
