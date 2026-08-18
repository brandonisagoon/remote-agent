export const WebhookReceiptStatus = {
  Accepted: "accepted",
  Ignored: "ignored",
} as const;

export type WebhookReceiptStatusValue =
  (typeof WebhookReceiptStatus)[keyof typeof WebhookReceiptStatus];

export type LinearWebhookTrigger =
  | "mention"
  | "reflection"
  | "orchestration"
  | "describe"
  | "end";
