/**
 * DRA-31 legacy-consumer and new-task adoption rehearsal.
 *
 * EXPLICIT, never part of the default `bun test` gate. Real isolated server
 * (private migrated SQLite, loopback TCP, control socket), the real frozen
 * prepared Drafted releases A and B, and Drafted A's own committed CLI:
 *   env -u REMOTE_AGENT_CONFIG DRA31_PREPARED_RELEASES=/private/tmp/<dir>/prepared.json \
 *     bun test/dra31-legacy-turn.rehearsal.ts
 *
 * What it proves, through normal supported routes only:
 * 1. Before any release-aware selection, the task primary resolves its
 *    runtime capability (configured-host A receipt) and Drafted A's
 *    `upkeep pause` records an owner development intent. That A process is
 *    still in flight (its next callback is held in a transparent socket relay
 *    that forwards bytes unchanged), so the intent is a genuine live
 *    pre-boundary consumer.
 * 2. Normal first activation of A inventories that consumer with the exact
 *    recorded A executable; activation of B follows without restart.
 * 3. The in-flight A process then completes its own intent headerless; the
 *    server admits it only as that consumer's legacy continuation. No
 *    operation is created, A's pin and the owner pauses are preserved.
 * 4. A NEW command from the same stale A checkout is refused before effects.
 * 5. An owner task launch after B is pinned to B, and the synthetic ACP
 *    provider receives B's prepared checkout, not A's.
 *
 * Seeded rows are identity only: one task/primary session for the legacy
 * consumer and one unpaused control task. Selection, consumers, operations,
 * capability receipts, intents, pauses, allocations and deliveries are all
 * produced by the server's own routes. Source-message turns are NOT covered:
 * their only normal producer is the credentialed Linear comment webhook and
 * dispatch validates ownership against Linear (see the evidence's
 * `limitations`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseServiceFile } from "../lib/config.ts";
import { isolatedServer } from "../test-support/isolated-server.ts";
import { verifyPreparedToolingRelease } from "../apps/server/services/tasks/tooling.ts";

const Receipt = z.object({ repositoryId: z.literal("fixture"), revision: z.string().regex(/^[a-f0-9]{40}$/),
  tree: z.string().regex(/^[a-f0-9]{40}$/), policyBlob: z.string(), checkout: z.string(), lockfileDigest: z.string().regex(/^[a-f0-9]{64}$/) });
// Explicit child environment: no inherited REMOTE_AGENT_* or provider secrets.
const cleanEnv = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", HOME: home });
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { env: cleanEnv(root), stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return out;
}

/** Transparent unix-socket relay. Bytes, method, path and headers are
 * forwarded unchanged; the only effect is that a request matching `hold`
 * waits until `release()` — modelling a pre-boundary process whose next
 * callback arrives after activation. Every request is logged. */
function relay(listen: string, target: string, hold: (method: string, pathname: string) => boolean) {
  const requests: Array<{ at: string; method: string; path: string; operationHeader: string | null; held: boolean; status?: number }> = [];
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let heldSignal!: () => void;
  const heldSeen = new Promise<void>(resolve => { heldSignal = resolve; });
  const server = Bun.serve({ unix: listen, async fetch(request) {
    const url = new URL(request.url);
    const entry = { at: new Date().toISOString(), method: request.method, path: url.pathname + url.search, operationHeader: request.headers.get("x-remote-agent-operation"), held: false } as (typeof requests)[number];
    requests.push(entry);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    if (hold(request.method, url.pathname)) { entry.held = true; heldSignal(); await gate; }
    const headers = new Headers(request.headers); headers.delete("host");
    const response = await fetch(`http://relay${url.pathname}${url.search}`, { method: request.method, headers, body, unix: target, redirect: "manual" });
    entry.status = response.status;
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  } });
  return { requests, heldSeen, release: () => open(), stop: () => server.stop(true) };
}

export async function rehearseLegacyTurn(receiptFile: string) {
  for (const name of Object.keys(process.env)) if (name.startsWith("REMOTE_AGENT_")) delete process.env[name];
  const file = await realpath(receiptFile), artifactRoot = path.dirname(file);
  const temporaryRoots = await Promise.all(["/private/tmp", tmpdir()].map(value => realpath(value)));
  assert(temporaryRoots.some(root => artifactRoot.startsWith(`${root}/`)), "Rehearsal must use disposable temporary prepared releases");
  const [a, b] = z.array(Receipt).length(2).parse(JSON.parse(await readFile(file, "utf8")));
  assert(a && b && a.revision !== b.revision && a.policyBlob === b.policyBlob, "Two distinct compatible committed releases are required");
  const source = await realpath(path.join(artifactRoot, "source")), install = await realpath(path.join(artifactRoot, "install"));
  for (const release of [a, b]) {
    assert.equal(await realpath(release.checkout), path.join(install, "tooling", "fixture", release.revision));
    await verifyPreparedToolingRelease(release);
  }
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  const provenance = async () => ({ head: (await git(repositoryRoot, "rev-parse", "HEAD")).trim(),
    status: await git(repositoryRoot, "--no-optional-locks", "status", "--porcelain"),
    trackedDiffDigest: sha256(await git(repositoryRoot, "--no-optional-locks", "diff", "HEAD", "--binary")),
    runnerDigest: sha256(await readFile(import.meta.path)), helperDigest: sha256(await readFile(path.join(import.meta.dir, "dra31-legacy-turn-helper.ts"))) });
  const server = await isolatedServer();
  const taskId = "dra31-legacy", sessionId = "dra31-legacy-primary", controlId = "dra31-control";
  const stateDirectory = path.join(server.root, "state"), providerLog = path.join(server.root, "provider.jsonl"), relaySocket = path.join(server.root, "relay.sock");
  const evidence: Record<string, unknown> = { scope: "real isolated server + frozen Drafted A/B releases + Drafted A CLI; synthetic ACP provider; no physical provider/app/Linear acceptance",
    serverRoot: server.root, releases: [a, b], sourceProvenance: await provenance(), steps: [] };
  const steps = evidence.steps as unknown[];
  const resultFile = path.join(server.root, "legacy-turn.json");
  let passed = false, relayed: ReturnType<typeof relay> | undefined;
  const json = async (response: Response, status = 200) => {
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  const paused = async () => Object.fromEntries((await server.db.prisma.remoteTask.findMany({ where: { id: { in: [taskId, controlId] } } })).map(task => [task.id, task.ownerPaused]));
  const activate = async (revision: string, expectedGeneration: number, requestKey: string) => {
    const beforePid = server.pid;
    const receipt = await json(await server.request("/api/tooling-releases/fixture/activations", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, expectedGeneration, requestKey }), signal: AbortSignal.timeout(120_000) }));
    steps.push({ action: "activation", revision, expectedGeneration, requestKey, beforePid, afterPid: server.pid, ownerPaused: await paused(), receipt });
    assert.equal(server.pid, beforePid, "Activation must not restart the isolated server");
    return receipt;
  };
  const cli = (checkout: string, args: string[], requestKey: string, socket: string) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", path.join(checkout, "src/cli.ts"), ...args, "--task", taskId, "--socket", socket], {
      cwd: checkout, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...cleanEnv(server.root), DRAFTED_RUNTIME_STATE_DIRECTORY: stateDirectory, REMOTE_AGENT_TOOLING_REQUEST_KEY: requestKey } });
    const limit = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 120_000);
    return (async () => {
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        steps.push({ action: `drafted ${args.join(" ")}`, revision: path.basename(checkout), requestKey, code, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) });
        return { code, stdout, stderr };
      } finally { clearTimeout(limit); }
    })();
  };
  try {
    // --- Isolated configuration: tooling source/ref A, frozen install, synthetic provider.
    const config = parseServiceFile(JSON.parse(await readFile(server.configFile, "utf8")));
    config.repositories.fixture!.tooling = { root: source, ref: a.revision };
    config.machine.installation.root = install;
    const provider = [process.execPath, "--no-env-file", path.join(import.meta.dir, "dra31-legacy-turn-helper.ts"), providerLog];
    config.providers.codex = { ...config.providers.codex, command: provider };
    config.providers.claude = { ...config.providers.claude, command: provider };
    await writeFile(server.configFile, JSON.stringify(config), { mode: 0o600 });
    const worktree = config.repositories.fixture!.root;
    await git(worktree, "init", "--quiet", "-b", "main");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic task identity");
    // Drafted's committed team policy bases new tasks on origin/staging: a
    // local bare remote (no network) gives the launch its normal fetch.
    const origin = path.join(server.root, "origin.git");
    await git(server.root, "init", "--quiet", "--bare", origin);
    await git(worktree, "remote", "add", "origin", origin);
    await git(worktree, "push", "--quiet", "origin", "main:staging");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    // --- Identity-only seed (no pause, intent, capability, consumer or operation).
    await server.db.prisma.runtimeSession.create({ data: { id: sessionId, scopeKey: sessionId, agentCommand: "codex", repositoryId: "fixture", machineId: "isolated-workflow",
      cwd: worktree, worktreePath: worktree, role: "primary", lifecycle: "persistent", status: "idle" } });
    await server.db.prisma.remoteTask.create({ data: { id: taskId, requestKey: taskId, repositoryId: "fixture", machineId: "isolated-workflow", primarySessionId: sessionId,
      worktreePath: worktree, branchName: "main", toolingRoot: source, toolingRevision: a.revision, pinnedToolingRoot: a.checkout, phase: "working" } });
    await server.db.prisma.remoteTask.create({ data: { id: controlId, requestKey: controlId, repositoryId: "fixture", machineId: "isolated-workflow",
      branchName: "control", toolingRoot: source, toolingRevision: a.revision, phase: "working" } });
    await server.start();
    const pid = server.pid;
    assert.equal((await json(await server.request("/api/tooling-releases/fixture"))).selection, null);

    // --- Pre-boundary: owner pauses the control task; primary resolves runtime capability A.
    const control = await json(await server.request(`/api/tasks/${controlId}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) }));
    steps.push({ action: "owner-pause-control", status: control.task?.ownerPaused ?? null });
    const capability = await json(await server.socketRequest(`/api/sessions/${sessionId}/tooling-capability`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "runtime" }), signal: AbortSignal.timeout(60_000) }));
    steps.push({ action: "runtime-capability", receipt: capability.receipt });
    assert.equal(capability.receipt.capabilityRevision, a.revision);
    assert.equal(capability.receipt.checkout, a.checkout);
    assert.equal(capability.receipt.source, "configured-host");

    // --- Pre-boundary A process: records the owner development intent, then
    // its next callback is held in flight across both activations.
    relayed = relay(relaySocket, server.controlSocket, (method, pathname) => method === "POST" && pathname === `/api/tasks/${taskId}/development-authority`);
    const pause = cli(a.checkout, ["upkeep", "pause", "--request-key", "dra31-owner-pause"], "dra31-legacy-pause", relaySocket);
    await Promise.race([relayed.heldSeen, pause.then(result => { throw new Error(`A exited before its continuation was held: ${JSON.stringify(result)}`); })]);
    const intent = await server.db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { runtimeSessionId: sessionId, source: `development:${taskId}`, action: "development-compute-intent" } });
    assert.equal(await server.db.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: sessionId, source: `development:${taskId}`, action: "development-compute-complete" } }), 0);
    assert.equal(await server.db.prisma.toolingOperation.count(), 0, "No release-aware operation exists before the boundary");
    steps.push({ action: "pre-boundary-consumer-live", intentSequence: intent.sequence, intent: JSON.parse(intent.value ?? "null"), ownerPaused: await paused() });

    // --- Normal activation A (inventories the live consumer), then B.
    const first = await activate(a.revision, 0, "dra31-legacy-activate-a");
    assert.equal(first.selection.generation, 1);
    const consumers = await server.db.prisma.toolingLegacyConsumer.findMany();
    steps.push({ action: "first-bootstrap-inventory", consumers });
    const consumer = consumers.find(row => row.consumerKind === "development-intent" && row.consumerId === String(intent.sequence));
    assert(consumer, `The live intent ${intent.sequence} was not inventoried: ${JSON.stringify(consumers)}`);
    assert.equal(consumer.taskId, taskId);
    assert.equal(consumer.provenance, "exact");
    assert.equal(consumer.revision, a.revision);
    assert.equal(consumer.checkout, a.checkout);
    assert.equal(consumer.status, "retained");
    const second = await activate(b.revision, 1, "dra31-legacy-activate-b");
    assert.equal(second.selection.generation, 2);
    assert.equal(second.selection.release.revision, b.revision);

    // --- The in-flight A process continues its own pre-boundary consumer.
    relayed.release();
    const continued = await pause;
    assert.equal(continued.code, 0, continued.stderr);
    const outcome = JSON.parse(continued.stdout.trim().split("\n").at(-1)!);
    assert.equal(outcome.developmentIntent?.state, "complete");
    const afterContinuation = relayed.requests.filter(entry => entry.method === "POST" && entry.path.startsWith(`/api/tasks/${taskId}/development-`));
    assert(afterContinuation.length >= 2 && afterContinuation.every(entry => entry.operationHeader === null && entry.status === 200), JSON.stringify(afterContinuation));
    assert.equal(await server.db.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: sessionId, source: `development:${taskId}`, action: "development-compute-complete" } }), 1);
    assert.equal(await server.db.prisma.toolingOperation.count({ where: { taskId } }), 0, "The legacy continuation creates no B binding");
    const retained = await server.db.prisma.toolingLegacyConsumer.findUniqueOrThrow({ where: { id: consumer.id } });
    assert.equal(retained.revision, a.revision); assert.equal(retained.checkout, a.checkout);
    const legacyTask = await server.db.prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(legacyTask.toolingRevision, a.revision); assert.equal(legacyTask.pinnedToolingRoot, a.checkout); assert.equal(legacyTask.primarySessionId, sessionId);
    assert.deepEqual(await paused(), { [taskId]: true, [controlId]: true });
    steps.push({ action: "legacy-continuation-completed", relayed: afterContinuation, consumer: retained, task: { toolingRevision: legacyTask.toolingRevision, pinnedToolingRoot: legacyTask.pinnedToolingRoot }, ownerPaused: await paused() });

    // --- A NEW command from the stale A checkout is refused before effects.
    const stale = await cli(a.checkout, ["runtime", "status"], "dra31-stale-a-status", server.controlSocket);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /is bound to tooling release .*not this checkout/);
    const refused = await server.db.prisma.toolingOperation.findFirstOrThrow({ where: { taskId, requestKey: "dra31-stale-a-status" } });
    assert.equal(refused.status, "bound");
    assert.equal(refused.releaseId, second.selection.release.id);
    assert.equal(await server.db.prisma.toolingStateWrite.count({ where: { operationId: refused.id } }), 0);

    // --- Owner launch after B: the new task is pinned to B.
    const launched = await server.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({ requestKey: "dra31-adopted", repositoryId: "fixture", branchName: "dra31-adopted", prompt: "Synthetic adoption check; do no work.", provider: "codex" }) });
    const launchedBody = await launched.json() as Record<string, any>;
    const adopted = await server.db.prisma.remoteTask.findFirst({ where: { requestKey: "dra31-adopted" } });
    steps.push({ action: "owner-launch", status: launched.status, body: launchedBody, task: adopted });
    assert.equal(launched.status, 201, JSON.stringify(launchedBody));
    assert(adopted?.primarySessionId);
    assert.equal(adopted.toolingRevision, b.revision);
    assert.equal(adopted.pinnedToolingRoot, b.checkout);
    const until = Date.now() + 60_000;
    let prompts: Array<{ event: string; text?: string; cwd: string }> = [];
    while (Date.now() < until) {
      prompts = existsSync(providerLog) ? (await readFile(providerLog, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.event === "session/prompt") : [];
      if (prompts.length) break;
      await Bun.sleep(200);
    }
    assert.equal(prompts.length, 1, "The synthetic provider must receive exactly the launch prompt");
    const prompt = prompts[0]!.text ?? "";
    assert(prompt.includes(b.checkout), "The launch prompt must use B's prepared checkout");
    assert(!prompt.includes(a.checkout), "The launch prompt must not use A's checkout");
    steps.push({ action: "launch-prompt", promptDigest: sha256(prompt), length: prompt.length, cwd: prompts[0]!.cwd, includesB: true, includesA: false });
    assert.equal(server.pid, pid, "No restart occurred during this rehearsal");
    assert.deepEqual(await paused(), { [taskId]: true, [controlId]: true });
    passed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    evidence.passed = passed;
    evidence.limitations = [
      "Source-message turn adoption is not exercised: its only normal producer is the Linear comment webhook (integrations/linear/webhooks/comment/handler.ts) and inbox dispatch calls tracker.sourceMessages.validateOwner against Linear (services/sessions/inbox.ts sourceAuthorityAllows); no credential-free supported seam exists.",
      "The legacy continuation's development intent selects no compute resources, so no observer process ran under A's code; admission evidence is the inventory row, the headerless 200 callbacks with B active, and zero created operations.",
      "Synthetic ACP provider and identity-only task/session rows; no physical runtime, provider or app acceptance.",
    ];
    relayed?.stop();
    try {
      await server.stop();
      evidence.endProvenance = await provenance();
      evidence.relay = relayed?.requests ?? [];
      evidence.selection = await server.db.prisma.toolingSelection.findMany();
      evidence.activations = await server.db.prisma.toolingActivation.findMany();
      evidence.legacyBoundaries = await server.db.prisma.toolingLegacyBoundary.findMany();
      evidence.legacyConsumers = await server.db.prisma.toolingLegacyConsumer.findMany();
      evidence.operations = await server.db.prisma.toolingOperation.findMany();
      evidence.capabilityReceipts = await server.db.prisma.runtimeMetadataEvent.findMany({ where: { action: "tooling-capability" } });
      evidence.developmentEvents = await server.db.prisma.runtimeMetadataEvent.findMany({ where: { source: `development:${taskId}` } });
      evidence.tasks = await server.db.prisma.remoteTask.findMany({ select: { id: true, requestKey: true, primarySessionId: true, toolingRevision: true, pinnedToolingRoot: true, ownerPaused: true, phase: true } });
      await writeFile(resultFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    } finally { await server.cleanup({ keepEvidence: true }); }
    console.log(JSON.stringify({ passed, evidence: resultFile }));
  }
}

if (import.meta.main) {
  const receipts = process.env.DRA31_PREPARED_RELEASES;
  if (!receipts) throw new Error("Set DRA31_PREPARED_RELEASES to the two real frozen-install receipts in a disposable temporary directory");
  await rehearseLegacyTurn(receipts);
}
