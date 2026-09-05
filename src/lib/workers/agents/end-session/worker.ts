import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../../types/dispatcher/index.ts";
import { isTerminalAgentIssueState } from "../../../../types/sessions/index.ts";
import { getMachine } from "../../../machines/index.ts";
import {
  endSessionGroup,
  terminateRuntimeSessions,
} from "../../../services/sessions/lifecycle/index.ts";
import { findAgentIssue } from "../../../services/sessions/lifecycle/agent-issue/queries/index.ts";

type EndSessionEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerIssueEndRequested }
>;

export const endSessionWorker: Worker<EndSessionEvent> = {
  key: "agents.end-session",
  supports(event): event is EndSessionEvent {
    return event.type === DispatchEventType.TrackerIssueEndRequested;
  },
  async execute(event, context) {
    const target = await findAgentIssue(context.config, {
      id: event.webhook.data.id,
    });
    if (!target) {
      return result("no_candidate", "agent_issue_not_found", null);
    }

    const machine = getMachine({ id: context.config.machine });
    if (!target.labels.nodes.some((label) => label.name === machine.label)) {
      return result("ignored", "different_machine", target.identifier);
    }

    if (
      target.state.name !== context.config.endOnState &&
      !isTerminalAgentIssueState(target.state.name)
    ) {
      return result("stale_target", "issue_left_end_state", target.identifier);
    }

    const group = await endSessionGroup(context.config, target);
    const terminated = await terminateRuntimeSessions(
      context.agentRuntime!,
      group.runtimeSessionIds,
    );
    return result(
      "delivered",
      `ended ${group.ended} issue(s); terminated ${terminated} acpx session(s)`,
      target.identifier,
    );
  },
};

function result(
  status: WorkerResult["status"],
  detail: string,
  targetAgentIssueIdentifier: string | null,
): WorkerResult {
  return { status, detail, targetAgentIssueIdentifier };
}
