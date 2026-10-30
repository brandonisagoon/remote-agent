import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OriginalWorkInput } from "../apps/server/services/tasks/original-work-schema.ts";

export const originalDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function originalGit(cwd: string, args: string[], env?: Record<string, string>) {
  const result = Bun.spawnSync(["git", ...args], { cwd, ...(env ? { env: { ...process.env, ...env } } : {}), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout;
}
/** Fixture-only archive producer. Never called by production adoption. */
export async function originalArchiveFixture(worktree: string, archive: string, archiveResourceId: string): Promise<OriginalWorkInput> {
  await mkdir(archive, { mode: 0o700 });
  await writeFile(path.join(worktree, "staged.txt"), "saved staged work\n"); originalGit(worktree, ["add", "staged.txt"]);
  await writeFile(path.join(worktree, "README.md"), "unfinished original change\n");
  await writeFile(path.join(worktree, "untracked.bin"), Buffer.from([0, 255, 1, 10]));
  originalGit(worktree, ["bundle", "create", path.join(archive, "source.bundle"), "--all"]);
  await writeFile(path.join(archive, "index.diff"), originalGit(worktree, ["diff", "--binary", "--cached", "HEAD"]));
  await writeFile(path.join(archive, "worktree.diff"), originalGit(worktree, ["diff", "--binary"]));
  const tar = Bun.spawnSync(["tar", "-cf", path.join(archive, "untracked.tar"), "-C", worktree, "untracked.bin"], { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "pipe", stderr: "pipe" });
  if (tar.exitCode) throw new Error(tar.stderr.toString());
  const index = path.join(path.dirname(archive), "fixture-content-index");
  const environment = { GIT_INDEX_FILE: index };
  let expectedWorkingTree: string;
  try {
    originalGit(worktree, ["read-tree", "HEAD"], environment);
    originalGit(worktree, ["add", "--all", "--force", "--", "."], environment);
    expectedWorkingTree = originalGit(worktree, ["write-tree"], environment).toString().trim();
  } finally { await rm(index, { force: true }); }
  const lines = [];
  for (const name of (await readdir(archive)).sort()) { await chmod(path.join(archive, name), 0o600); lines.push(`${originalDigest(await readFile(path.join(archive, name)))}  ${name}`); }
  const manifestPath = path.join(archive, "MANIFEST.sha256"), manifest = lines.join("\n") + "\n";
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  return { archiveResourceId, manifestPath, manifestSha256: originalDigest(manifest), bundlePath: "source.bundle", bundleRef: `refs/heads/${originalGit(worktree, ["symbolic-ref", "--short", "HEAD"]).toString().trim()}`, indexPatchPath: "index.diff", worktreePatchPath: "worktree.diff", untrackedArchivePath: "untracked.tar", expectedWorkingTree, ownedPaths: [] };
}
