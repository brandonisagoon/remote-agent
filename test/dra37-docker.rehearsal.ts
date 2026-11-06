/**
 * DRA-37 REAL-Docker physical-observer rehearsal (explicit; never in the
 * default gate). Real Remote Agent server, Drafted's actual runtime, Docker
 * transports, relay and observer against REAL local containers (images
 * already present, recorded by ID, never pulled), behind the fixture policy
 * guard. Provider transports stay synthetic. Tooling is prepared by the
 * supported frozen helper (prepareToolingRelease + verifyPreparedToolingRelease);
 * this runner has NO release-aware activation or command binding.
 *
 * Optional bounded hold for an external browser check after the second task
 * is healthy: DRA37_HOLD_SECONDS=<1..3600> [DRA37_HOLD_FILE=<path>]. The
 * runner writes the hold record (second URL, exact IDs, ledger) to the hold
 * file (default <server root>/hold.json) and waits until "<hold file>.release"
 * exists or the bound expires, then re-checks health and resumes the normal
 * exact stop and ledger cleanup.
 *
 *   DRA37_REAL_DOCKER=1 DRA37_DRAFTED_SOURCE=<drafted checkout> DRA37_DRAFTED_REVISION=<sha> \
 *     bun test ./test/dra37-docker.rehearsal.ts
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dra37Server } from "./dra37-fixture.ts";

const HOLD_SECONDS = process.env.DRA37_HOLD_SECONDS === undefined ? 0 : Number(process.env.DRA37_HOLD_SECONDS);
if (!Number.isInteger(HOLD_SECONDS) || HOLD_SECONDS < 0 || HOLD_SECONDS > 3_600) throw new Error("DRA37_HOLD_SECONDS must be an integer from 1 to 3600 (bounded hold)");
setDefaultTimeout(600_000 + HOLD_SECONDS * 1_000);
const DRAFTED = { source: process.env.DRA37_DRAFTED_SOURCE ?? "", revision: process.env.DRA37_DRAFTED_REVISION ?? "" };
if (process.env.DRA37_REAL_DOCKER !== "1" || !DRAFTED.source || !/^[a-f0-9]{40}$/.test(DRAFTED.revision)) {
  throw new Error("The DRA-37 real-Docker rehearsal requires DRA37_REAL_DOCKER=1, DRA37_DRAFTED_SOURCE and an exact DRA37_DRAFTED_REVISION; it is not part of the default test gate");
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, ms = 180_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (done(last)) return last; await Bun.sleep(250); }
  throw new Error(`Timed out waiting for ${label}: ${(JSON.stringify(last) ?? "").slice(-2_500)}`);
}

/** Diagnosis only (failure messages, never assertions): the server's own
 * observation path with an executor that keeps the observer's stderr. */
async function observerDiagnosis(server: Awaited<ReturnType<typeof dra37Server>>, taskId: string) {
  try {
    const prisma = server.db.prisma;
    const { readConfig } = await import("../lib/config.ts");
    const { readConfiguredComputeObservation } = await import("../apps/server/services/tasks/compute-observer.ts");
    const { resolveSessionToolingCapability } = await import("../apps/server/services/tasks/tooling-capabilities.ts");
    const environment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId } });
    const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
    const resource = await prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: environment.resourceId! } });
    const execute = async (args: string[], options: { cwd: string; input?: string; env?: Record<string, string> }) => {
      const child = Bun.spawn(args, { cwd: options.cwd, env: { ...options.env, PATH: `${path.join(server.root, "bin")}:${options.env?.PATH ?? process.env.PATH}` }, stdin: options.input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
      if (options.input !== undefined) { child.stdin!.write(options.input); await child.stdin!.end(); }
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`observer exit ${code}: ${stderr.slice(-2_500)}`);
      return stdout;
    };
    const output = await readConfiguredComputeObservation({ prisma, config: readConfig(server.configFile) }, task, environment, resource, [], { resolve: resolveSessionToolingCapability, execute: execute as never });
    return `observer output: ${JSON.stringify(output).slice(0, 2_500)}`;
  } catch (failure) { return `observer diagnosis: ${String(failure instanceof Error ? failure.message : failure).slice(0, 3_000)}`; }
}

test("real containers: verified stop releases the only slot to the next original primary, which claims and starts its own app", async () => {
  const server = await dra37Server({ slots: 1, drafted: DRAFTED, docker: "real" });
  cleanups.push(() => server.cleanup({ keepEvidence: !!process.env.DRA37_KEEP_EVIDENCE }));
  const real = server.real!;
  const docker = (...args: string[]) => Bun.spawnSync([real.docker, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const preexisting = new Set(docker("container", "ls", "-aq", "--no-trunc").split("\n").filter(Boolean));
  const first = await server.seedTask("first"), second = await server.seedTask("second");
  await server.start();
  const prisma = server.db.prisma;
  const turnFor = (taskId: string) => async () => (await server.agentEvents()).find(event => event.task === taskId && (event.event === "runtime-up" || event.event === "runtime-error"));
  const diagnose = async () => JSON.stringify({ environments: await prisma.computeEnvironment.findMany(), offers: await prisma.computeOffer.findMany(), slots: await prisma.computeSlot.findMany(),
    ledger: server.dockerLedger(),
    containers: server.dockerLedger().filter(entry => entry.kind === "container").map(entry => ({ id: entry.id.slice(0, 12),
      state: docker("inspect", entry.id, "--format", "{{.Name}} {{.State.Status}} exit={{.State.ExitCode}} {{.State.Error}}"),
      logs: Bun.spawnSync([real.docker, "logs", "--tail", "15", entry.id], { stdout: "pipe", stderr: "pipe" }).stderr.toString().slice(-1_200) })),
    refusals: existsSync(path.join(server.apps, "docker-calls.jsonl")) ? readFileSync(path.join(server.apps, "docker-calls.jsonl"), "utf8").split("\n").filter(line => line.includes("refused")).slice(-5) : [] }).slice(-8_000);

  expect((await server.runtimeTurn(first.id, "up")).code).toBe(0);
  const firstTurn = await until(turnFor(first.id), Boolean, "first runtime turn").catch(async error => { throw new Error(`${error}\n${await diagnose()}`); });
  if (firstTurn?.code !== 0) throw new Error(`First runtime turn failed\n${String(firstTurn?.stderr ?? "").slice(-800)}\n${await diagnose()}`);
  expect(firstTurn, JSON.stringify(firstTurn)).toMatchObject({ event: "runtime-up", code: 0, result: { phase: "ready" } });
  const firstUrl = (firstTurn.result as { urls: Record<string, string> }).urls.api!;
  expect(await (await fetch(new URL("/health", firstUrl))).json()).toMatchObject({ ready: true, taskId: first.id });
  const waiting = await server.runtimeTurn(second.id, "up");
  expect(waiting.code, waiting.stderr).toBe(0);
  expect(waiting.result).toMatchObject({ phase: "waiting-compute" });
  const firstEnvironment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: first.id } });
  await until(() => prisma.computeEnvironment.findUniqueOrThrow({ where: { id: firstEnvironment.id } }), row => (row.observation as { state?: string } | null)?.state === "running", "real running observation")
    .catch(async error => { throw new Error(`${String(error).slice(0, 300)}\n${await observerDiagnosis(server, first.id)}\n${await diagnose()}`); });
  expect(await turnFor(second.id)()).toBeUndefined();

  expect((await server.runtimeTurn(first.id, "stop")).code).toBe(0);
  const secondTurn = await until(turnFor(second.id), Boolean, "second runtime turn after verified release", 300_000).catch(async error => { throw new Error(`${error}\n${await diagnose()}`); });
  if (!secondTurn) throw new Error("Second original primary never received its turn");
  expect(secondTurn, JSON.stringify(secondTurn)).toMatchObject({ event: "runtime-up", code: 0, result: { phase: "ready" } });
  expect((await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: firstEnvironment.id } })).observation).toMatchObject({ state: "stopped" });
  const secondUrl = (secondTurn.result as { urls: Record<string, string> }).urls.api!;
  expect(await (await fetch(new URL("/health", secondUrl))).json()).toMatchObject({ ready: true, taskId: second.id });
  const allocations = await prisma.computeSlot.findMany({ where: { allocationId: { not: null } } });
  expect(allocations).toHaveLength(1);
  const secondEnvironment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: second.id } });
  expect((await prisma.computeOffer.findUniqueOrThrow({ where: { id: allocations[0]!.allocationId! } })).environmentId).toBe(secondEnvironment.id);

  // Every created engine object is fixture-prefixed, labelled and ledgered;
  // no pre-existing container was touched.
  const ledger = server.dockerLedger();
  for (const entry of ledger.filter(value => value.kind === "container")) {
    const [row] = JSON.parse(docker("inspect", entry.id)) as Array<{ Name: string; Config: { Labels: Record<string, string> }; HostConfig: { Privileged: boolean; NetworkMode: string } }>;
    expect(row!.Name.startsWith(`/${real.prefix}-`)).toBe(true);
    expect(row!.Config.Labels["dev.drafted.task"]).toMatch(/^dra37-/);
    expect(row!.HostConfig.Privileged).toBe(false);
    expect(row!.HostConfig.NetworkMode).not.toBe("host");
    expect(preexisting.has(entry.id)).toBe(false);
  }
  console.log(JSON.stringify({ realDocker: { serverRoot: server.root, prefix: real.prefix, images: real.images, tooling: server.drafted!.release, preparation: server.drafted!.preparation,
    ledger, firstEnvironment: firstEnvironment.id, secondEnvironment: secondEnvironment.id, allocation: allocations[0]!.allocationId, secondUrl } }));

  if (HOLD_SECONDS > 0) {
    // Bounded hold for root's external browser wrapper. Nothing is changed
    // while held; the release file (or the bound) resumes the normal path.
    const holdFile = process.env.DRA37_HOLD_FILE ? path.resolve(process.env.DRA37_HOLD_FILE) : path.join(server.root, "hold.json");
    const releaseFile = `${holdFile}.release`, deadline = new Date(Date.now() + HOLD_SECONDS * 1_000);
    if (existsSync(releaseFile)) throw new Error(`Stale hold release file ${releaseFile}; remove it before holding`);
    const record = { secondUrl, taskId: second.id, sessionId: second.sessionId, environmentId: secondEnvironment.id, allocationId: allocations[0]!.allocationId,
      serverRoot: server.root, prefix: real.prefix, ledger, tooling: server.drafted!.release, heldAt: new Date().toISOString(), until: deadline.toISOString(), resume: `touch ${JSON.stringify(releaseFile)}` };
    writeFileSync(holdFile, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ hold: { file: holdFile, secondUrl, until: record.until, resume: record.resume } }));
    while (!existsSync(releaseFile) && Date.now() < deadline.getTime()) await Bun.sleep(500);
    const resumedBy = existsSync(releaseFile) ? "release-file" : "bound";
    // Still the same healthy second task after the external check.
    expect(await (await fetch(new URL("/health", secondUrl))).json()).toMatchObject({ ready: true, taskId: second.id });
    expect(server.dockerLedger()).toEqual(ledger);
    console.log(JSON.stringify({ holdResumed: { by: resumedBy, at: new Date().toISOString() } }));
  }
  expect((await server.runtimeTurn(second.id, "stop")).code).toBe(0);
});
