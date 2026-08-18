import { mkdirSync } from "node:fs";
import path from "node:path";

export interface ProvisionWorktreeInput {
  repoRoot: string;
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
  repoRoot: string,
  branchName: string,
): string {
  const safeName = branchName.replaceAll("/", "-").replaceAll(" ", "-");
  return path.join(path.dirname(repoRoot), ".worktrees", safeName);
}

export async function provisionWorktree(
  input: ProvisionWorktreeInput,
): Promise<string> {
  const worktreePath = worktreePathForBranch(input.repoRoot, input.branchName);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  await run(
    [
      "git",
      "-C",
      input.repoRoot,
      "worktree",
      "add",
      "-b",
      input.branchName,
      worktreePath,
      input.baseBranch ?? "main",
    ],
    input.repoRoot,
  );
  await run(
    ["bash", path.join(worktreePath, "scripts/workspace/worktree/bootstrap.sh")],
    worktreePath,
  );
  return worktreePath;
}
