import { describe, expect, spyOn, test } from "bun:test";

import type { PrismaClient } from "../../../generated/prisma/client.ts";
import { createFakeBbClient } from "../../../test-support/bb.ts";
import { testConfig } from "../../../test-support/config.ts";
import type { BbModel } from "../../../types/runtime/index.ts";
import { ModelResolutionError } from "./resolve-model.ts";
import {
  launchExecutionSettings,
  spawnAgentThread,
  type SpawnAgentThreadInput,
} from "./spawn.ts";

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

function launchInput(
  overrides: Partial<SpawnAgentThreadInput> = {},
): SpawnAgentThreadInput {
  return {
    config: testConfig(),
    prisma: {} as PrismaClient,
    bbClient: createFakeBbClient(),
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

describe("launchExecutionSettings", () => {
  test("preserves the previous Codex primary execution mode", () => {
    expect(launchExecutionSettings("codex")).toEqual({
      permissionMode: "full",
      reasoningLevel: "high",
      serviceTier: "default",
    });
  });

  test("preserves the previous Claude delegate permission mode", () => {
    expect(launchExecutionSettings("claude")).toEqual({
      permissionMode: "auto",
      reasoningLevel: "high",
      serviceTier: undefined,
    });
  });
});

describe("spawnAgentThread model resolution", () => {
  test("rejects an unknown model before spawning", async () => {
    const bbClient = createFakeBbClient();
    bbClient.setModels("claude-code", [model("claude-fable-5")]);

    await expect(
      spawnAgentThread(launchInput({ bbClient, model: "unknown-model" })),
    ).rejects.toBeInstanceOf(ModelResolutionError);
    expect(bbClient.spawnInputs).toHaveLength(0);
  });

  test("forwards the resolved catalog ID to bb", async () => {
    const bbClient = createFakeBbClient();
    bbClient.setModels("claude-code", [model("claude-fable-5")]);
    bbClient.spawnThread = async (input) => {
      bbClient.spawnInputs.push(input);
      throw new Error("captured spawn input");
    };

    await expect(spawnAgentThread(launchInput({ bbClient }))).rejects.toThrow(
      "captured spawn input",
    );
    expect(bbClient.spawnInputs[0]?.model).toBe("claude-fable-5");
  });

  test("preserves the requested alias when the catalog is unavailable", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const bbClient = createFakeBbClient();
    bbClient.spawnThread = async (input) => {
      bbClient.spawnInputs.push(input);
      throw new Error("captured spawn input");
    };

    try {
      await expect(spawnAgentThread(launchInput({ bbClient }))).rejects.toThrow(
        "captured spawn input",
      );
      expect(bbClient.spawnInputs[0]?.model).toBe("fable");
    } finally {
      warning.mockRestore();
    }
  });
});
