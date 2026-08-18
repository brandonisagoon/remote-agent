import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
} from "../../../../types/dispatcher/index.ts";
import {
  fetchCommentContext,
  Reaction,
  reactToComment,
} from "../../../integrations/linear/index.ts";
import { forwardMessage } from "../../../services/messages/index.ts";
import { createBbClient } from "../../../transports/bb/index.ts";
import { buildAgentMentionMessage, excerpt } from "./message.ts";
import { selectOutcomeReactions } from "./reactions.ts";

type MentionEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.LinearCommentMentioned }
>;

export interface AgentMentionWorkerDependencies {
  forward: typeof forwardMessage;
  fetchContext: typeof fetchCommentContext;
  react: typeof reactToComment;
}

export function createAgentMentionWorker({
  forward = forwardMessage,
  fetchContext = fetchCommentContext,
  react = reactToComment,
}: Partial<AgentMentionWorkerDependencies> = {}): Worker<MentionEvent> {
  return {
    key: "product.agent-mention",
    supports(event): event is MentionEvent {
      return event.type === DispatchEventType.LinearCommentMentioned;
    },
    async execute(event, context) {
      const data = event.webhook.data;

      // Re-deliveries are harmless: duplicate reactions are best-effort and the
      // Linear client intentionally swallows any duplicate-emoji rejection.
      await react(context.config.linearApiKey, data.id, Reaction.Received);

      const commentContext = await fetchContext(
        context.config.linearApiKey,
        data.id,
      );
      const cubeIssueIdentifier =
        data.issue?.identifier ?? commentContext.cubeIssueIdentifier;
      if (!cubeIssueIdentifier) {
        await react(
          context.config.linearApiKey,
          data.id,
          Reaction.Unrouted,
        );
        return {
          status: "ignored",
          detail: "unresolved_source_issue",
          targetAgentIssueIdentifier: null,
        };
      }

      const replyContext = data.parentId
        ? {
            threadRootCommentId: data.parentId,
            targets: [
              {
                commentId: data.id,
                kind: "source" as const,
                authorName: data.user?.name ?? null,
                excerpt: excerpt(data.body),
              },
              {
                commentId: data.parentId,
                kind: "thread_root" as const,
                authorName: commentContext.parentAuthor,
                excerpt: excerpt(commentContext.parentBody ?? ""),
              },
            ],
          }
        : {
            threadRootCommentId: data.id,
            targets: [
              {
                commentId: data.id,
                kind: "thread_root" as const,
                authorName: data.user?.name ?? null,
                excerpt: excerpt(data.body),
              },
            ],
          };

      const result = await forward({
        config: context.config,
        bbClient: context.bbClient ?? createBbClient(context.config.bbBaseUrl),
        cubeIssueIdentifier,
        workerContext: {
          key: "product.agent-mention",
          routingHint:
            "Prefer the Primary session whose current activity owns the Linear thread. Planning replies belong to the active planning or orchestrated-planning session; description-augmentation replies belong to the active describe-linear-issue session; otherwise prefer the only eligible Primary.",
        },
        replyContext,
        message: buildAgentMentionMessage(
          cubeIssueIdentifier,
          data.user?.name ?? null,
          data.body,
          {
            quotedText: commentContext.quotedText,
            parentBody: commentContext.parentBody,
            parentAuthor: commentContext.parentAuthor,
          },
        ),
      });

      for (const reaction of selectOutcomeReactions(result)) {
        await react(context.config.linearApiKey, data.id, reaction);
      }

      return {
        status: result.status,
        detail: result.detail,
        targetAgentIssueIdentifier: result.targetAgentIssueIdentifier,
      };
    },
  };
}

export const agentMentionWorker = createAgentMentionWorker();
