import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import type { WorkflowConfig } from "../../../../lib/config.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { createApp } from "../../app.ts";
import { deliverManagedMerge } from "../../workers/product/workflow/merge-delivery.ts";
import type { SourceIssueWithAgentIssues } from "../../integrations/linear/session-store/source-issue/types.ts";
import { deliverInstructions } from "../sessions/inbox.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";
import { assertCompletionAllowed, recordOwnerMergeApproval } from "./completion.ts";
import { completionObservation, type PullRequestObservation } from "./completion-observation.ts";
import { prepareTaskFinalization, confirmTaskFinalization } from "./finalization.ts";

let directory: string, db: TestDatabase;
beforeEach(async () => { directory = realpathSync(mkdtempSync(path.join(tmpdir(), "old-pin-merge-lifecycle-"))); db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); rmSync(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function write(cwd: string, file: string, text: string) { mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); writeFileSync(path.join(cwd, file), text); }
function initialize(cwd: string, branch: string) {
  mkdirSync(cwd); git(cwd, "init", "-b", branch); git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.com"); git(cwd, "config", "commit.gpgsign", "false");
}
function commit(cwd: string, message: string) { git(cwd, "add", "."); git(cwd, "commit", "-m", message); return git(cwd, "rev-parse", "HEAD"); }

/** Git/reconciliation/hooks/push and server boundaries are real. GitHub and the
 * agent's choices are controlled fixture boundaries, not an LLM quality test. */
async function fixture() {
  const product = path.join(directory, "product"), remote = path.join(directory, "remote.git"), worktree = path.join(directory, "worktree");
  initialize(product, "staging"); write(product, "feature.txt", "baseline\n");
  const base = commit(product, "base"); git(directory, "init", "--bare", remote); git(product, "remote", "add", "origin", remote); git(product, "push", "origin", "staging");
  git(product, "worktree", "add", "-b", "codex/task", worktree);
  write(worktree, "feature.txt", "accepted implementation\n"); // Owner accepts dirty, unpublished work.
  const tooling = path.join(directory, "tooling"); initialize(tooling, "main");
  write(tooling, "AGENTS.md", "Preserve the original task policy and run its checks.");
  const oldRevision = commit(tooling, "before merge capability");
  write(tooling, ".remote-agent-capabilities.json", JSON.stringify({ version: 1, capabilities: { merge: { instructions: "agent-skills/merge/instructions.md", adapter: "src/cli.ts" } } }));
  write(tooling, "agent-skills/merge/instructions.md", "Start at the verified revision. Reconcile staging, rerun affected checks, preserve push hooks, create or inspect the matching PR, verify merge, confirm cleanup, publish Done, and close last. Recheck owner Merge authority at every step.");
  write(tooling, "src/cli.ts", "// Controlled fixture adapter boundary; never a task repin.");
  const hostRevision = commit(tooling, "versioned merge capability");
  const config = testConfig({ installRoot: path.join(directory, "install") });
  const workflow: WorkflowConfig = { id: "merge", on: "issue.state-changed", when: [{ "issue.state": ["Merge"] }], connectionId: null, deliver: "message-session", providerId: "codex", model: null, plan: null, skill: { skillset: "merge", flags: [] } };
  config.repository = { ...config.repository, root: product, baseBranch: "origin/staging", tooling: { root: tooling, revision: hostRevision }, workflows: { merge: workflow } };
  config.repositories = { [config.repository.id]: config.repository };
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.repository.id] = { when: [{ "linear.userId": ["owner"] }] };
  const pin = (revision: string) => {
    const root = path.join(config.installRoot, "tooling", config.repository.id, revision);
    mkdirSync(path.dirname(root), { recursive: true }); git(tooling, "worktree", "add", "--detach", root, revision); writeFileSync(`${root}.ready`, `${revision}\n`); return root;
  };
  const oldPin = pin(oldRevision); pin(hostRevision);
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", repositoryId: config.repository.id, machineId: config.machine, cwd: worktree } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-48", primarySessionId: session.id, worktreePath: worktree, branchName: "codex/task", toolingRoot: tooling, toolingRevision: oldRevision, pinnedToolingRoot: oldPin, phase: "review" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-48", relationship: "handles" } });
  const intake = await db.prisma.webhookReceipt.create({ data: { webhookId: config.activeWebhookId, connectionId: config.activeConnectionId, repositoryId: config.repository.id, provider: "linear", deliveryId: "owner-merge", eventType: "issue", trigger: "merge", resourceId: "DRA-48", status: "accepted" } });
  const run = await db.prisma.workerRun.create({ data: { receiptId: intake.id, workerKey: "product.workflow:merge", status: "pending" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "done", name: "Done", type: "completed" }];
  const issue = { id: "source", identifier: "DRA-48", branchName: "codex/task", title: "Accepted task", description: "Merge accepted work", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const runtime = createFakeAgentRuntime([{ id: session.id, role: "primary", status: "idle", cwd: worktree, repositoryId: task.repositoryId, machineId: task.machineId }]);
  let pr: PullRequestObservation | null = null;
  const effects = { checks: 0, push: 0, pr: 0, merge: 0, cleanup: 0, comments: 0, states: 0 };
  const observer = { ...completionObservation,
    repository: async () => ({ repository: "owner/product", remote: "origin" }),
    discover: async () => { if (!pr) throw new Error("No matching PR exists yet"); return { repository: "owner/product", remote: "origin", pullRequest: 1, baseBranch: "staging", head: pr.headRefOid, url: pr.url }; },
    remote: async () => ({ repository: "owner/product", remote: "origin", remoteHead: git(remote, "rev-parse", "refs/heads/codex/task"), remoteBase: git(remote, "rev-parse", "refs/heads/staging"), pullRequest: pr }),
  };
  const webhook = { type: "Issue" as const, action: "update" as const, webhookTimestamp: Date.now(), actor: { id: "owner" }, data: { id: issue.id, identifier: issue.identifier, state: { name: "Merge", type: "started" } }, updatedFrom: { stateId: "review" } };
  const dispatch = () => deliverManagedMerge({ context: { prisma: db.prisma, config, runId: run.id, commandClient: bunCommandClient }, workflow, issueIdentifier: issue.identifier, webhook,
    seed: "Use {{SKILL:merge}} for the accepted task.", read: async () => issue as unknown as SourceIssueWithAgentIssues,
    compose: async () => { throw new Error("Old pin has no merge skill"); }, recordApproval: (input) => recordOwnerMergeApproval(input, observer) });
  const gate = { prisma: db.prisma, config, sessionId: session.id };
  const source = async () => ({ session, link, config, issue });
  const finalization = { ...gate, requestKey: "finalize:task" };
  const finalizationDependencies = { source, completion: (input: typeof gate) => assertCompletionAllowed(input, observer), snapshot: completionObservation.snapshot };
  const client = { ...issueUpdateDelivery, source, read: async () => issue, graph: async () => ({ id: issue.id, identifier: issue.identifier, children: [], states }),
    complete: async () => { await assertCompletionAllowed(gate, observer); },
    create: async (_config: unknown, input: { id?: string }) => { effects.comments++; return { id: input.id! }; },
    update: async (_config: unknown, _query: unknown, input: { stateId?: string }) => { effects.states++; issue.state = states.find((state) => state.id === input.stateId)!; },
  };
  const hookLog = path.join(directory, "hook-checks"), hookFailure = path.join(directory, "fail-check"), hooks = path.join(directory, "hooks");
  const check = () => { effects.checks++; expect(readFileSync(path.join(worktree, "feature.txt"), "utf8")).toBe("accepted implementation\n"); };
  const reconcile = (changedContent = false) => {
    check(); const accepted = commit(worktree, "accepted implementation");
    if (changedContent) write(product, "upstream.txt", "new upstream behavior\n");
    git(product, "add", "."); git(product, "commit", "--allow-empty", "-m", "staging advanced"); git(product, "push", "origin", "staging");
    git(worktree, "fetch", "origin", "staging"); git(worktree, "merge", "--no-edit", "origin/staging"); check();
    expect(git(worktree, "merge-base", "--is-ancestor", accepted, "HEAD")).toBe("");
    expect(git(worktree, "merge-base", "--is-ancestor", "origin/staging", "HEAD")).toBe("");
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, "pre-push"), `#!${process.execPath}\nimport { existsSync, readFileSync, appendFileSync } from 'node:fs';\nif (existsSync(${JSON.stringify(hookFailure)}) || readFileSync('feature.txt','utf8') !== 'accepted implementation\\n') process.exit(1);\nconst head = Bun.spawnSync(['git','rev-parse','HEAD']).stdout.toString().trim();\nappendFileSync(${JSON.stringify(hookLog)}, head+'\\n');\n`, { mode: 0o755 });
    git(product, "config", "core.hooksPath", hooks);
  };
  const publishAndMerge = () => {
    git(worktree, "push", "origin", "codex/task"); effects.push++;
    const head = git(worktree, "rev-parse", "HEAD");
    pr = { url: "https://github.com/owner/product/pull/1", headRefOid: head, headRefName: "codex/task", baseRefName: "staging", state: "OPEN", isDraft: false, reviewDecision: null, mergeCommit: null }; effects.pr++;
    git(product, "merge", "--squash", "codex/task"); const merged = commit(product, "merge PR 1"); git(product, "push", "origin", "staging");
    pr.state = "MERGED"; pr.mergeCommit = { oid: merged }; effects.merge++;
    git(worktree, "fetch", "origin", "staging"); expect(git(worktree, "merge-base", "--is-ancestor", merged, "origin/staging")).toBe("");
  };
  return { task, session, config, product, remote, worktree, tooling, oldPin, oldRevision, hostRevision, base, runtime, dispatch, gate, observer, effects, reconcile, publishAndMerge, hookLog, hookFailure, finalization, finalizationDependencies, client, issue };
}

test("old-pin owner Merge continues through reconciled hooked publication, verified merge, cleanup and Done without a repin", async () => {
  const f = await fixture();
  expect(existsSync(path.join(f.oldPin, "agent-skills/merge/instructions.md"))).toBe(false);
  expect((await f.dispatch()).status).toBe("delivered");
  const instruction = await db.prisma.runtimeInstruction.findFirstOrThrow();
  expect(instruction.text).toContain(f.hostRevision);
  expect(instruction.text).toContain("rerun affected checks");
  await db.prisma.$disconnect();
  expect((await f.dispatch()).status).toBe("existing");
  await deliverInstructions(db.prisma, f.runtime);
  for (let attempt = 0; attempt < 100 && (await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } })).state !== "completed"; attempt++) await Bun.sleep(5);
  expect(f.runtime.sentMessages).toHaveLength(1);
  expect(f.runtime.sentMessages[0]!.sessionId).toBe(f.session.id);
  // Controlled provider executes the delivered instruction. Real Git advances
  // staging without changing accepted bytes; a separate test covers changed bytes.
  f.reconcile(); f.publishAndMerge();
  expect(f.effects).toMatchObject({ checks: 2, push: 1, pr: 1, merge: 1 });
  expect(readFileSync(f.hookLog, "utf8").trim().split("\n")).toHaveLength(2);
  expect((await assertCompletionAllowed(f.gate, f.observer)).receipts.merge.merged).toBe(true);
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "complete" } });
  const owned = path.join(directory, "owned-preview"), foreign = path.join(directory, "foreign-preview"); mkdirSync(owned); mkdirSync(foreign);
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "preview", purpose: "browser", kind: "profile", externalId: owned, state: "ready" } });
  const prepared = await prepareTaskFinalization(f.finalization, f.finalizationDependencies);
  rmSync(owned, { recursive: true }); f.effects.cleanup++;
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { state: "released" } });
  git(f.product, "worktree", "remove", f.worktree);
  await db.prisma.$disconnect(); // Process interruption after irreversible cleanup.
  expect(await prepareTaskFinalization(f.finalization, f.finalizationDependencies)).toEqual(prepared);
  const confirmed = await confirmTaskFinalization(f.finalization, f.finalizationDependencies);
  expect(await confirmTaskFinalization(f.finalization, f.finalizationDependencies)).toEqual(confirmed);
  const update = { ...f.gate, requestKey: "finalize:task:done", body: "PR1 merged, checks passed, exact cleanup confirmed; session is closing.", expectedState: "Merge", state: "Done", evidence: [] };
  expect((await publishSessionIssueUpdate(update, f.client)).published).toBe(true);
  expect((await publishSessionIssueUpdate(update, f.client)).published).toBe(true);
  expect(f.effects).toMatchObject({ push: 1, pr: 1, merge: 1, cleanup: 1, comments: 1, states: 1 });
  expect(existsSync(foreign)).toBe(true);
  const app = createApp({ config: f.config, prisma: db.prisma, agentRuntime: f.runtime });
  const closed = await app.request(`/api/tasks/${f.task.id}/automation`, { method: "POST", headers: { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ action: "close" }) });
  expect(closed.status).toBe(200);
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ phase: "closed", toolingRevision: f.oldRevision, pinnedToolingRoot: f.oldPin, primarySessionId: f.session.id });
  expect(git(f.oldPin, "rev-parse", "HEAD")).toBe(f.oldRevision);
  expect(git(f.tooling, "status", "--porcelain")).toBe("");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("old-pin continuation does not bypass a failing push hook or fabricate downstream receipts", async () => {
  const f = await fixture(); await f.dispatch(); f.reconcile();
  writeFileSync(f.hookFailure, "Affected check fails");
  expect(() => f.publishAndMerge()).toThrow();
  expect(git(f.product, "ls-remote", "origin", "refs/heads/codex/task")).toBe("");
  expect(f.effects).toMatchObject({ checks: 2, push: 0, pr: 0, merge: 0, cleanup: 0 });
  expect((await f.dispatch()).status).toBe("existing");
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect(existsSync(f.worktree)).toBe(true);
});

test("content-changing staging reconciliation gives an explicit stale-verification failure rather than silently completing", async () => {
  const f = await fixture(); await f.dispatch(); f.reconcile(true); f.publishAndMerge();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "complete" } });
  await expect(prepareTaskFinalization(f.finalization, f.finalizationDependencies)).rejects.toThrow("verification is missing, failed or stale");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(0);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "completion-verification" } })).toBe(1);
  expect(existsSync(f.worktree)).toBe(true);
  expect(f.issue.state.name).toBe("Merge");
  expect(f.effects.cleanup).toBe(0);
});
