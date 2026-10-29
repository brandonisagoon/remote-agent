import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskRoutes } from "../../routes/tasks/index.ts";
import { taskCompletionRoutes } from "../../routes/tasks/completion.ts";
import { recordOwnerMergeApproval, recordCompletionVerification, setCompletionContract, CompletionContractInput } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { adoptExternalDeliveries, externalBindingDependencies } from "./external-deliveries.ts";
import { EXTERNAL_BINDING, ExternalDeliveryBindingInput } from "./external-delivery-schema.ts";
import { observeExternalRemote, observeExternalSource, externalDeliveryObservation } from "./external-delivery-observation.ts";
import { prepareExternalFinalization, confirmExternalFinalization, assertExternalDoneAllowed, externalFinalizationProjection } from "./external-finalization.ts";
import { prepareTaskFinalization } from "./finalization.ts";
import { prepareFinalizationResources, assertFinalizationResources, type ResourceObservation } from "./finalization-resources.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "external-delivery-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function repository(cwd: string, name: string, branch = "codex/task") {
  await mkdir(cwd, { recursive: true }); git(cwd, "init", "-b", branch);
  git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(cwd, "README.md"), `${name}\n`); git(cwd, "add", "."); git(cwd, "commit", "-m", "fixture");
  git(cwd, "remote", "add", "origin", `https://github.com/owner/${name}.git`);
  return git(cwd, "rev-parse", "HEAD");
}
const noProcesses: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };

async function fixture() {
  const product = path.join(directory, "product"), worktree = path.join(directory, "original-worktree"), copies = path.join(directory, "accepted-copies"), tooling = path.join(directory, "pinned-tooling");
  await mkdir(tooling); const base = await repository(product, "product", "main"); git(product, "worktree", "add", "-b", "codex/task", worktree);
  const publisher = path.join(copies, "publisher"), policy = path.join(copies, "policy");
  const publisherHead = await repository(publisher, "publisher"), policyHead = await repository(policy, "policy");
  const report = path.join(copies, "accepted-local-report.txt");
  // Historical owner-attested reports need not be rewritten to add a SHA.
  await writeFile(report, "bun run check passed; 132 tests passed, 2 optional integrations skipped\n");
  const config = testConfig({ repository: { ...testConfig().repository, root: product } });
  config.repository = { ...config.repository, workflows: { ...config.repository.workflows, merge: { ...config.repository.workflows.review!, id: "merge", on: "issue.state-changed", when: [{ "issue.state": ["Merge"] }] } } };
  config.repositories = { ...config.repositories, [config.repository.id]: config.repository };
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.repository.id] = { when: [{ "linear.userId": ["owner"] }] };
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", role: "primary", status: "idle", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, baseCommit: base, toolingRoot: tooling, pinnedToolingRoot: tooling, toolingRevision: "a".repeat(40), connectionId: config.activeConnectionId, issueIdentifier: "DRA-159", phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-159", relationship: "handles" } });
  const receipt = await db.prisma.webhookReceipt.create({ data: { webhookId: config.activeWebhookId, connectionId: config.activeConnectionId, repositoryId: config.repository.id, provider: "linear", deliveryId: "accepted-merge", eventType: "issue", trigger: "merge", resourceId: "DRA-159", status: "accepted" } });
  const run = await db.prisma.workerRun.create({ data: { receiptId: receipt.id, workerKey: "product.workflow:merge", status: "pending" } });
  const context = { prisma: db.prisma, config, taskId: task.id };
  const approval = await recordOwnerMergeApproval({ ...context, runId: run.id, workflowId: "merge", currentIssueState: "Merge", webhook: { type: "Issue", action: "update", webhookTimestamp: Date.now(), organizationId: "organization", actor: { id: "owner" }, updatedFrom: { stateId: "review" }, data: { id: "issue", identifier: "DRA-159", state: { name: "Merge", type: "started" } } } });
  const event = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "completion-owner-approval" } });
  const comment = { organization: { id: "organization" }, comment: { id: "phone-accepted", body: "Phone playback works.", user: { id: "owner" }, issue: { id: "issue", identifier: "DRA-159" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } };
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "blocked", name: "Blocked", type: "started" }, { id: "done", name: "Done", type: "completed" }];
  const issue = { id: "issue", identifier: "DRA-159", branchName: "codex/task", title: "Video", description: "Request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const sourceResource = await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "copies", kind: "source-copies", purpose: "review", externalId: copies, state: "ready" } });
  for (const [key, externalId, kind] of [["publisher-pr", "https://github.com/owner/publisher/pull/8", "pull-request"], ["policy-pr", "https://github.com/owner/policy/pull/7", "pull-request"], ["ci", "https://github.com/owner/publisher/actions/runs/100", "ci-run"]]) await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: key!, kind: kind!, purpose: "review", externalId: externalId!, state: "ready" } });
  const manifest = ExternalDeliveryBindingInput.parse({ version: 1, requestKey: "accepted-external", expectedContractRevision: approval.contractRevision, expectedBindingRevision: 0,
    acceptance: { approvalEventSequence: event.sequence, ownerCommentId: comment.comment.id, ownerCommentDigest: digest(comment.comment.body) },
    deliveries: [
      { id: "publisher", repository: "owner/publisher", pullRequest: 8, sourcePath: publisher, branch: "codex/task", reviewedHead: publisherHead, baseBranch: "main", expectedMergeCommit: "b".repeat(40), verificationRefs: [{ kind: "ci-run", runId: 100, workflowId: 10, head: publisherHead }] },
      { id: "policy", repository: "owner/policy", pullRequest: 7, sourcePath: policy, branch: "codex/task", reviewedHead: policyHead, baseBranch: "main", expectedMergeCommit: "c".repeat(40), verificationRefs: [{ kind: "report", path: report, sha256: digest(await readFile(report)), head: policyHead }] },
    ], mergeOrder: ["publisher", "policy"], resourceIds: (await db.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } })).map((resource) => resource.id), ownership: { sourceCopyResourceId: sourceResource.id, ownedPaths: [report] } });
  const remote = async (delivery: typeof manifest.deliveries[number]) => ({ id: delivery.id, repository: delivery.repository, pullRequest: delivery.pullRequest, url: `https://github.com/${delivery.repository}/pull/${delivery.pullRequest}`, reviewedHead: delivery.reviewedHead, mergeCommit: delivery.expectedMergeCommit, mergedAt: delivery.id === "publisher" ? "2026-01-01T00:01:00.000Z" : "2026-01-01T00:02:00.000Z", baseHead: "d".repeat(40), ci: delivery.verificationRefs.flatMap((ref) => ref.kind === "ci-run" ? [{ runId: ref.runId, head: ref.head, workflowId: ref.workflowId, name: "checks", conclusion: "success" as const }] : []) });
  const dependencies = { ...externalBindingDependencies, source: async () => ({ session, link, config, issue }), comment: async () => comment,
    observer: { ...externalDeliveryObservation, remote },
    resources: (input: Parameters<typeof prepareFinalizationResources>[0]) => prepareFinalizationResources(input, noProcesses),
    assertResources: (input: Parameters<typeof assertFinalizationResources>[0]) => assertFinalizationResources(input, noProcesses) };
  const input = { ...context, binding: manifest };
  const finalize = { prisma: db.prisma, config, sessionId: session.id, requestKey: "finalize:task", finalizationVersion: 2 as const };
  const remove = async () => { await rm(copies, { recursive: true }); await db.prisma.remoteTaskResource.update({ where: { id: sourceResource.id }, data: { state: "released" } }); git(product, "worktree", "remove", worktree); };
  return { ...context, input, dependencies, finalize, task, session, comment, issue, states, copies, publisher, policy, report, worktree, product, sourceResource, manifest, remove };
}

test("accepted external deliveries preserve original cleanup identity through prepare, partial retry, confirmation and closed GET retention", async () => {
  const f = await fixture();
  const adopted = await adoptExternalDeliveries(f.input, f.dependencies);
  expect(await adoptExternalDeliveries(f.input, f.dependencies)).toEqual(adopted);
  expect(adopted.binding.deliveries[1]!.reports[0]!.attribution).toBe("owner-attested");
  expect((await db.prisma.runtimeMetadataEvent.findMany({ where: { action: "completion-contract" } })).length).toBe(1);
  await expect(prepareTaskFinalization({ ...f.finalize, finalizationVersion: undefined })).rejects.toThrow("finalizationVersion 2");
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  expect(prepared.worktree).toBe(f.worktree);
  expect(prepared.revision).toBe(git(f.worktree, "rev-parse", "HEAD"));
  expect(prepared.delivery.deliveries.map((entry) => entry.mergeCommit)).toEqual(["b".repeat(40), "c".repeat(40)]);
  expect(prepared.doneHandoff.body).toContain("cleanup revision");
  await rm(f.publisher, { recursive: true });
  expect(await prepareExternalFinalization(f.finalize, f.dependencies)).toEqual(prepared);
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("filesystem resources");
  await f.remove();
  const confirmed = await confirmExternalFinalization(f.finalize, f.dependencies);
  expect(await confirmExternalFinalization(f.finalize, f.dependencies)).toEqual(confirmed);
  expect(await prepareExternalFinalization(f.finalize, f.dependencies)).toEqual(confirmed);
  await expect(assertExternalDoneAllowed({ ...f.finalize, ...prepared.doneHandoff, body: "Unrelated merged product" }, f.dependencies)).rejects.toThrow("immutable prepared handoff");
  await assertExternalDoneAllowed({ ...f.finalize, ...prepared.doneHandoff }, f.dependencies);
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  const app = new Hono<AppEnv>(); app.use("*", contextMiddleware({ config: f.config, prisma: db.prisma, commandClient: bunCommandClient, agentRuntime: createFakeAgentRuntime() })); app.route("/api/tasks", taskRoutes);
  const result = await (await app.request("/api/tasks/task")).json() as { task: { finalizationVersion: number; finalizationRetention: { resources: unknown[] } } };
  expect(result.task.finalizationVersion).toBe(2); expect(result.task.finalizationRetention.resources).toHaveLength(3);
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "new", kind: "unknown", purpose: "tooling", externalId: "unowned", state: "ready" } });
  const changed = await (await app.request("/api/tasks/task")).json() as { task: { finalizationRetention?: unknown } };
  expect(changed.task.finalizationRetention).toBeUndefined();
});

test("owner comment, actual worker lineage, exact report bytes and manifest revisions cannot be replaced by resource claims", async () => {
  const f = await fixture();
  f.comment.comment.user.id = "agent";
  await expect(adoptExternalDeliveries(f.input, f.dependencies)).rejects.toThrow("comment author");
  f.comment.comment.user.id = "owner";
  const originalReport = await readFile(f.report);
  await writeFile(f.report, "different unaccepted checks");
  await expect(adoptExternalDeliveries(f.input, f.dependencies)).rejects.toThrow("report digest");
  await writeFile(f.report, originalReport);
  await expect(adoptExternalDeliveries({ ...f.input, binding: { ...f.manifest, expectedContractRevision: 1000 } }, f.dependencies)).rejects.toThrow("revision changed");
  await db.prisma.webhookReceipt.updateMany({ data: { status: "rejected" } });
  await expect(adoptExternalDeliveries(f.input, f.dependencies)).rejects.toThrow("workflow lineage");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: EXTERNAL_BINDING } })).toBe(0);
});

test("same-key adoption is immutable and existing v1 preparation cannot be silently converted", async () => {
  const f = await fixture(); await adoptExternalDeliveries(f.input, f.dependencies);
  await expect(adoptExternalDeliveries({ ...f.input, binding: { ...f.manifest, mergeOrder: ["policy", "publisher"] } }, f.dependencies)).rejects.toThrow("different adoption");
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: EXTERNAL_BINDING } });
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, action: "finalization-prepared", source: "finalizer:task", key: "finalize:task", value: "{}" } });
  await expect(adoptExternalDeliveries(f.input, f.dependencies)).rejects.toThrow("must be reconciled");
});

test("Blocked owner state, changed verification, source bytes, and stale task identity revoke effects", async () => {
  const f = await fixture(); await adoptExternalDeliveries(f.input, f.dependencies);
  f.issue.state = f.states[1]!;
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("current owner Merge");
  f.issue.state = f.states[0]!;
  await writeFile(path.join(f.policy, "README.md"), "changed\n");
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("clean reviewed head");
  git(f.policy, "checkout", "--", "README.md");
  await recordCompletionVerification({ prisma: db.prisma, config: f.config, taskId: f.task.id, verification: { requestKey: "revoked-verification", passed: false, evidence: ["Owner found a problem"] } });
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("verification was revoked");
});

test("a later contract, owner comment edit or recreated path blocks confirmation without new cleanup authority", async () => {
  const f = await fixture(); await adoptExternalDeliveries(f.input, f.dependencies); await prepareExternalFinalization(f.finalize, f.dependencies); await f.remove();
  f.comment.comment.body = "Playback no longer works";
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("comment author");
  f.comment.comment.body = "Phone playback works.";
  await mkdir(f.copies);
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("filesystem resources");
  await rm(f.copies, { recursive: true });
  await setCompletionContract({ prisma: db.prisma, config: f.config, taskId: f.task.id, contract: CompletionContractInput.parse({ requestKey: "revoked", expectedRevision: f.manifest.expectedContractRevision, boundary: "revoked", basis: "Owner withdrew delivery" }) });
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("revoked or replaced");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(0);
});

test("slow external observation cannot race a primary transfer or contract change into an accepted binding", async () => {
  const f = await fixture(); let changed = false;
  const dependencies = { ...f.dependencies, observer: { ...f.dependencies.observer, remote: async (...args: Parameters<typeof f.dependencies.observer.remote>) => {
    const remote = await f.dependencies.observer.remote(...args);
    if (!changed) { changed = true; await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { toolingRevision: "e".repeat(40) } }); }
    return remote;
  } } };
  await expect(adoptExternalDeliveries(f.input, dependencies)).rejects.toThrow("authority changed during adoption");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: EXTERNAL_BINDING } })).toBe(0);
});

test("external adoption API requires bearer and the database enforces supplemental receipt uniqueness", async () => {
  const f = await fixture();
  const app = new Hono<AppEnv>(); app.use("*", contextMiddleware({ config: f.config, prisma: db.prisma, commandClient: bunCommandClient, agentRuntime: createFakeAgentRuntime() })); app.route("/api/tasks", taskCompletionRoutes);
  expect((await app.request("/api/tasks/task/completion/external-deliveries", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(f.manifest) })).status).toBe(401);
  const data = { runtimeSessionId: f.session.id, action: EXTERNAL_BINDING, source: "owner:task", key: "same", value: "{}" };
  await db.prisma.runtimeMetadataEvent.create({ data });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data }))).rejects.toThrow();
});

test("provider observation checks exact merge ancestry, CI head/workflow/jobs and does not require a live head branch", async () => {
  const f = await fixture(); const delivery = f.manifest.deliveries[0]!; const calls: string[][] = [];
  const data = { pr: { number: 8, html_url: "https://github.com/owner/publisher/pull/8", state: "closed", draft: false, merged: true, merge_commit_sha: delivery.expectedMergeCommit, merged_at: "2026-01-01T00:01:00.000Z", head: { sha: delivery.reviewedHead, ref: "codex/task", repo: { full_name: "owner/publisher" } }, base: { ref: "main", repo: { full_name: "owner/publisher" } } },
    compare: { status: "ahead", merge_base_commit: { sha: delivery.expectedMergeCommit } }, run: { id: 100, head_sha: delivery.reviewedHead, workflow_id: 10, name: "checks", status: "completed", conclusion: "success", repository: { full_name: "owner/publisher" } }, jobs: { total_count: 1, jobs: [{ id: 1, run_id: 100, head_sha: delivery.reviewedHead, status: "completed", conclusion: "success" }] } };
  const client = { run: async (command: string, args: string[]) => { calls.push([command, ...args]); const endpoint = args[1]!;
    const value = endpoint.includes("/pulls/") ? data.pr : endpoint.includes("/compare/") ? data.compare : endpoint.includes("/commits/") ? { sha: "d".repeat(40) } : endpoint.includes("/jobs?") ? data.jobs : data.run;
    return { ok: true, stdout: JSON.stringify(value), stderr: "" };
  } };
  expect((await observeExternalRemote(delivery, false, client)).mergeCommit).toBe(delivery.expectedMergeCommit);
  expect(calls.every((call) => call[0] === "gh" && call[1] === "api")).toBe(true);
  data.compare.merge_base_commit.sha = "e".repeat(40); await expect(observeExternalRemote(delivery, false, client)).rejects.toThrow("ancestor");
  data.compare.merge_base_commit.sha = delivery.expectedMergeCommit; data.run.head_sha = "e".repeat(40); await expect(observeExternalRemote(delivery, false, client)).rejects.toThrow("accepted repository, head");
  data.run.head_sha = delivery.reviewedHead; data.jobs.total_count = 2; await expect(observeExternalRemote(delivery, false, client)).rejects.toThrow("job set is incomplete");
});

test("bounded cleanup authority checks cannot prepare, ignore Blocked, replace identity or reuse confirmed cleanup", async () => {
  const f = await fixture(); await adoptExternalDeliveries(f.input, f.dependencies);
  const batch = { ...f.finalize, authorityOnly: true as const };
  await expect(prepareExternalFinalization({ ...f.finalize, requestKey: "alternate" }, f.dependencies)).rejects.toThrow("stable finalize requestKey");
  await expect(prepareExternalFinalization(batch, f.dependencies)).rejects.toThrow("existing unconfirmed preparation");
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  const noRemote = { ...f.dependencies, observer: { ...f.dependencies.observer, remote: async () => { throw new Error("unexpected remote observation"); } } };
  expect(await prepareExternalFinalization(batch, noRemote)).toEqual(prepared);
  f.issue.state = f.states[1]!;
  await expect(prepareExternalFinalization(batch, noRemote)).rejects.toThrow("current owner Merge");
  f.issue.state = f.states[0]!;
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(prepareExternalFinalization(batch, noRemote)).rejects.toThrow("unchanged task ownership");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  await f.remove(); await confirmExternalFinalization(f.finalize, f.dependencies);
  await expect(prepareExternalFinalization(batch, noRemote)).rejects.toThrow("full replay verification");
});

test("missing or mismatched durable resource proofs block Done and confirmed replay", async () => {
  const f = await fixture(); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies); await f.remove(); await confirmExternalFinalization(f.finalize, f.dependencies);
  const proof = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-resource-proof" } });
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: proof.sequence }, data: { value: JSON.stringify({ ...JSON.parse(proof.value!), resourceId: "other-task-resource" }) } });
  await expect(assertExternalDoneAllowed({ ...f.finalize, ...prepared.doneHandoff }, f.dependencies)).rejects.toThrow("proof is missing or mismatched");
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("proof is missing or mismatched");
  expect((await externalFinalizationProjection(db.prisma, f.task)).finalizationRetention).toBeUndefined();
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual Drafted client consumes all eight server-planned resources, resumes a partial failure and closes last", async () => {
  const f = await fixture();
  const clientRoot = await realpath(process.env.DRAFTED_INTEGRATION_ROOT!);
  const { finalizeTask } = await import(path.join(clientRoot, "src/finalize.ts"));
  const { TaskRecord, FinalizationReceipt } = await import(path.join(clientRoot, "src/control.ts"));
  const profileRoot = path.join(f.copies, "review-browser"), profile = path.join(profileRoot, "profile"), ownerFile = path.join(profileRoot, "profile-owner.json"), contextFile = path.join(profileRoot, "browser-task.json");
  await mkdir(profile, { recursive: true });
  const marker = JSON.stringify({ taskId: f.task.id, session: `${f.task.id}-review`, profile, nonce: "b2177987-dc54-4c15-89eb-ce14236fdb57" });
  await writeFile(ownerFile, marker); await writeFile(contextFile, JSON.stringify({ taskId: f.task.id }));
  await writeFile(path.join(profile, "Cookies"), "opaque fixture browser bytes");
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "browser-profile:review", kind: "browser-profile", purpose: "review", externalId: profile, state: "ready",
    metadata: { namespace: "drafted", ownerFile, ownerSha256: digest(marker), session: `${f.task.id}-review`, toolingRoot: f.task.pinnedToolingRoot } } });
  for (const name of ["evidence-one", "evidence-two"]) {
    const file = path.join(f.copies, `${name}.mp4`), bytes = `existing owned ${name} bytes`;
    await writeFile(file, bytes);
    await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: name, kind: "evidence", purpose: "review", externalId: file, state: "ready", metadata: { size: Buffer.byteLength(bytes), sha256: digest(bytes) } } });
  }
  const script = path.join(f.copies, "phone-fixture.ts"); await writeFile(script, "// already-stopped fixture\n");
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "fixture-endpoint", kind: "local-http", purpose: "review", externalId: "http://127.0.0.1:29199", state: "ready", metadata: { pid: 98765, script } } });
  f.manifest.resourceIds = (await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id } })).map((resource) => resource.id);
  await adoptExternalDeliveries(f.input, f.dependencies);
  let injected = false, published = false, closed = 0;
  const effects: string[] = [];
  const registry = {
    task: async () => {
      const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id }, include: { resources: true } });
      return TaskRecord.parse(JSON.parse(JSON.stringify({ ...task, ...await externalFinalizationProjection(db.prisma, task) })));
    },
    resource: async (receipt: { key: string; state: string; metadata?: Record<string, unknown> }) => {
      // Crash after the first actual evidence unlink but before its state write.
      if (!injected && receipt.key === "evidence-one" && receipt.state === "released") { injected = true; throw new Error("injected partial cleanup response loss"); }
      const record = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: f.task.id, key: receipt.key } } });
      await db.prisma.remoteTaskResource.update({ where: { id: record.id }, data: { state: receipt.state, ...(receipt.metadata ? { metadata: JSON.parse(JSON.stringify(receipt.metadata)) } : {}) } });
      effects.push(`released:${receipt.key}`);
    },
    prepareFinalization: async (request: { requestKey: string; finalizationVersion?: 2; authorityOnly?: true }) => FinalizationReceipt.parse(await prepareExternalFinalization({ ...f.finalize, ...request }, f.dependencies)),
    confirmFinalization: async (request: { requestKey: string; finalizationVersion?: 2 }) => FinalizationReceipt.parse(await confirmExternalFinalization({ ...f.finalize, ...request }, f.dependencies)),
    publishIssueUpdate: async (handoff: { requestKey: string; body: string; state: string; expectedState: string }) => {
      await assertExternalDoneAllowed({ ...f.finalize, ...handoff }, f.dependencies);
      await db.prisma.runtimeIssueUpdate.create({ data: { runtimeSessionId: f.session.id, requestKey: handoff.requestKey, connectionId: f.task.connectionId!, issueId: f.issue.id, input: handoff, evidence: [], published: true } });
      published = true; f.issue.state = f.states[2]!; effects.push("Done"); return { published: true };
    },
  };
  const execute = () => finalizeTask({ registry, close: async () => {
    if (!published) throw new Error("Session closed before Done");
    await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
    closed++; effects.push("closed");
  }, preparedCleanup: { observation: noProcesses, browser: async (input: { beforeMutation?: () => Promise<void> }) => {
    await input.beforeMutation?.();
    await rm(profile, { recursive: true }); await rm(contextFile);
    return { released: true };
  } } });
  await expect(execute()).rejects.toThrow("injected partial cleanup");
  expect(closed).toBe(0); expect(published).toBe(false);
  expect(await lstat(path.join(f.copies, "evidence-one.mp4")).then(() => true, () => false)).toBe(false);
  const prepared = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-prepared" } });
  expect(JSON.parse(prepared.value!).resources).toHaveLength(8);
  expect((await execute()).closed).toBe(true);
  expect(effects.slice(-2)).toEqual(["Done", "closed"]);
  const final = await registry.task();
  expect(final.toolingRevision).toBe(f.task.toolingRevision);
  expect(final.finalizationRetention.resources).toHaveLength(3);
  expect(final.resources.filter((resource: { state: string }) => resource.state !== "released")).toHaveLength(3);
  expect(await lstat(f.copies).then(() => true, () => false)).toBe(false);
  expect(await lstat(f.worktree).then(() => true, () => false)).toBe(false);
  expect(git(f.product, "rev-parse", "HEAD")).toBe(f.task.baseCommit!);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
  expect(await execute()).toMatchObject({ alreadyClosed: true }); expect(closed).toBe(1);
}, 30_000);
