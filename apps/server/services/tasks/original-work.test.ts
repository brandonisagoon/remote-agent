import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { originalArchiveFixture, originalDigest, originalGit } from "../../../../test-support/original-work.ts";
import { assertOriginalWork, originalWorkTar, prepareOriginalWork } from "./original-work.ts";
import { finalizationDigest, type ResourceObservation } from "./finalization-resources.ts";

let directory: string;
const noProcesses: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
beforeEach(async () => { directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "original-work-test-"))); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const product = path.join(directory, "product"), worktree = path.join(directory, "original"), archive = path.join(directory, "archive");
  await mkdir(product); originalGit(product, ["init", "-b", "main"]);
  originalGit(product, ["config", "user.name", "Fixture"]); originalGit(product, ["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(product, "README.md"), "accepted base\n"); originalGit(product, ["add", "."]); originalGit(product, ["commit", "-m", "base"]);
  originalGit(product, ["worktree", "add", "-b", "codex/task", worktree]);
  const selection = await originalArchiveFixture(worktree, archive, "archive-resource");
  const resources = [{ id: "archive-resource", key: "archive", kind: "source-archive", purpose: "review", externalId: archive, state: "ready", metadata: {} }];
  const input = { taskId: "task", worktree, branch: "codex/task", approvedHead: originalGit(worktree, ["rev-parse", "HEAD"]).toString().trim(), resources, originalWork: selection };
  return { input, worktree, archive, product, resources, selection };
}
test("independently restores staged, unstaged and binary untracked work without writing the original index", async () => {
  const f = await fixture(), index = originalGit(f.worktree, ["rev-parse", "--absolute-git-dir"]).toString().trim() + "/index";
  const before = await readFile(index), proof = await prepareOriginalWork(f.input, noProcesses);
  expect(await readFile(index)).toEqual(before);
  expect(proof.snapshot.clean).toBe(false); expect(proof.snapshot.untracked).toHaveLength(1);
  expect(proof.restore.workingTree).toBe(f.selection.expectedWorkingTree);
  expect(proof.restore.fingerprint).toBe(proof.snapshot.fingerprint);
  expect(proof.target.sourcePaths).toEqual([f.worktree]);
  await assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: false }, noProcesses);
});
test("rejects missing or changed archive bytes, incomplete manifests and a wrong restore tree", async () => {
  const f = await fixture();
  await expect(prepareOriginalWork({ ...f.input, originalWork: { ...f.selection, expectedWorkingTree: "f".repeat(40) } }, noProcesses)).rejects.toThrow("content tree");
  await writeFile(path.join(f.archive, "new-material"), "unmanifested", { mode: 0o600 });
  await expect(prepareOriginalWork(f.input, noProcesses)).rejects.toThrow("unmanifested");
  await rm(path.join(f.archive, "new-material")); await writeFile(path.join(f.archive, "worktree.diff"), "changed");
  await expect(prepareOriginalWork(f.input, noProcesses)).rejects.toThrow("manifest");
});
test("new original or staged material invalidates the immutable adoption", async () => {
  const f = await fixture(), proof = await prepareOriginalWork(f.input, noProcesses);
  originalGit(f.worktree, ["add", "README.md"]);
  await expect(assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: false }, noProcesses)).rejects.toThrow("state changed");
});
test("ignored original material requires explicit ownership and remains in full capture", async () => {
  const f = await fixture();
  originalGit(f.worktree, ["config", "core.excludesFile", path.join(directory, "excludes")]);
  await writeFile(path.join(directory, "excludes"), "cache\n"); await writeFile(path.join(f.worktree, "cache"), "preserve");
  await expect(prepareOriginalWork(f.input, noProcesses)).rejects.toThrow("Ignored original material");
  const proof = await prepareOriginalWork({ ...f.input, originalWork: { ...f.selection, ownedPaths: [path.join(f.worktree, "cache")] } }, noProcesses);
  expect(proof.target.inventory.some((entry) => entry.path === "cache")).toBe(true);
});
test("confirmation requires exact whole-root capture and keeps archive and branch recoverable", async () => {
  const f = await fixture(), proof = await prepareOriginalWork(f.input, noProcesses), target = proof.target;
  await expect(assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: true }, noProcesses)).rejects.toThrow("not been preserved");
  const root = target.inventory.find((entry) => entry.path === ".")!;
  await mkdir(target.quarantine.directory, { mode: 0o700 }); const location = await lstat(target.quarantine.directory);
  await writeFile(target.quarantine.journal, JSON.stringify({ version: 1, taskId: "task", resourceId: proof.captureId, planDigest: finalizationDigest(target), sourcePath: target.path, capturedPath: target.quarantine.path, source: { dev: root.dev, ino: root.ino, mode: root.mode }, quarantine: { dev: location.dev, ino: location.ino } }), { mode: 0o600 });
  await rename(target.path, target.quarantine.path);
  originalGit(f.product, ["worktree", "remove", f.worktree]);
  await assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: true }, noProcesses);
  expect(originalGit(f.product, ["rev-parse", "refs/heads/codex/task"]).toString().trim()).toBe(proof.snapshot.head);
  expect(await readFile(path.join(target.quarantine.path, "untracked.bin"))).toEqual(Buffer.from([0, 255, 1, 10]));
  await mkdir(f.worktree);
  await expect(assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: true }, noProcesses)).rejects.toThrow("recreated");
});
test("archive permissions and replacement identity are verified on retries", async () => {
  const f = await fixture(), proof = await prepareOriginalWork(f.input, noProcesses);
  await chmod(f.selection.manifestPath, 0o644);
  await expect(assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: false }, noProcesses)).rejects.toThrow("private");
});
test("tar parsing refuses links, traversal and checksum corruption without extraction", async () => {
  const f = await fixture(), tar = await readFile(path.join(f.archive, "untracked.tar"));
  expect(originalWorkTar(tar).get("untracked.bin")?.bytes).toEqual(Buffer.from([0, 255, 1, 10]));
  const corrupt = Buffer.from(tar); corrupt[0] = 255;
  expect(() => originalWorkTar(corrupt)).toThrow("Invalid bounded tar member");
  const rewrite = (name: string, type: string) => {
    const result = Buffer.from(tar); result.fill(0, 0, 100); result.write(name, 0); result[156] = type.charCodeAt(0); result.fill(32, 148, 156);
    let sum = 0; for (const byte of result.subarray(0, 512)) sum += byte;
    result.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148); return result;
  };
  expect(() => originalWorkTar(rewrite("../outside", "0"))).toThrow("unsafe path");
  expect(() => originalWorkTar(rewrite("link", "2"))).toThrow("Only regular");
  expect(() => originalWorkTar(rewrite(".git/config", "0"))).toThrow("Unsafe");
});

test("historical results require exact archived task, tooling and resource identity", async () => {
  const f = await fixture(), provenancePath = path.join(f.archive, "provenance.json");
  const result = { id: "saved-chat", key: "saved-chat", kind: "rubin-chat", purpose: "development", externalId: "saved-result-id", state: "ready", metadata: {} };
  const provenance = JSON.stringify({ taskId: "task", toolingRevision: "a".repeat(40), resources: [{ key: result.key, kind: result.kind, purpose: result.purpose, externalId: result.externalId, state: "allocated" }] });
  await writeFile(provenancePath, provenance, { mode: 0o600 });
  const manifest = (await readFile(f.selection.manifestPath, "utf8")) + `${originalDigest(provenance)}  provenance.json\n`;
  await writeFile(f.selection.manifestPath, manifest);
  const input = { ...f.input, toolingRevision: "a".repeat(40), resources: [...f.resources, result], originalWork: { ...f.selection, manifestSha256: originalDigest(manifest), retainedResults: [{ resourceId: result.id, provenancePath: "provenance.json" }] } };
  const proof = await prepareOriginalWork(input, noProcesses);
  expect(proof.retainedResults?.[0]?.resourceId).toBe(result.id);
  await expect(prepareOriginalWork({ ...input, toolingRevision: "b".repeat(40) }, noProcesses)).rejects.toThrow();
  result.externalId = "another-result";
  await expect(assertOriginalWork({ taskId: "task", resources: input.resources, originalWork: proof, removed: false }, noProcesses)).rejects.toThrow("Historical result identity");
  await expect(prepareOriginalWork(input, noProcesses)).rejects.toThrow("archived task identity");
});

test("additional runtime archives need exact JSON root, member digests and immutable identity", async () => {
  const f = await fixture(), archive = path.join(directory, "runtime-archive"); await mkdir(archive, { mode: 0o700 });
  await writeFile(path.join(archive, "record.json"), "{}", { mode: 0o600 });
  const manifest = JSON.stringify({ root: archive, files: [{ path: "record.json", bytes: 2, sha256: originalDigest("{}") }], previous: "historical" });
  const manifestPath = path.join(archive, "MANIFEST.json"); await writeFile(manifestPath, manifest, { mode: 0o600 });
  const record = { ...f.resources[0]!, id: "runtime", key: "runtime", externalId: archive };
  const input = { ...f.input, resources: [...f.resources, record], originalWork: { ...f.selection, additionalArchives: [{ resourceId: record.id, manifestPath, manifestSha256: originalDigest(manifest), format: "files-v1" as const }] } };
  const proof = await prepareOriginalWork(input, noProcesses);
  expect(proof.additionalArchives?.[0]?.resourceId).toBe(record.id);
  await writeFile(path.join(archive, "record.json"), "[]");
  await expect(assertOriginalWork({ taskId: "task", resources: input.resources, originalWork: proof, removed: false }, noProcesses)).rejects.toThrow("manifest");
});
