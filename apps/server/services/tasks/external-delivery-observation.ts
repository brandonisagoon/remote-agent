import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CommandClient } from "../../../../types/runtime/index.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { completionObservation } from "./completion-observation.ts";
import { ExternalDeliveryObservation, ExternalSnapshot, Sha, type ExternalDeliveryInput } from "./external-delivery-schema.ts";

async function run(client: CommandClient, cwd: string, command: string, args: string[]) {
  const result = await client.run(command, args, { cwd });
  if (!result.ok) throw new Error(`External delivery observation failed (${command} ${args[0]})`);
  return result.stdout.trimEnd();
}

/** No fetch, checkout, reset or remote mutation. The source remains a separate
 * repository, never a replacement for the task's cleanup worktree. */
export async function observeExternalSource(delivery: ExternalDeliveryInput, client: CommandClient = bunCommandClient) {
  const readOnly: CommandClient = { run: (command, args, options) => client.run(command, command === "git" ? ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args] : args, options) };
  const sourcePath = await realpath(delivery.sourcePath);
  if (sourcePath !== delivery.sourcePath || !(await lstat(sourcePath)).isDirectory()) throw new Error("External source must be an unchanged canonical directory");
  const gitDirectory = path.join(sourcePath, ".git");
  if (!(await lstat(gitDirectory)).isDirectory() || await realpath(gitDirectory) !== gitDirectory) throw new Error("External source must have independent Git metadata");
  const git = (...args: string[]) => run(readOnly, sourcePath, "git", args);
  if (await realpath(await git("rev-parse", "--path-format=absolute", "--git-common-dir")) !== gitDirectory || await realpath(await git("rev-parse", "--show-toplevel")) !== sourcePath) throw new Error("External source shares another repository's Git metadata");
  for (const filename of ["objects/info/alternates", "objects/info/http-alternates"]) {
    const present = await lstat(path.join(gitDirectory, filename)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (present) throw new Error("External source uses unowned Git alternates");
  }
  const identity = await completionObservation.repository(sourcePath, readOnly);
  const snapshot = await completionObservation.snapshot(sourcePath, readOnly);
  if (identity.repository !== delivery.repository || !snapshot.clean || snapshot.head !== delivery.reviewedHead || snapshot.branch !== delivery.branch) throw new Error("External source does not match the exact clean reviewed head and branch");
  const info = await lstat(sourcePath);
  return ExternalSnapshot.parse({ ...snapshot, sourcePath, gitDirectory, tree: await git("rev-parse", "HEAD^{tree}"), device: info.dev, inode: info.ino });
}

/** Local reports are accepted by the authenticated owner, not called CI.
 * Read the already existing bytes and bind their digest and recorded head. */
export async function observeExternalReports(delivery: ExternalDeliveryInput) {
  return Promise.all(delivery.verificationRefs.filter((ref) => ref.kind === "report").map(async (ref) => {
    const info = await lstat(ref.path);
    if (!info.isFile() || info.size > 5 * 1024 * 1024 || await realpath(ref.path) !== ref.path) throw new Error("Accepted verification report must be a bounded canonical regular file");
    const bytes = await readFile(ref.path);
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("Accepted verification report digest does not match");
    return { path: ref.path, sha256: ref.sha256, head: ref.head, attribution: "owner-attested" as const };
  }));
}

const PullRequest = z.object({ number: z.number().int(), html_url: z.string(), state: z.literal("closed"), draft: z.literal(false), merged: z.literal(true),
  merge_commit_sha: Sha, merged_at: z.iso.datetime(), head: z.object({ sha: Sha, ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }) });

export async function observeExternalRemote(delivery: ExternalDeliveryInput, reviewRequired: boolean, client: CommandClient = bunCommandClient) {
  // Commands run outside the source so frozen receipts still verify after its removal.
  const api = async (suffix: string) => JSON.parse(await run(client, path.parse(process.cwd()).root, "gh", ["api", `repos/${delivery.repository}/${suffix}`]));
  const pr = PullRequest.parse(await api(`pulls/${delivery.pullRequest}`));
  if (pr.number !== delivery.pullRequest || pr.html_url.toLowerCase() !== `https://github.com/${delivery.repository}/pull/${delivery.pullRequest}` || pr.head.repo.full_name.toLowerCase() !== delivery.repository || pr.base.repo.full_name.toLowerCase() !== delivery.repository || pr.head.sha !== delivery.reviewedHead || pr.head.ref !== delivery.branch || pr.base.ref !== delivery.baseBranch || pr.merge_commit_sha !== delivery.expectedMergeCommit) throw new Error("External pull request does not match its accepted repository, head, base and merge");
  const base = z.object({ sha: Sha }).parse(await api(`commits/${encodeURIComponent(delivery.baseBranch)}`));
  const comparison = z.object({ status: z.enum(["ahead", "identical"]), merge_base_commit: z.object({ sha: Sha }) }).parse(await api(`compare/${delivery.expectedMergeCommit}...${base.sha}`));
  if (comparison.merge_base_commit.sha !== delivery.expectedMergeCommit) throw new Error("Accepted external merge is not an ancestor of the current base");
  if (reviewRequired) {
    const review = JSON.parse(await run(client, path.parse(process.cwd()).root, "gh", ["pr", "view", String(delivery.pullRequest), "--repo", delivery.repository, "--json", "headRefOid,reviewDecision"]));
    if (review.headRefOid !== delivery.reviewedHead || review.reviewDecision !== "APPROVED") throw new Error("External delivery still requires approved review on the exact head");
  }
  const ci = [];
  for (const ref of delivery.verificationRefs) if (ref.kind === "ci-run") {
    const run = z.object({ id: z.number().int(), head_sha: Sha, workflow_id: z.number().int(), name: z.string(), status: z.literal("completed"), conclusion: z.literal("success"), repository: z.object({ full_name: z.string() }) }).parse(await api(`actions/runs/${ref.runId}`));
    if (run.id !== ref.runId || run.head_sha !== ref.head || run.workflow_id !== ref.workflowId || run.repository.full_name.toLowerCase() !== delivery.repository) throw new Error("External CI run does not belong to the accepted repository, head and workflow");
    const jobs = z.object({ total_count: z.number().int().max(100), jobs: z.array(z.object({ id: z.number().int(), run_id: z.number().int(), head_sha: Sha, status: z.literal("completed"), conclusion: z.enum(["success", "skipped"]) })) }).parse(await api(`actions/runs/${ref.runId}/jobs?per_page=100`));
    if (!jobs.jobs.length || jobs.total_count !== jobs.jobs.length || jobs.jobs.some((job) => job.run_id !== ref.runId || job.head_sha !== ref.head) || !jobs.jobs.some((job) => job.conclusion === "success")) throw new Error("External CI job set is incomplete or belongs to another head");
    ci.push({ runId: run.id, head: run.head_sha, workflowId: run.workflow_id, name: run.name, conclusion: run.conclusion });
  }
  return { id: delivery.id, repository: delivery.repository, pullRequest: delivery.pullRequest, url: pr.html_url, reviewedHead: delivery.reviewedHead, mergeCommit: pr.merge_commit_sha, mergedAt: pr.merged_at, baseHead: base.sha, ci };
}

export const externalDeliveryObservation = { source: observeExternalSource, reports: observeExternalReports, remote: observeExternalRemote };
export async function observeExternalDeliveries(deliveries: ExternalDeliveryInput[], mergeOrder: string[], reviewRequired: boolean, observer = externalDeliveryObservation) {
  const results = await Promise.all(mergeOrder.map(async (id) => {
    const delivery = deliveries.find((entry) => entry.id === id)!;
    return ExternalDeliveryObservation.parse({ ...await observer.remote(delivery, reviewRequired), snapshot: await observer.source(delivery), reports: await observer.reports(delivery) });
  }));
  for (let index = 1; index < results.length; index++) if (Date.parse(results[index - 1]!.mergedAt) > Date.parse(results[index]!.mergedAt)) throw new Error("External deliveries were merged in a different order");
  return results;
}
