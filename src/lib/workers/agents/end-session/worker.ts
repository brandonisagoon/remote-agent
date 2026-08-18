import type {
  DispatchEvent,
  Worker,
  WorkerResult,
} from "../../../../types/dispatcher/index.ts";
import { isTerminalAgentIssueState } from "../../../../types/sessions/index.ts";
import { getMachine } from "../../../machines/index.ts";
import { createBbClient } from "../../../transports/bb/index.ts";
import {
  endSessionGroup,
  terminateBbThreads,
} from "../../../services/sessions/lifecycle/index.ts";
import { findAgentIssue } from "../../../services/sessions/lifecycle/agent-issue/queries/index.ts";

type EndSessionEvent = Extract<
  DispatchEvent,
  { type: "linear.issue.end-requested" }
>;

export const endSessionWorker: Worker<EndSessionEvent> = {
  key: "agents.end-session",
  supports(event): event is EndSessionEvent {
    return event.type === "linear.issue.end-requested";
  },
  async execute(event, context) {
    const target = await findAgentIssue(context.config, {
      id: event.webhook.data.id,
    });
    if (!target) {
      return result("no_candidate", "agent_issue_not_found", null);
    }

    const machine = getMachine({ id: context.config.machine });
    if (!target.labels.nodes.some((label) => label.name === machine.linearLabel)) {
      return result("ignored", "different_machine", target.identifier);
    }

    if (
      target.state.name !== context.config.endOnState &&
      !isTerminalAgentIssueState(target.state.name)
    ) {
      return result("stale_target", "issue_left_end_state", target.identifier);
    }

    const group = await endSessionGroup(context.config, target);
    const terminated = await terminateBbThreads(
      context.bbClient ?? createBbClient(context.config.bbBaseUrl),
      group.bbThreadIds,
    );
    return result(
      "delivered",
      `ended ${group.ended} issue(s); terminated ${terminated} bb thread(s)`,
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
