import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertRegisteredCaptureSharing } from "./cleanup-filesystem.ts";
import { CleanupObserverBatchInput, CleanupTarget, cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { assertFinalizationResources, finalizationDigest, prepareFinalizationResources, type FinalizationResourcePlan, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const quiet: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "registered-capture-"))); roots.push(directory); await chmod(directory, 0o700);
  const root = path.join(directory, "original-task"), evidence = path.join(root, "evidence", "capture.txt"), secret = path.join(root, "private.env");
  await mkdir(path.dirname(evidence), { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  await writeFile(evidence, "exact evidence bytes", { mode: 0o600 }); await writeFile(secret, "PRIVATE_FIXTURE=preserved\n", { mode: 0o600 });
  const resources: FinalizationResourceRecord[] = [
    { id: "root", key: "task-env", kind: "private-directory", purpose: "development", externalId: root, state: "ready", metadata: { original: true } },
    { id: "evidence", key: "capture", kind: "evidence", purpose: "browser", externalId: evidence, state: "ready", metadata: {} },
    { id: "secret", key: "private-env", kind: "private-file", purpose: "review", externalId: secret, state: "ready", metadata: {} },
  ];
  const input = { resources, taskId: "task", sessionId: "primary", toolingRoot: path.join(directory, "immutable-tooling"), sourcePaths: [], deliveries: [], ownership: { ownedPaths: [root] }, originalWork: true };
  const prepare = (observation = quiet) => prepareFinalizationResources(input, observation);
  const verify = (plan: FinalizationResourcePlan[], removed = false, observation = quiet) => assertFinalizationResources({ taskId: "task", resources, plan, removed, originalWork: true }, observation);
  return { directory, root, evidence, secret, resources, input, prepare, verify };
}
function rootPlan(plan: FinalizationResourcePlan[]) {
  const tree = plan.find(entry => entry.disposition === "retire-tree");
  if (!tree || tree.disposition !== "retire-tree") throw new Error("Missing registered tree");
  return tree;
}
async function capture(plan: FinalizationResourcePlan[], onlyJournal = false) {
  const tree = rootPlan(plan), target = tree.target, root = target.inventory[0]!;
  await mkdir(target.quarantine.directory, { mode: 0o700 }); const destination = await lstat(target.quarantine.directory);
  await writeFile(target.quarantine.journal, JSON.stringify({ version: 1, taskId: "task", resourceId: tree.id, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path,
    source: { dev: root.dev, ino: root.ino, mode: root.mode }, quarantine: { dev: destination.dev, ino: destination.ino } }), { mode: 0o600, flag: "wx" });
  if (!onlyJournal) await rename(target.path, target.quarantine.path);
}

test("registered private directories preserve every byte and exact contained receipts on capture/retry", async () => {
  const f = await fixture(), plan = await f.prepare(), tree = rootPlan(plan);
  expect(plan.filter(entry => entry.disposition === "retire-contained")).toHaveLength(2);
  expect(tree.target.inventory.map(entry => entry.path)).toEqual([".", "evidence", "evidence/capture.txt", "private.env"]);
  await f.verify(plan); await capture(plan, true); await f.verify(plan);
  await expect(f.verify(plan, true)).rejects.toThrow("no verified retained capture");
  await rename(f.root, tree.target.quarantine.path);
  const journal = await readFile(tree.target.quarantine.journal), evidence = await readFile(path.join(tree.target.quarantine.path, "evidence/capture.txt"));
  for (const resource of f.resources) resource.state = "released";
  await f.verify(plan, true); await f.verify(plan, true);
  expect(await readFile(tree.target.quarantine.journal)).toEqual(journal);
  expect(await readFile(path.join(tree.target.quarantine.path, "evidence/capture.txt"))).toEqual(evidence);
  expect(await readFile(path.join(tree.target.quarantine.path, "private.env"), "utf8")).toBe("PRIVATE_FIXTURE=preserved\n");
  expect(await lstat(f.root).catch(() => null)).toBeNull();
});

test.each(["unselected", "shared-mode", "git-ancestor", "git-child", "recorded-hash", "duplicate-root", "unsupported-child", "protected-root"])("registered capture rejects %s before a plan is adopted", async change => {
  const f = await fixture();
  if (change === "unselected") f.input.ownership.ownedPaths = [];
  if (change === "shared-mode") await chmod(f.root, 0o755);
  if (change === "git-ancestor") await mkdir(path.join(f.directory, ".git"));
  if (change === "git-child") await writeFile(path.join(f.root, ".git"), "gitdir: another-repository");
  if (change === "recorded-hash") f.resources[1]!.metadata = { sha256: "a".repeat(64) };
  if (change === "duplicate-root") f.resources.push({ ...f.resources[0]!, id: "other", key: "other" });
  if (change === "unsupported-child") f.resources[1]!.kind = "arbitrary-resource";
  if (change === "protected-root") f.input.toolingRoot = path.join(f.root, "tooling");
  await expect(f.prepare()).rejects.toThrow();
  expect(await readFile(f.evidence, "utf8")).toBe("exact evidence bytes");
  expect(f.resources.every(resource => resource.state === "ready")).toBeTrue();
});

test.each(["changed", "missing", "replacement", "symlink", "new-member"])("captured %s material cannot be acknowledged as retirement", async change => {
  const f = await fixture(), plan = await f.prepare(), tree = rootPlan(plan); await capture(plan);
  const file = path.join(tree.target.quarantine.path, "evidence/capture.txt");
  if (change === "changed") await writeFile(file, "changed");
  if (change === "missing") await rm(file);
  if (change === "replacement") {
    // Keep the original inode alive: unlink/recreate may reuse its persisted
    // identity, which identical bytes cannot distinguish as a new generation.
    const original = await lstat(file), bytes = await readFile(file), retained = path.join(f.directory, "original-evidence-retained");
    await rename(file, retained); await writeFile(file, bytes, { mode: 0o600 });
    expect((await lstat(file)).ino).not.toBe(original.ino);
    expect(await readFile(retained)).toEqual(bytes);
  }
  if (change === "symlink") { await rm(file); await symlink(f.secret, file); }
  if (change === "new-member") await writeFile(path.join(tree.target.quarantine.path, "new"), "new material");
  for (const resource of f.resources) resource.state = "released";
  await expect(f.verify(plan, true)).rejects.toThrow();
});

test("source recreation cannot be hidden by a valid retained capture", async () => {
  const f = await fixture(), plan = await f.prepare(); await capture(plan); await mkdir(f.root, { mode: 0o700 }); await writeFile(f.secret, "new writer bytes");
  await expect(f.verify(plan)).rejects.toThrow("recreated");
  expect(await readFile(f.secret, "utf8")).toBe("new writer bytes");
});

test("a root writer prevents preparation and confirmation independently of receipt state", async () => {
  const f = await fixture(); let busy = true;
  const observation = { ...quiet, rootIdle: async () => { if (busy) throw new Error("owned writer is present"); } };
  await expect(f.prepare(observation)).rejects.toThrow("writer"); busy = false;
  const plan = await f.prepare(observation); await capture(plan); busy = true;
  await expect(f.verify(plan, false, observation)).rejects.toThrow("writer");
});

test("other tasks cannot claim a captured source or destination subtree", async () => {
  const f = await fixture(), plan = await f.prepare(); let foreign = false, query: unknown;
  const database = { remoteTaskResource: { findFirst: async (input: unknown) => { query = input; return foreign ? { id: "foreign" } : null; } } };
  await assertRegisteredCaptureSharing(database as never, "task", plan);
  expect(JSON.stringify(query)).toContain(rootPlan(plan).target.quarantine.directory);
  foreign = true; await expect(assertRegisteredCaptureSharing(database as never, "task", plan)).rejects.toThrow("another task");
});

test.each(["native", "docker"] as const)("capture follows exact %s consumers without replacing their physical proof", async adapter => {
  const f = await fixture(); let present = true;
  const resource: FinalizationResourceRecord = { id: "consumer", key: "consumer", kind: adapter === "native" ? "local-process" : "docker-container", purpose: "development",
    externalId: adapter === "native" ? "recorded-family" : "a".repeat(64), state: "ready", metadata: { configurationFile: f.secret } };
  f.resources.push(resource);
  const context = { task: { id: "task", primarySessionId: "primary", worktreePath: path.join(f.directory, "original-checkout"), toolingRevision: "a".repeat(40) },
    capability: { version: 1 as const, source: "configured-host" as const, checkout: f.input.toolingRoot, revision: "b".repeat(40), adapter: path.join(f.input.toolingRoot, "src/cli.ts"), adapterSha256: "c".repeat(64) } };
  const observation: ResourceObservation = { ...quiet, adapters: async ({ request }) => {
    const input = CleanupObserverBatchInput.parse(request);
    const raw = adapter === "native" ? { kind: "native-family", id: "family", scope: { taskId: "task", purpose: "development", anchorKey: "consumer" }, proof: { file: path.join(f.directory, "proof.json"), sha256: "d".repeat(64) }, planDigest: "e".repeat(64), presentAtPrepare: true }
      : { kind: "docker-container", id: resource.externalId, scope: { taskId: "task", purpose: "development" }, identity: { createdAt: "now", labelsDigest: "e".repeat(64), image: "fixture-image", networks: [], volumes: [] }, presentAtPrepare: true };
    const parsed = CleanupTarget.parse({ ...raw, identityDigest: "0".repeat(64) });
    const target = { ...parsed, identityDigest: cleanupTargetDigest(parsed) };
    const { finalizationResourceIdentity } = await import("./finalization-resources.ts");
    return { version: 1, taskId: "task", observations: input.observations.map(item => ({ version: 1, taskId: "task", resourceId: item.resourceId,
      resourceIdentityDigest: finalizationResourceIdentity(resource).identityDigest, adapter, dependencies: [], stoppedConsumers: [], targets: item.expectedTargets ?? [target],
      presentTargetDigests: present ? [target.identityDigest] : [], absent: !present })) };
  } };
  const plan = await prepareFinalizationResources({ ...f.input, adapterContext: context }, observation), tree = rootPlan(plan);
  expect(adapter === "native" ? tree.stoppedConsumers : tree.dependencies).toEqual([resource.id]);
  await capture(plan);
  await expect(f.verify(plan, false, observation)).rejects.toThrow(adapter === "native" ? "native consumer" : "dependent adapter");
  present = false;
  if (adapter === "docker") resource.state = "released";
  await f.verify(plan, false, observation);
  for (const record of f.resources) record.state = "released";
  await f.verify(plan, true, observation);
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot)("actual native directory capture recovers a lost response without losing any private bytes", async () => {
  const f = await fixture(), plan = await f.prepare(), tree = rootPlan(plan), frozen = JSON.stringify(tree);
  const { capturePreparedTree } = await import(path.join(draftedRoot!, "src/quarantine.ts"));
  const identity = { taskId: "task", resourceId: tree.id, planDigest: finalizationDigest(tree.target) };
  await expect(capturePreparedTree(tree.target, identity, { afterCapture: () => { throw new Error("lost response"); } })).rejects.toThrow("lost response");
  await f.verify(plan); await capturePreparedTree(tree.target, identity);
  for (const resource of f.resources) resource.state = "released";
  await f.verify(plan, true); expect(JSON.stringify(tree)).toBe(frozen);
  expect(await readFile(path.join(tree.target.quarantine.path, "private.env"), "utf8")).toBe("PRIVATE_FIXTURE=preserved\n");
});

test.skipIf(!draftedRoot)("native last-window replacement preserves both trees and cannot produce a server confirmation", async () => {
  const f = await fixture(), plan = await f.prepare(), tree = rootPlan(plan), moved = path.join(f.directory, "original-preserved");
  const { capturePreparedTree } = await import(path.join(draftedRoot!, "src/quarantine.ts"));
  await expect(capturePreparedTree(tree.target, { taskId: "task", resourceId: tree.id, planDigest: finalizationDigest(tree.target) }, {
    beforeRename: async () => { await rename(f.root, moved); await mkdir(f.root, { mode: 0o700 }); await writeFile(path.join(f.root, "new-material"), "new bytes"); },
  })).rejects.toThrow();
  await expect(f.verify(plan)).rejects.toThrow();
  expect(await readFile(path.join(moved, "private.env"), "utf8")).toBe("PRIVATE_FIXTURE=preserved\n");
  expect(await readFile(path.join(tree.target.quarantine.path, "new-material"), "utf8")).toBe("new bytes");
});
