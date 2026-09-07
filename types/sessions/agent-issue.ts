import { z } from "zod";

export const AgentIssueState = {
  Registered: "Registered",
  Connected: "Connected",
  Disconnected: "Disconnected",
  End: "End",
  Ended: "Ended",
  Error: "Error",
  Duplicate: "Duplicate",
  Deleted: "Deleted",
} as const;

export const AgentIssueStateSchema = z.enum([
  AgentIssueState.Registered,
  AgentIssueState.Connected,
  AgentIssueState.Disconnected,
  AgentIssueState.End,
  AgentIssueState.Ended,
  AgentIssueState.Error,
  AgentIssueState.Duplicate,
  AgentIssueState.Deleted,
]);

export type AgentIssueStateValue = z.infer<typeof AgentIssueStateSchema>;

interface AgentIssueStateRules {
  terminal: boolean;
  reconcilable: boolean;
}

const AGENT_ISSUE_STATE_RULES = {
  [AgentIssueState.Registered]: {
    terminal: false,
    reconcilable: true,
  },
  [AgentIssueState.Connected]: {
    terminal: false,
    reconcilable: true,
  },
  [AgentIssueState.Disconnected]: {
    terminal: false,
    reconcilable: true,
  },
  [AgentIssueState.End]: {
    terminal: false,
    reconcilable: false,
  },
  [AgentIssueState.Ended]: {
    terminal: true,
    reconcilable: false,
  },
  [AgentIssueState.Error]: {
    terminal: false,
    reconcilable: true,
  },
  [AgentIssueState.Duplicate]: {
    terminal: true,
    reconcilable: false,
  },
  [AgentIssueState.Deleted]: {
    terminal: true,
    reconcilable: false,
  },
} satisfies Record<AgentIssueStateValue, AgentIssueStateRules>;

export function isTerminalAgentIssueState(
  state: AgentIssueStateValue,
): boolean {
  return AGENT_ISSUE_STATE_RULES[state].terminal;
}

export function isReconcilableAgentIssueState(
  state: AgentIssueStateValue,
): boolean {
  return AGENT_ISSUE_STATE_RULES[state].reconcilable;
}

export const AgentIssueLabelGroup = {
  Harness: "Harness",
  Role: "Role",
  Routing: "Routing",
  Machine: "Machine",
  Workflow: "Workflow",
} as const;

export const AgentIssueLabel = {
  Harness: {
    Claude: "Claude Code",
    Codex: "Codex",
  },
  Role: {
    Primary: "Primary",
    Delegate: "Delegate",
    Viewer: "Viewer",
    Unassigned: "Unassigned",
  },
  Routing: {
    AcceptsInput: "Accepts Linear Input",
    RejectsInput: "Does Not Accept Linear Input",
  },
  Workflow: {
    General: "General",
    DescribeLinearIssue: "describe-linear-issue",
    PlanLinear: "plan-linear",
    OrchestratePlanLinear: "orchestrate-plan-linear",
    ReflectLinear: "reflect-linear",
  },
} as const;

export type AgentIssueWorkflowLabel =
  (typeof AgentIssueLabel.Workflow)[keyof typeof AgentIssueLabel.Workflow];

export const LinearLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
});

export const AgentIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  team: z.object({
    id: z.string(),
    key: z.string(),
  }),
  assignee: z.object({ id: z.string() }).nullable(),
  state: z.object({
    id: z.string(),
    name: AgentIssueStateSchema,
    type: z.string(),
  }),
  labels: z.object({
    nodes: z.array(LinearLabelSchema),
  }),
});

export const CreateAgentIssueInputSchema = z.object({
  title: z.string(),
  description: z.string(),
  assigneeId: z.string(),
  stateId: z.string(),
  labelIds: z.array(z.string()),
  teamId: z.string(),
});

export const UpdateAgentIssueInputSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  assigneeId: z.string().optional(),
  stateId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

export const AgentCatalogSchema = z.object({
  teamId: z.string(),
  states: z.array(
    z.object({
      id: z.string(),
      name: AgentIssueStateSchema,
      type: z.string(),
    }),
  ),
  labels: z.array(LinearLabelSchema),
});

export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;
export type AgentIssue = z.infer<typeof AgentIssueSchema>;
export type CreateAgentIssueInput = z.infer<typeof CreateAgentIssueInputSchema>;
export type LinearLabel = z.infer<typeof LinearLabelSchema>;
export type UpdateAgentIssueInput = z.infer<typeof UpdateAgentIssueInputSchema>;
