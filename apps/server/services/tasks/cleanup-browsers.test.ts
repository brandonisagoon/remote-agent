import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CleanupObserverBatchInput, CleanupTarget, cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { assertFinalizationResources, finalizationDigest, finalizationResourceIdentity, prepareFinalizationResources, type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(registered = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "prepared-browser-"))); roots.push(directory); await chmod(directory, 0o700);
  const environment = path.join(directory, "environment"), root = path.join(environment, "browser"), profile = path.join(root, "profile"), ownerFile = path.join(root, "profile-owner.json");
  await mkdir(profile, { recursive: true, mode: 0o700 }); await chmod(environment, 0o700); await chmod(root, 0o700);
  await writeFile(path.join(profile, "Cookies"), "private opaque cookie bytes", { mode: 0o600 });
  const bytes = Buffer.from(JSON.stringify({ taskId: "task", profile, nonce: randomUUID(), session: "task" })); await writeFile(ownerFile, bytes, { mode: 0o600 });
  await writeFile(path.join(root, "browser-task.json"), "private offline context", { mode: 0o600 });
  const browser: FinalizationResourceRecord = { id: "browser", key: "browser-profile", kind: "browser-profile", purpose: "browser", externalId: profile, state: "ready",
    metadata: { namespace: "drafted", session: "task", ownerFile, ownerSha256: hash(bytes), toolingRoot: path.join(directory, "historical-tooling-do-not-execute") } };
  const resources: FinalizationResourceRecord[] = [browser];
  if (registered) resources.unshift({ id: "environment", key: "environment", kind: "private-directory", purpose: "development", externalId: environment, state: "ready", metadata: {} });
  const capability = { version: 1 as const, source: "configured-host" as const, checkout: path.join(directory, "configured-cleanup"), revision: "b".repeat(40), adapter: path.join(directory, "configured-cleanup/src/cli.ts"), adapterSha256: "c".repeat(64) };
  const input = { taskId: "task", sessionId: "primary", resources, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [registered ? environment : root] }, originalWork: true,
    toolingRoot: path.join(directory, "original-pinned-tooling"), adapterContext: { capability, task: { id: "task", primarySessionId: "primary", worktreePath: path.join(directory, "product"), toolingRevision: "a".repeat(40) } } };
  let running = true, calls = 0;
  const observation: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => { throw new Error("Must not execute old metadata-selected tooling"); },
    adapters: async ({ capability: selected, request }) => {
      expect(selected).toEqual(capability); calls++;
      const batch = CleanupObserverBatchInput.parse(request);
      const stat = batch.stage === "prepare" ? await lstat(profile) : null;
      const raw = stat && { kind: "browser-session", id: "task", scope: { taskId: "task", purpose: "browser", namespace: "drafted" }, presentAtPrepare: running,
        profile: { path: profile, dev: stat.dev, ino: stat.ino, mode: stat.mode, ownerFile, ownerSha256: hash(bytes) } };
      const parsed = raw && CleanupTarget.parse({ ...raw, identityDigest: "0".repeat(64) });
      const targets = batch.observations[0]!.expectedTargets ?? [{ ...parsed!, identityDigest: cleanupTargetDigest(parsed!) }];
      return { version: 1, taskId: "task", observations: [{ version: 1, taskId: "task", resourceId: "browser", resourceIdentityDigest: finalizationResourceIdentity(browser).identityDigest,
        adapter: "browser", dependencies: [], stoppedConsumers: [], targets, presentTargetDigests: running ? targets.map(target => target.identityDigest) : [], absent: !running }] };
    } };
  const prepare = () => prepareFinalizationResources(input, observation);
  const verify = (plan: FinalizationResourcePlan[], removed = false) => assertFinalizationResources({ taskId: "task", resources, plan, removed, originalWork: true }, observation);
  return { directory, environment, root, profile, ownerFile, browser, resources, input, prepare, verify, setRunning: (value: boolean) => { running = value; }, calls: () => calls };
}
function captureTarget(plan: FinalizationResourcePlan[]) {
  const browser = plan.find(entry => entry.disposition === "retire-browser");
  if (!browser || browser.disposition !== "retire-browser") throw new Error("Missing browser");
  if (browser.capture.type === "standalone") return { id: browser.id, target: browser.capture.target };
  const capture = browser.capture, parent = plan.find(entry => entry.id === capture.parentResourceId);
  if (!parent || parent.disposition !== "retire-tree") throw new Error("Missing registered parent"); return { id: parent.id, target: parent.target };
}
async function capture(plan: FinalizationResourcePlan[]) {
  const selected = captureTarget(plan), { target } = selected, original = target.inventory[0]!;
  await mkdir(target.quarantine.directory, { mode: 0o700 }); const stat = await lstat(target.quarantine.directory);
  await writeFile(target.quarantine.journal, JSON.stringify({ version: 1, taskId: "task", resourceId: selected.id, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path,
    source: { dev: original.dev, ino: original.ino, mode: original.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600 });
  await rename(target.path, target.quarantine.path);
}
test.each([false, true])("configured capability preserves legacy browser bytes and confirms exact capture (registered=%s)", async registered => {
  const f = await fixture(registered), plan = await f.prepare(), selected = captureTarget(plan), original = structuredClone(f.browser.metadata);
  const opaque = selected.target.inventory.filter(entry => entry.kind === "opaque"); expect(opaque).toHaveLength(1); expect(opaque[0]!.dependencyResourceId).toBe("browser");
  expect(selected.target.inventory.some(entry => entry.path.endsWith("Cookies"))).toBeFalse();
  await f.verify(plan); await capture(plan); await expect(f.verify(plan)).rejects.toThrow(registered ? "consumer" : "session absence");
  f.setRunning(false); await f.verify(plan); for (const resource of f.resources) resource.state = "released";
  await f.verify(plan, true); await f.verify(plan, true);
  expect(f.browser.metadata).toEqual(original);
  expect(await readFile(path.join(selected.target.quarantine.path, path.relative(selected.target.path, f.profile), "Cookies"), "utf8")).toBe("private opaque cookie bytes");
  expect(f.calls()).toBeGreaterThan(3);
});
test.each(["wrong-task", "wrong-marker", "shared-profile", "unselected", "overlapping-resource"])("browser capture refuses %s before adoption", async change => {
  const f = await fixture();
  if (change === "wrong-task") (f.browser.metadata as Record<string, unknown>).session = "another-task";
  if (change === "wrong-marker") await writeFile(f.ownerFile, "different owner", { mode: 0o600 });
  if (change === "shared-profile") await chmod(f.profile, 0o755);
  if (change === "unselected") f.input.ownership.ownedPaths = [];
  if (change === "overlapping-resource") f.resources.push({ ...f.browser, id: "other", key: "other", kind: "private-file", externalId: path.join(f.root, "browser-task.json") });
  await expect(f.prepare()).rejects.toThrow(); expect(await readFile(path.join(f.profile, "Cookies"), "utf8")).toBe("private opaque cookie bytes");
});
test.each(["marker", "profile", "source-recreated", "context"])("captured browser refuses %s substitution while retaining original material", async change => {
  const f = await fixture(), plan = await f.prepare(), { target } = captureTarget(plan); await capture(plan); f.setRunning(false);
  if (change === "marker") await writeFile(path.join(target.quarantine.path, "profile-owner.json"), "changed marker");
  if (change === "profile") { await rename(path.join(target.quarantine.path, "profile"), path.join(f.directory, "original-profile")); await mkdir(path.join(target.quarantine.path, "profile"), { mode: 0o700 }); }
  if (change === "source-recreated") await mkdir(f.root, { mode: 0o700 });
  if (change === "context") { const file = path.join(target.quarantine.path, "browser-task.json"); await rename(file, path.join(f.directory, "context-retained")); await symlink(path.join(f.directory, "context-retained"), file); }
  await expect(f.verify(plan)).rejects.toThrow();
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot).each([false, true])("actual prepared client closes only the selected browser and retains native capture across retry (registered=%s)", async registered => {
  const f = await fixture(registered), plan = await f.prepare(), selected = captureTarget(plan);
  const { releasePreparedResources } = await import(path.join(draftedRoot!, "src/finalization-resources.ts"));
  const { assertResourcePlan, FinalizationResourcePlan: ClientPlan } = await import(path.join(draftedRoot!, "src/finalization-plan.ts"));
  const { adapterReceipt } = await import(path.join(draftedRoot!, "test/fixtures/prepared-adapter.ts"));
  const task = { id: "task", primarySessionId: "primary", worktreePath: f.input.adapterContext.task.worktreePath, toolingRevision: "a".repeat(40), phase: "waiting", finalizationVersion: 2, resources: f.resources };
  const prepared = adapterReceipt(task, plan.map(entry => ClientPlan.parse(entry))), writes: string[] = [], closes: string[] = [];
  let running = true, lost = true;
  const registry = { task: async () => structuredClone(task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: { key: string; state: string }) => {
    writes.push(update.key); Object.assign(f.resources.find(resource => resource.key === update.key)!, update); await f.verify(plan);
  } };
  const browser = { sessions: async () => running ? ["task", "unrelated-session"] : ["unrelated-session"],
    close: async (session: string) => { expect(session).toBe("task"); closes.push(session); running = false; f.setRunning(false); },
    assertCapability: async (capability: unknown) => { expect(capability).toEqual(f.input.adapterContext.capability); } };
  const run = () => releasePreparedResources({ registry, prepared, observation: { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => { throw new Error("Old receipt-selected browser must not execute"); } },
    adapters: { observer: { browser } }, assertAuthority: () => f.verify(plan), assertBatchAuthority: async () => { assertResourcePlan(task, prepared.resources); },
    captureHooks: { afterCapture: () => { if (lost) { lost = false; throw new Error("lost browser capture acknowledgment"); } } } });
  const partial = await run(); expect(partial.results.some((entry: { outcome: string }) => entry.outcome === "failed")).toBeTrue(); expect(writes).toEqual([]); expect(closes).toEqual(["task"]);
  await f.verify(plan); const journal = await readFile(selected.target.quarantine.journal), captured = await lstat(selected.target.quarantine.path);
  const retried = await run(); expect(retried.results.every((entry: { outcome: string }) => entry.outcome === "retired-to-recoverable-quarantine")).toBeTrue();
  await f.verify(plan, true); await run(); await f.verify(plan, true);
  expect(closes).toEqual(["task"]); expect(writes).toEqual(registered ? ["environment", "browser-profile"] : ["browser-profile"]);
  expect((await lstat(selected.target.quarantine.path)).ino).toBe(captured.ino); expect(await readFile(selected.target.quarantine.journal)).toEqual(journal);
  expect(await readFile(path.join(selected.target.quarantine.path, path.relative(selected.target.path, f.profile), "Cookies"), "utf8")).toBe("private opaque cookie bytes");
  expect((f.browser.metadata as Record<string, unknown>).toolingRoot).toBe(path.join(f.directory, "historical-tooling-do-not-execute"));
  running = true; f.setRunning(true); const recreated = await run(); expect(recreated.results.some((entry: { outcome: string }) => entry.outcome === "failed")).toBeTrue(); expect(closes).toEqual(["task"]);
}, 30000);
