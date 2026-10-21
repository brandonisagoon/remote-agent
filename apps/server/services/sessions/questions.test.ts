import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { deliverSessionQuestion, askSessionQuestion, answerSessionQuestion } from "./questions.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { findThreadSession, resolveQuestionThread } from "./threads.ts";

let database: TestDatabase | undefined;
afterEach(async () => { await database?.cleanup(); });

test("question retries keep one comment identity, route early replies, and preserve answered threads", async () => {
  database = await createTestDatabase();
  const prisma = database.prisma;
  const session = await beginRuntimeSession(prisma, { sessionKey: "question-test", agent: "codex", cwd: "/tmp/question", repositoryId: "test-repository", machineId: "macbook-air" });
  const input = { prisma, apiKey: "fixture", sessionId: session.id, connectionId: "linear-drafted", issueId: "source-issue", requestKey: "choose-preview", body: "Which preview should I prepare?" };
  const ids: string[] = [];
  let delivered = false;
  const client = {
    async create(_apiKey: LinearCredential, comment: { id?: string; issueId: string; body: string }) {
      ids.push(comment.id!);
      const key = { provider: "linear", connectionId: input.connectionId, threadRootCommentId: comment.id! };
      expect((await findThreadSession(prisma, key))?.runtimeSessionId).toBe(session.id);
      if (!delivered) {
        delivered = true;
        expect((await findThreadSession(prisma, key))?.relationship).toBe("question");
        await resolveQuestionThread(prisma, { ...key, runtimeSessionId: session.id });
        return null; // provider accepted it, response was lost
      }
      return null; // fixed UUID already exists
    },
    async read(_apiKey: LinearCredential, id: string) {
      if (ids.length === 1) throw new Error("Network unavailable");
      return { id, body: input.body, issue: { id: input.issueId } };
    },
  };
  await expect(deliverSessionQuestion(input, client)).rejects.toThrow("Network unavailable");
  expect((await prisma.runtimeQuestion.findFirstOrThrow()).state).toBe("answered");
  await prisma.$disconnect();
  const result = await deliverSessionQuestion(input, client);
  expect(result.state).toBe("answered");
  expect(ids[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect((await findThreadSession(prisma, { provider: "linear", connectionId: input.connectionId, threadRootCommentId: result.commentId }))?.relationship).toBe("thread");
  expect(await deliverSessionQuestion(input, client)).toEqual(result);
  expect(ids).toHaveLength(1);
  expect(await prisma.runtimeQuestion.count()).toBe(1);
  await expect(deliverSessionQuestion({ ...input, body: "A different question" }, client)).rejects.toThrow("different question");
  await expect(deliverSessionQuestion({ ...input, issueId: "other-issue" }, client)).rejects.toThrow("different question");
});

test("a direct task's question and answer survive reconnect without duplicate or changed delivery", async () => {
  database = await createTestDatabase();
  const prisma = database.prisma;
  const session = await beginRuntimeSession(prisma, { sessionKey: "local-question", agent: "codex", cwd: "/tmp/local-question", repositoryId: "test-repository", machineId: "macbook-air" });
  const input = { prisma, config: testConfig(), sessionId: session.id, requestKey: "choice", body: "Which view should I verify?" };
  const question = await askSessionQuestion(input);
  expect(question).toMatchObject({ surface: "task", state: "pending" });
  await prisma.$disconnect();
  expect(await askSessionQuestion(input)).toEqual(question);
  const id = (question as { questionId: string }).questionId;
  await expect(answerSessionQuestion(prisma, { sessionId: "unrelated", questionId: id, answer: "Floor plan" })).rejects.toThrow("another task");
  await answerSessionQuestion(prisma, { sessionId: session.id, questionId: id, answer: "Floor plan" });
  await prisma.$disconnect();
  await answerSessionQuestion(prisma, { sessionId: session.id, questionId: id, answer: "Floor plan" });
  expect(await prisma.runtimeInstruction.count()).toBe(1);
  expect((await prisma.runtimeInstruction.findFirstOrThrow()).state).toBe("queued");
  expect((await prisma.runtimeQuestion.findFirstOrThrow()).state).toBe("answered");
  await expect(answerSessionQuestion(prisma, { sessionId: session.id, questionId: id, answer: "Different" })).rejects.toThrow("another instruction");
  expect(await prisma.runtimeInstruction.count()).toBe(1);
});

test("reconciliation refuses a matching comment ID on another issue", async () => {
  database = await createTestDatabase();
  const prisma = database.prisma;
  const session = await beginRuntimeSession(prisma, { sessionKey: "question-conflict", agent: "codex", cwd: "/tmp/question", repositoryId: "test-repository", machineId: "macbook-air" });
  await expect(deliverSessionQuestion({ prisma, apiKey: "fixture", sessionId: session.id, connectionId: "linear-drafted", issueId: "source-issue", requestKey: "question", body: "Continue?" }, {
    create: async () => null,
    read: async (_key, id) => ({ id, body: "Continue?", issue: { id: "unrelated-issue" } }),
  })).rejects.toThrow("unconfirmed");
  expect((await prisma.runtimeQuestion.findFirstOrThrow()).state).toBe("unknown");
});
