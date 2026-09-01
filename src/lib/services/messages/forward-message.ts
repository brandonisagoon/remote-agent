import type { ServerConfig } from "../../config.ts";
import type { AgentSessionRuntime } from "../../../types/runtime/index.ts";
import type { MessageDispatchResult } from "../../../types/messages/index.ts";
import type {
  ReplyTarget,
  RouteCandidate,
  RouteDecision,
  RoutingInput,
} from "../../../types/sessions/index.ts";
import {
  fetchTrackerRoutingContext,
  fetchRouteCandidates,
  isEligibleCandidate,
  RouterTimeoutError,
  selectSessionWithCodex,
} from "../sessions/index.ts";
import { buildReplyDirective } from "./reply-directive.ts";

export interface ReplyContext {
  threadRootCommentId: string;
  targets: ReplyTarget[];
}

export interface ForwardMessageOptions {
  config: ServerConfig;
  agentRuntime: AgentSessionRuntime;
  sourceIssueIdentifier: string;
  message: string;
  workerContext: RoutingInput["workerContext"];
  replyContext?: ReplyContext;
  finalizeMessage?: (
    target: RouteCandidate,
  ) => string | Promise<string>;
  fetchCandidates?: (
    config: ServerConfig,
    sourceIssueIdentifier: string,
  ) => Promise<RouteCandidate[]>;
  selectSession?: (
    config: ServerConfig,
    input: RoutingInput,
  ) => Promise<RouteDecision>;
}

export async function forwardMessage(
  options: ForwardMessageOptions,
): Promise<MessageDispatchResult> {
  try {
    return await route(options);
  } catch (error) {
    return {
      status:
        error instanceof RouterTimeoutError ? "router_timeout" : "failed",
      detail: error instanceof Error ? error.message : String(error),
      targetAgentIssueIdentifier: null,
      decision: null,
    };
  }
}

async function route(
  options: ForwardMessageOptions,
): Promise<MessageDispatchResult> {
  const fetchCandidates = options.fetchCandidates ?? fetchRouteCandidates;
  const selectSession = options.selectSession ?? selectSessionWithCodex;
  const initial = options.fetchCandidates
    ? {
        sourceIssue: null,
        candidates: await options.fetchCandidates(
          options.config,
          options.sourceIssueIdentifier,
        ),
      }
    : await fetchTrackerRoutingContext(
        options.config,
        options.sourceIssueIdentifier,
      );
  const candidates = (initial?.candidates ?? []).filter((candidate) =>
    isEligibleCandidate(options.config, candidate),
  );
  if (candidates.length === 0) {
    return {
      status: "no_candidate",
      detail: "no eligible related Agents session",
      targetAgentIssueIdentifier: null,
      decision: null,
    };
  }
  const selectedDecision = await selectSession(options.config, {
    sourceIssueIdentifier: options.sourceIssueIdentifier,
    sourceIssue: initial?.sourceIssue ?? null,
    comment: options.message,
    workerContext: options.workerContext,
    candidates,
    replyTargets: options.replyContext?.targets,
  });
  const normalized = normalizeDecision(
    selectedDecision,
    options.replyContext,
  );
  const decision = normalized.decision;
  if (!decision.targetAgentIssueIdentifier) {
    return {
      status:
        decision.reasonCode === "ambiguous" ? "ambiguous" : "no_candidate",
      detail: decision.reasonCode,
      targetAgentIssueIdentifier: null,
      decision,
    };
  }
  const fresh = (await fetchCandidates(
    options.config,
    options.sourceIssueIdentifier,
  )).find(
    (candidate) =>
      candidate.agentIssueIdentifier === decision.targetAgentIssueIdentifier,
  );
  if (!fresh || !isEligibleCandidate(options.config, fresh)) {
    return {
      status: "rejected",
      detail: "router selected a candidate that failed post-selection validation",
      targetAgentIssueIdentifier: decision.targetAgentIssueIdentifier,
      decision,
    };
  }
  const runtimeSessionId = fresh.runtime.runtimeSessionId;
  const session = runtimeSessionId
    ? await options.agentRuntime.getSession(runtimeSessionId)
    : null;
  if (!session || session.status === "closed" || session.status === "error") {
    return {
      status: "stale_target",
      detail: "the registered acpx session is no longer live",
      targetAgentIssueIdentifier: fresh.agentIssueIdentifier,
      decision,
    };
  }
  const baseMessage = options.finalizeMessage
    ? await options.finalizeMessage(fresh)
    : options.message;
  const message = normalized.replyRequested && options.replyContext
    ? `${baseMessage}\n\n${buildReplyDirective(
        options.sourceIssueIdentifier,
        options.replyContext.threadRootCommentId,
      )}`
    : baseMessage;
  try {
    await options.agentRuntime.enqueue({
      sessionId: session.id,
      text: message,
    });
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      targetAgentIssueIdentifier: fresh.agentIssueIdentifier,
      decision,
    };
  }
  return {
    status: "delivered",
    detail: deliveredDetail(decision, normalized.replyDetail),
    targetAgentIssueIdentifier: fresh.agentIssueIdentifier,
    decision,
  };
}

function normalizeDecision(
  decision: RouteDecision,
  replyContext: ReplyContext | undefined,
): {
  decision: RouteDecision;
  replyRequested: boolean;
  replyDetail: string | null;
} {
  let expectedActions = [...new Set(decision.expectedActions ?? [])];
  let replyToCommentId = decision.replyToCommentId ?? null;

  if (!expectedActions.includes("reply")) {
    replyToCommentId = null;
  }

  if (!replyContext) {
    return {
      decision: { ...decision, expectedActions, replyToCommentId: null },
      replyRequested: false,
      replyDetail: null,
    };
  }

  if (expectedActions.includes("reply")) {
    const legalIds = new Set(
      replyContext.targets.map((target) => target.commentId),
    );
    if (!replyToCommentId || !legalIds.has(replyToCommentId)) {
      const rejectedId = replyToCommentId;
      expectedActions = expectedActions.filter(
        (action) => action !== "reply",
      );
      replyToCommentId = null;
      return {
        decision: { ...decision, expectedActions, replyToCommentId },
        replyRequested: false,
        replyDetail: rejectedId
          ? `reply_target_rejected:${rejectedId}`
          : null,
      };
    }

    return {
      decision: {
        ...decision,
        expectedActions,
        replyToCommentId: replyContext.threadRootCommentId,
      },
      replyRequested: true,
      replyDetail: `reply_to:${replyContext.threadRootCommentId}`,
    };
  }

  return {
    decision: { ...decision, expectedActions, replyToCommentId: null },
    replyRequested: false,
    replyDetail: null,
  };
}

function deliveredDetail(
  decision: RouteDecision,
  replyDetail: string | null,
): string | null {
  const parts: string[] = [];
  if (decision.expectedActions.length > 0) {
    parts.push(`actions:${decision.expectedActions.join(",")}`);
  }
  if (replyDetail) parts.push(replyDetail);
  return parts.length > 0 ? parts.join(" ") : null;
}
