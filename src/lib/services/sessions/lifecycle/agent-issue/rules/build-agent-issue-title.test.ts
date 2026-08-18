import { describe, expect, test } from "bun:test";

import type { SessionRuntime } from "../../../../../../types/sessions/index.ts";
import { buildAgentIssueTitle } from "./index.ts";

describe("buildAgentIssueTitle", () => {
  const runtime: SessionRuntime = {
    harnessSessionId: "thr_a1b2c3d4",
    parentSessionId: null,
    worktreePath: "/tmp/worktree",
    branchName: "example-cube-2600",
    harness: "claude",
    machine: "macbook-air",
    role: "primary",
    bbThreadId: "agent",
  };

  test("puts the source and role before the harness", () => {
    expect(buildAgentIssueTitle(runtime, "CUBE-2600")).toBe(
      "CUBE-2600 · Primary · Claude Code · a1b2c3d4",
    );
  });

  test("puts Unrelated first when there is no source", () => {
    expect(buildAgentIssueTitle(runtime, null)).toBe(
      "Unrelated · Primary · Claude Code · a1b2c3d4",
    );
  });

  test("uses the Codex harness label", () => {
    expect(
      buildAgentIssueTitle(
        { ...runtime, harness: "codex", role: "delegate" },
        "CUBE-2600",
      ),
    ).toBe("CUBE-2600 · Delegate · Codex · a1b2c3d4");
  });
});
