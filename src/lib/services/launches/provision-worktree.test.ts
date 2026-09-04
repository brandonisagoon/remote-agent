import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RepositoryConfig } from "../../config.ts";
import { provisionWorktree, worktreePathForBranch } from "./index.ts";

let directory: string | null = null;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

function fixture(): RepositoryConfig {
  directory = mkdtempSync(path.join(tmpdir(), "remote-agent-host-repo-"));
  const root = path.join(directory, "repository");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts", "bootstrap.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\ntouch .bootstrapped\n",
    { mode: 0o755 },
  );
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "config", "user.name", "Fixture");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");

  return {
    id: "fixture",
    name: "Fixture",
    root,
    worktreeRoot: path.join(directory, "worktrees"),
    bootstrapCommand: ["bash", "scripts/bootstrap.sh"],
    skillsRoot: "agent-skills",
    workflows: {},
    metadata: { tags: {} },
    sessionDefaults: { tags: {} },
  };
}

describe("host repository contract", () => {
  test("provisions and bootstraps a configured worktree", async () => {
    const repository = fixture();
    const worktree = await provisionWorktree({
      repository,
      branchName: "feature/demo-42",
    });

    expect(worktree).toBe(
      worktreePathForBranch(repository.worktreeRoot, "feature/demo-42"),
    );
    expect(existsSync(path.join(worktree, ".bootstrapped"))).toBeTrue();
  });
});
