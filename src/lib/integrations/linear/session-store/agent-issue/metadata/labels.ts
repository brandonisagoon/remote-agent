import { getMachine, getMachines } from "../../../../../machines/index.ts";
import {
  AgentIssueLabel,
  AgentIssueLabelGroup,
  type AgentIssueWorkflowLabel,
  type AgentCatalog,
  type AgentIssue,
  type RuntimeSessionEvent,
  type Workflow,
} from "../../../../../../types/sessions/index.ts";

const MANAGED_GROUPS = new Set<string>(Object.values(AgentIssueLabelGroup));
const WORKFLOW_LABELS = new Set<string>(
  Object.values(AgentIssueLabel.Workflow),
);
const LABEL_GROUP_BY_NAME = new Map<string, string>([
  [AgentIssueLabel.Harness.Claude, AgentIssueLabelGroup.Harness],
  [AgentIssueLabel.Harness.Codex, AgentIssueLabelGroup.Harness],
  [AgentIssueLabel.Role.Primary, AgentIssueLabelGroup.Role],
  [AgentIssueLabel.Role.Delegate, AgentIssueLabelGroup.Role],
  [AgentIssueLabel.Role.Viewer, AgentIssueLabelGroup.Role],
  [AgentIssueLabel.Role.Unassigned, AgentIssueLabelGroup.Role],
  [AgentIssueLabel.Routing.AcceptsInput, AgentIssueLabelGroup.Routing],
  [AgentIssueLabel.Routing.RejectsInput, AgentIssueLabelGroup.Routing],
  [AgentIssueLabel.Workflow.General, AgentIssueLabelGroup.Workflow],
  [AgentIssueLabel.Workflow.DescribeLinearIssue, AgentIssueLabelGroup.Workflow],
  [AgentIssueLabel.Workflow.PlanLinear, AgentIssueLabelGroup.Workflow],
  [
    AgentIssueLabel.Workflow.OrchestratePlanLinear,
    AgentIssueLabelGroup.Workflow,
  ],
  [AgentIssueLabel.Workflow.ReflectLinear, AgentIssueLabelGroup.Workflow],
]);

function labelId(catalogValue: AgentCatalog, name: string): string {
  const expectedGroup =
    LABEL_GROUP_BY_NAME.get(name) ??
    (getMachines().some((machine) => machine.label === name)
      ? AgentIssueLabelGroup.Machine
      : undefined);
  const label = catalogValue.labels.find(
    (entry) =>
      entry.name === name &&
      (!expectedGroup || entry.parent?.name === expectedGroup),
  );
  if (!label) {
    throw new Error(
      `Agents label ${expectedGroup ? `${expectedGroup} / ` : ""}${name} was not found`,
    );
  }
  return label.id;
}

export function desiredAgentIssueLabelNames(
  event: RuntimeSessionEvent,
  existing: AgentIssue | null,
  connected: boolean,
): string[] {
  const runtime = event.runtime;
  const machine = getMachine({ id: runtime.machine });
  const names = [
    runtime.harness === "claude"
      ? AgentIssueLabel.Harness.Claude
      : AgentIssueLabel.Harness.Codex,
    runtime.role === "delegate"
      ? AgentIssueLabel.Role.Delegate
      : runtime.role === "viewer"
        ? AgentIssueLabel.Role.Viewer
        : runtime.role === "unassigned"
          ? AgentIssueLabel.Role.Unassigned
          : AgentIssueLabel.Role.Primary,
    machine.label,
    connected && machine.acceptsTrackerInput && runtime.role === "primary"
      ? AgentIssueLabel.Routing.AcceptsInput
      : AgentIssueLabel.Routing.RejectsInput,
  ];

  names.push(
    workflowLabelForEvent(
      event,
      existing?.labels.nodes.map((label) => label.name) ?? [],
    ),
  );
  return names;
}

export function workflowLabelForEvent(
  event:
    | {
        type: "workflow.started" | "workflow.ended";
        workflow: Workflow;
      }
    | {
        type: Exclude<
          RuntimeSessionEvent["type"],
          "workflow.started" | "workflow.ended"
        >;
      },
  existingLabelNames: string[],
): AgentIssueWorkflowLabel {
  const existingWorkflows = existingLabelNames.filter((name) =>
    WORKFLOW_LABELS.has(name),
  );
  const current =
    existingWorkflows.length === 1
      ? (existingWorkflows[0] as AgentIssueWorkflowLabel)
      : AgentIssueLabel.Workflow.General;

  if (event.type === "workflow.started") {
    return event.workflow;
  }
  if (event.type === "workflow.ended" && current === event.workflow) {
    return AgentIssueLabel.Workflow.General;
  }
  return current;
}

export function mergeAgentIssueLabelIds(
  catalogValue: AgentCatalog,
  existing: AgentIssue | null,
  desiredNames: string[],
): string[] {
  const unmanaged =
    existing?.labels.nodes.filter(
      (label) => !label.parent || !MANAGED_GROUPS.has(label.parent.name),
    ) ?? [];
  return [
    ...unmanaged.map((label) => label.id),
    ...desiredNames.map((name) => labelId(catalogValue, name)),
  ];
}

export function agentIssueLabelIdsWithRouting(
  catalogValue: AgentCatalog,
  issue: AgentIssue,
  acceptsInput: boolean,
): string[] {
  return [
    ...issue.labels.nodes
      .filter((label) => label.parent?.name !== AgentIssueLabelGroup.Routing)
      .map((label) => label.id),
    labelId(
      catalogValue,
      acceptsInput
        ? AgentIssueLabel.Routing.AcceptsInput
        : AgentIssueLabel.Routing.RejectsInput,
    ),
  ];
}
