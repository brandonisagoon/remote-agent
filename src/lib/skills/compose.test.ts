import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import path from "node:path";

import {
  composeForPrompt,
  renderSkillToken,
  resolveSkillPlaceholders,
  skillsetsFromPrompt,
} from "./compose.ts";
import { repoRoot } from "../../test-support/repo.ts";

const FAKE_CLI = path.join(repoRoot(), "src", "test-support", "fake-skill-composer.ts");
let previous: string | undefined;

beforeEach(() => {
  chmodSync(FAKE_CLI, 0o755);
  previous = process.env.REMOTE_AGENT_SKILL_COMPOSER;
  process.env.REMOTE_AGENT_SKILL_COMPOSER = FAKE_CLI;
});

afterEach(() => {
  if (previous === undefined) delete process.env.REMOTE_AGENT_SKILL_COMPOSER;
  else process.env.REMOTE_AGENT_SKILL_COMPOSER = previous;
});

describe("skill token grammar", () => {
  test("renders sorted, deduplicated flags", () => {
    expect(renderSkillToken({ skillset: "plan", flags: ["z", "a", "a"] })).toBe("{{SKILL:plan+a+z}}");
    expect(renderSkillToken({ skillset: "plan", flags: [] })).toBe("{{SKILL:plan}}");
  });

  test("scans and dedupes selections from a prompt", () => {
    const selections = skillsetsFromPrompt(
      "Use {{SKILL:plan+tunnel}} then {{SKILL:plan+tunnel}} and {{SKILL:describe}}.",
    );
    expect(selections).toEqual([
      { token: "plan+tunnel", skillset: "plan", flags: ["tunnel"] },
      { token: "describe", skillset: "describe", flags: [] },
    ]);
  });
});

describe("composeForPrompt", () => {
  test("composes each selection and resolves harness-specific invocations", async () => {
    const claude = await composeForPrompt("/tmp", "Use {{SKILL:plan+tunnel}}.", "claude");
    expect(claude).toBe("Use /skill-composer-plan-flags-tunnel.");
    const codex = await composeForPrompt("/tmp", "Use {{SKILL:plan+tunnel}}.", "codex");
    expect(codex).toBe("Use $skill-composer-plan-flags-tunnel.");
  });

  test("passes prompts without tokens through untouched", async () => {
    expect(await composeForPrompt("/tmp", "no tokens here", "claude")).toBe("no tokens here");
  });

  test("fails on unknown skillsets with the composer's message", async () => {
    await expect(composeForPrompt("/tmp", "{{SKILL:missing}}", "claude")).rejects.toThrow(
      "Unknown skillset: missing",
    );
  });

  test("rejects a composed skill incompatible with the session harness", async () => {
    await expect(composeForPrompt("/tmp", "{{SKILL:codex-only}}", "claude")).rejects.toThrow(
      "incompatible with 'claude'",
    );
  });

  test("resolve throws for tokens that were never composed", () => {
    expect(() => resolveSkillPlaceholders("{{SKILL:plan}}", "claude", new Map())).toThrow(
      "Unknown composed skillset",
    );
  });
});
