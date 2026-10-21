import { existsSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { RepositoryConfig } from "../../../../lib/config.ts";
import { provisionWorktree, worktreePathForBranch } from "../launches/provision-worktree.ts";

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Git preparation failed: ${err.trim()}`);
  return out.trim();
}

/** Reserve identity before creating anything. A retry may reuse only the
 * recorded path, repository and branch; never an unrelated existing branch. */
export async function provisionTaskWorktree(prisma: PrismaClient, taskId: string, repository: RepositoryConfig, directoryName: string): Promise<string> {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  if (task.repositoryId !== repository.id) throw new Error("Task repository mismatch");
  const worktreePath = task.worktreePath ?? (directoryName
    ? path.resolve(repository.worktreeRoot, directoryName)
    : worktreePathForBranch(repository.worktreeRoot, task.branchName));
  const relative = path.relative(repository.worktreeRoot, worktreePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Task worktree escapes the configured root");
  if (!task.worktreePath && existsSync(worktreePath)) throw new Error("Unowned worktree already exists at the requested path");
  const baseCommit = task.baseCommit ?? await git(repository.root, ["rev-parse", "--verify", "--end-of-options", `${repository.baseBranch ?? "main"}^{commit}`]);
  await prisma.remoteTask.update({ where: { id: taskId }, data: { worktreePath, baseCommit } });
  if (existsSync(worktreePath)) {
    const [branch, common, expectedCommon] = await Promise.all([
      git(worktreePath, ["branch", "--show-current"]),
      git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(repository.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    if (branch !== task.branchName || common !== expectedCommon) throw new Error("Recorded worktree identity changed; reconcile before retrying");
    return worktreePath;
  }
  return provisionWorktree({ repository: { ...repository, preparation: "agent" }, branchName: task.branchName, directoryName: relative, baseBranch: baseCommit });
}
