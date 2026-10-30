import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Prisma } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime, AgentRuntimeLifecycleEvent } from "../../../../types/runtime/index.ts";

export type SourceMessageStore = Pick<PrismaClient, "runtimeSourceMessage" | "runtimeInstruction">;

/** Immutable delivery provenance, supplied only by authenticated integrations. */
export interface SourceMessageInput {
  provider: string; connectionId: string; repositoryId: string; machineId: string;
  resourceId: string; resourceIdentifier: string; commentId: string; threadRootId: string; authorId: string; body: string;
  presentation: Record<string, string | undefined>;
  /** Canonical provider version for an edit of an attested outbound report. */
  revision?: string;
}

export function sourceMessageId(input: Pick<SourceMessageInput, "provider" | "connectionId" | "commentId" | "body" | "revision">) {
  return `${input.provider}-comment:${input.connectionId}:${input.commentId}:${createHash("sha256").update(input.body).digest("hex")}${input.revision ? `:revision:${createHash("sha256").update(input.revision).digest("hex")}` : ""}`;
}

export async function recordSourceMessage(store: SourceMessageStore, input: SourceMessageInput) {
  const id = sourceMessageId(input);
  const { revision: _revision, ...record } = input;
  const row = await store.runtimeSourceMessage.upsert({ where: { id }, update: {}, create: {
    ...record, id, presentation: JSON.parse(JSON.stringify(input.presentation)) as Prisma.InputJsonObject,
  } });
  if (["provider", "connectionId", "repositoryId", "machineId", "resourceId", "commentId", "threadRootId", "authorId", "body"].some((key) => row[key as keyof typeof row] !== input[key as keyof SourceMessageInput])) {
    throw new Error("Source message identity changed; refusing to reroute an accepted comment");
  }
  return row;
}

export function sourceReplyInstructions(id: string) {
  return `\n\n[Reply context ${id}] Answer this comment with reply_to_source using sourceMessageId "${id}". Use read_reply_context with the same ID to inspect its original parent/evidence. The server retains the original thread. publish_issue_update is for a separate intentional task update.`;
}

export async function bindSourceTurn(store: Pick<PrismaClient, "runtimeSourceMessage" | "runtimeMetadataEvent">, sourceId: string, sessionId: string, requestId: string) {
  await store.runtimeSourceMessage.update({ where: { id: sourceId }, data: { sessionId, requestId, targetRequestId: null } });
  await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: sessionId, action: "source-message-turn", key: requestId, source: "comment-delivery", value: sourceId } });
}

/** Lifecycle correlation is shared; integration-specific rendering is separate. */
export async function recordSourceLifecycle(prisma: PrismaClient, event: AgentRuntimeLifecycleEvent) {
  await prisma.runtimeSourceMessage.updateMany({ where: { sessionId: event.sessionId, ...(event.phase === "started" ? { state: { in: ["routing", "queued"] } } : {}), OR: [{ requestId: event.requestId }, { targetRequestId: event.requestId, state: { not: "unknown" } }] }, data: {
    state: { started: "processing", completed: "handled", failed: "failed", cancelled: "attention" }[event.phase],
    projectionPending: true,
    ...(event.error ? { detail: event.error } : {}),
  } });
}

export const SourceReplyInput = z.object({
  requestKey: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(30_000),
  sourceMessageId: z.string().min(1),
}).strict();

/** Resolves against the daemon's executing turn, never a session's last thread.
 * The MCP child has only session identity; the runtime is the turn authority. */
export async function activeSourceMessage(input: {
  prisma: PrismaClient; config: ServerConfig; runtime: AgentSessionRuntime; sessionId: string;
  sourceMessageId?: string;
}) {
  const activity = input.runtime.observeSessionActivity?.(input.sessionId);
  if (activity?.state !== "executing" || !activity.requestId) throw new Error("No confirmed executing turn for this session");
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.status !== "active" || session.role !== "primary" || session.machineId !== input.config.machine) throw new Error("Only the active owning primary may reply");
  const messages = await input.prisma.runtimeSourceMessage.findMany({ where: {
    sessionId: session.id, repositoryId: session.repositoryId, machineId: session.machineId,
    ...(input.sourceMessageId ? { id: input.sourceMessageId } : {}),
    OR: [{ requestId: activity.requestId }, { targetRequestId: activity.requestId }],
  } });
  if (messages.length !== 1) throw new Error("Reply source is missing or ambiguous; supply the active sourceMessageId");
  return messages[0]!;
}

export async function readReplyContext(input: Parameters<typeof activeSourceMessage>[0]) {
  const message = await activeSourceMessage(input);
  const { tracker } = await import("../../integrations/tracker/port.ts");
  if (tracker.sourceMessages.provider !== message.provider) throw new Error("Source integration is unavailable");
  const scoped = await tracker.sourceMessages.validateOwner(input.config, input.prisma, message);
  const root = await tracker.sourceMessages.readComment(scoped.linearApiKey, message.threadRootId);
  if (root?.issue?.id !== message.resourceId) throw new Error("Original reply thread is unavailable");
  return { sourceMessageId: message.id, issueIdentifier: message.resourceIdentifier, commentId: message.commentId,
    body: message.body, threadRoot: { id: root.id, body: root.body } };
}

export async function replyToSource(input: z.infer<typeof SourceReplyInput> & Parameters<typeof activeSourceMessage>[0]) {
  const message = await activeSourceMessage(input);
  await prepareSourceReply(input.prisma, message.id, input.body, false, input.requestKey);
  // The durable outbox is also retried by the daemon; no agent turn is replayed.
  const { tracker } = await import("../../integrations/tracker/port.ts");
  if (tracker.sourceMessages.provider !== message.provider) throw new Error("Source integration is unavailable");
  await tracker.sourceMessages.publishReply(input.config, input.prisma, message.id);
  return { published: true, commentId: message.replyId, sourceMessageId: message.id };
}

export async function prepareSourceReply(prisma: PrismaClient, id: string, body: string, automatic: boolean, requestKey?: string) {
  const bounded = body.length > 30_000 ? `${body.slice(0,1000)}\n\n[… see the session transcript for full output …]\n\n${body.slice(-28_000)}` : body;
  await prisma.runtimeSourceMessage.updateMany({ where: { id, replyBody: null }, data: { replyBody: bounded, replyRequestKey: requestKey ?? null, projectionPending: true } });
  const row = await prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id } });
  if (!automatic && row.replyBody !== bounded) throw new Error("This comment already has a different immutable reply; retry the original reply");
  if (!automatic && row.replyRequestKey !== requestKey) throw new Error("Reply already belongs to another requestKey");
  return row;
}

export async function projectSourceReply(config: ServerConfig, prisma: PrismaClient, event: AgentRuntimeLifecycleEvent) {
  const messages = await prisma.runtimeSourceMessage.findMany({ where: { sessionId: event.sessionId,
    OR: [{ requestId: event.requestId }, { targetRequestId: event.requestId, state: { not: "unknown" } }] } });
  if (!messages.length) {
    // An explicitly retried instruction has a newer request identity. Late
    // output from its old attempt must not fall through to an unrelated thread.
    return Boolean(await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: event.sessionId, action: "source-message-turn", key: event.requestId } }));
  }
  await recordSourceLifecycle(prisma, event);
  if (event.phase !== "completed") return true;
  const { tracker } = await import("../../integrations/tracker/port.ts");
  for (const message of messages) {
    if (!message.replyPosted && (message.replyBody || event.output?.trim())) {
      await prepareSourceReply(prisma, message.id, message.replyBody ?? event.output!.trim(), true);
      if (tracker.sourceMessages.provider !== message.provider) throw new Error("Source integration is unavailable");
      await tracker.sourceMessages.publishReply(config, prisma, message.id);
    }
  }
  return true;
}
