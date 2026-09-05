import type { ServerConfig, WorkflowConfig } from "../config.ts";

export type WorkflowEventKind = WorkflowConfig["on"];

/** Event payloads flatten into a field bag the conditions match against;
    multi-valued fields (labels) contribute every value. */
export type WorkflowEventFields = Record<string, string | string[] | undefined>;

function matchesCondition(
  condition: Record<string, string[]>,
  fields: WorkflowEventFields,
): boolean {
  return Object.entries(condition).every(([key, allowed]) => {
    const value = fields[key];
    if (value === undefined) return false;
    const values = Array.isArray(value) ? value : [value];
    return values.some((candidate) => allowed.includes(candidate));
  });
}

/** OR of AND-groups — identical semantics to connection repository routing. */
export function matchesConditions(
  when: ReadonlyArray<Record<string, string[]>> | null,
  fields: WorkflowEventFields,
): boolean {
  if (!when || when.length === 0) return true;
  return when.some((condition) => matchesCondition(condition, fields));
}

/** All workflows of the scoped repository whose trigger matches the event.
    Several may match; each gets its own dispatch. */
export function matchWorkflows(input: {
  config: ServerConfig;
  on: WorkflowEventKind;
  fields: WorkflowEventFields;
}): WorkflowConfig[] {
  const { config, on, fields } = input;
  return Object.values(config.repository.workflows).filter((workflow) => {
    if (workflow.on !== on) return false;
    if (workflow.connectionId && workflow.connectionId !== config.activeConnectionId) {
      return false;
    }
    return matchesConditions(workflow.when, fields);
  });
}
