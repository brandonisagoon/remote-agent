import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../../lib/config.ts";
import type { AgentRuntimeLifecycleEvent, AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity } from "../../../integrations/linear/comments.ts";
import { getSourceIssueForWorkflow } from "../../../integrations/linear/session-store/source-issue/read.ts";
import { registerThread } from "../threads.ts";
import { advanceRuntimeEventCursor, getRuntimeEventCursor } from "../runtime-registry.ts";

const client = { create: createThreadedIssueComment, read: fetchIssueCommentIdentity, issue: getSourceIssueForWorkflow };
const MAX_PREVIEW = 1_800;
const Checkpoint = z.object({
  eventId: z.string(), requestId: z.string(), phase: z.enum(["completed", "failed"]), fingerprint: z.string(),
});

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointBody(event: AgentRuntimeLifecycleEvent, output: string): string {
  // This is an excerpt, not a semantic summary. Preserve the opening context
  // and final result; never infer task completion or owner action from prose.
  const preview = output.length > MAX_PREVIEW
    ? `${output.slice(0, 600)}\n\n[… excerpt shortened …]\n\n${output.slice(-1_200)}`
    : output;
  const detail = output.length > MAX_PREVIEW
    ? `\n\nFull checkpoint details are retained in the runtime lifecycle journal (session \`${event.sessionId}\`, turn \`${event.requestId}\`); see the session transcript for execution history.`
    : "";
  return `${event.phase === "failed" ? "### Agent turn failed" : "### Agent checkpoint"}\n\n${preview}${detail}`;
}

/** Only a confirmed explicit update from this same turn can replace an automatic
 * checkpoint. Missing journal timing is not evidence that a prior update covers
 * this turn. A comment alone suffices even if its optional state change failed. */
async function alreadyPublished(prisma: PrismaClient, event: AgentRuntimeLifecycleEvent, connectionId: string, issueId: string, output: string): Promise<boolean> {
  if (event.phase !== "completed") return false;
  const endedAt = new Date(event.createdAt);
  const started = await prisma.runtimeLifecycleEvent.findFirst({
    where: { runtimeSessionId: event.sessionId, requestId: event.requestId, phase: "started", occurredAt: { lte: endedAt } },
    orderBy: { sequence: "desc" },
  });
  if (!started) return false;
  const receipt = await prisma.runtimeIssueUpdate.findFirst({
    where: {
      runtimeSessionId: event.sessionId, connectionId, issueId, commentPosted: true,
      createdAt: { gte: started.occurredAt, lte: endedAt }, updatedAt: { lte: endedAt },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  const input = z.object({ body: z.string() }).safeParse(receipt?.input);
  return input.success && input.data.body.trim() === output;
}

/** New task sessions link directly to their source issue and need no separate
 * AGENT team. A stable comment UUID reconciles a lost response before retry. */
export async function projectSourceCheckpoint(config: ServerConfig, prisma: PrismaClient, _runtime: AgentSessionRuntime, event: AgentRuntimeLifecycleEvent, delivery = client) {
  const source = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: event.sessionId, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  if (!source) return false;
  if (event.phase !== "completed" && event.phase !== "failed") return true;
  const output = event.phase === "failed" ? event.error?.trim() || "The agent turn failed." : event.output?.trim();
  if (!output) return true;
  // The dedicated cursor records only confirmed/suppressed checkpoints. Keep
  // it separate from projection's journal cursor, scoped to the linked issue.
  const consumer = `linear-source-checkpoint:v1:${fingerprint(`${source.connectionId}:${source.externalId}`)}`;
  const cursor = await getRuntimeEventCursor(prisma, { runtimeSessionId: event.sessionId, consumer });
  const previous = cursor.sourceCursor ? Checkpoint.parse(JSON.parse(cursor.sourceCursor)) : null;
  const sequence = BigInt(event.sequence ?? 0);
  if (previous?.eventId === event.id || (sequence > 0n && sequence <= cursor.generation)) return true;
  // Hash full output, not its excerpt: different diagnostics must not collapse
  // just because their visible beginnings and endings happen to match.
  const next = { eventId: event.id, requestId: event.requestId, phase: event.phase, fingerprint: fingerprint(output) };
  const remember = () => advanceRuntimeEventCursor(prisma, {
    runtimeSessionId: event.sessionId, consumer, sourceCursor: JSON.stringify(next),
    generation: sequence > 0n ? sequence : cursor.generation,
  });
  if (previous?.phase === next.phase && previous.fingerprint === next.fingerprint &&
      (next.phase === "completed" || previous.requestId === next.requestId)) {
    await remember();
    return true;
  }
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: event.sessionId } });
  const scoped = scopeConfig(config, { repositoryId: session.repositoryId, connectionId: source.connectionId });
  const issue = await delivery.issue(scoped, { id: source.externalId });
  if (!issue) throw new Error("Checkpoint source issue missing");
  if (await alreadyPublished(prisma, event, source.connectionId, issue.id, output)) {
    await remember();
    return true;
  }
  const body = checkpointBody(event, output);
  const digest = createHash("sha256").update(`linear-checkpoint:${event.sessionId}:${event.id}`).digest("hex");
  // Linear accepts client IDs in UUIDv4 form; the hash keeps retries stable.
  const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const threads = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: event.sessionId, provider: "linear", connectionId: source.connectionId, resourceType: "comment-thread", relationship: "thread", endedAt: null }, orderBy: { createdAt: "asc" } });
  let thread: (typeof threads)[number] | undefined;
  for (const candidate of threads) {
    // A primary can own child-issue conversations too. Never post its source
    // checkpoint under an unrelated child's comment root.
    const identity = await delivery.read(scoped.linearApiKey, candidate.externalId);
    if (identity?.issue?.id === issue.id) { thread = candidate; break; }
  }
  const created = await delivery.create(scoped.linearApiKey, { id, issueId: issue.id, body, ...(thread ? { parentId: thread.externalId } : {}) });
  if (created?.id !== id) {
    const existing = await delivery.read(scoped.linearApiKey, id);
    // A pre-upgrade event may already have posted the old 8k tail format before
    // losing its acknowledgement. Reconcile that same event UUID, never replace
    // or duplicate its comment just because the preview policy has changed.
    const legacyOutput = event.phase === "failed" ? event.error ?? "The agent turn failed." : output;
    const legacyBody = `${event.phase === "failed" ? "### Agent turn failed" : "### Agent checkpoint"}\n\n${legacyOutput.length > 8000 ? `…${legacyOutput.slice(-8000)}` : legacyOutput}`;
    if (existing?.id !== id || existing.issue?.id !== issue.id || (existing.body !== body && existing.body !== legacyBody)) throw new Error("Checkpoint delivery unconfirmed; retain event for reconciliation");
  }
  if (!thread) await registerThread(prisma, { provider: "linear", connectionId: source.connectionId, threadRootCommentId: id, runtimeSessionId: event.sessionId, relationship: "thread" });
  await remember();
  return true;
}
