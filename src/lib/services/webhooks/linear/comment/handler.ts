import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../config.ts";
import type { BbClient } from "../../../../../types/runtime/index.ts";
import { mentionsAgent } from "../../../../integrations/linear/index.ts";
import { bunCommandClient } from "../../../../transports/command/index.ts";
import { DispatchEventType } from "../../../../../types/dispatcher/index.ts";
import type { LinearCommentWebhook } from "../../../../../types/webhooks/linear/index.ts";
import { dispatchEvent } from "../../../dispatcher/index.ts";
import { createWebhookReceipt } from "../receipt-store.ts";

export type CommentWebhookResult =
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | {
      kind: "accepted";
      deliveryId: string;
      cubeIssueIdentifier: string | null;
    };

export async function handleCommentWebhook(input: {
  prisma: PrismaClient;
  config: ServerConfig;
  bbClient: BbClient;
  deliveryId: string;
  webhook: LinearCommentWebhook;
}): Promise<CommentWebhookResult> {
  const { prisma, config, bbClient, deliveryId, webhook } = input;
  const data = webhook.data;
  const authorId = data.userId ?? data.user?.id ?? null;
  const selfAuthored = authorId === config.agentUserId;
  const mentioned =
    !selfAuthored &&
    mentionsAgent(data.body, {
      agentUserId: config.agentUserId,
      agentHandle: config.agentHandle,
    });
  const detail = selfAuthored
    ? "self_authored"
    : mentioned
      ? null
      : "no_agent_mention";
  const receipt = await createWebhookReceipt(prisma, {
    linearDeliveryId: deliveryId,
    eventType: "comment",
    trigger: "mention",
    cubeIssueIdentifier: data.issue?.identifier ?? null,
    sourceCommentId: data.id,
    status: mentioned ? "accepted" : "ignored",
    detail,
  });
  if (!receipt) return { kind: "duplicate" };
  if (!mentioned) return { kind: "ignored", reason: detail! };

  void dispatchEvent({
    prisma,
    config,
    commandClient: bunCommandClient,
    bbClient,
    receiptId: receipt.id,
    event: { type: DispatchEventType.LinearCommentMentioned, webhook },
  });
  return {
    kind: "accepted",
    deliveryId,
    cubeIssueIdentifier: data.issue?.identifier ?? null,
  };
}
