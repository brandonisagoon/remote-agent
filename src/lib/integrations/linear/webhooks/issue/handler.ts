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
import { matchWorkflows } from "../../../../workflows/match.ts";
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
  if (!stateName) return { kind: IssueWebhookResultKind.Ignored };
  const matched = matchWorkflows({
    config,
    on: "issue.state-changed",
    fields: { "issue.state": stateName },
  });
  if (matched.length === 0) return { kind: IssueWebhookResultKind.Ignored };

  const receipt = await createWebhookReceipt(prisma, {
    webhookId: config.activeWebhookId,
    connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId,
    linearDeliveryId: deliveryId,
    eventType: "issue",
    trigger: matched.map((workflow) => workflow.id).join(","),
    sourceIssueIdentifier: data.identifier,
    sourceCommentId: null,
    status: "accepted",
  });
  if (!receipt) return { kind: IssueWebhookResultKind.Duplicate };
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
    kind: IssueWebhookResultKind.Triggered,
    workflowIds: matched.map((workflow) => workflow.id),
  };
}
