import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../config.ts";
import type { AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { bunCommandClient } from "../../../../transports/command/index.ts";
import { DispatchEventType } from "../../../../../types/dispatcher/index.ts";
import {
  IssueWebhookResultKind,
  type IssueWebhookResult,
  type LinearIssueWebhook,
} from "../../webhook-types/index.ts";
import { dispatchEvent } from "../../../../services/dispatcher/index.ts";
import { createWebhookReceipt } from "../receipt-store.ts";

export type { IssueWebhookResult } from "../../webhook-types/index.ts";

export async function handleIssueWebhook(input: {
  prisma: PrismaClient;
  config: ServerConfig;
  agentRuntime: AgentSessionRuntime;
  deliveryId: string;
  webhook: LinearIssueWebhook;
}): Promise<IssueWebhookResult> {
  const { prisma, config, agentRuntime, deliveryId, webhook } = input;
  const data = webhook.data;
  if (!webhook.updatedFrom?.stateId) {
    return { kind: IssueWebhookResultKind.Ignored };
  }

  const stateName = data.state?.name;
  const trigger =
    stateName === config.reflectOnState
      ? "reflection"
      : stateName === config.orchestrateOnState
        ? "orchestration"
        : null;
  if (!trigger) return { kind: IssueWebhookResultKind.Ignored };

  const receipt = await createWebhookReceipt(prisma, {
    webhookId: config.activeWebhookId,
    connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId,
    linearDeliveryId: deliveryId,
    eventType: "issue",
    trigger,
    sourceIssueIdentifier: data.identifier,
    sourceCommentId: null,
    status: "accepted",
  });
  if (!receipt) return { kind: IssueWebhookResultKind.Duplicate };
  void dispatchEvent({
    prisma,
    config,
    commandClient: bunCommandClient,
    agentRuntime,
    receiptId: receipt.id,
    event: {
      type:
        trigger === "reflection"
          ? DispatchEventType.TrackerIssueReflectionRequested
          : DispatchEventType.TrackerIssueOrchestrationRequested,
      webhook,
    },
  });
  return {
    kind:
      trigger === "reflection"
        ? IssueWebhookResultKind.Reflecting
        : IssueWebhookResultKind.Orchestrating,
  };
}
