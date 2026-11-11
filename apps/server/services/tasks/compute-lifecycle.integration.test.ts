import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../app.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { confirmComputeDelivery, reconcileObservedCompute } from "./compute-admission.ts";
import { refreshComputeObservation } from "./compute-observer.ts";
import { considerComputeSuspension } from "./compute-suspension.ts";
import { classifyCompute } from "./compute-decision.ts";
import { tickCompute } from "./compute-worker.ts";
import { assertCompletionAllowed, CompletionContractInput, recordCompletionVerification, setCompletionContract } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { canonicalDigest, readToolingOperation } from "./tooling-releases.ts";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createAcpxSessionRuntime } from "../../transports/acpx/session-runtime.ts";
import { wakeConfigurationAfterRepair } from "./configuration-repair-wakeup.ts";
import { reclaimStoppedCompute } from "./compute-reclamation.ts";
import { deliverInstructions } from "../sessions/inbox.ts";

const clientRoot = process.env.DRAFTED_INTEGRATION_ROOT;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function repository(root: string) {
  await mkdir(root); git(root, "init", "--quiet"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
}

/** Real SQLite/routes/Unix registry and client runtime. Only cloud/Docker and
 * the external physical-observer transport are disposable fixtures. The
 * configured observer is committed and resolved by the production verifier. */
async function fixture(platformHome = false, review = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "compute-pair-")));
  cleanup.push(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const db = await createTestDatabase(); cleanup.push(db.cleanup); const { prisma } = db;
  const control = await import(path.join(clientRoot!, "src/control.ts"));
  const client = await import(path.join(clientRoot!, "src/runtime.ts"));
  const { savePrivate } = await import(path.join(clientRoot!, "src/runtime-config.ts"));
  const { continueDevelopmentIntent } = await import(path.join(clientRoot!, "src/development-intent.ts"));
  const product = path.join(root, "product"), tooling = path.join(root, "tooling"), physicalFile = path.join(root, "physical.json");
  await repository(product);
  if (platformHome) {
    await mkdir(path.join(product, "apps/web/src/app"), { recursive: true });
    await writeFile(path.join(product, "apps/web/src/app/page.tsx"), "export default function Page() { return 'Home'; }\n");
    git(product, "add", ".");
  }
  git(product, "commit", "--allow-empty", "--quiet", "-m", "Original product");
  const productRevision = git(product, "rev-parse", "HEAD");
  await repository(tooling);
  const toolingManifest = await Bun.file(path.join(clientRoot!, ".remote-agent-release.json")).json();
  const runtimeContracts = (await Bun.file(path.join(clientRoot!, ".remote-agent-capabilities.json")).json()).capabilities.runtime.observationContracts;
  await writeFile(path.join(tooling, ".remote-agent-release.json"), JSON.stringify(toolingManifest));
  await writeFile(path.join(tooling, "runtime.md"), "Fixture physical observation only.\n");
  await writeFile(path.join(tooling, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "observe.ts", observationContracts: runtimeContracts } } }));
  await writeFile(path.join(tooling, "observe.ts"), `
const input = JSON.parse(await Bun.stdin.text());
const physical = await Bun.file(${JSON.stringify(physicalFile)}).json();
if (process.argv[3] === "configuration-observe") {
  const { observeRuntimeConfiguration } = await import(${JSON.stringify(path.join(clientRoot!, "src/runtime-configuration-observer.ts"))});
  const { guardObservation, toolingOperationClient, checkoutRelease } = await import(${JSON.stringify(path.join(clientRoot!, "src/tooling-operation.ts"))});
  await guardObservation({ client: toolingOperationClient(process.env.REMOTE_AGENT_SOCKET), taskId: input.task.id, sessionId: input.task.primarySessionId,
    release: () => checkoutRelease(process.cwd()) });
  const docker = { inspect: async id => physical.container?.id === id ? { ...physical.container, running: physical.running } : null };
  console.log(JSON.stringify(await observeRuntimeConfiguration(input, docker)));
  process.exit(0);
}
const now = Date.now();
const route = { id: "pair-api", taskId: input.task.id, primarySessionId: input.task.primarySessionId,
  environmentId: input.environment.id, resourceId: input.resource.id, resourceIdentity: input.resource.identityDigest,
  purpose: input.environment.purpose, service: "api", revision: input.environment.revision, proxyId: "pair-proxy", configurationDigest: input.resource.metadata.compute?.configurationSha256 ?? "e".repeat(64) };
const previous = input.previousTraffic[0];
const traffic = previous ? { ...previous, route, sequence: previous.sequence + 1, lastReceivedAt: now, lastObservedAt: now }
  : { version: 1, route, epoch: "pair-epoch", sequence: 1, lastReceivedAt: now, lastObservedAt: now, coverage: "complete", coverageSince: now - 60000,
      reason: null, lastMeaningfulAt: null, lastUnknownAt: null, active: {}, completed: {}, buckets: [] };
console.log(JSON.stringify({ observation: { version: 1, environmentId: input.environment.id, taskId: input.task.id,
  primarySessionId: input.task.primarySessionId, purpose: input.environment.purpose, revision: input.environment.revision,
  ...(physical.sourceRevision ? { sourceRevision: physical.sourceRevision } : {}),
  recipeDigest: input.environment.recipeDigest, resourceId: input.resource.id, resourceIdentity: input.resource.identityDigest,
  observedAt: now, state: physical.running ? "running" : "stopped", coverage: "complete", configurationDigest: route.configurationDigest,
  routes: [route], operations: { coverage: "complete", active: physical.active, generation: "f".repeat(64) } }, traffic: [traffic] }));
`);
  git(tooling, "add", "."); git(tooling, "commit", "--quiet", "-m", "Immutable fixture observer");
  const toolingRevision = git(tooling, "rev-parse", "HEAD"), socket = path.join(root, "control.sock");
  const config = testConfig({ installRoot: path.join(root, "install"), controlIpcPath: socket,
    compute: ComputePolicy.parse({ enabled: true, slots: 1, quietPeriodSeconds: 30, decisionApiKey: "fixture" }) });
  config.repository = { ...config.repository, root: product, tooling: { root: tooling, revision: toolingRevision } };
  config.repositories = { [config.repository.id]: config.repository };
  const checkout = path.join(config.installRoot, "tooling", config.repository.id, toolingRevision);
  await mkdir(path.dirname(checkout), { recursive: true }); git(tooling, "worktree", "add", "--detach", checkout, toolingRevision); await writeFile(`${checkout}.ready`, `${toolingRevision}\n`);
  const task = await prisma.remoteTask.create({ data: { id: "pair-task", requestKey: "pair-task", repositoryId: config.repository.id,
    machineId: config.machine, primarySessionId: "pair-primary", worktreePath: product, branchName: "codex/pair", phase: "working", toolingRoot: tooling, pinnedToolingRoot: checkout, toolingRevision } });
  await prisma.runtimeSession.create({ data: { id: task.primarySessionId!, scopeKey: task.id, agentCommand: "codex", role: "primary", status: "idle", cwd: product, repositoryId: task.repositoryId, machineId: task.machineId } });
  const runtime = createFakeAgentRuntime([{ id: task.primarySessionId!, role: "primary", status: "idle", cwd: product, repositoryId: task.repositoryId, machineId: task.machineId }]);
  const app = createApp({ config, prisma, agentRuntime: runtime, trustLocal: true });
  const server = Bun.serve({ unix: socket, fetch: app.fetch }); cleanup.push(async () => { await server.stop(true); });
  const registry = control.taskRegistry(socket, task.id);
  const credentials = { CLERK_SECRET_KEY: "sk_test_fixture", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_fixture", OPENAI_API_KEY: "fixture-secret", STUDIO_PLANETSCALE_SERVICE_TOKEN_ID: "fixture", STUDIO_PLANETSCALE_SERVICE_TOKEN: "fixture" };
  const credentialsFile = path.join(root, "credentials.json"); await savePrivate(credentialsFile, credentials);
  const configFile = path.join(root, "recipe.json");
  await writeFile(configFile, JSON.stringify({ version: 1, profile: "platform", image: "fixture:1", credentialsFile,
    runtimeSecrets: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "OPENAI_API_KEY"], planetscale: { organization: "fixture", database: "fixture", baseBranch: "main", baseBranchId: "base" },
    setup: [["bun", "install"]], fixtures: [["bun", "seed-task.ts"]], services: { api: { command: ["bun", "api.ts"], port: 8080 } }, checks: [{ service: "api", path: "/health", representative: true, json: { ready: true } }], readyTimeoutSeconds: 1 }));
  if (platformHome) {
    const recipe = await Bun.file(configFile).json();
    recipe.services.web = { command: ["bun", "--no-env-file", "run", "--cwd", "apps/web", "dev"], port: 3000 };
    recipe.checks.push({ service: "web", path: "/create", status: 200, representative: true });
    await savePrivate(configFile, recipe);
  }
  const physical: { running: boolean; active: number; sourceRevision?: string; container?: unknown } = { running: false, active: 0 }; const sync = () => savePrivate(physicalFile, physical); await sync();
  const effects: string[] = [], remote = new Map<string, unknown>(); let container: any = null, proxy: any = null;
  const network = { id: "c".repeat(64), createdAt: "original-network" };
  const labels = { "dev.drafted.task": task.id, "dev.drafted.purpose": "development" };
  const docker = {
    preflight: async () => { effects.push("preflight"); },
    create: async (state: any, directory: string, environment: unknown) => { effects.push("create"); await savePrivate(path.join(directory, "app", "environment.json"), environment);
      state.network = network;
      labels["dev.drafted.purpose"] = state.purpose;
      container = { id: "a".repeat(64), image: `sha256:${"a".repeat(64)}`, createdAt: "2026-01-01T00:00:00.000Z", running: false, labels: { "dev.drafted.task": task.id, "dev.drafted.purpose": state.purpose, "dev.drafted.runtime": "1" } }; physical.container = container; await sync(); return container; },
    inspect: async () => container,
    start: async () => { effects.push("start"); container.running = physical.running = true; await sync(); },
    exec: async () => { effects.push("exec"); },
    stop: async () => { effects.push("stop"); container.running = physical.running = false; await sync(); },
    remove: async () => { throw new Error("Suspension must not delete its container"); },
    releaseDependencies: async () => { throw new Error("Suspension must preserve dependencies"); },
  };
  const providers = { preflight: async () => {}, create: async (provider: string, name: string, record: (value: unknown) => Promise<void>) => {
    effects.push(`create-${provider}`); const receipt = { provider, id: `${provider}-original`, name }; remote.set(provider, receipt); await record(receipt); return { DATABASE_URL: "mysql://fixture@fixture.invalid/fixture" }; },
    inspect: async (receipt: any) => remote.has(receipt.provider), resume: async () => ({ DATABASE_URL: "mysql://fixture@fixture.invalid/fixture" }),
    schema: async (_receipt: unknown, operation: (env: unknown) => Promise<unknown>) => operation({ DATABASE_URL: "mysql://fixture@fixture.invalid/fixture" }),
    release: async () => { throw new Error("Suspension must preserve remote data"); } };
  const computeDocker = async (args: string[]) => {
    const options = (flag: string) => args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
    if (args[0] === "image") return JSON.stringify([{ Id: `sha256:${"b".repeat(64)}` }]);
    if (args[0] === "network") return JSON.stringify([{ Id: network.id, Name: "fixture", Created: network.createdAt, Labels: labels }]);
    if (args[0] === "container" && args[1] === "ls") return proxy?.Id ?? "";
    if (args[0] === "create") {
      effects.push("create-proxy");
      const mount = options("--mount").map(value => Object.fromEntries(value.split(",").map(pair => pair.split("="))));
      proxy = { Id: "d".repeat(64), Image: `sha256:${"b".repeat(64)}`, Created: "original-proxy", State: { Running: false },
        Config: { Labels: Object.fromEntries(options("--label").map(value => value.split("="))) },
        HostConfig: { NetworkMode: network.id, PortBindings: Object.fromEntries(options("--publish").map(value => { const [HostIp, HostPort, port] = value.split(":"); return [`${port}/tcp`, [{ HostIp, HostPort }]]; })) },
        Mounts: mount.map(value => ({ Source: value.source, Destination: value.target, RW: value.readonly === undefined && !options("--mount").some(raw => raw.includes(`target=${value.target},readonly`)) })),
        NetworkSettings: { Networks: { fixture: { NetworkID: network.id } } } };
      return proxy.Id;
    }
    if (args[0] === "inspect") return JSON.stringify([proxy]);
    if (args[0] === "start") { effects.push("start-proxy"); proxy.State.Running = true; return ""; }
    throw new Error(`Unexpected disposable traffic Docker command: ${args[0]}`);
  };
  const input = { registry, stateDirectory: root, ...(review ? { purpose: "review", revision: productRevision } : {}), docker, computeDocker, clerkCredentials: async () => credentials, providers: () => providers, request: async () => Response.json({ ready: true }) };
  const context = { prisma, config, runtime };
  const admission = { prisma, machineId: config.machine, policy: config.compute! };
  async function deliver() {
    const environment = await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: task.id } });
    const offer = await prisma.computeOffer.findFirstOrThrow({ where: { environmentId: environment.id, state: "queued" }, orderBy: { createdAt: "desc" } });
    await prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
    await prisma.runtimeSession.update({ where: { id: task.primarySessionId! }, data: { status: "active" } });
    await prisma.runtimeLifecycleEvent.create({ data: { id: crypto.randomUUID(), runtimeSessionId: task.primarySessionId!, requestId: offer.instructionId, phase: "started", occurredAt: new Date() } });
    const delivered = await confirmComputeDelivery({ ...admission, sessionId: task.primarySessionId!, requestId: offer.instructionId });
    expect(delivered).toMatchObject({ state: "offered", expiresAt: null });
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);
    return offer;
  }
  async function settled(offer: Awaited<ReturnType<typeof deliver>>) {
    await prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "completed" } });
    await prisma.runtimeSession.update({ where: { id: task.primarySessionId! }, data: { status: "idle" } });
    await prisma.runtimeLifecycleEvent.create({ data: { id: crypto.randomUUID(), runtimeSessionId: task.primarySessionId!, requestId: offer.instructionId, phase: "completed", occurredAt: new Date() } });
  }
  const manage = (request: any) => client.manageRuntimeResource(request, (value: any) => client.manageRuntime({ ...value, ...input, registry: value.registry }));
  const consider: typeof considerComputeSuspension = input => considerComputeSuspension(input, { classify: (evidence, settings) => classifyCompute(evidence, { ...settings,
    fetch: async () => Response.json({ answers: [{ type: "choice", name: "compute_action", choice: "suspend-compute", confidence: 0.92 }] }) }) });
  const continuationErrors: unknown[] = [];
  const continueSaved = async () => { try { return await continueDevelopmentIntent(registry, manage); } catch (error) { continuationErrors.push(error); throw error; } };
  return { ...context, admission, registry, client, input, configFile, effects, remote, physical, sync, deliver, settled, consider, continueSaved, continuationErrors, task, productRevision, root,
    control, socket, tooling, toolingManifest, toolingRevision, checkout, container: () => container };
}

test.skipIf(!clientRoot).each([false, true])("actual Unix review advances its unstarted queue to the corrected detached checkout (bound lost response: %s)", async bound => {
  const f = await fixture();
  const operations = await import(path.join(clientRoot!, "src/tooling-operation.ts")), tree = git(f.tooling, "rev-parse", "HEAD^{tree}");
  if (bound) {
    await f.prisma.toolingRelease.create({ data: { id: "paired-review-release", repositoryId: f.task.repositoryId, revision: f.toolingRevision, tree,
      policyBlob: git(f.tooling, "rev-parse", "HEAD:runtime.md"), checkout: f.checkout, manifest: f.toolingManifest, lockfileDigest: "0".repeat(64), bunVersion: Bun.version } });
    await f.prisma.toolingLegacyBoundary.create({ data: { repositoryId: f.task.repositoryId, activationRequestKey: "review-boundary", legacyRevision: f.toolingRevision, recordedAt: new Date() } });
    await f.prisma.toolingSelection.create({ data: { repositoryId: f.task.repositoryId, generation: 1, releaseId: "paired-review-release", activatedAt: new Date() } });
    cleanup.push(async () => f.control.bindControlOperation(null));
  }
  const up = async (revision: string, computeOffer?: string) => {
    let session;
    if (bound) {
      const client = operations.toolingOperationClient(f.socket), requestKey = `review:${revision}:${computeOffer ?? "request"}`;
      const guard = await operations.guardToolingOperation({ client, task: f.task, kind: "adapter-command", resourceKey: "runtime-review", inputDigest: canonicalDigest({ revision, computeOffer }), requestKey,
        release: async () => ({ checkout: f.checkout, revision: f.toolingRevision, tree, manifest: f.toolingManifest }) });
      session = new operations.ToolingOperationSession(guard, { client, task: f.task, commandRequestKey: requestKey, socket: f.socket, settlementDirectory: f.root });
      f.control.bindControlOperation(session);
    }
    try {
      const result = await f.client.manageRuntime({ ...f.input, action: "up", purpose: "review", revision, configFile: f.configFile, computeOffer });
      await session?.complete(); return result;
    } finally { if (bound) f.control.bindControlOperation(null); }
  };
  expect((await up(f.productRevision)).phase).toBe("waiting-compute");
  const original = await f.prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: f.task.id, purpose: "review" } });
  const waiting = await f.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: original.id } });
  const anchor = await f.prisma.remoteTaskResource.findFirstOrThrow({ where: { taskId: f.task.id, key: `review-${f.productRevision}` } });
  const firstOffer = await f.prisma.computeOffer.findFirstOrThrow({ where: { environmentId: original.id } });
  expect(f.effects).toEqual([]);
  git(f.task.worktreePath!, "commit", "--allow-empty", "--quiet", "-m", "Correct product after browser verification");
  const revision = git(f.task.worktreePath!, "rev-parse", "HEAD");
  if (bound) {
    const request = f.registry.requestCompute; let lost = true;
    f.registry.requestCompute = async (value: any) => { const result = await request(value); if (lost) { lost = false; throw new Error("Lost committed review advance response"); } return result; };
    await expect(up(revision)).rejects.toThrow("Lost committed review advance response");
    await f.prisma.$disconnect();
  }
  expect((await up(revision)).phase).toBe("waiting-compute");
  expect(await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ revision, recipeDigest: original.recipeDigest, resourceId: null });
  expect(await f.prisma.computeWait.findUniqueOrThrow({ where: { environmentId: original.id } })).toEqual(waiting);
  expect(await f.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: anchor.id } })).toEqual(anchor);
  expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: firstOffer.id } })).state).toBe("ineligible");
  expect(f.effects).toEqual([]);
  const offer = await f.deliver();
  expect(offer.id).not.toBe(firstOffer.id);
  expect((await up(revision, offer.id)).phase).toBe("ready");
  expect(f.effects.filter(value => value === "create")).toHaveLength(1);
  expect(f.effects.filter(value => value === "create-planetscale")).toHaveLength(1);
  expect(await f.prisma.remoteTaskResource.count({ where: { taskId: f.task.id, kind: "git-worktree", purpose: "review" } })).toBe(2);
  expect((await f.registry.task()).toolingRevision).toBe(f.task.toolingRevision);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-unstarted-revision" } })).toBe(1);
}, 90_000);

test.skipIf(!clientRoot).each([false, true])("actual Unix lifecycle suspends idle compute and resumes the saved runtime (lost completion: %s)", async lostCompletion => {
  const f = await fixture();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile })).phase).toBe("waiting-compute");
  expect(f.effects).toEqual([]); expect(await f.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(1);
  const first = await f.deliver();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: first.id })).phase).toBe("ready");
  await f.settled(first);
  const environment = await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: first.environmentId } });
  const refresh = () => refreshComputeObservation({ ...f, environmentId: environment.id });
  await refresh(); await reconcileObservedCompute({ ...f.admission, environmentId: environment.id, runtime: f.runtime });
  const original = await f.registry.task(), containerId = f.container().id, stores = structuredClone([...f.remote]);
  const scenario = path.join(f.root, "saved-scenario.json"); await writeFile(scenario, JSON.stringify({ design: "original", jobs: [1, 2, 3] })); const bytes = await readFile(scenario);
  f.physical.active = 1; await f.sync();
  const busy = await tickCompute(f, { consider: f.consider, continue: f.continueSaved });
  if (f.continuationErrors.length) throw f.continuationErrors[0];
  expect(busy).toEqual({ observed: 1, unavailable: 0 });
  expect(f.effects).not.toContain("stop"); expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
  f.physical.active = 0; await f.sync();
  const complete = f.registry.completeDevelopmentIntent;
  let lost = false;
  f.registry.completeDevelopmentIntent = async (input: unknown) => {
    const result = await complete(input);
    if (lostCompletion && !lost) { lost = true; throw new Error("Fixture lost committed completion response"); }
    return result;
  };
  const suspended = await tickCompute(f, { consider: f.consider, continue: f.continueSaved });
  if (lostCompletion) {
    expect(suspended).toEqual({ observed: 0, unavailable: 1 });
    expect(String(f.continuationErrors.shift())).toContain("Fixture lost committed completion response");
    expect(await f.prisma.computeSlot.count({ where: { allocationId: first.id } })).toBe(1);
    await f.prisma.$disconnect();
    expect(await tickCompute(f, { consider: f.consider, continue: f.continueSaved })).toEqual({ observed: 1, unavailable: 0 });
  } else {
    if (f.continuationErrors.length) throw f.continuationErrors[0];
    expect(suspended).toEqual({ observed: 1, unavailable: 0 });
  }
  const stopped = await f.registry.task();
  expect(stopped.developmentIntent).toMatchObject({ reason: "runtime-suspended", state: "complete" });
  expect(stopped.ownerPaused).toBe(false); expect(stopped.phase).toBe(original.phase);
  expect(f.container()).toMatchObject({ id: containerId, running: false }); expect([...f.remote]).toEqual(stores);
  expect(await f.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  expect(await f.prisma.computeWait.count()).toBe(0); expect(await f.prisma.computeOffer.count()).toBe(1);
  expect(await f.continueSaved()).toMatchObject({ results: [] }); expect(f.effects.filter(value => value === "stop")).toHaveLength(1);
  const request = { key: environment.key, purpose: "development", revision: environment.revision, recipeDigest: environment.recipeDigest };
  expect((await f.registry.requestCompute(request)).environment.id).toBe(environment.id);
  const second = await f.deliver(); expect(second.id).not.toBe(first.id);
  const resumed = await f.client.manageRuntime({ ...f.input, action: "up", resumeOnly: true, computeOffer: second.id });
  expect(resumed.phase).toBe("ready"); await f.settled(second); await refresh();
  await reconcileObservedCompute({ ...f.admission, environmentId: environment.id, runtime: f.runtime });
  expect(f.container()).toMatchObject({ id: containerId, running: true }); expect([...f.remote]).toEqual(stores); expect(await readFile(scenario)).toEqual(bytes);
  expect(f.effects.filter(value => value === "create")).toHaveLength(1); expect(f.effects.filter(value => value === "create-planetscale")).toHaveLength(1);
  expect(f.effects.filter(value => value === "exec")).toHaveLength(3); expect(f.effects.filter(value => value === "start")).toHaveLength(2);
  expect(await f.prisma.computeSlot.count({ where: { allocationId: second.id } })).toBe(1);
  expect((await f.registry.task()).resources.map((value: any) => value.id)).toEqual(original.resources.map((value: any) => value.id));
  expect(await f.prisma.runtimeSession.count()).toBe(1);
  expect(git(f.task.worktreePath!, "rev-parse", "HEAD")).toBe(f.productRevision);
}, 90_000);

test.skipIf(!clientRoot)("actual client stops a merged app through original Unix routes while stale final verification remains pending", async () => {
  const f = await fixture();
  git(f.task.worktreePath!, "checkout", "-qb", f.task.branchName);
  await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile });
  const offer = await f.deliver();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: offer.id })).phase).toBe("ready");
  await f.settled(offer);
  const context = { ...f, taskId: f.task.id };
  await setCompletionContract({ ...context, contract: CompletionContractInput.parse({ requestKey: "owner-merge", expectedRevision: 0, boundary: "merge", basis: "Owner requested Merge", repository: "owner/product", pullRequest: 42, baseBranch: "main" }) });
  await recordCompletionVerification({ ...context, verification: { requestKey: "reviewed-source", passed: true, evidence: ["original source checks"] } });
  await writeFile(path.join(f.task.worktreePath!, "merged.txt"), "reconciled with staging\n");
  git(f.task.worktreePath!, "add", "."); git(f.task.worktreePath!, "commit", "-qm", "Reconcile staging");
  const head = git(f.task.worktreePath!, "rev-parse", "HEAD");
  const observer = { ...completionObservation, remote: async () => ({ remote: "origin", repository: "owner/product", remoteHead: head, remoteBase: "b".repeat(40), pullRequest: {
    url: "https://github.com/owner/product/pull/42", headRefOid: head, headRefName: f.task.branchName, baseRefName: "main", state: "MERGED", isDraft: false, reviewDecision: null, mergeCommit: { oid: "c".repeat(40) },
  } }) };
  await expect(assertCompletionAllowed({ ...context, sessionId: f.task.primarySessionId! }, observer)).rejects.toThrow("verification is missing, failed or stale");
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "complete" } });
  f.physical.sourceRevision = head; await f.sync();
  const original = await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } });
  const resources = await f.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
  const stores = structuredClone([...f.remote]), containerId = f.container().id;
  const complete = f.registry.completeDevelopmentIntent; let lost = false;
  f.registry.completeDevelopmentIntent = async (input: unknown) => {
    const result = await complete(input);
    if (!lost) { lost = true; throw new Error("Lost merged-stop acknowledgment"); }
    return result;
  };
  expect(await tickCompute(f, { continue: f.continueSaved })).toEqual({ observed: 0, unavailable: 1 });
  expect(String(f.continuationErrors.shift())).toContain("Lost merged-stop acknowledgment");
  expect(await f.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
  await f.prisma.$disconnect();
  expect(await tickCompute(f, { continue: f.continueSaved })).toEqual({ observed: 1, unavailable: 0 });
  if (f.continuationErrors.length) throw f.continuationErrors[0];
  expect(f.container()).toMatchObject({ id: containerId, running: false });
  expect(f.effects.filter(value => value === "stop")).toHaveLength(1); expect([...f.remote]).toEqual(stores);
  expect(await f.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(0);
  expect(await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(original);
  const stoppedResources = await f.prisma.remoteTaskResource.findMany({ orderBy: { id: "asc" } });
  expect(stoppedResources.map(finalizationResourceIdentity)).toEqual(resources.map(finalizationResourceIdentity));
  expect(stoppedResources.filter(value => value.kind !== "task-runtime")).toEqual(resources.filter(value => value.kind !== "task-runtime"));
  expect(stoppedResources.find(value => value.kind === "task-runtime")?.state).toBe("allocated");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-idle-decision" } })).toBe(0);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-merged-delivery-stop" } })).toBe(1);
  await expect(assertCompletionAllowed({ ...context, sessionId: f.task.primarySessionId! }, observer)).rejects.toThrow("verification is missing, failed or stale");
  expect((await f.registry.task()).developmentIntent).toMatchObject({ reason: "runtime-suspended", state: "complete" });
}, 90_000);

test.skipIf(!clientRoot)("actual Unix suspension refuses a newer owner pause after container inspection and before stop", async () => {
  const f = await fixture();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile })).phase).toBe("waiting-compute");
  const offer = await f.deliver();
  await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: offer.id }); await f.settled(offer);
  await refreshComputeObservation({ ...f, environmentId: offer.environmentId });
  await reconcileObservedCompute({ ...f.admission, environmentId: offer.environmentId, runtime: f.runtime });
  const decision = await f.consider({ ...f, environmentId: offer.environmentId, requestKey: "late-pause" });
  expect(decision.outcome).toBe("suspension-recorded");
  const inspect = f.input.docker.inspect;
  let changed = false;
  f.input.docker.inspect = async () => {
    const result = await inspect();
    if (!changed) { changed = true; await f.registry.setDevelopmentIntent({ action: "pause", development: true, requestKey: "late-owner-pause" }); }
    return result;
  };
  await expect(f.continueSaved()).rejects.toThrow();
  expect(changed).toBe(true); expect(f.effects).not.toContain("stop"); expect(f.container().running).toBe(true);
  expect((await f.registry.task()).developmentIntent.reason).toBe("owner-pause");
  expect(await f.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
  expect(await f.prisma.remoteTaskResource.count({ where: { state: "released" } })).toBe(0);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-complete" } })).toBe(0);
}, 90_000);

test.skipIf(!clientRoot)("setup, migrations and fixtures retain their claimed slot before application activity becomes available", async () => {
  const f = await fixture();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile })).phase).toBe("waiting-compute");
  const offer = await f.deliver(), steps: string[] = [], execute = f.input.docker.exec;
  f.input.docker.exec = async () => {
    const task = await f.registry.task(), resource = task.resources.find((value: any) => value.key === "runtime-development");
    const step = resource.metadata.progress.step;
    steps.push(step);
    expect(await Bun.file(path.join(path.dirname(resource.externalId), "app", "start.json")).exists()).toBe(false);
    expect(resource.metadata.compute).toBeUndefined();
    // Even the fixture's deliberately idle physical observation cannot override
    // the actual active setup turn. Real traffic coverage is not published yet.
    const result = await considerComputeSuspension({ ...f, environmentId: offer.environmentId, requestKey: `setup:${step}` }, {
      classify: async () => { throw new Error("Startup must never reach Decisions"); },
    });
    expect(result.outcome).toBe("not-eligible");
    expect(result.evidence.activity.ownedSessionsSettled).toBe(false);
    expect(await f.prisma.computeSlot.count({ where: { allocationId: offer.id } })).toBe(1);
    expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(0);
    expect(f.effects).not.toContain("stop");
    await execute();
  };
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: offer.id })).phase).toBe("ready");
  expect(steps).toEqual(["setup", "schema", "fixtures"]);
  await f.settled(offer);
  expect((await f.consider({ ...f, environmentId: offer.environmentId, requestKey: "ready-and-quiet" })).outcome).toBe("suspension-recorded");
  expect(f.effects).not.toContain("stop");
}, 90_000);

test.skipIf(!clientRoot).each(["normal", "lost-acknowledgment", "resumed-terminal", "repair-available", "repair-after-v1"])("actual client/observer configuration replays through Unix routes and ordinary admission (%s)", async mode => {
  const lost = mode === "lost-acknowledgment" || mode === "resumed-terminal", repair = mode === "repair-available" || mode === "repair-after-v1";
  const f = await fixture();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile })).phase).toBe("waiting-compute");
  const first = await f.deliver();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: first.id })).phase).toBe("ready");
  await f.settled(first);
  const refresh = () => refreshComputeObservation({ ...f, environmentId: first.environmentId });
  await refresh(); await reconcileObservedCompute({ ...f.admission, environmentId: first.environmentId, runtime: f.runtime });
  const stores = structuredClone([...f.remote]), originalContainer = f.container().id, before = await f.registry.task();
  const recipe = await Bun.file(f.configFile).json(); recipe.readyTimeoutSeconds = 2;
  await writeFile(f.configFile, JSON.stringify(recipe));
  const operations = await import(path.join(clientRoot!, "src/tooling-operation.ts"));
  const tree = git(f.tooling, "rev-parse", "HEAD^{tree}");
  await f.prisma.toolingRelease.create({ data: { id: "paired-configuration-release", repositoryId: f.task.repositoryId, revision: f.toolingRevision, tree,
    policyBlob: git(f.tooling, "rev-parse", "HEAD:runtime.md"), checkout: f.checkout, manifest: f.toolingManifest, lockfileDigest: "0".repeat(64), bunVersion: Bun.version } });
  await f.prisma.toolingLegacyBoundary.create({ data: { repositoryId: f.task.repositoryId, activationRequestKey: "paired-boundary", legacyRevision: f.toolingRevision, recordedAt: new Date() } });
  await f.prisma.toolingSelection.create({ data: { repositoryId: f.task.repositoryId, generation: 1, releaseId: "paired-configuration-release", activatedAt: new Date() } });
  const client = operations.toolingOperationClient(f.socket), requestKey = "original-configure-command";
  const guard = await operations.guardToolingOperation({ client, task: f.task, kind: "adapter-command", inputDigest: canonicalDigest(recipe), requestKey,
    release: async () => ({ checkout: f.checkout, revision: f.toolingRevision, tree, manifest: f.toolingManifest }) });
  expect(guard.mode).toBe("bound");
  const session = new operations.ToolingOperationSession(guard, { client, task: f.task, commandRequestKey: requestKey, socket: f.socket, settlementDirectory: f.root });
  f.control.bindControlOperation(session); cleanup.push(async () => f.control.bindControlOperation(null));
  const configure = f.registry.configureCompute; let drop = lost;
  const legacy: Array<{ id: string; inputDigest: string; events: Awaited<ReturnType<typeof f.prisma.runtimeMetadataEvent.findMany>> }> = [];
  f.registry.configureCompute = async (request: any) => {
    if ((lost || repair) && !legacy.length) {
      // Two ended old full-body/PID requests, refused by the real observer's
      // current-lock check. The supported callback stays under this parent.
      for (const offset of [1, 2]) {
        const old = { ...request, lockPid: process.pid + offset }, inputDigest = canonicalDigest(old);
        const child = await client.begin(f.task.primarySessionId, { requestKey: `old-process-${offset}`, kind: "compute-configure", parentOperationId: guard.operationId,
          existingOperationId: request.offerId, inputDigest });
        const response = await fetch("http://remote-agent/api/tasks/pair-task/compute-configure", { method: "POST", unix: f.socket,
          headers: { "content-type": "application/json", "x-remote-agent-operation": child.binding.operationId }, body: JSON.stringify(old) });
        expect(response.status).toBe(409);
        const failure = await response.json() as { code: string };
        expect(failure.code).toBe("configuration-observation-failed");
        if (repair) {
          // Fixture the persisted pre-upgrade server contract: its guarded
          // refusal is real; older versions either had no repair stamp or v1.
          const intent = await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { key: `outcome:${child.binding.operationId}` }, orderBy: { sequence: "asc" } });
          const { repairContracts: _unsupported, ...prior } = JSON.parse(intent.value!);
          await f.prisma.runtimeMetadataEvent.update({ where: { sequence: intent.sequence }, data: { value: JSON.stringify({ ...prior,
            ...(mode === "repair-after-v1" ? { repairContracts: ["configuration-command-recovery/v1"] } : {}) }) } });
        }
        legacy.push({ id: child.binding.operationId, inputDigest, events: await f.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${child.binding.operationId}` }, orderBy: { sequence: "asc" } }) });
      }
      if (repair) throw new Error("Fixture original command stopped before shared repair");
    }
    const result = await configure(request);
    if (drop) { drop = false; throw new Error("Fixture lost verified configuration response"); }
    return result;
  };
  if (lost) {
    await expect(f.client.manageRuntime({ ...f.input, action: "configure", configFile: f.configFile })).rejects.toThrow("lost verified configuration response");
    expect(f.container().running).toBe(false);
    await refresh(); await reconcileObservedCompute({ ...f.admission, environmentId: first.environmentId, runtime: f.runtime });
    expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("stopped");
    if (mode === "resumed-terminal") {
      // Once the task is active again, reclamation invalidates its cached
      // suspended accounting. Replay must re-observe the stopped app instead
      // of treating the unknown cache as a new allocation or permanent stop.
      expect(await reclaimStoppedCompute({ ...f, environmentId: first.environmentId }, async () => { throw new Error("Active task must not reclaim"); })).toEqual({ released: false });
      expect((await f.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: first.environmentId } })).state).toBe("unknown");
    }
  }
  let configured: any;
  if (repair) {
    await expect(f.client.manageRuntime({ ...f.input, action: "configure", configFile: f.configFile })).rejects.toThrow("original command stopped before shared repair");
    expect(f.container().running).toBe(false);
    const stateDir = path.join(f.root, "provider-state"), providerId = "original-configure-provider", requestId = "original-configure-turn";
    const providerConfig = { ...f.config, acpxStateDir: stateDir };
    await f.prisma.runtimeSession.update({ where: { id: f.task.primarySessionId! }, data: { status: "active", acpxRecordId: providerId, acpxSessionId: providerId } });
    await f.prisma.runtimeLifecycleEvent.create({ data: { id: requestId, runtimeSessionId: f.task.primarySessionId!, requestId, phase: "failed", occurredAt: new Date("2026-01-02T00:00:01Z") } });
    const record: AcpSessionRecord = { schema: "acpx.session.v1", acpxRecordId: providerId, acpSessionId: providerId, agentCommand: "codex", cwd: f.task.worktreePath!,
      createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-02T00:00:01Z", lastSeq: 1, pid: 2147483647, lastPromptAt: "2026-01-02T00:00:00Z", lastRequestId: requestId,
      eventLog: { active_path: path.join(stateDir, "original.stream"), segment_count: 1, max_segment_bytes: 100000, max_segments: 1 }, messages: [], updated_at: "2026-01-02T00:00:01Z", cumulative_token_usage: {}, request_token_usage: {} };
    await createRuntimeStore({ stateDir }).save(record);
    const waking = { ...f, config: providerConfig, runtime: createAcpxSessionRuntime(f.prisma, providerConfig), taskId: f.task.id, environmentId: first.environmentId };
    const wake = await wakeConfigurationAfterRepair(waking);
    expect(wake.state).toBe("queued");
    expect(await wakeConfigurationAfterRepair(waking)).toEqual({ state: "not-needed" });
    const continuation = await f.prisma.runtimeInstruction.findFirstOrThrow({ where: { id: { startsWith: "configuration-repair:" } } });
    expect(continuation).toMatchObject({ sessionId: f.task.primarySessionId, state: "queued" });
    expect(continuation.text).toContain(f.checkout);
    let done!: () => void, failed!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    f.runtime.startTurn = input => ({ requestId: input.requestId!, events: { async *[Symbol.asyncIterator]() {} }, cancel: async () => {}, result: (async () => {
      try {
        expect(input.sessionId).toBe(f.task.primarySessionId!);
        expect(await input.beforeStart?.()).toBe(true);
        configured = await f.client.manageRuntime({ ...f.input, action: "configure", configFile: f.configFile });
        done(); return { status: "completed" as const };
      } catch (error) { failed(error); return { status: "failed" as const, error: String(error) }; }
    })() });
    await deliverInstructions(f.prisma, f.runtime, f.config);
    await completed;
    for (let i = 0; i < 100 && (await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: continuation.id } })).state !== "completed"; i++) await Bun.sleep(5);
    expect(await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: continuation.id } })).toMatchObject({ state: "completed" });
    expect(await f.prisma.runtimeInstruction.count({ where: { id: { startsWith: "configuration-repair:" } } })).toBe(1);
  } else configured = await f.client.manageRuntime({ ...f.input, action: "configure", configFile: f.configFile });
  expect(configured.phase).toBe(lost ? "waiting-compute" : "ready");
  await session.complete(); f.control.bindControlOperation(null);
  expect((await readToolingOperation({ prisma: f.prisma, operationId: guard.operationId }))?.status).toBe("completed");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "compute-runtime-configuration" } })).toBe(1);
  for (const old of legacy) {
    expect(await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "completed", inputDigest: old.inputDigest, parentOperationId: guard.operationId,
      completionEvidence: { kind: "verified-configuration-transition" } });
    expect(await f.prisma.runtimeMetadataEvent.findMany({ where: { key: `outcome:${old.id}` }, orderBy: { sequence: "asc" } })).toEqual(old.events);
  }
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "configuration-command-recovery" } })).toBe(lost || repair ? 1 : 0);
  expect(f.container().id).toBe(originalContainer); expect([...f.remote]).toEqual(stores);
  if (lost) {
    expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("stopped");
    const queued = await f.prisma.computeOffer.findFirstOrThrow({ where: { environmentId: first.environmentId, state: "queued" } });
    const instruction = await f.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: queued.instructionId } });
    expect(instruction.sessionId).toBe(f.task.primarySessionId!);
    expect(queued.id).not.toBe(first.id);
  }
  const after = await f.registry.task();
  expect(after).toMatchObject({ id: before.id, primarySessionId: before.primarySessionId, worktreePath: before.worktreePath, toolingRevision: before.toolingRevision });
  expect(f.effects.filter(value => value === "create")).toHaveLength(1);
}, 30_000);

test.skipIf(!clientRoot)("RA-33 actual Unix recovery retains admission and data and replays a lost report without a second restart", async () => {
  const f = await fixture();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile })).phase).toBe("waiting-compute");
  const offer = await f.deliver();
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: offer.id })).phase).toBe("ready");
  await f.settled(offer);
  const original = f.container().id, stores = structuredClone([...f.remote]);
  const operations = await import(path.join(clientRoot!, "src/tooling-operation.ts"));
  const { reconcileRuntimeHealth } = await import(path.join(clientRoot!, "src/runtime-health.ts"));
  const tree = git(f.tooling, "rev-parse", "HEAD^{tree}");
  await f.prisma.toolingRelease.create({ data: { id: "paired-health-release", repositoryId: f.task.repositoryId, revision: f.toolingRevision, tree,
    policyBlob: git(f.tooling, "rev-parse", "HEAD:runtime.md"), checkout: f.checkout, manifest: f.toolingManifest, lockfileDigest: "0".repeat(64), bunVersion: Bun.version } });
  await f.prisma.toolingLegacyBoundary.create({ data: { repositoryId: f.task.repositoryId, activationRequestKey: "health-boundary", legacyRevision: f.toolingRevision, recordedAt: new Date() } });
  await f.prisma.toolingSelection.create({ data: { repositoryId: f.task.repositoryId, generation: 1, releaseId: "paired-health-release", activatedAt: new Date() } });
  const client = operations.toolingOperationClient(f.socket), requestKey = "original-health-sweep";
  const guard = await operations.guardToolingOperation({ client, task: f.task, kind: "adapter-command", inputDigest: canonicalDigest({ key: "runtime-development" }), requestKey,
    release: async () => ({ checkout: f.checkout, revision: f.toolingRevision, tree, manifest: f.toolingManifest }) });
  const session = new operations.ToolingOperationSession(guard, { client, task: f.task, commandRequestKey: requestKey, socket: f.socket, settlementDirectory: f.root });
  f.control.bindControlOperation(session); cleanup.push(async () => f.control.bindControlOperation(null));
  const exit = { kind: "launcher-crash", containerId: original, image: f.container().image, createdAt: f.container().createdAt,
    startedAt: "2026-11-10T00:00:00Z", finishedAt: "2026-11-10T00:21:00Z", exitCode: 133, oomKilled: false, bunVersion: "1.3.11" };
  Object.assign(f.input.docker, { diagnoseExit: async () => f.container().running ? undefined : exit });
  f.container().running = f.physical.running = false; await f.sync(); f.effects.length = 0;
  const report = f.registry.reportRuntimeHealth; let lost = true;
  f.registry.reportRuntimeHealth = async (value: any) => { const result = await report(value); if (value.notify && lost) { lost = false; throw new Error("Lost recovered report reply"); } return result; };
  const manage = (value: any) => f.client.manageRuntimeResource(value, (input: any) => f.client.manageRuntime({ ...f.input, ...input }));
  const recover = () => reconcileRuntimeHealth({ registry: f.registry, key: "runtime-development" }, manage);
  await expect(recover()).rejects.toThrow("Lost recovered report reply");
  const notices = () => f.prisma.runtimeInstruction.count({ where: { sessionId: f.task.primarySessionId!, id: { startsWith: "runtime-health:" } } });
  expect(await notices()).toBe(1);
  await f.prisma.$disconnect(); expect((await recover()).outcome).toBe("running"); expect(await notices()).toBe(1);
  expect(f.effects.filter(effect => effect === "start")).toHaveLength(1);
  expect(f.effects.filter(effect => effect.startsWith("create") || effect === "exec")).toEqual([]);
  expect(f.container().id).toBe(original); expect([...f.remote]).toEqual(stores);
  expect(await f.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(1);
  expect((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).environmentStatus).toBe("ready");
  expect(await f.prisma.remoteTaskResource.count({ where: { taskId: f.task.id, key: "runtime-health-development", kind: "evidence" } })).toBe(1);
  await session.complete(); f.control.bindControlOperation(null);
}, 120_000);

test.skipIf(!clientRoot).each(["normal", "lost-acknowledgment", "unsettled-startups", "review", "review-lost-acknowledgment"])("a refused configuration crosses releases once and retains the existing runtime (%s)", async mode => {
  const review = mode.startsWith("review"), lost = mode.endsWith("lost-acknowledgment"), unsettled = mode === "unsettled-startups";
  const f = await fixture(true, review), purpose = review ? "review" as const : "development" as const;
  const operations = await import(path.join(clientRoot!, "src/tooling-operation.ts"));
  const { sessionStateAuthority } = await import(path.join(clientRoot!, "src/tooling-state-evidence.ts"));
  const { savePrivate } = await import(path.join(clientRoot!, "src/runtime-config.ts"));
  const { saveRuntimeStateFile, lossKeysForReaders } = await import(path.join(clientRoot!, "src/tooling-state-formats.ts"));
  const { observeConfigurationRefusal, configurationValidationFailure } = await import(path.join(clientRoot!, "src/runtime-configuration-refusal-observer.ts"));
  const { repairConfigurationRefusal } = await import("./configuration-refusal-repair.ts");
  const tree = git(f.tooling, "rev-parse", "HEAD^{tree}");
  const old = await f.prisma.toolingRelease.create({ data: { id: "original-release", repositoryId: f.task.repositoryId, revision: f.toolingRevision, tree,
    policyBlob: git(f.tooling, "rev-parse", "HEAD:runtime.md"), checkout: f.checkout, manifest: f.toolingManifest, lockfileDigest: "0".repeat(64), bunVersion: Bun.version } });
  await f.prisma.toolingSelection.create({ data: { repositoryId: f.task.repositoryId, generation: 1, releaseId: old.id, activatedAt: new Date() } });
  const release = () => Promise.resolve({ checkout: f.checkout, revision: f.toolingRevision, tree, manifest: f.toolingManifest });
  const operationClient = operations.toolingOperationClient(f.socket);
  const interrupted: string[] = [];
  const values = { task: f.task.id, config: f.configFile, "state-directory": f.root, purpose };
  const start = async (action: string, extra: Record<string, string> = {}) => {
    const session = await operations.bindCliOperation({ positionals: ["runtime", action], values: { ...values, ...(review && action === "up" ? { commit: f.productRevision } : {}), ...extra }, taskId: f.task.id, socket: f.socket,
      task: () => f.registry.task(), files: { config: await readFile(f.configFile) }, release, client: operationClient, journalDirectory: f.root });
    f.control.bindControlOperation(session); return session;
  };
  cleanup.push(async () => f.control.bindControlOperation(null));
  let session = await start("up");
  expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile })).phase).toBe("waiting-compute");
  await session.complete(); f.control.bindControlOperation(null);
  const offer = await f.deliver(); session = await start("up", { "compute-offer": offer.id });
  const unhealthy = { ...f.input, request: async () => new Response("Unavailable", { status: 503 }) };
  if (unsettled) {
    await expect(f.client.manageRuntime({ ...unhealthy, action: "up", configFile: f.configFile, computeOffer: offer.id })).rejects.toThrow();
    interrupted.push(session.operationId!);
  } else {
    expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: offer.id })).phase).toBe("ready");
    await session.complete();
  }
  f.control.bindControlOperation(null); if (!unsettled) await f.settled(offer);
  // A prior successful configuration owns this offer; the next correction
  // must not bypass that ownership merely by selecting a newer executable.
  let recipe = await Bun.file(f.configFile).json(); recipe.readyTimeoutSeconds = 2; await savePrivate(f.configFile, recipe);
  if (!review) {
    session = await start("configure");
    if (unsettled) {
      await expect(f.client.manageRuntime({ ...unhealthy, action: "configure", configFile: f.configFile })).rejects.toThrow();
      interrupted.push(session.operationId!);
    } else {
      expect((await f.client.manageRuntime({ ...f.input, action: "configure", configFile: f.configFile })).phase).toBe("ready");
      await session.complete();
    }
  }
  f.control.bindControlOperation(null);
  if (unsettled) await f.settled(offer);
  recipe = await Bun.file(f.configFile).json();
  if (review) recipe.services.web.environment = { ...recipe.services.web.environment, NODE_OPTIONS: "--max-old-space-size=6144" };
  else recipe.checks[1].path = "/";
  await savePrivate(f.configFile, recipe);
  const failed = await start("configure");
  const resource = (await f.registry.task()).resources.find((r: any) => r.key === `runtime-${purpose}`)!;
  const state = await Bun.file(resource.externalId).json(), original = structuredClone(state), effects = [...f.effects];
  const history = await f.prisma.runtimeMetadataEvent.findMany({ where: { action: "tooling-operation-association", source: `tooling-operation:${f.task.id}` }, orderBy: { sequence: "asc" } });
  // Persist the exact old reader's validation-refusal boundary: only its
  // failed progress write exists, with no configuration journal or callback.
  if (!review) {
    state.phase = "failed"; state.progress = { step: "health", detail: configurationValidationFailure, state: "failed", updatedAt: new Date().toISOString() };
    const authority = sessionStateAuthority(failed);
    await saveRuntimeStateFile(resource.externalId, state, { authority: "bound", scopeKey: "runtime-development", registerWrite: authority.evidence.registerWrite, lossKeys: lossKeysForReaders((await authority.evidence.read({ family: "drafted.runtime", scopeKey: "runtime-development" })).consumers) });
    await f.registry.resource({ key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId, state: "failed", metadata: { ...resource.metadata, observed: "failed", progress: state.progress } });
  } else {
    // Frozen old review preflight stopped before any lock, receipt or callback.
    expect(await f.prisma.toolingStateWrite.count({ where: { operationId: failed.operationId! } })).toBe(0);
    expect(await f.prisma.toolingOperation.count({ where: { parentOperationId: failed.operationId! } })).toBe(0);
    git(f.task.worktreePath!, "commit", "--allow-empty", "-qm", "Later development must not select review source");
  }
  f.control.bindControlOperation(null);
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: true } });
  f.runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: Date.now() });
  await writeFile(path.join(f.tooling, "corrected.txt"), "Corrected validation reader fixture\n"); git(f.tooling, "add", "."); git(f.tooling, "commit", "--quiet", "-m", "Corrected reader");
  const revision = git(f.tooling, "rev-parse", "HEAD"), correctedTree = git(f.tooling, "rev-parse", "HEAD^{tree}"), checkout = path.join(f.config.installRoot, "tooling", f.task.repositoryId, revision);
  git(f.tooling, "worktree", "add", "--detach", checkout, revision); await writeFile(`${checkout}.ready`, `${revision}\n`);
  const corrected = await f.prisma.toolingRelease.create({ data: { ...old, manifest: f.toolingManifest, id: "corrected-release", revision, tree: correctedTree, checkout } });
  await f.prisma.toolingSelection.update({ where: { repositoryId: f.task.repositoryId }, data: { generation: 2, releaseId: corrected.id } });
  const repairInput = { ...f, repositoryId: f.task.repositoryId, taskId: f.task.id, request: { requestKey: "repair-original-refusal", operationId: failed.operationId!,
    expectedInputDigest: failed.guard.binding.inputDigest, expectedGeneration: 2, values } };
  const repaired = await repairConfigurationRefusal(repairInput, { observe: (_release, raw) => observeConfigurationRefusal(raw, f.input.docker) });
  expect(f.effects).toEqual(effects);
  expect(await repairConfigurationRefusal(repairInput, { observe: async () => { throw new Error("replay must not observe"); } })).toEqual(repaired);
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { ownerPaused: false } });
  if (unsettled) {
    await refreshComputeObservation({ ...f, environmentId: offer.environmentId });
    await reconcileObservedCompute({ ...f.admission, environmentId: offer.environmentId, runtime: f.runtime });
  }
  const successor = await operations.bindCliOperation({ positionals: ["runtime", "configure"], values, taskId: f.task.id, socket: f.socket,
    task: () => f.registry.task(), files: { config: await readFile(f.configFile) }, client: operationClient, journalDirectory: f.root,
    env: { REMOTE_AGENT_TOOLING_OPERATION: repaired.binding.operationId }, release: async () => ({ checkout, revision, tree: correctedTree, manifest: f.toolingManifest }) });
  f.control.bindControlOperation(successor);
  const configure = f.registry.configureCompute; let drop = lost || unsettled;
  f.registry.configureCompute = async (request: any) => { const result = await configure(request); if (drop) { drop = false; throw new Error("Lost repaired configuration response"); } return result; };
  if (lost || unsettled) {
    await expect(f.client.manageRuntime({ ...f.input, action: "configure", configFile: f.configFile })).rejects.toThrow("Lost repaired configuration response");
    expect(f.container().running).toBe(false);
    if (unsettled) {
      await refreshComputeObservation({ ...f, environmentId: offer.environmentId });
      await reconcileObservedCompute({ ...f.admission, environmentId: offer.environmentId, runtime: f.runtime });
      expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("stopped");
    }
  }
  expect((await f.client.manageRuntime({ ...f.input, action: "configure", configFile: f.configFile })).phase).toBe(unsettled ? "waiting-compute" : "ready");
  await successor.complete(); f.control.bindControlOperation(null);
  const after = await Bun.file(resource.externalId).json();
  for (const field of ["container", "resources", "network", "dependencyVolume", "ports", "urls", "fingerprints"]) expect(after[field]).toEqual(original[field]);
  if (review) {
    expect(after.recipe.services.web.environment.NODE_OPTIONS).toBe("--max-old-space-size=6144");
    expect(after.worktree).toBe(original.worktree); expect(after.revision).toBe(f.productRevision);
    expect(after.recipe.checks).toEqual(original.recipe.checks);
  } else expect(after.recipe.checks[1].path).toBe("/");
  expect(after.configuration).toBeUndefined();
  expect((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).toolingRevision).toBe(f.task.toolingRevision);
  expect((await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id: failed.operationId! } })).completionEvidence).toEqual({ kind: "configuration-validation-failed", reference: repaired.binding.operationId });
  expect(f.effects.filter(effect => effect === "create")).toHaveLength(1);
  if (unsettled) {
    const next = await f.deliver();
    expect(next.id).not.toBe(offer.id);
    const restart = await operations.bindCliOperation({ positionals: ["runtime", "up"], values: { ...values, "compute-offer": next.id }, taskId: f.task.id, socket: f.socket,
      task: () => f.registry.task(), files: { config: await readFile(f.configFile) }, client: operationClient, journalDirectory: f.root,
      release: async () => ({ checkout, revision, tree: correctedTree, manifest: f.toolingManifest }) });
    f.control.bindControlOperation(restart);
    expect((await f.client.manageRuntime({ ...f.input, action: "up", configFile: f.configFile, computeOffer: next.id })).phase).toBe("ready");
    await restart.complete(); f.control.bindControlOperation(null);
    for (const id of interrupted) {
      const retired = await f.prisma.toolingOperation.findUniqueOrThrow({ where: { id } });
      expect(retired.completionEvidence).toEqual({ kind: "runtime-command-superseded", reference: successor.operationId });
      const response = await fetch(`http://remote-agent/api/sessions/${f.task.primarySessionId}/tooling-operations/${id}/settlement`, { method: "POST", unix: f.socket,
        headers: { "content-type": "application/json", "x-remote-agent-operation": id }, body: JSON.stringify({ requestKey: retired.requestKey, inputDigest: retired.inputDigest, outcome: "completed" }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "operation-closed" });
    }
    for (const event of history) expect(await f.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: event.sequence } })).toEqual(event);
    expect(f.container()).toMatchObject({ id: original.container.id, running: true });
    expect(f.effects.filter(effect => effect === "create")).toHaveLength(1);
    expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("stopped");
  }
}, 30_000);
