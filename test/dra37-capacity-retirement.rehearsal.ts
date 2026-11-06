/**
 * DRA-37 real-server acceptance: closed-waiter retirement and unavailable
 * historical capacity evidence (separate from A's physical runner; no Docker).
 *
 * EXPLICIT, never part of the default `bun test` gate:
 *   env -i PATH="$PATH" HOME=<private> TMPDIR=<private> bun test/dra37-capacity-retirement.rehearsal.ts
 *
 * Real isolated server (test-support/isolated-server.ts, unchanged), one
 * compute slot, five tasks launched through the owner route on a PRIVATE
 * committed synthetic tooling repository (test/dra37-capacity-tooling.ts)
 * whose runtime observer is task-owned and synthetic: it logs each call and,
 * by default, reports its physical inventory unavailable. Barrier provider:
 * test/dra37-reservation-provider.ts. Only normal owner/control/registration
 * routes; nothing is seeded except reading evidence.
 *
 * 1. Closed and paused waiters: while the only slot is held by a delivered
 *    assignment, the owner closes one waiter and pauses another. When that
 *    turn ends unclaimed, selection retires the closed wait with a durable
 *    receipt, keeps the paused one, and offers the next eligible original
 *    primary.
 * 2. Historical capacity: a task registers a task-runtime resource through
 *    the normal resource route with no stopped proof; the observer is
 *    unavailable. The diagnostic names the exact group, resource and cause,
 *    the conservative charge is kept (no assignment), and ordinary inbox
 *    delivery continues.
 * 3. Only closed waits: after the owner closes every remaining waiter, queue
 *    and inbox triggers retire them with receipts and the scan-requiring
 *    historical group still present causes NO observer call.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseServiceFile } from "../lib/config.ts";
import { isolatedServer } from "../test-support/isolated-server.ts";
import { createSyntheticTooling } from "./dra37-capacity-tooling.ts";

const cleanEnv = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", HOME: home });
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const PROVIDER = path.join(import.meta.dir, "dra37-reservation-provider.ts");
const TOOLING_HELPER = path.join(import.meta.dir, "dra37-capacity-tooling.ts");
async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { env: cleanEnv(root), stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return out;
}
const readJsonl = async (file: string) => existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

export async function rehearseCapacityRetirement() {
  for (const name of Object.keys(process.env)) if (name.startsWith("REMOTE_AGENT_")) delete process.env[name];
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  const provenance = async () => ({ head: (await git(repositoryRoot, "rev-parse", "HEAD")).trim(),
    status: await git(repositoryRoot, "--no-optional-locks", "status", "--porcelain"),
    trackedDiffDigest: sha256(await git(repositoryRoot, "--no-optional-locks", "diff", "HEAD", "--binary")),
    runnerDigest: sha256(await readFile(import.meta.path)), toolingHelperDigest: sha256(await readFile(TOOLING_HELPER)), providerDigest: sha256(await readFile(PROVIDER)),
    isolatedServerDigest: sha256(await readFile(path.join(repositoryRoot, "test-support/isolated-server.ts"))) });
  const server = await isolatedServer();
  const prisma = server.db.prisma, control = path.join(server.root, "provider-control");
  const evidence: Record<string, unknown> = { scope: "real isolated server, one compute slot, normal owner/control/registration routes, synthetic task-owned observer and barrier provider; no Docker, physical runtime, Linear or live provider",
    serverRoot: server.root, sourceProvenance: await provenance(), steps: [] };
  const steps = evidence.steps as unknown[];
  const resultFile = path.join(server.root, "capacity-retirement.json");
  let passed = false, observerLog = "";
  const call = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null });
  const owner = (route: string, body?: unknown) => server.request(route, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const socket = (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => server.socketRequest(route, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const until = async <T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await Bun.sleep(200); }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const observerCalls = async () => (await readJsonl(observerLog)).filter(entry => entry.args?.[0] === "compute");
  const waits = () => prisma.computeWait.findMany({ orderBy: { sequence: "asc" } });
  const retirements = () => prisma.runtimeMetadataEvent.findMany({ where: { action: "compute-wait-retired" }, orderBy: { sequence: "asc" } });
  const activeOffers = () => prisma.computeOffer.findMany({ where: { state: { in: ["queued", "offered", "validating", "claimed", "running", "unknown"] } } });
  const snapshot = async (label: string) => {
    const value = { label, at: new Date().toISOString(), offers: await prisma.computeOffer.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, environmentId: true, state: true, createdAt: true, completedAt: true } }),
      slots: await prisma.computeSlot.findMany(), waits: await waits(), environments: await prisma.computeEnvironment.findMany({ select: { id: true, taskId: true, state: true } }),
      tasks: await prisma.remoteTask.findMany({ select: { id: true, requestKey: true, ownerPaused: true, phase: true } }), observerCalls: (await observerCalls()).length };
    steps.push({ action: "snapshot", ...value });
    return value;
  };
  const seen = new Set<string>();
  const nextOffer = (taskId: string, what: string) => until(`${what} (offer to ${taskId})`, async () => {
    for (const name of (await readdir(control)).filter(value => value.startsWith("seen-")).sort()) {
      if (seen.has(name)) continue;
      const value = JSON.parse(await readFile(path.join(control, name), "utf8")) as { offer: string; n: number };
      const offer = await prisma.computeOffer.findUnique({ where: { id: value.offer } });
      const environment = offer && await prisma.computeEnvironment.findUnique({ where: { id: offer.environmentId } });
      if (environment?.taskId !== taskId) continue;
      seen.add(name); return { ...value, environmentId: environment.id };
    }
    return null;
  });
  const end = (offer: { offer: string; n: number }) => writeFile(path.join(control, `decide-${offer.offer}-${offer.n}.json`), JSON.stringify({ action: "end" }), { mode: 0o600 });
  const instruct = async (taskId: string, requestKey: string) => {
    const queued = await call(await owner(`/api/tasks/${taskId}/instructions`, { requestKey, text: `Ordinary DRA-37 instruction ${requestKey}; do no work.` }));
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    await until(`ordinary instruction ${requestKey}`, async () => (await prisma.runtimeInstruction.findUnique({ where: { id: `task:${taskId}:${requestKey}` } }))?.state === "completed");
    steps.push({ action: "ordinary-instruction-completed", taskId, requestKey });
  };
  try {
    // --- Private synthetic tooling, one slot, barrier provider.
    await mkdir(control, { recursive: true, mode: 0o700 });
    const tooling = await createSyntheticTooling(server.root, git);
    observerLog = path.join(tooling.control, "calls.jsonl");
    evidence.tooling = { revision: tooling.revision, adapterDigest: sha256(tooling.adapter) };
    const config = parseServiceFile(JSON.parse(await readFile(server.configFile, "utf8")));
    config.repositories.fixture!.tooling = { root: tooling.source, ref: tooling.revision };
    (config.machine as { compute?: unknown }).compute = { enabled: true, slots: 1, collectorFreshnessSeconds: 2, deliveryTimeoutSeconds: 5, startupTimeoutSeconds: 30, quietPeriodSeconds: 30 };
    config.machine.acpx = { ...config.machine.acpx, maxConcurrentTurns: 3 };
    const provider = [process.execPath, "--no-env-file", PROVIDER, control];
    config.providers.codex = { ...config.providers.codex, command: provider };
    config.providers.claude = { ...config.providers.claude, command: provider };
    await writeFile(server.configFile, JSON.stringify(parseServiceFile(JSON.parse(JSON.stringify(config)))), { mode: 0o600 });
    const repo = config.repositories.fixture!.root;
    await git(repo, "init", "--quiet", "-b", "main");
    await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
    await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic product identity");
    await server.start();

    const tasks: Array<{ id: string; sessionId: string; worktree: string }> = [];
    for (const key of ["cap-1", "cap-2", "cap-3", "cap-4", "cap-5"]) {
      const launched = await call(await owner("/api/tasks", { requestKey: key, repositoryId: "fixture", branchName: key, prompt: "Synthetic DRA-37 capacity task; do no work.", provider: "codex" }));
      assert.equal(launched.status, 201, JSON.stringify(launched.body));
      const task = await until(`task ${key}`, async () => { const row = await prisma.remoteTask.findFirst({ where: { requestKey: key } }); return row?.primarySessionId && row.worktreePath ? row : null; });
      await until(`task ${key} launch turn`, async () => (await prisma.runtimeInstruction.findUnique({ where: { id: `launch:${key}` } }))?.state === "completed"
        && (await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId! } }))?.status === "idle");
      tasks.push({ id: task.id, sessionId: task.primarySessionId!, worktree: task.worktreePath! });
    }
    const [t1, t2, t3, t4, t5] = tasks as [typeof tasks[number], typeof tasks[number], typeof tasks[number], typeof tasks[number], typeof tasks[number]];
    steps.push({ action: "launched", tasks, launchPhases: (await prisma.remoteTask.findMany({ select: { requestKey: true, phase: true, environmentStatus: true } })) });
    const recipeDigest = sha256("dra37-capacity-recipe");
    const environments: Record<string, string> = {};
    for (const task of [t1, t2, t3, t4]) {
      const requested = await call(await socket(`/api/tasks/${task.id}/compute-request`, { key: "app", purpose: "development", revision: (await git(task.worktree, "rev-parse", "HEAD")).trim(), recipeDigest }));
      assert.equal(requested.status, 202, JSON.stringify(requested.body));
      environments[task.id] = requested.body!.environment.id;
    }

    // --- 1. Closed and paused waiters while the only slot is held.
    const o1 = await nextOffer(t1.id, "first assignment");
    const closed2 = await call(await owner(`/api/tasks/${t2.id}/automation`, { action: "close" }));
    assert.equal(closed2.status, 200, JSON.stringify(closed2.body));
    const paused3 = await call(await owner(`/api/tasks/${t3.id}/automation`, { action: "pause" }));
    assert([200, 202].includes(paused3.status), JSON.stringify(paused3.body));
    let state = await snapshot("held-with-closed-and-paused-waiters");
    assert.equal(state.tasks.find(task => task.id === t2.id)?.phase, "closed");
    // Retirement belongs to selection (any scheduler tick, possibly within a
    // second of the close), proven below by its durable receipt, never by the
    // close route itself; whether a tick already ran is recorded, not assumed.
    steps.push({ action: "closed-waiter-wait-at-close", stillWaiting: state.waits.some(wait => wait.environmentId === environments[t2.id]) });
    await end(o1);
    const o4 = await nextOffer(t4.id, "the next eligible original primary after the closed and paused waiters");
    state = await snapshot("closed-retired-paused-kept-next-offered");
    const retired2 = (await retirements()).find(event => event.key.startsWith(`${environments[t2.id]}:`));
    assert(retired2, "The closed waiter's wait was retired with a durable receipt");
    const receipt2 = JSON.parse(retired2.value!);
    assert.equal(receipt2.reason, "task-closed");
    assert.equal(receipt2.evidence.taskPhase, "closed");
    assert(!state.waits.some(wait => wait.environmentId === environments[t2.id]));
    assert(state.waits.some(wait => wait.environmentId === environments[t3.id]), "The paused waiter's wait is kept");
    assert.equal(state.tasks.find(task => task.id === t3.id)?.ownerPaused, true);
    assert(!state.offers.some(offer => offer.environmentId === environments[t3.id]), "The paused waiter is never offered");
    assert(!state.offers.some(offer => offer.environmentId === environments[t2.id]), "The closed waiter is never offered");
    steps.push({ action: "closed-waiter-retired", receipt: { key: retired2.key, value: receipt2, runtimeSessionId: retired2.runtimeSessionId }, nextOffer: o4.offer, observerCallsSoFar: state.observerCalls });

    // --- 2. Historical/unrecorded capacity: exact cause, conservative charge, inbox continues.
    const registered = await call(await socket(`/api/sessions/${t5.sessionId}/task/resources`, { key: "runtime-development", kind: "task-runtime", purpose: "development",
      externalId: path.join(server.root, "synthetic-runtime", "runtime.json"), state: "ready", metadata: { recipeHash: recipeDigest, revision: (await git(t5.worktree, "rev-parse", "HEAD")).trim() } }, "PUT"));
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const resource = await prisma.remoteTaskResource.findFirstOrThrow({ where: { taskId: t5.id, key: "runtime-development" } });
    const callsBefore = (await observerCalls()).length;
    // Before any observation of it: reported as never observed.
    const unobserved = await call(await socket(`/api/tasks/${t1.id}/compute-policy?capacity=1`));
    const neverObserved = unobserved.body?.capacity?.blockers?.unaccounted?.find((value: { group: string }) => value.group === `${t5.id}:development`);
    steps.push({ action: "capacity-diagnostic-never-observed", observerCalls: callsBefore, blocker: neverObserved });
    if (callsBefore === 0) assert(neverObserved?.reason === "unrecorded-resource" || neverObserved?.detail?.includes("never observed"), JSON.stringify(neverObserved));
    await end(o4);
    await until("the observer to be asked for the historical group", async () => (await observerCalls()).length > callsBefore, 30_000);
    await Bun.sleep(5_000); // Several selection/collection ticks with eligible waiters.
    state = await snapshot("historical-capacity-unavailable");
    assert.equal((await activeOffers()).length, 0, "No assignment while the historical group is unaccounted");
    assert(state.slots.every(slot => slot.allocationId === null));
    const blocked = await call(await socket(`/api/tasks/${t1.id}/compute-policy?capacity=1`));
    const capacity = blocked.body?.capacity;
    steps.push({ action: "capacity-diagnostic-historical", status: blocked.status, capacity, observerCalls: (await observerCalls()).slice(-3) });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal(capacity.unaccounted, 1);
    assert.equal(capacity.usable, 0);
    const group = capacity.blockers.unaccounted.find((value: { group: string }) => value.group === `${t5.id}:development`);
    assert(group && group.ids.includes(resource.id), `The diagnostic names the exact group and resource: ${JSON.stringify(capacity.blockers)}`);
    // The exact cause: the observer failed at the observe phase with its fixed
    // code, distinct from a group never observed; never its raw output.
    assert.equal(group.reason, "uncredited-baseline");
    assert.equal(group.baseline?.reason, "refresh-failed", JSON.stringify(group));
    assert.deepEqual({ outcome: group.baseline.refresh.outcome, phase: group.baseline.refresh.phase, code: group.baseline.refresh.code }, { outcome: "failed", phase: "observe", code: "OBSERVER_EXIT" });
    assert(group.detail.includes("last refresh failed at observe OBSERVER_EXIT"), group.detail);
    assert(typeof group.action === "string" && group.action.length);
    const refreshEvents = await prisma.runtimeMetadataEvent.findMany({ where: { action: "compute-baseline-refresh" } });
    assert(refreshEvents.length >= 1);
    for (const text of [JSON.stringify(blocked.body), ...refreshEvents.map(event => event.value ?? "")]) assert(!text.includes("physical inventory unavailable"), "raw observer output is never recorded or reported");
    steps.push({ action: "observer-failure-diagnosed", refreshEvents: refreshEvents.map(event => ({ key: event.key, source: event.source, value: JSON.parse(event.value!) })) });
    assert((await observerCalls()).every(entry => entry.mode === "unavailable" && entry.args[1] === "baseline-observe"));
    assert(state.waits.some(wait => wait.environmentId === environments[t1.id]) && state.waits.some(wait => wait.environmentId === environments[t4.id]), "Eligible waiters are kept, not dropped");
    await instruct(t1.id, "ordinary-while-historical");

    // --- 3. Only closed waits: retired by queue/inbox triggers with no observer call.
    for (const task of [t1, t3, t4]) {
      const closed = await call(await owner(`/api/tasks/${task.id}/automation`, { action: "close" }));
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
    }
    await Bun.sleep(3_000); // Let any selection begun before the last close finish.
    const callsAtClose = (await observerCalls()).length;
    await instruct(t5.id, "queue-trigger-only-closed"); // An inbox tick schedules compute selection.
    await until("every closed wait to be retired", async () => (await waits()).length === 0, 30_000);
    await Bun.sleep(5_000); // Several more collection ticks.
    state = await snapshot("only-closed-waits-retired");
    const allRetired = await retirements();
    for (const task of [t1, t3, t4]) {
      const event = allRetired.find(value => value.key.startsWith(`${environments[task.id]}:`));
      assert(event, `wait of ${task.id} retired with a receipt`);
      assert.equal(JSON.parse(event.value!).reason, "task-closed");
    }
    assert.equal((await observerCalls()).length, callsAtClose, "No observer (physical scan) call while only closed waits remain");
    const stillBlocked = await call(await socket(`/api/tasks/${t5.id}/compute-policy?capacity=1`));
    assert(stillBlocked.body?.capacity?.blockers?.unaccounted?.some((value: { group: string }) => value.group === `${t5.id}:development`), "The historical group still requires a scan");
    steps.push({ action: "only-closed-waits-no-scan", observerCalls: callsAtClose, retirements: allRetired.map(event => ({ key: event.key, value: JSON.parse(event.value!) })), stillBlocked: stillBlocked.body?.capacity });
    const endProvenance = await provenance(), start = evidence.sourceProvenance as typeof endProvenance;
    assert.deepEqual(endProvenance, start, "Source provenance changed during the rehearsal");
    passed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 4000) : String(error);
    throw error;
  } finally {
    evidence.passed = passed;
    evidence.limitations = [
      "The runtime observer is a task-owned synthetic adapter (committed in a private tooling repository) that reports its physical inventory unavailable; real Drafted/Docker observation is A's physical runner.",
      "Closure uses the supported owner close action; resource cleanup/finalization of closed tasks is a separate operation not exercised here.",
      "Historical capacity recovery (a credited stopped proof) is not exercised: the registry release of a resource is deliberately not proof.",
      "Synthetic ACP provider; no Linear, Docker, live provider or deployment.",
    ];
    try {
      await server.stop();
      evidence.endProvenance = await provenance().catch(error => ({ error: String(error) }));
      evidence.observerCalls = existsSync(observerLog) ? await readJsonl(observerLog) : [];
      evidence.final = { offers: await prisma.computeOffer.findMany(), slots: await prisma.computeSlot.findMany(), waits: await prisma.computeWait.findMany(),
        environments: await prisma.computeEnvironment.findMany(), baselines: await prisma.computeBaseline.findMany(),
        resources: await prisma.remoteTaskResource.findMany(), retirements: await prisma.runtimeMetadataEvent.findMany({ where: { action: "compute-wait-retired" } }),
        instructions: await prisma.runtimeInstruction.findMany({ select: { id: true, sessionId: true, state: true, detail: true } }),
        tasks: await prisma.remoteTask.findMany({ select: { id: true, requestKey: true, ownerPaused: true, phase: true, primarySessionId: true, environmentStatus: true } }),
        sessions: await prisma.runtimeSession.findMany({ select: { id: true, status: true, closedAt: true } }) };
      evidence.leftovers = { serverRoot: await readdir(server.root).catch(() => []), databaseRemovedAfterEvidence: true };
      await writeFile(resultFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    } finally { await server.cleanup({ keepEvidence: true }); }
    console.log(JSON.stringify({ passed, evidence: resultFile }));
  }
}

if (import.meta.main) await rehearseCapacityRetirement();
