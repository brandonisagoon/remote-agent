import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { recordSourceMessage } from "./source-messages.ts";
import { deliverInstructions, queueInstruction } from "./inbox.ts";

let db: TestDatabase;
const originalFetch = globalThis.fetch;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { globalThis.fetch = originalFetch; await db.cleanup(); });

async function queuedChildComment() {
  const config = testConfig();
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
  const session = await beginRuntimeSession(db.prisma, { sessionKey: "authority-test", agent: "codex", cwd: "/tmp/comment-authority",
    repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
  const runtime = createFakeAgentRuntime([{ ...session, status: "idle", agent: "codex" }]);
  const task = await db.prisma.remoteTask.create({ data: { requestKey: "authority-task", repositoryId: config.activeRepositoryId,
    machineId: config.machine, connectionId: config.activeConnectionId, worktreePath: session.cwd, primarySessionId: session.id,
    branchName: "codex/authority-test", toolingRoot: "/tools", toolingRevision: "a".repeat(40), issueIdentifier: "PARENT-1", phase: "working" } });
  const source = await recordSourceMessage(db.prisma, { provider: "linear", connectionId: config.activeConnectionId,
    repositoryId: config.activeRepositoryId, machineId: config.machine, resourceId: "child-issue", resourceIdentifier: "CHILD-1",
    commentId: "child-comment", threadRootId: "child-comment", authorId: "owner", body: "Feedback on the former child", presentation: {} });
  await db.prisma.$transaction((tx) => queueInstruction(tx, { sessionId: session.id, requestId: source.id, sourceMessageId: source.id, text: source.body }));
  let graphReads = 0;
  globalThis.fetch = (async (_url, init) => {
    const { query } = JSON.parse(String(init?.body));
    if (!query.includes("SourceIssueWorkGraph")) throw new Error(`Unexpected query: ${query}`);
    graphReads++;
    // The queued comment was accepted earlier. Its issue has since been
    // reparented, so the original primary no longer owns it.
    return Response.json({ data: { issue: { id: "parent-issue", identifier: "PARENT-1", team: { states: { nodes: [] } },
      children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  }) as typeof fetch;
  return { config, runtime, task, source, graphReads: () => graphReads };
}

test("a config-less inbox wakeup cannot submit a queued comment without current source authority", async () => {
  const { runtime, source, graphReads } = await queuedChildComment();
  await deliverInstructions(db.prisma, runtime);
  expect(runtime.sentMessages).toHaveLength(0);
  expect(graphReads()).toBe(0);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: source.id } })).state).toBe("queued");
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id } })).state).toBe("queued");
});

test("an unrelated task instruction wakeup revalidates and refuses a reparented queued child comment", async () => {
  const { config, runtime, task, source, graphReads } = await queuedChildComment();
  const admitted: string[] = [];
  const start = runtime.startTurn.bind(runtime);
  runtime.startTurn = (input) => start({ ...input, beforeStart: async () => {
    const accepted = await input.beforeStart!();
    if (accepted) admitted.push(input.text);
    return accepted;
  } });
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const response = await app.request(`/api/tasks/${task.id}/instructions`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestKey: "unrelated-followup", text: "Inspect the original parent task" }) });
  expect(response.status).toBe(202);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: source.id } })).state !== "queued") break;
    await Bun.sleep(5);
  }
  expect(graphReads()).toBe(1);
  expect(admitted).toEqual([]);
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: source.id } })).state).toBe("failed");
  expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id } })).state).toBe("failed");
});
