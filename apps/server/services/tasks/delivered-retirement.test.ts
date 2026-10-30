import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskCompletionRoutes } from "../../routes/tasks/completion.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { prepareTaskFinalization, confirmTaskFinalization, assertPreparedDoneHandoff } from "./finalization.ts";
import { FINALIZATION_PREPARED } from "./finalization-receipts.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "done-retirement-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

import { adoptDoneRetirement, inspectDoneRetirement, DoneRetirementInput, DONE_RETIREMENT } from "./delivered-retirement.ts";
import { revokeDeliveredRetirement } from "./delivered-retirement-revocation.ts";
import { adoptLegacyEvidence, manageLegacyEvidence } from "./legacy-evidence.ts";
import { finalizationDigest } from "./finalization-resources.ts";

test("Done supplement preserves original v1 preparation, contract, verification and legacy proof across lost acknowledgment", async () => {
  const f = await fixture();
  await expect(prepareTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("current owner Merge");
  const legacy = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "owner:task", action: "legacy-evidence-retention", key: "proof515", value: JSON.stringify({ original: "immutable fixture evidence" }) } });
  const original = await db.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const request = await f.request();
  const adopted = await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  // The caller lost the success response; replay only reads the saved authority.
  expect(await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies)).toEqual(adopted);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: original.map(row => row.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(original);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: legacy.sequence } })).value).toBe(legacy.value);
  const replay = await prepareTaskFinalization(f.finalizer, f.finalization);
  expect(replay).toMatchObject({ ...f.prepared, retirement: { authorityRevision: adopted.revision, doneHandoff: { expectedState: "Done", state: "Done" } } });
  await expect(confirmTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("unreleased");
  await db.prisma.remoteTaskResource.updateMany({ data: { state: "released" } });
  git(f.root, "worktree", "remove", f.worktree);
  const confirmed = await confirmTaskFinalization(f.finalizer, f.finalization);
  expect(confirmed).toMatchObject({ ...replay, confirmedRevision: expect.any(Number) });
  expect(await confirmTaskFinalization(f.finalizer, f.finalization)).toEqual(confirmed);
  expect(f.issue.state.name).toBe("Done");
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.preparation.value);
});

test("an interrupted waiting primary continues the same preparation only after the authenticated supplement commits", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  const request = await f.request();
  await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("complete");
  expect((await prepareTaskFinalization(f.finalizer, f.finalization)).preparedRevision).toBe(f.prepared.preparedRevision);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.preparation.value);
});

test.each(["pause", "branch", "pin", "contract", "verification", "preparation", "resource"])("%s change invalidates the supplement without rewriting historical proof", async changed => {
  const f = await fixture(), request = await f.request();
  await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  if (changed === "branch") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { branchName: "foreign" } });
  if (changed === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
  if (changed === "contract") await setCompletionContract({ ...f.context, contract: CompletionContractInput.parse({ requestKey: "revoked", expectedRevision: f.contract.revision, boundary: "revoked", basis: "Owner stopped" }) });
  if (changed === "verification") await recordCompletionVerification({ ...f.context, verification: { requestKey: "new", passed: true, evidence: ["new verification"] } });
  if (changed === "preparation") await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: FINALIZATION_PREPARED, key: "another", value: f.preparation.value } });
  if (changed === "resource") await db.prisma.remoteTaskResource.updateMany({ data: { metadata: { root: "/foreign/archive" } } });
  await expect(prepareTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow();
  await expect(adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies)).rejects.toThrow();
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.preparation.value);
});

test.each(["Blocked", "same Done newer version", "dirty original"])("%s during provider observation refuses adoption", async changed => {
  const f = await fixture(), request = await f.request();
  await expect(adoptDoneRetirement({ ...f.context, retirement: request }, { ...f.dependencies, remote: async (...args) => {
    if (changed === "Blocked") f.issue.state = { id: "blocked", name: "Blocked", type: "started" };
    if (changed === "same Done newer version") f.issue.updatedAt = "2026-10-30T11:00:00.000Z";
    if (changed === "dirty original") await writeFile(path.join(f.worktree, "README.md"), "new owner bytes");
    return f.dependencies.remote();
  } })).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(0);
});

test("owner API requires bearer even on the trusted control socket", async () => {
  const f = await fixture();
  const app = new Hono<AppEnv>().use("*", contextMiddleware({ prisma: db.prisma, config: f.config, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient })).route("/api/tasks", taskCompletionRoutes);
  expect((await app.request("/api/tasks/task/completion/delivered-retirement", { method: "PUT", body: JSON.stringify(await f.request()), headers: { "Content-Type": "application/json" } })).status).toBe(401);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(0);
});

test("revocation stops the next prepared effect and same-key replay cannot revive the supplement", async () => {
  const f = await fixture(), request = await f.request();
  const adopted = await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  f.issue.state = { id: "merge", name: "Merge", type: "started" };
  await expect(prepareTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("Done retirement");
  f.issue.state = { id: "done", name: "Done", type: "completed" };
  const revocation = { requestKey: "revoke-cleanup", expectedRevision: adopted.revision, basis: "Owner stopped this cleanup" };
  expect(await revokeDeliveredRetirement({ ...f.context, revocation })).toEqual(await revokeDeliveredRetirement({ ...f.context, revocation }));
  await expect(prepareTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("revoked");
  await expect(adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies)).rejects.toThrow("revoked");
});

test("a failed adoption transaction restores neither phase nor partial authority, and the same request can retry", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  const request = await f.request();
  await db.prisma.$executeRawUnsafe("CREATE TRIGGER refuse_done_phase BEFORE UPDATE ON RemoteTask WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'phase acknowledgment failed'); END");
  await expect(adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(0);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } })).phase).toBe("waiting");
  await db.prisma.$executeRawUnsafe("DROP TRIGGER refuse_done_phase");
  await adoptDoneRetirement({ ...f.context, retirement: request }, f.dependencies);
  expect((await prepareTaskFinalization(f.finalizer, f.finalization)).preparedRevision).toBe(f.prepared.preparedRevision);
  const event = await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: DONE_RETIREMENT } });
  await expect(Promise.resolve(db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: event.runtimeSessionId, action: event.action, source: event.source, key: event.key, value: event.value } }))).rejects.toThrow();
});

test("revocation during a new adoption's provider read wins the authority CAS; only a newly inspected decision can resume", async () => {
  const f = await fixture();
  const first = await adoptDoneRetirement({ ...f.context, retirement: await f.request() }, f.dependencies);
  const stale = { ...await f.request(), requestKey: "second-adoption" };
  await expect(adoptDoneRetirement({ ...f.context, retirement: stale }, { ...f.dependencies, remote: async () => {
    await revokeDeliveredRetirement({ ...f.context, revocation: { requestKey: "concurrent-revoke", expectedRevision: first.revision, basis: "Owner stopped during observation" } });
    return f.dependencies.remote();
  } })).rejects.toThrow("changed during adoption");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: DONE_RETIREMENT } })).toBe(1);
  await expect(prepareTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("revoked");
  const inspection = await inspectDoneRetirement(f.context, f.dependencies);
  expect(inspection.revoked).toBeTrue(); expect(inspection.revision).toBeGreaterThan(first.revision);
  const fresh = { ...await f.request(), requestKey: "fresh-after-revocation" };
  await adoptDoneRetirement({ ...f.context, retirement: fresh }, f.dependencies);
  expect((await prepareTaskFinalization(f.finalizer, f.finalization)).preparedRevision).toBe(f.prepared.preparedRevision);
});

test("an existing retained-evidence proof authorizes and independently confirms capture under the supplement without rewriting proof or unrelated failed resources", async () => {
  const historical = path.join(directory, "historical"), archive = path.join(directory, "retained");
  await mkdir(historical, { mode: 0o700 }); await mkdir(archive, { mode: 0o700 });
  const original = path.join(historical, "capture.txt"), retained = path.join(archive, "capture.txt"), body = "existing preserved task evidence";
  const sha256 = createHash("sha256").update(body).digest("hex"), size = Buffer.byteLength(body);
  await writeFile(original, body, { mode: 0o600 }); await writeFile(retained, body, { mode: 0o600 });
  let resource!: RemoteTaskResource;
  const f = await fixture(async () => { resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "capture", kind: "evidence", purpose: "review", externalId: original, state: "ready", metadata: { sha256, bytes: size } } }); });
  const manifestPath = path.join(archive, "RETENTION.json"), manifest = JSON.stringify({ task: "task", retainedArchive: archive, files: [{ path: "capture.txt", sha256, bytes: size }] });
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  const proof = await adoptLegacyEvidence({ ...f.context, adoption: { requestKey: "existing-proof515", finalizationRequestKey: f.prepared.requestKey, expectedPreparedRevision: f.prepared.preparedRevision,
    manifest: { path: manifestPath, sha256: createHash("sha256").update(manifest).digest("hex") }, entries: [{ resourceId: resource.id, retainedPath: retained, sha256, size }] } });
  const proofBefore = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: proof.proofRevision } });
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
  await adoptDoneRetirement({ ...f.context, retirement: await f.request() }, f.dependencies);
  const operation = { resourceKey: resource.key, proofRevision: proof.proofRevision, proofDigest: proof.proofDigest, preparedRevision: f.prepared.preparedRevision, finalizationRequestKey: f.prepared.requestKey };
  const dependencies = { prepare: (input: Parameters<typeof prepareTaskFinalization>[0]) => prepareTaskFinalization(input, f.finalization) };
  await manageLegacyEvidence({ ...f.finalizer, operation: { ...operation, action: "authorize" } }, dependencies);
  const target = proof.proof.entries[0]!.target, q = target.quarantine;
  if (target.type !== "file") throw new Error("Expected file fixture");
  await mkdir(q.directory, { mode: 0o700 }); const stat = await lstat(q.directory);
  await writeFile(q.journal, JSON.stringify({ version: 1, taskId: "task", resourceId: resource.id, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: q.path,
    source: { dev: target.dev, ino: target.ino, mode: target.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600 });
  await rename(target.path, q.path);
  const confirmed = await manageLegacyEvidence({ ...f.finalizer, operation: { ...operation, action: "confirm" } }, dependencies);
  expect(await manageLegacyEvidence({ ...f.finalizer, operation: { ...operation, action: "confirm" } }, dependencies)).toEqual(confirmed);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: proof.proofRevision } })).value).toBe(proofBefore.value);
  expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: f.prepared.preparedRevision } })).value).toBe(f.preparation.value);
  expect(await readFile(q.path, "utf8")).toBe(body); expect(await readFile(retained, "utf8")).toBe(body);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).metadata).toEqual(resource.metadata);
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: "unresolved-clerk" } } })).state).toBe("ready");
  await expect(confirmTaskFinalization(f.finalizer, f.finalization)).rejects.toThrow("unreleased");
  await writeFile(retained, "changed archive");
  await expect(manageLegacyEvidence({ ...f.finalizer, operation: { ...operation, action: "authorize" } }, dependencies)).rejects.toThrow();
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual original-primary finalizer resumes the unchanged v1 preparation after Done and lost publication acknowledgment, then closes last", async () => {
  const f = await fixture();
  // Independent adapter work was already completed; no fake provider deletion
  // is performed by this finalization/publication compatibility fixture.
  await db.prisma.remoteTaskResource.updateMany({ data: { state: "released" } });
  await adoptDoneRetirement({ ...f.context, retirement: await f.request() }, f.dependencies);
  const originals = await db.prisma.runtimeMetadataEvent.findMany({ where: { action: { in: ["completion-contract", "completion-verification", FINALIZATION_PREPARED] } }, orderBy: { sequence: "asc" } });
  let comments = 0, stateWrites = 0, closed = 0;
  const posted = new Map<string, { id: string; body: string; issue: { id: string } }>();
  const provider = { ...issueUpdateDelivery, source: f.dependencies.source, read: async () => f.issue,
    graph: async () => ({ id: f.issue.id, identifier: f.issue.identifier, children: [], states: [f.issue.state] }),
    complete: async (input: Parameters<typeof issueUpdateDelivery.complete>[0]) => assertPreparedDoneHandoff({ ...input, requestKey: input.requestKey ?? "" }, f.finalization),
    create: async (_key: unknown, value: { id?: string; body: string; issueId: string }) => { comments++; posted.set(value.id!, { id: value.id!, body: value.body, issue: { id: value.issueId } }); return { id: value.id! }; },
    comment: async (_key: unknown, id: string) => posted.get(id) ?? null,
    update: async () => { stateWrites++; },
  };
  await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_done_publication BEFORE INSERT ON RuntimeMetadataEvent WHEN NEW.action = 'issue-update-published' BEGIN SELECT RAISE(ABORT, 'injected publication acknowledgment loss'); END");
  const socket = path.join(directory, "control.sock");
  const server = Bun.serve({ unix: socket, fetch: async request => {
    try {
      const route = new URL(request.url).pathname;
      if (route.endsWith("/prepare-finalization")) return Response.json(await prepareTaskFinalization(f.finalizer, f.finalization));
      if (route.endsWith("/confirm-finalization")) return Response.json(await confirmTaskFinalization(f.finalizer, f.finalization));
      if (route.endsWith("/issue-update")) return Response.json(await publishSessionIssueUpdate({ ...f.finalizer, ...await request.json(), evidence: [] }, provider));
      if (route === "/api/tasks/task") return Response.json({ task: await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" }, include: { resources: true } }) });
      return Response.json({ error: "Unexpected fixture request" }, { status: 404 });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
  } });
  await chmod(socket, 0o600);
  try {
    const { taskRegistry } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/control.ts"));
    const { finalizeTask } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/finalize.ts"));
    const registry = taskRegistry(socket, "task");
    const close = async () => {
      expect(comments).toBe(1); expect(stateWrites).toBe(0);
      expect((await db.prisma.runtimeIssueUpdate.findFirstOrThrow()).published).toBeTrue();
      expect((await confirmTaskFinalization(f.finalizer, f.finalization)).preparedRevision).toBe(f.prepared.preparedRevision);
      closed++;
      await db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "closed" } });
      await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed" } });
    };
    // Prisma maps this SQLite trigger abort to its constraint error. The
    // pending receipt and successful same-key replay below identify the fault.
    await expect(finalizeTask({ registry, close })).rejects.toThrow("Foreign key constraint");
    expect(comments).toBe(1); expect(stateWrites).toBe(0); expect(closed).toBe(0);
    expect((await db.prisma.runtimeIssueUpdate.findFirstOrThrow()).commentPosted).toBeTrue();
    expect((await db.prisma.runtimeIssueUpdate.findFirstOrThrow()).published).toBeFalse();
    await db.prisma.$executeRawUnsafe("DROP TRIGGER fail_done_publication");
    await finalizeTask({ registry, close });
    expect(comments).toBe(1); expect(stateWrites).toBe(0); expect(closed).toBe(1);
    expect(await db.prisma.runtimeMetadataEvent.findMany({ where: { sequence: { in: originals.map(event => event.sequence) } }, orderBy: { sequence: "asc" } })).toEqual(originals);
    expect(await finalizeTask({ registry, close })).toMatchObject({ alreadyClosed: true });
    expect(closed).toBe(1);
  } finally { await server.stop(true); }
}, 60_000);
async function fixture(beforePrepare?: () => Promise<void>) {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture"); git(root, "worktree", "add", "-b", "codex/task", worktree);
  const repository = testConfig().repository;
  const config = testConfig({ repository: { ...repository, root, workflows: { ...repository.workflows, merge: { ...repository.workflows.review!, id: "merge", when: [{ "issue.state": ["Merge"] }] } } } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: root, toolingRevision: "a".repeat(40), pinnedToolingRoot: root, phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "unresolved-clerk", kind: "clerk-session", purpose: "development", externalId: "fixture-only-clerk", state: "ready" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "blocked", name: "Blocked", type: "started" }, { id: "review", name: "Manual Review", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", updatedAt: "2026-10-30T04:00:00.000Z", branchName: "codex/task", title: "Task", description: "Request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const context = { prisma: db.prisma, config, taskId: "task" };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "original-owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "original-verified", passed: true, evidence: ["Accepted original content"] } });
  const head = git(worktree, "rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const finalizer = { prisma: db.prisma, config, sessionId: session.id, requestKey: "finalize:task" };
  const finalizationDependencies = { source: async () => ({ session, link, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, { ...completionObservation, remote: async () => remote }), snapshot: completionObservation.snapshot };
  await beforePrepare?.();
  const prepared = await prepareTaskFinalization(finalizer, finalizationDependencies);
  const preparation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.preparedRevision } });

  issue.state = { id: "done", name: "Done", type: "completed" };
  issue.team.states.nodes.push(issue.state);
  const remoteObservation = async () => ({ id: "retirement", repository: "owner/product", pullRequest: 12, url: remote.pullRequest.url, reviewedHead: head, mergeCommit: remote.pullRequest.mergeCommit.oid, mergedAt: new Date(0).toISOString(), baseHead: remote.remoteBase, ci: [] });
  const dependencies = { source: finalizationDependencies.source, snapshot: completionObservation.snapshot, remote: remoteObservation };
  const finalization = { ...finalizationDependencies, retirementRemote: remoteObservation };
  const request = async () => { const observed = await inspectDoneRetirement(context, dependencies); return DoneRetirementInput.parse({ version: 1, mode: "existing-preparation", requestKey: "done-retirement:fixture", expectedRevision: observed.revision, expectedBindingDigest: observed.bindingDigest, preparedRevision: observed.preparedRevision, preparedDigest: observed.preparedDigest, source: observed.source, basis: "Human standing authorization: finish delivered tasks and cleanup" }); };
  return { root, worktree, config, link, session, issue, context, contract, finalizer, finalization, prepared, preparation, dependencies, request };
}
