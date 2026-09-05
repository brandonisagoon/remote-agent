import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../generated/prisma/client.ts";
import { createFakeAgentRuntime } from "../../../test-support/agent-runtime.ts";
import { testConfig } from "../../../test-support/config.ts";
import { spawnAgentThread, type SpawnAgentThreadInput } from "./spawn.ts";

function launchInput(
  overrides: Partial<SpawnAgentThreadInput> = {},
): SpawnAgentThreadInput {
  return {
    config: testConfig(),
    prisma: {} as PrismaClient,
    agentRuntime: createFakeAgentRuntime(),
    launchKey: "run-3278",
    issueIdentifier: "CUBE-3278",
    harness: "claude",
    model: "fable",
    prompt: "Plan CUBE-3278",
    machine: "macbook-air",
    worktreePath: "/tmp/cube-3278",
    lifecycle: "persistent",
    role: "delegate",
    ...overrides,
  };
}

describe("spawnAgentThread", () => {
  test("ensures a metadata-complete session and enqueues it", async () => {
    const runtime = createFakeAgentRuntime();
    const launched = await spawnAgentThread(launchInput({ agentRuntime: runtime }));

    expect(runtime.ensureInputs).toEqual([
      expect.objectContaining({
        sessionKey: "run-3278",
        agent: "claude",
        cwd: "/tmp/cube-3278",
        model: "fable",
        repositoryId: "test-repository",
        machineId: "macbook-air",
        role: "delegate",
        resourceLinks: [{
          provider: "linear",
          connectionId: "linear-test",
          resourceType: "issue-identifier",
          externalId: "CUBE-3278",
          relationship: "handles",
        }],
      }),
    ]);
    expect(launched.agentIssue).toBeNull();
    expect(runtime.sentMessages).toEqual([
      {
        sessionId: launched.session.id,
        text: "Plan CUBE-3278",
        requestId: "launch:run-3278",
      },
    ]);
  });

  test("closes the acpx session when its initial enqueue fails", async () => {
    const runtime = createFakeAgentRuntime();
    runtime.enqueue = async () => {
      throw new Error("enqueue failed");
    };
    await expect(
      spawnAgentThread(launchInput({ agentRuntime: runtime })),
    ).rejects.toThrow("enqueue failed");
    expect(runtime.closedSessionIds).toEqual(["runtime-1"]);
    expect(runtime.sentMessages).toHaveLength(0);
  });
});
