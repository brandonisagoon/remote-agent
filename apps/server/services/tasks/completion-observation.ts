import { preparationStage } from "./preparation-diagnostics.ts";
import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import type { CommandClient } from "../../../../types/runtime/index.ts";
import { bunCommandClient } from "../../transports/command/index.ts";

export interface CompletionSnapshot { head: string; branch: string; clean: boolean; fingerprint: string }
export interface PullRequestObservation {
  url: string; headRefOid: string; headRefName: string; baseRefName: string; state: string;
  isDraft: boolean; reviewDecision: string | null; mergeCommit: { oid: string } | null;
}

async function run(client: CommandClient, cwd: string, command: string, args: string[]) {
  const result = await client.run(command, args, { cwd });
  if (!result.ok) throw new Error(`Completion evidence could not be verified (${command} ${args[0] ?? ""})`);
  return result.stdout.trimEnd();
}

/** Read-only facts. No fetch, commit, push, review or merge is performed. */
export function observeCompletionSnapshot(cwd: string, client: CommandClient = bunCommandClient): Promise<CompletionSnapshot> {
  return preparationStage("fingerprint", () => readCompletionSnapshot(cwd, client));
}
/** Preserve existing Git configuration semantics while forbidding optional
 * index refresh and filesystem-monitor hooks during a frozen capture proof. */
export function observeReadonlyCompletionSnapshot(cwd: string): Promise<CompletionSnapshot> {
  return observeCompletionSnapshot(cwd, { run(command, args, options) {
    return bunCommandClient.run(command, command === "git" ? ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args] : args, options);
  } });
}
async function readCompletionSnapshot(cwd: string, client: CommandClient): Promise<CompletionSnapshot> {
  const git = (...args: string[]) => run(client, cwd, "git", args);
  const head = await git("rev-parse", "--verify", "HEAD");
  const branch = await git("symbolic-ref", "--short", "HEAD");
  const status = await git("status", "--porcelain=v1", "-z", "--untracked-files=all");
  const deleted = new Set((await git("ls-files", "--deleted", "-z")).split("\0"));
  const files = [...new Set((await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter((file) => file && !deleted.has(file)))].sort();
  if (files.length > 20_000) throw new Error("Too many files to verify a completion snapshot");
  // Bind acceptance to working content, not the act of committing it. The
  // owner's accepted uncommitted bytes remain accepted after commit/push.
  const hash = createHash("sha256");
  for (let index = 0; index < files.length; index += 100) {
    const chunk = files.slice(index, index + 100);
    const regular: string[] = [];
    const entries: Array<{ file: string; mode: string; link?: string }> = [];
    for (const file of chunk) {
      const absolute = path.resolve(cwd, file);
      if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error("Invalid completion snapshot path");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) entries.push({ file, mode: "symlink", link: await readlink(absolute) });
      else if (info.isFile()) { regular.push(file); entries.push({ file, mode: info.mode & 0o111 ? "executable" : "file" }); }
      else throw new Error("Completion snapshots require regular files; inspect submodules separately");
    }
    const hashes = regular.length ? (await git("hash-object", "--no-filters", "--", ...regular)).split("\n") : [];
    if (hashes.length !== regular.length) throw new Error("Completion snapshot changed during hashing");
    let offset = 0;
    for (const entry of entries) hash.update("\0").update(entry.file).update("\0").update(entry.mode).update("\0").update(entry.link ?? hashes[offset++]!);
  }
  return { head, branch, clean: status.length === 0, fingerprint: hash.digest("hex") };
}

function githubRepository(remoteUrl: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  return match?.[1]?.toLowerCase() ?? null;
}

export async function observeCompletionRemote(cwd: string, input: {
  repository: string; remote: string; branch: string; pullRequest?: number; baseBranch?: string;
}, client: CommandClient = bunCommandClient) {
  const git = (...args: string[]) => run(client, cwd, "git", args);
  const remoteUrl = await git("remote", "get-url", input.remote);
  if (githubRepository(remoteUrl) !== input.repository.toLowerCase()) throw new Error("Completion repository does not match the configured git remote");
  const refs = await git("ls-remote", "--heads", input.remote, `refs/heads/${input.branch}`, ...(input.baseBranch ? [`refs/heads/${input.baseBranch}`] : []));
  const remoteHead = refs.split("\n").find((line) => line.split(/\s+/)[1] === `refs/heads/${input.branch}`)?.split(/\s+/)[0] ?? null;
  const remoteBase = input.baseBranch ? refs.split("\n").find((line) => line.split(/\s+/)[1] === `refs/heads/${input.baseBranch}`)?.split(/\s+/)[0] ?? null : null;
  let pullRequest: PullRequestObservation | null = null;
  if (input.pullRequest) {
    const data = JSON.parse(await run(client, cwd, "gh", ["pr", "view", String(input.pullRequest), "--repo", input.repository, "--json", "url,headRefOid,headRefName,baseRefName,state,isDraft,reviewDecision,mergeCommit,headRepository,isCrossRepository"]));
    if (data.isCrossRepository !== false || typeof data.url !== "string" || data.url.toLowerCase() !== `https://github.com/${input.repository}/pull/${input.pullRequest}`.toLowerCase() || typeof data.headRefOid !== "string" || typeof data.isDraft !== "boolean") {
      throw new Error("Pull request identity could not be verified");
    }
    pullRequest = data;
  }
  return { remote: input.remote, repository: input.repository, remoteHead, remoteBase, pullRequest };
}

export async function discoverCompletionPullRequest(cwd: string, branch: string, client: CommandClient = bunCommandClient) {
  const { repository } = await observeCompletionRepository(cwd, client);
  const pr = JSON.parse(await run(client, cwd, "gh", ["pr", "view", branch, "--repo", repository, "--json", "number,url,headRefOid,headRefName,baseRefName,state,isDraft,isCrossRepository"]));
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.url !== "string" || pr.url.toLowerCase() !== `https://github.com/${repository}/pull/${pr.number}`.toLowerCase() || pr.headRefName !== branch || pr.isCrossRepository !== false || pr.isDraft !== false || !["OPEN", "MERGED"].includes(pr.state) || typeof pr.headRefOid !== "string" || typeof pr.baseRefName !== "string") {
    throw new Error("Owner Merge approval could not identify this task's exact pull request");
  }
  return { repository, remote: "origin", pullRequest: pr.number as number, baseBranch: pr.baseRefName as string, head: pr.headRefOid as string, url: pr.url as string };
}

export async function observeCompletionRepository(cwd: string, client: CommandClient = bunCommandClient) {
  const repository = githubRepository(await run(client, cwd, "git", ["remote", "get-url", "origin"]));
  if (!repository) throw new Error("Owner Merge approval requires an identifiable GitHub origin");
  return { repository, remote: "origin" };
}

export const completionObservation = { snapshot: observeCompletionSnapshot, remote: observeCompletionRemote, discover: discoverCompletionPullRequest, repository: observeCompletionRepository };
