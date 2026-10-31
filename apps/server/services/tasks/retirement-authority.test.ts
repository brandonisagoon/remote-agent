import { Hono } from "hono";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { taskCompletionRoutes } from "../../routes/tasks/completion.ts";
import { RetirementAuthorityInput, inspectRetirementAuthority, setRetirementAuthority } from "./retirement-authority.ts";
import { RETIREMENT_AUTHORITY } from "./retirement-receipts.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { CompletionContractInput, assertCompletionAllowed, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { confirmTaskFinalization, prepareTaskFinalization } from "./finalization.ts";
import { FINALIZATION_PREPARED, FINALIZATION_CONFIRMED } from "./finalization-receipts.ts";
import { issueUpdateDelivery, publishSessionIssueUpdate } from "../sessions/issue-updates.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await realpath(await mkdtemp(path.join(tmpdir(), "task-retirement-"))); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("bare Done and generic resource claims never authorize retirement", async () => {
  const f = await fixture();
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "retirement-authorized", kind: "retirement", purpose: "tooling", externalId: "claimed", state: "ready", metadata: { authorized: true } } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("current owner Merge");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(0);
});

test("explicit owner retirement verifies delivery, preserves identity, and retries the same prepared Done handoff", async () => {
  const f = await fixture();
  const input = await f.authorization();
  const granted = await setRetirementAuthority({ ...f.context, authorization: input }, f.authorityDependencies);
  expect(await setRetirementAuthority({ ...f.context, authorization: input }, f.authorityDependencies)).toEqual(granted);
  const prepared = await prepareTaskFinalization(f.input, f.finalizationDependencies);
  if (!("retirement" in prepared)) throw new Error("Missing retirement handoff");
  expect(prepared.retirement?.authorityRevision).toBe(granted.revision);
  expect(prepared.retirement?.doneHandoff).toMatchObject({ requestKey: "finalize:task:done", expectedState: "Done", state: "Done" });
  expect(f.issue.state.name).toBe("Done");
  await expect(confirmTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("still exists");
  f.remove();
  expect(await prepareTaskFinalization(f.input, f.finalizationDependencies)).toEqual(prepared);
  const confirmed = await confirmTaskFinalization(f.input, f.finalizationDependencies);
  if (!("retirement" in confirmed)) throw new Error("Missing confirmed retirement handoff");
  expect(await confirmTaskFinalization(f.input, f.finalizationDependencies)).toEqual(confirmed);
  expect(confirmed.preparedRevision).toBe(prepared.preparedRevision);
  let comments = 0, stateWrites = 0;
  const client = { ...issueUpdateDelivery, source: f.dependencies.source, read: async () => f.issue,
    graph: async () => ({ id: f.issue.id, identifier: f.issue.identifier, children: [], states: f.states }),
    create: async (_config: unknown, value: { id?: string }) => { comments++; return { id: value.id! }; },
    update: async () => { stateWrites++; },
  };
  const handoff = { ...f.input, ...confirmed.retirement!.doneHandoff, evidence: [] };
  expect((await publishSessionIssueUpdate(handoff, client)).published).toBe(true);
  expect((await publishSessionIssueUpdate(handoff, client)).published).toBe(true);
  expect(comments).toBe(1); expect(stateWrites).toBe(0);
  expect(await prepareTaskFinalization(f.input, f.finalizationDependencies)).toEqual(confirmed);
  const task = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  expect(task).toMatchObject({ primarySessionId: "primary", toolingRoot: directory, pinnedToolingRoot: directory, toolingRevision: "a".repeat(40) });
});

test("revocation prevents both new cleanup and confirmation after interrupted removal", async () => {
  const f = await fixture();
  const grant = await f.grant();
  const prepared = await prepareTaskFinalization(f.input, f.finalizationDependencies);
  f.remove();
  await setRetirementAuthority({ ...f.context, authorization: { requestKey: "owner-revoke", action: "revoke", expectedRevision: grant.revision, basis: "Owner withdrew retirement" } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("revoked");
  await expect(confirmTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("revoked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
  expect((await db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: FINALIZATION_PREPARED } })).sequence).toBe(prepared.preparedRevision);
});

test("stale owner writes and replayed grants cannot undo revocation", async () => {
  const f = await fixture();
  const authorization = await f.authorization();
  if (authorization.action !== "authorize") throw new Error("Unexpected fixture action");
  const grant = await setRetirementAuthority({ ...f.context, authorization }, f.authorityDependencies);
  await expect(setRetirementAuthority({ ...f.context, authorization: { ...authorization, requestKey: "stale" } }, f.authorityDependencies)).rejects.toThrow("authority changed");
  await setRetirementAuthority({ ...f.context, authorization: { requestKey: "revoke", action: "revoke", expectedRevision: grant.revision, basis: "Stop" } });
  await expect(setRetirementAuthority({ ...f.context, authorization }, f.authorityDependencies)).rejects.toThrow("superseded");
});

test.each(["toolingRevision", "pinnedToolingRoot", "worktreePath", "branchName", "ownerPaused", "phase"])("a changed %s invalidates the exact task grant", async field => {
  const f = await fixture(); await f.grant(); await prepareTaskFinalization(f.input, f.finalizationDependencies);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { [field]: field === "ownerPaused" ? true : field === "phase" ? "closed" : "changed" } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow();
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(0);
});

test("only state and observation changes preserve exact resource identity", async () => {
  const f = await fixture();
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "service", kind: "local-http", purpose: "development", externalId: "http://127.0.0.1:4173", state: "ready", metadata: { pid: 12345, launcher: "/private/original-launcher", observed: "ready" } } });
  await f.grant();
  const prepared = await prepareTaskFinalization(f.input, f.finalizationDependencies);
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { state: "released", metadata: { pid: 12345, launcher: "/private/original-launcher", observed: "absent", observedAt: new Date().toISOString() } } });
  expect(await prepareTaskFinalization(f.input, f.finalizationDependencies)).toEqual(prepared);
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: { pid: 99999, launcher: "/private/original-launcher" } } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("binding changed");
});

test("new resource and resurrected released receipt both invalidate retirement", async () => {
  const f = await fixture();
  const old = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "old", kind: "evidence", purpose: "review", externalId: "/private/evidence", state: "released" } });
  await f.grant();
  await db.prisma.remoteTaskResource.update({ where: { id: old.id }, data: { state: "ready" } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("binding changed");
  await db.prisma.remoteTaskResource.update({ where: { id: old.id }, data: { state: "released" } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "new", kind: "evidence", purpose: "tooling", externalId: "/private/other", state: "released" } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("binding changed");
});

test("missing accepted verification, dirty bytes, mismatched delivery and absent ancestry never create a grant", async () => {
  const f = await fixture();
  const authorization = await f.authorization();
  for (const delivery of [{ ...f.delivery, head: "d".repeat(40) }, { ...f.delivery, mergeCommit: "d".repeat(40) }, { ...f.delivery, pullRequest: 13 }, { ...f.delivery, baseBranch: "other" }]) {
    await expect(setRetirementAuthority({ ...f.context, authorization: { ...authorization, delivery } }, f.authorityDependencies)).rejects.toThrow("delivery does not match");
  }
  await expect(setRetirementAuthority({ ...f.context, authorization }, { ...f.authorityDependencies, remote: async () => { throw new Error("Merge is not an ancestor of staging"); } })).rejects.toThrow("not an ancestor");
  await writeFile(path.join(f.worktree, "README.md"), "unarchived work\n");
  await expect(setRetirementAuthority({ ...f.context, authorization }, f.authorityDependencies)).rejects.toThrow();
  git(f.worktree, "restore", "README.md");
  await db.prisma.runtimeMetadataEvent.deleteMany({ where: { action: "completion-verification" } });
  await expect(setRetirementAuthority({ ...f.context, authorization }, f.authorityDependencies)).rejects.toThrow("accepted verification");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: RETIREMENT_AUTHORITY } })).toBe(0);
});

test("fresh source, provider delivery, resource and verification changes are checked on retries", async () => {
  const f = await fixture(); await f.grant(); await prepareTaskFinalization(f.input, f.finalizationDependencies);
  f.issue.state = f.states[0]!;
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("retirement authority changed");
  f.issue.state = f.states[1]!;
  await expect(prepareTaskFinalization(f.input, { ...f.finalizationDependencies, retirementRemote: async () => { throw new Error("Current base no longer contains merge"); } })).rejects.toThrow("no longer contains");
  await recordCompletionVerification({ ...f.context, verification: { requestKey: "new-check", passed: true, evidence: ["A different verification receipt"] } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("binding changed");
});

test("owner authorization rechecks resource binding after slow provider observations", async () => {
  const f = await fixture();
  const authorization = await f.authorization();
  await expect(setRetirementAuthority({ ...f.context, authorization }, { ...f.authorityDependencies, remote: async () => {
    await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "racing", kind: "evidence", purpose: "tooling", externalId: "/private/new", state: "ready" } });
    return f.retirementRemote();
  } })).rejects.toThrow("binding changed during");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: RETIREMENT_AUTHORITY } })).toBe(0);
});

test("retirement inspection and writes require owner bearer on the local socket", async () => {
  const f = await fixture();
  const app = new Hono<AppEnv>();
  app.use("*", contextMiddleware({ config: f.config, prisma: db.prisma, commandClient: bunCommandClient, agentRuntime: createFakeAgentRuntime() }));
  app.route("/api/tasks", taskCompletionRoutes);
  for (const method of ["GET", "PUT"]) for (const authorization of [undefined, "Bearer session-not-owner"]) {
    expect((await app.request("/api/tasks/task/completion/retirement", { method, headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" }, ...(method === "PUT" ? { body: JSON.stringify({ action: "revoke", requestKey: "owner-revoke", expectedRevision: 0, basis: "Stop" }) } : {}) })).status).toBe(401);
  }
  expect((await app.request("/api/tasks/task/completion/retirement", { method: "PUT", headers: { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ action: "revoke", requestKey: "owner-revoke", expectedRevision: 0, basis: "Stop" }) })).status).toBe(200);
});

test("owner can recover a lost revision and revoke after the task becomes ineligible", async () => {
  const f = await fixture(); await f.grant();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  const inspected = await inspectRetirementAuthority(f.context, f.authorityDependencies);
  expect(inspected).toMatchObject({ eligible: false, action: "authorize" });
  expect(inspected.revision).toBeGreaterThan(0);
  expect("bindingDigest" in inspected).toBeFalse();
  expect("bindingError" in inspected).toBeTrue();
  await setRetirementAuthority({ ...f.context, authorization: { requestKey: "recovered-revoke", action: "revoke", expectedRevision: inspected.revision, basis: "Stop while paused" } });
  expect(await inspectRetirementAuthority(f.context, f.authorityDependencies)).toMatchObject({ eligible: false, action: "revoke" });
});

test("legacy launcher identity expansion must finish before the grant freezes resources", async () => {
  const f = await fixture();
  const resource = await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "launch", kind: "launch-agent", purpose: "development", externalId: "ai.drafted.task.task.api", state: "ready", metadata: { plist: "/private/old.plist" } } });
  expect((await inspectRetirementAuthority(f.context, f.authorityDependencies)).eligible).toBeFalse();
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: { manifest: "/private/exact.plist", sha256: "a".repeat(64) } } });
  await f.grant();
  await db.prisma.remoteTaskResource.update({ where: { id: resource.id }, data: { metadata: { manifest: "/private/rebound.plist", sha256: "a".repeat(64) } } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("binding changed");
});

test("source state and explicit revocation during remote observation deny cleanup", async () => {
  const f = await fixture(); const grant = await f.grant();
  await expect(prepareTaskFinalization(f.input, { ...f.finalizationDependencies, retirementRemote: async () => {
    f.issue.state = f.states[2]!;
    return f.retirementRemote();
  } })).rejects.toThrow("source authority changed");
  f.issue.state = f.states[1]!;
  await expect(prepareTaskFinalization(f.input, { ...f.finalizationDependencies, retirementRemote: async () => {
    await setRetirementAuthority({ ...f.context, authorization: { requestKey: "mid-observation-revoke", expectedRevision: grant.revision, action: "revoke", basis: "Stop" } });
    return f.retirementRemote();
  } })).rejects.toThrow("revoked");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(0);
});

test("a closed original primary and revoked completion contract cannot consume retirement authority", async () => {
  const f = await fixture(); await f.grant();
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed" } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("original operation recorded before settled primary closure");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: { in: [FINALIZATION_PREPARED, "finalization-cleanup-started", FINALIZATION_CONFIRMED] } } })).toBe(0);
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "idle" } });
  await f.revoke();
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow("existing merge authority");
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual Drafted client retires a Done task and retries a lost publication response without a backwards state change", async () => {
  const f = await fixture(); await f.grant();
  const { finalizeTask } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/finalize.ts"));
  let comments = 0, stateWrites = 0, closes = 0, publications = 0;
  const client = { ...issueUpdateDelivery, source: f.dependencies.source, read: async () => f.issue,
    graph: async () => ({ id: f.issue.id, identifier: f.issue.identifier, children: [], states: f.states }),
    create: async (_config: unknown, value: { id?: string }) => { comments++; return { id: value.id! }; }, update: async () => { stateWrites++; },
  };
  const registry = {
    task: async () => ({ ...await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } }), resources: [] }),
    resource: async () => { throw new Error("No fixture resource writes expected"); },
    prepareFinalization: () => prepareTaskFinalization(f.input, f.finalizationDependencies),
    confirmFinalization: () => confirmTaskFinalization(f.input, f.finalizationDependencies),
    publishIssueUpdate: async (handoff: { requestKey: string; body: string; expectedState: string; state: string }) => {
      const result = await publishSessionIssueUpdate({ ...f.input, ...handoff, evidence: [] }, client);
      if (!publications++) throw new Error("Lost publication response");
      return result;
    },
  };
  await expect(finalizeTask({ registry, close: async () => { closes++; } })).rejects.toThrow("Lost publication response");
  expect(git(f.root, "worktree", "list", "--porcelain")).not.toContain(f.worktree);
  expect(comments).toBe(1); expect(stateWrites).toBe(0); expect(closes).toBe(0);
  expect((await finalizeTask({ registry, close: async () => { closes++; } })).closed).toBe(true);
  expect(comments).toBe(1); expect(stateWrites).toBe(0); expect(closes).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_PREPARED } })).toBe(1);
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: FINALIZATION_CONFIRMED } })).toBe(1);
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT).each(["named", "quick"])("actual %s preview cleanup preserves frozen retirement authority through exact lifecycle writes", async kind => {
  const f = await fixture();
  const root = process.env.DRAFTED_INTEGRATION_ROOT!;
  const { releasePublicPreview, reconcilePublicPreview } = await import(path.join(root, "src/public-preview.ts"));
  const { guardedRetirementRegistry } = await import(path.join(root, "src/finalize.ts"));
  const hostname = kind === "quick" ? "task-random.trycloudflare.com" : "task.example.test";
  const tunnelId = "11111111-2222-3333-4444-555555555555", zone = "b".repeat(32), account = "a".repeat(32), dnsId = "c".repeat(32);
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "endpoint", kind: "local-http", purpose: "review", externalId: "http://127.0.0.1:4173", state: "ready", metadata: { publicUrl: `https://${hostname}`, ...(kind === "quick" ? { connectorKeys: ["connector"] } : {}) } } });
  await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "connector", kind: "docker-container", purpose: "review", externalId: "d".repeat(64), state: "ready", metadata: { image: "fixture" } } });
  if (kind === "named") {
    await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "dns", kind: "cloudflare-dns-record", purpose: "review", externalId: hostname, state: "ready", metadata: { zone, hostname, content: `${tunnelId}.cfargotunnel.com` } } });
    await db.prisma.remoteTaskResource.create({ data: { taskId: "task", key: "tunnel", kind: "cloudflare-tunnel", purpose: "review", externalId: tunnelId, state: "ready", metadata: { tunnelId, hostname, accountId: account, zoneId: zone, name: "task-preview", shared: true } } });
  }
  const registry = {
    task: async () => ({ ...await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } }), resources: (await db.prisma.remoteTaskResource.findMany({ where: { taskId: "task" } })).map(resource => ({ ...resource, expiresAt: resource.expiresAt?.toISOString() ?? null })) }),
    resource: async (receipt: { key: string; kind: string; externalId: string; purpose: string; state: string; metadata: object }) => { await db.prisma.remoteTaskResource.update({ where: { taskId_key: { taskId: "task", key: receipt.key } }, data: receipt }); },
  };
  let dns: { id: string; type: string; name: string; content: string } | null = { id: dnsId, type: "CNAME", name: hostname, content: `${tunnelId}.cfargotunnel.com` };
  let lostDelete = kind === "named";
  const calls: string[] = [];
  const provider = { request: async (method: string, route: string) => {
    calls.push(`${method} ${route}`);
    if (route.includes("dns_records")) {
      if (method === "DELETE") { dns = null; if (lostDelete) { lostDelete = false; throw new Error("Lost DNS delete response"); } return null; }
      return route.includes("?") ? dns ? [dns] : [] : dns;
    }
    throw new Error(`Unexpected provider call ${method} ${route}`);
  } };
  if (kind === "named") {
    expect((await inspectRetirementAuthority(f.context, f.authorityDependencies)).eligible).toBeFalse();
    await expect(setRetirementAuthority({ ...f.context, authorization: { action: "authorize", requestKey: "premature", expectedRevision: 0, expectedBindingDigest: "e".repeat(64), basis: "Unreconciled", delivery: f.delivery } }, f.authorityDependencies)).rejects.toThrow("Reconcile exact public preview");
  }
  await reconcilePublicPreview({ registry, key: "endpoint", provider });
  expect(calls.every(call => call.startsWith("GET"))).toBeTrue();
  expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: "connector" } } })).state).toBe("ready");
  await f.grant();
  const prepared = await prepareTaskFinalization(f.input, f.finalizationDependencies);
  const guarded = guardedRetirementRegistry(registry, async () => { expect(await prepareTaskFinalization(f.input, f.finalizationDependencies)).toEqual(prepared); });
  const releaseConnector = async (key: string) => {
    const resource = (await registry.task()).resources.find(item => item.key === key)!;
    await guarded.resource({ ...resource, state: "released" });
  };
  if (kind === "named") {
    const recorded = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: "dns" } } });
    const observed = provider.request;
    provider.request = async (method, route) => {
      const result = await observed(method, route);
      if (method === "GET") await db.prisma.remoteTaskResource.update({ where: { id: recorded.id }, data: { metadata: { ...recorded.metadata as object, dnsRecordId: "f".repeat(32) } } });
      return result;
    };
    await expect(releasePublicPreview({ registry: guarded, key: "endpoint", provider, releaseConnector })).rejects.toThrow("binding changed");
    expect(calls.some(call => call.startsWith("DELETE"))).toBeFalse();
    await db.prisma.remoteTaskResource.update({ where: { id: recorded.id }, data: { metadata: recorded.metadata! } });
    provider.request = observed;
  }
  if (kind === "named") await expect(releasePublicPreview({ registry: guarded, key: "endpoint", provider, releaseConnector })).rejects.toThrow("Lost DNS delete response");
  await releasePublicPreview({ registry: guarded, key: "endpoint", provider, releaseConnector });
  expect(await prepareTaskFinalization(f.input, f.finalizationDependencies)).toEqual(prepared);
  expect((await registry.task()).resources.find(item => item.key === "endpoint")!.metadata).toMatchObject({ publicUrl: null, publicPreviewCleanup: { complete: true, hostname } });
  expect(calls.filter(call => call.startsWith("DELETE"))).toHaveLength(kind === "named" ? 1 : 0);
  const count = calls.length;
  await releasePublicPreview({ registry: guarded, key: "endpoint", provider, releaseConnector });
  expect(calls.length).toBe(count);
  const endpoint = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: "task", key: "endpoint" } } });
  await db.prisma.remoteTaskResource.update({ where: { id: endpoint.id }, data: { metadata: { ...endpoint.metadata as object, publicPreviewCleanup: { complete: true, hostname: "someone-else.example.test", observedAt: new Date().toISOString(), quickTunnelConnectorRemoved: true } } } });
  await expect(prepareTaskFinalization(f.input, f.finalizationDependencies)).rejects.toThrow();
});

async function fixture() {
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  await mkdir(root); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(root, "README.md"), "accepted content\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  git(root, "worktree", "add", "-b", "codex/task", worktree);
  const config = testConfig({ repository: { ...testConfig().repository, root } });
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-75", primarySessionId: session.id, branchName: "codex/task", worktreePath: worktree, toolingRoot: directory, toolingRevision: "a".repeat(40), pinnedToolingRoot: directory, phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-75", relationship: "handles" } });
  const states = [{ id: "merge", name: "Merge", type: "started" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Blocked", type: "started" }];
  const issue = { id: "issue", identifier: "DRA-75", branchName: "codex/task", title: "Task", description: "Request", state: states[1]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const context = { prisma: db.prisma, config, taskId: task.id };
  const contract = await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner", expectedRevision: 0, boundary: "merge", basis: "Owner accepted Merge", repository: "owner/product", pullRequest: 12, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "owner-verified", passed: true, evidence: ["Owner accepted verified content"] } });
  const head = git(worktree, "rev-parse", "HEAD");
  const remote = { remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: { url: "https://github.com/owner/product/pull/12", headRefOid: head, headRefName: "codex/task", baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) } } };
  const observer = { ...completionObservation, remote: async () => remote };
  const input = { prisma: db.prisma, config, sessionId: session.id, requestKey: "finalize:task" };
  const dependencies = { source: async () => ({ session, link, config, issue }), completion: (value: Parameters<typeof assertCompletionAllowed>[0]) => assertCompletionAllowed(value, observer), snapshot: completionObservation.snapshot };
  const remove = () => git(root, "worktree", "remove", worktree);
  const revoke = () => setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "revoke", expectedRevision: contract.revision, boundary: "revoked", basis: "Owner withdrew delivery" }) });
  const retirementRemote = async () => ({ id: "retirement", repository: "owner/product", pullRequest: 12, url: remote.pullRequest.url, reviewedHead: head, mergeCommit: remote.pullRequest.mergeCommit.oid, mergedAt: new Date(0).toISOString(), baseHead: remote.remoteBase, ci: [] });
  const authorityDependencies = { ...dependencies, remote: retirementRemote };
  const finalizationDependencies = { ...dependencies, retirementRemote };
  const delivery = { repository: "owner/product", pullRequest: 12, head, mergeCommit: remote.pullRequest.mergeCommit.oid, baseBranch: "main" };
  const authorization = async () => {
    const inspected = await inspectRetirementAuthority(context, authorityDependencies);
    if (!inspected.eligible) throw new Error(inspected.bindingError);
    const parsed = RetirementAuthorityInput.parse({ requestKey: "owner-retire", expectedRevision: 0, action: "authorize", basis: "Retire this exact accepted delivery without changing Done", expectedBindingDigest: inspected.bindingDigest, delivery });
    if (parsed.action !== "authorize") throw new Error("Unexpected fixture action");
    return parsed;
  };
  const grant = async () => setRetirementAuthority({ ...context, authorization: await authorization() }, authorityDependencies);
  return { authorization, grant, delivery, authorityDependencies, finalizationDependencies, retirementRemote, root, worktree, config, session, task, issue, states, context, contract, remote, observer, input, dependencies, remove, revoke };
}

