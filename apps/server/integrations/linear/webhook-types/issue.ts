import { z } from "zod";

export const LinearIssueWebhookSchema = z.object({
  type: z.literal("Issue"),
  action: z.literal("update"),
  webhookTimestamp: z.number().int(),
  organizationId: z.string().optional(),
  actor: z.object({ id: z.string() }).optional(),
  data: z.object({
    id: z.string(),
    identifier: z.string(),
    assigneeId: z.string().nullish(),
    state: z.object({ id: z.string().optional(), name: z.string(), type: z.string() }).nullish(),
    team: z.object({ key: z.string() }).nullish(),
  }),
  updatedFrom: z.object({ stateId: z.string().nullish() }).nullish(),
});

export const IssueWebhookResultKind = {
  Ignored: "ignored",
  Duplicate: "duplicate",
  Triggered: "triggered",
  Ending: "ending",
} as const;

export type IssueWebhookResultKindValue =
  (typeof IssueWebhookResultKind)[keyof typeof IssueWebhookResultKind];

export interface IssueWebhookResult {
  kind: IssueWebhookResultKindValue;
  /** IDs of the workflows this event triggered. */
  workflowIds?: string[];
}
export type LinearIssueWebhook = z.infer<typeof LinearIssueWebhookSchema>;
