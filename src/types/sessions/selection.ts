import { z } from "zod";

import type {
  RouteCandidate,
  RouteSourceIssue,
} from "./session.ts";

export const RouteActionSchema = z.enum([
  "reply",
  "plan_update",
  "code_change",
]);

export type RouteAction = z.infer<typeof RouteActionSchema>;

export interface ReplyTarget {
  commentId: string;
  kind: "source" | "thread_root";
  authorName: string | null;
  excerpt: string;
}

export interface RoutingInput {
  sourceIssueIdentifier: string;
  sourceIssue: RouteSourceIssue | null;
  comment: string;
  workerContext: {
    key: string;
    routingHint: string;
  };
  candidates: RouteCandidate[];
  replyTargets?: ReplyTarget[];
}

export const RouteReasonSchema = z.enum([
  "workflow_match",
  "primary_session",
  "only_eligible_candidate",
  "no_eligible_candidate",
  "ambiguous",
]);

export const RouteDecisionSchema = z.object({
  targetAgentIssueIdentifier: z.string().nullable(),
  reasonCode: RouteReasonSchema,
  confidence: z.number().min(0).max(1),
  expectedActions: z.array(RouteActionSchema).default([]),
  replyToCommentId: z.string().nullable().default(null),
});

export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
