import { mkdirSync } from "node:fs";
import path from "node:path";

import type { RepositoryConfig } from "../../config.ts";

export interface ProvisionWorktreeInput {
  repository: RepositoryConfig;
  branchName: string;
  baseBranch?: string;
}

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(args, {
    cwd,
    env: Bun.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${args.join(" ")}`);
  }
}

export function worktreePathForBranch(
  worktreeRoot: string,
  branchName: string,
): string {
  const safeName = branchName.replaceAll("/", "-").replaceAll(" ", "-");
  return path.join(worktreeRoot, safeName);
}

export async function provisionWorktree(
  input: ProvisionWorktreeInput,
): Promise<string> {
  const { repository } = input;
  const worktreePath = worktreePathForBranch(
    repository.worktreeRoot,
    input.branchName,
  );
  mkdirSync(repository.worktreeRoot, { recursive: true });
  await run(
    [
      "git",
      "-C",
      repository.root,
      "worktree",
      "add",
      "-b",
      input.branchName,
      worktreePath,
      input.baseBranch ?? "main",
    ],
    repository.root,
  );
  await run(repository.bootstrapCommand, worktreePath);
  return worktreePath;
}
