import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CleanupObserverBatchInput, CleanupTarget, cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { assertFinalizationResources, finalizationDigest, finalizationResourceIdentity, prepareFinalizationResources, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";
import { assertRegisteredCaptureSharing } from "./cleanup-filesystem.ts";
import { observeLegacyEvidenceFile } from "./legacy-evidence-files.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "browser-vault-capture-"))); roots.push(root); await chmod(root, 0o700);
  const directory = path.join(root, ".agent-browser", "auth"), file = path.join(directory, "dra42-cmvraeev-clerk.json"), keyFile = path.join(path.dirname(directory), ".encryption-key");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(file, "opaque encrypted credential fixture", { mode: 0o600 }); await writeFile(keyFile, "a".repeat(64), { mode: 0o600 });
  await writeFile(path.join(directory, "unrelated.json"), "unrelated entry stays byte-for-byte", { mode: 0o600 });
  const taskId = "cmvraeev-original-task", resource: FinalizationResourceRecord = { id: "vault", key: "browser-auth-vault", kind: "browser-auth", purpose: "browser", externalId: "agent-browser:drafted:dra42-cmvraeev-clerk", state: "allocated",
    metadata: { entry: "dra42-cmvraeev-clerk", namespace: "drafted", origin: "http://localhost:19570", source: "task-owned test identity", toolingRoot: path.join(root, "old-code-do-not-execute") } };
  const resources = [resource], context = { task: { id: taskId, primarySessionId: "primary", worktreePath: path.join(root, "product"), toolingRevision: "a".repeat(40) },
    capability: { version: 1 as const, source: "configured-host" as const, checkout: path.join(root, "configured-cleanup"), revision: "b".repeat(40), adapter: path.join(root, "configured-cleanup/src/cli.ts"), adapterSha256: "c".repeat(64) } };
  const observation: ResourceObservation = { rootIdle: async () => {}, pathsIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {}, browserVaultRoot: () => directory,
    adapters: async ({ request }) => {
      const input = CleanupObserverBatchInput.parse(request), selected = input.observations[0]!;
      const exists = await lstat(file).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
      const raw = input.stage === "prepare" ? CleanupTarget.parse({ kind: "browser-auth-entry", id: "dra42-cmvraeev-clerk", scope: { taskId, purpose: "browser", namespace: "drafted", keyFile, keySha256: hash(await readFile(keyFile)) },
        file: await observeLegacyEvidenceFile(file, true), origin: "http://localhost:19570", usernameDigest: hash("task+clerk_test@example.com"), presentAtPrepare: true, identityDigest: "0".repeat(64) }) : null;
      const targets = selected.expectedTargets ?? [{ ...raw!, identityDigest: cleanupTargetDigest(raw!) }];
      return { version: 1, taskId, observations: [{ version: 1, taskId, resourceId: resource.id, resourceIdentityDigest: finalizationResourceIdentity(resource).identityDigest,
        adapter: "vault", dependencies: [], stoppedConsumers: [], targets, absent: !exists, presentTargetDigests: exists ? targets.map(target => target.identityDigest) : [] }] };
    } };
  const input = { taskId, sessionId: "primary", resources, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [file] }, originalWork: true, toolingRoot: path.join(root, "old-pin"), adapterContext: context };
  const prepare = () => prepareFinalizationResources(input, observation);
  const verify = (plan: Awaited<ReturnType<typeof prepare>>, removed = false) => assertFinalizationResources({ taskId, resources, plan, originalWork: true, removed }, observation);
  return { root, directory, file, keyFile, resource, resources, taskId, input, observation, prepare, verify };
}
function entryOf(plan: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["prepare"]>>) {
  const entry = plan.find(entry => entry.disposition === "retire-vault"); if (!entry || entry.disposition !== "retire-vault") throw new Error("Missing vault capture"); return entry;
}
async function capture(f: Awaited<ReturnType<typeof fixture>>, entry: ReturnType<typeof entryOf>, pending = false) {
  const { target } = entry; await mkdir(target.quarantine.directory, { mode: 0o700 }); const stat = await lstat(target.quarantine.directory);
  await writeFile(target.quarantine.journal, JSON.stringify({ version: 1, taskId: f.taskId, resourceId: entry.id, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path,
    source: { dev: target.dev, ino: target.ino, mode: target.mode }, quarantine: { dev: stat.dev, ino: stat.ino } }), { mode: 0o600 });
  if (!pending) await rename(target.path, target.quarantine.path);
}
test("vault capture retains only its exact encrypted entry and leaves the global key and unrelated entries intact", async () => {
  const f = await fixture(), plan = await f.prepare(), entry = entryOf(plan), key = await readFile(f.keyFile), original = await readFile(f.file);
  await capture(f, entry, true); await f.verify(plan); await expect(f.verify(plan, true)).rejects.toThrow();
  await rename(f.file, entry.target.quarantine.path); await f.verify(plan); f.resource.state = "released"; await f.verify(plan, true); await f.verify(plan, true);
  expect(await readFile(entry.target.quarantine.path)).toEqual(original); expect(await readFile(f.keyFile)).toEqual(key);
  expect(await readFile(path.join(f.directory, "unrelated.json"), "utf8")).toBe("unrelated entry stays byte-for-byte");
  expect((await lstat(entry.target.quarantine.path)).ino).toBe(entry.target.ino);
});
test.each(["wrong-entry", "wrong-namespace", "wrong-origin", "unselected", "shared-parent", "shared-key", "other-resource", "protected"])("vault preparation refuses %s without moving data", async changed => {
  const f = await fixture(), metadata = f.resource.metadata as Record<string, unknown>;
  if (changed === "wrong-entry") metadata.entry = "another-task";
  if (changed === "wrong-namespace") metadata.namespace = "another";
  if (changed === "wrong-origin") metadata.origin = "http://localhost:9999";
  if (changed === "unselected") f.input.ownership.ownedPaths = [];
  if (changed === "shared-parent") await chmod(f.directory, 0o755);
  if (changed === "shared-key") await chmod(f.keyFile, 0o644);
  if (changed === "other-resource") f.resources.push({ ...f.resource, id: "other", key: "other" });
  if (changed === "protected") f.input.toolingRoot = f.directory;
  await expect(f.prepare()).rejects.toThrow(); expect(await readFile(f.file, "utf8")).toBe("opaque encrypted credential fixture");
});
test.each(["recreated", "captured-bytes", "captured-inode", "key", "journal"])("vault confirmation rejects %s and preserves every available generation", async changed => {
  const f = await fixture(), plan = await f.prepare(), entry = entryOf(plan); await capture(f, entry);
  if (changed === "recreated") await writeFile(f.file, "new unrelated credentials", { mode: 0o600 });
  if (changed === "captured-bytes") await writeFile(entry.target.quarantine.path, "changed encrypted bytes");
  if (changed === "captured-inode") { await rename(entry.target.quarantine.path, path.join(f.root, "original-retained")); await writeFile(entry.target.quarantine.path, "opaque encrypted credential fixture", { mode: 0o600 }); }
  if (changed === "key") await writeFile(f.keyFile, "b".repeat(64));
  if (changed === "journal") { const journal = JSON.parse(await readFile(entry.target.quarantine.journal, "utf8")); journal.resourceId = "another"; await writeFile(entry.target.quarantine.journal, JSON.stringify(journal)); }
  await expect(f.verify(plan)).rejects.toThrow();
  if (changed === "recreated") expect(await readFile(f.file, "utf8")).toBe("new unrelated credentials");
  if (changed === "captured-inode") expect(await readFile(path.join(f.root, "original-retained"), "utf8")).toBe("opaque encrypted credential fixture");
});
test("vault sharing checks include the non-path provider name as well as exact capture paths", async () => {
  const f = await fixture(), plan = await f.prepare(); let query: unknown;
  await assertRegisteredCaptureSharing({ remoteTaskResource: { findFirst: async (input: unknown) => { query = input; return null; } } } as never, f.taskId, plan);
  expect(JSON.stringify(query)).toContain(f.resource.externalId); expect(JSON.stringify(query)).toContain(f.file);
  await expect(assertRegisteredCaptureSharing({ remoteTaskResource: { findFirst: async () => ({ id: "foreign" }) } } as never, f.taskId, plan)).rejects.toThrow("another task");
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot)("actual prepared vault client retains exact encrypted bytes across lost capture acknowledgment and server confirmation", async () => {
  const f = await fixture();
  f.resources.push({ id: "user", key: "dev-clerk-test-user", kind: "clerk-test-user", purpose: "development", externalId: "user_Recorded", state: "released", metadata: { email: "dra42.cmvraeev+clerk_test@example.com" } });
  const { observeCleanupBatch } = await import(path.join(draftedRoot!, "src/cleanup-observer.ts"));
  const { releasePreparedResources } = await import(path.join(draftedRoot!, "src/finalization-resources.ts"));
  const { assertResourcePlan, FinalizationResourcePlan: ClientPlan } = await import(path.join(draftedRoot!, "src/finalization-plan.ts"));
  const { adapterReceipt } = await import(path.join(draftedRoot!, "test/fixtures/prepared-adapter.ts"));
  let shows = 0, lost = true;
  const vault = { root: f.directory, show: async (entry: string) => {
    expect(entry).toBe("dra42-cmvraeev-clerk"); shows++;
    return { name: entry, url: "http://localhost:19570/sign-in", username: "dra42.cmvraeev+clerk_test@example.com" };
  }, assertCapability: async (capability: unknown) => { expect(capability).toEqual(f.input.adapterContext.capability); } };
  f.observation.adapters = ({ request }) => observeCleanupBatch(request, { vault });
  const plan = await f.prepare(), selected = entryOf(plan), original = await readFile(f.file), key = await readFile(f.keyFile);
  const task = { ...f.input.adapterContext.task, phase: "waiting", finalizationVersion: 2, resources: f.resources }, prepared = adapterReceipt(task, plan.map(entry => ClientPlan.parse(entry))), writes: string[] = [];
  const registry = { task: async () => structuredClone(task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: { key: string; state: string }) => {
    writes.push(update.key); Object.assign(f.resources.find(resource => resource.key === update.key)!, update); await f.verify(plan);
  } };
  const run = () => releasePreparedResources({ registry, prepared, observation: f.observation, adapters: { observer: { vault } }, assertAuthority: () => f.verify(plan),
    assertBatchAuthority: async () => { assertResourcePlan(task, prepared.resources); }, fileCaptureHooks: { afterCapture: () => { if (lost) { lost = false; throw new Error("lost vault capture acknowledgment"); } } } });
  const partial = await run(); expect(partial.results.some((entry: { outcome: string }) => entry.outcome === "failed")).toBeTrue(); expect(writes).toEqual([]);
  await f.verify(plan); const journal = await readFile(selected.target.quarantine.journal), captured = await lstat(selected.target.quarantine.path), priorShows = shows;
  const retried = await run(); expect(retried.results.some((entry: { outcome: string }) => entry.outcome === "failed")).toBeFalse(); await f.verify(plan, true);
  await run(); await f.verify(plan, true); expect(writes).toEqual(["browser-auth-vault"]); expect(shows).toBe(priorShows);
  expect(await readFile(selected.target.quarantine.journal)).toEqual(journal); expect((await lstat(selected.target.quarantine.path)).ino).toBe(captured.ino);
  expect(await readFile(selected.target.quarantine.path)).toEqual(original); expect(await readFile(f.keyFile)).toEqual(key);
  expect(await readFile(path.join(f.directory, "unrelated.json"), "utf8")).toBe("unrelated entry stays byte-for-byte");
}, 30_000);
