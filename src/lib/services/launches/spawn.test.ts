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
  test("ensures, registers, and enqueues one acpx session", async () => {
    const runtime = createFakeAgentRuntime();
    let registeredRuntime: unknown;
    const launched = await spawnAgentThread(
      launchInput({ agentRuntime: runtime }),
      {
        register: async (_config, event) => {
          registeredRuntime = event.runtime;
          return null;
        },
      },
    );

    expect(runtime.ensureInputs).toEqual([
      expect.objectContaining({
        sessionKey: "run-3278",
        agent: "claude",
        cwd: "/tmp/cube-3278",
        model: "fable",
      }),
    ]);
    expect(registeredRuntime).toMatchObject({
      harnessSessionId: launched.session.id,
      runtimeSessionId: launched.session.id,
      lifecycle: "persistent",
      role: "delegate",
    });
    expect(runtime.sentMessages).toEqual([
      {
        sessionId: launched.session.id,
        text: "Plan CUBE-3278",
        requestId: "launch:run-3278",
      },
    ]);
  });

  test("closes the acpx session when Linear registration fails", async () => {
    const runtime = createFakeAgentRuntime();
    await expect(
      spawnAgentThread(launchInput({ agentRuntime: runtime }), {
        register: async () => {
          throw new Error("registration failed");
        },
      }),
    ).rejects.toThrow("registration failed");
    expect(runtime.closedSessionIds).toEqual(["runtime-1"]);
    expect(runtime.sentMessages).toHaveLength(0);
  });
});
