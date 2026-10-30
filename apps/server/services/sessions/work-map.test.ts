import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { recordWorkMap, workMapProjection, assertMappedIssueDelivery } from "./work-map.ts";
import { WorkMapInput, assertNoRemainingConsumers, WORK_MAP } from "../tasks/work-map-state.ts";
import { inspectPreparedCleanupAuthority } from "../tasks/cleanup-lifecycle.ts";
import { prepareTaskFinalization } from "../tasks/finalization.ts";
import type { IssueWorkGraph } from "../../integrations/linear/session-store/source-issue/work-graph.ts";

let db: TestDatabase;
afterEach(async () => { await db?.cleanup(); });
async function fixture() {
  db = await createTestDatabase();
  const config = testConfig();
  const session = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", role: "primary", status: "idle", agentCommand: "codex", cwd: "/tmp/work-map-task", repositoryId: config.repository.id, machineId: config.machine } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", primarySessionId: session.id, repositoryId: config.repository.id, machineId: config.machine, worktreePath: session.cwd, branchName: "codex/task", toolingRoot: "/immutable/tooling", toolingRevision: "a".repeat(40), pinnedToolingRoot: "/immutable/pin", connectionId: config.activeConnectionId, issueIdentifier: "DRA-195", phase: "complete" } });
  const link = await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId!, resourceType: "issue-identifier", externalId: task.issueIdentifier!, relationship: "handles" } });
  const states = [{ id: "done", name: "Done", type: "completed" }];
  const issue = { id: "parent", identifier: "DRA-195", title: "Outcome", branchName: null, description: "Original", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const graph: IssueWorkGraph = { id: issue.id, identifier: issue.identifier, states, children: ["implementation", "verification"].map(id => ({ id, identifier: id, title: id, url: `https://linear.app/issue/${id}`, state: states[0]!, completedAt: null, parent: { id: issue.id, identifier: issue.identifier }, blockedBy: [], blocks: [] })) };
  const client = { source: async () => ({ session, link, config, issue }), graph: async () => graph };
  const context = { prisma: db.prisma, config, sessionId: session.id };
  const map = WorkMapInput.parse({ version: 1, requestKey: "scope-1", expectedRevision: 0, units: [
    { issueId: "parent", kind: "outcome", acceptance: "Combined accepted behavior", deliveryIds: ["product"] },
    ...graph.children.map(c => ({ issueId: c.id, kind: "work-item", acceptance: "Its own functional check", deliveryIds: ["product"] })),
  ], deliveries: [{ id: "product", scope: "Requested behavior", boundary: "merge", dependsOn: [], proposed: { repository: "owner/product", branch: task.branchName, baseBranch: "main" }, pullRequest: { repository: "owner/product", number: 1, head: "b".repeat(40) } }], remainingConsumers: [] });
  return { context, task, session, link, issue, graph, client, map };
}

test("checklist/work items share a PR without new sessions or cleanup; planned refs are not observed delivery", async () => {
  const f = await fixture();
  const before = await db.prisma.runtimeSession.findMany();
  expect((await workMapProjection(f.context, f.graph)).mapping).toBeNull();
  await assertNoRemainingConsumers(db.prisma, f.task);
  await recordWorkMap({ ...f.context, map: f.map }, f.client);
  const projection = await workMapProjection(f.context, f.graph);
  expect(projection.mapping?.deliveries).toHaveLength(1);
  expect(projection.mapping?.deliveries[0]).toMatchObject({ observation: null, boundaryObserved: false, facts: { pullRequest: false, review: null, merge: false, deployed: null } });
  await assertMappedIssueDelivery(f.context, f.graph, "implementation");
  await assertMappedIssueDelivery(f.context, f.graph, "verification");
  await expect(assertMappedIssueDelivery(f.context, f.graph, "parent")).rejects.toThrow("unobserved");
  expect(await db.prisma.runtimeSession.findMany()).toEqual(before);
  expect(await db.prisma.remoteTaskResource.count()).toBe(0);
  expect(await db.prisma.remoteTask.findUnique({ where: { id: f.task.id } })).toEqual(f.task);
});

test("retries survive reconnect, preserve old snapshots and reject reused keys or stale scope", async () => {
  const f = await fixture();
  const first = await recordWorkMap({ ...f.context, map: f.map }, f.client);
  const original = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: first.revision } });
  await db.prisma.$disconnect();
  expect(await recordWorkMap({ ...f.context, map: f.map }, f.client)).toMatchObject({ revision: first.revision, replayed: true });
  await expect(recordWorkMap({ ...f.context, map: { ...f.map, remainingConsumers: [{ issueId: "verification", reason: "Still testing" }] } }, f.client)).rejects.toThrow("different scope");
  await expect(recordWorkMap({ ...f.context, map: { ...f.map, requestKey: "stale" } }, f.client)).rejects.toThrow("changed");
  const second = await recordWorkMap({ ...f.context, map: { ...f.map, requestKey: "scope-2", expectedRevision: first.revision, remainingConsumers: [{ issueId: "verification", reason: "Still testing" }] } }, f.client);
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(await db.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: first.revision } })).toEqual(original);
  expect((await recordWorkMap({ ...f.context, map: f.map }, f.client)).revision).toBe(first.revision);
  expect((await workMapProjection(f.context, f.graph)).mapping?.revision).toBe(second.revision);
});

test("only explicit consumers block both initial preparation and existing-operation authority; child Done never clears them", async () => {
  const f = await fixture();
  const first = await recordWorkMap({ ...f.context, map: { ...f.map, remainingConsumers: [{ issueId: "verification", reason: "Needs the existing app for combined acceptance" }] } }, f.client);
  await expect(prepareTaskFinalization({ ...f.context, requestKey: "finalize:task" })).rejects.toThrow("explicitly recorded work consumers");
  await expect(inspectPreparedCleanupAuthority({ ...f.context, requestKey: "finalize:task" })).rejects.toThrow("explicitly recorded work consumers");
  await assertMappedIssueDelivery(f.context, f.graph, "verification");
  await expect(assertNoRemainingConsumers(db.prisma, f.task)).rejects.toThrow("explicitly recorded work consumers");
  await recordWorkMap({ ...f.context, map: { ...f.map, requestKey: "finished-consumers", expectedRevision: first.revision } }, f.client);
  await assertNoRemainingConsumers(db.prisma, f.task);
  // Clearing a hold does not manufacture preparation, approval or effect authority.
  await expect(inspectPreparedCleanupAuthority({ ...f.context, requestKey: "finalize:task" })).rejects.toThrow("existing preparation");
});

test("pause, primary/pin/source drift and late reparenting refuse without saving a map", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  await expect(recordWorkMap({ ...f.context, map: f.map }, f.client)).rejects.toThrow("unpaused original primary");
  await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  let reads = 0;
  await expect(recordWorkMap({ ...f.context, map: f.map }, { ...f.client, graph: async () => ++reads === 1 ? f.graph : { ...f.graph, children: [] } })).rejects.toThrow("current direct children");
  await expect(recordWorkMap({ ...f.context, map: f.map }, { ...f.client, graph: async () => { await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: "/other/pin" } }); return f.graph; } })).rejects.toThrow("identity changed");
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: WORK_MAP } })).toBe(0);
});

test("dependency and stack contracts reject cycles, duplicated PR identities and conflicting bases", async () => {
  const f = await fixture();
  const product = f.map.deliveries[0]!;
  for (const deliveries of [
    [{ ...product, dependsOn: ["product"] }],
    [product, { ...product, id: "duplicate" }],
    [{ ...product, dependsOn: ["missing"] }],
    [product, { ...product, id: "stack", pullRequest: undefined, dependsOn: ["product"], stackedOn: "product" }],
  ]) expect(WorkMapInput.safeParse({ ...f.map, deliveries }).success).toBeFalse();
  const stack = { ...product, id: "stack", pullRequest: undefined, proposed: { ...product.proposed!, branch: "codex/next", baseBranch: product.proposed!.branch }, dependsOn: ["product"], stackedOn: "product" };
  expect(WorkMapInput.safeParse({ ...f.map, deliveries: [product, stack] }).success).toBeTrue();
});

test("actual work-graph routes store bounded metadata and preserve task/session identity", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request, init) => {
    if (String(request) !== "https://api.linear.app/graphql") throw new Error("Unexpected route provider");
    const query = JSON.parse(String(init?.body)).query as string;
    const data = query.includes("SourceIssueWorkGraph") ? { ...f.issue, children: { nodes: f.graph.children.map(child => ({ ...child, relations: { nodes: [], pageInfo: { hasNextPage: false } }, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } } })), pageInfo: { hasNextPage: false } } } : f.issue;
    return Response.json({ data: { issue: data } });
  }) as typeof fetch;
  try {
    const app = createApp({ ...f.context, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const route = `/api/sessions/${f.session.id}/work-graph`;
    const request = () => app.request(route, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(f.map) });
    const result = await request(); expect(result.status).toBe(200);
    expect((await (await request()).json()).replayed).toBeTrue();
    const read = await app.request(route); expect(read.status).toBe(200);
    expect((await read.json()).mapping).toMatchObject({ authority: "none", units: f.map.units });
    expect(await db.prisma.remoteTask.findUnique({ where: { id: f.task.id } })).toEqual(f.task);
    expect(await db.prisma.runtimeSession.count()).toBe(1);
    expect(await db.prisma.runtimeInstruction.count()).toBe(0);
    expect(await db.prisma.remoteTaskResource.count()).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});

test("single-PR observations preserve separate review/merge/deployed facts and reject replaced contracts or heads", async () => {
  const f = await fixture();
  await recordWorkMap({ ...f.context, map: f.map }, f.client);
  const contract = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-contract", key: "contract", value: JSON.stringify({ boundary: "merge", repository: "owner/product", baseBranch: "main" }) } });
  const receipts = { contractRevision: contract.sequence, snapshot: { head: "b".repeat(40), branch: f.task.branchName, clean: true, fingerprint: "digest" },
    implementation: { source: "model-reported", phase: "complete" }, verification: { source: "owner-attested", matched: true, evidence: ["checked"] },
    commit: { observed: true, sha: "b".repeat(40), clean: true }, push: { observed: true, matchesHead: true }, pullRequest: { observed: true, matchesHead: true, url: "https://github.com/owner/product/pull/1" },
    review: { observed: true, approved: true }, merge: { observed: true, merged: false, sha: null as string | null } };
  const observe = (data = receipts) => db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `observer:${f.task.id}`, action: "completion-observation", key: String(contract.sequence), value: JSON.stringify(data) } });
  await observe();
  expect((await workMapProjection(f.context, f.graph)).mapping!.deliveries[0]).toMatchObject({ facts: { pullRequest: true, review: true, merge: false, deployed: null }, boundaryObserved: false });
  await observe({ ...receipts, merge: { observed: true, merged: true, sha: "c".repeat(40) } });
  await assertMappedIssueDelivery(f.context, f.graph, "parent");
  expect((await workMapProjection(f.context, f.graph)).mapping!.deliveries[0]!.facts.deployed).toBeNull();
  await observe({ ...receipts, verification: { ...receipts.verification, matched: false }, merge: { observed: true, merged: true, sha: "c".repeat(40) } });
  await expect(assertMappedIssueDelivery(f.context, f.graph, "parent")).rejects.toThrow("unobserved");
  await observe({ ...receipts, snapshot: { ...receipts.snapshot, head: "d".repeat(40) } });
  expect((await workMapProjection(f.context, f.graph)).mapping!.deliveries[0]!.observation).toBeNull();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `owner:${f.task.id}`, action: "completion-contract", key: "revoked", value: JSON.stringify({ boundary: "revoked" }) } });
  await expect(assertMappedIssueDelivery(f.context, f.graph, "parent")).rejects.toThrow("unobserved");
});
