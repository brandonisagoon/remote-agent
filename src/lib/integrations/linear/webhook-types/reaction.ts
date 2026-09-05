import { z } from "zod";

const LinearReactionUserSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});

const LinearReactionIssueSchema = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string().optional(),
});

const LinearReactionCommentSchema = z.object({
  id: z.string(),
});

export const LinearReactionWebhookSchema = z.object({
  type: z.literal("Reaction"),
  action: z.string(),
  webhookTimestamp: z.number().int(),
  data: z.object({
    id: z.string(),
    emoji: z.string(),
    userId: z.string().nullish(),
    user: LinearReactionUserSchema.nullish(),
    issueId: z.string().nullish(),
    issue: LinearReactionIssueSchema.nullish(),
    commentId: z.string().nullish(),
    comment: LinearReactionCommentSchema.nullish(),
  }),
});

export const ReactionWebhookResultKind = {
  Ignored: "ignored",
  Duplicate: "duplicate",
  Triggered: "triggered",
} as const;

export type ReactionWebhookResult =
  | {
      kind: typeof ReactionWebhookResultKind.Ignored;
      reason: string;
    }
  | { kind: typeof ReactionWebhookResultKind.Duplicate }
  | { kind: typeof ReactionWebhookResultKind.Triggered; workflowIds: string[] };

export type LinearReactionWebhook = z.infer<
  typeof LinearReactionWebhookSchema
>;
