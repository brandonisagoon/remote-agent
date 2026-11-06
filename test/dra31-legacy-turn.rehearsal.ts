/**
 * DRA-31 legacy-consumer and new-task adoption rehearsal.
 *
 * EXPLICIT, never part of the default `bun test` gate. Real isolated server
 * (private migrated SQLite, loopback TCP, control socket), the real frozen
 * prepared Drafted releases A and B, and Drafted A's and B's own committed CLIs:
 *   env -u REMOTE_AGENT_CONFIG DRA31_PREPARED_RELEASES=/private/tmp/<dir>/prepared.json \
 *     bun test/dra31-legacy-turn.rehearsal.ts
 *
 * What it exercises, through normal supported routes only:
 * 1. Before any release-aware selection the task primary resolves its runtime
 *    capability (configured-host A receipt) and Drafted A's `upkeep pause`
 *    records an owner development intent. That A process is still in flight
 *    (its next callback waits in a socket relay), so the intent is a genuine
 *    live pre-boundary consumer.
 * 2. Normal first activation of A inventories exactly that consumer with the
 *    resolved A capability receipt; B then activates without restart.
 * 3. The in-flight A process completes its own intent headerless after B is
 *    active; the server admits it only as that consumer's legacy
 *    continuation. No operation is created; A's pin and owner pauses stay.
 * 4. Terminal-consumer probe: the completed legacy intent is still admitted
 *    headerless until lazily resolved (recorded, see `findings`).
 * 5. A new command from the stale A checkout is refused before effects; the
 *    same request key then runs and settles with Drafted B's CLI.
 * 6. The finished legacy consumer is resolved through the normal operation
 *    state route on a live development-intent operation (the paused task
 *    withholds state receipts from command operations); afterwards the same
 *    headerless legacy call is refused.
 * 7. An owner task launch after B is pinned to B; the synthetic ACP provider
 *    session is the new primary and receives B's checkout. A headerless
 *    continuation of that post-boundary task's own intent is refused.
 *
 * Seeded rows are identity only: one task/primary session and one unpaused
 * control task. Selection, consumers, operations, capability receipts,
 * intents, pauses and deliveries are produced by the server's routes.
 * Not covered: source-message turns (credentialed Linear producer), physical
 * runtime/provider/app acceptance, or a fully prepared product launch.
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
// Explicit child environment: no inherited REMOTE_AGENT_* or provider secrets.
const cleanEnv = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", HOME: home });
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { env: cleanEnv(root), stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return out;
}

/** Unix-socket relay between a Drafted CLI and the server's control socket.
 * Method, path, query, body bytes and every request header except Host are
 * forwarded unchanged (fetch sets Host to the relay's own `relay` name); the
 * response status, headers and body bytes are returned unchanged. Its only
 * other effect: while armed, the first request matching the predicate waits
 * until released — a process whose next callback arrives later. */
function relay(listen: string, target: string) {
  type Entry = { arrivedAt: string; forwardedAt?: string; completedAt?: string; method: string; path: string; operationHeader: string | null; held: boolean; status?: number };
  const requests: Entry[] = [];
  let hold: { match: (method: string, pathname: string) => boolean; opened: boolean; gate: Promise<void>; open: () => void; signal: () => void } | null = null;
  const server = Bun.serve({ unix: listen, async fetch(request) {
    const url = new URL(request.url);
    const entry: Entry = { arrivedAt: now(), method: request.method, path: url.pathname + url.search, operationHeader: request.headers.get("x-remote-agent-operation"), held: false };
    requests.push(entry);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const current = hold;
    if (current && !current.opened && current.match(request.method, url.pathname)) { entry.held = true; current.signal(); await current.gate; }
    const headers = new Headers(request.headers); headers.delete("host");
    entry.forwardedAt = now();
    const response = await fetch(`http://relay${url.pathname}${url.search}`, { method: request.method, headers, body, unix: target, redirect: "manual" });
    entry.status = response.status;
    const bytes = await response.arrayBuffer();
    entry.completedAt = now();
    return new Response(bytes, { status: response.status, headers: response.headers });
  } });
  return { requests, stop: () => server.stop(true),
    arm(match: (method: string, pathname: string) => boolean) {
      let open!: () => void, signal!: () => void;
      const gate = new Promise<void>(resolve => { open = resolve; });
      const seen = new Promise<void>(resolve => { signal = resolve; });
      const armed = { match, opened: false, gate, open, signal };
      hold = armed;
      return { seen, release: () => { armed.opened = true; armed.open(); } };
    } };
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
  const evidence: Record<string, unknown> = { scope: "real isolated server + frozen Drafted A/B releases + Drafted A/B CLIs; synthetic ACP provider; no physical provider/app/Linear acceptance and no fully prepared product launch",
    serverRoot: server.root, releases: [a, b], sourceProvenance: await provenance(), steps: [], findings: [] };
  const steps = evidence.steps as unknown[], findings = evidence.findings as unknown[];
  const resultFile = path.join(server.root, "legacy-turn.json");
  let passed = false, relayed: ReturnType<typeof relay> | undefined;
  const call = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, any> });
  const json = async (response: Response, status = 200) => {
    const { status: actual, body } = await call(response);
    assert.equal(actual, status, JSON.stringify(body));
    return body;
  };
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => server.socketRequest(route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const paused = async () => Object.fromEntries((await server.db.prisma.remoteTask.findMany({ orderBy: { id: "asc" } })).map(task => [task.requestKey, task.ownerPaused]));
  const developmentEvents = () => server.db.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: sessionId, source: `development:${taskId}` } });
  const activate = async (revision: string, expectedGeneration: number, requestKey: string) => {
    const beforePid = server.pid;
    const receipt = await json(await server.request("/api/tooling-releases/fixture/activations", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, expectedGeneration, requestKey }), signal: AbortSignal.timeout(120_000) }));
    const completedAt = now();
    steps.push({ action: "activation", revision, expectedGeneration, requestKey, beforePid, afterPid: server.pid, completedAt, ownerPaused: await paused(), receipt });
    assert.equal(server.pid, beforePid, "Activation must not restart the isolated server");
    return { receipt, completedAt };
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
  const developmentPosts = (from: number) => relayed!.requests.slice(from).filter(entry => entry.method === "POST" && entry.path.startsWith(`/api/tasks/${taskId}/development-`));
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

    // --- 1. Pre-boundary: owner pauses the control task; primary resolves runtime capability A.
    const control = await json(await server.request(`/api/tasks/${controlId}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) }));
    steps.push({ action: "owner-pause-control", ownerPaused: control.task?.ownerPaused ?? null });
    const capability = await json(await post(`/api/sessions/${sessionId}/tooling-capability`, { capability: "runtime" }));
    steps.push({ action: "runtime-capability", receipt: capability.receipt });
    assert.equal(capability.receipt.capabilityRevision, a.revision);
    assert.equal(capability.receipt.checkout, a.checkout);
    assert.equal(capability.receipt.source, "configured-host");

    relayed = relay(relaySocket, server.controlSocket);
    const firstHold = relayed.arm((method, pathname) => method === "POST" && pathname === `/api/tasks/${taskId}/development-authority`);
    const pause = cli(a.checkout, ["upkeep", "pause", "--request-key", "dra31-owner-pause"], "dra31-legacy-pause", relaySocket);
    await Promise.race([firstHold.seen, pause.then(result => { throw new Error(`A exited before its continuation was held: ${JSON.stringify(result)}`); })]);
    const intent = await server.db.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { runtimeSessionId: sessionId, source: `development:${taskId}`, action: "development-compute-intent" } });
    assert.equal(await server.db.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: sessionId, source: `development:${taskId}`, action: "development-compute-complete" } }), 0);
    assert.equal(await server.db.prisma.toolingOperation.count(), 0, "No release-aware operation exists before the boundary");
    steps.push({ action: "pre-boundary-consumer-live", intentSequence: intent.sequence, intent: JSON.parse(intent.value ?? "null"), ownerPaused: await paused() });

    // --- 2. Normal activation A inventories exactly that consumer; then B.
    const first = await activate(a.revision, 0, "dra31-legacy-activate-a");
    assert.equal(first.receipt.selection.generation, 1);
    const consumers = await server.db.prisma.toolingLegacyConsumer.findMany();
    steps.push({ action: "first-bootstrap-inventory", consumers });
    assert.equal(consumers.length, 1, `Exactly one live legacy consumer is expected: ${JSON.stringify(consumers)}`);
    const consumer = consumers[0]!;
    assert.deepEqual({ kind: consumer.consumerKind, id: consumer.consumerId, taskId: consumer.taskId, provenance: consumer.provenance, revision: consumer.revision, checkout: consumer.checkout, status: consumer.status },
      { kind: "development-intent", id: String(intent.sequence), taskId, provenance: "exact", revision: a.revision, checkout: a.checkout, status: "retained" });
    assert.deepEqual(consumer.receipt, capability.receipt, "The inventoried executable is exactly the resolved capability receipt");
    const second = await activate(b.revision, 1, "dra31-legacy-activate-b");
    assert.equal(second.receipt.selection.generation, 2);
    assert.equal(second.receipt.selection.release.revision, b.revision);

    // --- 3. The in-flight A process continues its own pre-boundary consumer.
    firstHold.release();
    const continued = await pause;
    assert.equal(continued.code, 0, continued.stderr);
    const outcome = JSON.parse(continued.stdout.trim().split("\n").at(-1)!);
    assert.equal(outcome.developmentIntent?.state, "complete");
    const legacyCalls = developmentPosts(0);
    assert.deepEqual(legacyCalls.map(entry => entry.path.split("/").at(-1)), ["development-authority", "development-authority", "development-complete"]);
    assert(legacyCalls.every(entry => entry.operationHeader === null && entry.status === 200), JSON.stringify(legacyCalls));
    assert(legacyCalls[0]!.held && Date.parse(legacyCalls[0]!.forwardedAt!) >= Date.parse(second.completedAt), "The held callback reached the server only after B was active");
    assert.equal(await server.db.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: sessionId, source: `development:${taskId}`, action: "development-compute-complete" } }), 1);
    assert.equal(await server.db.prisma.toolingOperation.count({ where: { taskId } }), 0, "The legacy continuation creates no B binding");
    const legacyTask = await server.db.prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(legacyTask.toolingRevision, a.revision); assert.equal(legacyTask.pinnedToolingRoot, a.checkout); assert.equal(legacyTask.primarySessionId, sessionId);
    assert.deepEqual(await paused(), { [taskId]: true, [controlId]: true });
    steps.push({ action: "legacy-continuation-completed", relayed: legacyCalls, bActivatedAt: second.completedAt, ownerPaused: await paused() });

    // --- 4. Terminal-consumer probe (recorded): the completed legacy intent
    // is still admitted headerless until lazily resolved.
    const reference = { intentRevision: outcome.developmentIntent.revision as number, intentDigest: outcome.developmentIntent.digest as string };
    const eventsBefore = await developmentEvents();
    const terminal = await call(await post(`/api/tasks/${taskId}/development-authority`, { ...reference, resourceKeys: [] }));
    const eventsAfter = await developmentEvents();
    assert.equal(eventsAfter, eventsBefore, "A terminal renewal writes no development event");
    assert.equal(await server.db.prisma.toolingOperation.count({ where: { taskId } }), 0);
    findings.push({ finding: "terminal-legacy-callback-admitted-until-lazy-resolution", consumerStatus: (await server.db.prisma.toolingLegacyConsumer.findUniqueOrThrow({ where: { id: consumer.id } })).status,
      status: terminal.status, body: terminal.body, developmentEventsUnchanged: true });

    // --- 5. A NEW stale-A command is refused before effects; B settles that key.
    const stale = await cli(a.checkout, ["runtime", "status"], "dra31-stale-a-status", server.controlSocket);
    assert.notEqual(stale.code, 0);
    assert.match(stale.stderr, /is bound to tooling release .*not this checkout/);
    const refused = await server.db.prisma.toolingOperation.findFirstOrThrow({ where: { taskId, requestKey: "dra31-stale-a-status" } });
    assert.equal(refused.status, "bound");
    assert.equal(refused.releaseId, second.receipt.selection.release.id);
    assert.equal(await server.db.prisma.toolingStateWrite.count({ where: { operationId: refused.id } }), 0);
    // A command operation receives no state receipt while its task is owner-paused.
    const pausedState = await call(await server.socketRequest(`/api/sessions/${sessionId}/tooling-operations/${refused.id}/state?family=drafted.runtime&scopeKey=task`, { headers: { "x-remote-agent-operation": refused.id } }));
    steps.push({ action: "state-route-paused-command", operationId: refused.id, ...pausedState });
    assert.equal(pausedState.status, 409);
    assert.match(String(pausedState.body.error), /paused/);
    assert.equal((await server.db.prisma.toolingLegacyConsumer.findUniqueOrThrow({ where: { id: consumer.id } })).status, "retained", "A refused state request resolves nothing");
    const settledByB = await cli(b.checkout, ["runtime", "status"], "dra31-stale-a-status", server.controlSocket);
    const settled = await server.db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: refused.id } });
    steps.push({ action: "stale-key-settled-by-b", operation: settled });
    assert.equal(settled.releaseId, second.receipt.selection.release.id);
    // Recorded rather than assumed: whether a paused task's B command settles.
    if (settledByB.code !== 0 || settled.status !== "completed") findings.push({ finding: "paused-task-command-did-not-settle", code: settledByB.code, stderr: settledByB.stderr.slice(0, 2000), status: settled.status });

    // --- 6. Finished-consumer resolution through the normal state route on a
    // live development-intent operation (exempt from the pause withholding):
    // Drafted B's `upkeep pause` records a new owner-pause intent (the pause is
    // kept) and its bound completion waits in the relay meanwhile.
    const before = relayed.requests.length;
    const secondHold = relayed.arm((method, pathname) => method === "POST" && pathname === `/api/tasks/${taskId}/development-complete`);
    const pauseB = cli(b.checkout, ["upkeep", "pause", "--request-key", "dra31-owner-pause-b"], "dra31-pause-b", relaySocket);
    await Promise.race([secondHold.seen, pauseB.then(result => { throw new Error(`B exited before its completion was held: ${JSON.stringify(result)}`); })]);
    const child = await server.db.prisma.toolingOperation.findFirstOrThrow({ where: { taskId, kind: "development-intent", status: { in: ["bound", "running", "unknown"] } } });
    const resolving = await call(await server.socketRequest(`/api/sessions/${sessionId}/tooling-operations/${child.id}/state?family=drafted.runtime&scopeKey=task`, { headers: { "x-remote-agent-operation": child.id } }));
    const resolved = await server.db.prisma.toolingLegacyConsumer.findUniqueOrThrow({ where: { id: consumer.id } });
    steps.push({ action: "state-route-resolves-finished-consumer", operationId: child.id, operationKind: child.kind, ...resolving, consumer: resolved });
    assert.equal(resolved.status, "resolved");
    assert.deepEqual(resolved.resolution, { kind: "development-intent-finished", reference: String(intent.sequence) });
    assert(resolved.resolvedAt);
    if (resolving.status !== 200) findings.push({ finding: "state-evidence-not-issued-after-resolution", ...resolving });
    secondHold.release();
    const completedB = await pauseB;
    assert.equal(completedB.code, 0, completedB.stderr);
    const bCalls = developmentPosts(before);
    assert.deepEqual(bCalls.map(entry => entry.path.split("/").at(-1)), ["development-authority", "development-authority", "development-complete"]);
    assert(bCalls.every(entry => entry.operationHeader !== null && entry.status === 200), JSON.stringify(bCalls));
    const bOperations = await server.db.prisma.toolingOperation.findMany({ where: { taskId, requestKey: { not: "dra31-stale-a-status" } } });
    assert(bOperations.length >= 2 && bOperations.every(row => row.status === "completed" && row.releaseId === second.receipt.selection.release.id), JSON.stringify(bOperations));
    steps.push({ action: "b-development-intent-settled", relayed: bCalls, operations: bOperations });
    // After resolution the same headerless legacy call is refused.
    const after = await call(await post(`/api/tasks/${taskId}/development-authority`, { ...reference, resourceKeys: [] }));
    steps.push({ action: "resolved-legacy-call-refused", ...after });
    assert.equal(after.status, 428); // operation-required maps to 428 Precondition Required
    assert.equal(after.body.code, "operation-required");

    // --- 7. Owner launch after B: the new task is pinned to B.
    const launched = await call(await server.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({ requestKey: "dra31-adopted", repositoryId: "fixture", branchName: "dra31-adopted", prompt: "Synthetic adoption check; do no work.", provider: "codex" }) }));
    const adopted = await server.db.prisma.remoteTask.findFirst({ where: { requestKey: "dra31-adopted" } });
    steps.push({ action: "owner-launch", ...launched, task: adopted });
    assert.equal(launched.status, 201, JSON.stringify(launched.body));
    assert(adopted?.primarySessionId);
    assert.equal(adopted.toolingRevision, b.revision);
    assert.equal(adopted.pinnedToolingRoot, b.checkout);
    // The launch prompt must be delivered before the owner pause below (an
    // earlier pause correctly preempts an undelivered launch prompt).
    const delivered = Date.now() + 60_000;
    while (Date.now() < delivered && !(existsSync(providerLog) && (await readFile(providerLog, "utf8")).includes('"event":"session/prompt"'))) await Bun.sleep(100);
    // The provider's process lifetime is acpx's choice (observed: closed after
    // the turn, or kept until server shutdown); prompts are counted at the
    // terminal point below, after the server's normal stop closes its stdin.
    // A post-boundary consumer was never inventoried: its headerless
    // continuation is refused (the owner pause recorded here is kept).
    const adoptedPause = await call(await server.request(`/api/tasks/${adopted.id}/automation`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause", development: true, requestKey: "dra31-adopted-pause" }) }));
    // 202: the owner pause is recorded while owned sessions settle.
    const pauseRecorded = adoptedPause.status === 200 || adoptedPause.status === 202;
    const adoptedTask = pauseRecorded ? adoptedPause.body.task : null;
    const adoptedIntent = adoptedTask?.developmentIntent;
    if (!adoptedIntent?.revision || !adoptedIntent?.digest) findings.push({ finding: "post-boundary-intent-unavailable-for-negative-control", pause: adoptedPause, task: adoptedTask && JSON.stringify(adoptedTask).slice(0, 2000) });
    // Without a genuine post-boundary intent, the negative control names a
    // revision that no consumer inventory or operation owns.
    const negative = adoptedIntent?.revision && adoptedIntent?.digest ? { intentRevision: adoptedIntent.revision, intentDigest: adoptedIntent.digest } : { intentRevision: 999_999, intentDigest: "0".repeat(64) };
    const unrecorded = await call(await post(`/api/tasks/${adopted.id}/development-authority`, { ...negative, resourceKeys: [] }));
    steps.push({ action: "uninventoried-headerless-refused", pause: adoptedPause.status, ownerPaused: adoptedPause.body.task?.ownerPaused ?? null, intent: negative, genuineIntent: Boolean(adoptedIntent?.revision), ...unrecorded });
    assert.equal(unrecorded.status, 428);
    assert.equal(unrecorded.body.code, "operation-required");
    assert.equal(await server.db.prisma.toolingLegacyConsumer.count(), 1, "Activation inventoried nothing after the boundary");

    assert.equal(server.pid, pid, "No restart occurred during this rehearsal");
    assert.deepEqual(await paused(), { [taskId]: true, [controlId]: true, "dra31-adopted": pauseRecorded });
    await server.stop();
    const until = Date.now() + 15_000;
    let entries: Array<{ pid: number; event: string; text?: string; cwd: string; sessionEnv?: string | null }> = [];
    while (Date.now() < until) {
      entries = existsSync(providerLog) ? (await readFile(providerLog, "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [];
      if (entries.some(entry => entry.event === "stdin-closed")) break;
      await Bun.sleep(200);
    }
    const spawns = entries.filter(entry => entry.event === "spawn");
    assert.equal(spawns.length, 1, JSON.stringify(spawns));
    assert.equal(spawns[0]!.sessionEnv, adopted.primarySessionId, "The provider process belongs to the adopted primary");
    assert(entries.every(entry => entry.pid === spawns[0]!.pid));
    assert.equal(entries.at(-1)?.event, "stdin-closed");
    const prompts = entries.filter(entry => entry.event === "session/prompt");
    assert.equal(prompts.length, 1, "The synthetic provider received exactly the launch prompt");
    const prompt = prompts[0]!.text ?? "";
    assert(prompt.includes(b.checkout), "The launch prompt uses B's prepared checkout");
    assert(!prompt.includes(a.checkout), "The launch prompt does not use A's checkout");
    assert.equal(prompts[0]!.cwd, adopted.worktreePath);
    steps.push({ action: "launch-prompt", providerPid: spawns[0]!.pid, providerSession: spawns[0]!.sessionEnv, events: entries.map(entry => ({ event: entry.event, at: (entry as { at?: string }).at })),
      promptDigest: sha256(prompt), length: prompt.length, cwd: prompts[0]!.cwd });
    const end = await provenance();
    assert.deepEqual(end, evidence.sourceProvenance, "Source provenance changed during the rehearsal");
    passed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    evidence.passed = passed;
    evidence.limitations = [
      "Source-message turn adoption is not exercised: its only normal producer is the Linear comment webhook (integrations/linear/webhooks/comment/handler.ts) and inbox dispatch calls tracker.sourceMessages.validateOwner (services/sessions/inbox.ts sourceAuthorityAllows).",
      "The legacy development intent selects no compute resources, so no server observer ran under A's code; A's own CLI performed the continuation.",
      "The new task's launch is prompt delivery only (phase stays preparing): no preparation, bootstrap or product readiness is claimed.",
      "Synthetic ACP provider and identity-only task/session rows; no physical runtime, provider or app acceptance.",
    ];
    relayed?.stop();
    try {
      await server.stop();
      evidence.endProvenance = await provenance().catch(error => ({ error: String(error) }));
      evidence.relay = relayed?.requests ?? [];
      evidence.selection = await server.db.prisma.toolingSelection.findMany();
      evidence.activations = await server.db.prisma.toolingActivation.findMany();
      evidence.legacyBoundaries = await server.db.prisma.toolingLegacyBoundary.findMany();
      evidence.legacyConsumers = await server.db.prisma.toolingLegacyConsumer.findMany();
      evidence.operations = await server.db.prisma.toolingOperation.findMany();
      evidence.capabilityReceipts = await server.db.prisma.runtimeMetadataEvent.findMany({ where: { action: "tooling-capability" } });
      evidence.developmentEvents = await server.db.prisma.runtimeMetadataEvent.findMany({ where: { source: { startsWith: "development:" } } });
      // Leftovers. The private database is removed by cleanup (its rows are
      // copied here); the server root, repo, bare origin, acpx state and the
      // adopted worktree are kept with this evidence.
      evidence.leftovers = {
        tasks: await server.db.prisma.remoteTask.findMany({ select: { id: true, requestKey: true, primarySessionId: true, worktreePath: true, branchName: true, toolingRevision: true, pinnedToolingRoot: true, ownerPaused: true, phase: true } }),
        sessions: await server.db.prisma.runtimeSession.findMany({ select: { id: true, role: true, status: true, cwd: true, agentCommand: true, closedAt: true } }),
        serverRoot: await readdir(server.root).catch(() => []),
        worktrees: existsSync(path.join(server.root, "repo")) ? await git(path.join(server.root, "repo"), "worktree", "list", "--porcelain").catch(error => String(error)) : null,
        branches: existsSync(path.join(server.root, "repo")) ? await git(path.join(server.root, "repo"), "branch", "-a").catch(error => String(error)) : null,
        databaseRemovedAfterEvidence: true,
      };
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
