import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
} from "../../../../types/dispatcher/index.ts";
import { forwardMessage } from "../../../services/messages/index.ts";
import { createBbClient } from "../../../transports/bb/index.ts";
import { composeSkill } from "../../../workflows/skills.ts";
import { buildReflectionMessage } from "./message.ts";

type ReflectionEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.LinearIssueReflectionRequested }
>;

export const reflectionWorker: Worker<ReflectionEvent> = {
  key: "product.reflection",
  supports(event): event is ReflectionEvent {
    return event.type === DispatchEventType.LinearIssueReflectionRequested;
  },
  execute(event, context) {
    const issue = event.webhook.data;
    return forwardMessage({
      config: context.config,
      bbClient: context.bbClient ?? createBbClient(context.config.bbBaseUrl),
      cubeIssueIdentifier: issue.identifier,
      workerContext: {
        key: "product.reflection",
        routingHint:
          "Prefer the Primary session whose current activity is reflection; otherwise prefer the only eligible Primary that worked on the CUBE issue.",
      },
      message: `Post a reflection for ${issue.identifier}, which entered ${issue.state?.name ?? context.config.reflectOnState}.`,
      finalizeMessage: async (target) => {
        // Composition reads definitions from this service checkout and writes the
        // generated skill into the selected session's local worktree. Like bb
        // delivery itself, this assumes the worktree is on the service's machine.
        const composed = await composeSkill({
          skillset: "reflect-linear",
          selection: {
            snippets: [],
            hooks: [],
            flags: [],
            allSnippets: true,
            allHooks: true,
          },
          root: target.runtime.worktreePath,
        });
        return buildReflectionMessage(
          target.runtime.harness,
          composed.skill,
          issue.identifier,
          issue.state?.name ?? context.config.reflectOnState,
        );
      },
    });
  },
};
