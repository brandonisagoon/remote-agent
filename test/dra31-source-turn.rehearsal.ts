/**
 * DRA-31 source-message turn adoption rehearsal.
 *
 * EXPLICIT, never part of the default `bun test` gate:
 *   env -u REMOTE_AGENT_CONFIG DRA31_PREPARED_RELEASES=/private/tmp/<dir>/prepared.json \
 *     bun test/dra31-source-turn.rehearsal.ts
 *
 * Real isolated server (private migrated SQLite, loopback TCP, control
 * socket) started with the test-only preload test/dra31-linear-preload.ts,
 * which answers an explicit set of Linear GraphQL operations from scripted
 * private state and refuses everything else (no real network, synthetic
 * credential). Frozen prepared Drafted releases A and B; Drafted's committed
 * team policy supplies the workflows; the synthetic ACP provider
 * test/dra31-legacy-turn-helper.ts is reused unchanged behind the
 * model-advertising shim test/dra31-source-turn-helper.ts (the committed
 * `implement` workflow pins a model; acpx requires it to be advertised).
 *
 * Flow, all through normal routes:
 * 1. Before any selection, a signed owner Reaction webhook (🚀) triggers the
 *    committed `implement` workflow: the normal worker launches the source
 *    task and its primary on the configured-host A pin; the provider gets A.
 * 2. Normal activation of A, then B, without restart.
 * 3. A signed owner Comment webhook on the same issue is routed to that
 *    original primary, queued as a source instruction and dispatched: the
 *    turn is journaled with release B (generation 2) and the provider prompt
 *    names B's checkout, while the task's A pin is unchanged.
 * The owner-paused control task (identity seed, paused through the owner
 * route) stays paused. Seeded rows: that identity only.
 *
 * Not covered: an owner-authorized retry (the retry route needs an `unknown`
 * instruction, i.e. an interrupted dispatch; the reused provider completes
 * turns immediately), real Linear behaviour, provider/product work.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
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
const now = () => new Date().toISOString();
const PRELOAD = path.join(import.meta.dir, "dra31-linear-preload.ts");
const PROVIDER = path.join(import.meta.dir, "dra31-legacy-turn-helper.ts");
const MODEL_SHIM = path.join(import.meta.dir, "dra31-source-turn-helper.ts");

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { env: cleanEnv(root), stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return out;
}
const readJsonl = async (file: string) => existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

export async function rehearseSourceTurn(receiptFile: string) {
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
    runnerDigest: sha256(await readFile(import.meta.path)), preloadDigest: sha256(await readFile(PRELOAD)), providerDigest: sha256(await readFile(PROVIDER)), modelShimDigest: sha256(await readFile(MODEL_SHIM)),
    helperDigest: sha256(await readFile(path.join(repositoryRoot, "test-support/isolated-server.ts"))) });
  const server = await isolatedServer({ preload: PRELOAD });
  const controlId = "dra31-control";
  const owner = "owner-user-dra31", agent = "agent-user-dra31", credential = `synthetic-not-a-credential-${crypto.randomUUID()}`;
  const webhookSlug = "wh-dra31", secret = crypto.randomUUID(), connectionId = "lin-dra31";
  const issue = { id: crypto.randomUUID(), identifier: "FIX-1", title: "Synthetic source turn rehearsal", description: "Synthetic issue for DRA-31; do no product work.",
    branchName: "fix-1-synthetic-source-turn-rehearsal", createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString(),
    state: { id: "state-todo", name: "Todo", type: "unstarted" }, team: { id: "team-fix", key: "FIX" } };
  const linearState = { credential, organizationId: "org-dra31", agentUserId: agent, issues: [issue], comments: [] as unknown[] };
  const statePath = path.join(server.root, "linear-state.json"), providerLog = path.join(server.root, "provider.jsonl");
  const evidence: Record<string, unknown> = { scope: "real isolated server + test-only synthetic Linear GraphQL preload + frozen Drafted A/B releases + committed team policy; synthetic ACP provider; no real Linear, provider or product work",
    serverRoot: server.root, releases: [a, b], sourceProvenance: await provenance(), steps: [] };
  const steps = evidence.steps as unknown[];
  const resultFile = path.join(server.root, "source-turn.json");
  let passed = false;
  const call = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null });
  const json = async (response: Response, status = 200) => { const result = await call(response); assert.equal(result.status, status, JSON.stringify(result.body)); return result.body!; };
  const paused = async () => Object.fromEntries((await server.db.prisma.remoteTask.findMany({ orderBy: { requestKey: "asc" } })).map(task => [task.requestKey, task.ownerPaused]));
  const webhook = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ ...payload, webhookTimestamp: Date.now(), organizationId: linearState.organizationId });
    const deliveryId = crypto.randomUUID();
    const response = await fetch(`${server.url}/webhooks/${webhookSlug}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", "linear-delivery": deliveryId, "linear-signature": createHmac("sha256", secret).update(body).digest("hex") }, body });
    const result = { deliveryId, ...(await call(response)) };
    steps.push({ action: `webhook ${payload.type}`, ...result });
    return result;
  };
  const until = async <T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 120_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await Bun.sleep(250); }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const prompts = async () => (await readJsonl(providerLog)).filter(entry => entry.event === "session/prompt");
  const activate = async (revision: string, expectedGeneration: number, requestKey: string) => {
    const beforePid = server.pid;
    const receipt = await json(await server.request("/api/tooling-releases/fixture/activations", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, expectedGeneration, requestKey }), signal: AbortSignal.timeout(120_000) }));
    steps.push({ action: "activation", revision, expectedGeneration, requestKey, beforePid, afterPid: server.pid, completedAt: now(), ownerPaused: await paused(), receipt });
    assert.equal(server.pid, beforePid, "Activation must not restart the isolated server");
    return receipt;
  };
  try {
    // --- Isolated configuration: tooling A, frozen install, synthetic provider and Linear connection.
    const config = parseServiceFile(JSON.parse(await readFile(server.configFile, "utf8")));
    config.repositories.fixture!.tooling = { root: source, ref: a.revision };
    config.machine.installation.root = install;
    // The unchanged synthetic provider behind a shim that advertises exactly
    // the model Drafted's committed `implement` workflow pins.
    const committedModel = "gpt-6-astra";
    const provider = [process.execPath, "--no-env-file", MODEL_SHIM, providerLog, committedModel];
    config.providers.codex = { ...config.providers.codex, command: provider };
    config.providers.claude = { ...config.providers.claude, command: provider };
    (config as { connections: Record<string, unknown> }).connections = { [connectionId]: { provider: "linear", name: "Synthetic DRA-31", apiKey: credential, agentUserId: agent,
      workspace: "dra31-synthetic", repositories: { fixture: { when: [{ "linear.userId": [owner] }] } }, webhook: { slug: webhookSlug, secret } } };
    await writeFile(server.configFile, JSON.stringify(parseServiceFile(JSON.parse(JSON.stringify(config)))), { mode: 0o600 });
    await writeFile(statePath, JSON.stringify(linearState), { mode: 0o600 });
    const worktree = config.repositories.fixture!.root;
    await git(worktree, "init", "--quiet", "-b", "main");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic product identity");
    // Drafted's committed policy bases new tasks on origin/staging (local bare remote, no network).
    const origin = path.join(server.root, "origin.git");
    await git(server.root, "init", "--quiet", "--bare", origin);
    await git(worktree, "remote", "add", "origin", origin);
    await git(worktree, "push", "--quiet", "origin", "main:staging");
    // --- Identity-only seed: the control task (paused below through the owner route).
    await server.db.prisma.remoteTask.create({ data: { id: controlId, requestKey: controlId, repositoryId: "fixture", machineId: "isolated-workflow",
      branchName: "control", toolingRoot: source, toolingRevision: a.revision, phase: "working" } });
    await server.start();
    const pid = server.pid;
    assert.equal((await json(await server.request("/api/tooling-releases/fixture"))).selection, null);
    const loaded = (await readJsonl(path.join(server.root, "linear-requests.jsonl"))).filter(entry => entry.outcome === "loaded");
    assert.equal(loaded.length, 1, "The synthetic Linear preload is loaded exactly once in the server process");
    assert.equal(loaded[0].pid, pid);
    const control = await json(await server.request(`/api/tasks/${controlId}/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) }));
    steps.push({ action: "owner-pause-control", ownerPaused: control.task?.ownerPaused ?? null });

    // --- 1. Pre-boundary owner reaction launches the source task through the committed workflow.
    const reaction = await webhook({ type: "Reaction", action: "create", data: { id: crypto.randomUUID(), createdAt: now(), emoji: "rocket", userId: owner,
      issueId: issue.id, issue: { id: issue.id, identifier: issue.identifier, title: issue.title } } });
    assert((reaction.status === 200 || reaction.status === 202) && reaction.body?.accepted === true, JSON.stringify(reaction));
    const task = await until("the source task and its primary", async () => {
      const found = await server.db.prisma.remoteTask.findFirst({ where: { issueIdentifier: issue.identifier, connectionId } });
      return found?.primarySessionId ? found : null;
    });
    const primary = task.primarySessionId!;
    await until("the launch prompt", async () => (await prompts()).length >= 1);
    const launchPrompt = (await prompts())[0]!;
    assert.equal(task.toolingRevision, a.revision);
    assert.equal(task.pinnedToolingRoot, a.checkout);
    assert(launchPrompt.text.includes(a.checkout) && !launchPrompt.text.includes(b.checkout), "The pre-boundary launch uses A");
    await until("the primary to become idle after its launch turn", async () => (await server.db.prisma.runtimeSession.findUnique({ where: { id: primary } }))?.status === "idle");
    steps.push({ action: "pre-boundary-launch", task: { id: task.id, requestKey: task.requestKey, primarySessionId: primary, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, worktreePath: task.worktreePath },
      promptDigest: sha256(launchPrompt.text), workerRuns: await server.db.prisma.workerRun.findMany() });

    // --- 2. Normal activation A, then B.
    const first = await activate(a.revision, 0, "dra31-source-activate-a");
    assert.equal(first.selection.generation, 1);
    steps.push({ action: "first-bootstrap-inventory", consumers: await server.db.prisma.toolingLegacyConsumer.findMany() });
    const second = await activate(b.revision, 1, "dra31-source-activate-b");
    assert.equal(second.selection.generation, 2);
    assert.equal(second.selection.release.revision, b.revision);

    // --- 3. Signed owner comment on the same issue reaches the original primary.
    const commentAt = now();
    const comment = { id: crypto.randomUUID(), issueId: issue.id, body: "Synthetic owner follow-up for DRA-31; reply only, do no product work.", parentId: null, userId: owner, createdAt: commentAt, updatedAt: commentAt };
    linearState.comments.push(comment);
    await writeFile(statePath, JSON.stringify(linearState), { mode: 0o600 });
    const delivered = await webhook({ type: "Comment", action: "create", data: { id: comment.id, body: comment.body, createdAt: commentAt, updatedAt: commentAt,
      issueId: issue.id, userId: owner, issue: { id: issue.id, identifier: issue.identifier, title: issue.title } } });
    assert((delivered.status === 200 || delivered.status === 202) && delivered.body?.accepted === true, JSON.stringify(delivered));
    const instruction = await until("the source instruction", async () => server.db.prisma.runtimeInstruction.findFirst({ where: { sessionId: primary, sourceMessageId: { not: null } } }));
    await until("the source-turn prompt", async () => (await prompts()).length >= 2);
    const turnPrompt = (await prompts())[1]!;
    const journal = await until("the tooling-turn journal", async () => server.db.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: primary, source: "tooling-turn", action: "instruction" } }));
    const recorded = JSON.parse(journal.value ?? "null");
    assert.deepEqual({ instructionId: recorded.instructionId, sourceMessageId: recorded.sourceMessageId, taskId: recorded.taskId, releaseId: recorded.releaseId, revision: recorded.revision, generation: recorded.generation },
      { instructionId: instruction.id, sourceMessageId: instruction.sourceMessageId, taskId: task.id, releaseId: second.selection.release.id, revision: b.revision, generation: 2 });
    assert.equal(recorded.text, turnPrompt.text.slice(0, recorded.text.length), "The provider received the journaled turn text");
    assert(turnPrompt.text.includes(`Tooling release for this independent turn: ${b.revision}, generation 2, checkout ${b.checkout}.`));
    assert(turnPrompt.text.includes(b.checkout) && !turnPrompt.text.includes(a.checkout), "The source turn uses B, not A's checkout");
    assert(turnPrompt.text.includes(comment.body));
    const after = await server.db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.deepEqual({ toolingRevision: after.toolingRevision, pinnedToolingRoot: after.pinnedToolingRoot, primarySessionId: after.primarySessionId, worktreePath: after.worktreePath },
      { toolingRevision: a.revision, pinnedToolingRoot: a.checkout, primarySessionId: primary, worktreePath: task.worktreePath }, "No repin: the original task identity is unchanged");
    await until("the source instruction to settle", async () => !["queued", "preparing", "dispatching"].includes((await server.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } })).state));
    steps.push({ action: "source-turn-adopted-b", instruction: await server.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: instruction.id } }), journalKey: journal.key,
      recorded: { ...recorded, text: undefined, textDigest: sha256(recorded.text) }, promptDigest: sha256(turnPrompt.text) });
    assert.equal(server.pid, pid, "No restart occurred during this rehearsal");
    assert.deepEqual((await paused())[controlId], true);

    // --- Terminal point: the server's normal stop closes the provider; count prompts then.
    await server.stop();
    const entries = await until("provider stdin to close", async () => { const all = await readJsonl(providerLog); return all.some(entry => entry.event === "stdin-closed") ? all : null; }, 15_000);
    assert(entries.some(entry => entry.event === "shim-models-advertised"), "The shim advertised the committed model");
    const spawns = entries.filter(entry => entry.event === "spawn");
    assert(spawns.length >= 1 && spawns.every(entry => entry.sessionEnv === primary), `Every provider process belongs to the original primary: ${JSON.stringify(spawns)}`);
    assert.equal(entries.filter(entry => entry.event === "session/prompt").length, 2, "Exactly the launch prompt and the source-turn prompt");
    steps.push({ action: "provider-terminal", events: entries.map(entry => ({ pid: entry.pid, event: entry.event, at: entry.at, sessionEnv: entry.sessionEnv })) });
    const linearRequests = await readJsonl(path.join(server.root, "linear-requests.jsonl"));
    assert(!linearRequests.some(entry => entry.outcome === "refused" && entry.reason !== "unknown operation"), "No OAuth/non-GraphQL Linear request was attempted");
    const end = await provenance();
    assert.deepEqual(end, evidence.sourceProvenance, "Source provenance changed during the rehearsal");
    passed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    evidence.passed = passed;
    evidence.limitations = [
      "Linear is synthetic: a test-only preload answers an explicit GraphQL operation set from scripted private state; real Linear behaviour, OAuth and network delivery are not exercised.",
      "No owner-authorized retry: resolveTaskInstruction retries only an `unknown` instruction (services/sessions/inbox.ts), which needs an interrupted dispatch; the reused synthetic provider completes turns immediately.",
      "Synthetic ACP provider: prompt delivery only; no provider, product or preparation work is claimed.",
    ];
    try {
      await server.stop();
      evidence.endProvenance = await provenance().catch(error => ({ error: String(error) }));
      evidence.linearRequests = await readJsonl(path.join(server.root, "linear-requests.jsonl"));
      evidence.linearCreated = await readJsonl(path.join(server.root, "linear-created.jsonl"));
      const prisma = server.db.prisma;
      evidence.webhookReceipts = await prisma.webhookReceipt.findMany();
      evidence.workerRuns = await prisma.workerRun.findMany();
      evidence.sourceMessages = await prisma.runtimeSourceMessage.findMany();
      evidence.instructions = await prisma.runtimeInstruction.findMany();
      evidence.lifecycleEvents = await prisma.runtimeLifecycleEvent.findMany({ orderBy: { sequence: "asc" } });
      evidence.toolingTurnJournal = await prisma.runtimeMetadataEvent.findMany({ where: { source: "tooling-turn" } });
      evidence.resourceLinks = await prisma.runtimeSessionResourceLink.findMany();
      evidence.selection = await prisma.toolingSelection.findMany();
      evidence.activations = await prisma.toolingActivation.findMany();
      evidence.legacyBoundaries = await prisma.toolingLegacyBoundary.findMany();
      evidence.legacyConsumers = await prisma.toolingLegacyConsumer.findMany();
      evidence.operations = await prisma.toolingOperation.findMany();
      evidence.leftovers = {
        tasks: await prisma.remoteTask.findMany({ select: { id: true, requestKey: true, issueIdentifier: true, connectionId: true, primarySessionId: true, worktreePath: true, branchName: true, toolingRevision: true, pinnedToolingRoot: true, ownerPaused: true, phase: true } }),
        sessions: await prisma.runtimeSession.findMany({ select: { id: true, role: true, status: true, cwd: true, agentCommand: true, closedAt: true } }),
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
  await rehearseSourceTurn(receipts);
}
