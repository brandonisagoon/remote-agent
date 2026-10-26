import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testConfig } from "../../../../test-support/config.ts";
import { provisionWorktree } from "./provision-worktree.ts";
import { resolveWorktreeBase } from "./worktree-base.ts";

let directory: string;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture() {
  directory = mkdtempSync(path.join(tmpdir(), "remote-agent-fresh-base-"));
  const remote = path.join(directory, "upstream");
  const root = path.join(directory, "checkout");
  mkdirSync(remote);
  git(remote, "init", "-b", "staging");
  git(remote, "config", "user.name", "Fixture");
  git(remote, "config", "user.email", "fixture@example.com");
  commit(remote, "initial");
  git(directory, "clone", remote, root);
  const repository = { ...testConfig().repository, root, worktreeRoot: path.join(directory, "worktrees"), baseBranch: "origin/staging", preparation: "agent" as const };
  return { remote, repository };
}

function commit(root: string, content: string): string {
  writeFileSync(path.join(root, "README.md"), content);
  git(root, "add", "README.md");
  git(root, "commit", "-m", content);
  return git(root, "rev-parse", "HEAD");
}

test("new parallel worktrees use fetched staging without changing the source checkout", async () => {
  const { remote, repository } = fixture();
  const original = git(repository.root, "rev-parse", "HEAD");
  writeFileSync(path.join(repository.root, "README.md"), "owner edits");
  const latest = commit(remote, "new staging");
  const worktrees = await Promise.all(["one", "two"].map((name) => provisionWorktree({ repository, branchName: `feature/${name}` })));
  for (const worktree of worktrees) expect(git(worktree, "rev-parse", "HEAD")).toBe(latest);
  expect(git(repository.root, "rev-parse", "HEAD")).toBe(original);
  expect(readFileSync(path.join(repository.root, "README.md"), "utf8")).toBe("owner edits");
  const next = commit(remote, "later staging");
  expect(await resolveWorktreeBase(repository.root, "refs/remotes/origin/staging")).toBe(next);
  expect(await resolveWorktreeBase(repository.root, "origin/HEAD")).toBe(next);
});

test("failed fetch blocks a new worktree instead of using cached staging, and can be retried", async () => {
  const { remote, repository } = fixture();
  const cached = git(repository.root, "rev-parse", "origin/staging");
  const latest = commit(remote, "unfetched staging");
  git(repository.root, "remote", "set-url", "origin", path.join(directory, "missing"));
  await expect(provisionWorktree({ repository, branchName: "feature/blocked" })).rejects.toThrow("Worktree base preparation failed");
  expect(existsSync(repository.worktreeRoot)).toBeFalse();
  expect(git(repository.root, "branch", "--list", "feature/blocked")).toBe("");
  expect(git(repository.root, "rev-parse", "origin/staging")).toBe(cached);
  git(repository.root, "remote", "set-url", "origin", remote);
  const worktree = await provisionWorktree({ repository, branchName: "feature/blocked" });
  expect(git(worktree, "rev-parse", "HEAD")).toBe(latest);
});

test("explicit commits and local branches remain usable offline, but orphaned remote refs do not", async () => {
  const { repository } = fixture();
  const original = git(repository.root, "rev-parse", "HEAD");
  git(repository.root, "remote", "set-url", "origin", path.join(directory, "missing"));
  expect(await resolveWorktreeBase(repository.root, original)).toBe(original);
  expect(await resolveWorktreeBase(repository.root, "staging")).toBe(original);
  git(repository.root, "config", "--remove-section", "remote.origin");
  await expect(resolveWorktreeBase(repository.root, "origin/staging")).rejects.toThrow("not configured");
});
