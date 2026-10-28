import { mkdirSync } from "node:fs";
import path from "node:path";

import type { RepositoryConfig } from "../../../../lib/config.ts";
import { resolveWorktreeBase } from "./worktree-base.ts";

export interface ProvisionWorktreeInput {
  repository: RepositoryConfig;
  branchName: string;
  /** Directory name under worktreeRoot; defaults to the flattened branch. */
  directoryName?: string;
  baseBranch?: string;
}

async function run(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...Bun.env, ...env },
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

/** Server-owned phase: the git surgery. Derives the directory from the
    branch (provider-supplied — the server never invents branch names) and
    creates the branch + working copy off the base in one step. */
async function createWorktree(
  input: ProvisionWorktreeInput,
  worktreePath: string,
): Promise<void> {
  const baseCommit = await resolveWorktreeBase(input.repository.root, input.baseBranch ?? input.repository.baseBranch ?? "main");
  mkdirSync(input.repository.worktreeRoot, { recursive: true });
  await run(
    [
      "git",
      "-C",
      input.repository.root,
      "worktree",
      "add",
      "-b",
      input.branchName,
      worktreePath,
      baseCommit,
    ],
    input.repository.root,
  );
}

/** Repository-owned phase: the repo's own bootstrap command, run once in
    the fresh worktree. The server's entire contract: non-zero exit fails
    the launch. What the command does is the repository's business. */
async function runRepositoryBootstrap(
  input: ProvisionWorktreeInput,
  worktreePath: string,
): Promise<void> {
  await run(input.repository.bootstrapCommand, worktreePath);
}

export async function provisionWorktree(
  input: ProvisionWorktreeInput,
): Promise<string> {
  const worktreePath = input.directoryName
    ? path.join(input.repository.worktreeRoot, input.directoryName)
    : worktreePathForBranch(input.repository.worktreeRoot, input.branchName);
  const relative = path.relative(input.repository.worktreeRoot, worktreePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Worktree must be a child of the configured worktree root");
  }
  await createWorktree(input, worktreePath);
  if (input.repository.preparation !== "agent") await runRepositoryBootstrap(input, worktreePath);
  return worktreePath;
}
