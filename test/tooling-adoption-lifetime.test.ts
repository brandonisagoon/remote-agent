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
  let domain: (route: string) => number = () => 200;
  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => { c.set("prisma", db.prisma); c.set("config", config); await next(); });
  server.use("/api/*", toolingOperationGuard());
  server.route("/api/sessions", toolingOperationRoutes);
  server.all("/api/*", async c => {
    await c.req.json().catch(() => undefined);
    const route = c.req.path.split("/").at(-1)!, status = domain(route);
    handled.push(`${c.req.header(TOOLING_OPERATION_HEADER)?.slice(0, 8)}:${route}:${status}`);
    return c.json(status === 200 ? {} : { error: "synthetic domain refusal", code: "domain" }, status as 200);
  });
  const post = async (route: string, body: unknown, operationId?: string): Promise<Reply> => {
    const response = await server.request(route, { method: "POST", headers: { "content-type": "application/json", ...(operationId ? { [TOOLING_OPERATION_HEADER]: operationId } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
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
  const environment = () => db.prisma.computeEnvironment.create({ data: { id: ENV, taskId: "task", primarySessionId: "primary", machineId: "host", key: KEY,
    purpose: "development", revision: computeBody.revision, recipeDigest: computeBody.recipeDigest, taskIdentity: "9".repeat(64), state: "waiting" } });
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

test("H2: never-produced waiting work admitted by settled A is adopted by the next B command's claim; replays are not rebound; a failed request admits nothing", async () => {
  const f = await fixture();
  await f.activate(A, 0);
  const a = await f.command("a-runtime-up");
  expect((await a.request()).called?.status).toBe(200);
  await f.environment();
  expect((await a.settle()).status).toBe(200); // A's command ends waiting.
  await f.activate(B, 1);

  // A B request the domain refuses never takes the admission.
  const probe = await f.command("b-runtime-status");
  f.setDomain(route => route === "compute-request" ? 409 : 200);
  expect((await probe.request()).called?.status).toBe(409);
  f.setDomain(() => 200);
  expect(await f.admissions()).toEqual([`${short(a.bindings[0]!)}:intent`, `${short(a.bindings[0]!)}:confirmed`, `${short(probe.bindings[0]!)}:intent`, `${short(probe.bindings[0]!)}:failed`]);

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
  console.log(JSON.stringify({ H2: { a: short(a.fence), aChild: short(original), probe: short(probe.fence), b: short(b.fence), bClaim: short(claim.child!), admissions: await f.admissions(), handled: f.handled } }));
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
  expect((await b.settle()).status).toBe(200);
  expect((await resourceGroupCode({ prisma: db.prisma, task: await f.task(), reference: { type: "compute-environment", id: ENV } })).code!.revision).toBe(B);
  expect(await db.prisma.computeEnvironment.count()).toBe(1);
  console.log(JSON.stringify({ H3: { a: short(a.fence), continuation: short(continuation), b: short(b.fence), admissions: await f.admissions() } }));
});
