import type { PrismaClient, RuntimeSourceMessage, RuntimeMessageControl } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { linearGraphql } from "./client.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity } from "./comments.ts";
import { getIssueWorkGraph } from "./session-store/source-issue/work-graph.ts";
import { registerThread } from "../../services/sessions/threads.ts";
import { matchesReactionEmoji } from "./webhooks/reaction/emoji.ts";

const publishing = new Map<string, Promise<void>>();

export class SourceMessageOwnershipError extends Error {
  readonly code = "source_ownership_revoked";
}

export async function validateSourceMessageOwner(config: ServerConfig, prisma: PrismaClient, message: RuntimeSourceMessage) {
  if (message.provider !== "linear" || message.machineId !== config.machine) throw new SourceMessageOwnershipError("Source message belongs to another integration or machine");
  const webhookId = Object.values(config.webhooks).find((webhook) => webhook.connectionId === message.connectionId && webhook.repositoryRouting[message.repositoryId])?.id;
  if (!webhookId) throw new SourceMessageOwnershipError("Source subscription is no longer configured");
  const scoped = scopeConfig(config, { connectionId: message.connectionId, repositoryId: message.repositoryId, webhookId });
  const rule = scoped.webhooks[scoped.activeWebhookId]?.repositoryRouting[message.repositoryId];
  if (rule?.when?.length && !rule.when.some((condition) => !condition["linear.userId"] || condition["linear.userId"]!.includes(message.authorId))) throw new SourceMessageOwnershipError("Source author is no longer subscribed");
  if (!message.sessionId) {
    if (message.state !== "unrouted") throw new SourceMessageOwnershipError("Source message has no selected owner");
    return scoped;
  }
  const session = await prisma.runtimeSession.findUnique({ where: { id: message.sessionId } });
  if (!session || session.status === "closed" || session.role !== "primary" || session.repositoryId !== message.repositoryId || session.machineId !== message.machineId) throw new SourceMessageOwnershipError("Source message owner is no longer eligible");
  const task = await prisma.remoteTask.findUnique({ where: { primarySessionId: session.id } });
  if (task) {
    if (task.phase === "closed" || task.worktreePath !== session.cwd || task.connectionId !== message.connectionId) throw new SourceMessageOwnershipError("Source task ownership has changed");
    if (task.issueIdentifier !== message.resourceIdentifier) {
      const ownTask = await prisma.remoteTask.findFirst({ where: { issueIdentifier: message.resourceIdentifier, connectionId: message.connectionId, repositoryId: message.repositoryId, machineId: message.machineId } });
      if (ownTask) throw new SourceMessageOwnershipError("Child now has its own task");
      const graph = await getIssueWorkGraph(scoped, { id: task.issueIdentifier! });
      if (!graph.children.some((child) => child.id === message.resourceId && child.identifier === message.resourceIdentifier && child.parent?.id === graph.id)) throw new SourceMessageOwnershipError("Source child is no longer owned by this primary");
    }
  }
  return scoped;
}

/** Immutable comment UUID reconciles a lost response without another reply. */
export async function publishSourceReply(config: ServerConfig, prisma: PrismaClient, id: string) {
  const prior = publishing.get(id) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(async () => {
    const message = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id } });
    if (message.replyPosted || !message.replyBody) return;
    const scoped = await validateSourceMessageOwner(config, prisma, message);
    const root = await fetchIssueCommentIdentity(scoped.linearApiKey, message.threadRootId);
    if (root?.issue?.id !== message.resourceId) throw new Error("Reply thread no longer belongs to the original issue");
    const input = { id: message.replyId, issueId: message.resourceId, parentId: message.threadRootId, body: message.replyBody };
    const created = await createThreadedIssueComment(scoped.linearApiKey, input);
    if (created?.id !== input.id) {
      const existing = await fetchIssueCommentIdentity(scoped.linearApiKey, input.id);
      if (existing?.issue?.id !== input.issueId || existing.body !== input.body || existing.parentId !== input.parentId) throw new Error("Reply publication is unconfirmed; the outbox will reconcile the same comment ID");
    }
    // Operator recovery can replace an unrouted failure notice with a fresh
    // conversational outbox while this network request is in flight. Its old
    // acknowledgement must never mark the new answer as published.
    const confirmed = await prisma.$transaction(async (tx) => {
      const current = await tx.runtimeSourceMessage.updateMany({ where: { id, replyId: message.replyId, replyBody: message.replyBody },
        data: { replyPosted: true, projectionPending: true } });
      if (!current.count) await tx.runtimeSourceMessageResolution.updateMany({ where: { sourceMessageId: id, priorReplyId: message.replyId }, data: { priorReplyPosted: true } });
      return current.count > 0;
    });
    if (confirmed && message.sessionId) await registerThread(prisma, { provider: message.provider, connectionId: message.connectionId,
      runtimeSessionId: message.sessionId, threadRootCommentId: message.threadRootId });
  });
  publishing.set(id, run);
  try { await run; } finally { if (publishing.get(id) === run) publishing.delete(id); }
}

interface Reaction { id: string; emoji: string; user: { id: string } | null }

/** Project current state, not historical events. Only the configured automation
 * identity's reactions are eligible for removal; human control reactions stay. */
export async function projectMessageReactions(config: ServerConfig, prisma: PrismaClient, message: RuntimeSourceMessage) {
  const mapping = message.presentation as Record<string, string | undefined>;
  const history = await prisma.runtimeSourceMessage.findMany({ where: { provider: message.provider, connectionId: message.connectionId, commentId: message.commentId }, select: { presentation: true, projectedReactions: true } });
  const managed = new Set<string>();
  for (const previous of history) {
    for (const value of Object.values(previous.presentation as Record<string, string>)) managed.add(value);
    if (Array.isArray(previous.projectedReactions)) for (const value of previous.projectedReactions) if (typeof value === "string") managed.add(value);
  }
  if (!managed.size) return true;
  const scoped = scopeConfig(config, { connectionId: message.connectionId, repositoryId: message.repositoryId });
  const state = { queued: "queued", processing: "processing", failed: "failed", unknown: "attention", attention: "attention", unrouted: "attention" }[message.state];
  const desired = new Set([state ? mapping[state] : null, message.replyPosted ? mapping.replied : null].filter((value): value is string => Boolean(value)));
  const actions = Array.isArray(message.requestedActions) ? message.requestedActions : [];
  if (actions.includes("plan_update") && mapping.planUpdate) desired.add(mapping.planUpdate);
  if (actions.includes("code_change") && mapping.codeChange) desired.add(mapping.codeChange);
  if (message.state === "handled" && message.replyBody && !message.replyPosted && mapping.attention) desired.add(mapping.attention);
  const attention = await prisma.runtimeMessageControl.findFirst({ where: { sourceMessageId: message.id, state: { in: ["unsupported", "unknown", "rejected"] } } });
  if (attention && mapping.attention) desired.add(mapping.attention);
  const result = await linearGraphql<{ comment: { reactions: Reaction[] } | null }>(scoped.linearApiKey,
    "query DeliveryReactions($id: String!) { comment(id: $id) { reactions { id emoji user { id } } } }", { id: message.commentId });
  if (!result.comment) throw new Error("Cannot reconcile source-comment reactions");
  const own = result.comment.reactions.filter((reaction) => reaction.user?.id === scoped.agentUserId);
  for (const emoji of desired) {
    if (own.some((reaction) => matchesReactionEmoji(reaction.emoji, emoji))) continue;
    const created = await linearGraphql<{ reactionCreate: { success: boolean } }>(scoped.linearApiKey,
      "mutation DeliveryReaction($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }", { input: { commentId: message.commentId, emoji } });
    if (!created.reactionCreate.success) throw new Error("Reaction publication was not confirmed");
  }
  for (const reaction of own) {
    if (![...managed].some((emoji) => emoji && matchesReactionEmoji(reaction.emoji, emoji)) || [...desired].some((emoji) => matchesReactionEmoji(reaction.emoji, emoji))) continue;
    const deleted = await linearGraphql<{ reactionDelete: { success: boolean } }>(scoped.linearApiKey,
      "mutation RemoveDeliveryReaction($id: String!) { reactionDelete(id: $id) { success } }", { id: reaction.id });
    if (!deleted.reactionDelete.success) throw new Error("Old reaction removal was not confirmed");
  }
  const projected = await prisma.runtimeSourceMessage.updateMany({ where: { id: message.id, updatedAt: message.updatedAt }, data: { projectedReactions: [...desired] } });
  // A newer projection may already have finished while our stale network
  // writes were pending. Schedule the current truth again even in that case.
  if (!projected.count) await prisma.runtimeSourceMessage.update({ where: { id: await reactionSourceId(prisma, message) }, data: { projectionPending: true } });
  return projected.count > 0;
}

async function reactionSourceId(prisma: PrismaClient, message: RuntimeSourceMessage) {
  const identity = { provider: message.provider, connectionId: message.connectionId, commentId: message.commentId };
  const latest = await prisma.runtimeSourceMessage.findFirstOrThrow({ where: identity, orderBy: { sequence: "desc" } });
  const recovery = await prisma.runtimeSourceMessageResolution.findFirst({ where: { action: "retry", sourceMessage: identity }, orderBy: { sequence: "desc" } });
  // A canonical recovery may select an earlier-arriving revision. Its explicit
  // selection remains authoritative until genuinely new ingress arrives.
  return recovery?.revisionSequence != null && latest.sequence <= recovery.revisionSequence ? recovery.sourceMessageId : latest.id;
}

export async function reconcileSourceMessages(config: ServerConfig, prisma: PrismaClient, runtime?: AgentSessionRuntime) {
  let after = 0;
  while (true) {
    const messages = await prisma.runtimeSourceMessage.findMany({ where: { machineId: config.machine, sequence: { gt: after },
      OR: [{ projectionPending: true }, { replyBody: { not: null }, replyPosted: false }] }, orderBy: { sequence: "asc" }, take: 100 });
    if (!messages.length) return;
    for (let message of messages) {
      after = message.sequence;
      if (message.state === "routing") {
        if (runtime) {
          try {
            const { handleCommentWebhook } = await import("./webhooks/comment/handler.ts");
            const scoped = scopeConfig(config, { connectionId: message.connectionId, repositoryId: message.repositoryId });
            await handleCommentWebhook({ prisma, config: scoped, agentRuntime: runtime, deliveryId: `source-recovery:${message.id}`, resumeRouting: true,
              webhook: { type: "Comment", action: "create", webhookTimestamp: Date.now(), data: { id: message.commentId, body: message.body,
                parentId: message.threadRootId === message.commentId ? null : message.threadRootId, userId: message.authorId,
                issue: { id: message.resourceId, identifier: message.resourceIdentifier } } } });
          } catch { console.error(`[comment-delivery] routing remains pending for ${message.id}`); }
        }
        continue;
      }
      const projectionId = await reactionSourceId(prisma, message);
      try {
        let pendingReply = false;
        if (message.replyBody && !message.replyPosted) {
          try { await publishSourceReply(config, prisma, message.id); }
          catch { pendingReply = true; }
        }
        message = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } });
        if (projectionId === message.id && !(await projectMessageReactions(config, prisma, message))) continue;
        const currentProjectionId = await reactionSourceId(prisma, message);
        if (projectionId === message.id && currentProjectionId !== message.id) {
          await prisma.runtimeSourceMessage.update({ where: { id: currentProjectionId }, data: { projectionPending: true } });
          continue;
        }
        // Reaction writes update updatedAt: reread before the compare-and-swap.
        const current = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: message.id } });
        if (!pendingReply && current.state === message.state && current.replyPosted === message.replyPosted) await prisma.runtimeSourceMessage.updateMany({ where: { id: current.id, updatedAt: current.updatedAt }, data: { projectionPending: false } });
      } catch {
        // Durable retry is independent of agent execution and other sessions.
        console.error(`[comment-delivery] projection remains pending for ${message.id}`);
      }
    }
  }
}

export async function reconcileControlNotices(config: ServerConfig, prisma: PrismaClient) {
  let cursor: { createdAt: Date; id: string } | null = null;
  while (true) {
  const controls: RuntimeMessageControl[] = await prisma.runtimeMessageControl.findMany({ where: { machineId: config.machine, noticeBody: { not: null }, noticePosted: false,
    ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 });
  if (!controls.length) break;
  for (const control of controls) {
    cursor = { createdAt: control.createdAt, id: control.id };
    try {
      const message = control.sourceMessageId ? await prisma.runtimeSourceMessage.findUnique({ where: { id: control.sourceMessageId } }) : null;
      if (!message) continue;
      const scoped = await validateSourceMessageOwner(config, prisma, message);
      const root = await fetchIssueCommentIdentity(scoped.linearApiKey, message.threadRootId);
      if (root?.issue?.id !== message.resourceId) throw new Error("Control thread no longer belongs to the original issue");
      const input = { id: control.noticeId, issueId: message.resourceId, parentId: message.threadRootId, body: control.noticeBody! };
      const created = await createThreadedIssueComment(scoped.linearApiKey, input);
      if (created?.id !== input.id) {
        const existing = await fetchIssueCommentIdentity(scoped.linearApiKey, input.id);
        if (existing?.issue?.id !== input.issueId || existing.parentId !== input.parentId || existing.body !== input.body) throw new Error("Control acknowledgment is unconfirmed");
      }
      await prisma.$transaction(async (tx) => {
        await tx.runtimeMessageControl.update({ where: { id: control.id }, data: { noticePosted: true } });
        await tx.runtimeSourceMessage.update({ where: { id: message.id }, data: { projectionPending: true } });
      });
    } catch { console.error(`[comment-delivery] control acknowledgment remains pending for ${control.id}`); }
  }
  }
}
