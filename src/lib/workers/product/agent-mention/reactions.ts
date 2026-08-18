import type { MessageDispatchResult } from "../../../../types/messages/index.ts";
import { Reaction } from "../../../integrations/linear/index.ts";

export function selectOutcomeReactions(
  result: MessageDispatchResult,
): string[] {
  if (result.status === "delivered") {
    const reactions: string[] = [Reaction.Delivered];
    const actions = new Set(result.decision?.expectedActions ?? []);
    if (actions.has("reply")) reactions.push(Reaction.Reply);
    if (actions.has("plan_update")) reactions.push(Reaction.PlanUpdate);
    if (actions.has("code_change")) reactions.push(Reaction.CodeChange);
    return reactions;
  }

  if (
    result.status === "no_candidate" ||
    result.status === "ambiguous" ||
    result.status === "ignored"
  ) {
    return [Reaction.Unrouted];
  }

  return [Reaction.Failed];
}
