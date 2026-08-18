import { afterEach, describe, expect, test } from "bun:test";

import type { CreatedIssueComment } from "../../../integrations/linear/index.ts";
import { createFakeBbClient } from "../../../../test-support/bb.ts";
import { testConfig } from "../../../../test-support/config.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../../test-support/db.ts";
import type { BbEvent } from "../../../../types/runtime/index.ts";
import type {
  AgentIssue,
  AgentIssueStateValue,
} from "../../../../types/sessions/index.ts";
import { buildAgentIssueDescription } from "../registry/index.ts";
import {
  projectBbEvent,
  type ProjectBbEventDependencies,
} from "./projection.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

function event(input: {
  id: string;
  type: string;
  status?: string;
  turnId?: string;
  data?: Record<string, unknown>;
  createdAt?: number;
}): BbEvent {
  return {
    id: input.id,
    threadId: "thr_1",
    seq: 1,
    createdAt: input.createdAt ?? 1_000,
    type: input.type,
    scope: input.turnId
      ? { kind: "turn", turnId: input.turnId }
      : { kind: "thread" },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...input.data,
    },
  };
}

function agentIssue(state: AgentIssueStateValue): AgentIssue {
  const config = testConfig();
  return {
    id: "agent-issue-id",
    identifier: "AGENT-1",
    title: "Test agent",
    description: buildAgentIssueDescription(
      {
        harnessSessionId: "session-1",
        parentSessionId: null,
        worktreePath: "/tmp/worktree",
        branchName: "test-cube-3273",
        harness: "claude",
        machine: "macbook-air",
        role: "primary",
        lifecycle: "persistent",
        cubeIssueIdentifier: "CUBE-3273",
        bbThreadId: "thr_1",
      },
      {
        eventId: "session-event-1",
        generation: 1,
        occurredAt: "2026-08-13T00:00:00.000Z",
        cubeIssueIdentifier: "CUBE-3273",
      },
      config,
    ),
    team: { id: "agent-team-id", key: "AGENT" },
    assignee: null,
    state: { id: `state-${state}`, name: state, type: "started" },
    labels: {
      nodes: [
        { id: "label-claude", name: "Claude Code", parent: null },
      ],
    },
  };
}

interface RecordingLinear {
  dependencies: ProjectBbEventDependencies;
  creates: Array<{
    issueId: string;
    body: string;
    parentId?: string;
  }>;
  updates: Array<{ id: string; body: string }>;
  bodies: Map<string, string>;
  failParentIds: Set<string>;
  setOutput(output: string | null): void;
}

function recordingLinear(state: AgentIssueStateValue): RecordingLinear {
  const creates: RecordingLinear["creates"] = [];
  const updates: RecordingLinear["updates"] = [];
  const bodies = new Map<string, string>();
  const failParentIds = new Set<string>();
  const bbClient = createFakeBbClient([
    {
      id: "thr_1",
      projectId: "proj_test",
      environmentId: null,
      hostId: "host_air",
      providerId: "claude-code",
      title: null,
      status: "active",
      parentThreadId: null,
      archivedAt: null,
    },
  ]);
  bbClient.setExecutionOptions("thr_1", {
    model: "claude-opus-5",
    reasoningLevel: "high",
    permissionMode: "full",
    serviceTier: "default",
  });
  let output: string | null = null;
  bbClient.getThreadOutput = async () => output;
  let nextComment = 1;

  return {
    creates,
    updates,
    bodies,
    failParentIds,
    setOutput(value) {
      output = value;
    },
    dependencies: {
      bbClient,
      findIssue: async () => agentIssue(state),
      getIssue: async () => ({ id: "cube-issue-id" }),
      createComment: async (_apiKey, input) => {
        creates.push(input);
        if (input.parentId && failParentIds.has(input.parentId)) return null;
        const created: CreatedIssueComment = { id: `comment-${nextComment++}` };
        bodies.set(created.id, input.body);
        return created;
      },
      getCommentBody: async (_apiKey, commentId) =>
        bodies.get(commentId) ?? null,
      updateComment: async (_apiKey, commentId, body) => {
        updates.push({ id: commentId, body });
        bodies.set(commentId, body);
        return true;
      },
    },
  };
}

async function seedRecord(
  overrides: Partial<{
    sessionRootCommentId: string | null;
    lastErrorCommentId: string | null;
    lastErrorEventId: string | null;
    lastErrorTurnId: string | null;
    lastErrorAt: Date | null;
  }> = {},
) {
  database = await createTestDatabase();
  await database.prisma.agentIssueRecord.create({
    data: {
      harnessSessionId: "session-1",
      agentIssueId: "agent-issue-id",
      agentIssueIdentifier: "AGENT-1",
      machine: "macbook-air",
      bbThreadId: "thr_1",
      ...overrides,
    },
  });
  return database.prisma;
}

describe("bb event projection integration", () => {
  test("coalesces a provider error and its failed turn", async () => {
    const prisma = await seedRecord();
    const linear = recordingLinear("Error");
    await projectBbEvent(
      testConfig(),
      prisma,
      event({
        id: "provider-event",
        type: "provider/error",
        turnId: "turn-1",
        data: {
          detail: "API Error: 529 Overloaded.",
          errorInfo: { category: "overloaded", httpStatusCode: 529 },
        },
      }),
      linear.dependencies,
    );
    await projectBbEvent(
      testConfig(),
      prisma,
      event({
        id: "failed-event",
        type: "turn/completed",
        status: "failed",
        turnId: "turn-1",
      }),
      linear.dependencies,
    );

    expect(linear.creates).toHaveLength(2);
    expect(linear.creates[0]?.parentId).toBeUndefined();
    expect(linear.creates[0]?.body).toContain("claude-opus-5");
    expect(linear.creates[1]?.parentId).toBe("comment-1");
    expect(linear.creates[1]?.body).toContain("HTTP 529");
    expect(
      await prisma.agentIssueRecord.findUnique({
        where: { bbThreadId: "thr_1" },
      }),
    ).toMatchObject({
      sessionRootCommentId: "comment-1",
      lastErrorCommentId: "comment-2",
      lastErrorEventId: "provider-event",
      lastErrorTurnId: "turn-1",
    });
  });

  test("posts an unpaired failed turn as an error reply", async () => {
    const prisma = await seedRecord();
    const linear = recordingLinear("Error");
    await projectBbEvent(
      testConfig(),
      prisma,
      event({
        id: "failed-event",
        type: "turn/completed",
        status: "failed",
        turnId: "turn-2",
        data: { error: { message: "provider disconnected" } },
      }),
      linear.dependencies,
    );
    expect(linear.creates).toHaveLength(2);
    expect(linear.creates[1]?.body).toContain("provider disconnected");
  });

  test("creates one root and threads every healthy checkpoint under it", async () => {
    const prisma = await seedRecord();
    const linear = recordingLinear("Connected");
    linear.setOutput("Implementation complete.");
    for (const id of ["completed-1", "completed-2"]) {
      await projectBbEvent(
        testConfig(),
        prisma,
        event({
          id,
          type: "turn/completed",
          status: "completed",
          turnId: id,
        }),
        linear.dependencies,
      );
    }
    expect(linear.creates).toHaveLength(3);
    expect(linear.creates[0]?.parentId).toBeUndefined();
    expect(linear.creates.slice(1).map((input) => input.parentId)).toEqual([
      "comment-1",
      "comment-1",
    ]);
  });

  test("marks an open error recovered once and clears its state", async () => {
    const prisma = await seedRecord({
      sessionRootCommentId: "root-1",
      lastErrorCommentId: "error-1",
      lastErrorEventId: "provider-event",
      lastErrorTurnId: "turn-1",
      lastErrorAt: new Date(1_000),
    });
    const linear = recordingLinear("Connected");
    linear.bodies.set("error-1", "❌ bb agent error");
    const recovered = event({
      id: "completed-event",
      type: "turn/completed",
      status: "completed",
      turnId: "turn-2",
      createdAt: 93_000,
    });
    await projectBbEvent(testConfig(), prisma, recovered, linear.dependencies);
    await projectBbEvent(testConfig(), prisma, recovered, linear.dependencies);

    expect(linear.updates).toHaveLength(1);
    expect(linear.updates[0]?.body).toContain("✅ Recovered");
    expect(
      await prisma.agentIssueRecord.findUnique({
        where: { bbThreadId: "thr_1" },
      }),
    ).toMatchObject({
      lastErrorCommentId: null,
      lastErrorEventId: null,
      lastErrorTurnId: null,
      lastErrorAt: null,
    });
  });

  test("folds a repeat error into the existing notice", async () => {
    const prisma = await seedRecord({
      sessionRootCommentId: "root-1",
      lastErrorCommentId: "error-1",
      lastErrorEventId: "provider-event-1",
      lastErrorTurnId: "turn-1",
      lastErrorAt: new Date(1_000),
    });
    const linear = recordingLinear("Error");
    linear.bodies.set("error-1", "❌ bb agent error");
    await projectBbEvent(
      testConfig(),
      prisma,
      event({
        id: "provider-event-2",
        type: "provider/error",
        turnId: "turn-2",
        data: {
          detail: "still overloaded",
          errorInfo: { category: "overloaded" },
        },
      }),
      linear.dependencies,
    );
    expect(linear.creates).toHaveLength(0);
    expect(linear.updates).toHaveLength(1);
    expect(linear.updates[0]?.body).toContain("❌ Repeated");
    expect(
      await prisma.agentIssueRecord.findUnique({
        where: { bbThreadId: "thr_1" },
      }),
    ).toMatchObject({
      lastErrorCommentId: "error-1",
      lastErrorEventId: "provider-event-2",
      lastErrorTurnId: "turn-2",
    });
  });

  test("ignores an exact replay after the error state was stored", async () => {
    const prisma = await seedRecord({
      sessionRootCommentId: "root-1",
      lastErrorCommentId: "error-1",
      lastErrorEventId: "provider-event",
      lastErrorTurnId: "turn-1",
      lastErrorAt: new Date(1_000),
    });
    const linear = recordingLinear("Error");
    await projectBbEvent(
      testConfig(),
      prisma,
      event({
        id: "provider-event",
        type: "provider/error",
        turnId: "turn-1",
      }),
      linear.dependencies,
    );
    expect(linear.creates).toHaveLength(0);
    expect(linear.updates).toHaveLength(0);
  });

  test("recreates a missing root and retries the reply once", async () => {
    const prisma = await seedRecord({ sessionRootCommentId: "old-root" });
    const linear = recordingLinear("Connected");
    linear.failParentIds.add("old-root");
    linear.setOutput("Checkpoint ready.");
    await projectBbEvent(
      testConfig(),
      prisma,
      event({
        id: "completed-event",
        type: "turn/completed",
        status: "completed",
        turnId: "turn-1",
      }),
      linear.dependencies,
    );

    expect(linear.creates).toHaveLength(3);
    expect(linear.creates[0]?.parentId).toBe("old-root");
    expect(linear.creates[1]?.parentId).toBeUndefined();
    expect(linear.creates[2]?.parentId).toBe("comment-1");
    expect(
      await prisma.agentIssueRecord.findUnique({
        where: { bbThreadId: "thr_1" },
      }),
    ).toMatchObject({ sessionRootCommentId: "comment-1" });
  });
});
