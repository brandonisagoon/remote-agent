import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../app.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { startRuntimeEventProjection } from "../sessions/runtime-events/projection.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { inspectCleanupSupplementAuthority } from "./cleanup-lifecycle.ts";
import { legacyOriginalWorkDependencies } from "./legacy-original-work.ts";
import { prepareCleanupAdapterResources, assertCleanupAdapterResources } from "./cleanup-adapter-resources.ts";
import { assertRegisteredCaptureSharing } from "./cleanup-filesystem.ts";

const source = process.env.DRAFTED_STUDIO_CLEANUP_ROOT;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
/** Actual client owner files/observer, Unix control, SQLite authority and Git
 * capture. Docker inventories/removals, proxy owner writer and handle absence
 * are injected; this does not claim a live Docker/proxy acceptance. */
test.skipIf(!source)("actual stock Studio v1 finalizer rechecks late claims and preserves its operation through lost replies and source capture", async () => {
  const db = await createTestDatabase(), directory = await realpath(await mkdtemp(path.join(tmpdir(), "studio-finalizer-")));
  const root = path.join(directory, "repository"), worktree = path.join(directory, "worktree");
  const client = (file: string) => import(pathToFileURL(path.join(source!, `src/${file}.ts`)).href);
  const { studioCleanupFixture } = await import(pathToFileURL(path.join(source!, "test/fixtures/studio-cleanup.ts")).href);
  const { finalizeTask } = await client("finalize"), { taskRegistry, closeTask } = await client("control"), { manageResource } = await client("resources");
  const { prepareLegacyOriginalArchive } = await client("legacy-original-archive");
  const { observeStudioCleanup } = await client("cleanup-observer-studio");
  let fixture: any, server: ReturnType<typeof Bun.serve> | undefined, stop: (() => Promise<void>) | undefined;
  const idle = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
  const priorObservation = legacyOriginalWorkDependencies.observation; legacyOriginalWorkDependencies.observation = idle;
  try {
    await mkdir(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
    await writeFile(path.join(root, "README.md"), "disposable Studio source\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture"); git(root, "worktree", "add", "-b", "codex/studio", worktree);
    await writeFile(path.join(root, ".git/info/exclude"), ".local/\n");
    fixture = await studioCleanupFixture({ taskId: "original-studio", primarySessionId: "primary", toolingRevision: "a".repeat(40), worktreePath: worktree, resourceId: "group" });
    git(worktree, "add", "."); git(worktree, "commit", "-m", "original Studio recipe");
    const config = testConfig({ repository: { ...testConfig().repository, root } });
    await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", role: "primary", cwd: worktree, repositoryId: config.repository.id, machineId: config.machine } });
    const task = await db.prisma.remoteTask.create({ data: { id: fixture.task.id, requestKey: fixture.task.id, repositoryId: config.repository.id, machineId: config.machine, primarySessionId: "primary", branchName: "codex/studio", baseCommit: git(worktree, "rev-parse", "HEAD"), worktreePath: worktree, toolingRoot: root, toolingRevision: fixture.task.toolingRevision, phase: "complete" } });
    const resource = await db.prisma.remoteTaskResource.create({ data: { ...fixture.resource, taskId: task.id } });
    await db.prisma.computeEnvironment.create({ data: { id: fixture.record.environmentId, taskId: task.id, primarySessionId: "primary", machineId: config.machine, taskIdentity: "f".repeat(64), key: resource.key, purpose: "development", revision: fixture.record.revision, recipeDigest: fixture.record.recipeDigest, resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest, configuration: fixture.record.configuration, state: "suspended" } });
    const runtime = createFakeAgentRuntime(), app = createApp({ prisma: db.prisma, config, agentRuntime: runtime, trustLocal: true });
    const socket = path.join(directory, "control.sock"); server = Bun.serve({ unix: socket, fetch: app.fetch }); await chmod(socket, 0o600);
    stop = startRuntimeEventProjection({ prisma: db.prisma, config, runtime }, async () => {});
    const request = async (route: string, body: object, method = "POST") => {
      const response = await fetch(`http://localhost/api/tasks/${task.id}/${route}`, { unix: socket, method, headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    expect((await request("completion/contract", { requestKey: "owner-complete", expectedRevision: 0, boundary: "local-only", basis: "Disposable Studio verification is complete; deliberately retire its owned data." }, "PUT")).status).toBe(200);
    expect((await request("completion/verification", { requestKey: "owner-verified", passed: true, evidence: ["Disposable original Studio identities and retained source verified"] })).status).toBe(200);
    const registry = taskRegistry(socket, task.id, 30_000), finalizationRequest = { requestKey: `finalize:${task.id}`, cleanup: true };
    // The actual read-only client observer must satisfy the server's v2 target
    // schema too, but this plan grants no authority to the v1 finalizer below.
    const context = { task: fixture.proof.task, capability: { version: 1 as const, source: "configured-host" as const, checkout: source!, revision: "b".repeat(40), adapter: path.join(source!, "src/cli.ts"), adapterSha256: "c".repeat(64) } };
    const observer = async ({ request: input }: any) => {
      const current = await registry.task(); const observations = [];
      for (const selected of input.observations) {
        const own = current.resources.find((row: any) => row.id === selected.resourceId);
        const result = await observeStudioCleanup({ version: 1, task: input.task, resource: { ...own, expiresAt: own.expiresAt ?? null }, resources: current.resources.map((row: any) => ({ ...row, expiresAt: row.expiresAt ?? null })), stage: input.stage, ...(selected.expectedTargets ? { expectedTargets: selected.expectedTargets } : {}) }, fixture.docker, fixture.services);
        observations.push(result.observation);
      }
      return { version: 1, taskId: task.id, observations };
    };
    const recordDTO = (row: typeof resource) => ({ id: row.id, key: row.key, kind: row.kind, purpose: row.purpose, externalId: row.externalId, state: row.state, expiresAt: row.expiresAt?.toISOString() ?? null, metadata: row.metadata });
    const records = [recordDTO(resource)], identities = [{ ...finalizationResourceIdentity(resource), purpose: "development" as const }];
    const targetPlan = await prepareCleanupAdapterResources({ context, resources: records as never, identities }, observer);
    expect(targetPlan[0]!.targets).toHaveLength(10); await assertRegisteredCaptureSharing(db.prisma, task.id, targetPlan);
    let lastManageError: unknown;
    const manage = async (input: any) => { try { return await manageResource({ ...input, docker: fixture.docker, studio: { root: fixture.root, cleanup: fixture.services } }); } catch (error) { lastManageError = error; throw error; } };
    let closes = 0;
    const args = { registry, cleanup: true, manage, close: async () => { await closeTask(socket, task.id); closes++; }, preparedCleanup: { observation: idle } };
    await expect(finalizeTask(args)).rejects.toThrow("Local source contains ignored material");
    const prepared = await request("prepare-finalization", { ...finalizationRequest, authorityOnly: true }); expect(prepared.status).toBe(200);
    const rawPrepared = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.preparedRevision } });
    const rawOperation = await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: prepared.data.cleanup.operationRevision } });
    const binding = { kind: "original-work", requestKey: "owner-source", finalizationRequestKey: finalizationRequest.requestKey, expectedPreparedRevision: rawPrepared.sequence, expectedPreparedRawDigest: sha(rawPrepared.value!), expectedOperationRevision: rawOperation.sequence, expectedOperationRawDigest: sha(rawOperation.value!), expectedOperationDigest: finalizationDigest(JSON.parse(rawOperation.value!)) };
    const archiveRoot = path.join(directory, "retained"); await mkdir(archiveRoot, { mode: 0o700 });
    const archive = await prepareLegacyOriginalArchive({ taskId: task.id, sessionId: "primary", toolingRevision: task.toolingRevision, worktree, revision: task.baseCommit, branch: task.branchName, archiveRoot: path.join(archiveRoot, "source"), ownedPaths: [path.join(worktree, ".local")], binding }, { assertAuthority: async () => { await inspectCleanupSupplementAuthority({ prisma: db.prisma, config, sessionId: "primary", requestKey: finalizationRequest.requestKey }); } });
    const adoption = await request("legacy-evidence", { ...binding, archive }); expect(adoption.status).toBe(200);
    const originalInode = (await lstat(worktree)).ino;
    // Inject a real DB-only claim after the slow physical read. It has no
    // container, so only the final selected-resource renewal can catch it.
    let inserted = false;
    const command = fixture.services.command;
    fixture.services.command = async (argv: string[]) => {
      const result = await command(argv);
      if (!inserted && argv[0] === "exec" && argv[2] === "cat" && argv[3] === "/etc/nginx/nginx.conf") {
        inserted = true;
        await db.prisma.remoteTask.create({ data: { id: "foreign", requestKey: "foreign", repositoryId: config.repository.id, machineId: config.machine, worktreePath: path.join(directory, "foreign"), branchName: "codex/foreign", toolingRoot: root, toolingRevision: "b".repeat(40) } });
        await db.prisma.remoteTaskResource.create({ data: { taskId: "foreign", key: "claim", kind: "docker-container", purpose: "development", externalId: fixture.proof.containers[0].id, state: "ready" } });
      }
      return result;
    };
    await expect(finalizeTask(args)).rejects.toThrow("Cleanup preserved task resources"); expect(String(lastManageError)).toContain("another registered owner"); expect(inserted).toBe(true); expect(fixture.effects).toEqual([]); expect(closes).toBe(0);
    await expect(assertRegisteredCaptureSharing(db.prisma, task.id, targetPlan)).rejects.toThrow("another registered owner");
    await db.prisma.remoteTaskResource.deleteMany({ where: { taskId: "foreign" } });
    fixture.services.command = command;
    fixture.fail("remove"); await expect(finalizeTask(args)).rejects.toThrow("Cleanup preserved task resources"); expect(String(lastManageError)).toContain("Remove reply lost");
    const firstRemoved = fixture.effects.find((value: string) => value.startsWith("remove:"));
    const register = registry.resource; let loseReleased = true;
    registry.resource = async (row: any) => { const result = await register(row); if (row.state === "released" && loseReleased) { loseReleased = false; throw Error("Lost real Released response"); } return result; };
    await expect(manage({ registry, key: resource.key, action: "release" })).rejects.toThrow("Lost real Released response");
    expect(fixture.effects.filter((value: string) => value === firstRemoved)).toHaveLength(1);
    expect((await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } })).state).toBe("released");
    await expect(finalizeTask({ ...args, preparedCleanup: { observation: idle, captureHooks: { afterCapture() { throw Error("Lost source capture response"); } } } })).rejects.toThrow("Lost source capture response");
    const sourceProof = adoption.data.proof.originalWork;
    expect((await lstat(sourceProof.target.quarantine.path)).ino).toBe(originalInode); expect(await lstat(worktree).catch(() => null)).toBeNull();
    const confirm = registry.confirmFinalization; let loseConfirmation = true;
    registry.confirmFinalization = async (input: unknown) => { const result = await confirm(input); if (loseConfirmation) { loseConfirmation = false; throw Error("Lost confirmation response"); } return result; };
    await expect(finalizeTask(args)).rejects.toThrow("Lost confirmation response");
    const beforeRetry = [...fixture.effects]; await db.prisma.$disconnect();
    expect(await finalizeTask(args)).toMatchObject({ closed: true, reporting: { state: "recorded" } });
    expect(fixture.effects).toEqual(beforeRetry); expect(closes).toBe(1);
    const currentResource = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } });
    expect(currentResource.metadata).toEqual(resource.metadata); expect(await db.prisma.remoteTaskResource.count({ where: { taskId: task.id } })).toBe(1);
    await assertCleanupAdapterResources({ taskId: task.id, resources: [recordDTO(currentResource)] as never, plan: targetPlan, removed: true }, observer);
    expect(fixture.state.container.map((row: any) => row.id)).toEqual([fixture.coverage.proxy.id]); expect(fixture.state.network.map((row: any) => row.id)).toEqual([fixture.proof.sharedNetwork.id]); expect(fixture.state.volume).toEqual([]);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: rawPrepared.sequence } })).value).toBe(rawPrepared.value);
    expect((await db.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: rawOperation.sequence } })).value).toBe(rawOperation.value);
    expect(await db.prisma.runtimeIssueUpdate.count()).toBe(0); expect(await db.prisma.runtimeSession.count()).toBe(1);
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain(worktree);
    expect(await readFile(path.join(sourceProof.target.quarantine.path, ".local/home-studio/workspace.json"), "utf8")).toBe(JSON.stringify(fixture.workspace));
  } finally {
    if (stop) await stop(); if (server) await server.stop(true); legacyOriginalWorkDependencies.observation = priorObservation;
    if (fixture) await fixture.close(); await db.cleanup(); await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
