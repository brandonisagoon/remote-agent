import type { ServerConfig } from "../../../config.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { BbEvent } from "../../../../types/runtime/index.ts";
import type { BbClient } from "../../../../types/runtime/index.ts";
import {
  createThreadedIssueComment,
  fetchIssueCommentBody,
  updateIssueComment,
} from "../../../integrations/linear/index.ts";
import { buildBbThreadOpenLink } from "../../../transports/bb/thread-link.ts";
import {
  AgentIssueState,
  type AgentIssueStateValue,
} from "../../../../types/sessions/index.ts";
import {
  agentIssueLabelIdsWithRouting,
  agentIssueRuntimeWithLabels,
  clearAgentIssueRecordErrorNotice,
  findAgentIssueRecordByBbThreadId,
  getAgentCatalog,
  getAgentStateId,
  parseAgentIssueRuntime,
  updateAgentIssue,
  getCubeIssue,
  parseAgentIssueSourceIdentifier,
  setAgentIssueRecordErrorNotice,
  setAgentIssueRecordSessionRoot,
} from "../registry/index.ts";
import { findAgentIssue } from "../lifecycle/agent-issue/queries/index.ts";
import { buildBbCheckpointComment } from "./checkpoints.ts";
import {
  buildBbErrorNotice,
  buildRecoveryAppendix,
  buildRepeatAppendix,
  buildSessionRootComment,
  isBbErrorEvent,
  RECOVERY_MARKER,
  type BbNoticeContext,
} from "./error-notices.ts";

export function agentIssueStateForBbEvent(
  event: BbEvent,
  lifecycle: "one-shot" | "persistent" | null | undefined,
): AgentIssueStateValue | null {
  if (event.type === "turn/completed") {
    const status = (event.data as { status?: unknown } | null)?.status;
    if (status === "failed") return AgentIssueState.Error;
    if (status === "interrupted") {
      return lifecycle === "one-shot"
        ? AgentIssueState.Ended
        : AgentIssueState.Disconnected;
    }
    return AgentIssueState.Connected;
  }
  if (
    event.type === "thread/started" ||
    event.type === "turn/started" ||
    event.type === "turn/input/accepted"
  ) {
    return AgentIssueState.Connected;
  }
  if (/failed|error/.test(event.type)) return AgentIssueState.Error;
  if (
    event.type === "system/thread/interrupted" ||
    /thread\/(stopped|ended|archived|deleted)/.test(event.type)
  ) {
    return lifecycle === "one-shot"
      ? AgentIssueState.Ended
      : AgentIssueState.Disconnected;
  }
  return null;
}

export function shouldProjectBbEvent(event: BbEvent): boolean {
  if (agentIssueStateForBbEvent(event, null)) return true;
  if (event.type !== "system/userQuestion/lifecycle") return false;
  return (event.data as { status?: unknown } | null)?.status === "pending";
}

export interface ProjectBbEventDependencies {
  bbClient?: BbClient;
  createComment?: typeof createThreadedIssueComment;
  updateComment?: typeof updateIssueComment;
  getCommentBody?: typeof fetchIssueCommentBody;
  findIssue?: typeof findAgentIssue;
  getIssue?: typeof getCubeIssue;
  updateIssue?: typeof updateAgentIssue;
  getCatalog?: typeof getAgentCatalog;
}

function completedTurnStatus(event: BbEvent): unknown {
  return event.type === "turn/completed"
    ? (event.data as { status?: unknown } | null)?.status
    : null;
}

function eventTurnId(event: BbEvent): string | null {
  return event.scope.kind === "turn" ? event.scope.turnId : null;
}

export async function projectBbEvent(
  config: ServerConfig,
  prisma: PrismaClient,
  event: BbEvent,
  dependencies: ProjectBbEventDependencies = {},
): Promise<void> {
  // bb emits token, output, reasoning, and tool deltas at high frequency. None
  // of them changes the Linear mirror, so reject them before any Linear read.
  // Without this guard every streamed delta consumed API quota even though it
  // produced no mutation or checkpoint.
  if (!shouldProjectBbEvent(event)) return;
  const record = await findAgentIssueRecordByBbThreadId(prisma, {
    bbThreadId: event.threadId,
  });
  if (!record) return;
  const issue = await (dependencies.findIssue ?? findAgentIssue)(config, {
    id: record.agentIssueId,
  });
  if (!issue) return;
  const parsed = parseAgentIssueRuntime(issue.description);
  const cubeIssueIdentifier = parseAgentIssueSourceIdentifier(
    issue.description,
  );
  const runtime = parsed ? agentIssueRuntimeWithLabels(issue, parsed) : null;
  const next = agentIssueStateForBbEvent(event, runtime?.lifecycle);
  if (next && issue.state.name !== next) {
    const catalog = await (dependencies.getCatalog ?? getAgentCatalog)(config);
    const routable =
      next === AgentIssueState.Connected &&
      runtime?.role === "primary" &&
      runtime.machine === config.machine;
    await (dependencies.updateIssue ?? updateAgentIssue)(
      config,
      { id: issue.id },
      {
        stateId: getAgentStateId(catalog, { name: next }),
        labelIds: agentIssueLabelIdsWithRouting(catalog, issue, routable),
      },
    );
  }

  if (!cubeIssueIdentifier) return;

  const errorEvent = isBbErrorEvent(event);
  if (errorEvent && record.lastErrorEventId === event.id) return;
  if (
    completedTurnStatus(event) === "failed" &&
    eventTurnId(event) !== null &&
    eventTurnId(event) === record.lastErrorTurnId
  ) {
    return;
  }

  const getCommentBody =
    dependencies.getCommentBody ?? fetchIssueCommentBody;
  const updateComment = dependencies.updateComment ?? updateIssueComment;
  if (
    completedTurnStatus(event) === "completed" &&
    record.lastErrorCommentId
  ) {
    const existingBody = await getCommentBody(
      config.linearApiKey,
      record.lastErrorCommentId,
    );
    if (existingBody && !existingBody.includes(RECOVERY_MARKER)) {
      const recovered = await updateComment(
        config.linearApiKey,
        record.lastErrorCommentId,
        existingBody +
          buildRecoveryAppendix({
            recoveredAtMs: event.createdAt,
            errorAt: record.lastErrorAt ?? new Date(event.createdAt),
          }),
      );
      if (!recovered) {
        throw new Error(
          `Failed to reconcile bb error ${record.lastErrorCommentId}`,
        );
      }
    }
    await clearAgentIssueRecordErrorNotice(prisma, {
      bbThreadId: event.threadId,
    });
  }

  const needsOutput =
    completedTurnStatus(event) === "completed";
  const output =
    needsOutput && dependencies.bbClient
      ? await dependencies.bbClient.getThreadOutput(event.threadId)
      : null;
  const threadLink = buildBbThreadOpenLink(config, event.threadId);
  const noticeContext: BbNoticeContext = {
    threadLink,
    machine: runtime?.machine ?? record.machine ?? config.machine,
    harness: runtime?.harness ?? "unknown",
  };
  const body = errorEvent
    ? buildBbErrorNotice(event, noticeContext)
    : buildBbCheckpointComment(event, output);
  if (!body) return;

  if (errorEvent && record.lastErrorCommentId) {
    const existingBody = await getCommentBody(
      config.linearApiKey,
      record.lastErrorCommentId,
    );
    if (existingBody) {
      const updated = await updateComment(
        config.linearApiKey,
        record.lastErrorCommentId,
        existingBody + buildRepeatAppendix(event, noticeContext),
      );
      if (!updated) {
        throw new Error(
          `Failed to fold bb error into ${record.lastErrorCommentId}`,
        );
      }
      await setAgentIssueRecordErrorNotice(prisma, {
        bbThreadId: event.threadId,
        lastErrorCommentId: record.lastErrorCommentId,
        lastErrorEventId: event.id,
        lastErrorTurnId: eventTurnId(event),
        lastErrorAt: new Date(event.createdAt),
      });
      return;
    }
    await clearAgentIssueRecordErrorNotice(prisma, {
      bbThreadId: event.threadId,
    });
  }

  const cubeIssue = await (dependencies.getIssue ?? getCubeIssue)(config, {
    id: cubeIssueIdentifier,
  });
  if (!cubeIssue) return;

  const createComment =
    dependencies.createComment ?? createThreadedIssueComment;
  const createRoot = async (): Promise<string> => {
    const [thread, options] = dependencies.bbClient
      ? await Promise.all([
          dependencies.bbClient.getThread(event.threadId),
          dependencies.bbClient.getThreadExecutionOptions(event.threadId),
        ])
      : [null, null];
    const root = await createComment(config.linearApiKey, {
      issueId: cubeIssue.id,
      body: buildSessionRootComment({
        ...noticeContext,
        provider: thread?.providerId ?? null,
        model: options?.model ?? null,
      }),
    });
    if (!root) {
      throw new Error(`Failed to create bb session root for ${event.threadId}`);
    }
    await setAgentIssueRecordSessionRoot(prisma, {
      bbThreadId: event.threadId,
      sessionRootCommentId: root.id,
    });
    return root.id;
  };

  let rootCommentId = record.sessionRootCommentId ?? (await createRoot());
  let posted = await createComment(config.linearApiKey, {
    issueId: cubeIssue.id,
    body,
    parentId: rootCommentId,
  });
  if (!posted) {
    rootCommentId = await createRoot();
    posted = await createComment(config.linearApiKey, {
      issueId: cubeIssue.id,
      body,
      parentId: rootCommentId,
    });
  }
  if (!posted) {
    throw new Error(`Failed to project bb event ${event.id} to Linear`);
  }
  if (errorEvent) {
    await setAgentIssueRecordErrorNotice(prisma, {
      bbThreadId: event.threadId,
      lastErrorCommentId: posted.id,
      lastErrorEventId: event.id,
      lastErrorTurnId: eventTurnId(event),
      lastErrorAt: new Date(event.createdAt),
    });
  }
}
