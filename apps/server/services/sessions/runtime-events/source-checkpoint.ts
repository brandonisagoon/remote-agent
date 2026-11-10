import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../../lib/config.ts";
import type { AgentRuntimeLifecycleEvent, AgentSessionRuntime } from "../../../../../types/runtime/index.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity, fetchPublicationCommentTimeline } from "../../../integrations/linear/comments.ts";
import { getSourceIssueForUpdate } from "../../../integrations/linear/session-store/source-issue/read.ts";
import { registerThread } from "../threads.ts";
import { advanceRuntimeEventCursor, getRuntimeEventCursor } from "../runtime-registry.ts";

import { IssueUpdateInput, issueUpdateDelivery, publishSessionIssueUpdate } from "../issue-updates.ts";
import { issueUpdateSource } from "../issue-update-source.ts";
import { canonicalPublicationReceipt, observePublicationRecoveries, readPublicationFact, resolveTaskPublication, reserveTaskPublication } from "../task-publication.ts";

const client = { create: createThreadedIssueComment, read: fetchIssueCommentIdentity, issue: getSourceIssueForUpdate, timeline: fetchPublicationCommentTimeline };
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

/** Completed turns stay internal. Concrete primary failures and observed
 * recoveries share exactly the same task/update receipt as explicit reports. */
export async function projectSourceCheckpoint(config: ServerConfig, prisma: PrismaClient, _runtime: AgentSessionRuntime, event: AgentRuntimeLifecycleEvent, delivery: Omit<typeof client, "timeline"> & Partial<Pick<typeof client, "timeline">> = client) {
  const session = await prisma.runtimeSession.findUnique({ where: { id: event.sessionId }, include: { sessionMirror: true } });
  if (!session) return false;
  const links = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: event.sessionId, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  if (links.length > 1) throw new Error("Checkpoint source ownership is ambiguous");
  const link = links[0];
  if (!link && !session.sessionMirror) return false;
  if (!["completed", "failed", "cancelled"].includes(event.phase)) return true;
  if (session.role === "delegate" || session.status === "closed") return true; // Its result belongs in the primary inbox.
  const consumer = `linear-source-checkpoint:v1:${fingerprint(link ? `${link.connectionId}:${link.externalId}` : `mirror:${session.sessionMirror!.id}`)}`;
  const cursor = await getRuntimeEventCursor(prisma, { runtimeSessionId: event.sessionId, consumer });
  const previous = cursor.sourceCursor ? Checkpoint.parse(JSON.parse(cursor.sourceCursor)) : null;
  const sequence = BigInt(event.sequence ?? 0);
  if (previous?.eventId === event.id || (sequence > 0n && sequence <= cursor.generation)) return true;
  const output = event.error?.trim() || "The agent turn failed.";
  const remember = () => advanceRuntimeEventCursor(prisma, { runtimeSessionId: event.sessionId, consumer,
    sourceCursor: JSON.stringify({ eventId: event.id, requestId: event.requestId, phase: event.phase === "failed" ? "failed" : "completed", fingerprint: fingerprint(output) }), generation: sequence > 0n ? sequence : cursor.generation });
  // No issue fetch or publication for routine completed worker acknowledgments.
  if (event.phase !== "failed" && !await prisma.runtimeEventCursor.count({ where: { runtimeSessionId: session.id, consumer: { startsWith: "task-publication:v1:" }, sourceCursor: { not: null } } })) {
    await remember(); return true;
  }
  const source = link ? { session, link, config: scopeConfig(config, { repositoryId: session.repositoryId, connectionId: link.connectionId }), issue: null } : await issueUpdateSource({ prisma, config, sessionId: session.id });
  const issue = source.issue ?? await delivery.issue(source.config, { id: source.link.externalId });
  if (!issue) throw new Error("Checkpoint source issue missing");
  const task = await prisma.remoteTask.findUnique({ where: { primarySessionId: session.id } });
  if (task?.ownerPaused || task?.phase === "closed" || task?.phase === "complete" || ["completed", "canceled"].includes(issue.state.type)) { await remember(); return true; }
  const owner = { sessionId: session.id, taskId: task?.id ?? null, repositoryId: session.repositoryId, machineId: session.machineId, connectionId: source.link.connectionId, issueId: issue.id };
  const scopedClient = { ...issueUpdateDelivery, source: async () => ({ ...source, issue }), read: async () => {
    const latest = await delivery.issue(source.config, { id: source.link.externalId });
    if (latest && ["completed", "canceled"].includes(latest.state.type)) throw new Error("Checkpoint source issue became terminal");
    if (task && (await prisma.remoteTask.findUnique({ where: { id: task.id } }))?.ownerPaused) throw new Error("Checkpoint task is paused");
    return latest;
  }, create: delivery.create, comment: delivery.read };
  const pending = await prisma.runtimeIssueUpdate.findMany({ where: { runtimeSessionId: session.id, connectionId: owner.connectionId, issueId: owner.issueId, published: false, requestKey: { startsWith: "task-publication:v1:" } }, orderBy: { createdAt: "asc" }, take: 100 });
  for (const receipt of pending) await publishSessionIssueUpdate({ prisma, config, sessionId: session.id, ...IssueUpdateInput.parse(receipt.input) }, scopedClient);
  const publications = (await observePublicationRecoveries(prisma, owner)).map((publication) => ({ publication, body: `Earlier blocker resolved for ${publication.subject.kind} \`${publication.subject.id}\`. The original failure remains in task activity.` }));
  if (event.phase === "failed") {
    const instruction = await prisma.runtimeInstruction.findFirst({ where: { sessionId: session.id, executionRequestId: event.requestId, state: { in: ["failed", "unknown"] } } });
    const subject = instruction ? { kind: "instruction" as const, id: instruction.id } : { kind: "execution" as const, id: session.id };
    const fact = await readPublicationFact(prisma, owner, subject);
    if (fact.status === "blocked" && fact.code) {
      const actual = subject.kind === "execution" && typeof fact.witness.eventId === "string" ? await prisma.runtimeLifecycleEvent.findUnique({ where: { id: fact.witness.eventId } }) : null;
      const currentEvent = actual ? { ...event, id: actual.id, requestId: actual.requestId, error: actual.error ?? undefined } : event;
      publications.push({ publication: { category: "blocker", subject, code: fact.code }, body: checkpointBody(currentEvent, currentEvent.error?.trim() || "The agent turn failed.") });
    }
  }
  for (const item of publications) {
    const resolved = await prisma.$transaction((tx) => resolveTaskPublication(tx, owner, item.publication));
    const requestKey = `task-checkpoint:v2:${fingerprint(resolved.requestKey)}`;
    const saved = await canonicalPublicationReceipt(prisma, owner, resolved.requestKey);
    const payload = saved ? IssueUpdateInput.parse(saved.input) : { requestKey, body: item.body, publication: resolved.publication, evidence: [] };
    if (!saved && item.publication.category === "blocker" && event.phase === "failed" && (item.publication.subject.kind !== "execution" || (await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } }))?.id === event.id)) {
      const digest = fingerprint(`linear-checkpoint:${event.sessionId}:${event.id}`);
      let id = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      let existing = await delivery.read(source.config.linearApiKey, id);
      const mirror = session.sessionMirror;
      if (!existing && mirror?.rootCommentId) {
        const migration = await prisma.runtimeEventCursor.upsert({ where: { runtimeSessionId_consumer: { runtimeSessionId: session.id, consumer: "linear-publication-migration:v1" } }, update: {},
          create: { runtimeSessionId: session.id, consumer: "linear-publication-migration:v1", generation: BigInt((await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: session.id }, orderBy: { sequence: "desc" } }))?.sequence ?? 0), sourceCursor: new Date().toISOString() } });
        if (sequence <= migration.generation && event.sequence !== undefined) {
          const root = await delivery.read(source.config.linearApiKey, mirror.rootCommentId);
          if (root?.issue?.id !== issue.id) throw new Error("Legacy mirror thread ownership is unconfirmed");
          const timeline = await (delivery.timeline ?? client.timeline)(source.config.linearApiKey, issue.id);
          const candidates = timeline.filter((comment) => comment.parentId === mirror.rootCommentId && comment.body === `❌ Agent turn failed\n\n${event.error ?? "Unknown acpx error"}` && Date.parse(comment.createdAt) >= event.createdAt && Date.parse(comment.createdAt) <= Date.parse(migration.sourceCursor!));
          if (candidates.length > 1) throw new Error("Legacy mirror delivery is ambiguous; retain its original event for reconciliation");
          if (candidates[0]) { id = candidates[0].id; existing = { ...candidates[0], issue: { id: issue.id } }; }
        }
      }
      if (existing) {
        const legacyOutput = event.error ?? "The agent turn failed.";
        const legacyBody = `### Agent turn failed\n\n${legacyOutput.length > 8000 ? `…${legacyOutput.slice(-8000)}` : legacyOutput}`;
        if (existing.id !== id || existing.issue?.id !== issue.id || ![item.body, legacyBody, ...(session.sessionMirror?.rootCommentId && existing.parentId === session.sessionMirror.rootCommentId ? [`❌ Agent turn failed\n\n${event.error ?? "Unknown acpx error"}`] : [])].includes(existing.body)) throw new Error("Checkpoint delivery unconfirmed; legacy comment identity differs");
        const receipt = await prisma.runtimeIssueUpdate.upsert({ where: { id }, update: {}, create: { id, runtimeSessionId: session.id, requestKey: `legacy-checkpoint:${fingerprint(event.id)}`, connectionId: owner.connectionId, issueId: issue.id,
          input: { requestKey: `legacy-checkpoint:${fingerprint(event.id)}`, body: existing.body, evidence: [] }, evidence: [], commentPosted: true, published: true } });
        await reserveTaskPublication(prisma, owner, payload, [], receipt);
        await registerThread(prisma, { provider: "linear", connectionId: owner.connectionId, runtimeSessionId: session.id, threadRootCommentId: id });
      }
    }
    await publishSessionIssueUpdate({ prisma, config, sessionId: session.id, ...payload }, scopedClient);
  }
  await remember(); return true;
}
