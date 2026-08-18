import { z } from "zod";

/**
 * Parsed before event-specific schemas so replay protection also applies to
 * event types the service intentionally ignores.
 */
export const LinearWebhookEnvelopeSchema = z.object({
  type: z.string(),
  action: z.string(),
  webhookTimestamp: z.number().int(),
});

export type LinearWebhookEnvelope = z.infer<typeof LinearWebhookEnvelopeSchema>;
