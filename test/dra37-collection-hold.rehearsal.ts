/**
 * DRA-37 real isolated server acceptance: physical collection held beyond 60
 * seconds, an independently delayed primary response, reservation survival,
 * ordinary owner instruction progress, bounded repeated scheduling and
 * collection, then normal completion and exact cleanup.
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
 * Two test-only barriers, each blocking REAL execution, never answering for it:
 *  - observer hold (guard): the server-spawned `compute observe` process's
 *    Docker calls wait while the hold file exists, so no observation can be
 *    collected;
 *  - offer-turn hold (synthetic primary): a delivered compute-offer turn stays
 *    in progress without a claim or answer until released.
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
setDefaultTimeout(1_200_000);
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

test("collection held beyond 60 s and a delayed offer response keep exact charge and reservation; owner work progresses; normal completion", async () => {
  const server = await dra37Server({ slots: 1, drafted: DRAFTED, docker: "real" });
  let passed = false;
  cleanups.push(() => server.cleanup({ keepEvidence: true }));
  const evidenceFile = path.join(server.root, "collection-hold-evidence.json");
  const evidence: Record<string, any> = { scope: "real isolated Remote Agent server; supported frozen Drafted release; Drafted runtime/Docker transports/observer on real local containers; synthetic ACP primary and provider transports; test-only observer and offer-turn barriers",
    serverRoot: server.root, start: provenance(server), steps: [] as unknown[], samples: [] as unknown[] };
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
  const instructionState = async (id: string) => (await prisma.runtimeInstruction.findUniqueOrThrow({ where: { id } })).state;
  const offersFor = (environmentId: string) => prisma.computeOffer.findMany({ where: { environmentId }, orderBy: { createdAt: "asc" } });
  const holdState = () => {
    const entries = calls().filter(entry => entry.hold);
    const open = new Set<number>();
    for (const entry of entries) { if (entry.hold === "start") open.add(entry.pid); else open.delete(entry.pid); }
    return { started: entries.filter(entry => entry.hold === "start").length, open: open.size, expired: entries.filter(entry => entry.hold === "bound-expired").length,
      abandoned: entries.filter(entry => entry.hold === "abandoned").length, released: entries.filter(entry => entry.hold === "released").length };
  };

  try {
    const first = await server.seedTask("first"), second = await server.seedTask("second");
    await server.start();
    const pid = server.pid;

    // --- 1. First task running and observed; second waits for the only slot.
    expect((await server.runtimeTurn(first.id, "up")).code).toBe(0);
    const firstUp = await until("first runtime turn", agentEvent(first.id, "runtime-up"));
    expect(firstUp, JSON.stringify(firstUp)).toMatchObject({ code: 0, result: { phase: "ready" } });
    const env1 = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: first.id } });
    await until("first observed running", async () => (await observation(env1.id))?.state === "running");
    const waiting = await server.runtimeTurn(second.id, "up");
    expect(waiting.code, waiting.stderr).toBe(0);
    expect(waiting.result).toMatchObject({ phase: "waiting-compute" });
    const env2 = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: second.id } });
    const charged = await prisma.computeSlot.findMany({ where: { allocationId: { not: null } } });
    expect(charged).toHaveLength(1);
    const firstOffer = await prisma.computeOffer.findUniqueOrThrow({ where: { id: charged[0]!.allocationId! } });
    expect(firstOffer.environmentId).toBe(env1.id);
    step("first-running-second-waiting", { env1: env1.id, env2: env2.id, firstOffer: firstOffer.id, slot: charged[0] });

    // --- 2. Hold physical collection beyond 60 s; stop the first app normally.
    await server.holdObserver(true);
    const holdStartedAt = Date.now();
    await until("a held observer call (the actual observer is blocked)", async () => holdState().open > 0, 60_000);
    const lastBeforeHold = (await observation(env1.id))?.observedAt ?? 0;
    const stopped = await server.runtimeTurn(first.id, "stop");
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(app(first.id)).toMatchObject({ status: "exited", running: false, pid: 0 });
    const progressDuringHold = await instruct(first.id, "dra37-progress-during-collection-hold", "DRA37 ordinary owner instruction during held collection; reply only.");
    let maxOpen = 0;
    while (Date.now() - holdStartedAt < HOLD_MS) {
      const held = holdState(); maxOpen = Math.max(maxOpen, held.open);
      const slots = await prisma.computeSlot.findMany({ where: { allocationId: { not: null } } });
      const sample = { atMs: Date.now() - holdStartedAt, held, observedAt: (await observation(env1.id))?.observedAt ?? null, slots: slots.map(slot => slot.allocationId),
        env2Offers: (await offersFor(env2.id)).map(offer => ({ id: offer.id, state: offer.state })), progress: await instructionState(progressDuringHold) };
      evidence.samples.push({ phase: "collection-held", ...sample });
      // Exact conservative charge: no proof, no release, no transfer.
      expect(sample.slots).toEqual([firstOffer.id]);
      expect(sample.env2Offers).toEqual([]);
      expect(held.expired).toBe(0);
      await Bun.sleep(2_000);
    }
    const heldFor = Date.now() - holdStartedAt;
    expect(heldFor).toBeGreaterThan(60_000);
    // No observation was collected while held (one already in flight may finish only before the hold engaged).
    expect((await observation(env1.id))?.observedAt ?? 0).toBeLessThanOrEqual(Math.max(lastBeforeHold, holdStartedAt));
    // Ordinary owner work progressed while collection was held.
    await until("owner instruction completed during held collection", async () => (await instructionState(progressDuringHold)) === "completed", 30_000);
    expect(Date.now() - holdStartedAt).toBeLessThan(HOLD_MS + 30_000);
    const holdSummary = { heldForMs: heldFor, ...holdState(), maxConcurrentHeld: maxOpen };
    // Bounded repeated collection: attempts do not pile up (at most one held
    // observer call at a time, plus one being replaced) and do not exceed one
    // per compute tick (5 s here: collectorFreshnessSeconds 15 / 3).
    expect(maxOpen).toBeLessThanOrEqual(2);
    expect(holdSummary.started).toBeLessThanOrEqual(Math.ceil(heldFor / 5_000) + 2);
    step("collection-held", { ...holdSummary, waitingEnvironment: (await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: env2.id } })).state, progressInstruction: progressDuringHold });

    // --- 3. Arm the independent offer-turn hold, then release collection.
    await server.holdAgentOffers(true);
    await server.holdObserver(false);
    const releasedAt = Date.now();
    await until("a fresh stopped observation after release", async () => { const value = await observation(env1.id); return value?.state === "stopped" && (value.observedAt ?? 0) > releasedAt; }, 120_000);
    const offer2 = await until("the second task's single offer", async () => { const offers = await offersFor(env2.id); return offers.length ? offers : null; }, 120_000);
    expect(offer2).toHaveLength(1);
    await until("the offer turn held by the primary", agentEvent(second.id, "offer-held"), 120_000);
    const agentHeldAt = Date.now();
    step("collection-released-offer-delivered", { offer: offer2[0], firstOfferAfter: await prisma.computeOffer.findUniqueOrThrow({ where: { id: firstOffer.id } }) });

    // --- 4. Delayed primary response beyond 60 s: the reservation survives.
    const queuedBehindTurn = await instruct(second.id, "dra37-progress-behind-held-offer", "DRA37 ordinary owner instruction queued behind the held offer turn; reply only.");
    while (Date.now() - agentHeldAt < HOLD_MS) {
      const offers = await offersFor(env2.id), slots = await prisma.computeSlot.findMany({ where: { allocationId: { not: null } } });
      const sample = { atMs: Date.now() - agentHeldAt, offers: offers.map(offer => ({ id: offer.id, state: offer.state })), slots: slots.map(slot => slot.allocationId), queued: await instructionState(queuedBehindTurn) };
      evidence.samples.push({ phase: "offer-turn-held", ...sample });
      expect(sample.offers).toEqual([{ id: offer2[0]!.id, state: "offered" }]);
      expect(sample.slots).toEqual([offer2[0]!.id]);
      expect(sample.queued).not.toBe("completed");
      await Bun.sleep(2_000);
    }
    expect(Date.now() - agentHeldAt).toBeGreaterThan(60_000);
    await server.holdAgentOffers(false);

    // --- 5. The same reservation is claimed; the app starts; owner work follows.
    const secondUp = await until("second runtime turn after the delayed response", agentEvent(second.id, "runtime-up"), 300_000);
    expect(secondUp, JSON.stringify(secondUp)).toMatchObject({ offerId: offer2[0]!.id, code: 0, result: { phase: "ready" } });
    const claimed = await prisma.computeOffer.findUniqueOrThrow({ where: { id: offer2[0]!.id } });
    expect(["claimed", "running"]).toContain(claimed.state);
    expect((await offersFor(env2.id)).map(offer => offer.id)).toEqual([offer2[0]!.id]);
    expect((await prisma.computeSlot.findMany({ where: { allocationId: { not: null } } })).map(slot => slot.allocationId)).toEqual([offer2[0]!.id]);
    const secondUrl = (secondUp.result as { urls: Record<string, string> }).urls.api!;
    expect(await (await fetch(new URL("/health", secondUrl))).json()).toMatchObject({ ready: true, taskId: second.id });
    await until("owner instruction behind the held turn completed", async () => (await instructionState(queuedBehindTurn)) === "completed", 120_000);
    step("same-reservation-claimed", { offer: claimed, app: app(second.id), secondUrl });

    // --- 6. Normal completion.
    const finalStartedAt = Date.now();
    expect((await server.runtimeTurn(second.id, "stop")).code).toBe(0);
    expect(app(second.id)).toMatchObject({ status: "exited", running: false, pid: 0 });
    await until("fresh stopped observation of the second app", async () => { const value = await observation(env2.id); return value?.state === "stopped" && (value.observedAt ?? 0) > finalStartedAt; }, 120_000);
    expect(server.pid).toBe(pid);
    const end = provenance(server);
    for (const key of ["head", "trackedDiffDigest", "files", "helpers", "drafted"] as const) expect(JSON.stringify(end[key]), key).toBe(JSON.stringify(evidence.start[key]));
    step("completed", { holdSummary, guardHold: calls().filter(entry => entry.hold) });
    passed = true;
  } finally {
    evidence.passed = passed;
    evidence.end = provenance(server);
    evidence.rows = await (async () => ({ environments: await prisma.computeEnvironment.findMany(), offers: await prisma.computeOffer.findMany(), slots: await prisma.computeSlot.findMany(),
      instructions: await prisma.runtimeInstruction.findMany(), tasks: await prisma.remoteTask.findMany({ select: { id: true, primarySessionId: true, ownerPaused: true, phase: true } }) }))().catch(error => ({ error: String(error) }));
    evidence.agent = await server.agentEvents().catch(() => []);
    evidence.ledger = server.dockerLedger();
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ collectionHoldEvidence: evidenceFile, passed }));
  }
});
