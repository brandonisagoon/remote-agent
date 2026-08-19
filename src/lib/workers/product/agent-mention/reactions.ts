import type { MessageDispatchResult } from "../../../../types/messages/index.ts";
import { TrackerReaction } from "../../../integrations/tracker/index.ts";

export function selectOutcomeReactions(
  result: MessageDispatchResult,
): string[] {
  if (result.status === "delivered") {
    const reactions: string[] = [TrackerReaction.Delivered];
    const actions = new Set(result.decision?.expectedActions ?? []);
    if (actions.has("reply")) reactions.push(TrackerReaction.Reply);
    if (actions.has("plan_update")) reactions.push(TrackerReaction.PlanUpdate);
    if (actions.has("code_change")) reactions.push(TrackerReaction.CodeChange);
    return reactions;
  }

  if (
    result.status === "no_candidate" ||
    result.status === "ambiguous" ||
    result.status === "ignored"
  ) {
    return [TrackerReaction.Unrouted];
  }

  return [TrackerReaction.Failed];
}
