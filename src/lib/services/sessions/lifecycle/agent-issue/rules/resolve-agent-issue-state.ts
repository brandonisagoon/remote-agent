import {
  AgentIssueState,
  type AgentIssue,
  type AgentIssueStateValue,
  type RuntimeSessionEvent,
} from "../../../../../../types/sessions/index.ts";

export function resolveAgentIssueState(
  event: RuntimeSessionEvent,
  hasCompleteRuntime: boolean,
  existing: AgentIssue | null,
): AgentIssueStateValue {
  switch (event.type) {
    case "session.ended":
    case "subagent.ended":
      return AgentIssueState.Ended;
    case "session.disconnected":
      return AgentIssueState.Disconnected;
    case "workflow.started":
    case "workflow.ended":
      if (
        hasCompleteRuntime &&
        existing &&
        (existing.state.name === AgentIssueState.Error ||
          existing.state.name === AgentIssueState.Disconnected)
      ) {
        return AgentIssueState.Connected;
      }
      if (existing && existing.state.name !== AgentIssueState.Registered) {
        return existing.state.name;
      }
      break;
  }

  return hasCompleteRuntime ? AgentIssueState.Connected : AgentIssueState.Error;
}
