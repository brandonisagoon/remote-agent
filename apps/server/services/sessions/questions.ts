import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity } from "../../integrations/linear/comments.ts";
import { getSourceIssueForWorkflow } from "../../integrations/linear/session-store/source-issue/read.ts";
import { assertTaskAutomationAllowed } from "../tasks/control.ts";
import { findThreadSession, registerThread } from "./threads.ts";

export async function linkedSourceIssue(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string }) {
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.status === "closed") throw new Error("Session is missing or closed");
  const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: {
    runtimeSessionId: session.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null,
  } });
  if (!link) throw new Error("Session has no linked Linear issue");
  const config = scopeConfig(input.config, { repositoryId: session.repositoryId, connectionId: link.connectionId });
  const issue = await getSourceIssueForWorkflow(config, { id: link.externalId });
  if (!issue) throw new Error("Linked issue not found");
  return { session, link, config, issue };
}

const delivery = { create: createThreadedIssueComment, read: fetchIssueCommentIdentity };

/** Persist identity and register routing before the external write. Retrying
 * uses the same UUID; a lost response can never create a second comment. */
export async function deliverSessionQuestion(input: {
  prisma: PrismaClient; apiKey: string; sessionId: string; connectionId: string;
  issueId: string; requestKey: string; body: string;
}, client = delivery) {
  const question = await input.prisma.runtimeQuestion.upsert({
    where: { runtimeSessionId_requestKey: { runtimeSessionId: input.sessionId, requestKey: input.requestKey } }, update: {},
    create: { runtimeSessionId: input.sessionId, requestKey: input.requestKey, connectionId: input.connectionId, issueId: input.issueId, body: input.body },
  });
  if (question.body !== input.body || question.issueId !== input.issueId || question.connectionId !== input.connectionId) throw new Error("Question request key already belongs to a different question");
  if (question.state === "posted") return { commentId: question.id, state: "posted" as const };
  const key = { provider: "linear", connectionId: input.connectionId, threadRootCommentId: question.id };
  // An answer may arrive before an uncertain create is reconciled. Preserve
  // the answered thread's relationship when retrying.
  if (!(await findThreadSession(input.prisma, key))) await registerThread(input.prisma, { ...key, runtimeSessionId: input.sessionId, relationship: "question" });
  try {
    const created = await client.create(input.apiKey, { id: question.id, issueId: question.issueId, body: question.body });
    if (created?.id !== question.id) {
      const existing = await client.read(input.apiKey, question.id);
      if (existing?.id !== question.id || existing.issue?.id !== question.issueId || existing.body !== question.body) throw new Error("Question delivery is unconfirmed; retry with the same requestKey");
    }
    await input.prisma.runtimeQuestion.update({ where: { id: question.id }, data: { state: "posted", error: null } });
    return { commentId: question.id, state: "posted" as const };
  } catch (error) {
    await input.prisma.runtimeQuestion.update({ where: { id: question.id }, data: { state: "unknown", error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export async function askSessionQuestion(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; requestKey: string; body: string }) {
  const { session, link, config, issue } = await linkedSourceIssue(input);
  await assertTaskAutomationAllowed(input.prisma, session.cwd);
  return { ...await deliverSessionQuestion({ ...input, apiKey: config.linearApiKey, issueId: issue.id, connectionId: link.connectionId }), issueIdentifier: issue.identifier };
}
