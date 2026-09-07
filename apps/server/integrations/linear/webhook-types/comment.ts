import { z } from "zod";

const LinearUserSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
});

const LinearIssueRefSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string().optional(),
  branchName: z.string().optional(),
  assigneeId: z.string().nullish(),
});

export const LinearCommentWebhookSchema = z.object({
  type: z.literal("Comment"),
  action: z.enum(["create", "update"]),
  webhookTimestamp: z.number().int(),
  organizationId: z.string().optional(),
  url: z.string().optional(),
  data: z.object({
    id: z.string(),
    body: z.string(),
    issueId: z.string().optional(),
    parentId: z.string().nullish(),
    userId: z.string().nullish(),
    user: LinearUserSchema.nullish(),
    issue: LinearIssueRefSchema.nullish(),
  }),
});

export type LinearCommentWebhook = z.infer<typeof LinearCommentWebhookSchema>;
