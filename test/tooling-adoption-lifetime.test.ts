/**
 * Release adoption across one task's compute lifetime (DRA-37 physical plan).
 *
 * Isolated migrated SQLite. Real: the activation service (only
 * prepareToolingRelease, the git/frozen-install boundary, is injected) with the
 * real legacy inventory; the begin and settlement routes; the tooling-operation
 * guard and its before/after callback hooks. SYNTHETIC: the compute domain.
 * Handlers behind the guard are stand-ins that only acknowledge (or refuse);
 * environment/offer rows and offer state changes are written by the test as
 * the domain would; "stopped" is a stand-in for the domain's verified stop
 * (resolveEnvironmentConsumers, as release/reclamation call it). No Docker,
 * provider or live configuration.
 *
 * The command client mirrors Drafted 66a14f4 ToolingOperationSession
 * .callbackHeaders: one child per (kind, projection digest), reused within the
 * command; request key `${command}/${kind}/${digest({existing, digest})[0..24]}`;
 * claim/bind carry existingOperationId = offerId.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "../test-support/db.ts";
import { testConfig } from "../test-support/config.ts";
import type { AppEnv } from "../apps/server/middleware/context.ts";
import { toolingOperationGuard, toolingOperationRoutes } from "../apps/server/routes/tasks/tooling-operations.ts";
import { TOOLING_OPERATION_HEADER, bindServerContinuation, inventoryLegacyToolingConsumers, producerOperationId, resolveEnvironmentConsumers, resourceGroupCode } from "../apps/server/services/tasks/tooling-operations.ts";
import { activateToolingRelease, canonicalDigest } from "../apps/server/services/tasks/tooling-releases.ts";
import { computeTaskIdentity } from "../apps/server/services/tasks/compute-admission.ts";
import type { PreparedToolingRelease } from "../apps/server/services/tasks/tooling.ts";

for (const name of Object.keys(process.env)) if (name.startsWith("REMOTE_AGENT_")) delete process.env[name];

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

const LEGACY = "1".repeat(40), A = "a".repeat(40), B = "b".repeat(40), POLICY = "f".repeat(40);
const KEY = "runtime-development", ENV = "22222222-2222-4222-8222-222222222222";
const computeBody = { key: KEY, purpose: "development", revision: "c".repeat(40), recipeDigest: "d".repeat(64) };
const manifest = { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 1, max: 1 }, stateFormats: { "drafted.runtime": { read: [1, 2], write: 1, preservesUnknown: true } } };
type Binding = { operationId: string; requestKey: string; inputDigest: string; kind: string; status: string; existingOperationId: string | null; parentOperationId: string | null; release: { id: string; revision: string } };
type Reply = { status: number; body: Record<string, any> };

async function fixture() {
  const base = testConfig({ machine: "host" });
  const repository = { ...base.repository, id: "repo", tooling: { root: "/fixture/tooling-source", revision: LEGACY, policyBlob: POLICY } };
  const config = { ...base, repository, repositories: { repo: repository } } as typeof base;
  // Identity only: the task and its original primary.
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/task", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: "/fixture/task",
    toolingRoot: "/fixture/tooling-source", toolingRevision: LEGACY, primarySessionId: "primary", phase: "working" } });
  const prepare = async (input: { repositoryId: string; revision: string }): Promise<PreparedToolingRelease> => ({ repositoryId: input.repositoryId, revision: input.revision,
    tree: input.revision.replace(/./g, "e"), policyBlob: POLICY, checkout: `/install/tooling/repo/${input.revision}`, manifest: manifest as PreparedToolingRelease["manifest"],
    lockfileDigest: "0".repeat(64), bunVersion: "1.3.14" });
  const activate = async (revision: string, expectedGeneration: number) => (await activateToolingRelease({ prisma: db.prisma, config, repositoryId: "repo",
    requestKey: `activate-${revision.slice(0, 1)}`, revision, expectedGeneration }, { prepare, inventoryLegacyConsumers: inventoryLegacyToolingConsumers })).generation;

  const handled: string[] = [];
  let domain: (route: string) => number | Promise<number> = () => 200;
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  server.use("/api/*", toolingOperationGuard());
  server.route("/api/sessions", toolingOperationRoutes);
  server.all("/api/*", async c => {
    await c.req.json().catch(() => undefined);
    const route = c.req.path.split("/").at(-1)!, status = await domain(route);
    handled.push(`${c.req.header(TOOLING_OPERATION_HEADER)?.slice(0, 8)}:${route}:${status}`);
    return c.json(status === 200 ? {} : { error: "synthetic domain refusal", code: "domain" }, status as 200);
  });
  const post = async (route: string, body: unknown, operationId?: string): Promise<Reply> => {
    const response = await server.request(route, { method: "POST", headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: JSON.stringify(body) });
    // A handler exception (lost response) is an unstructured 500 body.
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const begin = (request: Record<string, unknown>) => post("/api/sessions/primary/tooling-operations", request);

  /** One adapter command (fence) and its Drafted-style callback client. */
  const command = async (requestKey: string) => {
    const fenced = await begin({ requestKey, inputDigest: canonicalDigest({ command: requestKey }), kind: "adapter-command", resourceKey: KEY });
    expect(fenced.status, JSON.stringify(fenced.body)).toBe(200);
    const fence = fenced.body.binding as Binding, bindings: Binding[] = [];
    const callback = async (route: string, body: Record<string, unknown>, rule: { kind: string; input: Record<string, unknown> | undefined; existing?: string; reference: "none" | "admission" | "existing" }) => {
      const inputDigest = rule.input === undefined ? null : canonicalDigest(rule.input), existing = rule.existing ?? null;
      let child = [...bindings].reverse().find(value => value.kind === rule.kind && (inputDigest === null || value.inputDigest === inputDigest) && (rule.reference !== "existing" || value.existingOperationId === existing));
      let begun: Reply | undefined;
      if (!child) {
        const digest = inputDigest ?? canonicalDigest({ existingOperationId: existing });
        begun = await begin({ requestKey: `${requestKey}/${rule.kind}/${canonicalDigest({ existing, digest }).slice(0, 24)}`, inputDigest: digest, kind: rule.kind,
          ...(rule.reference !== "none" && existing ? { existingOperationId: existing } : {}), parentOperationId: fence.operationId });
        if (begun.status !== 200) return { begun, called: null as Reply | null };
        child = begun.body.binding as Binding; bindings.push(child);
      }
      return { begun, child, called: await post(`/api/tasks/task/${route}`, body, child.operationId) as Reply | null };
    };
    return {
      fence, bindings,
      /** Begin a claim child exactly as Drafted would, without calling it yet. */
      beginChild: (offerId: string, body: Record<string, unknown> = computeBody) => { const digest = canonicalDigest(body);
        return begin({ requestKey: `${requestKey}/compute-admission/${canonicalDigest({ existing: offerId, digest }).slice(0, 24)}`, inputDigest: digest, kind: "compute-admission", existingOperationId: offerId, parentOperationId: fence.operationId }); },
      call: (route: string, body: Record<string, unknown>, operationId: string) => post(`/api/tasks/task/${route}`, body, operationId),
      request: () => callback("compute-request", computeBody, { kind: "compute-admission", input: computeBody, reference: "none" }),
      claim: (offerId: string) => callback("compute-claim", { ...computeBody, offerId }, { kind: "compute-admission", input: computeBody, existing: offerId, reference: "admission" }),
      bind: (offerId: string) => callback("compute-bind", { offerId, resourceKey: KEY }, { kind: "compute-admission", input: undefined, existing: offerId, reference: "admission" }),
      settle: () => post(`/api/sessions/primary/tooling-operations/${fence.operationId}/settlement`, { requestKey: fence.requestKey, inputDigest: fence.inputDigest, outcome: "completed" }, fence.operationId),
    };
  };
  // Synthetic domain row carrying the task's real compute-owner identity.
  const environment = async () => db.prisma.computeEnvironment.create({ data: { id: ENV, taskId: "task", primarySessionId: "primary", machineId: "host", key: KEY,
    purpose: "development", revision: computeBody.revision, recipeDigest: computeBody.recipeDigest, state: "waiting",
    taskIdentity: computeTaskIdentity(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } }), "primary", "host", null) } });
  const offer = (id: string, state = "offered") => db.prisma.computeOffer.create({ data: { id, environmentId: ENV, machineId: "host", instructionId: `instruction-${id}`, state, dispatchDeadline: new Date(Date.now() + 60_000) } });
  const claimed = (id: string) => db.prisma.computeOffer.update({ where: { id }, data: { state: "running", claimedAt: new Date() } });
  /** Admission receipts for the key: [operation prefix, state] in record order. */
  const admissions = async () => (await db.prisma.runtimeMetadataEvent.findMany({ where: { source: "tooling-operation:task", key: `admission:environment-key:${KEY}` }, orderBy: { sequence: "asc" } }))
    .map(event => { const value = JSON.parse(event.value!); return `${value.operationId.slice(0, 8)}:${value.state}`; });
  const task = () => db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "task" } });
  const operation = (id: string) => db.prisma.toolingOperation.findUniqueOrThrow({ where: { id } });
  const settleOperation = (binding: { operationId: string; requestKey: string; inputDigest: string }) => post(`/api/sessions/primary/tooling-operations/${binding.operationId}/settlement`,
    { requestKey: binding.requestKey, inputDigest: binding.inputDigest, outcome: "completed" }, binding.operationId);
  return { config, activate, begin, command, settleOperation, environment, offer, claimed, admissions, task, operation, handled, setDomain: (next: typeof domain) => { domain = next; } };
}
const short = (binding: { operationId: string }) => binding.operationId.slice(0, 8);

test("H1: a cross-release request is refused before any effect while A's command is in flight, and A's exact claim/bind retry continue A", async () => {
  const f = await fixture();
  expect(await f.activate(A, 0)).toBe(1);
  const a = await f.command("a-runtime-up");
  expect((await a.request()).called?.status).toBe(200);
  await f.environment(); await f.offer("offer-a");
  expect((await a.claim("offer-a")).called?.status).toBe(200);
  expect(await f.activate(B, 1)).toBe(2);
  const history = await f.admissions(), handled = f.handled.length;

  const b = await f.command("b-runtime-configure");
  expect(b.fence.release.revision).toBe(B);
  const refused = await b.request();
  expect(refused.called?.status).toBe(409);
  expect(refused.called?.body).toMatchObject({ code: "retained-release-required" });
  expect(refused.called?.body.error).toContain(`held by operation ${short(a.bindings[0]!)}`);
  // Refused before effects: no handler call, no admission receipt, child never ran.
  expect(f.handled.length).toBe(handled);
  expect(await f.admissions()).toEqual(history);
  expect((await f.operation(refused.child!.operationId)).status).toBe("bound");

  // A's process restarts and retries with its derived keys: same A binding, then bind and settle.
  const restarted = await f.command("a-runtime-up");
  expect(restarted.fence.operationId).toBe(a.fence.operationId);
  const retry = await restarted.claim("offer-a");
  expect(retry.begun?.status, JSON.stringify(retry.begun?.body)).toBe(200);
  expect(retry.child!.operationId).toBe(a.bindings[0]!.operationId);
  expect(retry.child!.release.revision).toBe(A);
  expect(retry.called?.status).toBe(200);
  expect((await restarted.bind("offer-a")).called?.status).toBe(200);
  expect(await producerOperationId(db.prisma, await f.task(), ENV)).toBe(a.bindings[0]!.operationId);
  expect((await restarted.settle()).status).toBe(200);
  console.log(JSON.stringify({ H1: { a: short(a.fence), aChild: short(a.bindings[0]!), b: short(b.fence), bChild: short(refused.child!), refusal: refused.called?.body, admissions: await f.admissions(), handled: f.handled } }));
});

test("H2: never-produced waiting work admitted by settled A is adopted by the next B command's claim; replays are not rebound", async () => {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  expect((await a.request()).called?.status).toBe(200);
  await f.environment();
  expect((await a.settle()).status).toBe(200); // A's command ends waiting.
  await f.activate(B, 1);

  // offerNextCompute delivers an offer; the instructed active (B) adapter claims it directly.
  await f.offer("offer-delivered");
  const b = await f.command("b-runtime-up-offer");
  const claim = await b.claim("offer-delivered");
  expect(claim.begun?.status, JSON.stringify(claim.begun?.body)).toBe(200);
  expect(claim.child).toMatchObject({ release: { revision: B }, existingOperationId: "offer-delivered", parentOperationId: b.fence.operationId });
  expect(claim.called?.status, JSON.stringify(claim.called?.body)).toBe(200);
  await f.claimed("offer-delivered");
  expect((await b.bind("offer-delivered")).called?.status).toBe(200); // reuses the claim child, as Drafted does
  expect(await producerOperationId(db.prisma, await f.task(), ENV)).toBe(claim.child!.operationId);
  expect((await resourceGroupCode({ prisma: db.prisma, task: await f.task(), reference: { type: "compute-environment", id: ENV } })).code!.revision).toBe(B);
  expect((await b.settle()).status).toBe(200);
  expect(await db.prisma.computeEnvironment.count()).toBe(1);

  // Exact replays keep their original bindings: B's claim, and A's own request child.
  const replayB = await f.begin({ requestKey: claim.child!.requestKey, inputDigest: claim.child!.inputDigest, kind: "compute-admission", existingOperationId: "offer-delivered", parentOperationId: b.fence.operationId });
  expect(replayB.body.binding?.operationId).toBe(claim.child!.operationId);
  const original = a.bindings[0]!;
  const replayA = await f.begin({ requestKey: original.requestKey, inputDigest: original.inputDigest, kind: "compute-admission", parentOperationId: a.fence.operationId });
  expect(replayA.body.binding).toMatchObject({ operationId: original.operationId, release: { revision: A } });
  console.log(JSON.stringify({ H2: { a: short(a.fence), aChild: short(original), b: short(b.fence), bClaim: short(claim.child!), admissions: await f.admissions(), handled: f.handled } }));
});

/** Settled A admitted a waiting environment, B is active and an offer was delivered. */
async function waiting() {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  expect((await a.request()).called?.status).toBe(200);
  await f.environment();
  expect((await a.settle()).status).toBe(200);
  await f.activate(B, 1);
  await f.offer("offer-delivered");
  return f;
}

test("H2: of two competing adoptions exactly one lineage wins atomically, and the loser cannot be handed a second authority", async () => {
  const f = await waiting();
  const x = await f.command("b-one"), y = await f.command("b-two");
  // Both children are begun while settled A is still the newest admission.
  const [bx, by] = [await x.beginChild("offer-delivered"), await y.beginChild("offer-delivered")];
  expect([bx.status, by.status]).toEqual([200, 200]);
  expect(bx.body.binding.operationId).not.toBe(by.body.binding.operationId);
  const results = await Promise.all([x.call("compute-claim", { ...computeBody, offerId: "offer-delivered" }, bx.body.binding.operationId),
    y.call("compute-claim", { ...computeBody, offerId: "offer-delivered" }, by.body.binding.operationId)]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const loser = results.find(result => result.status === 409)!;
  expect(loser.body.code).toBe("retained-release-required");
  expect(f.handled.filter(entry => entry.endsWith("compute-claim:200"))).toHaveLength(1);
  // Exactly one adoption receipt survived; the loser's rolled back with it.
  const winner = results[0]!.status === 200 ? bx.body.binding : by.body.binding;
  expect((await f.admissions()).filter(entry => !entry.startsWith(winner.operationId.slice(0, 8)))).toHaveLength(2); // A's intent + confirmed
  console.log(JSON.stringify({ race: { winner: winner.operationId.slice(0, 8), admissions: await f.admissions(), handled: f.handled, refusal: loser.body } }));
});

test("H2: waiting work with a claimed effect, a paused task or another recipe is never adopted", async () => {
  const claimedEffect = await waiting();
  await claimedEffect.claimed("offer-delivered");
  const late = await claimedEffect.command("b-late");
  expect((await late.beginChild("offer-delivered")).body).toMatchObject({ code: "retained-release-required" });

  await db.cleanup(); db = await createTestDatabase();
  const mismatch = await waiting();
  const other = await mismatch.command("b-other-recipe");
  const otherBody = { ...computeBody, revision: "e".repeat(40) };
  expect((await other.beginChild("offer-delivered", otherBody)).body).toMatchObject({ code: "retained-release-required" });

  await db.cleanup(); db = await createTestDatabase();
  const paused = await waiting();
  // Pause blocks the claim itself (compute-admission is pause-blocked), so the command begins first.
  const pausedCommand = await paused.command("b-paused");
  await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
  expect((await pausedCommand.beginChild("offer-delivered")).body.error).toMatch(/paused/);
  expect(await paused.admissions()).toHaveLength(2); // settled A's intent + confirmed only
});

test("review 1: a request that commits then answers 409, or loses its response, keeps its admission intent; only the same operation recovers it", async () => {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  // The domain commits (creates the environment), then a later step fails as 409.
  f.setDomain(async route => { if (route === "compute-request") { await f.environment(); return 409; } return 200; });
  expect((await a.request()).called?.status).toBe(409);
  const child = a.bindings[0]!;
  expect(await f.admissions()).toEqual([`${short(child)}:intent`]);
  // B activates; an independent B request cannot take the key behind the unknown intent.
  await f.activate(B, 1);
  const b = await f.command("b-runtime-up");
  const blocked = await b.request();
  expect(blocked.called?.body).toMatchObject({ code: "retained-release-required" });
  expect(blocked.called?.body.error).toContain(`held by operation ${short(child)}`);
  // Lost response (handler exception) on the same operation: still an intent.
  f.setDomain(route => { if (route === "compute-request") throw new Error("lost response"); return 200; });
  expect((await a.request()).called?.status).toBe(500);
  expect(await f.admissions()).toEqual([`${short(child)}:intent`]);
  // The same operation's successful retry confirms its ORIGINAL intent (no
  // second intent). (The child itself stays `unknown` after the lost response:
  // existing reconciliation rules, unchanged here, govern its later effects.)
  f.setDomain(() => 200);
  expect((await a.request()).called?.status).toBe(200);
  expect(await f.admissions()).toEqual([`${short(child)}:intent`, `${short(child)}:confirmed`]);
  // B remains refused: A's command is still open.
  expect((await b.request()).called?.body).toMatchObject({ code: "retained-release-required" });
  console.log(JSON.stringify({ review1: { a: short(a.fence), child: short(child), blocked: blocked.called?.body.error.split(". Begin")[0], admissions: await f.admissions(), handled: f.handled } }));
});

test("review 2: before any environment exists, a gated first A request holds the key; a competing B request is refused, and concurrent first requests serialize", async () => {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  await f.activate(B, 1);
  const b = await f.command("b-runtime-up");
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  f.setDomain(async route => { if (route === "compute-request") await gate; return 200; });
  const pending = a.request();
  const deadline = Date.now() + 5_000;
  while (!(await f.admissions()).length && Date.now() < deadline) await Bun.sleep(10);
  expect(await f.admissions()).toEqual([`${short(a.bindings[0]!)}:intent`]);
  expect(await db.prisma.computeEnvironment.count()).toBe(0); // A's domain create has not happened yet
  f.setDomain(() => 200); // B would not be gated
  const competing = await b.request();
  expect(competing.called?.status).toBe(409);
  expect(competing.called?.body.error).toContain(`held by operation ${short(a.bindings[0]!)}`);
  expect(f.handled.some(entry => entry.startsWith(short(b.bindings[0]!)))).toBe(false);
  open();
  expect((await pending).called?.status).toBe(200);
  expect(await f.admissions()).toEqual([`${short(a.bindings[0]!)}:intent`, `${short(a.bindings[0]!)}:confirmed`]);

  // Truly concurrent first requests from two releases on a fresh key: exactly one wins.
  await db.cleanup(); db = await createTestDatabase();
  const g = await fixture();
  await g.activate(A, 0);
  const ga = await g.command("a-first");
  const aChild = await g.begin({ requestKey: "a-first/request", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: ga.fence.operationId });
  await g.activate(B, 1);
  const gb = await g.command("b-first");
  const bChild = await g.begin({ requestKey: "b-first/request", inputDigest: canonicalDigest(computeBody), kind: "compute-admission", parentOperationId: gb.fence.operationId });
  const results = await Promise.all([ga.call("compute-request", computeBody, aChild.body.binding.operationId), gb.call("compute-request", computeBody, bChild.body.binding.operationId)]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect(g.handled.filter(entry => entry.endsWith("compute-request:200"))).toHaveLength(1);
  expect((await g.admissions()).filter(entry => entry.endsWith(":intent"))).toHaveLength(1);
  console.log(JSON.stringify({ review2: { competing: competing.called?.body.error.split(". Begin")[0], race: { statuses: results.map(result => result.status), admissions: await g.admissions(), handled: g.handled } } }));
});

test("H3: after A's group stops and its continuation settles, an independent B command adopts the SAME environment (stand-in stop, synthetic rows)", async () => {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  expect((await a.request()).called?.status).toBe(200);
  await f.environment(); await f.offer("offer-a");
  expect((await a.claim("offer-a")).called?.status).toBe(200);
  await f.claimed("offer-a");
  expect((await a.bind("offer-a")).called?.status).toBe(200);
  expect((await a.settle()).status).toBe(200);
  expect(await db.prisma.toolingRetainedConsumer.count({ where: { consumerId: ENV, status: "confirmed" } })).toBe(1);
  await f.activate(B, 1);

  // While A's group is live (running offer, confirmed reader), B's request is refused.
  const early = await f.command("b-runtime-up-early");
  expect((await early.request()).called?.body.code).toBe("retained-release-required");

  // A's server continuation (idle suspension) keeps A and settles.
  const continuation = (await bindServerContinuation({ prisma: db.prisma, config: f.config, task: await f.task(), environmentId: ENV,
    request: { requestKey: `compute-continue:${ENV}:1`, inputDigest: canonicalDigest({ continue: 1 }) } })).binding!;
  expect(continuation.release.revision).toBe(A);
  const continued = await f.settleOperation(continuation);
  expect(continued.status, JSON.stringify(continued.body)).toBe(200);
  // STAND-IN for the domain's verified stop: offer stopped, readers resolved.
  await db.prisma.computeOffer.update({ where: { id: "offer-a" }, data: { state: "stopped" } });
  expect(await resolveEnvironmentConsumers(db.prisma, ENV, { kind: "stopped", reference: "stand-in-stop" })).toBe(1);

  const b = await f.command("b-runtime-up");
  expect((await b.request()).called?.status).toBe(200);
  await f.offer("offer-b");
  expect((await b.claim("offer-b")).called?.status).toBe(200);
  await f.claimed("offer-b");
  expect((await b.bind("offer-b")).called?.status).toBe(200);
  // Review of 3df63a0: B is now producer with a live offer. B's SAME operation
  // retrying its request is the current holder's own retry, not a conflict
  // with historical A (no second admission is written).
  const before = await f.admissions();
  const ownRetry = await b.request();
  expect(ownRetry.child!.operationId).toBe(b.bindings[0]!.operationId);
  expect(ownRetry.called?.status, JSON.stringify(ownRetry.called?.body)).toBe(200);
  expect(await f.admissions()).toEqual(before);
  expect((await b.settle()).status).toBe(200);
  expect((await resourceGroupCode({ prisma: db.prisma, task: await f.task(), reference: { type: "compute-environment", id: ENV } })).code!.revision).toBe(B);
  expect(await db.prisma.computeEnvironment.count()).toBe(1);
  // A later independent B command (same release) still re-admits as before.
  const later = await f.command("b-runtime-configure");
  expect((await later.request()).called?.status).toBe(200);
  // Exclusion is not weakened: a third release C cannot take the key B holds.
  expect(await f.activate("c".repeat(40), 2)).toBe(3);
  const c = await f.command("c-runtime-up");
  const refusedC = await c.request();
  expect(refusedC.called?.body).toMatchObject({ code: "retained-release-required" });
  expect(refusedC.called?.body.error).toContain(`held by operation ${short(later.bindings[0]!)}`);
  console.log(JSON.stringify({ H3: { a: short(a.fence), continuation: short(continuation), b: short(b.fence), later: short(later.fence), c: short(c.fence), refusedC: refusedC.called?.body.error.split(". Begin")[0], admissions: await f.admissions() } }));
});

// ---------------------------------------------------------------------------
// Unknown request reconciliation (promoted from /private/tmp/dra27-unknown-child probe).
/** Callback attempt records of one operation, in record order. */
const attempts = async (operationId: string) => (await db.prisma.runtimeMetadataEvent.findMany({ where: { source: "tooling-operation:task", key: `outcome:${operationId}` }, orderBy: { sequence: "asc" } }))
  .map(event => JSON.parse(event.value!) as { attemptId: string; state: string; route: string; status: number | null; acknowledgedAttemptId?: string });
const lose = (f: Awaited<ReturnType<typeof fixture>>, route = "compute-request") => f.setDomain(async name => {
  if (name === "compute-request" && !await db.prisma.computeEnvironment.count()) await f.environment(); // the domain commits...
  if (name === route) throw new Error("lost response"); // ...and the response is lost
  return 200;
});
async function lostRequest() {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  lose(f);
  expect((await a.request()).called?.status).toBe(500);
  f.setDomain(() => 200);
  const child = a.bindings[0]!;
  expect((await f.operation(child.operationId)).status).toBe("unknown");
  return { f, a, child };
}

test("reconcile: request commits, response lost; the restarted command's exact replay reconciles the same child, then claim/bind and settlement finish with original IDs", async () => {
  const { f, a, child } = await lostRequest();
  const restarted = await f.command("a-runtime-up");
  expect(restarted.fence.operationId).toBe(a.fence.operationId);
  const replay = await restarted.request();
  expect(replay.child!.operationId).toBe(child.operationId);
  expect(replay.called?.status).toBe(200);
  expect((await f.operation(child.operationId)).status).toBe("running");
  const records = await attempts(child.operationId);
  const original = records.find(record => record.state === "unknown")!, acknowledged = records.find(record => record.state === "acknowledged")!;
  // Every original attempt is kept; the reconciliation links original -> later replay.
  expect(records.map(record => `${record.route.split("/").at(-1)}:${record.state}`)).toEqual(["compute-request:intent", "compute-request:unknown", "compute-request:intent", "compute-request:acknowledged", "compute-request:reconciled"]);
  expect(records.at(-1)).toMatchObject({ attemptId: original.attemptId, acknowledgedAttemptId: acknowledged.attemptId });
  await f.offer("offer-a");
  const claim = await restarted.claim("offer-a");
  expect(claim.child!.operationId).toBe(child.operationId);
  expect(claim.called?.status, JSON.stringify(claim.called?.body)).toBe(200);
  await f.claimed("offer-a");
  expect((await restarted.bind("offer-a")).called?.status).toBe(200);
  const settled = await restarted.settle();
  expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  expect((await f.operation(child.operationId)).status).toBe("completed");
  expect(await producerOperationId(db.prisma, await f.task(), ENV)).toBe(child.operationId);
  console.log(JSON.stringify({ reconcile: { fence: short(a.fence), child: short(child), records: (await attempts(child.operationId)).map(record => `${record.attemptId.slice(0, 8)}:${record.route.split("/").at(-1)}:${record.state}${record.acknowledgedAttemptId ? `->${record.acknowledgedAttemptId.slice(0, 8)}` : ""}`) } }));
});

test("reconcile: another route's unknown, a changed environment or a pause between replay and proof keep the child unknown and settlement refused", async () => {
  // A claim (not a request) whose response was lost is never reconciled by a request replay.
  {
    const f = await fixture();
    await f.activate(A, 0);
    const a = await f.command("a-runtime-up");
    expect((await a.request()).called?.status).toBe(200);
    await f.environment(); await f.offer("offer-a");
    lose(f, "compute-claim");
    expect((await a.claim("offer-a")).called?.status).toBe(500);
    f.setDomain(() => 200);
    expect((await a.request()).called?.status).toBe(200);
    expect((await f.operation(a.bindings[0]!.operationId)).status).toBe("unknown");
    expect((await attempts(a.bindings[0]!.operationId)).some(record => record.state === "reconciled")).toBe(false);
    expect((await a.settle()).body.code).toBe("operation-closed");
  }
  // Exact readback: the environment no longer matches the request.
  {
    await db.cleanup(); db = await createTestDatabase();
    const { f, a, child } = await lostRequest();
    await db.prisma.computeEnvironment.update({ where: { id: ENV }, data: { recipeDigest: "e".repeat(64) } });
    expect((await a.request()).called?.status).toBe(200);
    expect((await f.operation(child.operationId)).status).toBe("unknown");
    // A different request under the same child never reaches an attempt.
    expect((await a.call("compute-request", { ...computeBody, revision: "e".repeat(40) }, child.operationId)).status).toBe(400);
    expect((await attempts(child.operationId)).filter(record => record.state === "intent")).toHaveLength(2);
  }
  // The primary's authority is revoked while the replay runs (its session
  // closes): the proof transaction rechecks full authority and rolls back.
  {
    await db.cleanup(); db = await createTestDatabase();
    const { f, a, child } = await lostRequest();
    f.setDomain(async () => { await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "closed" } }); return 200; });
    expect((await a.request()).called?.status).toBe(200);
    expect((await f.operation(child.operationId)).status).toBe("unknown");
    expect((await attempts(child.operationId)).some(record => record.state === "reconciled")).toBe(false);
  }
  // The environment's owner identity no longer matches the task.
  {
    await db.cleanup(); db = await createTestDatabase();
    const { f, a, child } = await lostRequest();
    await db.prisma.computeEnvironment.update({ where: { id: ENV }, data: { taskIdentity: "9".repeat(64) } });
    expect((await a.request()).called?.status).toBe(200);
    expect((await f.operation(child.operationId)).status).toBe("unknown");
  }
  // Producer evidence that is truncated (over its bound) or unreadable is never
  // read as "no producer". ADVERSARIAL seeded rows, used only to prove refusal.
  for (const seed of ["overflow", "unreadable"] as const) {
    await db.cleanup(); db = await createTestDatabase();
    const { f, a, child } = await lostRequest();
    const row = (index: number, value: string) => ({ runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key: `producer:compute-environment:other-${index}`, value });
    if (seed === "overflow") await db.prisma.runtimeMetadataEvent.createMany({ data: Array.from({ length: 1001 }, (_, index) => row(index, JSON.stringify({ version: 1, operationId: "other", role: "producer", state: "confirmed" }))) });
    else await db.prisma.runtimeMetadataEvent.create({ data: row(0, "{not json") });
    expect((await a.request()).called?.status).toBe(200);
    expect((await f.operation(child.operationId)).status).toBe("unknown");
    expect((await attempts(child.operationId)).some(record => record.state === "reconciled")).toBe(false);
  }
  // The owner pauses while the replay runs: the proof transaction refuses atomically.
  {
    await db.cleanup(); db = await createTestDatabase();
    const { f, a, child } = await lostRequest();
    f.setDomain(async () => { await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } }); return 200; });
    expect((await a.request()).called?.status).toBe(200);
    expect((await f.operation(child.operationId)).status).toBe("unknown");
    expect((await attempts(child.operationId)).some(record => record.state === "reconciled")).toBe(false);
  }
});

test("reconcile: an earlier attempt still in flight blocks reconciliation until a later exact replay; concurrent replays reconcile once", async () => {
  const { f, a, child } = await lostRequest();
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  f.setDomain(async () => { await gate; return 200; });
  const inFlight = a.call("compute-request", computeBody, child.operationId);
  const deadline = Date.now() + 5_000;
  while ((await attempts(child.operationId)).filter(record => record.state === "intent").length < 2 && Date.now() < deadline) await Bun.sleep(10);
  f.setDomain(() => 200);
  // Replay 3 is acknowledged, but attempt 2 has no result yet: no reconciliation.
  expect((await a.call("compute-request", computeBody, child.operationId)).status).toBe(200);
  expect((await f.operation(child.operationId)).status).toBe("unknown");
  open();
  // Attempt 2 is now acknowledged, but it is not the latest attempt.
  expect((await inFlight).status).toBe(200);
  expect((await f.operation(child.operationId)).status).toBe("unknown");
  expect((await attempts(child.operationId)).some(record => record.state === "reconciled")).toBe(false);
  // Two concurrent exact replays: both acknowledged, exactly one reconciliation.
  const both = await Promise.all([a.call("compute-request", computeBody, child.operationId), a.call("compute-request", computeBody, child.operationId)]);
  expect(both.map(result => result.status)).toEqual([200, 200]);
  // Whichever replay is latest may reconcile; at most one set of records exists.
  let reconciled = (await attempts(child.operationId)).filter(record => record.state === "reconciled");
  if (!reconciled.length) { expect((await a.call("compute-request", computeBody, child.operationId)).status).toBe(200); reconciled = (await attempts(child.operationId)).filter(record => record.state === "reconciled"); }
  expect(reconciled).toHaveLength(1);
  expect((await f.operation(child.operationId)).status).toBe("running");
  console.log(JSON.stringify({ inflight: (await attempts(child.operationId)).map(record => `${record.attemptId.slice(0, 8)}:${record.state}`) }));
});

// ---------------------------------------------------------------------------
// A child bound but never attempted (client killed between begin and callback).
/** Begin (only) the configure child Drafted would bind for an offer: kind
 * compute-configure, existing = offerId, under the command fence. */
const configureBody = (offerId: string) => ({ offerId, environmentId: ENV, resourceId: "resource", recipeHash: "d".repeat(64) });
const beginConfigure = (f: Awaited<ReturnType<typeof fixture>>, fence: { operationId: string; requestKey: string }, offerId: string) => {
  const digest = canonicalDigest(configureBody(offerId));
  return f.begin({ requestKey: `${fence.requestKey}/compute-configure/${canonicalDigest({ existing: offerId, digest }).slice(0, 24)}`, inputDigest: digest, kind: "compute-configure", existingOperationId: offerId, parentOperationId: fence.operationId });
};
/** A started command (request, claim, bind on offer-2) with an orphan configure child for expired offer-1. */
async function orphaned() {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  expect((await a.request()).called?.status).toBe(200);
  await f.environment(); await f.offer("offer-1");
  // Begin the configure child for offer-1, then the client dies before its callback.
  const orphan = await beginConfigure(f, a.fence, "offer-1");
  expect(orphan.status, JSON.stringify(orphan.body)).toBe(200);
  // offer-1 expires and is replaced; the restarted command claims and binds offer-2.
  await db.prisma.computeOffer.update({ where: { id: "offer-1" }, data: { state: "expired" } });
  await f.offer("offer-2");
  const restarted = await f.command("a-runtime-up");
  expect(restarted.fence.operationId).toBe(a.fence.operationId);
  expect((await restarted.request()).called?.status).toBe(200);
  expect((await restarted.claim("offer-2")).called?.status).toBe(200);
  await f.claimed("offer-2");
  expect((await restarted.bind("offer-2")).called?.status).toBe(200);
  return { f, a, restarted, orphanId: orphan.body.binding.operationId as string };
}

test("never-attempted: a crash between a configure child's begin and its callback, then a replacement offer, still lets the command settle", async () => {
  const { f, a, restarted, orphanId } = await orphaned();
  const before = await f.operation(orphanId);
  expect(before.status).toBe("bound");
  const settled = await restarted.settle();
  console.log(JSON.stringify({ neverAttempted: { orphan: orphanId.slice(0, 8), settle: settled.status, body: settled.body } }));
  expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  // The original row, identity and lineage are kept; only its status gains exact evidence.
  const row = await f.operation(orphanId);
  expect(row).toMatchObject({ id: before.id, requestKey: before.requestKey, inputDigest: before.inputDigest, kind: "compute-configure", existingOperationId: "offer-1",
    parentOperationId: a.fence.operationId, releaseId: before.releaseId, generation: before.generation, status: "completed", completionEvidence: { kind: "never-attempted", reference: a.fence.operationId } });
  // The completed orphan can never run its old offer.
  expect((await restarted.call("compute-configure", configureBody("offer-1"), orphanId)).status).toBe(409);
});

test("never-attempted: a bound child with any attempt or effect record, or an unknown/running child, still blocks settlement", async () => {
  // The normal path moves a child to running in the same transaction as its
  // first attempt, so a BOUND child with records is ADVERSARIALLY seeded here
  // only to prove refusal.
  for (const seed of ["attempt", "owner"] as const) {
    if (seed !== "attempt") { await db.cleanup(); db = await createTestDatabase(); }
    const { f, restarted, orphanId } = await orphaned();
    const key = seed === "attempt" ? `outcome:${orphanId}` : "owner:compute-offer:offer-1";
    const value = seed === "attempt" ? { version: 1, operationId: orphanId, role: "outcome", state: "intent", attemptId: "seeded", route: "POST /api/tasks/:taskId/compute-configure", inputDigest: "x" }
      : { version: 1, operationId: orphanId, role: "owner", state: "confirmed" };
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key, value: JSON.stringify(value) } });
    const settled = await restarted.settle();
    expect(settled.status).toBe(409);
    expect(settled.body.error).toContain(seed === "attempt" ? "bound with callback attempt history" : "bound with owner evidence");
    expect((await f.operation(orphanId)).status).toBe("bound");
    expect((await f.operation(restarted.fence.operationId)).status).not.toBe("completed"); // the parent swap rolled back
  }
  // An unknown child (lost callback response) is unchanged by this rule.
  await db.cleanup(); db = await createTestDatabase();
  const { f, restarted, orphanId } = await orphaned();
  f.setDomain(route => { if (route === "compute-configure") throw new Error("lost response"); return 200; });
  expect((await restarted.call("compute-configure", configureBody("offer-1"), orphanId)).status).toBe(500);
  expect((await f.operation(orphanId)).status).toBe("unknown");
  // Refused (its pending reader or its unknown status blocks first); the child stays unknown.
  const refusedUnknown = await restarted.settle();
  expect(refusedUnknown.status).toBe(409);
  expect(refusedUnknown.body.error).toMatch(/unconfirmed producing effect|is unknown/);
  expect((await f.operation(orphanId)).status).toBe("unknown");
});

test("never-attempted: settlement racing the orphan's callback or a new child's begin yields a refused settlement or a refused callback, never both effects", async () => {
  for (let round = 0; round < 3; round++) {
    await db.cleanup(); db = await createTestDatabase();
    const { f, restarted, orphanId } = await orphaned();
    const handledBefore = f.handled.length;
    const [settled, called] = await Promise.all([restarted.settle(), restarted.call("compute-configure", configureBody("offer-1"), orphanId)]);
    const row = await f.operation(orphanId), ran = f.handled.slice(handledBefore).some(entry => entry.startsWith(orphanId.slice(0, 8)));
    if ((row.completionEvidence as { kind?: string } | null)?.kind === "never-attempted") {
      // Settlement won: the callback was refused before any record or effect.
      expect([settled.status, called.status, ran]).toEqual([200, 409, false]);
      expect(await db.prisma.runtimeMetadataEvent.count({ where: { key: `outcome:${orphanId}` } })).toBe(0);
    } else {
      // The callback won: settlement is refused, or (callback fully acknowledged first) completes it as acknowledged.
      expect(ran).toBe(true);
      expect(settled.status === 409 || (row.completionEvidence as { kind?: string } | null)?.kind === "callback-acknowledged").toBe(true);
    }
  }
  // A new child begun concurrently with settlement: refused, or completed never-attempted and then unusable.
  await db.cleanup(); db = await createTestDatabase();
  const { f, restarted } = await orphaned();
  const [settled, begun] = await Promise.all([restarted.settle(), beginConfigure(f, restarted.fence, "offer-3")]);
  expect(settled.status).toBe(200);
  if (begun.status === 200) {
    const late = begun.body.binding.operationId as string;
    expect((await f.operation(late)).completionEvidence).toMatchObject({ kind: "never-attempted" });
    expect((await restarted.call("compute-configure", configureBody("offer-3"), late)).status).toBe(409);
  } else {
    // Begun after the parent's swap: refused, no child row.
    expect(begun.status).toBeGreaterThanOrEqual(400); expect(begun.status).toBeLessThan(500);
    expect(await db.prisma.toolingOperation.count({ where: { parentOperationId: restarted.fence.operationId, existingOperationId: "offer-3" } })).toBe(0);
  }
  console.log(JSON.stringify({ concurrentBegin: { settle: settled.status, begin: begun.status, refusal: begun.body.code ?? null } }));
});
