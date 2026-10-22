import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { createThreadedIssueComment, fetchIssueCommentIdentity } from "../../integrations/linear/comments.ts";
import { getSourceIssueForUpdate } from "../../integrations/linear/session-store/source-issue/read.ts";
import { assertTaskAutomationAllowed } from "../tasks/control.ts";
import { findThreadSession, registerThread } from "./threads.ts";
import { queueInstruction } from "./inbox.ts";

export async function linkedSourceIssue(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string }) {
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.status === "closed") throw new Error("Session is missing or closed");
  const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: {
    runtimeSessionId: session.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null,
  } });
  if (!link) throw new Error("Session has no linked Linear issue");
  const config = scopeConfig(input.config, { repositoryId: session.repositoryId, connectionId: link.connectionId });
  const issue = await getSourceIssueForUpdate(config, { id: link.externalId });
  if (!issue) throw new Error("Linked issue not found");
  return { session, link, config, issue };
}

const delivery = { create: createThreadedIssueComment, read: fetchIssueCommentIdentity };

/** Persist identity and register routing before the external write. Retrying
 * uses the same UUID; a lost response can never create a second comment. */
export async function deliverSessionQuestion(input: {
  prisma: PrismaClient; apiKey: LinearCredential; sessionId: string; connectionId: string;
  issueId: string; requestKey: string; body: string;
}, client = delivery) {
  const question = await input.prisma.runtimeQuestion.upsert({
    where: { runtimeSessionId_requestKey: { runtimeSessionId: input.sessionId, requestKey: input.requestKey } }, update: {},
    create: { runtimeSessionId: input.sessionId, requestKey: input.requestKey, connectionId: input.connectionId, issueId: input.issueId, body: input.body },
  });
  if (question.body !== input.body || question.issueId !== input.issueId || question.connectionId !== input.connectionId) throw new Error("Question request key already belongs to a different question");
  if (question.state === "posted" || question.state === "answered") return { commentId: question.id, state: question.state };
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
    await input.prisma.runtimeQuestion.updateMany({ where: { id: question.id, state: { not: "answered" } }, data: { state: "posted", error: null } });
    return { commentId: question.id, state: "posted" as const };
  } catch (error) {
    await input.prisma.runtimeQuestion.updateMany({ where: { id: question.id, state: { not: "answered" } }, data: { state: "unknown", error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export async function askSessionQuestion(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; requestKey: string; body: string }) {
  const current = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  if (current.status === "closed") throw new Error("Session is closed");
  await assertTaskAutomationAllowed(input.prisma, current.cwd);
  const source = await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: current.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  if (!source) {
    const question = await input.prisma.runtimeQuestion.upsert({ where: { runtimeSessionId_requestKey: { runtimeSessionId: current.id, requestKey: input.requestKey } }, update: {}, create: { runtimeSessionId: current.id, requestKey: input.requestKey, body: input.body, connectionId: "", issueId: "" } });
    if (question.body !== input.body) throw new Error("Question request key already belongs to a different question");
    return { questionId: question.id, state: question.state, surface: "task" };
  }
  const { session, link, config, issue } = await linkedSourceIssue(input);
  await assertTaskAutomationAllowed(input.prisma, session.cwd);
  return { ...await deliverSessionQuestion({ ...input, apiKey: config.linearApiKey, issueId: issue.id, connectionId: link.connectionId }), issueIdentifier: issue.identifier };
}

export async function answerSessionQuestion(prisma: PrismaClient, input: { sessionId: string; questionId: string; answer: string }) {
  return prisma.$transaction(async (tx) => {
    const question = await tx.runtimeQuestion.findUniqueOrThrow({ where: { id: input.questionId } });
    if (question.runtimeSessionId !== input.sessionId) throw new Error("Question belongs to another task");
    const session = await tx.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
    if (session.status === "closed") throw new Error("Session is closed");
    const instruction = await queueInstruction(tx, { sessionId: input.sessionId, requestId: `question:${question.id}`, text: `The owner answered your question.\n\nQuestion: ${question.body}\n\nAnswer: ${input.answer}` });
    await tx.runtimeQuestion.update({ where: { id: question.id }, data: { state: "answered", error: null } });
    await tx.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: input.sessionId, resourceType: "comment-thread", externalId: question.id, relationship: "question", endedAt: null }, data: { relationship: "thread" } });
    return { questionId: question.id, instruction };
  });
}
