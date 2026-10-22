import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { attachIssueEvidence, uploadIssueEvidence } from "../../integrations/linear/evidence.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity } from "../../integrations/linear/comments.ts";
import { getSourceIssueForUpdate } from "../../integrations/linear/session-store/source-issue/read.ts";
import { updateSourceIssue } from "../../integrations/linear/session-store/source-issue/update.ts";
import { assertTaskAutomationAllowed } from "../tasks/control.ts";
import { taskForSession } from "../tasks/store.ts";
import { linkedSourceIssue } from "./questions.ts";
import { registerThread } from "./threads.ts";
import { EvidenceReceipt, issueUpdateBody, readIssueEvidence } from "./issue-evidence.ts";

export const IssueUpdateInput = z.object({
  requestKey: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(30_000),
  state: z.string().trim().min(1).max(100).optional(), expectedState: z.string().trim().min(1).max(100).optional(),
  evidence: z.array(z.object({ path: z.string().min(1).max(4096), title: z.string().trim().min(1).max(200) }).strict()).max(8).default([]),
}).strict().refine((value) => Boolean(value.state) === Boolean(value.expectedState), "State changes require both state and expectedState from read_source_issue");
type Input = z.infer<typeof IssueUpdateInput>;

const delivery = {
  source: linkedSourceIssue, read: getSourceIssueForUpdate, update: updateSourceIssue,
  upload: uploadIssueEvidence, attach: attachIssueEvidence, create: createThreadedIssueComment, comment: fetchIssueCommentIdentity,
};

// These writes run only in the HTTP server. Serializing per source prevents two
// simultaneous retries from racing uploads or undoing a newer status update.
const writes = new Map<string, Promise<unknown>>();
export async function publishSessionIssueUpdate(input: Input & { prisma: PrismaClient; config: ServerConfig; sessionId: string }, client = delivery) {
  const source = await client.source(input);
  const key = `${source.link.connectionId}:${source.issue.id}`;
  const previous = writes.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => publish(input, source, client));
  writes.set(key, run);
  try { return await run; } finally { if (writes.get(key) === run) writes.delete(key); }
}

async function publish(input: Input & { prisma: PrismaClient; config: ServerConfig; sessionId: string }, source: Awaited<ReturnType<typeof linkedSourceIssue>>, client: typeof delivery) {
  const { prisma, sessionId } = input;
  const { session, link, config, issue } = source;
  await assertTaskAutomationAllowed(prisma, session.cwd);
  const current = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: sessionId } });
  if (current.status === "closed" || current.role === "delegate") throw new Error("Only an open primary session may publish source-issue updates");
  const task = await taskForSession(prisma, sessionId);
  if (task && task.primarySessionId !== sessionId) throw new Error("Only the task's primary session may publish its issue updates");
  const payload = IssueUpdateInput.parse(inputPayload(input));
  const ownedPaths = task?.resources.filter((resource) => resource.kind === "evidence" && resource.state !== "released").map((resource) => resource.externalId) ?? [];
  let receipt = await prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: sessionId, requestKey: payload.requestKey } } });
  const target = payload.state ? issue.team.states.nodes.find((state) => state.name === payload.state) : undefined;
  if (!receipt?.published && payload.state && !target) throw new Error(`State '${payload.state}' is not in the linked issue's team; read_source_issue for current states`);
  if (!receipt) {
    // Validate every capture before publishing anything. The digest binds retries
    // to the same bytes even if a capture is subsequently overwritten on disk.
    const evidence = [];
    for (const file of payload.evidence) evidence.push((await readIssueEvidence(file, session.cwd, ownedPaths)).receipt);
    receipt = await prisma.runtimeIssueUpdate.create({ data: { runtimeSessionId: sessionId, requestKey: payload.requestKey, connectionId: link.connectionId, issueId: issue.id, input: payload, evidence } });
  }
  if (JSON.stringify(receipt.input) !== JSON.stringify(payload) || receipt.issueId !== issue.id || receipt.connectionId !== link.connectionId) throw new Error("Update requestKey already belongs to a different update; use the original payload to retry");
  const evidence = z.array(EvidenceReceipt).parse(receipt.evidence);
  const result = () => ({ published: true, commentId: receipt.id, issueIdentifier: issue.identifier, state: payload.state ?? null, evidence: evidence.map(({ title, assetUrl, attachmentId }) => ({ title, url: assetUrl, attachmentId })) });
  if (receipt.published) return result(); // A retry must never rewind later owner changes.
  const checkState = async () => {
    await assertTaskAutomationAllowed(prisma, session.cwd);
    const latest = await client.read(config, { id: issue.id });
    if (!latest) throw new Error("Linked issue no longer exists");
    if (payload.state && latest.state.name !== payload.expectedState && latest.state.name !== payload.state) throw new Error(`Issue is now '${latest.state.name}'; inspect it before publishing a new update`);
    return latest;
  };
  await checkState();
  for (const file of evidence) {
    if (!file.assetUrl) {
      const capture = await readIssueEvidence(file, session.cwd, ownedPaths);
      if (capture.receipt.sha256 !== file.sha256) throw new Error("Evidence changed since this update began; restore the capture before retrying");
      file.assetUrl = await client.upload(config.linearApiKey, { name: path.basename(file.path), contentType: file.contentType, bytes: capture.bytes });
      await prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { evidence } });
    }
    if (!file.attachmentId) {
      await assertTaskAutomationAllowed(prisma, session.cwd);
      file.attachmentId = await client.attach(config.linearApiKey, { issueId: issue.id, title: file.title, url: file.assetUrl });
      await prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { evidence } });
    }
  }
  await checkState();
  if (!receipt.commentPosted) {
    const body = issueUpdateBody(payload.body, evidence);
    await registerThread(prisma, { provider: "linear", connectionId: link.connectionId, runtimeSessionId: sessionId, threadRootCommentId: receipt.id });
    const created = await client.create(config.linearApiKey, { id: receipt.id, issueId: issue.id, body });
    if (created?.id !== receipt.id) {
      const existing = await client.comment(config.linearApiKey, receipt.id);
      if (existing?.id !== receipt.id || existing.issue?.id !== issue.id || existing.body !== body) throw new Error("Issue update delivery is unconfirmed; retry with the same requestKey and payload");
    }
    await prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { commentPosted: true } });
  }
  // The handoff and all attachments must exist before a completed-type state
  // is selected. This does not close a runtime session or release its preview.
  const latest = await checkState();
  if (target && latest.state.id !== target.id) await client.update(config, { id: issue.id }, { stateId: target.id });
  if (target) {
    const confirmed = await client.read(config, { id: issue.id });
    if (confirmed?.state.id !== target.id) throw new Error("Issue state change is unconfirmed; inspect and retry the same update");
  }
  await prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { published: true } });
  return result();
}

function inputPayload(input: Input): Input {
  return { requestKey: input.requestKey, body: input.body, ...(input.state ? { state: input.state } : {}), ...(input.expectedState ? { expectedState: input.expectedState } : {}), evidence: input.evidence };
}
