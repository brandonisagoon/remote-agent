/**
 * DRA-37 real server + actual Drafted runtime algorithm, with SYNTHETIC
 * physical/provider transports (see dra37-runtime-turn.ts). This proves the
 * Remote Agent server routes/scheduler/inbox and Drafted's manageRuntime
 * together; it is NOT production Docker or PlanetScale acceptance.
 *
 * Tooling preparation here is a DEPENDENCY-INJECTED PARTIAL REHEARSAL (see
 * dra37-fixture.ts): symlinked paired node_modules and a fixture-written
 * readiness receipt, not frozen install or release acceptance.
 *
 * EXPLICIT cross-repository rehearsal, never part of the default `bun test`
 * gate (the file name is deliberately not *.test.ts). It requires the paired
 * Drafted checkout and an exact commit, and fails when either is missing:
 *   DRA37_DRAFTED_SOURCE=/path/to/drafted DRA37_DRAFTED_REVISION=<40-hex sha> \
 *     bun test ./test/dra37-runtime.rehearsal.ts
 *
 * Hold mode for root browser verification (same inputs, plus):
 *   DRA37_HOLD=1 bun test ./test/dra37-runtime.rehearsal.ts -t "delivered offer"
 * prints the task app URL and the exact normal stop/cleanup command
 * (`touch <root>/release-hold`), then performs Drafted's normal stop and
 * removes only this fixture's own temporary root.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dra37Server } from "./dra37-fixture.ts";

setDefaultTimeout(Number(process.env.DRA37_HOLD_SECONDS ?? 0) * 1000 + 300_000);
const DRAFTED = { source: process.env.DRA37_DRAFTED_SOURCE ?? "", revision: process.env.DRA37_DRAFTED_REVISION ?? "" };
if (!DRAFTED.source || !/^[a-f0-9]{40}$/.test(DRAFTED.revision)) {
  throw new Error("DRA-37 runtime rehearsal requires DRA37_DRAFTED_SOURCE (paired Drafted checkout with node_modules) and DRA37_DRAFTED_REVISION (exact 40-character commit); it is not part of the default test gate");
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (done(last)) return last; await Bun.sleep(100); }
  const text = JSON.stringify(last) ?? "";
  throw new Error(`Timed out waiting for ${label}: ${text.slice(0, 800)} … ${text.slice(-2_000)}`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the original primary's delivered offer runs the actual Drafted runtime to a healthy task-owned app, and a normal stop ends exactly that process", async () => {
  const server = await dra37Server({ slots: 1, drafted: DRAFTED });
  cleanups.push(() => server.cleanup({ keepEvidence: !!process.env.DRA37_KEEP_EVIDENCE }));
  const task = await server.seedTask("app");
  await server.start();
  const prisma = server.db.prisma;
  // The configured tooling source and task pin make the normal capability
  // route resolvable (pre-protocol: no release-aware selection exists).
  const capability = await server.socket(`/api/sessions/${encodeURIComponent(task.sessionId)}/tooling-capability`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: "browser" }) });
  const browser = await capability.json() as { receipt?: Record<string, unknown>; error?: string };
  expect(capability.status, JSON.stringify(browser)).toBe(200);
  expect(browser.receipt).toMatchObject({ capability: "browser", source: "configured-host", capabilityRevision: server.drafted!.revision, checkout: server.drafted!.root, taskToolingRevision: server.drafted!.revision });
  expect(await prisma.toolingSelection.count()).toBe(0);

  // The adapter's first `runtime up` requests compute through the real routes.
  const first = await server.runtimeTurn(task.id, "up");
  expect(first.code, first.stderr).toBe(0);
  // The server reserves the slot and delivers the offer to the original
  // primary, whose turn runs the actual Drafted runtime with that offer.
  const events = await until(server.agentEvents, all => all.some(event => event.event === "runtime-up" || event.event === "runtime-error"), "runtime turn");
  const turn = events.find(event => event.event === "runtime-up" || event.event === "runtime-error")!;
  expect(turn, JSON.stringify(turn)).toMatchObject({ event: "runtime-up", code: 0, result: { phase: "ready" } });
  const environment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: task.id } });
  const offer = await prisma.computeOffer.findFirstOrThrow({ where: { environmentId: environment.id } });
  expect(["claimed", "running"]).toContain(offer.state);
  expect(await prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);

  // The task-owned app is a real process answering on Drafted's assigned URL.
  const identity = JSON.parse(readFileSync(path.join(server.apps, `${task.id}.identity.json`), "utf8")) as { pid: number; port: number; token: string };
  const url = (turn.result as { urls: Record<string, string> }).urls.api!;
  expect(Number(new URL(url).port)).toBe(identity.port);
  expect(alive(identity.pid)).toBe(true);
  const health = await (await fetch(new URL("/health", url))).json() as Record<string, unknown>;
  expect(health).toMatchObject({ ready: true, taskId: task.id, pid: identity.pid, token: identity.token });
  const evidence = { serverRoot: server.root, serverPid: server.pid, drafted: server.drafted, task: task.id, environment: environment.id, offer: offer.id, app: { url, ...identity } };
  console.log(JSON.stringify({ evidence }));

  if (process.env.DRA37_HOLD) {
    const release = path.join(server.root, "release-hold");
    console.log(JSON.stringify({ hold: { appUrl: url, normalStopAndCleanup: `touch ${JSON.stringify(release)}`, until: Number(process.env.DRA37_HOLD_SECONDS ?? 0) || "indefinitely (test timeout applies)" } }));
    const deadline = Date.now() + Number(process.env.DRA37_HOLD_SECONDS ?? 0) * 1000;
    while (!existsSync(release) && (process.env.DRA37_HOLD_SECONDS ? Date.now() < deadline : true)) await Bun.sleep(500);
  }

  // Normal stop through the actual runtime: exactly the recorded process ends.
  const stopped = await server.runtimeTurn(task.id, "stop");
  expect(stopped.code, stopped.stderr).toBe(0);
  await until(async () => alive(identity.pid), running => !running, "app process exit", 15_000);
  await expect(fetch(new URL("/health", url), { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
  const effects = readFileSync(path.join(server.apps, `${task.id}.effects.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(effects.filter(value => value.effect === "start")).toHaveLength(1);
  expect(effects.filter(value => value.effect === "stop").map(value => value.appPid)).toEqual([identity.pid]);
});

/**
 * Physical evidence boundary. Drafted's actual `compute observe` requires the
 * traffic journal its traffic daemon writes from the proxy's access log. The
 * synthetic proxy writes none, so observation is unavailable; the server must
 * then keep the stopped app's allocation charged and offer nothing to the
 * next waiter. (Verified handoff needs the real traffic daemon fed by the
 * fixture proxy: the next DRA-37 transport step.)
 */
test("without physical observer evidence a stopped app's allocation stays charged and the next waiter gets no offer", async () => {
  const server = await dra37Server({ slots: 1, drafted: DRAFTED });
  cleanups.push(() => server.cleanup({ keepEvidence: !!process.env.DRA37_KEEP_EVIDENCE }));
  const first = await server.seedTask("first"), second = await server.seedTask("second");
  await server.start();
  const prisma = server.db.prisma;
  const turnFor = (taskId: string) => async () => (await server.agentEvents()).find(event => event.task === taskId && (event.event === "runtime-up" || event.event === "runtime-error"));
  expect((await server.runtimeTurn(first.id, "up")).code).toBe(0);
  const firstTurn = await until(turnFor(first.id), Boolean, "first runtime turn");
  expect(firstTurn, JSON.stringify(firstTurn)).toMatchObject({ event: "runtime-up", code: 0, result: { phase: "ready" } });
  const waiting = await server.runtimeTurn(second.id, "up");
  expect(waiting.code, waiting.stderr).toBe(0);
  expect(waiting.result).toMatchObject({ phase: "waiting-compute" });
  const firstIdentity = JSON.parse(readFileSync(path.join(server.apps, `${first.id}.identity.json`), "utf8")) as { pid: number };
  const allocation = (await prisma.computeSlot.findFirstOrThrow({ where: { allocationId: { not: null } } })).allocationId!;

  expect((await server.runtimeTurn(first.id, "stop")).code).toBe(0);
  expect(alive(firstIdentity.pid)).toBe(false);
  // Several collector periods: the actual observer runs (via the synthetic
  // Docker CLI) but cannot produce a complete observation.
  const calls = path.join(server.apps, "docker-calls.jsonl");
  await until(async () => (existsSync(calls) ? readFileSync(calls, "utf8") : "").split("\n").filter(line => line.includes('"container","ls"')).length, count => count >= 3, "observer attempts", 90_000);
  const environment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: first.id } });
  expect(environment.observation).toBeNull();
  expect(await prisma.computeSlot.findFirst({ where: { allocationId: allocation } })).not.toBeNull();
  expect((await prisma.computeOffer.findUniqueOrThrow({ where: { id: allocation } })).state).toBe("claimed");
  expect(await prisma.computeOffer.count({ where: { environmentId: (await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: second.id } })).id } })).toBe(0);
  expect(await turnFor(second.id)()).toBeUndefined();
});
