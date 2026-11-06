/**
 * Boot recovery of tooling callbacks interrupted by a server process's exit.
 *
 * Isolated migrated SQLite. A REAL second Bun process (a stand-in server
 * instance with its own SERVER_INSTANCE stamp) runs the real guard path
 * (admitToolingCallback -> beforeBoundCallback [-> afterBoundCallback]) on the
 * same database and is SIGKILLed inside each crash window, so its PID
 * genuinely exits. Activation, begin, settlement and reconciliation are the
 * real services/routes; compute domain handlers are stand-ins. Rows written
 * directly are ADVERSARIAL evidence, used only to prove refusal.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../test-support/db.ts";
import { testConfig } from "../test-support/config.ts";
import type { AppEnv } from "../apps/server/middleware/context.ts";
import { toolingOperationGuard, toolingOperationRoutes } from "../apps/server/routes/tasks/tooling-operations.ts";
import { SERVER_INSTANCE, TOOLING_OPERATION_HEADER } from "../apps/server/services/tasks/tooling-operations.ts";
import { activateToolingRelease, canonicalDigest } from "../apps/server/services/tasks/tooling-releases.ts";
import { recoverInterruptedCallbacks } from "../apps/server/services/tasks/tooling-callback-recovery.ts";
import { computeTaskIdentity } from "../apps/server/services/tasks/compute-admission.ts";
import type { PreparedToolingRelease } from "../apps/server/services/tasks/tooling.ts";

for (const name of Object.keys(process.env)) if (name.startsWith("REMOTE_AGENT_")) delete process.env[name];
const ROOT = path.resolve(import.meta.dir, "..");
let db: TestDatabase, scratch: string;
beforeEach(async () => { db = await createTestDatabase(); scratch = mkdtempSync(path.join(tmpdir(), "callback-recovery-")); });
afterEach(async () => { await db.cleanup(); rmSync(scratch, { recursive: true, force: true }); });

const A = "a".repeat(40), POLICY = "f".repeat(40), KEY = "runtime-development", ENV = "22222222-2222-4222-8222-222222222222";
const computeBody = { key: KEY, purpose: "development", revision: "c".repeat(40), recipeDigest: "d".repeat(64) };
const manifest = { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 1 }, stateFormats: { "drafted.runtime": { read: [1, 2], write: 1, preservesUnknown: true } } };
/** Same configuration in this process and in the crashing server process. */
const CONFIG = `const base = testConfig({ machine: "host" });
const repository = { ...base.repository, id: "repo", tooling: { root: "/fixture/tooling-source", revision: "${"1".repeat(40)}", policyBlob: "${POLICY}" } };
const config = { ...base, repository, repositories: { repo: repository } };`;
const config = new Function("testConfig", `${CONFIG}; return config;`)(testConfig) as ReturnType<typeof testConfig>;
type Reply = { status: number; body: Record<string, any> };

async function fixture() {
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/task", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: "/fixture/task",
    toolingRoot: "/fixture/tooling-source", toolingRevision: "1".repeat(40), primarySessionId: "primary", phase: "working" } });
  const prepare = async (input: { repositoryId: string; revision: string }): Promise<PreparedToolingRelease> => ({ repositoryId: input.repositoryId, revision: input.revision, tree: "e".repeat(40),
    policyBlob: POLICY, checkout: `/install/tooling/repo/${input.revision}`, manifest: manifest as PreparedToolingRelease["manifest"], lockfileDigest: "0".repeat(64), bunVersion: "1.3.14" });
  await activateToolingRelease({ prisma: db.prisma, config, repositoryId: "repo", requestKey: "activate-a", revision: A, expectedGeneration: 0 }, { prepare, inventoryLegacyConsumers: async () => [] });
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  server.use("/api/*", toolingOperationGuard());
  server.route("/api/sessions", toolingOperationRoutes);
  server.all("/api/*", async c => { await c.req.json().catch(() => undefined); return c.json({}); });
  const post = async (route: string, body: unknown, operationId?: string): Promise<Reply> => {
    const response = await server.request(route, { method: "POST", headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const begin = (request: Record<string, unknown>) => post("/api/sessions/primary/tooling-operations", request);
  const fence = (await begin({ requestKey: "cmd", inputDigest: canonicalDigest({ command: "cmd" }), kind: "adapter-command", resourceKey: KEY })).body.binding;
  const child = (await begin({ requestKey: "cmd/compute-admission", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: fence.operationId })).body.binding;
  await db.prisma.computeEnvironment.create({ data: { id: ENV, taskId: "task", primarySessionId: "primary", machineId: "host", key: KEY, purpose: "development", revision: computeBody.revision,
    recipeDigest: computeBody.recipeDigest, state: "waiting", taskIdentity: computeTaskIdentity(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } }), "primary", "host", null) } });
  return {
    fence, child, post,
    call: (route: string, body: Record<string, unknown>) => post(`/api/tasks/task/${route}`, body, child.operationId),
    settle: () => post(`/api/sessions/primary/tooling-operations/${fence.operationId}/settlement`, { requestKey: fence.requestKey, inputDigest: fence.inputDigest, outcome: "completed" }, fence.operationId),
    status: async () => (await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: child.operationId } })).status,
    records: async () => (await db.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${child.operationId}` }, orderBy: { sequence: "asc" } })).map(event => JSON.parse(event.value!)),
  };
}

/** Another server process runs the real guard path and is killed in a window.
 * `window`: "intent" (after beforeBoundCallback) or "unknown-result"
 * (afterBoundCallback recorded unknown, then the status change never ran). */
async function crashingServer(operationId: string, route: string, body: Record<string, unknown>, window: "intent" | "unknown-result", kill = true) {
  const script = path.join(scratch, `crash-${crypto.randomUUID()}.ts`);
  writeFileSync(script, `import { testConfig } from ${JSON.stringify(path.join(ROOT, "test-support/config.ts"))};
import { createPrismaClient } from ${JSON.stringify(path.join(ROOT, "apps/server/prisma.ts"))};
import { admitToolingCallback, afterBoundCallback, beforeBoundCallback, toolingOperationDependencies, SERVER_INSTANCE } from ${JSON.stringify(path.join(ROOT, "apps/server/services/tasks/tooling-operations.ts"))};
${CONFIG}
const prisma = createPrismaClient(${JSON.stringify(db.databaseUrl)});
const admission = await admitToolingCallback({ prisma, config, method: "POST", pathname: ${JSON.stringify(`/api/tasks/task/${route}`)}, header: ${JSON.stringify(operationId)}, body: ${JSON.stringify(body)} });
if (!admission || admission.mode !== "bound") throw new Error("not admitted");
const state = await beforeBoundCallback(prisma, config, admission);
if (${JSON.stringify(window)} === "intent") { console.log(JSON.stringify({ window: "intent", server: SERVER_INSTANCE })); await new Promise(() => {}); }
await afterBoundCallback(prisma, admission, state, "exception", { ...toolingOperationDependencies,
  transition: async () => { console.log(JSON.stringify({ window: "unknown-result", server: SERVER_INSTANCE })); await new Promise(() => {}); } });
`);
  const child = Bun.spawn([process.execPath, "--no-env-file", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch } });
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 20_000;
  while (!text.includes("\n") && Date.now() < deadline) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); }
  if (!text.includes(`"window":"${window}"`)) { child.kill("SIGKILL"); throw new Error(`crash server did not reach ${window}: ${text} ${await new Response(child.stderr).text()}`); }
  const server = JSON.parse(text.trim().split("\n")[0]!).server as typeof SERVER_INSTANCE;
  if (kill) { child.kill("SIGKILL"); await child.exited; }
  return { server, child };
}

test("window 1 (intent, no result): stuck before recovery; recovery records the exact unknown result once; the exact replay reconciles and the command settles", async () => {
  const f = await fixture();
  const crashed = await crashingServer(f.child.operationId, "compute-request", computeBody, "intent");
  expect(crashed.server.pid).not.toBe(process.pid);
  expect(await f.status()).toBe("running");
  // Reproduction: the orphaned attempt blocks settlement forever.
  expect((await f.settle()).body.error).toContain("without a confirmed latest callback outcome");
  const recovered = await recoverInterruptedCallbacks({ prisma: db.prisma });
  expect(recovered).toEqual({ repaired: [{ operationId: f.child.operationId, attempts: [expect.any(String)], status: "unknown" }], blocked: [] });
  expect(await f.status()).toBe("unknown");
  const records = await f.records();
  const [intent, appended] = [records[0], records.at(-1)];
  expect(appended).toEqual({ version: 1, operationId: intent.operationId, role: "outcome", state: "unknown", attemptId: intent.attemptId, route: intent.route, inputDigest: intent.inputDigest,
    requestKey: intent.requestKey, status: null, evidence: `interrupted-by-restart:${crashed.server.instance}:${crashed.server.pid}:recovered-by:${SERVER_INSTANCE.instance}:${SERVER_INSTANCE.pid}` });
  // Idempotent: a second boot changes nothing.
  const count = (await f.records()).length;
  expect(await recoverInterruptedCallbacks({ prisma: db.prisma })).toEqual({ repaired: [], blocked: [] });
  expect((await f.records()).length).toBe(count);
  // The existing reconciliation: exact replay, same child, claim, bind, settle.
  expect((await f.call("compute-request", computeBody)).status).toBe(200);
  expect(await f.status()).toBe("running");
  await db.prisma.computeOffer.create({ data: { id: "offer-a", environmentId: ENV, machineId: "host", instructionId: "instruction-a", state: "offered", dispatchDeadline: new Date(Date.now() + 60_000) } });
  expect((await f.call("compute-claim", { ...computeBody, offerId: "offer-a" })).status).toBe(200);
  await db.prisma.computeOffer.update({ where: { id: "offer-a" }, data: { state: "running", claimedAt: new Date() } });
  expect((await f.call("compute-bind", { offerId: "offer-a", resourceKey: KEY })).status).toBe(200);
  // A LATER boot (the crashed PID still exited) leaves the reconciled,
  // producing operation running: its unknown attempt is history, not swept again.
  expect(await db.prisma.runtimeMetadataEvent.count({ where: { key: `producer:compute-environment:${ENV}` } })).toBeGreaterThan(0);
  const reconciledHistory = await f.records();
  for (const boot of [{ instance: crypto.randomUUID(), pid: process.pid, host: SERVER_INSTANCE.host }, undefined]) {
    expect(await recoverInterruptedCallbacks({ prisma: db.prisma, ...(boot ? { current: boot } : {}) })).toEqual({ repaired: [], blocked: [] });
    expect(await f.status()).toBe("running");
    expect(await f.records()).toEqual(reconciledHistory);
  }
  const settled = await f.settle();
  expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  expect(await f.status()).toBe("completed");
  console.log(JSON.stringify({ window1: { crashed: crashed.server, child: f.child.operationId.slice(0, 8), records: (await f.records()).map(value => `${value.attemptId.slice(0, 8)}:${value.route.split("/").at(-1)}:${value.state}`) } }));
});

test("window 2 (unknown result recorded, still running): recovery only moves running -> unknown, appending nothing", async () => {
  const f = await fixture();
  await crashingServer(f.child.operationId, "compute-request", computeBody, "unknown-result");
  expect(await f.status()).toBe("running");
  const before = await f.records();
  expect(before.map(value => value.state)).toEqual(["intent", "unknown"]);
  expect((await recoverInterruptedCallbacks({ prisma: db.prisma })).repaired).toHaveLength(1);
  expect(await f.status()).toBe("unknown");
  expect(await f.records()).toEqual(before);
  expect((await f.call("compute-request", computeBody)).status).toBe(200);
  expect(await f.status()).toBe("running");
  // Later boot: the reconciled unknown result is never swept again.
  const history = await f.records();
  expect(await recoverInterruptedCallbacks({ prisma: db.prisma })).toEqual({ repaired: [], blocked: [] });
  expect(await f.status()).toBe("running");
  expect(await f.records()).toEqual(history);
});

test("a reconciliation record that does not validate is never credited: the running operation stays blocked and untouched", async () => {
  const f = await fixture();
  const crashed = await crashingServer(f.child.operationId, "compute-request", computeBody, "unknown-result");
  // ADVERSARIAL seeded record, used only to prove refusal: it names an
  // acknowledgment that does not exist.
  const [intent] = await f.records();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key: `outcome:${f.child.operationId}`,
    value: JSON.stringify({ version: 1, operationId: f.child.operationId, role: "outcome", state: "reconciled", attemptId: intent.attemptId, acknowledgedAttemptId: crypto.randomUUID(),
      route: intent.route, inputDigest: intent.inputDigest, requestKey: intent.requestKey }) } });
  const history = await f.records();
  const report = await recoverInterruptedCallbacks({ prisma: db.prisma });
  expect(report.repaired).toEqual([]);
  expect(report.blocked).toEqual([{ operationId: f.child.operationId, reason: `attempt ${intent.attemptId} has a reconciliation record that does not validate` }]);
  expect(await f.status()).toBe("running");
  expect(await f.records()).toEqual(history);
  expect(crashed.server.pid).not.toBe(process.pid);
});

test("a live crashed-server PID, this instance's own attempts, uncertain or other-host stamps, unstamped, malformed or overflowing history stay blocked", async () => {
  const f = await fixture();
  // Live: the other server process has not exited yet.
  const live = await crashingServer(f.child.operationId, "compute-request", computeBody, "intent", false);
  const blocked = await recoverInterruptedCallbacks({ prisma: db.prisma });
  expect(blocked.repaired).toEqual([]);
  expect(blocked.blocked).toEqual([{ operationId: f.child.operationId, reason: expect.stringContaining(`server PID ${live.server.pid} is alive`) }]);
  expect(await f.status()).toBe("running");
  live.child.kill("SIGKILL"); await live.child.exited;
  expect((await recoverInterruptedCallbacks({ prisma: db.prisma })).repaired).toHaveLength(1);

  // This process's own in-flight attempt is never swept.
  const own = (await f.post("/api/sessions/primary/tooling-operations", { requestKey: "own", inputDigest: canonicalDigest({ command: "own" }), kind: "adapter-command" })).body.binding;
  const ownChild = (await f.post("/api/sessions/primary/tooling-operations", { requestKey: "own/compute-admission", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: own.operationId })).body.binding;
  const seed = async (operationId: string, value: unknown) => db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association",
    key: `outcome:${operationId}`, value: typeof value === "string" ? value : JSON.stringify(value) } });
  const running = async (requestKey: string) => {
    const op = (await f.post("/api/sessions/primary/tooling-operations", { requestKey, inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: own.operationId })).body.binding;
    await db.prisma.toolingOperation.update({ where: { id: op.operationId }, data: { status: "running" } });
    return op.operationId as string;
  };
  const intent = (operationId: string, server?: unknown) => ({ version: 1, operationId, role: "outcome", state: "intent", attemptId: crypto.randomUUID(), route: "POST /api/tasks/:taskId/compute-request",
    inputDigest: canonicalDigest(computeBody), requestKey: "seeded", status: null, ...(server ? { server } : {}) });
  // ADVERSARIAL seeded evidence below, used only to prove refusal.
  await db.prisma.toolingOperation.update({ where: { id: ownChild.operationId }, data: { status: "running" } });
  await seed(ownChild.operationId, intent(ownChild.operationId, SERVER_INSTANCE));
  const unstamped = await running("unstamped"); await seed(unstamped, intent(unstamped));
  const uncertain = await running("uncertain"); await seed(uncertain, intent(uncertain, { instance: crypto.randomUUID(), pid: 1, host: SERVER_INSTANCE.host }));
  const otherHost = await running("other-host"); await seed(otherHost, intent(otherHost, { instance: crypto.randomUUID(), pid: 999_999, host: "elsewhere.invalid" }));
  const malformed = await running("malformed"); await seed(malformed, "{not json");
  const overflow = await running("overflow");
  await db.prisma.runtimeMetadataEvent.createMany({ data: Array.from({ length: 1001 }, () => ({ runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association",
    key: `outcome:${overflow}`, value: JSON.stringify(intent(overflow, { instance: crypto.randomUUID(), pid: 999_999, host: SERVER_INSTANCE.host })) })) });
  const report = await recoverInterruptedCallbacks({ prisma: db.prisma });
  const reason = (operationId: string) => report.blocked.find(entry => entry.operationId === operationId)?.reason ?? "";
  expect(report.repaired).toEqual([]);
  expect(reason(ownChild.operationId)).toContain("belongs to this running server instance");
  expect(reason(unstamped)).toContain("no server instance stamp");
  expect(reason(uncertain)).toContain("server PID 1 is uncertain");
  expect(reason(otherHost)).toContain("ran on another host");
  expect(reason(malformed)).toContain("malformed attempt record");
  expect(reason(overflow)).toContain("exceeds its bound");
  for (const id of [ownChild.operationId, unstamped, uncertain, otherHost, malformed, overflow]) expect((await db.prisma.toolingOperation.findUniqueOrThrow({ where: { id } })).status).toBe("running");
  console.log(JSON.stringify({ blocked: report.blocked.map(entry => ({ ...entry, operationId: entry.operationId.slice(0, 8), reason: entry.reason.slice(0, 120) })) }));
});

test("an interrupted claim (another route) becomes unknown at boot but is NOT recovered: a request replay cannot reconcile it and settlement stays refused", async () => {
  const f = await fixture();
  expect((await f.call("compute-request", computeBody)).status).toBe(200);
  await db.prisma.computeOffer.create({ data: { id: "offer-a", environmentId: ENV, machineId: "host", instructionId: "instruction-a", state: "offered", dispatchDeadline: new Date(Date.now() + 60_000) } });
  await crashingServer(f.child.operationId, "compute-claim", { ...computeBody, offerId: "offer-a" }, "intent");
  expect((await recoverInterruptedCallbacks({ prisma: db.prisma })).repaired).toHaveLength(1);
  expect(await f.status()).toBe("unknown");
  expect((await f.call("compute-request", computeBody)).status).toBe(200);
  expect(await f.status()).toBe("unknown");
  expect((await f.records()).some(value => value.state === "reconciled")).toBe(false);
  expect((await f.settle()).status).toBe(409);
  // Offers, admissions and readers are untouched by recovery.
  expect((await db.prisma.computeOffer.findUniqueOrThrow({ where: { id: "offer-a" } })).state).toBe("offered");
});
