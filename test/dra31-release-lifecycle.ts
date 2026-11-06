/** Explicit real-server/real-CLI rehearsal, not an automatically skipped gate.
 * Run with DRA31_PREPARED_RELEASES pointing at the two real frozen-install
 * receipts in a disposable source/install directory. Activation must be
 * enabled by reviewed source integration: this runner never bypasses it.
 * This covers release routing, not physical application/provider acceptance.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { parseServiceFile } from "../lib/config.ts";
import { isolatedServer } from "../test-support/isolated-server.ts";
import { canonicalDigest } from "../apps/server/services/tasks/tooling-releases.ts";
import { verifyPreparedToolingRelease } from "../apps/server/services/tasks/tooling.ts";

const Receipt = z.object({ repositoryId: z.literal("fixture"), revision: z.string().regex(/^[a-f0-9]{40}$/),
  tree: z.string().regex(/^[a-f0-9]{40}$/), policyBlob: z.string(), checkout: z.string(), lockfileDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const cleanEnv = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", HOME: home });

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { env: cleanEnv(root), stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, error);
  return out.trim();
}

export async function rehearseReleaseLifecycle(receiptFile: string) {
  const file = await realpath(receiptFile), artifactRoot = path.dirname(file);
  const temporaryRoots = await Promise.all(["/private/tmp", tmpdir()].map(value => realpath(value)));
  assert(temporaryRoots.some(root => artifactRoot.startsWith(`${root}/`)), "Release rehearsal must use a disposable temporary source/install directory");
  const [a, b] = z.array(Receipt).length(2).parse(JSON.parse(await readFile(file, "utf8")));
  assert(a && b && a.revision !== b.revision, "Two distinct committed releases are required");
  assert.equal(a.policyBlob, b.policyBlob, "This rehearsal requires compatible team policy");
  const source = await realpath(path.join(artifactRoot, "source"));
  const install = await realpath(path.join(artifactRoot, "install"));
  for (const release of [a, b]) {
    assert.equal(await realpath(release.checkout), path.join(install, "tooling", "fixture", release.revision));
    // Require current real install receipts before starting the rehearsal;
    // activation must not unexpectedly install dependencies inside a tick.
    await verifyPreparedToolingRelease(release);
  }
  const server = await isolatedServer();
  const taskId = "dra31-existing", sessionId = "dra31-existing-primary";
  const stateDirectory = path.join(server.root, "state");
  const evidence: Record<string, unknown> = { scope: "real server and committed Drafted CLI; no physical provider/app acceptance", serverRoot: server.root,
    serverRevision: await git(path.resolve(import.meta.dir, ".."), "rev-parse", "HEAD"), releases: [a, b], steps: [] };
  const steps = evidence.steps as unknown[];
  let passed = false;
  const resultFile = path.join(server.root, "release-lifecycle.json");
  const json = async (response: Response, status = 200) => {
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  const activate = async (revision: string, expectedGeneration: number, requestKey: string) =>
    json(await server.request("/api/tooling-releases/fixture/activations", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, expectedGeneration, requestKey }), signal: AbortSignal.timeout(120_000) }));
  const runCli = async (checkout: string, requestKey: string, operationId?: string, action = "status") => {
    const child = Bun.spawn([process.execPath, "--no-env-file", path.join(checkout, "src/cli.ts"), "runtime", action, "--task", taskId, "--socket", server.controlSocket], {
      cwd: checkout, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...cleanEnv(server.root), DRAFTED_RUNTIME_STATE_DIRECTORY: stateDirectory, REMOTE_AGENT_TOOLING_REQUEST_KEY: requestKey,
        ...(operationId ? { REMOTE_AGENT_TOOLING_OPERATION: operationId } : {}) },
    });
    const limit = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 60_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      steps.push({ action: `runtime-${action}`, revision: path.basename(checkout), requestKey, operationId, code, stdout, stderr });
      return { code, stdout, stderr };
    } finally { clearTimeout(limit); }
  };
  try {
    const config = parseServiceFile(JSON.parse(await readFile(server.configFile, "utf8")));
    config.repositories.fixture!.tooling = { root: source, ref: a.revision };
    config.machine.installation.root = install;
    await writeFile(server.configFile, JSON.stringify(config), { mode: 0o600 });
    const worktree = config.repositories.fixture!.root;
    await git(worktree, "init", "--quiet");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
    await git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic task identity");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    // Identity-only fixtures. No selection, operation, state-write, offer,
    // allocation or delivery record is seeded or edited by this runner.
    await server.db.prisma.runtimeSession.create({ data: { id: sessionId, scopeKey: sessionId, agentCommand: "codex", repositoryId: "fixture", machineId: "isolated-workflow",
      cwd: worktree, worktreePath: worktree, role: "primary", lifecycle: "persistent", status: "idle" } });
    await server.db.prisma.remoteTask.create({ data: { id: taskId, requestKey: taskId, repositoryId: "fixture", machineId: "isolated-workflow", primarySessionId: sessionId,
      worktreePath: worktree, branchName: "main", toolingRoot: source, toolingRevision: a.revision, pinnedToolingRoot: a.checkout, phase: "working" } });
    await server.db.prisma.remoteTask.create({ data: { id: "dra31-paused", requestKey: "dra31-paused", repositoryId: "fixture", machineId: "isolated-workflow",
      branchName: "paused", toolingRoot: source, toolingRevision: a.revision, ownerPaused: true, phase: "working" } });
    await server.start();
    const pid = server.pid;
    assert.equal((await fetch(`${server.url}/api/tooling-releases/fixture`)).status, 401);
    assert.equal((await server.socketRequest("/api/tooling-releases/fixture")).status, 404);
    const readiness = await json(await server.request("/api/tooling-releases/fixture"));
    if (!readiness.activationEnabled) throw new Error("DRA-31 activation remains disabled by source integration; no activation or manual database substitute was attempted");
    const first = await activate(a.revision, 0, "dra31-activate-a");
    assert.equal(first.selection.generation, 1);
    const requestKey = "dra31-retained-a";
    const inputDigest = canonicalDigest({ operation: "runtime status", taskId, positionals: ["runtime", "status"], options: { purpose: "development", task: taskId }, files: {}, stdin: null });
    const old = await json(await server.socketRequest(`/api/sessions/${sessionId}/tooling-operations`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestKey, inputDigest, kind: "adapter-command", resourceKey: "runtime-development" }) }));
    assert.equal(old.binding.release.revision, a.revision);
    const second = await activate(b.revision, 1, "dra31-activate-b");
    assert.equal(second.selection.generation, 2);
    assert.equal(server.pid, pid, "Compatible activation must not restart the server");
    const retained = await runCli(a.checkout, requestKey, old.binding.operationId);
    assert.equal(retained.code, 0, retained.stderr);
    assert.equal(JSON.parse(retained.stdout).phase, "absent");
    const retainedOperation = await server.db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: old.binding.operationId } });
    assert.equal(retainedOperation.status, "completed");
    assert.equal((await server.db.prisma.toolingRelease.findUniqueOrThrow({ where: { id: retainedOperation.releaseId } })).revision, a.revision);
    const freshKey = "dra31-independent-b";
    const stale = await runCli(a.checkout, freshKey);
    assert.notEqual(stale.code, 0, "A cached release cannot start independent work after B activates");
    assert.match(stale.stderr, /is bound to tooling release .*not this checkout/);
    const refused = await server.db.prisma.toolingOperation.findFirstOrThrow({ where: { taskId, requestKey: freshKey } });
    assert.equal(refused.status, "bound", "Stale A must refuse before starting B's operation");
    assert.equal((await server.db.prisma.toolingRelease.findUniqueOrThrow({ where: { id: refused.releaseId } })).revision, b.revision);
    assert.equal(await server.db.prisma.toolingOperation.count({ where: { parentOperationId: refused.id } }), 0);
    assert.equal(await server.db.prisma.toolingStateWrite.count({ where: { operationId: refused.id } }), 0);
    assert.equal(await server.db.prisma.remoteTaskResource.count({ where: { taskId } }), 0);
    const fresh = await runCli(b.checkout, freshKey);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.equal(JSON.parse(fresh.stdout).phase, "absent");
    const operation = await server.db.prisma.toolingOperation.findFirstOrThrow({ where: { taskId, requestKey: freshKey } });
    assert.equal((await server.db.prisma.toolingRelease.findUniqueOrThrow({ where: { id: operation.releaseId } })).revision, b.revision);
    assert.equal(operation.status, "completed");
    assert.deepEqual((await activate(a.revision, 0, "dra31-activate-a")).selection, first.selection, "Lost activation acknowledgments replay their original result");
    const invalid = await server.request("/api/tooling-releases/fixture/activations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: "dra31-invalid", revision: "main", expectedGeneration: 2 }) });
    assert.equal(invalid.status, 400);
    await server.stop(); await server.start();
    assert.notEqual(server.pid, pid);
    const recovered = await json(await server.request("/api/tooling-releases/fixture"));
    assert.equal(recovered.selection.release.revision, b.revision);
    assert.equal(recovered.selection.generation, 2);
    const original = await server.db.prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(original.toolingRevision, a.revision);
    assert.equal(original.pinnedToolingRoot, a.checkout);
    assert.equal(original.primarySessionId, sessionId);
    assert.equal((await server.db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "dra31-paused" } })).ownerPaused, true);

    // Synthetic saved-state input, not a provisioned resource or seeded state
    // registration. Execute the committed repository's fixture in its own
    // process; never import product-owned modules into the server process.
    // The fixture includes an uncertain provider outcome and exact IDs. Only
    // the normal migrate-state CLI may change its bytes or register version 2.
    const fixtureProcess = Bun.spawn([process.execPath, "--no-env-file", "-e",
      "const { runtimeFixture } = await import(process.argv[1]); process.stdout.write(JSON.stringify(runtimeFixture(JSON.parse(process.argv[2]))));",
      path.join(b.checkout, "test-support/runtime-state-fixture.ts"), JSON.stringify({ taskId, worktree })],
    { cwd: b.checkout, env: cleanEnv(server.root), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [fixtureCode, fixtureText, fixtureError] = await Promise.all([fixtureProcess.exited,
      new Response(fixtureProcess.stdout).text(), new Response(fixtureProcess.stderr).text()]);
    assert.equal(fixtureCode, 0, fixtureError);
    const beforeMigration = JSON.parse(fixtureText);
    assert.equal(beforeMigration.version, 1);
    assert.equal(typeof beforeMigration.pending, "string");
    assert(beforeMigration.pending.length > 0, "The fixture must carry an uncertain provider outcome");
    assert(Array.isArray(beforeMigration.resources) && beforeMigration.resources.some((resource: Record<string, unknown>) =>
      typeof resource.id === "string" && resource.id.length > 0 && resource.released !== true), "The fixture must carry an unreleased exact provider ID");
    assert.equal(beforeMigration.setupComplete, true);
    assert.equal(beforeMigration.schemaApplied, true);
    assert.equal(beforeMigration.fixturesComplete, true);
    const runtimeFile = path.join(stateDirectory, "runtimes", taskId, "development", "runtime.json");
    await mkdir(path.dirname(runtimeFile), { recursive: true, mode: 0o700 });
    await writeFile(runtimeFile, JSON.stringify(beforeMigration, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // This is ordinary registration of synthetic input, not a bound effect.
    await json(await server.socketRequest(`/api/sessions/${sessionId}/task/resources`, { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "runtime-development", kind: "task-runtime",
        purpose: "development", externalId: runtimeFile, state: "allocated", metadata: { recipeHash: beforeMigration.recipeHash } }) }));
    const migrationKey = "dra31-runtime-state-migration";
    const migrated = await runCli(b.checkout, migrationKey, undefined, "migrate-state");
    assert.equal(migrated.code, 0, migrated.stderr);
    assert.equal(JSON.parse(migrated.stdout).status, "migrated");
    const migratedBytes = await readFile(runtimeFile, "utf8"), migratedState = JSON.parse(migratedBytes);
    assert.equal(migratedState.version, 2);
    assert.deepEqual({ ...migratedState, version: 1 }, beforeMigration, "Migration must preserve every saved ID, pending outcome and setup flag");
    const migrationOperation = await server.db.prisma.toolingOperation.findFirstOrThrow({ where: { taskId, requestKey: migrationKey } });
    assert.equal(migrationOperation.status, "completed");
    const registered = await server.db.prisma.toolingStateWrite.findMany({ where: { taskId, family: "drafted.runtime", scopeKey: "runtime-development", version: 2 } });
    assert.equal(registered.length, 1);
    const writer = await server.db.prisma.toolingOperation.findUniqueOrThrow({ where: { id: registered[0]!.operationId } });
    assert(writer.id === migrationOperation.id || writer.parentOperationId === migrationOperation.id, "The migration write must belong to its command or exact child");
    const migrationReceiptFile = path.join(path.dirname(runtimeFile), "state-migrations", "runtime.json.drafted.runtime.1-2.json");
    const migrationReceipt = JSON.parse(await readFile(migrationReceiptFile, "utf8"));
    assert.equal(migrationReceipt.phase, "committed");
    assert.equal(migrationReceipt.operationId, writer.id);
    assert.match(migrationReceipt.outputDigest, /^[a-f0-9]{64}$/);
    const operationCount = await server.db.prisma.toolingOperation.count({ where: { taskId } });
    const taskWrites = await server.db.prisma.toolingStateWrite.findMany({ where: { taskId }, orderBy: { sequence: "asc" } });
    const replayed = await runCli(b.checkout, migrationKey, undefined, "migrate-state");
    assert.equal(replayed.code, 0, replayed.stderr);
    assert.equal(JSON.parse(replayed.stdout).alreadySettled, true);
    assert.equal(await readFile(runtimeFile, "utf8"), migratedBytes, "An acknowledged migration replay must not rewrite state");
    assert.equal(await server.db.prisma.toolingOperation.count({ where: { taskId } }), operationCount, "Replay must not create a root or child operation");
    assert.deepEqual(await server.db.prisma.toolingStateWrite.findMany({ where: { taskId }, orderBy: { sequence: "asc" } }), taskWrites);
    assert.deepEqual(JSON.parse(await readFile(migrationReceiptFile, "utf8")), migrationReceipt, "Replay must preserve the committed receipt and its identity");
    steps.push({ action: "state-migration-verified", operationId: migrationOperation.id, scopeKey: "runtime-development", version: 2,
      beforeDigest: canonicalDigest(beforeMigration), afterDigest: canonicalDigest(migratedState), replayUnchanged: true });
    steps.push({ action: "verified", originalPid: pid, restartedPid: server.pid, retainedOperation: old.binding.operationId, independentOperation: operation.id,
      activeRevision: b.revision, generation: 2, originalPin: original.toolingRevision });
    passed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    evidence.passed = passed;
    try {
      await server.stop();
      // Preserve synthetic selection/operation evidence before the fixture
      // removes its DB. No full database or config/credential copy is kept.
      evidence.selection = await server.db.prisma.toolingSelection.findMany();
      evidence.operations = await server.db.prisma.toolingOperation.findMany();
      evidence.stateWrites = await server.db.prisma.toolingStateWrite.findMany();
      await writeFile(resultFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    } finally { await server.cleanup({ keepEvidence: true }); }
    console.log(JSON.stringify({ passed, evidence: resultFile }));
  }
}

if (import.meta.main) {
  const receipts = process.env.DRA31_PREPARED_RELEASES;
  if (!receipts) throw new Error("Set DRA31_PREPARED_RELEASES to two real frozen-install receipts in a disposable temporary directory");
  await rehearseReleaseLifecycle(receipts);
}
