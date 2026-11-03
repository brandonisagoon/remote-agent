import { lstat, realpath } from "node:fs/promises";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";

/** Read the original task worktree, never a caller-supplied commit override. */
export async function readComputeWorktreeRevision(worktree: string): Promise<string> {
  if (await realpath(worktree) !== worktree || !(await lstat(worktree)).isDirectory()) throw new Error("Compute worktree ownership changed");
  const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const revision = (await executeOwnedObserver(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: worktree, timeoutMs: 5_000, env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  })).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Compute worktree revision is unavailable");
  return revision;
}
