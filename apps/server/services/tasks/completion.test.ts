import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskCompletionRoutes } from "../../routes/tasks/completion.ts";
import { CompletionContractInput, assertCompletionAllowed, inspectTaskCompletion, recordCompletionVerification, recordOwnerMergeApproval, setCompletionContract } from "./completion.ts";
import { completionObservation, observeCompletionRemote } from "./completion-observation.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await mkdtemp(path.join(tmpdir(), "completion-contract-")); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture() {
  git("init", "-b", "codex/task");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  await writeFile(path.join(directory, "feature.txt"), "initial\n");
  git("add", "."); git("commit", "-m", "initial");
  const config = testConfig();
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: directory, repositoryId: config.repository.id, machineId: config.machine } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, primarySessionId: "primary", branchName: "codex/task", worktreePath: directory, toolingRoot: directory, toolingRevision: "a".repeat(40), phase: "working" } });
  const context = { prisma: db.prisma, config, taskId: "task" };
  const gate = { prisma: db.prisma, config, sessionId: "primary" };
  const contract = (boundary = "commit", overrides: object = {}) => CompletionContractInput.parse({ requestKey: "owner-contract", expectedRevision: 0, boundary, basis: "The owner explicitly requested this delivery boundary", ...overrides });
  const verify = (requestKey = "verified") => recordCompletionVerification({ ...context, verification: { requestKey, passed: true, evidence: ["Owner ran the feature check and inspected its result"] } });
  const head = git("rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: {
    url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "OPEN", isDraft: false,
    reviewDecision: "APPROVED", mergeCommit: null as { oid: string } | null,
  } };
  const observer = { ...completionObservation, remote: async () => remote };
  return { config, context, gate, contract, verify, remote, observer };
}

test("unknown legacy completion authority stays unknown despite model progress or resource claims", async () => {
  const { context, gate } = await fixture();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "complete" } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "completion-contract", kind: "merge", purpose: "review", externalId: "claimed", state: "ready", metadata: { merged: true } } });
  expect((await inspectTaskCompletion(context)).boundary).toBe("unknown");
  await expect(assertCompletionAllowed(gate)).rejects.toThrow("unknown or revoked");
});

test("verified but dirty implementation cannot satisfy commit completion", async () => {
  const { context, gate, contract, verify } = await fixture();
  await setCompletionContract({ ...context, contract: contract() });
  await writeFile(path.join(directory, "feature.txt"), "verified local change\n");
  await verify();
  await expect(assertCompletionAllowed(gate)).rejects.toThrow("still dirty");
  const status = await inspectTaskCompletion(context);
  expect(status.receipts[0]?.commit).toMatchObject({ observed: true, clean: false });
  expect(status.receipts[0]?.verification).toMatchObject({ source: "owner-attested", matched: true });
});

test.each(["research", "local-only"])("explicit %s work can complete locally with verified uncommitted output", async (boundary) => {
  const { context, gate, contract, verify } = await fixture();
  await setCompletionContract({ ...context, contract: contract(boundary) });
  await writeFile(path.join(directory, "research.txt"), "owner-requested research result\n");
  await verify();
  expect((await assertCompletionAllowed(gate)).boundary).toBe(boundary);
});

test("committed but unpublished work cannot satisfy push completion", async () => {
  const { context, gate, contract, verify, remote, observer } = await fixture();
  await setCompletionContract({ ...context, contract: contract("push", { repository: "owner/product" }) });
  await verify();
  remote.remoteHead = "a".repeat(40);
  await expect(assertCompletionAllowed(gate, observer)).rejects.toThrow("not been published");
  remote.remoteHead = git("rev-parse", "HEAD");
  expect((await assertCompletionAllowed(gate, observer)).boundary).toBe("push");
});

test("PR, required human review, and merge are distinct authorized boundaries", async () => {
  const { context, gate, contract, verify, remote, observer } = await fixture();
  const authorized = await setCompletionContract({ ...context, contract: contract("review", { repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await verify();
  remote.pullRequest.reviewDecision = "REVIEW_REQUIRED";
  await expect(assertCompletionAllowed(gate, observer)).rejects.toThrow("human review is still pending");
  remote.pullRequest.reviewDecision = "APPROVED";
  expect((await assertCompletionAllowed(gate, observer)).boundary).toBe("review");
  await setCompletionContract({ ...context, contract: contract("merge", { requestKey: "owner-authorized-merge", expectedRevision: authorized.revision, repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await verify("merge-check");
  await expect(assertCompletionAllowed(gate, observer)).rejects.toThrow("has not been merged");
  remote.pullRequest.state = "MERGED"; remote.pullRequest.mergeCommit = { oid: "c".repeat(40) };
  expect((await assertCompletionAllowed(gate, observer)).receipts.merge).toMatchObject({ merged: true, sha: "c".repeat(40) });
});

test("stale verification, wrong PR head/base, and draft PRs cannot satisfy delivery", async () => {
  const { context, gate, contract, verify, remote, observer } = await fixture();
  await setCompletionContract({ ...context, contract: contract("pr", { repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await verify();
  for (const change of [{ headRefOid: "a".repeat(40) }, { baseRefName: "unauthorized" }, { isDraft: true }]) {
    const saved = { ...remote.pullRequest };
    Object.assign(remote.pullRequest, change);
    await expect(assertCompletionAllowed(gate, observer)).rejects.toThrow("does not match");
    Object.assign(remote.pullRequest, saved);
  }
  await writeFile(path.join(directory, "feature.txt"), "different implementation\n");
  await expect(assertCompletionAllowed(gate, observer)).rejects.toThrow("verification is missing, failed or stale");
});

test("owner contract retries are immutable, stale revisions fail, and revocation/closure block completion", async () => {
  const { context, gate, contract, verify } = await fixture();
  const input = contract();
  const saved = await setCompletionContract({ ...context, contract: input });
  expect(await setCompletionContract({ ...context, contract: input })).toEqual(saved);
  await expect(setCompletionContract({ ...context, contract: { ...input, boundary: "local-only" } })).rejects.toThrow("different owner decision");
  await expect(setCompletionContract({ ...context, contract: contract("local-only", { requestKey: "stale" }) })).rejects.toThrow("authority changed");
  await verify();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
  await expect(assertCompletionAllowed(gate)).rejects.toThrow("closed");
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "working" } });
  await setCompletionContract({ ...context, contract: contract("revoked", { requestKey: "owner-revoked", expectedRevision: saved.revision }) });
  await expect(assertCompletionAllowed(gate)).rejects.toThrow("unknown or revoked");
});

test("verification retries retain the original snapshot and do not certify later edits", async () => {
  const { context, gate, contract, verify } = await fixture();
  await setCompletionContract({ ...context, contract: contract("local-only") });
  const saved = await verify();
  await writeFile(path.join(directory, "untracked.txt"), "new bytes");
  expect(await verify()).toEqual(saved);
  await expect(assertCompletionAllowed(gate)).rejects.toThrow("stale");
  await verify("new-verification");
  expect((await assertCompletionAllowed(gate)).boundary).toBe("local-only");
  await writeFile(path.join(directory, "untracked.txt"), "different bytes");
  await expect(assertCompletionAllowed(gate)).rejects.toThrow("stale");
});

test("authority revoked during observation cannot authorize a terminal transition", async () => {
  const { context, gate, contract, verify } = await fixture();
  const saved = await setCompletionContract({ ...context, contract: contract() });
  await verify();
  const observer = { ...completionObservation, snapshot: async (cwd: string) => {
    const snapshot = await completionObservation.snapshot(cwd);
    await setCompletionContract({ ...context, contract: contract("revoked", { requestKey: "revoked-during-check", expectedRevision: saved.revision }) });
    return snapshot;
  } };
  await expect(assertCompletionAllowed(gate, observer)).rejects.toThrow("authority or task identity changed");
});

test("completion contract writes require bearer even on a trusted local socket", async () => {
  const { config, contract } = await fixture();
  const app = new Hono<AppEnv>();
  app.use("*", contextMiddleware({ config, prisma: db.prisma, commandClient: bunCommandClient, agentRuntime: createFakeAgentRuntime() }));
  app.route("/api/tasks", taskCompletionRoutes);
  const request = (authorization?: string) => app.request("/api/tasks/task/completion/contract", { method: "PUT", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify(contract()) });
  expect((await request()).status).toBe(401);
  expect((await request("Bearer session-tool-is-not-owner")).status).toBe(401);
  expect((await request(`Bearer ${config.apiKey}`)).status).toBe(200);
});

test("remote observation validates repository and exact PR identity using only read commands", async () => {
  const calls: string[][] = [];
  const head = "a".repeat(40);
  const client = { run: async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const stdout = command === "gh" ? JSON.stringify({ url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED", mergeCommit: null })
      : args[0] === "remote" ? "git@github.com:owner/product.git\n" : `${head}\trefs/heads/codex/task\n`;
    return { ok: true, stdout, stderr: "" };
  } };
  const input = { repository: "owner/product", remote: "origin", branch: "codex/task", pullRequest: 12, baseBranch: "main" };
  expect((await observeCompletionRemote(directory, input, client)).remoteHead).toBe(head);
  expect(calls.map((call) => call.slice(0, 2))).toEqual([["git", "remote"], ["git", "ls-remote"], ["gh", "pr"]]);
  await expect(observeCompletionRemote(directory, { ...input, repository: "someone/else" }, client)).rejects.toThrow("does not match");
});

async function mergeFixture() {
  const fixtureData = await fixture();
  const { config } = fixtureData;
  const merge = { ...config.repository.workflows.review!, id: "merge", on: "issue.state-changed" as const, when: [{ "issue.state": ["Merge"] }], skill: { skillset: "merge", flags: [] } };
  config.repository = { ...config.repository, workflows: { ...config.repository.workflows, merge } };
  config.repositories = { ...config.repositories, [config.repository.id]: config.repository };
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.repository.id] = { when: [{ "linear.userId": ["owner"] }] };
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { issueIdentifier: "DRA-75", connectionId: config.activeConnectionId } });
  const receipt = await db.prisma.webhookReceipt.create({ data: { webhookId: config.activeWebhookId, connectionId: config.activeConnectionId, repositoryId: config.repository.id, provider: "linear", deliveryId: "delivery", eventType: "issue", trigger: "merge", resourceId: "DRA-75", status: "accepted" } });
  const run = await db.prisma.workerRun.create({ data: { receiptId: receipt.id, workerKey: "product.workflow:merge", status: "pending" } });
  const webhook = { type: "Issue" as const, action: "update" as const, webhookTimestamp: Date.now(), actor: { id: "owner" }, data: { id: "source-issue", identifier: "DRA-75", state: { name: "Merge", type: "started" } }, updatedFrom: { stateId: "review" } };
  const input = { ...fixtureData.context, runId: run.id, workflowId: "merge", webhook, currentIssueState: "Merge" };
  const observer = { ...fixtureData.observer, repository: async () => ({ repository: "owner/product", remote: "origin" }), discover: async () => ({ repository: "owner/product", remote: "origin", pullRequest: 12, baseBranch: "main", head: git("rev-parse", "HEAD"), url: "https://github.com/owner/product/pull/12" }) };
  return { ...fixtureData, input, observer };
}

test("owner Merge records authority before a PR exists; committing accepted bytes needs no repeated owner ceremony", async () => {
  const { input, observer, context, gate, remote } = await mergeFixture();
  await writeFile(path.join(directory, "feature.txt"), "accepted implementation, still uncommitted\n");
  const approval = await recordOwnerMergeApproval(input, observer);
  expect((await inspectTaskCompletion(context)).boundary).toBe("merge");
  expect(approval.actorId).toBe("owner");
  expect(await recordOwnerMergeApproval(input, observer)).toEqual(approval);
  git("add", "."); git("commit", "-m", "owner accepted implementation");
  remote.remoteHead = git("rev-parse", "HEAD");
  remote.pullRequest.headRefOid = remote.remoteHead;
  remote.pullRequest.state = "MERGED";
  remote.pullRequest.reviewDecision = ""; // Owner Merge acceptance is the human approval.
  remote.pullRequest.mergeCommit = { oid: "c".repeat(40) };
  expect((await assertCompletionAllowed(gate, observer)).boundary).toBe("merge");
  await writeFile(path.join(directory, "feature.txt"), "different implementation after acceptance\n");
  await expect(assertCompletionAllowed(gate, observer)).rejects.toThrow("verification is missing, failed or stale");
});

test("missing/nonowner actors, mismatched worker receipts, and revoked Merge state grant no authority", async () => {
  const { input, observer, context } = await mergeFixture();
  for (const actor of [undefined, { id: "another-user" }, { id: input.config.agentUserId }]) {
    await expect(recordOwnerMergeApproval({ ...input, webhook: { ...input.webhook, actor } }, observer)).rejects.toThrow("subscribed owner's");
  }
  await expect(recordOwnerMergeApproval({ ...input, runId: "not-a-trusted-run" }, observer)).rejects.toThrow("accepted workflow receipt");
  await expect(recordOwnerMergeApproval({ ...input, currentIssueState: "Manual Review" }, observer)).rejects.toThrow("subscribed owner's");
  expect((await inspectTaskCompletion(context)).boundary).toBe("unknown");
});

test("replaying an accepted Merge trigger cannot override a later owner revocation", async () => {
  const { input, observer, context, contract } = await mergeFixture();
  const approval = await recordOwnerMergeApproval(input, observer);
  await setCompletionContract({ ...context, contract: contract("revoked", { requestKey: "revoked", expectedRevision: approval.contractRevision }) });
  await expect(recordOwnerMergeApproval(input, observer)).rejects.toThrow("superseded");
  expect((await inspectTaskCompletion(context)).boundary).toBe("revoked");
});
