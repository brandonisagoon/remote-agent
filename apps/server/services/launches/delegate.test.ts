import { afterEach, describe, expect, test } from "bun:test";

import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { delegateSession } from "./delegate.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

describe("delegateSession", () => {
  test("the child inherits lineage and gets the parent's prompt-free links", async () => {
    database = await createTestDatabase();
    const runtime = createFakeAgentRuntime([
      {
        id: "parent",
        name: "Cubic · plan",
        agent: "claude",
        cwd: "/worktrees/cube-42",
        worktreePath: "/worktrees/cube-42",
        repositoryId: "cubic",
        machineId: "macbook-air",
        workflowId: "plan",
      },
    ]);
    await database.prisma.runtimeSession.create({
      data: {
        id: "parent",
        scopeKey: "scope-parent",
        agentCommand: "claude",
        repositoryId: "cubic",
        cwd: "/worktrees/cube-42",
        status: "idle",
        resourceLinks: {
          create: [
            { provider: "linear", connectionId: "linear-main", resourceType: "issue-identifier", externalId: "CUBE-42", relationship: "handles" },
            { provider: "linear", connectionId: "linear-main", resourceType: "comment-thread", externalId: "comment-9", relationship: "question" },
          ],
        },
      },
    });

    const child = await delegateSession(
      { parentSessionId: "parent", prompt: "Research the auth flow.", name: "research" },
      { prisma: database.prisma, runtime },
    );

    const input = runtime.ensureInputs[0]!;
    expect(input.agent).toBe("claude");
    expect(input.cwd).toBe("/worktrees/cube-42");
    expect(input.repositoryId).toBe("cubic");
    expect(input.role).toBe("delegate");
    expect(input.lifecycle).toBe("one-shot");
    expect(input.workflowId).toBe("plan");
    expect(input.relations).toEqual([{ relationship: "spawned-by", targetSessionId: "parent" }]);
    // The issue link carries down; the parent's question thread does not.
    expect(input.resourceLinks).toEqual([
      { provider: "linear", connectionId: "linear-main", resourceType: "issue-identifier", externalId: "CUBE-42", relationship: "handles" },
    ]);
    expect(input.name).toBe("Cubic · plan › research");
    expect(runtime.sentMessages).toEqual([
      { sessionId: child.id, text: "Research the auth flow.", requestId: `delegate:${child.id}` },
    ]);
  });

  test("provider and cwd overrides win; a delegate can delegate", async () => {
    database = await createTestDatabase();
    const runtime = createFakeAgentRuntime([
      { id: "parent", agent: "claude", cwd: "/wt", worktreePath: "/wt", repositoryId: "cubic" },
    ]);
    await database.prisma.runtimeSession.create({
      data: { id: "parent", scopeKey: "s", agentCommand: "claude", repositoryId: "cubic", cwd: "/wt", status: "idle" },
    });
    const first = await delegateSession(
      { parentSessionId: "parent", prompt: "one", provider: "codex", cwd: "/wt/sub" },
      { prisma: database.prisma, runtime },
    );
    expect(runtime.ensureInputs[0]!.agent).toBe("codex");
    expect(runtime.ensureInputs[0]!.cwd).toBe("/wt/sub");

    await database.prisma.runtimeSession.create({
      data: { id: first.id, scopeKey: `s-${first.id}`, agentCommand: "codex", repositoryId: "cubic", cwd: "/wt/sub", status: "idle" },
    });
    await delegateSession({ parentSessionId: first.id, prompt: "two" }, { prisma: database.prisma, runtime });
    expect(runtime.ensureInputs[1]!.relations).toEqual([
      { relationship: "spawned-by", targetSessionId: first.id },
    ]);
  });

  test("refuses unknown and closed parents", async () => {
    database = await createTestDatabase();
    const runtime = createFakeAgentRuntime([{ id: "done", status: "closed" }]);
    await expect(
      delegateSession({ parentSessionId: "nope", prompt: "x" }, { prisma: database.prisma, runtime }),
    ).rejects.toThrow("unknown session: nope");
    await expect(
      delegateSession({ parentSessionId: "done", prompt: "x" }, { prisma: database.prisma, runtime }),
    ).rejects.toThrow("session is closed: done");
  });
});
