import { nativeReportIngress } from "../../../../services/sessions/source-message-publication.ts";
import type { PrismaClient } from "../../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../../../types/runtime/index.ts";
import { bunCommandClient } from "../../../../transports/command/index.ts";
import { DispatchEventType } from "../../../../../../types/dispatcher/index.ts";
import type { LinearCommentWebhook } from "../../webhook-types/index.ts";
import { dispatchEvent } from "../../../../services/dispatcher/index.ts";
import { findThreadSession } from "../../../../services/sessions/threads.ts";
import { createWebhookReceipt } from "../../../../services/receipts/store.ts";
import { deliverInstructions, queueInstruction } from "../../../../services/sessions/inbox.ts";
import { getIssueWorkGraph } from "../../session-store/source-issue/work-graph.ts";
import { getSourceIssueParent } from "../../session-store/source-issue/read.ts";
import { withToolingInstructions } from "../../../../../../lib/skills/compose.ts";
import { matchWorkflows } from "../../../../workflows/match.ts";
import { recordSourceMessage, sourceMessageId, type SourceMessageInput } from "../../../../services/sessions/source-messages.ts";
import { readDeliveryComment } from "../../comment-context.ts";

function messageSource(config: ServerConfig, webhook: LinearCommentWebhook) {
  const data = webhook.data;
  return { provider: "linear", connectionId: config.activeConnectionId, repositoryId: config.activeRepositoryId,
    machineId: config.machine, resourceId: data.issue!.id, resourceIdentifier: data.issue!.identifier,
    commentId: data.id, threadRootId: data.parentId ?? data.id, authorId: data.userId ?? data.user!.id,
    body: data.body, presentation: config.repository.conversationReactions ?? {} };
}

/** A subscription without an explicit actor is not owner authorization. The
 * ingress has already checked the complete subscription before this handler. */
function isSubscribedOwner(config: ServerConfig, authorId: string | null): boolean {
  return Boolean(authorId && config.webhooks[config.activeWebhookId]?.repositoryRouting[config.activeRepositoryId]?.when
    ?.some((condition) => condition["linear.userId"]?.includes(authorId)));
}

async function sourcePrimary(prisma: PrismaClient, config: ServerConfig, identifier: string) {
  const tasks = await prisma.remoteTask.findMany({ where: {
    issueIdentifier: identifier, connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine,
  } });
  const candidates = [];
  for (const task of tasks) {
    if (task.phase === "closed" || !task.primarySessionId) continue;
    const session = await prisma.runtimeSession.findFirst({ where: {
      id: task.primarySessionId!, role: "primary", status: { not: "closed" },
      repositoryId: task.repositoryId, machineId: task.machineId, cwd: task.worktreePath ?? "",
      resourceLinks: { some: { provider: "linear", connectionId: config.activeConnectionId,
        resourceType: "issue-identifier", relationship: "handles", externalId: identifier, endedAt: null } },
    } });
    if (session) candidates.push(session);
  }
  return { primary: candidates.length === 1 ? candidates[0]! : null,
    reason: candidates.length > 1 ? "ambiguous_source_primary" : tasks.length ? "source_primary_unavailable" : null };
}

async function childPrimary(prisma: PrismaClient, config: ServerConfig, identifier: string) {
  const links = await prisma.runtimeSessionResourceLink.findMany({ where: {
    provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier",
    relationship: "child", externalId: identifier,
  } });
  const candidates = [];
  for (const link of links) {
    if (link.endedAt) continue;
    const task = await prisma.remoteTask.findUnique({ where: { primarySessionId: link.runtimeSessionId } });
    if (!task?.issueIdentifier || task.connectionId !== config.activeConnectionId || task.repositoryId !== config.activeRepositoryId || task.machineId !== config.machine || task.phase === "closed") continue;
    const ownership = await sourcePrimary(prisma, config, task.issueIdentifier);
    if (ownership.primary?.id === link.runtimeSessionId) candidates.push({ primary: ownership.primary, parentIdentifier: task.issueIdentifier });
  }
  return { owner: candidates.length === 1 ? candidates[0]! : null,
    reason: candidates.length > 1 ? "ambiguous_child_primary" : links.length ? "child_primary_unavailable" : null };
}

async function queueOwnerComment(input: {
  prisma: PrismaClient; config: ServerConfig; agentRuntime: AgentSessionRuntime;
  deliveryId: string; webhook: LinearCommentWebhook; sessionId: string;
  parentIdentifier?: string; questionId?: string; discoveredChild?: boolean;
}): Promise<CommentWebhookResult> {
  const { prisma, config, webhook, sessionId } = input;
  const data = webhook.data;
  // A Linear retry can carry a different delivery ID. An unchanged comment
  // still has one instruction, while a genuine edit is a new owner message.
  let sourceInput: SourceMessageInput = messageSource(config, webhook);
  const report = await nativeReportIngress(prisma, config, sourceInput);
  if (report && !report.informational) sourceInput = { ...sourceInput, revision: report.revision };
  const requestId = sourceMessageId(sourceInput);
  const queued = await prisma.$transaction(async (tx) => {
    const session = await tx.runtimeSession.findUnique({ where: { id: sessionId } });
    const task = await tx.remoteTask.findUnique({ where: { primarySessionId: sessionId } });
    if (input.parentIdentifier) {
      // Discovery includes remote reads. A child may acquire its own task
      // during those reads; never steal its comment for the old parent.
      const direct = await sourcePrimary(tx as PrismaClient, config, data.issue!.identifier);
      if (direct.primary || direct.reason) throw new Error("Child acquired its own task before owner comment delivery");
      if (input.discoveredChild) {
        const identity = { runtimeSessionId: sessionId, provider: "linear", connectionId: config.activeConnectionId,
          resourceType: "issue-identifier", externalId: data.issue!.identifier, relationship: "child" };
        await tx.runtimeSessionResourceLink.upsert({ where: { runtimeSessionId_provider_connectionId_resourceType_externalId_relationship: identity }, create: identity, update: {} });
      }
    }
    const currentOwner = input.parentIdentifier
      ? (await childPrimary(tx as PrismaClient, config, data.issue!.identifier)).owner
      : await sourcePrimary(tx as PrismaClient, config, data.issue!.identifier);
    if (!session || session.status === "closed" || session.role !== "primary" || !task || task.phase === "closed" || currentOwner?.primary?.id !== sessionId || (input.parentIdentifier && task.issueIdentifier !== input.parentIdentifier)) {
      throw new Error("Owner comment target closed before durable delivery");
    }
    const receipt = await createWebhookReceipt(tx as PrismaClient, {
      webhookId: config.activeWebhookId, connectionId: config.activeConnectionId,
      repositoryId: config.activeRepositoryId, provider: "linear", deliveryId: input.deliveryId,
      eventType: "comment", trigger: input.parentIdentifier ? "child-owner" : "owner", resourceId: data.issue!.identifier,
      commentId: data.id, status: "accepted", detail: `instruction:${requestId}`,
    });
    if (!receipt) return false;
    if (report) {
      const current = await tx.runtimeSourceMessageResolution.findUnique({ where: { id: report.receiptId } });
      if (current?.fingerprint !== report.fingerprint) throw new Error("Native report provenance changed during ingress");
      if (report.informational) {
        await tx.webhookReceipt.update({ where: { id: receipt.id }, data: { status: "ignored", detail: "external_informational_report" } });
        return false;
      }
    }
    const source = await recordSourceMessage(tx, sourceInput);
    const question = input.questionId ? await tx.runtimeQuestion.findFirst({ where: {
      id: input.questionId, runtimeSessionId: sessionId, connectionId: config.activeConnectionId,
    } }) : null;
    const previous = await tx.runtimeInstruction.findUnique({ where: { id: requestId } });
    if (source.state !== "routing" && !previous) {
      await tx.webhookReceipt.update({ where: { id: receipt.id }, data: { status: "ignored", detail: "comment_already_handled" } });
      return false;
    }
    if (previous && previous.sessionId !== sessionId) throw new Error("Owner comment is already bound to another primary");
    const prompt = `${question ? `This answers your earlier question in this thread.\nQuestion: ${question.body}\n\n` : ""}[Linear ${data.issue!.identifier}${input.parentIdentifier ? ` — direct child of ${input.parentIdentifier}` : ""} — owner comment ${data.id}]\n${data.body}`;
    // An accepted message retains its exact pinned-policy payload on retry,
    // even if the checkout becomes unavailable before acknowledgement.
    await queueInstruction(tx, { sessionId, requestId, sourceMessageId: source.id, text: previous?.text ?? (task.pinnedToolingRoot
      ? withToolingInstructions(prompt, session.cwd, task.pinnedToolingRoot) : prompt) });
    if (question) {
      await tx.runtimeQuestion.update({ where: { id: question.id }, data: { state: "answered", error: null } });
      await tx.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: sessionId, provider: "linear", connectionId: config.activeConnectionId, resourceType: "comment-thread", externalId: question.id, relationship: "question", endedAt: null }, data: { relationship: "thread" } });
    }
    return true;
  });
  // The daemon also drains this durable inbox after restart. A failed wake-up
  // cannot erase the accepted instruction or cause a blind second delivery.
  void deliverInstructions(prisma, input.agentRuntime, config).catch(() => undefined);
  return queued ? { kind: "accepted", deliveryId: input.deliveryId, resourceId: data.issue!.identifier } : { kind: "duplicate" };
}

export type CommentWebhookResult =
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | {
      kind: "accepted";
      deliveryId: string;
      resourceId: string | null;
    };

export async function handleCommentWebhook(input: {
  prisma: PrismaClient;
  config: ServerConfig;
  agentRuntime: AgentSessionRuntime;
  deliveryId: string;
  webhook: LinearCommentWebhook;
  resumeRouting?: boolean;
  configuredControl?: boolean;
}): Promise<CommentWebhookResult> {
  const { prisma, config, agentRuntime, deliveryId } = input;
  let webhook = input.webhook;
  if (!webhook.data.issue && (webhook.data.userId ?? webhook.data.user?.id) !== config.agentUserId) {
    const source = await readDeliveryComment(config.linearApiKey, webhook.data.id);
    if (source?.issue) webhook = { ...webhook, data: { ...webhook.data, issue: source.issue, parentId: webhook.data.parentId ?? source.parentId } };
    input = { ...input, webhook };
  }
  const data = webhook.data;
  const authorId = data.userId ?? data.user?.id ?? null;
  const selfAuthored = authorId === config.agentUserId;
  const commentWorkflows = matchWorkflows({ config, on: "comment.created", fields: {
    "comment.action": webhook.action, "comment.authorId": authorId ?? undefined,
    "issue.identifier": data.issue?.identifier,
  } }).filter((workflow) => workflow.deliver === "queue-session");
  // Registered threads are conversations: replies deliver without a mention,
  // like replying to a person. Linear threads are single-level, so
  // parentId ?? id is the thread root.
  const threadRootCommentId = data.parentId ?? data.id;
  const registration = selfAuthored
    ? null
    : await findThreadSession(prisma, {
        provider: "linear",
        connectionId: config.activeConnectionId,
        threadRootCommentId,
      });
  let ownerRoutingFailure: string | null = null;
  let childRoutingFailure: string | null = null;
  // Direct ownership supersedes a historical parent-child link. Otherwise a
  // child promoted into its own task would retry forever against the parent.
  if (!selfAuthored && data.issue?.identifier && isSubscribedOwner(config, authorId)) {
    const direct = await sourcePrimary(prisma, config, data.issue.identifier);
    if (direct.primary && (!registration || registration.runtimeSessionId === direct.primary.id)) {
      return queueOwnerComment({ ...input, sessionId: direct.primary.id, ...(registration ? { questionId: threadRootCommentId } : {}) });
    }
    ownerRoutingFailure = direct.primary && registration ? "source_thread_owner_mismatch" : direct.reason;
  }
  if (!selfAuthored && !ownerRoutingFailure && data.issue?.identifier) {
    let ownership = await childPrimary(prisma, config, data.issue.identifier);
    let discoveredParentId: string | null = null;
    // A child created by the owner must not wait for the primary to refresh its
    // graph. Discover only for a subscribed owner and never revive stale links
    // or steal an issue that already has its own task.
    if (!ownership.owner && !ownership.reason && isSubscribedOwner(config, authorId)) {
      const direct = await sourcePrimary(prisma, config, data.issue.identifier);
      if (!direct.primary && !direct.reason) {
        const issue = await getSourceIssueParent(config, { id: data.issue.id });
        if (issue?.id === data.issue.id && issue.identifier === data.issue.identifier && issue.parent) {
          const parent = await sourcePrimary(prisma, config, issue.parent.identifier);
          if (parent.primary) {
            ownership = { owner: { primary: parent.primary, parentIdentifier: issue.parent.identifier }, reason: null };
            discoveredParentId = issue.parent.id;
          } else if (parent.reason) ownership = { owner: null, reason: parent.reason };
        }
      }
    }
    if (ownership.owner) {
      if (!isSubscribedOwner(config, authorId)) childRoutingFailure = "unauthorized_child_comment";
      else if (registration && registration.runtimeSessionId !== ownership.owner.primary.id) childRoutingFailure = "child_thread_owner_mismatch";
      else {
        // A remembered link never grants continued ownership after reparenting.
        // Failure to read Linear throws before receipt creation so delivery can
        // retry; a confirmed changed parent is rejected, including mentions.
        const graph = await getIssueWorkGraph(config, { id: ownership.owner.parentIdentifier });
        const child = graph.children.find((candidate) => candidate.identifier === data.issue!.identifier && candidate.id === data.issue!.id);
        if (graph.identifier !== ownership.owner.parentIdentifier || child?.parent?.id !== graph.id || (discoveredParentId && graph.id !== discoveredParentId)) childRoutingFailure = "child_no_longer_owned";
        else {
          return queueOwnerComment({ ...input, sessionId: ownership.owner.primary.id, parentIdentifier: ownership.owner.parentIdentifier,
            discoveredChild: Boolean(discoveredParentId),
            ...(registration ? { questionId: threadRootCommentId } : {}) });
        }
      }
    } else childRoutingFailure = ownership.reason;
  }
  const accepted = !selfAuthored && Boolean(authorId) && !childRoutingFailure && !ownerRoutingFailure && (commentWorkflows.length > 0 || registration !== null || input.configuredControl === true);
  const detail = selfAuthored
    ? "self_authored"
    : accepted
      ? null
      : childRoutingFailure ?? ownerRoutingFailure ?? "no_comment_workflow";
  const recorded = await prisma.$transaction(async (tx) => {
  let receipt = await createWebhookReceipt(tx as PrismaClient, {
    webhookId: config.activeWebhookId,
    connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId,
    provider: "linear",
    deliveryId,
    eventType: "comment",
    trigger: registration ? "thread" : "comment",
    resourceId: data.issue?.identifier ?? null,
    commentId: data.id,
    status: accepted ? "accepted" : "ignored",
    detail,
  });
  if (!receipt && input.resumeRouting) receipt = await tx.webhookReceipt.findFirst({ where: { provider: "linear", connectionId: config.activeConnectionId, deliveryId } });
  if (!receipt) return null;
  const needsFeedback = !selfAuthored && isSubscribedOwner(config, authorId) && (ownerRoutingFailure || childRoutingFailure);
  const source = data.issue && authorId && (accepted || needsFeedback) ? await recordSourceMessage(tx, messageSource(config, webhook)) : null;
  if (!accepted && source) {
      await tx.runtimeSourceMessage.updateMany({ where: { id: source.id, state: "routing", sessionId: null }, data: { state: "unrouted", detail,
        replyBody: "I couldn't deliver this comment because its owning session is unavailable or ambiguous. No new task was started.", projectionPending: true } });
  }
  return { receipt, source };
  });
  if (!recorded) return { kind: "duplicate" };
  if (!accepted) return { kind: "ignored", reason: detail! };
  const { receipt, source } = recorded;
  if (source && source.state !== "routing") return { kind: "duplicate" };

  void dispatchEvent({
    prisma,
    config,
    commandClient: bunCommandClient,
    agentRuntime,
    receiptId: receipt.id,
    event: {
      type: DispatchEventType.TrackerCommentReceived,
      webhook,
      ...(source ? { sourceMessageId: source.id } : {}),
      ...(registration
        ? {
            routedSessionId: registration.runtimeSessionId,
            threadRelationship: registration.relationship,
          }
        : {}),
    },
  });
  return {
    kind: "accepted",
    deliveryId,
    resourceId: data.issue?.identifier ?? null,
  };
}
