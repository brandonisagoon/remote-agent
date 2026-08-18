import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../generated/prisma/client.ts";
import { createApp } from "../../app.ts";
import { createFakeBbClient } from "../../test-support/bb.ts";
import { testConfig } from "../../test-support/config.ts";
import type { BbModel } from "../../types/runtime/index.ts";

function model(id: string): BbModel {
  return {
    id,
    model: id,
    displayName: id,
    description: id,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "high",
    isDefault: false,
  };
}

describe("POST /api/launches", () => {
  test("returns 422 when a requested model is absent from the catalog", async () => {
    const bbClient = createFakeBbClient();
    bbClient.setModels("claude-code", [
      model("claude-fable-5"),
      model("claude-sonnet-5"),
    ]);
    const app = createApp({
      config: testConfig(),
      bbClient,
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
        model: "no-such-model",
        prompt: "Plan CUBE-3278",
        machine: "macbook-air",
        worktreePath: "/tmp/cube-3278",
        lifecycle: "persistent",
        role: "delegate",
      }),
    });
    const body = (await response.json()) as {
      requestedModel: string;
      availableModels: string[];
    };

    expect(response.status).toBe(422);
    expect(body.requestedModel).toBe("no-such-model");
    expect(body.availableModels).toEqual(["claude-fable-5", "claude-sonnet-5"]);
    expect(bbClient.spawnInputs).toHaveLength(0);
  });
});
