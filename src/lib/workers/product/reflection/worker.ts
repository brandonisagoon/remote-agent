import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
} from "../../../../types/dispatcher/index.ts";
import { forwardMessage } from "../../../services/messages/index.ts";
import { createBbClient } from "../../../transports/bb/index.ts";
import { readWorkflowPrompt } from "../../../workflows/repository.ts";
import { buildReflectionMessage } from "./message.ts";

type ReflectionEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerIssueReflectionRequested }
>;

export const reflectionWorker: Worker<ReflectionEvent> = {
  key: "product.reflection",
  supports(event): event is ReflectionEvent {
    return event.type === DispatchEventType.TrackerIssueReflectionRequested;
  },
  execute(event, context) {
    const issue = event.webhook.data;
    return forwardMessage({
      config: context.config,
      bbClient: context.bbClient ?? createBbClient(context.config.bbBaseUrl),
      sourceIssueIdentifier: issue.identifier,
      workerContext: {
        key: "product.reflection",
        routingHint:
          "Prefer the Primary session whose current activity is reflection; otherwise prefer the only eligible Primary that worked on the source issue.",
      },
      message: `Post a reflection for ${issue.identifier}, which entered ${issue.state?.name ?? context.config.reflectOnState}.`,
      finalizeMessage: async (target) => {
        const prompt = readWorkflowPrompt(
          context.config.repository,
          "reflect",
          target.runtime.worktreePath,
        );
        return buildReflectionMessage(
          prompt,
          issue.identifier,
          issue.state?.name ?? context.config.reflectOnState,
        );
      },
    });
  },
};
