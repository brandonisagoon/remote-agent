import { expect, test } from "bun:test";
import { testConfig } from "../../../../test-support/config.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { handleReactionWebhook } from "../../integrations/linear/webhooks/reaction/handler.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";

test("a committed control recovers its original comment snapshot after interruption and a later edit", async () => {
  const db = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  try {
    const config = testConfig();
    config.webhooks[config.activeWebhookId]!.repositoryRouting[config.activeRepositoryId] = { when: [{ "linear.userId": ["owner"] }] };
    Object.assign(config.repository.workflows, { steer: { id: "steer", connectionId: null, on: "comment.reaction",
      when: [{ "reaction.emoji": ["compass"] }], skill: { skillset: "", flags: [] }, deliver: "steer-session",
      providerId: null, model: null, plan: null } });
    const session = await beginRuntimeSession(db.prisma, { sessionKey: "control-recovery", agent: "codex", cwd: "/tmp/control-recovery",
      repositoryId: config.activeRepositoryId, machineId: config.machine, role: "primary" });
    await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "active" } });
    await db.prisma.remoteTask.create({ data: { requestKey: "control-recovery-task", repositoryId: config.activeRepositoryId,
      machineId: config.machine, connectionId: config.activeConnectionId, worktreePath: session.cwd, primarySessionId: session.id,
      branchName: "codex/control-recovery", toolingRoot: "/tools", toolingRevision: "a".repeat(40), issueIdentifier: "ISSUE-1", phase: "working" } });
    await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear",
      connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "ISSUE-1", relationship: "handles" } });
    const runtime = createFakeAgentRuntime([{ ...session, agent: "codex", status: "active" }]);
    runtime.observeSessionActivity = () => ({ state: "executing", requestId: "existing-active-turn", observedAt: Date.now() });
    let canonicalBody = "Original revision A";
    globalThis.fetch = (async (_url, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (!query.includes("DeliveryComment")) throw new Error(`Unexpected query: ${query}`);
      return Response.json({ data: { comment: { id: "recover-feedback", body: canonicalBody, parentId: null,
        user: { id: "owner" }, issue: { id: "issue-one", identifier: "ISSUE-1" }, documentContent: null } } });
    }) as typeof fetch;
    let transactions = 0;
    const interrupted = new Proxy(db.prisma, {
      get(target, key, receiver) {
        if (key === "$transaction") return (...args: unknown[]) => {
          transactions++;
          // The first transaction has committed the control and its receipt;
          // interrupt the subsequent owner-queue transaction before it starts.
          if (transactions === 2) throw new Error("Interrupted after control commit");
          return (target.$transaction as (...args: unknown[]) => unknown).apply(target, args);
        };
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const webhook = { type: "Reaction" as const, action: "create", webhookTimestamp: Date.now(), data: {
      id: "recover-reaction", emoji: "compass", commentId: "recover-feedback", userId: "owner",
    } };
    const input = { prisma: interrupted, config, agentRuntime: runtime, deliveryId: "recover-delivery", webhook };
    await expect(handleReactionWebhook(input)).rejects.toThrow("Interrupted after control commit");
    const control = await db.prisma.runtimeMessageControl.findFirstOrThrow();
    expect(control.state).toBe("pending");
    expect(control.sourceMessageId).not.toBeNull();
    const source = await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: control.sourceMessageId! } });
    expect(source.body).toBe("Original revision A");
    expect(source.state).toBe("routing");
    expect(await db.prisma.runtimeInstruction.count()).toBe(0);

    // Linear now returns another revision, but the same reaction's retry must
    // recover its committed snapshot rather than enqueue substitute content.
    canonicalBody = "Later revision B";
    await handleReactionWebhook(input);
    await handleReactionWebhook(input);
    expect(await db.prisma.runtimeSourceMessage.count()).toBe(1);
    expect(await db.prisma.runtimeInstruction.count()).toBe(1);
    const instruction = await db.prisma.runtimeInstruction.findFirstOrThrow();
    expect(instruction.sourceMessageId).toBe(source.id);
    expect(instruction.sessionId).toBe(session.id);
    expect(instruction.state).toBe("queued");
    expect(instruction.text).toContain("Original revision A");
    expect(instruction.text).not.toContain("Later revision B");
    expect((await db.prisma.runtimeSourceMessage.findUniqueOrThrow({ where: { id: source.id } })).sessionId).toBe(session.id);
    const recovered = await db.prisma.runtimeMessageControl.findUniqueOrThrow({ where: { id: control.id } });
    expect(recovered.sourceMessageId).toBe(source.id);
    expect(recovered.state).toBe("unsupported");
    expect(runtime.sentMessages).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; await db.cleanup(); }
});
