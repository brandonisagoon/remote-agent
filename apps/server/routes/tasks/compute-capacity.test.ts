import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { createApp } from "../../app.ts";
import { refreshComputeBaselines } from "../../services/tasks/compute-baseline.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function fixture(enabled = true, maxManagedAllocations?: number, slots = 0) {
  const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled, slots, maxManagedAllocations }) }), runtime = createFakeAgentRuntime();
  const now = new Date(); let observed = 0;
  runtime.observeSessionActivity = () => { observed++; return { state: "unknown", observedAt: Date.now() }; };
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", machineId: "host", repositoryId: "repo", cwd: "/fixture", role: "primary", status: "closed", closedAt: now } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", machineId: "host", repositoryId: "repo", primarySessionId: "primary", worktreePath: "/fixture", branchName: "codex/fixture", toolingRoot: "/fixture/tooling", toolingRevision: "a".repeat(40), phase: "closed" } });
  await db.prisma.remoteTaskResource.create({ data: { id: "app", taskId: "task", key: "app", kind: "docker-container", purpose: "development", externalId: "container", state: "ready" } });
  await refreshComputeBaselines({ prisma: db.prisma, config, runtime, now }, async (_input, _task, request: any) => ({ version: 1, kind: "compute-baseline", machineId: request.machineId, taskId: request.task.id, primarySessionId: request.task.primarySessionId, purpose: request.purpose, resourceSetDigest: request.resourceSetDigest, observedAt: now.getTime(), resources: request.resources.map((r: any) => ({ resourceId: r.id, resourceIdentity: r.identityDigest, state: "stopped", proofDigest: "d".repeat(64) })) }));
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime });
  const get = (suffix = "?capacity=1", authorization = `Bearer ${config.apiKey}`, task = "task") => app.request(`/api/tasks/${task}/compute-policy${suffix}`, { headers: { authorization } });
  return { config, runtime, get, observations: () => observed };
}
async function allRows() {
  const tables = await db.prisma.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  return Promise.all(tables.map(async ({ name }) => ({ name, rows: await db.prisma.$queryRawUnsafe(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`) })));
}
test("opt-in GET uses the daemon observation and preserves every row without refreshing/provisioning", async () => {
  const f = await fixture(), before = await allRows(), priorObservations = f.observations();
  f.runtime.history = async () => { throw Error("GET must not call provider history"); };
  const response = await f.get(), body = await response.json() as any;
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ enabled: true, capacity: { slots: 0, unaccounted: 0, occupied: 0, usable: 0, headroom: 0 } });
  expect(Number.isFinite(Date.parse(body.capacity.observedAt))).toBe(true);
  expect(body.capacity).not.toHaveProperty("maxManagedAllocations");
  expect(body.capacity).not.toHaveProperty("budgetUsable");
  expect(f.observations()).toBeGreaterThan(priorObservations);
  expect(await allRows()).toEqual(before);
  expect(JSON.stringify(body)).not.toContain(configKey(f.config));
});
function configKey(config: ReturnType<typeof testConfig>) { return config.apiKey; }
test("default response is unchanged; disabled diagnostic grants no capacity and makes no observation", async () => {
  const f = await fixture(false), before = f.observations();
  expect(await (await f.get("")).json()).toEqual({ enabled: false });
  expect(await (await f.get()).json()).toEqual({ enabled: false, capacity: null });
  expect(f.observations()).toBe(before);
});
test("existing network authentication covers capacity and rejects before observing", async () => {
  const f = await fixture(), before = await allRows(), observed = f.observations();
  expect((await f.get("?capacity=1", "")).status).toBe(401);
  expect((await f.get("?capacity=1", "Bearer invalid")).status).toBe(401);
  expect(f.observations()).toBe(observed); expect(await allRows()).toEqual(before);
  expect((await f.get()).status).toBe(200);
  expect(await (await f.get("")).json()).toEqual({ enabled: true });
});
test("missing observation or missing/foreign owner refuses instead of returning guessed free capacity", async () => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { machineId: "other" } });
  expect((await f.get()).status).toBe(409);
  expect((await f.get("?capacity=1", `Bearer ${f.config.apiKey}`, "missing")).status).toBe(409);
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { machineId: "host" } });
  f.runtime.observeSessionActivity = undefined;
  const response = await f.get(); expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Compute capacity could not be observed; existing reservations were preserved" });
});
test("all occupied ordinals remain debited and negative headroom is visible without creating slots", async () => {
  const f = await fixture();
  await db.prisma.computeSlot.create({ data: { id: "host:99", machineId: "host", ordinal: 99, allocationId: "existing" } });
  const before = await allRows();
  expect(await (await f.get()).json()).toMatchObject({ capacity: { slots: 0, unaccounted: 0, occupied: 1, usable: 0, headroom: -1 } });
  expect(await allRows()).toEqual(before);
});

test("configured managed cap exposes effective and total-budget capacity without changing any rows", async () => {
  const f = await fixture(true, 1, 19), before = await allRows();
  expect(await (await f.get()).json()).toMatchObject({ capacity: { slots: 19, maxManagedAllocations: 1, budgetUsable: 19, unaccounted: 0, occupied: 0, usable: 1, headroom: 1 } });
  expect(await allRows()).toEqual(before);
  await db.prisma.computeSlot.create({ data: { id: "host:99", machineId: "host", ordinal: 99, allocationId: "unknown-reservation" } });
  expect(await (await f.get()).json()).toMatchObject({ capacity: { budgetUsable: 19, occupied: 1, usable: 1, headroom: 0 } });
});

test("a managed cap cannot turn insufficient total budget into capacity", async () => {
  const f = await fixture(true, 1, 0);
  expect(await (await f.get()).json()).toMatchObject({ capacity: { maxManagedAllocations: 1, budgetUsable: 0, usable: 0, headroom: 0 } });
});
