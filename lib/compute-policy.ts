import { z } from "zod";

/** Application-environment admission, never an agent/provider turn limit.
 * Nothing is enabled by adding this optional configuration schema. */
export const ComputePolicy = z.object({
  enabled: z.boolean().default(false),
  slots: z.number().int().min(0).max(1000).default(0),
  quietPeriodSeconds: z.number().int().min(30).max(604800).default(1800),
  collectorFreshnessSeconds: z.number().int().min(2).max(300).default(15),
  deliveryTimeoutSeconds: z.number().int().min(5).max(300).default(30),
  startupTimeoutSeconds: z.number().int().min(30).max(3600).default(600),
  decisionApiKey: z.string().min(1).optional(),
  decisionModel: z.literal("gpt-6-luna").default("gpt-6-luna"),
}).strict();
export type ComputePolicy = z.infer<typeof ComputePolicy>;
export const COMPUTE_CLAIM_MS = 60_000;
