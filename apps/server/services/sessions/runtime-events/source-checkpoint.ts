import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../../lib/config.ts";
import type { AgentRuntimeLifecycleEvent, AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity } from "../../../integrations/linear/comments.ts";
import { getSourceIssueForWorkflow } from "../../../integrations/linear/session-store/source-issue/read.ts";
import { registerThread } from "../threads.ts";

const client = { create: createThreadedIssueComment, read: fetchIssueCommentIdentity, issue: getSourceIssueForWorkflow };

/** New task sessions link directly to their source issue and need no separate
 * AGENT team. A stable comment UUID reconciles a lost response before retry. */
export async function projectSourceCheckpoint(config: ServerConfig, prisma: PrismaClient, _runtime: AgentSessionRuntime, event: AgentRuntimeLifecycleEvent, delivery = client) {
  const source = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: event.sessionId, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  if (!source) return false;
  if (event.phase !== "completed" && event.phase !== "failed") return true;
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: event.sessionId } });
  const scoped = scopeConfig(config, { repositoryId: session.repositoryId, connectionId: source.connectionId });
  const issue = await delivery.issue(scoped, { id: source.externalId });
  if (!issue) throw new Error("Checkpoint source issue missing");
  const output = event.phase === "failed" ? event.error ?? "The agent turn failed." : event.output?.trim();
  if (!output) return true;
  const body = `${event.phase === "failed" ? "### Agent turn failed" : "### Agent checkpoint"}\n\n${output.length > 8000 ? `…${output.slice(-8000)}` : output}`;
  const digest = createHash("sha256").update(`linear-checkpoint:${event.sessionId}:${event.id}`).digest("hex");
  // Linear accepts client IDs in UUIDv4 form; the hash keeps retries stable.
  const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const thread = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: event.sessionId, provider: "linear", connectionId: source.connectionId, resourceType: "comment-thread", relationship: "thread", endedAt: null }, orderBy: { createdAt: "asc" } });
  const created = await delivery.create(scoped.linearApiKey, { id, issueId: issue.id, body, ...(thread ? { parentId: thread.externalId } : {}) });
  if (created?.id !== id) {
    const existing = await delivery.read(scoped.linearApiKey, id);
    if (existing?.issue?.id !== issue.id || existing.body !== body) throw new Error("Checkpoint delivery unconfirmed; retain event for reconciliation");
  }
  if (!thread) await registerThread(prisma, { provider: "linear", connectionId: source.connectionId, threadRootCommentId: id, runtimeSessionId: event.sessionId, relationship: "thread" });
  return true;
}
