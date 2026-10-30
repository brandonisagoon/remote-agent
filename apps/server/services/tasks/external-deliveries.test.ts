import { ORIGINAL_ADMINISTRATION } from "./original-work-supplement.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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
import { prepareExternalFinalization, confirmExternalFinalization, assertExternalDoneAllowed, externalFinalizationProjection, PreparedExternalFinalization } from "./external-finalization.ts";
import { prepareTaskFinalization } from "./finalization.ts";
import { prepareFinalizationResources, assertFinalizationResources, finalizationDigest, inspectFinalizationQuarantine, type ResourceObservation } from "./finalization-resources.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";
import { fixtureSocket } from "./unix-socket.test-support.ts";
import { originalArchiveFixture } from "../../../../test-support/original-work.ts";
import { recoveryArchiveFixture } from "../../../../test-support/recovery-work.ts";
import { assertOriginalWork, prepareOriginalWork } from "./original-work.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "external-delivery-"))); });
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
  const capture = async (renameRoot = true) => {
    const event = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-prepared", source: `finalizer:${task.id}` } });
    const prepared = PreparedExternalFinalization.parse(JSON.parse(event.value!));
    const entry = prepared.resources.find((resource) => resource.disposition === "retire-owned" && resource.target.type === "tree");
    if (!entry || entry.disposition !== "retire-owned" || entry.target.type !== "tree") throw new Error("Missing fixture capture plan");
    const target = entry.target, root = target.inventory.find((node) => node.path === ".")!;
    if (!(await lstat(target.quarantine.directory).catch(() => null))) {
      await mkdir(target.quarantine.directory, { mode: 0o700 });
      const location = await lstat(target.quarantine.directory);
      const journal = { version: 1, taskId: task.id, resourceId: entry.id, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path,
        source: { dev: root.dev, ino: root.ino, mode: root.mode }, quarantine: { dev: location.dev, ino: location.ino } };
      await writeFile(target.quarantine.journal, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
    }
    if (renameRoot && await lstat(target.path).catch(() => null)) await rename(target.path, target.quarantine.path);
    await inspectFinalizationQuarantine({ taskId: task.id, resourceId: entry.id, target });
    return target;
  };
  const remove = async () => { await capture(); await db.prisma.remoteTaskResource.update({ where: { id: sourceResource.id }, data: { state: "released" } }); git(product, "worktree", "remove", worktree); };
  return { ...context, input, dependencies, finalize, task, session, comment, issue, states, copies, publisher, policy, report, worktree, product, sourceResource, manifest, capture, remove };
}

async function originalFixture(recovery = false, historical = false) {
  const f = await fixture();
  // This fixture deliberately has no source-copies receipt, like the historical
  // original. Its accepted delivery checkouts remain read-only evidence.
  await db.prisma.remoteTaskResource.delete({ where: { id: f.sourceResource.id } });
  const archive = path.join(directory, "retained-original");
  const record = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "original-archive", kind: recovery ? "recovery-archive" : "source-archive", purpose: recovery ? "tooling" : "review", externalId: archive, state: "ready" } });
  const inventory = recovery ? await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "inventory", kind: "resource-inventory", purpose: "tooling", externalId: path.join(archive, "resource-inventory.json"), state: "ready" } }) : undefined;
  const selection = recovery ? (await recoveryArchiveFixture(f.worktree, archive, { archiveResourceId: record.id, inventoryId: inventory!.id })).selection : await originalArchiveFixture(f.worktree, archive, record.id);
  const released = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "previously-retired", kind: "old-provider-object", purpose: "development", externalId: "historical-id", state: "released" } });
  const binding = ExternalDeliveryBindingInput.parse({ ...f.manifest, ownership: { ownedPaths: [] }, originalWork: selection, resourceIds: (await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id } })).map((entry) => entry.id) });
  const dependencies = { ...f.dependencies,
    originalWork: async (input: Parameters<typeof prepareOriginalWork>[0]) => { const proof = await prepareOriginalWork(input, noProcesses); if (historical) delete proof.administration; return proof; },
    assertOriginalWork: (input: Parameters<typeof assertOriginalWork>[0]) => assertOriginalWork(input, noProcesses) };
  const captureOriginal = async (proof: Awaited<ReturnType<typeof prepareOriginalWork>>, administration = false) => {
    const target = administration ? proof.administration!.administrationCapture : proof.target, root = target.inventory.find((entry) => entry.path === ".")!;
    await mkdir(target.quarantine.directory, { mode: 0o700 }); const location = await lstat(target.quarantine.directory);
    await writeFile(target.quarantine.journal, JSON.stringify({ version: 1, taskId: f.task.id, resourceId: proof.captureId, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path, source: { dev: root.dev, ino: root.ino, mode: root.mode }, quarantine: { dev: location.dev, ino: location.ino } }), { mode: 0o600 });
    await rename(target.path, target.quarantine.path);
  };
  return { ...f, input: { ...f.input, binding }, dependencies, archive, archiveRecord: record, released, captureOriginal };
}

test("bound historical v2 cleanup retains approval lineage while Linear comment reads are unavailable", async () => {
  const f = await fixture();
  await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.preparedRevision } });
  const input = { ...f.finalize, cleanup: true as const };
  await prepareExternalFinalization(input, f.dependencies);
  f.issue.state = f.states[1]!;
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "waiting" } });
  const offline = { ...f.dependencies, source: async () => { throw new Error("Linear source unavailable"); }, comment: async () => { throw new Error("Linear comment unavailable"); } };
  expect((await prepareExternalFinalization(input, offline)).preparedRevision).toBe(prepared.preparedRevision);
  await f.remove();
  const confirmed = await confirmExternalFinalization(input, offline);
  expect(confirmed.confirmedRevision).toBeGreaterThan(prepared.preparedRevision);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "completion-owner-approval" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-cleanup-report" } })).toBe(1);
  expect(f.issue.state.name).toBe("Blocked");
});

test("historical adoption preserves recovery archive purpose and exact archive-member retention after confirmation", async () => {
  const f = await originalFixture(true);
  const adopted = await adoptExternalDeliveries(f.input, f.dependencies);
  expect(adopted.binding.originalWork?.restore).toHaveProperty("format", "base-work-tar/v1");
  expect(adopted.binding.resources.filter(entry => entry.purpose === "tooling").map(entry => entry.disposition).sort()).toEqual(["retain-archive", "retain-archive-member"]);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  await f.captureOriginal(prepared.originalWork!); await f.captureOriginal(prepared.originalWork!, true);
  await confirmExternalFinalization(f.finalize, f.dependencies);
  const projection = await externalFinalizationProjection(db.prisma, { id: f.task.id, primarySessionId: f.session.id });
  expect(projection.finalizationRetention?.resources.filter(entry => entry.purpose === "tooling")).toHaveLength(2);
  expect((await db.prisma.remoteTaskResource.findMany({ where: { taskId: f.task.id, purpose: "tooling" } })).every(record => record.state === "ready")).toBe(true);
});

test("dirty original finalization preserves restored archive, full capture and prior released records", async () => {
  const f = await originalFixture();
  const adopted = await adoptExternalDeliveries(f.input, f.dependencies);
  expect(adopted.binding.originalWork?.snapshot.clean).toBe(false);
  expect(adopted.binding.resources.find((entry) => entry.id === f.released.id)?.disposition).toBe("already-released");
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  const selectedOriginal = f.input.binding.originalWork!;
  if (!("expectedWorkingTree" in selectedOriginal)) throw new Error("Fixture requires its bundle selection");
  expect(prepared.originalWork?.restore.workingTree).toBe(selectedOriginal.expectedWorkingTree);
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("not been preserved");
  await f.captureOriginal(prepared.originalWork!);
  // Lost acknowledgement after capture: replay is valid, but Git registration
  // must independently disappear before confirmation.
  expect((await prepareExternalFinalization(f.finalize, f.dependencies)).preparedRevision).toBe(prepared.preparedRevision);
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("exact administration");
  await f.captureOriginal(prepared.originalWork!, true);
  const confirmed = await confirmExternalFinalization(f.finalize, f.dependencies);
  expect(confirmed.confirmedRevision).toBeGreaterThan(prepared.preparedRevision);
  expect((await confirmExternalFinalization(f.finalize, f.dependencies)).confirmedRevision).toBe(confirmed.confirmedRevision);
  expect(await readFile(path.join(prepared.originalWork!.target.quarantine.path, "untracked.bin"))).toEqual(Buffer.from([0, 255, 1, 10]));
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.archiveRecord.id } })).state).toBe("ready");
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.released.id } })).state).toBe("released");
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
  const projection = await externalFinalizationProjection(db.prisma, f.task);
  expect(projection.finalizationRetention?.resources.find((entry) => entry.id === f.archiveRecord.id)?.disposition).toBe("retain-archive");
});

test("original-work selection never authorizes unknown open resources or changed work", async () => {
  const f = await originalFixture();
  const unknown = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "saved-provider-data", kind: "provider-object", purpose: "development", externalId: "do-not-delete", state: "ready" } });
  f.input.binding.resourceIds.push(unknown.id);
  await expect(adoptExternalDeliveries(f.input, f.dependencies)).rejects.toThrow("saved-provider-data (provider-object)");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: EXTERNAL_BINDING } })).toBe(0);
  await db.prisma.remoteTaskResource.update({ where: { id: unknown.id }, data: { state: "released" } });
  await adoptExternalDeliveries(f.input, f.dependencies);
  await writeFile(path.join(f.worktree, "new-work.txt"), "retain me");
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("New material");
  expect(await readFile(path.join(f.worktree, "new-work.txt"), "utf8")).toBe("retain me");
});

test("legacy delivery aliases retain only the exact independently observed pull request", async () => {
  const f = await fixture();
  await db.prisma.remoteTaskResource.update({ where: { taskId_key: { taskId: f.task.id, key: "publisher-pr" } }, data: { kind: "delivery-receipt" } });
  await db.prisma.remoteTaskResource.update({ where: { taskId_key: { taskId: f.task.id, key: "policy-pr" } }, data: { kind: "github-pull-request", externalId: "https://github.com/owner/policy/pull/999" } });
  await expect(adoptExternalDeliveries(f.input, f.dependencies)).rejects.toThrow("independently verified");
  await db.prisma.remoteTaskResource.update({ where: { taskId_key: { taskId: f.task.id, key: "policy-pr" } }, data: { externalId: "https://github.com/owner/policy/pull/7" } });
  const adopted = await adoptExternalDeliveries(f.input, f.dependencies);
  expect(adopted.binding.resources.filter((entry) => entry.disposition === "retain-reference")).toHaveLength(3);
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT).each([false, true])("actual Drafted finalizer resumes archived dirty original capture and Done response loss (historical=%s)", async historical => {
  const f = await originalFixture(false, historical), clientRoot = await realpath(process.env.DRAFTED_INTEGRATION_ROOT!);
  const { finalizeTask } = await import(path.join(clientRoot, "src/finalize.ts"));
  const { TaskRecord, FinalizationReceipt } = await import(path.join(clientRoot, "src/control.ts"));
  await adoptExternalDeliveries(f.input, f.dependencies);
  const publication = publicationFixture(f, "state-response");
  let failRemoval = true, removals = 0, closed = 0;
  const registry = {
    task: async () => {
      const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id }, include: { resources: true } });
      return TaskRecord.parse(JSON.parse(JSON.stringify({ ...task, ...await externalFinalizationProjection(db.prisma, task) })));
    },
    resource: async () => { throw new Error("Retained and previously released resources must not be rewritten"); },
    prepareFinalization: async (request: { requestKey: string; finalizationVersion?: 2; authorityOnly?: true }) => FinalizationReceipt.parse(await prepareExternalFinalization({ ...f.finalize, ...request }, publication.dependencies)),
    confirmFinalization: async (request: { requestKey: string; finalizationVersion?: 2 }) => FinalizationReceipt.parse(await confirmExternalFinalization({ ...f.finalize, ...request }, publication.dependencies)),
    publishIssueUpdate: publication.publish,
  };
  const execute = () => finalizeTask({ registry, preparedCleanup: { observation: noProcesses, captureHooks: { afterCapture: () => { if (failRemoval) { failRemoval = false; throw new Error("injected interruption after original capture"); } } } }, runner: async (command: string[], cwd: string) => {
    if (command[0] === "git" && command.includes("worktree") && command.includes("remove")) {
      removals++;
    }
    const result = await bunCommandClient.run(command[0]!, command.slice(1), { cwd });
    if (!result.ok) throw new Error("Fixture Git command failed");
    return result.stdout.trim();
  }, close: async () => {
    expect(await db.prisma.runtimeIssueUpdate.count({ where: { runtimeSessionId: f.session.id, published: true } })).toBe(1);
    await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } }); closed++;
  } });
  await expect(execute()).rejects.toThrow("interruption after original capture");
  expect(closed).toBe(0); expect(removals).toBe(0);
  const event = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-prepared" } });
  const prepared = PreparedExternalFinalization.parse(JSON.parse(event.value!)), captured = prepared.originalWork!.target.quarantine.path;
  const identity = await lstat(captured);
  expect(await lstat(f.worktree).then(() => true, () => false)).toBe(false);
  await expect(execute()).rejects.toThrow("injected");
  expect(f.issue.state.name).toBe("Done"); expect(closed).toBe(0);
  expect((await execute()).closed).toBe(true);
  expect(closed).toBe(1); expect(removals).toBe(0);
  expect((await lstat(captured)).ino).toBe(identity.ino);
  expect(await readFile(path.join(captured, "staged.txt"), "utf8")).toBe("saved staged work\n");
  expect(await readFile(path.join(captured, "README.md"), "utf8")).toBe("unfinished original change\n");
  expect((await registry.task()).finalizationRetention.resources).toHaveLength(4);
  expect(publication.counts()).toMatchObject({ createCount: 1, updateCount: 1 });
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
}, 30_000);

function publicationFixture(f: Awaited<ReturnType<typeof fixture>>, failure?: "state-response" | "receipt-transaction") {
  const comments = new Map<string, { id: string; body: string; issue: { id: string } }>();
  let createCount = 0, updateCount = 0, gateCount = 0, fail = Boolean(failure);
  const dependencies = { ...f.dependencies, handoffComment: async (_credential: unknown, id: string) => comments.get(id) ?? null };
  const prisma = new Proxy(db.prisma, { get(target, property) {
    if (property === "$transaction") return async (callback: Parameters<typeof target.$transaction>[0]) => target.$transaction(async (tx) => {
      const result = await (callback as (transaction: typeof tx) => Promise<unknown>)(tx);
      if (failure === "receipt-transaction" && fail && await tx.runtimeIssueUpdate.count({ where: { requestKey: `${f.finalize.requestKey}:done`, published: true } })) {
        fail = false; throw new Error("injected published-receipt transaction loss");
      }
      return result;
    });
    return Reflect.get(target, property);
  } });
  const client = { ...issueUpdateDelivery, source: dependencies.source,
    read: async () => f.issue,
    graph: async () => ({ id: f.issue.id, identifier: f.issue.identifier, children: [], states: f.states }),
    complete: async (input: Parameters<typeof issueUpdateDelivery.complete>[0]) => { gateCount++; await assertExternalDoneAllowed(input, dependencies); },
    create: async (_credential: unknown, input: { id?: string; issueId: string; body: string }) => {
      createCount++; comments.set(input.id!, { id: input.id!, body: input.body, issue: { id: input.issueId } }); return { id: input.id! };
    },
    comment: dependencies.handoffComment,
    update: async (_config: unknown, _query: unknown, input: { stateId?: string }) => {
      updateCount++; f.issue.state = f.states.find((state) => state.id === input.stateId)!;
      if (failure === "state-response" && fail) { fail = false; throw new Error("injected applied-Done response loss"); }
    },
  };
  const publish = (handoff: { requestKey: string; body: string; state: string; expectedState: string }) => publishSessionIssueUpdate({ ...f.finalize, ...handoff, prisma, evidence: [] }, client);
  return { dependencies, publish, comments, counts: () => ({ createCount, updateCount, gateCount }) };
}

test.each(["state-response", "receipt-transaction"] as const)("exact pending Done handoff reconciles actual %s loss without another comment or cleanup", async (failure) => {
  const f = await fixture(); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies); await f.remove();
  const confirmed = await confirmExternalFinalization(f.finalize, f.dependencies);
  const publication = publicationFixture(f, failure);
  await expect(publication.publish(prepared.doneHandoff)).rejects.toThrow("injected");
  expect(f.issue.state.name).toBe("Done");
  const pending = await db.prisma.runtimeIssueUpdate.findFirstOrThrow({ where: { requestKey: prepared.doneHandoff.requestKey } });
  expect(pending.published).toBe(false); expect(pending.commentPosted).toBe(true);
  expect((await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).toBe("idle");
  expect(await prepareExternalFinalization(f.finalize, publication.dependencies)).toEqual(confirmed);
  expect((await publication.publish(prepared.doneHandoff)).published).toBe(true);
  expect((await publication.publish(prepared.doneHandoff)).published).toBe(true);
  expect(publication.counts()).toMatchObject({ createCount: 1, updateCount: 1 });
  expect(publication.counts().gateCount).toBeGreaterThan(2);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "issue-update-published" } })).toBe(1);
});

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
  await f.capture(false);
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
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("recreated");
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

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT).each(["state-response", "receipt-transaction"] as const)("actual Drafted client resumes eight-resource cleanup and %s publication loss, then closes last", async (failure) => {
  const f = await fixture();
  const clientRoot = await realpath(process.env.DRAFTED_INTEGRATION_ROOT!);
  const { finalizeTask } = await import(path.join(clientRoot, "src/finalize.ts"));
  const { TaskRecord, FinalizationReceipt } = await import(path.join(clientRoot, "src/control.ts"));
  const leak = path.join(f.copies, "tmp", "leak"); await mkdir(leak, { recursive: true });
  fixtureSocket(path.join(leak, "stream.sock")); fixtureSocket(path.join(leak, "dgram.sock"), "stale-datagram");
  const socketBefore = await lstat(path.join(leak, "stream.sock"));
  f.manifest.ownership.ownedPaths.push(leak);
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
  const publication = publicationFixture(f, failure);
  let injected = false, published = false, closed = 0;
  const effects: string[] = [];
  const registry = {
    task: async () => {
      const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id }, include: { resources: true } });
      return TaskRecord.parse(JSON.parse(JSON.stringify({ ...task, ...await externalFinalizationProjection(db.prisma, task) })));
    },
    resource: async (receipt: { key: string; state: string; metadata?: Record<string, unknown> }) => {
      // Crash after the whole root is captured but before an evidence state write.
      if (!injected && receipt.key === "evidence-one" && receipt.state === "released") { injected = true; throw new Error("injected partial cleanup response loss"); }
      const record = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: f.task.id, key: receipt.key } } });
      await db.prisma.remoteTaskResource.update({ where: { id: record.id }, data: { state: receipt.state, ...(receipt.metadata ? { metadata: JSON.parse(JSON.stringify(receipt.metadata)) } : {}) } });
      effects.push(`released:${receipt.key}`);
    },
    prepareFinalization: async (request: { requestKey: string; finalizationVersion?: 2; authorityOnly?: true }) => FinalizationReceipt.parse(await prepareExternalFinalization({ ...f.finalize, ...request }, publication.dependencies)),
    confirmFinalization: async (request: { requestKey: string; finalizationVersion?: 2 }) => FinalizationReceipt.parse(await confirmExternalFinalization({ ...f.finalize, ...request }, publication.dependencies)),
    publishIssueUpdate: async (handoff: { requestKey: string; body: string; state: string; expectedState: string }) => {
      const result = await publication.publish(handoff);
      published = result.published; effects.push("Done"); return result;
    },
  };
  const execute = () => finalizeTask({ registry, runner: async (command: string[], cwd: string) => {
    if (command[0] === "git" && command.includes("worktree") && command.includes("remove")) effects.push("removed:worktree");
    const result = await bunCommandClient.run(command[0]!, command.slice(1), { cwd });
    if (!result.ok) throw new Error("Fixture Git command failed");
    return result.stdout.trim();
  }, close: async () => {
    if (!published) throw new Error("Session closed before Done");
    await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
    closed++; effects.push("closed");
  }, preparedCleanup: { observation: noProcesses, browser: async (input: { action: string; beforeMutation?: () => Promise<void> }) => {
    await input.beforeMutation?.();
    expect(input.action).toBe("close");
    effects.push("closed:browser");
    return { closed: true };
  } } });
  await expect(execute()).rejects.toThrow("injected partial cleanup");
  expect(closed).toBe(0); expect(published).toBe(false);
  expect(await lstat(path.join(f.copies, "evidence-one.mp4")).then(() => true, () => false)).toBe(false);
  const prepared = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-prepared" } });
  expect(JSON.parse(prepared.value!).resources).toHaveLength(8);
  await expect(execute()).rejects.toThrow("injected");
  expect(closed).toBe(0); expect(published).toBe(false); expect(f.issue.state.name).toBe("Done");
  const releasedBeforeRetry = effects.filter((effect) => effect.startsWith("released:"));
  expect((await execute()).closed).toBe(true);
  expect(effects.filter((effect) => effect.startsWith("released:"))).toEqual(releasedBeforeRetry);
  expect(effects.filter((effect) => effect === "removed:worktree")).toHaveLength(1);
  expect(effects.filter((effect) => effect === "closed:browser")).toHaveLength(1);
  expect(publication.counts()).toMatchObject({ createCount: 1, updateCount: 1 });
  expect(effects.slice(-2)).toEqual(["Done", "closed"]);
  const final = await registry.task();
  expect(final.toolingRevision).toBe(f.task.toolingRevision);
  expect(final.finalizationRetention.resources).toHaveLength(3);
  expect(final.resources.filter((resource: { state: string }) => resource.state !== "released")).toHaveLength(3);
  const sealed = PreparedExternalFinalization.parse(JSON.parse(prepared.value!));
  const captured = sealed.resources.find((resource) => resource.disposition === "retire-owned" && resource.target.type === "tree");
  if (!captured || captured.disposition !== "retire-owned" || captured.target.type !== "tree") throw new Error("Missing captured root");
  expect(await inspectFinalizationQuarantine({ taskId: f.task.id, resourceId: captured.id, target: captured.target })).toMatchObject({ captured: true });
  const retainedSocket = path.join(captured.target.quarantine.path, "tmp/leak/stream.sock");
  expect(retainedSocket.length).toBeGreaterThan(108);
  expect((await lstat(retainedSocket)).ino).toBe(socketBefore.ino);
  expect((await lstat(retainedSocket)).isSocket()).toBeTrue();
  expect(captured.target.inventory.filter(entry => entry.kind === "socket")).toHaveLength(2);
  expect(await readFile(path.join(captured.target.quarantine.path, "evidence-one.mp4"), "utf8")).toBe("existing owned evidence-one bytes");
  expect(await readFile(path.join(captured.target.quarantine.path, "evidence-two.mp4"), "utf8")).toBe("existing owned evidence-two bytes");
  expect(await readFile(path.join(captured.target.quarantine.path, "review-browser", "profile", "Cookies"), "utf8")).toBe("opaque fixture browser bytes");
  expect(await readFile(path.join(captured.target.quarantine.path, "review-browser", "browser-task.json"), "utf8")).toBe(JSON.stringify({ taskId: f.task.id }));
  expect(sealed.doneHandoff.body).toContain("verified retained quarantine");
  expect(await lstat(f.copies).then(() => true, () => false)).toBe(false);
  expect(await lstat(f.worktree).then(() => true, () => false)).toBe(false);
  expect(git(f.product, "rev-parse", "HEAD")).toBe(f.task.baseCommit!);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-prepared" } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "finalization-confirmed" } })).toBe(1);
  expect(await execute()).toMatchObject({ alreadyClosed: true }); expect(closed).toBe(1);
}, 30_000);

test("pending Done reconciliation refuses mismatched payload, comment, source, missing proof and renewed resources", async () => {
  const f = await fixture(); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies); await f.remove(); await confirmExternalFinalization(f.finalize, f.dependencies);
  const publication = publicationFixture(f, "state-response");
  f.issue.state = f.states[2]!;
  await expect(prepareExternalFinalization(f.finalize, publication.dependencies)).rejects.toThrow("current owner Merge");
  f.issue.state = f.states[0]!;
  await expect(publication.publish(prepared.doneHandoff)).rejects.toThrow("injected");
  await expect(prepareExternalFinalization({ ...f.finalize, authorityOnly: true }, publication.dependencies)).rejects.toThrow("full replay verification");
  const receipt = await db.prisma.runtimeIssueUpdate.findFirstOrThrow({ where: { requestKey: prepared.doneHandoff.requestKey } });
  const comment = publication.comments.get(receipt.id)!;
  for (const changed of [null, { ...comment, id: "another-comment" }, { ...comment, issue: { id: "another-issue" } }, { ...comment, body: "different handoff" }]) {
    if (changed) publication.comments.set(receipt.id, changed); else publication.comments.delete(receipt.id);
    await expect(prepareExternalFinalization(f.finalize, publication.dependencies)).rejects.toThrow("exact posted handoff comment");
  }
  publication.comments.set(receipt.id, comment);
  const payload = receipt.input as Record<string, unknown>;
  for (const changed of [{ ...payload, body: "different payload" }, { ...payload, requestKey: "different-key" }, { ...payload, evidence: [{ path: "/unowned", title: "unowned" }] }]) {
    await db.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { input: JSON.parse(JSON.stringify(changed)) } });
    await expect(prepareExternalFinalization(f.finalize, publication.dependencies)).rejects.toThrow();
  }
  await db.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { input: JSON.parse(JSON.stringify(payload)), issueId: "different-issue" } });
  await expect(prepareExternalFinalization(f.finalize, publication.dependencies)).rejects.toThrow("current owner Merge");
  await db.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { issueId: f.issue.id } });
  const proof = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "finalization-resource-proof" } });
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: proof.sequence }, data: { value: "{}" } });
  await expect(publication.publish(prepared.doneHandoff)).rejects.toThrow("proof is missing or mismatched");
  await db.prisma.runtimeMetadataEvent.update({ where: { sequence: proof.sequence }, data: { value: proof.value } });
  await mkdir(f.worktree);
  await expect(prepareExternalFinalization(f.finalize, publication.dependencies)).rejects.toThrow("still exists");
  await rm(f.worktree, { recursive: true });
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "new-resource", kind: "evidence", purpose: "review", externalId: path.join(directory, "renewed"), state: "ready" } });
  await expect(publication.publish(prepared.doneHandoff)).rejects.toThrow("resource set changed");
  await db.prisma.remoteTaskResource.delete({ where: { id: resource.id } });
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(publication.publish(prepared.doneHandoff)).rejects.toThrow();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  expect((await db.prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: receipt.id } })).published).toBe(false);
  expect(publication.counts()).toMatchObject({ createCount: 1, updateCount: 1 });
  expect((await publication.publish(prepared.doneHandoff)).published).toBe(true);
});

test("an explicit retirement revocation blocks historical external binding and local cleanup authority", async () => {
  const { revokeDeliveredRetirement } = await import("./delivered-retirement-revocation.ts");
  const { inspectExternalCleanupAuthority } = await import("./external-cleanup-authority.ts");
  const f = await fixture();
  const adopted = await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  const before = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.preparedRevision } });
  await inspectExternalCleanupAuthority(f.finalize);
  await revokeDeliveredRetirement({ prisma: db.prisma, taskId: f.task.id, revocation: { requestKey: "stop-historical-cleanup", expectedRevision: adopted.revision, basis: "Owner revoked cleanup" } });
  await expect(inspectExternalCleanupAuthority(f.finalize)).rejects.toThrow("explicitly revoked");
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("explicitly revoked");
  await expect(adoptExternalDeliveries(f.input, f.dependencies)).rejects.toThrow("explicitly revoked");
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.preparedRevision } })).value).toBe(before.value);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "completion-retirement-authority" } })).toBe(0);
});

test("accepted cleanup reuses historical comment provenance while preserving provider checks and local revocation", async () => {
  const { observeBoundExternalDelivery } = await import("./external-deliveries.ts");
  const { revokeDeliveredRetirement } = await import("./delivered-retirement-revocation.ts");
  const f = await fixture(), adopted = await adoptExternalDeliveries(f.input, f.dependencies);
  await prepareExternalFinalization(f.finalize, f.dependencies);
  let providerReads = 0;
  const dependencies = { ...f.dependencies, comment: async () => { throw new Error("Linear comment is unavailable"); }, observer: { ...f.dependencies.observer,
    remote: async (...args: Parameters<typeof f.dependencies.observer.remote>) => { providerReads++; return f.dependencies.observer.remote(...args); } } };
  const input = { ...f.input, binding: adopted.binding, revision: adopted.revision, sources: false };
  await expect(observeBoundExternalDelivery(input, dependencies)).rejects.toThrow("Linear comment is unavailable");
  expect(await observeBoundExternalDelivery({ ...input, acceptedCleanup: true }, dependencies)).toHaveLength(2);
  expect(providerReads).toBe(2);
  await revokeDeliveredRetirement({ prisma: db.prisma, taskId: f.task.id, revocation: { requestKey: "revoke-accepted-continuation", expectedRevision: adopted.revision, basis: "Owner revoked cleanup" } });
  await expect(observeBoundExternalDelivery({ ...input, acceptedCleanup: true }, dependencies)).rejects.toThrow("explicitly revoked");
  expect(providerReads).toBe(2);
});


test("historical preparation supplement survives lost acknowledgment and never changes original receipt bytes", async () => {
  const f = await originalFixture(false, true);
  await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  expect(prepared.originalWork?.administration).toBeUndefined();
  expect(prepared.originalWorkAdministration?.proof.administration).toBeDefined();
  const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.preparedRevision } });
  await db.prisma.$disconnect();
  expect(await prepareExternalFinalization(f.finalize, f.dependencies)).toEqual(prepared);
  expect(await prepareExternalFinalization({ ...f.finalize, authorityOnly: true }, f.dependencies)).toEqual(prepared);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: original.sequence } })).value).toBe(original.value);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: ORIGINAL_ADMINISTRATION } })).toBe(1);
  const extension = prepared.originalWorkAdministration!;
  await f.captureOriginal(prepared.originalWork!);
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow();
  await f.captureOriginal({ ...prepared.originalWork!, administration: extension.proof.administration! }, true);
  const confirmed = await confirmExternalFinalization(f.finalize, f.dependencies);
  expect(confirmed.originalWorkAdministration).toEqual(extension);
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: extension.revision } });
  await expect(confirmExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("proof is missing");
});

test("historical captured source is supplemented only against its saved staged snapshot and pointer", async () => {
  const f = await originalFixture(false, true); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  // Simulate the exact pre-extension persisted state, not a live receipt rewrite.
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: prepared.originalWorkAdministration!.revision } });
  await f.captureOriginal(prepared.originalWork!);
  const replay = await prepareExternalFinalization(f.finalize, f.dependencies);
  expect(replay.originalWorkAdministration!.proof.administration!.git.index.sha256).toBe(prepared.originalWorkAdministration!.proof.administration!.git.index.sha256);
  expect(replay.preparedRevision).toBe(prepared.preparedRevision);
  const admin = replay.originalWorkAdministration!.proof.administration!;
  await writeFile(admin.git.index.path, "changed index");
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow();
  expect(await readFile(path.join(prepared.originalWork!.target.quarantine.path, "staged.txt"), "utf8")).toBe("saved staged work\n");
});

test("a completed old registration removal is recorded truthfully without a fabricated admin capture", async () => {
  const f = await originalFixture(false, true); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: prepared.originalWorkAdministration!.revision } });
  await f.captureOriginal(prepared.originalWork!); git(f.product, "worktree", "remove", f.worktree);
  const replay = await prepareExternalFinalization(f.finalize, f.dependencies);
  expect(replay.originalWorkAdministration?.proof.administration).toBeNull();
  expect((await confirmExternalFinalization(f.finalize, f.dependencies)).confirmedRevision).toBeGreaterThan(prepared.preparedRevision);
});

test("changed staged administration before a historical supplement cannot be rebound", async () => {
  const f = await originalFixture(false, true); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies), extension = prepared.originalWorkAdministration!;
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: extension.revision } });
  git(f.worktree, "add", "README.md");
  await f.captureOriginal(prepared.originalWork!);
  await expect(prepareExternalFinalization(f.finalize, f.dependencies)).rejects.toThrow("snapshot differs");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: ORIGINAL_ADMINISTRATION } })).toBe(0);
});

test("pause during administration observation prevents supplementation and the unique receipt cannot fork", async () => {
  const f = await originalFixture(false, true); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies), extension = prepared.originalWorkAdministration!;
  const event = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: extension.revision } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: event.runtimeSessionId, source: event.source, action: event.action, key: event.key, value: event.value } }))).rejects.toThrow();
  await db.prisma.runtimeMetadataEvent.delete({ where: { sequence: extension.revision } });
  const dependencies = { ...f.dependencies, assertOriginalWork: async (...args: Parameters<typeof f.dependencies.assertOriginalWork>) => {
    await f.dependencies.assertOriginalWork(...args);
    await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  } };
  await expect(prepareExternalFinalization(f.finalize, dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: ORIGINAL_ADMINISTRATION } })).toBe(0);
  expect(await lstat(f.worktree).then(() => true, () => false)).toBe(true);
});

test.skipIf(!process.env.DRAFTED_LEGACY_ROOT).each([false, true])("old strict client refuses new administration authority before effects (historical=%s)", async historical => {
  const f = await originalFixture(false, historical); await adoptExternalDeliveries(f.input, f.dependencies);
  const prepared = await prepareExternalFinalization(f.finalize, f.dependencies);
  const { FinalizationReceipt } = await import(path.join(process.env.DRAFTED_LEGACY_ROOT!, "src/control.ts"));
  expect(() => FinalizationReceipt.parse(prepared)).toThrow();
  expect(await lstat(f.worktree).then(() => true, () => false)).toBe(true);
});
