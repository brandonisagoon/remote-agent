import { describe, expect, spyOn, test } from "bun:test";

import type { BbModel } from "../../../types/runtime/index.ts";
import {
  matchCatalogModel,
  ModelResolutionError,
  resolveLaunchModel,
} from "./resolve-model.ts";

function model(
  id: string,
  options: { model?: string; isDefault?: boolean } = {},
): BbModel {
  return {
    id,
    model: options.model ?? id,
    displayName: id,
    description: id,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "high",
    isDefault: options.isDefault ?? false,
  };
}

const catalog = [
  model("claude-fable-5"),
  model("claude-opus-5[1m]", { isDefault: true }),
  model("claude-opus-4-8[1m]"),
  model("claude-sonnet-5"),
];

describe("matchCatalogModel", () => {
  test("matches exact catalog IDs case-insensitively", () => {
    expect(matchCatalogModel(catalog, "Claude-Fable-5", "claude-code").id).toBe(
      "claude-fable-5",
    );
  });

  test("matches the provider model field", () => {
    const models = [model("catalog-fable", { model: "claude-fable-5-wire" })];
    expect(
      matchCatalogModel(models, "claude-fable-5-wire", "claude-code").id,
    ).toBe("catalog-fable");
  });

  test("resolves unique aliases", () => {
    expect(matchCatalogModel(catalog, "fable", "claude-code").id).toBe(
      "claude-fable-5",
    );
    expect(matchCatalogModel(catalog, "sonnet", "claude-code").id).toBe(
      "claude-sonnet-5",
    );
  });

  test("prefers the catalog default for an ambiguous alias", () => {
    expect(matchCatalogModel(catalog, "opus", "claude-code").id).toBe(
      "claude-opus-5[1m]",
    );
  });

  test("uses all requested tokens to narrow an alias", () => {
    expect(matchCatalogModel(catalog, "opus-5", "claude-code").id).toBe(
      "claude-opus-5[1m]",
    );
  });

  test("throws when an alias has no unique or default match", () => {
    const models = [model("claude-opus-5"), model("claude-opus-4-8")];

    try {
      matchCatalogModel(models, "opus", "claude-code");
      throw new Error("expected model resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelResolutionError);
      expect((error as ModelResolutionError).reason).toBe("ambiguous");
    }
  });

  test("throws with available IDs for an unknown model", () => {
    try {
      matchCatalogModel(catalog, "haiku", "claude-code");
      throw new Error("expected model resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelResolutionError);
      expect((error as ModelResolutionError).reason).toBe("unknown");
      expect((error as ModelResolutionError).availableModelIds).toEqual(
        catalog.map((entry) => entry.id),
      );
    }
  });
});

describe("resolveLaunchModel", () => {
  test("skips catalog lookup when no model was requested", async () => {
    let calls = 0;
    const resolved = await resolveLaunchModel({
      bbClient: {
        async listModels() {
          calls += 1;
          return catalog;
        },
      },
      providerId: "codex",
    });

    expect(resolved).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("returns the canonical catalog ID", async () => {
    const resolved = await resolveLaunchModel({
      bbClient: {
        async listModels() {
          return catalog;
        },
      },
      providerId: "claude-code",
      hostId: "host_air",
      requested: "fable",
    });

    expect(resolved).toBe("claude-fable-5");
  });

  test("passes through when the catalog is empty", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = await resolveLaunchModel({
        bbClient: {
          async listModels() {
            return [];
          },
        },
        providerId: "claude-code",
        requested: "fable",
      });

      expect(resolved).toBe("fable");
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test("passes through when catalog lookup fails", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = await resolveLaunchModel({
        bbClient: {
          async listModels() {
            throw new Error("catalog offline");
          },
        },
        providerId: "claude-code",
        requested: "fable",
      });

      expect(resolved).toBe("fable");
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
