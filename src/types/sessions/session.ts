import { z } from "zod";

import { MachineSchema } from "../../lib/machines/index.ts";
import { AgentIssueLabel, type AgentIssueStateValue } from "./agent-issue.ts";

export { MachineSchema } from "../../lib/machines/index.ts";
export type { Machine } from "../../lib/machines/index.ts";

export const HarnessSchema = z.enum(["codex", "claude"]);
export const SessionRoleSchema = z.enum([
  "primary",
  "delegate",
  "viewer",
  "unassigned",
]);
export const SessionLifecycleSchema = z.enum(["one-shot", "persistent"]);
export const SourceIssueIdentifierSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*-\d+$/);
export const WorkflowSchema = z.enum([
  AgentIssueLabel.Workflow.DescribeLinearIssue,
  AgentIssueLabel.Workflow.PlanLinear,
  AgentIssueLabel.Workflow.OrchestratePlanLinear,
  AgentIssueLabel.Workflow.ReflectLinear,
]);

const RuntimeSchema = z.object({
  harnessSessionId: z.string().min(1).max(256),
  parentSessionId: z.string().min(1).max(256).nullish(),
  worktreePath: z.string().min(1).max(4096),
  branchName: z.string().min(1).max(512).nullish(),
  harness: HarnessSchema,
  machine: MachineSchema,
  role: SessionRoleSchema.default("primary"),
  lifecycle: SessionLifecycleSchema.nullish(),
  sourceIssueIdentifier: SourceIssueIdentifierSchema.nullish(),
  bbThreadId: z.string().min(1).max(256).nullish(),
});

const EventBaseSchema = z.object({
  eventId: z.string().min(1).max(256),
  occurredAt: z.string().datetime(),
  generation: z.number().int().nonnegative(),
});

export const SessionLifecycleEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.enum([
      "session.started",
      "session.disconnected",
      "session.ended",
      "subagent.started",
      "subagent.ended",
      "runtime.refresh",
    ]),
    runtime: RuntimeSchema,
  }),
  EventBaseSchema.extend({
    type: z.enum(["workflow.started", "workflow.ended"]),
    runtime: RuntimeSchema,
    workflow: WorkflowSchema,
    sourceIssueIdentifier: SourceIssueIdentifierSchema.nullish(),
  }),
  EventBaseSchema.extend({
    type: z.literal("worktree.ended"),
    locator: z.object({
      machine: MachineSchema,
      worktreePath: z.string().min(1).max(4096),
    }),
  }),
]);

export type SessionLifecycleEvent = z.infer<typeof SessionLifecycleEventSchema>;
export type SessionLifecycle = z.infer<typeof SessionLifecycleSchema>;
export type SessionRole = z.infer<typeof SessionRoleSchema>;
export type SessionRuntime = z.infer<typeof RuntimeSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

export interface AgentIssueSyncMetadata {
  eventId: string;
  generation: number;
  occurredAt: string;
  sourceIssueIdentifier: string | null;
}

export interface RouteCandidate {
  agentIssueId: string;
  agentIssueIdentifier: string;
  status: AgentIssueStateValue;
  assigneeId: string | null;
  labels: string[];
  runtime: SessionRuntime;
}

export interface RouteSourceIssue {
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  labels: string[];
}

export interface TrackerRoutingContext {
  sourceIssue: RouteSourceIssue;
  candidates: RouteCandidate[];
}

export type RuntimeSessionEvent = Exclude<
  SessionLifecycleEvent,
  { type: "worktree.ended" }
>;

export type MachineSnapshot = never;
