import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../app.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { confirmComputeDelivery, offerNextCompute, reconcileObservedCompute } from "./compute-admission.ts";
import { refreshComputeObservation } from "./compute-observer.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { tickCompute } from "./compute-worker.ts";

const clientRoot = process.env.DRAFTED_INTEGRATION_ROOT;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** Actual Unix task registry and configured observer call the client saved
 * adapter. Only the physical Docker transport is a disposable file fixture;
 * delivery uses genuine persisted lifecycle events, not a provider process. */
test.skipIf(!clientRoot).each(["after-stopped", "while-running"])("saved container commit %s retains history and resumes the same instance at new HEAD", async when => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "saved-compute-pair-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = await createTestDatabase(); cleanup.push(db.cleanup); const { prisma } = db;
  const product = path.join(root, "product"), tooling = path.join(root, "tooling"), physicalFile = path.join(root, "physical.json"), socket = path.join(root, "control.sock");
  for (const directory of [product, tooling]) { await mkdir(directory); git(directory, "init", "-q"); git(directory, "config", "user.name", "Fixture"); git(directory, "config", "user.email", "fixture@example.invalid"); }
  git(product, "commit", "--allow-empty", "-qm", "original product"); const firstRevision = git(product, "rev-parse", "HEAD");
  const original = { Id: "a".repeat(64), Created: "2026-01-01T00:00:00Z", Image: `sha256:${"b".repeat(64)}`, Name: "/saved-app",
    Config: { Labels: { "dev.drafted.task": "saved-task", "dev.drafted.purpose": "development" } }, State: { Running: false }, NetworkSettings: { Networks: {} }, Mounts: [] };
  const physical = structuredClone(original); const sync = () => writeFile(physicalFile, JSON.stringify(physical), { mode: 0o600 }); await sync();
  await writeFile(path.join(tooling, "runtime.md"), "Disposable physical Docker transport for the actual client observer.\n");
  await writeFile(path.join(tooling, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { runtime: { instructions: "runtime.md", adapter: "observe.ts", observationContracts: ["compute-traffic/v1"] } } }));
  await writeFile(path.join(tooling, "observe.ts"), `
import { observeCompute } from ${JSON.stringify(path.join(clientRoot!, "src/compute-coverage.ts"))};
const input = JSON.parse(await Bun.stdin.text());
const docker = async (args) => {
  const value = await Bun.file(${JSON.stringify(physicalFile)}).json();
  if (args.join(" ") === "container ls -aq --no-trunc") return value.Id;
  if (args[0] === "container" && args[1] === "inspect" && args[2] === value.Id) return JSON.stringify([value]);
  throw new Error("Unexpected observer effect");
};
console.log(JSON.stringify(await observeCompute(input, { docker, request: fetch, json: async () => { throw new Error("No traffic configuration"); }, bytes: async () => { throw new Error("No traffic configuration"); } })));
`);
  git(tooling, "add", "."); git(tooling, "commit", "-qm", "immutable observer fixture"); const toolingRevision = git(tooling, "rev-parse", "HEAD");
  const config = testConfig({ installRoot: path.join(root, "install"), controlIpcPath: socket, compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
  config.repository = { ...config.repository, root: product, tooling: { root: tooling, revision: toolingRevision } }; config.repositories = { [config.repository.id]: config.repository };
  const checkout = path.join(config.installRoot, "tooling", config.repository.id, toolingRevision);
  await mkdir(path.dirname(checkout), { recursive: true }); git(tooling, "worktree", "add", "--detach", checkout, toolingRevision); await writeFile(`${checkout}.ready`, `${toolingRevision}\n`);
  const task = await prisma.remoteTask.create({ data: { id: "saved-task", requestKey: "saved-task", repositoryId: config.repository.id, machineId: config.machine,
    primarySessionId: "saved-primary", worktreePath: product, branchName: "codex/saved", phase: "working", toolingRoot: tooling, pinnedToolingRoot: checkout, toolingRevision } });
  const primary = { id: task.primarySessionId!, role: "primary" as const, status: "idle" as const, cwd: product, repositoryId: task.repositoryId, machineId: task.machineId };
  await prisma.runtimeSession.create({ data: { ...primary, scopeKey: task.id, agentCommand: "codex" } });
  const resource = await prisma.remoteTaskResource.create({ data: { id: "saved-app", taskId: task.id, key: "app", kind: "docker-container", purpose: "development", externalId: original.Id, state: "allocated", metadata: { image: original.Image, createdAt: original.Created } } });
  const identity = finalizationResourceIdentity(resource);
  const runtime = createFakeAgentRuntime([primary]), app = createApp({ config, prisma, agentRuntime: runtime, trustLocal: true });
  const server = Bun.serve({ unix: socket, fetch: app.fetch }); cleanup.push(async () => { await server.stop(true); });
  const { taskRegistry } = await import(path.join(clientRoot!, "src/control.ts"));
  const { dockerResources, manageResource } = await import(path.join(clientRoot!, "src/resources.ts"));
  const registry = taskRegistry(socket, task.id), effects: string[] = [];
  const docker = dockerResources(async (...args: string[]) => {
    if (args.join(" ") === "container ls -aq --no-trunc") return physical.Id;
    if (args[0] === "container" && args[1] === "inspect" && args[2] === physical.Id) return JSON.stringify([physical]);
    if (args[0] === "container" && ["start", "stop"].includes(args[1]!) && args.at(-1) === physical.Id) { effects.push(args[1]!); physical.State.Running = args[1] === "start"; await sync(); return physical.Id; }
    throw new Error("Unexpected physical mutation");
  });
  const manage = (action: "resume" | "stop", computeOffer?: string) => manageResource({ registry, key: resource.key, action, docker, computeOffer });
  const context = { prisma, machineId: config.machine, policy: config.compute! };
  const deliver = async () => {
    const offer = await prisma.computeOffer.findFirstOrThrow({ where: { environmentId, state: "queued" } });
    await prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "dispatching", executionRequestId: offer.instructionId } });
    await prisma.runtimeLifecycleEvent.create({ data: { id: `${offer.id}:started`, runtimeSessionId: primary.id, requestId: offer.instructionId, phase: "started", occurredAt: new Date() } });
    await confirmComputeDelivery({ ...context, sessionId: primary.id, requestId: offer.instructionId }); return offer;
  };
  const settle = async (offer: Awaited<ReturnType<typeof deliver>>) => {
    await prisma.runtimeInstruction.update({ where: { id: offer.instructionId }, data: { state: "completed" } });
    await prisma.runtimeLifecycleEvent.create({ data: { id: `${offer.id}:completed`, runtimeSessionId: primary.id, requestId: offer.instructionId, phase: "completed", occurredAt: new Date() } });
  };
  expect(await manage("resume")).toMatchObject({ phase: "waiting-compute" });
  const environmentId = (await prisma.computeEnvironment.findFirstOrThrow()).id;
  const refresh = () => refreshComputeObservation({ prisma, config, environmentId });
  const reconcile = () => reconcileObservedCompute({ ...context, environmentId, runtime });
  await refresh(); await offerNextCompute(context); const first = await deliver();
  expect(await manage("resume", first.id)).toMatchObject({ state: "ready" });
  await refresh(); expect(await reconcile()).toEqual({ released: false }); await settle(first);
  if (when === "while-running") {
    git(product, "commit", "--allow-empty", "-qm", "ordinary product change during development");
    expect((await refresh()).revision).toBe(git(product, "rev-parse", "HEAD"));
    expect(await reconcile()).toEqual({ released: false });
    await expect(manage("resume")).rejects.toThrow();
    expect((await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environmentId } })).revision).toBe(firstRevision);
    expect((await prisma.computeSlot.findFirstOrThrow({ where: { allocationId: first.id } })).allocationId).toBe(first.id);
  }
  await manage("stop");
  expect(await tickCompute({ prisma, config, runtime }, { consider: async () => { throw new Error("Physical-only coverage must never reach Decisions"); }, evidence: async () => { throw new Error("Physical-only saved mode has no idle evidence"); } })).toEqual({ observed: 1, unavailable: 0 });
  const retired = await prisma.computeOffer.findUniqueOrThrow({ where: { id: first.id } }); expect(retired.state).toBe("stopped");
  if (when === "after-stopped") git(product, "commit", "--allow-empty", "-qm", "ordinary product change");
  const nextRevision = git(product, "rev-parse", "HEAD"); expect(nextRevision).not.toBe(firstRevision);
  expect(await manage("resume")).toMatchObject({ phase: "waiting-compute" });
  const next = await prisma.computeEnvironment.findUniqueOrThrow({ where: { id: environmentId } }); expect(next.revision).toBe(nextRevision);
  const second = await deliver(); expect(await manage("resume", second.id)).toMatchObject({ state: "ready" });
  expect(await prisma.computeOffer.findUniqueOrThrow({ where: { id: first.id } })).toEqual(retired);
  expect(effects).toEqual(["start", "stop", "start"]);
  expect(await prisma.computeEnvironment.count()).toBe(1); expect(await prisma.remoteTaskResource.count()).toBe(1);
  expect(finalizationResourceIdentity(await prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: resource.id } }))).toEqual(identity);
  const fact = await prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "compute-saved-revision" } });
  expect(JSON.parse(fact.value!)).toMatchObject({ environmentId, fromRevision: firstRevision, toRevision: nextRevision, observation: { revision: nextRevision, state: "stopped", coverage: "incomplete" } });
  expect(physical.Id).toBe(original.Id); expect(physical.Created).toBe(original.Created);
}, 30_000);
