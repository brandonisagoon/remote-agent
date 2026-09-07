export const WebhookReceiptStatus = {
  Accepted: "accepted",
  Ignored: "ignored",
} as const;

export type WebhookReceiptStatusValue =
  (typeof WebhookReceiptStatus)[keyof typeof WebhookReceiptStatus];

/** "mention", "end", or a comma-joined list of triggered workflow IDs. */
export type LinearWebhookTrigger = string;
