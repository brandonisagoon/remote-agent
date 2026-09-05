import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../generated/prisma/client.ts";
import { createApp } from "../../app.ts";
import { createFakeAgentRuntime } from "../../test-support/agent-runtime.ts";
import { testConfig } from "../../test-support/config.ts";

describe("POST /api/launches", () => {
  test("rejects a relative worktree before launching", async () => {
    const agentRuntime = createFakeAgentRuntime();
    const app = createApp({
      config: testConfig(),
      agentRuntime,
      prisma: {} as PrismaClient,
    });

    const response = await app.request("/api/launches", {
      method: "POST",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        issueIdentifier: "CUBE-3278",
        harness: "claude",
        prompt: "Plan CUBE-3278",
        machine: "macbook-air",
        worktreePath: "tmp/cube-3278",
        lifecycle: "persistent",
        role: "delegate",
      }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("worktreePath must be absolute");
    expect(agentRuntime.ensureInputs).toHaveLength(0);
  });
});
