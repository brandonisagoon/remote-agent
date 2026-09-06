import type { PrismaClient } from "../../../../generated/prisma/client.ts";

const UNIQUE_VIOLATION = "P2002";

export class WebhookReceiptError extends Error {
  constructor(cause: unknown) {
    super("Failed to record webhook receipt", { cause });
    this.name = "WebhookReceiptError";
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** Records one inbound webhook delivery. `deliveryId` is the provider's
    idempotency key (Linear delivery id, GitHub X-GitHub-Delivery, Slack
    event_id); a duplicate delivery returns null. `resourceId` names the
    container resource the event concerns and `commentId` the threadable
    item within it. */
export async function createWebhookReceipt(
  prisma: PrismaClient,
  input: {
    provider: string;
    deliveryId: string;
    eventType: string;
    trigger: string;
    resourceId: string | null;
    commentId: string | null;
    status: "accepted" | "ignored";
    detail?: string | null;
    webhookId: string;
    connectionId: string;
    repositoryId: string;
  },
) {
  try {
    return await prisma.webhookReceipt.create({ data: input });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw new WebhookReceiptError(error);
  }
}
