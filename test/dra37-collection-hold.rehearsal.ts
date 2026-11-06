/**
 * DRA-37 real isolated server acceptance (two gated tests):
 *
 * 1. "observation unavailable": physical observation is made unavailable for
 *    over 60 s. Honestly: this is NOT one long collector pass. Each server
 *    `compute observe` run (10 s server timeout) blocks on a held Docker call
 *    that Drafted's own computeDocker abandons after 5 s, so the evidence is a
 *    bounded series of real, individually abandoned observer attempts while
 *    the charge stays exact, then an independently held offer turn (> 60 s)
 *    whose reservation survives while another original primary's ordinary
 *    instruction completes.
 * 2. "slow baseline": ONE real baseline refresh cycle longer than 60 s. Twelve
 *    pre-admission (historical) runtimes form twelve real baseline groups;
 *    each group's real `compute baseline-observe` (60 s server timeout) makes
 *    8 Docker calls, each slowed by a bounded 3.5 s and then FORWARDED for its
 *    real result (under Drafted's 5 s per-command deadline). With the
 *    server's four-group concurrency the single-flight cycle spans > 60 s and
 *    credits every group; the waiting task's offer dispatch is delayed by it.
 *    Then an independently held offer turn (> 60 s), reservation survival,
 *    another original primary's instruction completing, claim and completion.
 *
 * EXPLICIT, never part of the default gate:
 *   DRA37_REAL_DOCKER=1 DRA37_COLLECTION_HOLD=1 DRA37_DRAFTED_SOURCE=<drafted checkout> \
 *     DRA37_DRAFTED_REVISION=<sha> bun test ./test/dra37-collection-hold.rehearsal.ts
 *
 * Real isolated Remote Agent server (private migrated SQLite, loopback TCP,
 * control socket), ONE compute slot, Drafted prepared by the supported frozen
 * helper, Drafted's runtime/Docker transports/observer against real local
 * containers behind the fixture guard. Seeds are task/session identity only
 * (no offers, slots, grants or instructions); every request, offer,
 * reservation, delivery, claim and release comes from the server. Provider
 * transports stay synthetic (dra37-runtime-turn.ts).
 *
 * Test-only barriers, each acting on REAL execution and never answering for it:
 *  - observer hold / slow collector (guard): only Docker calls from the
 *    server-spawned observer (cwd inside the prepared tooling install); a hold
 *    blocks, a delay slows then forwards; both exit if their caller is gone;
 *  - offer-turn hold (synthetic primary): a delivered compute-offer turn stays
 *    in progress without a claim or answer until released.
 * Production timeouts are unchanged.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dra37Server } from "./dra37-fixture.ts";

const DRAFTED = { source: process.env.DRA37_DRAFTED_SOURCE ?? "", revision: process.env.DRA37_DRAFTED_REVISION ?? "" };
if (process.env.DRA37_REAL_DOCKER !== "1" || process.env.DRA37_COLLECTION_HOLD !== "1" || !DRAFTED.source || !/^[a-f0-9]{40}$/.test(DRAFTED.revision)) {
  throw new Error("The DRA-37 collection-hold acceptance requires DRA37_REAL_DOCKER=1, DRA37_COLLECTION_HOLD=1, DRA37_DRAFTED_SOURCE and an exact DRA37_DRAFTED_REVISION; it is not part of the default test gate");
}
const HOLD_MS = 65_000;
const GROUPS = 12, COLLECTOR_DELAY_MS = 3_500;
setDefaultTimeout(1_800_000);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const sourceRoot = path.resolve(import.meta.dir, "..");
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const gitOut = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  if (result.exitCode) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().slice(0, 300)}`);
  return result.stdout.toString();
};
const HELPERS = ["test-support/db.ts", "apps/server/prisma.ts", "lib/config.ts", "lib/tooling-source.ts", "apps/server/services/tasks/tooling.ts", "apps/server/server.ts", "package.json", "bun.lock"];
function provenance(server: Awaited<ReturnType<typeof dra37Server>>) {
  const digest = (relative: string) => existsSync(path.join(sourceRoot, relative)) ? sha256(readFileSync(path.join(sourceRoot, relative))) : null;
  const drafted = server.drafted!;
  return { at: new Date().toISOString(), head: gitOut(sourceRoot, "rev-parse", "HEAD").trim(), status: gitOut(sourceRoot, "status", "--porcelain=v1", "--untracked-files=all"),
    trackedDiffDigest: sha256(gitOut(sourceRoot, "diff", "HEAD", "--binary")),
    files: Object.fromEntries(readdirSync(import.meta.dir).filter(name => name.startsWith("dra37-") && name.endsWith(".ts")).sort().map(name => [`test/${name}`, digest(`test/${name}`)])),
    helpers: Object.fromEntries(HELPERS.map(relative => [relative, digest(relative)])),
    drafted: { pairedSource: DRAFTED.source, release: drafted.release, checkoutHead: gitOut(drafted.root, "rev-parse", "HEAD").trim(),
      checkoutStatus: gitOut(drafted.root, "status", "--porcelain", "--untracked-files=normal"),
      installReceipt: existsSync(`${drafted.root}.install.json`) ? JSON.parse(readFileSync(`${drafted.root}.install.json`, "utf8")) : null } };
}
const readJsonl = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>) : [];
async function until<T>(label: string, read: () => Promise<T | null | undefined | false>, ms = 300_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await Bun.sleep(250); }
  throw new Error(`Timed out waiting for ${label}`);
}

type Server = Awaited<ReturnType<typeof dra37Server>>;
/** Shared, read-mostly helpers over one fixture server. */
function harness(server: Server, evidence: Record<string, any>) {
  const step = (action: string, detail: object = {}) => evidence.steps.push({ action, at: new Date().toISOString(), ...detail });
  const prisma = server.db.prisma, real = server.real!;
  const calls = () => readJsonl(path.join(server.apps, "docker-calls.jsonl"));
  const docker = (...args: string[]) => Bun.spawnSync([real.docker, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const app = (taskId: string) => server.dockerLedger().filter(entry => entry.kind === "container").flatMap(entry => {
    const [row] = JSON.parse(docker("inspect", entry.id) || "[]") as Array<{ Id: string; Name: string; Config: { Labels: Record<string, string> }; State: { Status: string; Running: boolean; Pid: number } }>;
    return row && row.Config.Labels["dev.drafted.task"] === taskId && row.Name.endsWith("-app") ? [{ id: row.Id, status: row.State.Status, running: row.State.Running, pid: row.State.Pid }] : [];
  })[0];
  const observation = async (environmentId: string) => (await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environmentId } })).observation as { state?: string; observedAt?: number } | null;
  const agentEvent = (taskId: string, event: string) => async () => (await server.agentEvents()).find(entry => entry.task === taskId && entry.event === event);
  const instruct = async (taskId: string, requestKey: string, text: string) => {
    const response = await server.request(`/api/tasks/${encodeURIComponent(taskId)}/instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey, text }) });
    const body = await response.json() as { instruction?: { id: string } };
    expect(response.status, JSON.stringify(body)).toBe(202);
    step("owner-instruction", { taskId, requestKey, instructionId: body.instruction!.id });
    return body.instruction!.id;
  };
  const instruction = (id: string) => prisma.runtimeInstruction.findUniqueOrThrow({ where: { id } });
  const offersFor = (environmentId: string) => prisma.computeOffer.findMany({ where: { environmentId }, orderBy: { createdAt: "asc" } });
  const allocations = async () => (await prisma.computeSlot.findMany({ where: { allocationId: { not: null } } })).map(slot => slot.allocationId);
  /** Live guard (barrier) processes of THIS fixture: argv names its policy. */
  const barrierProcesses = () => Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe" }).stdout.toString().split("\n")
    .filter(line => line.includes(real.policy) && !line.includes("ps -axo"));
  const noBarrierProcesses = (label: string) => until(`${label}: no live barrier process`, async () => barrierProcesses().length === 0 || null, 30_000);
  /** Independent offer-turn hold > 60 s: the same reservation survives and
   * ANOTHER original primary's ordinary instruction completes meanwhile. */
  async function heldOfferTurn(taskId: string, environmentId: string, otherTaskId: string, phase: string) {
    const offers = await until(`${phase}: the single offer`, async () => { const rows = await offersFor(environmentId); return rows.length ? rows : null; }, 300_000);
    expect(offers).toHaveLength(1);
    const offer = offers[0]!;
    await until(`${phase}: offer turn held by the primary`, agentEvent(taskId, "offer-held"), 120_000);
    const heldAt = Date.now();
    const other = await instruct(otherTaskId, `dra37-${phase}-other-primary`, "DRA37 ordinary owner instruction to another original primary while an offer turn is held; reply only.");
    let otherCompletedAtMs: number | null = null;
    while (Date.now() - heldAt < HOLD_MS) {
      const rows = await offersFor(environmentId), otherState = (await instruction(other)).state;
      if (otherState === "completed" && otherCompletedAtMs === null) otherCompletedAtMs = Date.now() - heldAt;
      const sample = { atMs: Date.now() - heldAt, offers: rows.map(row => ({ id: row.id, state: row.state })), slots: await allocations(), other: otherState };
      evidence.samples.push({ phase, ...sample });
      expect(sample.offers).toEqual([{ id: offer.id, state: "offered" }]);
      expect(sample.slots).toEqual([offer.id]);
      await Bun.sleep(2_000);
    }
    const heldForMs = Date.now() - heldAt;
    expect(heldForMs).toBeGreaterThan(60_000);
    expect(otherCompletedAtMs, "another original primary's instruction completed while the offer turn was held").not.toBeNull();
    await server.holdAgentOffers(false);
    step(`${phase}-held`, { offer: offer.id, heldForMs, dispatchDeadline: offer.dispatchDeadline, otherInstruction: other, otherCompletedAtMs });
    return offer;
  }
  return { step, prisma, real, calls, app, observation, agentEvent, instruct, instruction, offersFor, allocations, barrierProcesses, noBarrierProcesses, heldOfferTurn };
}
async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { for (;;) { const item = items[index++]; if (item === undefined) return; await work(item); } }));
}
async function finish(server: Server, evidence: Record<string, any>, evidenceFile: string, passed: boolean) {
  const prisma = server.db.prisma;
  evidence.passed = passed;
  evidence.end = provenance(server);
  evidence.rows = await (async () => ({ environments: await prisma.computeEnvironment.findMany(), offers: await prisma.computeOffer.findMany(), slots: await prisma.computeSlot.findMany(),
    baselines: await prisma.computeBaseline.findMany(), instructions: await prisma.runtimeInstruction.findMany(),
    baselineRefreshes: await prisma.runtimeMetadataEvent.findMany({ where: { action: "compute-baseline-refresh" }, orderBy: { sequence: "asc" } }),
    tasks: await prisma.remoteTask.findMany({ select: { id: true, primarySessionId: true, ownerPaused: true, phase: true } }) }))().catch(error => ({ error: String(error) }));
  evidence.agent = await server.agentEvents().catch(() => []);
  evidence.ledger = server.dockerLedger();
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ evidence: evidenceFile, passed }));
}
const stable = (start: ReturnType<typeof provenance>, end: ReturnType<typeof provenance>) => {
  for (const key of ["head", "trackedDiffDigest", "files", "helpers", "drafted"] as const) expect(JSON.stringify(end[key]), key).toBe(JSON.stringify(start[key]));
};

test("observation unavailable > 60 s through bounded abandoned observer attempts; held offer turn > 60 s keeps its reservation while another primary progresses", async () => {
  const server = await dra37Server({ slots: 1, drafted: DRAFTED, docker: "real" });
  let passed = false;
  cleanups.push(() => server.cleanup({ keepEvidence: true }));
  const evidenceFile = path.join(server.root, "observation-unavailable-evidence.json");
  const evidence: Record<string, any> = { scope: "real isolated Remote Agent server; supported frozen Drafted release; Drafted runtime/Docker transports/observer on real local containers; synthetic ACP primary and provider transports; test-only observer hold and offer-turn hold",
    claim: "physical observation UNAVAILABLE for > 60 s via repeated real observer attempts, each blocked on a held Docker call and abandoned by Drafted's 5 s computeDocker deadline (server compute observe timeout is 10 s); not one long collector pass",
    serverRoot: server.root, start: provenance(server), steps: [] as unknown[], samples: [] as unknown[] };
  const h = harness(server, evidence), { prisma } = h;
  const holdState = () => {
    const entries = h.calls().filter(entry => entry.hold);
    const open = new Set<number>();
    for (const entry of entries) { if (entry.hold === "start") open.add(entry.pid); else open.delete(entry.pid); }
    const ended = entries.filter(entry => entry.hold !== "start");
    return { started: entries.filter(entry => entry.hold === "start").length, open: open.size, byOutcome: Object.fromEntries(["abandoned", "released", "bound-expired", "caller-gone"].map(kind => [kind, ended.filter(entry => entry.hold === kind).length])),
      waitedMs: ended.map(entry => entry.waitedMs) };
  };
  try {
    const first = await server.seedTask("first"), second = await server.seedTask("second");
    await server.start();
    const pid = server.pid;

    // --- 1. First task running and observed; second waits for the only slot.
    expect((await server.runtimeTurn(first.id, "up")).code).toBe(0);
    const firstUp = await until("first runtime turn", h.agentEvent(first.id, "runtime-up"));
    expect(firstUp, JSON.stringify(firstUp)).toMatchObject({ code: 0, result: { phase: "ready" } });
    const env1 = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: first.id } });
    await until("first observed running", async () => (await h.observation(env1.id))?.state === "running");
    const waiting = await server.runtimeTurn(second.id, "up");
    expect(waiting.code, waiting.stderr).toBe(0);
    expect(waiting.result).toMatchObject({ phase: "waiting-compute" });
    const env2 = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: second.id } });
    const firstOffer = (await h.allocations())[0]!;
    expect((await prisma.computeOffer.findUniqueOrThrow({ where: { id: firstOffer } })).environmentId).toBe(env1.id);
    h.step("first-running-second-waiting", { env1: env1.id, env2: env2.id, firstOffer });

    // --- 2. Observation unavailable > 60 s; the first app is stopped normally meanwhile.
    await server.holdObserver(true);
    const holdStartedAt = Date.now();
    await until("a held observer call (a real observer run is blocked)", async () => holdState().open > 0 || null, 60_000);
    const lastBeforeHold = (await h.observation(env1.id))?.observedAt ?? 0;
    const stopped = await server.runtimeTurn(first.id, "stop");
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(h.app(first.id)).toMatchObject({ status: "exited", running: false, pid: 0 });
    const progress = await h.instruct(first.id, "dra37-progress-during-unavailable-observation", "DRA37 ordinary owner instruction while observation is unavailable; reply only.");
    let maxOpen = 0;
    while (Date.now() - holdStartedAt < HOLD_MS) {
      const held = holdState(); maxOpen = Math.max(maxOpen, held.open);
      const sample = { atMs: Date.now() - holdStartedAt, held: { started: held.started, open: held.open, ...held.byOutcome }, observedAt: (await h.observation(env1.id))?.observedAt ?? null,
        slots: await h.allocations(), env2Offers: (await h.offersFor(env2.id)).map(offer => ({ id: offer.id, state: offer.state })), progress: (await h.instruction(progress)).state };
      evidence.samples.push({ phase: "observation-unavailable", ...sample });
      expect(sample.slots).toEqual([firstOffer]);
      expect(sample.env2Offers).toEqual([]);
      expect(held.byOutcome["bound-expired"]).toBe(0);
      await Bun.sleep(2_000);
    }
    const unavailableForMs = Date.now() - holdStartedAt;
    expect(unavailableForMs).toBeGreaterThan(60_000);
    expect((await h.observation(env1.id))?.observedAt ?? 0).toBeLessThanOrEqual(Math.max(lastBeforeHold, holdStartedAt));
    await until("owner instruction completed while observation was unavailable", async () => (await h.instruction(progress)).state === "completed" || null, 30_000);
    const summary = holdState();
    // Each attempt was a real observer run abandoned by Drafted's own 5 s
    // deadline (never our bound); attempts never overlap and stay <= 1 per tick.
    expect(summary.waitedMs.every((ms: number) => ms < 10_000)).toBe(true);
    expect(maxOpen).toBeLessThanOrEqual(1);
    expect(summary.started).toBeLessThanOrEqual(Math.ceil(unavailableForMs / 5_000) + 1);
    h.step("observation-unavailable", { unavailableForMs, attempts: summary.started, outcomes: summary.byOutcome, maxConcurrentHeld: maxOpen, attemptWaitedMs: summary.waitedMs, progressInstruction: progress });

    // --- 3. Arm the offer-turn hold, then restore observation.
    await server.holdAgentOffers(true);
    await server.holdObserver(false);
    const releasedAt = Date.now();
    await h.noBarrierProcesses("after observer release");
    await until("a fresh stopped observation after release", async () => { const value = await h.observation(env1.id); return (value?.state === "stopped" && (value.observedAt ?? 0) > releasedAt) || null; }, 120_000);

    // --- 4. Held offer turn > 60 s; the first task's primary (another original primary) progresses.
    const offer = await h.heldOfferTurn(second.id, env2.id, first.id, "offer-turn");

    // --- 5. Same reservation claimed; normal completion.
    const secondUp = await until("second runtime turn after the delayed response", h.agentEvent(second.id, "runtime-up"), 300_000);
    expect(secondUp, JSON.stringify(secondUp)).toMatchObject({ offerId: offer.id, code: 0, result: { phase: "ready" } });
    expect((await h.offersFor(env2.id)).map(row => row.id)).toEqual([offer.id]);
    expect(await h.allocations()).toEqual([offer.id]);
    const secondUrl = (secondUp.result as { urls: Record<string, string> }).urls.api!;
    expect(await (await fetch(new URL("/health", secondUrl))).json()).toMatchObject({ ready: true, taskId: second.id });
    const finalStartedAt = Date.now();
    expect((await server.runtimeTurn(second.id, "stop")).code).toBe(0);
    expect(h.app(second.id)).toMatchObject({ status: "exited", running: false, pid: 0 });
    await until("fresh stopped observation of the second app", async () => { const value = await h.observation(env2.id); return (value?.state === "stopped" && (value.observedAt ?? 0) > finalStartedAt) || null; }, 120_000);
    expect(server.pid).toBe(pid);
    await h.noBarrierProcesses("at completion");
    stable(evidence.start, provenance(server));
    h.step("completed", { claimed: await prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } }), guardHold: h.calls().filter(entry => entry.hold) });
    passed = true;
  } finally { await finish(server, evidence, evidenceFile, passed); }
});

test("slow baseline: one real refresh cycle > 60 s over twelve historical groups delays dispatch; held offer turn > 60 s keeps its reservation while another primary progresses", async () => {
  const server = await dra37Server({ slots: 1, drafted: DRAFTED, docker: "real", computeEnabled: false });
  let passed = false;
  cleanups.push(() => server.cleanup({ keepEvidence: true }));
  const evidenceFile = path.join(server.root, "slow-baseline-evidence.json");
  const evidence: Record<string, any> = { scope: "real isolated Remote Agent server; supported frozen Drafted release; real pre-admission runtimes as historical baseline groups; Drafted baseline-observe/runtime/observer on real local containers; synthetic ACP primary and provider transports; test-only slow-collector delay (forwarded) and offer-turn hold",
    claim: `one single-flight baseline refresh cycle of > 60 s: ${GROUPS} real groups, each real compute baseline-observe slowed by ${COLLECTOR_DELAY_MS} ms per Docker call (then forwarded), four groups concurrently`,
    serverRoot: server.root, start: provenance(server), steps: [] as unknown[], samples: [] as unknown[] };
  const h = harness(server, evidence), { prisma } = h;
  const refreshes = async () => (await prisma.runtimeMetadataEvent.findMany({ where: { action: "compute-baseline-refresh" }, orderBy: { sequence: "asc" } }))
    .map(row => ({ sequence: row.sequence, key: row.key, at: row.occurredAt.getTime(), ...JSON.parse(row.value ?? "{}") as { outcome?: string; phase?: string; code?: string } }));
  try {
    const historical: Awaited<ReturnType<Server["seedTask"]>>[] = [];
    for (let index = 1; index <= GROUPS; index++) historical.push(await server.seedTask(`h${String(index).padStart(2, "0")}`, { traffic: false }));
    const waiter = await server.seedTask("waiter");
    await server.start();

    // --- 1. Pre-admission runtimes (compute disabled): real apps started and stopped normally.
    await pool(historical, 4, async task => {
      const up = await server.runtimeTurn(task.id, "up");
      expect(up.code, up.stderr.slice(-1_500)).toBe(0);
      expect(up.result).toMatchObject({ phase: "ready" });
      const down = await server.runtimeTurn(task.id, "stop");
      expect(down.code, down.stderr.slice(-1_500)).toBe(0);
    });
    const runtimes = await prisma.remoteTaskResource.findMany({ where: { kind: "task-runtime", taskId: { in: historical.map(task => task.id) } } });
    expect(runtimes).toHaveLength(GROUPS);
    expect(await prisma.computeEnvironment.count()).toBe(0);
    for (const task of historical) expect(h.app(task.id)).toMatchObject({ status: "exited", running: false });
    h.step("historical-runtimes", { groups: GROUPS, resources: runtimes.map(row => ({ id: row.id, taskId: row.taskId, kind: row.kind, state: row.state })) });

    // --- 2. Restart with compute admission enabled (isolated config only); slow the collector.
    await server.stop();
    await server.setComputeEnabled(true);
    await server.start();
    const pid = server.pid;
    await server.slowCollector(COLLECTOR_DELAY_MS);
    await server.holdAgentOffers(true);
    const waiting = await server.runtimeTurn(waiter.id, "up");
    expect(waiting.code, waiting.stderr).toBe(0);
    expect(waiting.result).toMatchObject({ phase: "waiting-compute" });
    const envW = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: waiter.id } });
    const requestedAt = Date.now();

    // --- 3. The single refresh cycle: > 60 s of real collection, every group credited.
    await until("the first slowed baseline Docker call", async () => h.calls().some(entry => entry.delay === "start") || null, 120_000);
    const progress = await h.instruct(historical[0]!.id, "dra37-progress-during-slow-baseline", "DRA37 ordinary owner instruction during the slow baseline cycle; reply only.");
    let progressDoneAt: number | null = null, credited: Array<Record<string, any>> = [];
    for (;;) {
      const rows = await refreshes(), latest = new Map(rows.map(row => [row.key, row]));
      const failed = [...latest.values()].filter(row => row.outcome && row.outcome !== "credited");
      if (failed.length) throw new Error(`Baseline groups did not credit: ${JSON.stringify(failed)}`);
      if (progressDoneAt === null && (await h.instruction(progress)).state === "completed") progressDoneAt = Date.now();
      const offers = await h.offersFor(envW.id);
      evidence.samples.push({ phase: "slow-baseline", atMs: Date.now() - requestedAt, credited: latest.size, offers: offers.length, progress: (await h.instruction(progress)).state });
      if (latest.size === GROUPS) { credited = [...latest.values()]; break; }
      expect(offers, "no offer before every historical group is credited").toEqual([]);
      if (Date.now() - requestedAt > 600_000) throw new Error("The slow baseline cycle did not complete within its bound");
      await Bun.sleep(1_000);
    }
    const delays = h.calls().filter(entry => entry.delay);
    const started = delays.filter(entry => entry.delay === "start"), ended = delays.filter(entry => entry.delay !== "start");
    // One observer process per group in this cycle (ppid = the real baseline-observe run), never more than four at once.
    const observers = new Map<number, { first: number; last: number }>();
    for (const entry of started) { const span = observers.get(entry.ppid) ?? { first: entry.at, last: entry.at }; span.last = entry.at; observers.set(entry.ppid, span); }
    const spans = [...observers.values()];
    const maxConcurrentObservers = Math.max(...spans.map(span => spans.filter(other => other.first <= span.first && other.last >= span.first).length));
    const cycleMs = Math.max(...credited.map(row => row.at)) - Math.min(...started.map(entry => entry.at));
    expect(ended.every(entry => entry.delay === "forwarded"), "every slowed call was forwarded for its real result").toBe(true);
    expect(started.length).toBe(GROUPS * 8);
    expect(observers.size).toBe(GROUPS);
    expect(maxConcurrentObservers).toBeLessThanOrEqual(4);
    expect(cycleMs).toBeGreaterThan(60_000);
    expect(progressDoneAt, "another original primary's instruction completed during the slow cycle").not.toBeNull();
    expect(progressDoneAt!).toBeLessThan(Math.max(...credited.map(row => row.at)));
    await server.slowCollector(null);
    await h.noBarrierProcesses("after the slow baseline");
    h.step("slow-baseline-cycle", { cycleMs, groups: GROUPS, slowedCalls: started.length, observerRuns: observers.size, maxConcurrentObservers, perCallDelayMs: COLLECTOR_DELAY_MS,
      progressInstruction: progress, progressCompletedBeforeCycleEndMs: Math.max(...credited.map(row => row.at)) - progressDoneAt!, credited });

    // --- 4. Dispatch follows the credits; held offer turn > 60 s; another primary progresses.
    const offer = await h.heldOfferTurn(waiter.id, envW.id, historical[1]!.id, "offer-turn");
    expect(offer.createdAt.getTime()).toBeGreaterThanOrEqual(Math.max(...credited.map(row => row.at)) - 1_000);

    // --- 5. Same reservation claimed; normal completion.
    const up = await until("waiter runtime turn after the delayed response", h.agentEvent(waiter.id, "runtime-up"), 300_000);
    expect(up, JSON.stringify(up)).toMatchObject({ offerId: offer.id, code: 0, result: { phase: "ready" } });
    expect((await h.offersFor(envW.id)).map(row => row.id)).toEqual([offer.id]);
    expect(await h.allocations()).toEqual([offer.id]);
    const url = (up.result as { urls: Record<string, string> }).urls.api!;
    expect(await (await fetch(new URL("/health", url))).json()).toMatchObject({ ready: true, taskId: waiter.id });
    const finalStartedAt = Date.now();
    expect((await server.runtimeTurn(waiter.id, "stop")).code).toBe(0);
    expect(h.app(waiter.id)).toMatchObject({ status: "exited", running: false, pid: 0 });
    await until("fresh stopped observation of the waiter app", async () => { const value = await h.observation(envW.id); return (value?.state === "stopped" && (value.observedAt ?? 0) > finalStartedAt) || null; }, 120_000);
    expect(server.pid).toBe(pid);
    await h.noBarrierProcesses("at completion");
    stable(evidence.start, provenance(server));
    h.step("completed", { claimed: await prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } }) });
    passed = true;
  } finally { await finish(server, evidence, evidenceFile, passed); }
});
