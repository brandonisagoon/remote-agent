/**
 * DRA-37 real-server compute reservation / restart / lost-acknowledgment
 * rehearsal (separate from A's physical runner; no Docker, no real adapter).
 *
 * EXPLICIT, never part of the default `bun test` gate:
 *   env -u REMOTE_AGENT_CONFIG DRA37_TOOLING_RELEASES=/private/tmp/<dir>/prepared.json \
 *     bun test/dra37-reservation-restart.rehearsal.ts
 *
 * Real isolated server (test-support/isolated-server.ts: private migrated
 * SQLite, loopback TCP, control socket, supported stop/start), host compute
 * enabled with ONE slot. Two tasks are launched through the owner route on
 * the configured-host tooling pin (no release activation in this proof).
 * Compute requests use the normal task control route; offers, reservations,
 * deliveries and claims are produced by the server. The synthetic provider
 * test/dra37-reservation-provider.ts holds each compute-offer turn at a
 * private barrier and either ends it or claims through the normal claim
 * route. A claim is startup intent only: no adapter ran and no physical
 * compute started, so collection never observes these environments.
 *
 * Matrix covered: reservation before dispatch with a filled one-slot budget
 * and a second eligible waiter; ordinary instructions keep working while the
 * slot is held; a never-started assignment is released only after its turn
 * ended without a claim and the session is quiescent; owner pause withdraws
 * an unclaimed assignment and the claim is refused; restart after
 * reservation keeps the same assignment and slot; the owner retry of the
 * interrupted offer turn (recorded as observed); a client-side lost claim
 * acknowledgment and a restart after startup intent redeem the same
 * assignment without extra slots; an unknown start stays charged and blocks
 * the waiter, with the diagnostic naming it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseServiceFile } from "../lib/config.ts";
import { isolatedServer } from "../test-support/isolated-server.ts";
import { verifyPreparedToolingRelease } from "../apps/server/services/tasks/tooling.ts";

const Receipt = z.object({ repositoryId: z.literal("fixture"), revision: z.string().regex(/^[a-f0-9]{40}$/),
  tree: z.string().regex(/^[a-f0-9]{40}$/), policyBlob: z.string(), checkout: z.string(), lockfileDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const cleanEnv = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", HOME: home });
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const PROVIDER = path.join(import.meta.dir, "dra37-reservation-provider.ts");
const STARTUP_TIMEOUT_SECONDS = 30;

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { env: cleanEnv(root), stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return out;
}

export async function rehearseReservationRestart(receiptFile: string) {
  for (const name of Object.keys(process.env)) if (name.startsWith("REMOTE_AGENT_")) delete process.env[name];
  const file = await realpath(receiptFile), artifactRoot = path.dirname(file);
  const temporaryRoots = await Promise.all(["/private/tmp", tmpdir()].map(value => realpath(value)));
  assert(temporaryRoots.some(root => artifactRoot.startsWith(`${root}/`)), "Rehearsal must use disposable temporary prepared tooling");
  const [a] = z.array(Receipt).min(1).parse(JSON.parse(await readFile(file, "utf8")));
  const source = await realpath(path.join(artifactRoot, "source")), install = await realpath(path.join(artifactRoot, "install"));
  await verifyPreparedToolingRelease(a!);
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  const provenance = async () => ({ head: (await git(repositoryRoot, "rev-parse", "HEAD")).trim(),
    status: await git(repositoryRoot, "--no-optional-locks", "status", "--porcelain"),
    trackedDiffDigest: sha256(await git(repositoryRoot, "--no-optional-locks", "diff", "HEAD", "--binary")),
    runnerDigest: sha256(await readFile(import.meta.path)), providerDigest: sha256(await readFile(PROVIDER)),
    helperDigest: sha256(await readFile(path.join(repositoryRoot, "test-support/isolated-server.ts"))) });
  const server = await isolatedServer();
  const control = path.join(server.root, "provider-control");
  const evidence: Record<string, unknown> = { scope: "real isolated server, host compute with one slot, normal owner/control routes, synthetic barrier provider; no adapter, Docker, physical start or release activation",
    serverRoot: server.root, tooling: { revision: a!.revision, checkout: a!.checkout }, sourceProvenance: await provenance(), steps: [], findings: [] };
  const steps = evidence.steps as unknown[], findings = evidence.findings as unknown[];
  const resultFile = path.join(server.root, "reservation-restart.json");
  let passed = false;
  const prisma = server.db.prisma;
  const call = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null });
  const owner = (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => server.request(route, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const socket = (route: string, body?: unknown) => server.socketRequest(route, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const until = async <T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await Bun.sleep(200); }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const snapshot = async (label: string) => {
    const value = { label, at: new Date().toISOString(), pid: server.pid,
      offers: await prisma.computeOffer.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, environmentId: true, state: true, instructionId: true, executionRequestId: true, createdAt: true, deliveredAt: true, claimedAt: true, completedAt: true } }),
      slots: await prisma.computeSlot.findMany({ orderBy: { ordinal: "asc" } }),
      environments: await prisma.computeEnvironment.findMany({ select: { id: true, taskId: true, state: true, key: true } }),
      waits: await prisma.computeWait.findMany({ orderBy: { sequence: "asc" } }),
      offerInstructions: await prisma.runtimeInstruction.findMany({ where: { id: { startsWith: "compute-offer:" } }, select: { id: true, state: true, executionRequestId: true, detail: true } }),
      tasks: await prisma.remoteTask.findMany({ select: { id: true, requestKey: true, ownerPaused: true, phase: true, primarySessionId: true } }) };
    steps.push({ action: "snapshot", ...value });
    return value;
  };
  const seenConsumed = new Set<string>();
  const nextOffer = async (taskId: string, what: string, ms = 60_000) => until(`${what} (offer delivered to ${taskId})`, async () => {
    for (const name of (await readdir(control)).filter(value => value.startsWith("seen-")).sort()) {
      if (seenConsumed.has(name)) continue;
      const seen = JSON.parse(await readFile(path.join(control, name), "utf8")) as { offer: string; n: number; sessionEnv: string };
      const offer = await prisma.computeOffer.findUnique({ where: { id: seen.offer } });
      const environment = offer && await prisma.computeEnvironment.findUnique({ where: { id: offer.environmentId } });
      if (environment?.taskId !== taskId) continue;
      seenConsumed.add(name);
      return { ...seen, environmentId: environment.id };
    }
    return null;
  }, ms);
  const decide = (offer: string, n: number, decision: object) => writeFile(path.join(control, `decide-${offer}-${n}.json`), JSON.stringify(decision), { mode: 0o600 });
  const slotHolders = async () => (await prisma.computeSlot.findMany({ where: { allocationId: { not: null } } })).map(slot => slot.allocationId);
  const offerState = async (id: string) => (await prisma.computeOffer.findUniqueOrThrow({ where: { id } })).state;
  const restart = async (label: string) => {
    const before = server.pid; await server.stop(); await server.start();
    steps.push({ action: "restart", label, beforePid: before, afterPid: server.pid, boot: server.bootCount });
    assert.notEqual(server.pid, before);
  };
  try {
    // --- Configuration: configured-host tooling, one compute slot, barrier provider.
    await mkdir(control, { recursive: true, mode: 0o700 });
    const config = parseServiceFile(JSON.parse(await readFile(server.configFile, "utf8")));
    config.repositories.fixture!.tooling = { root: source, ref: a!.revision };
    config.machine.installation.root = install;
    (config.machine as { compute?: unknown }).compute = { enabled: true, slots: 1, collectorFreshnessSeconds: 2, deliveryTimeoutSeconds: 5, startupTimeoutSeconds: STARTUP_TIMEOUT_SECONDS, quietPeriodSeconds: 30 };
    // The fixture default (one host-wide acpx turn) would serialize every
    // session behind a held offer turn; that is turn concurrency, not compute
    // admission, so this proof allows independent sessions to run.
    config.machine.acpx = { ...config.machine.acpx, maxConcurrentTurns: 3 };
    const provider = [process.execPath, "--no-env-file", PROVIDER, control];
    config.providers.codex = { ...config.providers.codex, command: provider };
    config.providers.claude = { ...config.providers.claude, command: provider };
    await writeFile(server.configFile, JSON.stringify(parseServiceFile(JSON.parse(JSON.stringify(config)))), { mode: 0o600 });
    const worktree = config.repositories.fixture!.root;
    await git(worktree, "init", "--quiet", "-b", "main");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic product identity");
    const origin = path.join(server.root, "origin.git");
    await git(server.root, "init", "--quiet", "--bare", origin);
    await git(worktree, "remote", "add", "origin", origin);
    await git(worktree, "push", "--quiet", "origin", "main:staging");
    await server.start();

    // --- Two tasks through the owner launch route (no identity seeding).
    const tasks: Array<{ id: string; sessionId: string; worktree: string }> = [];
    for (const key of ["dra37-res-1", "dra37-res-2"]) {
      const launched = await call(await owner("/api/tasks", { requestKey: key, repositoryId: "fixture", branchName: key, prompt: "Synthetic reservation task; do no work.", provider: "codex" }));
      assert.equal(launched.status, 201, JSON.stringify(launched.body));
      const task = await until(`task ${key} primary`, async () => { const row = await prisma.remoteTask.findFirst({ where: { requestKey: key } }); return row?.primarySessionId && row.worktreePath ? row : null; });
      await until(`task ${key} launch turn`, async () => (await prisma.runtimeInstruction.findUnique({ where: { id: `launch:${key}` } }))?.state === "completed"
        && (await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId! } }))?.status === "idle");
      tasks.push({ id: task.id, sessionId: task.primarySessionId!, worktree: task.worktreePath! });
    }
    const [t1, t2] = tasks as [typeof tasks[number], typeof tasks[number]];
    steps.push({ action: "launched", tasks });
    const recipeDigest = sha256("dra37-reservation-recipe");
    const requestFor = async (task: typeof t1) => ({ key: "app", purpose: "development", revision: (await git(task.worktree, "rev-parse", "HEAD")).trim(), recipeDigest });
    const requests = { [t1.id]: await requestFor(t1), [t2.id]: await requestFor(t2) };
    for (const task of [t1, t2]) {
      const requested = await call(await socket(`/api/tasks/${task.id}/compute-request`, requests[task.id]));
      steps.push({ action: "compute-request", taskId: task.id, ...requested });
      assert.equal(requested.status, 202, JSON.stringify(requested.body));
    }

    // --- 1. Reservation before dispatch, filled budget, second waiter, ordinary work.
    const o1 = await nextOffer(t1.id, "first assignment");
    let state = await snapshot("o1-delivered-held");
    const first = state.offers.find(offer => offer.id === o1.offer)!;
    assert.equal(first.state, "offered");
    assert.deepEqual(await slotHolders(), [o1.offer], "The only slot is reserved by the first assignment");
    assert(first.deliveredAt && first.createdAt <= first.deliveredAt, "Reserved at selection, then delivered");
    assert.equal(state.offers.length, 1, "The second waiter gets no assignment while the budget is filled");
    const diagnostic = await call(await socket(`/api/tasks/${t2.id}/compute-policy?capacity=1`));
    steps.push({ action: "capacity-diagnostic-filled", taskId: t2.id, ...diagnostic });
    assert.equal(diagnostic.body?.capacity?.occupied, 1);
    assert.equal(diagnostic.body?.capacity?.headroom, 0);
    const ordinary = await call(await owner(`/api/tasks/${t2.id}/instructions`, { requestKey: "ordinary-1", text: "Ordinary instruction while compute is reserved; do no work." }));
    assert.equal(ordinary.status, 202, JSON.stringify(ordinary.body));
    await until("the ordinary instruction to complete", async () => (await prisma.runtimeInstruction.findUnique({ where: { id: `task:${t2.id}:ordinary-1` } }))?.state === "completed");
    assert.equal(await offerState(o1.offer), "offered", "The held reservation is unaffected by ordinary work");
    steps.push({ action: "ordinary-instruction-completed-while-reserved", instructionId: `task:${t2.id}:ordinary-1` });

    // --- 2. Never-started: the turn ends without claiming, then the slot is released.
    await decide(o1.offer, o1.n, { action: "end" });
    await until("the never-started assignment release", async () => await offerState(o1.offer) === "expired");
    const releasedTurn = await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: t1.sessionId, phase: "completed", requestId: first.executionRequestId ?? undefined } });
    const released = await prisma.computeOffer.findUniqueOrThrow({ where: { id: o1.offer } });
    assert(releasedTurn && released.completedAt && released.completedAt >= releasedTurn.occurredAt, "Released only after its delivering turn completed");
    const o2 = await nextOffer(t2.id, "the second waiter's assignment after release");
    await snapshot("o1-released-o2-delivered");
    assert.deepEqual(await slotHolders(), [o2.offer]);

    // --- 3. Owner pause withdraws the unclaimed assignment; its claim is refused.
    const pause = await call(await owner(`/api/tasks/${t2.id}/automation`, { action: "pause" }));
    steps.push({ action: "owner-pause-t2", status: pause.status, pending: pause.body?.pause?.pendingSessionIds ?? null });
    assert([200, 202].includes(pause.status), JSON.stringify(pause.body));
    await until("the paused assignment withdrawal", async () => await offerState(o2.offer) === "ineligible");
    const refused = await call(await socket(`/api/tasks/${t2.id}/compute-claim`, { offerId: o2.offer, ...requests[t2.id] }));
    steps.push({ action: "claim-after-pause", ...refused });
    assert.equal(refused.status, 409);
    assert.equal(refused.body?.code, "compute_offer_unavailable");
    if (!existsSync(path.join(control, `decide-${o2.offer}-${o2.n}.json`))) await decide(o2.offer, o2.n, { action: "end" });

    // --- 4. Restart after reservation: the same assignment and slot survive.
    const o3 = await nextOffer(t1.id, "the first task's next assignment");
    state = await snapshot("o3-delivered-before-restart");
    assert.deepEqual(await slotHolders(), [o3.offer]);
    const offersBefore = state.offers.length;
    await restart("after-reservation");
    await until("the interrupted offer turn to become unknown", async () => (await prisma.runtimeInstruction.findUnique({ where: { id: `compute-offer:${o3.offer}` } }))?.state === "unknown");
    await Bun.sleep(4_000); // Several collection/scheduler ticks.
    state = await snapshot("after-restart-reservation");
    assert.equal(await offerState(o3.offer), "offered", "The delivered reservation survives restart");
    assert.deepEqual(await slotHolders(), [o3.offer], "Same slot, no extra slot");
    assert.equal(state.offers.length, offersBefore, "No new assignment after restart");

    // Owner-authorized retry of the interrupted offer turn (recorded as observed).
    const retry = await call(await owner(`/api/tasks/${t1.id}/instructions/${encodeURIComponent(`compute-offer:${o3.offer}`)}/resolve`, { action: "retry", reason: "DRA-37 rehearsal: retry the interrupted compute-offer turn", requestKey: "retry-o3" }));
    steps.push({ action: "owner-retry-offer-turn", ...retry });
    let claimOffer: { offer: string; n: number } | null = null;
    try { claimOffer = await nextOffer(t1.id, "the retried offer turn", 15_000); } catch { claimOffer = null; }
    if (!claimOffer) {
      const instruction = await prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: `compute-offer:${o3.offer}` } });
      state = await snapshot("retry-not-redelivered");
      findings.push({ finding: "owner-retry-of-delivered-compute-offer-is-never-redelivered", retryStatus: retry.status, retryBody: retry.body,
        instruction: { state: instruction.state, executionRequestId: instruction.executionRequestId, detail: instruction.detail },
        offer: { id: o3.offer, state: await offerState(o3.offer) }, slotHolders: await slotHolders(),
        explanation: "After retry the instruction is queued, but the inbox gate computeInstructionAllows dispatches a compute-offer instruction only while its offer is still `queued`; the delivered offer is `offered`, so the retry is never delivered. reconcileComputeOffers keeps an offered reservation while its instruction is non-terminal, so the slot stays held until the owner pauses the task." });
      // Supported release: owner pause withdraws it; owner resume makes the task eligible again.
      const pauseT1 = await call(await owner(`/api/tasks/${t1.id}/automation`, { action: "pause" }));
      assert([200, 202].includes(pauseT1.status), JSON.stringify(pauseT1.body));
      await until("the stuck reservation withdrawal by pause", async () => await offerState(o3.offer) === "ineligible");
      steps.push({ action: "owner-pause-releases-stuck-reservation", offer: o3.offer, instruction: (await prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: `compute-offer:${o3.offer}` } })).state, slotHolders: await slotHolders() });
      const resumeT1 = await call(await owner(`/api/tasks/${t1.id}/automation`, { action: "resume" }));
      assert.equal(resumeT1.status, 200, JSON.stringify(resumeT1.body));
      claimOffer = await nextOffer(t1.id, "the first task's assignment after resume");
    }

    // --- 5. Client-side lost claim acknowledgment: the retry redeems the same assignment.
    await decide(claimOffer.offer, claimOffer.n, { action: "claim", taskId: t1.id, request: requests[t1.id], times: 2 });
    await until("the provider's claims", async () => existsSync(path.join(control, `claimed-${claimOffer!.offer}-${claimOffer!.n}.json`)));
    const claims = JSON.parse(await readFile(path.join(control, `claimed-${claimOffer.offer}-${claimOffer.n}.json`), "utf8")) as Array<{ attempt: number; discarded: boolean; status: number; body: any }>;
    steps.push({ action: "provider-claims", offer: claimOffer.offer, claims });
    assert.deepEqual(claims.map(value => value.status), [200, 200]);
    assert.equal(claims[1]!.body.offer.id, claimOffer.offer);
    assert.equal(claims[1]!.body.resumed, true, "The retried claim redeems the same assignment");
    state = await snapshot("claimed");
    const claimed = state.offers.find(offer => offer.id === claimOffer!.offer)!;
    assert.equal(claimed.state, "claimed");
    assert.deepEqual(await slotHolders(), [claimOffer.offer]);
    assert.equal(state.offers.filter(offer => ["queued", "offered", "validating", "claimed", "running", "unknown"].includes(offer.state)).length, 1, "Exactly one active assignment");
    assert.equal(state.environments.find(environment => environment.taskId === t1.id)?.state, "starting", "Startup intent recorded; no physical start is claimed");

    // --- 6. Restart after startup intent: the adapter's retry redeems the same claim.
    await restart("after-startup-intent");
    const redeemed = await call(await socket(`/api/tasks/${t1.id}/compute-claim`, { offerId: claimOffer.offer, ...requests[t1.id] }));
    steps.push({ action: "claim-after-restart", ...redeemed });
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    assert.equal(redeemed.body?.offer?.id, claimOffer.offer);
    assert.equal(redeemed.body?.resumed, true);
    assert.deepEqual(await slotHolders(), [claimOffer.offer], "No extra slot after restart");

    // --- 7. Unknown start stays charged; a resumed waiter is not offered; diagnostic names it.
    const resumeT2 = await call(await owner(`/api/tasks/${t2.id}/automation`, { action: "resume" }));
    assert.equal(resumeT2.status, 200, JSON.stringify(resumeT2.body));
    await until("the startup timeout to mark the start unknown", async () => await offerState(claimOffer!.offer) === "unknown", (STARTUP_TIMEOUT_SECONDS + 30) * 1000);
    await Bun.sleep(4_000);
    state = await snapshot("unknown-start-charged");
    assert.deepEqual(await slotHolders(), [claimOffer.offer], "An unknown start keeps its slot");
    assert.equal(state.environments.find(environment => environment.taskId === t1.id)?.state, "unknown");
    assert(!state.offers.some(offer => state.environments.find(environment => environment.id === offer.environmentId)?.taskId === t2.id && ["queued", "offered", "validating", "claimed"].includes(offer.state)), "The resumed waiter is not offered capacity held by an unknown start");
    const blocked = await call(await socket(`/api/tasks/${t2.id}/compute-policy?capacity=1`));
    steps.push({ action: "capacity-diagnostic-unknown", ...blocked });
    assert.equal(blocked.body?.capacity?.headroom, 0);
    assert(blocked.body?.capacity?.blockers?.allocations?.some((value: { allocationId: string; state: string }) => value.allocationId === claimOffer!.offer && value.state === "unknown"));
    const ordinary2 = await call(await owner(`/api/tasks/${t2.id}/instructions`, { requestKey: "ordinary-2", text: "Ordinary instruction while capacity is blocked; do no work." }));
    assert.equal(ordinary2.status, 202, JSON.stringify(ordinary2.body));
    await until("the second ordinary instruction to complete", async () => (await prisma.runtimeInstruction.findUnique({ where: { id: `task:${t2.id}:ordinary-2` } }))?.state === "completed");
    steps.push({ action: "ordinary-instruction-completed-while-blocked", instructionId: `task:${t2.id}:ordinary-2` });
    // A edits other dra37 files in this shared worktree concurrently: the code
    // under test (HEAD) and this proof's own files must be unchanged; any other
    // status/diff change is recorded, not asserted.
    const end = await provenance(), start = evidence.sourceProvenance as typeof end;
    assert.deepEqual({ head: end.head, runner: end.runnerDigest, provider: end.providerDigest, helper: end.helperDigest },
      { head: start.head, runner: start.runnerDigest, provider: start.providerDigest, helper: start.helperDigest }, "Code under test or this proof changed during the rehearsal");
    evidence.provenanceDelta = { statusChanged: end.status !== start.status, trackedDiffChanged: end.trackedDiffDigest !== start.trackedDiffDigest };
    passed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 4000) : String(error);
    throw error;
  } finally {
    evidence.passed = passed;
    evidence.limitations = [
      "No adapter, Docker or physical start: a claim is recorded startup intent only; collection never observed these environments (no bound resource), so physical reclamation, health and browser checks belong to A's combined runner.",
      "The lost acknowledgment is client-side (the provider discards the first claim response and retries), not a transport fault.",
      "No release activation or command binding; tasks run on the configured-host tooling pin.",
      "Closed-waiter retirement and historical (unrecorded-resource) capacity blockers are not exercised here: closing needs the finalization path and an unrecorded resource triggers a physical baseline observer.",
    ];
    try {
      await server.stop();
      evidence.endProvenance = await provenance().catch(error => ({ error: String(error) }));
      evidence.provider = existsSync(path.join(control, "provider.jsonl")) ? (await readFile(path.join(control, "provider.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [];
      evidence.controlFiles = existsSync(control) ? (await readdir(control)).sort() : [];
      evidence.final = { offers: await prisma.computeOffer.findMany(), slots: await prisma.computeSlot.findMany(), environments: await prisma.computeEnvironment.findMany(), waits: await prisma.computeWait.findMany(),
        instructions: await prisma.runtimeInstruction.findMany({ select: { id: true, sessionId: true, state: true, executionRequestId: true, detail: true, createdAt: true, updatedAt: true } }),
        lifecycle: await prisma.runtimeLifecycleEvent.findMany({ orderBy: { sequence: "asc" }, select: { runtimeSessionId: true, requestId: true, phase: true, occurredAt: true } }),
        tasks: await prisma.remoteTask.findMany({ select: { id: true, requestKey: true, ownerPaused: true, phase: true, primarySessionId: true, worktreePath: true, toolingRevision: true } }),
        sessions: await prisma.runtimeSession.findMany({ select: { id: true, status: true, role: true, cwd: true } }),
        operations: await prisma.toolingOperation.findMany(), selection: await prisma.toolingSelection.findMany() };
      evidence.leftovers = { serverRoot: await readdir(server.root).catch(() => []), databaseRemovedAfterEvidence: true };
      await writeFile(resultFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    } finally { await server.cleanup({ keepEvidence: true }); }
    console.log(JSON.stringify({ passed, evidence: resultFile }));
  }
}

if (import.meta.main) {
  const receipts = process.env.DRA37_TOOLING_RELEASES;
  if (!receipts) throw new Error("Set DRA37_TOOLING_RELEASES to the frozen prepared tooling receipts in a disposable temporary directory");
  await rehearseReservationRestart(receipts);
}
