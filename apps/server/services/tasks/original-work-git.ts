import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import os from "node:os";
import { archiveMember as member, readArchiveBytes as bytes } from "./archive-observation.ts";
import { observeCompletionSnapshot } from "./completion-observation.ts";
import { OriginalWorkSnapshot } from "./original-work-schema.ts";
const MAX_BYTES = 512 * 1024 * 1024;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export async function originalWorkGit(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false; const timeout = setTimeout(() => { timedOut = true; child.kill(9); }, 30_000);
  const bounded = async (stream: ReadableStream<Uint8Array>, limit: number) => {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) return Buffer.concat(chunks); length += value.byteLength; if (length > limit) { child.kill(9); throw new Error("Original-work Git output exceeded its bound"); } chunks.push(value); } }
    finally { reader.releaseLock(); }
  };
  try {
    const [out, err, code] = await Promise.all([bounded(child.stdout, MAX_BYTES), bounded(child.stderr, 1024 * 1024), child.exited]);
    if (timedOut || code !== 0 || out.byteLength > MAX_BYTES || err.byteLength > 1024 * 1024) throw new Error("Original-work Git proof failed");
    return Buffer.from(out);
  } finally { clearTimeout(timeout); }
}
export const originalWorkTextGit = async (cwd: string, args: string[]) => (await originalWorkGit(cwd, args)).toString().trimEnd();
export const originalWorkCompletionSnapshot = (cwd: string, administrativeDirectory?: string) => observeCompletionSnapshot(cwd, { async run(command, args, options) {
  if (command !== "git" || !options?.cwd) throw new Error("Unexpected original-work observation command");
  return { ok: true, stdout: (await originalWorkGit(options.cwd, [...(administrativeDirectory ? ["--git-dir", administrativeDirectory, "--work-tree", cwd] : []), ...args])).toString(), stderr: "" };
} });

export async function originalWorkDirtySnapshot(worktree: string, administrativeDirectory?: string) {
  const observed = await originalWorkCompletionSnapshot(worktree, administrativeDirectory);
  const git = (args: string[]) => originalWorkGit(worktree, [...(administrativeDirectory ? ["--git-dir", administrativeDirectory, "--work-tree", worktree] : []), ...args]);
  const indexPatch = await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--cached", "HEAD"]);
  const worktreePatch = await git(["diff", "--binary", "--no-ext-diff", "--no-textconv"]);
  const paths = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean).sort();
  const untracked = [];
  for (const relative of paths) { const file = member(worktree, relative), content = await bytes(file); untracked.push({ path: relative, size: content.length, sha256: sha(content), executable: Boolean((await lstat(file)).mode & 0o111) }); }
  return OriginalWorkSnapshot.parse({ ...observed, indexPatchSha256: sha(indexPatch), worktreePatchSha256: sha(worktreePatch), untracked });
}
