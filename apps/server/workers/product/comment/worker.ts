import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
} from "../../../../../types/dispatcher/index.ts";
import { fetchCommentContext } from "../../../integrations/linear/comment-context.ts";
import { forwardMessage } from "../../../services/messages/index.ts";
import {
  registerThread,
  resolveQuestionThread,
} from "../../../services/sessions/threads.ts";
import { buildCommentMessage, excerpt } from "./message.ts";

type CommentEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerCommentReceived }
>;

export interface CommentWorkerDependencies {
  forward: typeof forwardMessage;
  fetchContext: typeof fetchCommentContext;
}

export function createCommentWorker({
  forward = forwardMessage,
  fetchContext = fetchCommentContext,
}: Partial<CommentWorkerDependencies> = {}): Worker<CommentEvent> {
  return {
    key: "product.comment",
    supports(event): event is CommentEvent {
      return event.type === DispatchEventType.TrackerCommentReceived;
    },
    async execute(event, context) {
      const data = event.webhook.data;

      const commentContext = await fetchContext(
        context.config.linearApiKey,
        data.id,
      );
      const sourceIssueIdentifier =
        data.issue?.identifier ?? commentContext.sourceIssueIdentifier;
      if (!sourceIssueIdentifier) {
        return {
          status: "ignored",
          detail: "unresolved_source_issue",
          targetResourceId: null,
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

      const threadRootCommentId = data.parentId ?? data.id;
      const routedSessionId = event.routedSessionId ?? null;
      const answersQuestion = event.threadRelationship === "question";

      let message = buildCommentMessage(
        sourceIssueIdentifier,
        data.user?.name ?? null,
        data.body,
        {
          quotedText: commentContext.quotedText,
          parentBody: commentContext.parentBody,
          parentAuthor: commentContext.parentAuthor,
        },
      );
      if (answersQuestion) {
        message = `This answers your earlier question in this thread.

${message}`;
      }

      const result = await forward({
        requestId: `worker:${context.runId}`,
        config: context.config,
        prisma: context.prisma,
        agentRuntime: context.agentRuntime!,
        sourceIssueIdentifier,
        workerContext: {
          key: "product.comment",
          routingHint:
            "Prefer the Primary session whose current activity owns the Linear thread. Planning replies belong to the active planning or orchestrated-planning session; description-augmentation replies belong to the active describe-linear-issue session; otherwise prefer the only eligible Primary.",
        },
        replyContext,
        // Registered threads route deterministically; the semantic router is
        // only the fallback when the registered session is no longer an
        // eligible candidate (closed, role change).
        ...(routedSessionId
          ? {
              selectSession: async (config, input) => {
                const registered = input.candidates.find(
                  (candidate) => candidate.runtime.runtimeSessionId === routedSessionId,
                );
                if (registered) {
                  return {
                    targetResourceId: registered.agentIssueIdentifier,
                    reasonCode: "registered_thread" as const,
                    confidence: 1,
                    expectedActions: [],
                    replyToCommentId: null,
                  };
                }
                const { selectSessionWithRouter } = await import(
                  "../../../services/sessions/selection/index.ts"
                );
                return selectSessionWithRouter(config, input);
              },
            }
          : {}),
        message,
        ...(event.sourceMessageId ? { sourceMessageId: event.sourceMessageId, requestId: event.sourceMessageId } : {}),
      });

      // Keep the registry current: successful deliveries own their thread,
      // and an answered question thread becomes a plain conversation.
      if (result.status === "delivered" && result.targetResourceId) {
        await registerThread(context.prisma, {
          provider: "linear",
          connectionId: context.config.activeConnectionId,
          threadRootCommentId,
          runtimeSessionId: result.targetResourceId,
          relationship: "thread",
        }).catch(() => undefined);
        if (answersQuestion && routedSessionId) {
          await resolveQuestionThread(context.prisma, {
            provider: "linear",
            connectionId: context.config.activeConnectionId,
            threadRootCommentId,
            runtimeSessionId: routedSessionId,
          }).catch(() => undefined);
        }
      }

      if (event.sourceMessageId && result.status === "delivered") {
        await context.prisma.runtimeSourceMessage.update({ where: { id: event.sourceMessageId }, data: {
          requestedActions: result.decision?.expectedActions ?? [], projectionPending: true,
        } });
      } else if (event.sourceMessageId) {
        await context.prisma.runtimeSourceMessage.updateMany({ where: { id: event.sourceMessageId, state: "routing", sessionId: null }, data: {
          state: "unrouted", detail: result.detail, projectionPending: true,
          replyBody: "I couldn't identify an eligible owning session for this comment. No new task was started.",
        } });
      }

      return {
        status: result.status,
        detail: result.detail,
        targetResourceId: result.targetResourceId,
      };
    },
  };
}

export const commentWorker = createCommentWorker();
