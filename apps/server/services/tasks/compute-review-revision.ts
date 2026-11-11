import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RemoteTask, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { finalizationDigest } from "./finalization-resources.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";

const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Metadata = z.object({ revision: Commit, toolingRevision: Commit, receipt: z.string(), reviewEnvironments: z.array(z.string()).optional() });
/** Existing Drafted review receipt, independently read by the admission owner. */
const Receipt = z.object({ version: z.literal(1), taskId: z.string(), revision: Commit, worktree: z.string(), commonGitDirectory: z.string(),
  expiresAt: z.iso.datetime(), state: z.literal("prepared"), error: z.null() }).strict();
type ReviewTask = Pick<RemoteTask, "id" | "toolingRevision" | "worktreePath">;

export function reviewRevisionAnchor(task: ReviewTask, resource: RemoteTaskResource) {
  const metadata = Metadata.parse(resource.metadata), directory = path.dirname(metadata.receipt);
  if (resource.taskId !== task.id || resource.purpose !== "review" || resource.kind !== "git-worktree"
    || resource.key !== `review-${metadata.revision}` || metadata.toolingRevision !== task.toolingRevision
    || !path.isAbsolute(directory) || path.normalize(directory) !== directory || path.basename(directory) !== metadata.revision
    || path.basename(path.dirname(directory)) !== task.id || path.basename(path.dirname(path.dirname(directory))) !== "reviews"
    || path.basename(metadata.receipt) !== "receipt.json" || resource.externalId !== path.join(directory, "checkout")
    || metadata.reviewEnvironments !== undefined && (metadata.reviewEnvironments.length !== 1 || metadata.reviewEnvironments[0] !== resource.key))
    throw new Error("Unstarted review checkout registration changed");
  return { revision: metadata.revision, receipt: metadata.receipt };
}

/** No caller path or mutable development HEAD selects a review source. Read the
 * registered detached checkout, its original private receipt and Git membership.
 * The returned proof is compared again inside the admission transaction. */
export async function readComputeReviewRevision(task: ReviewTask, resource: RemoteTaskResource, revision: string, now: Date) {
  const anchor = reviewRevisionAnchor(task, resource), worktree = resource.externalId;
  if (anchor.revision !== revision || resource.state !== "ready" || !resource.expiresAt || resource.expiresAt.getTime() <= now.getTime())
    throw new Error("Unstarted review requires its unexpired ready checkout");
  const held = await observeLegacyEvidenceFile(anchor.receipt, true, 64 * 1024), bytes = await readFile(anchor.receipt);
  if (createHash("sha256").update(bytes).digest("hex") !== held.sha256) throw new Error("Unstarted review receipt changed while reading");
  const receipt = Receipt.parse(JSON.parse(bytes.toString()));
  if (receipt.taskId !== task.id || receipt.revision !== revision || receipt.worktree !== worktree
    || Date.parse(receipt.expiresAt) !== resource.expiresAt.getTime()) throw new Error("Unstarted review receipt does not match its registration");
  for (const directory of [task.worktreePath!, worktree]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022 || await realpath(directory) !== directory)
      throw new Error("Unstarted review source is shared or redirected");
  }
  if (worktree === task.worktreePath || worktree.startsWith(`${task.worktreePath}${path.sep}`) || task.worktreePath!.startsWith(`${worktree}${path.sep}`))
    throw new Error("Unstarted review must use its separate checkout");
  const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const git = async (cwd: string, ...args: string[]) => (await executeOwnedObserver(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    { cwd, timeoutMs: 5_000, env: { ...env, GIT_TERMINAL_PROMPT: "0" } })).trim();
  const [common, actualCommon, head, branch, changes, registrations] = await Promise.all([
    git(task.worktreePath!, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"), git(worktree, "rev-parse", "--verify", "HEAD^{commit}"),
    git(worktree, "branch", "--show-current"), git(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
    git(task.worktreePath!, "worktree", "list", "--porcelain", "-z"),
  ]);
  const entries = registrations.split("\0\0").filter(Boolean).map(block => Object.fromEntries(block.split("\0").filter(Boolean).map(line => {
    const offset = line.indexOf(" "); return offset < 0 ? [line, ""] : [line.slice(0, offset), line.slice(offset + 1)];
  })));
  const selected = entries.filter(entry => entry.worktree === worktree), original = entries.filter(entry => entry.worktree === task.worktreePath);
  if (common !== actualCommon || receipt.commonGitDirectory !== common || head !== revision || branch || changes
    || original.length !== 1 || selected.length !== 1 || selected[0]!.HEAD !== revision || !("detached" in selected[0]!)
    || "locked" in selected[0]! || "prunable" in selected[0]!) throw new Error("Unstarted review Git checkout changed");
  if (finalizationDigest(await observeLegacyEvidenceFile(anchor.receipt, true, 64 * 1024)) !== finalizationDigest(held))
    throw new Error("Unstarted review receipt changed during observation");
  return { revision, worktree, commonGitDirectory: common, receipt: held };
}
