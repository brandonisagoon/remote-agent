export class WebhookReceiptError extends Error {
  constructor(cause: unknown) {
    super("Failed to record Linear webhook receipt", { cause });
    this.name = "WebhookReceiptError";
  }
}
