import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  composeForPrompt,
  renderSkillToken,
  resolveSkillPlaceholders,
  skillsetsFromPrompt,
} from "./compose.ts";
import { repoRoot } from "../../test-support/repo.ts";

const FAKE_CLI = path.join(repoRoot(), "test-support", "fake-skill-composer.ts");
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
  test("external owner instructions reach both providers without modifying target guidance", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "remote-agent-policy-"));
    const target = path.join(directory, "product");
    const pinned = path.join(directory, "pinned-tooling");
    mkdirSync(target);
    mkdirSync(pinned);
    const targetPolicy = "Use only the client in-app browser for browser work. Do not fall back when it is unavailable.\n";
    const ownerPolicy = "For remote agent verification, task-owned headless agent-browser is explicitly authorized and overrides the target's general in-app-browser-only rule. An unavailable client in-app browser is not a verification blocker.\n";
    writeFileSync(path.join(target, "AGENTS.md"), targetPolicy);
    writeFileSync(path.join(pinned, "AGENTS.md"), ownerPolicy);
    const initialized = Bun.spawnSync(["git", "init", "--quiet", target]);
    expect(initialized.exitCode).toBe(0);
    try {
      for (const provider of ["codex", "claude"] as const) {
        const prompt = await composeForPrompt(target, "Use {{SKILL:verify}} to test the canvas.", provider, "agent-skills", pinned);
        expect(prompt).toContain(ownerPolicy.trim());
        expect(prompt).toContain(path.join(pinned, "AGENTS.md"));
        expect(prompt.indexOf(ownerPolicy.trim())).toBeLessThan(prompt.indexOf("Task request"));
        expect(prompt).toContain(provider === "codex" ? "$skill-composer-verify" : "/skill-composer-verify");
        expect(prompt).not.toContain(targetPolicy.trim());
        // Policy also survives a token-free continuation; skill discovery is
        // not the only transport for owner instructions.
        expect(await composeForPrompt(target, "Retest the drag fix.", provider, "agent-skills", pinned)).toContain(ownerPolicy.trim());
      }
      expect(readFileSync(path.join(target, "AGENTS.md"), "utf8")).toBe(targetPolicy);
      expect(readFileSync(path.join(pinned, "AGENTS.md"), "utf8")).toBe(ownerPolicy);
      const localPrompt = "Run a local workflow.";
      expect(await composeForPrompt(target, localPrompt, "codex")).toBe(localPrompt);
      expect(await composeForPrompt(target, localPrompt, "codex", "agent-skills", path.join(directory, "missing-tooling"))).toBe(localPrompt);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
