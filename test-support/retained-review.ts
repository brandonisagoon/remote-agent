import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Real detached Git checkout and original private review receipt. No provider
 * effects: callers own the temporary root and register anchorData in their DB. */
export async function retainedReviewFixture(root: string, taskId: string, toolingRevision: string) {
  const worktree = path.join(root, "product"); await mkdir(worktree);
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim();
  };
  git(worktree, "init", "-q"); git(worktree, "config", "user.name", "Fixture"); git(worktree, "config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(worktree, "source.txt"), "reviewed"); git(worktree, "add", "."); git(worktree, "commit", "-qm", "Reviewed source");
  const revision = git(worktree, "rev-parse", "HEAD"), directory = path.join(root, "reviews", taskId, revision);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const checkout = path.join(directory, "checkout"), file = path.join(directory, "receipt.json"), expiresAt = new Date(Date.now() + 86400000);
  git(worktree, "worktree", "add", "--detach", checkout, revision);
  const receipt = { version: 1, taskId, revision, worktree: checkout, commonGitDirectory: git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    expiresAt: expiresAt.toISOString(), state: "prepared", error: null };
  await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
  git(worktree, "commit", "--allow-empty", "-qm", "Later development");
  return { worktree, checkout, revision, file, receipt, git, anchorData: { taskId, key: `review-${revision}`, kind: "git-worktree", purpose: "review", state: "ready", externalId: checkout, expiresAt,
    metadata: { revision, toolingRevision, receipt: file, reviewEnvironments: [`review-${revision}`] } } };
}
