import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { LinearWebhookTrigger } from "../../../../types/webhooks/linear/receipt.ts";
import { WebhookReceiptError } from "./errors.ts";

const UNIQUE_VIOLATION = "P2002";

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

export async function createWebhookReceipt(
  prisma: PrismaClient,
  input: {
    linearDeliveryId: string;
    eventType: "comment" | "issue" | "reaction";
    trigger: LinearWebhookTrigger;
    cubeIssueIdentifier: string | null;
    sourceCommentId: string | null;
    status: "accepted" | "ignored";
    detail?: string | null;
  },
) {
  try {
    return await prisma.linearWebhookReceipt.create({ data: input });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw new WebhookReceiptError(error);
  }
}
