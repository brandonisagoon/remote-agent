import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { recoveryFixture, recoveryTar, recoveryTarHeader, recoveryAppleDouble } from "../../../../test-support/recovery-work.ts";
import { originalDigest, originalGit } from "../../../../test-support/original-work.ts";
import { prepareOriginalWork, assertOriginalWork, originalWorkRetainedPlans } from "./original-work.ts";
import { prepareFinalizationResources, assertFinalizationResources } from "./finalization-resources.ts";
import { observeRecoveryArchive } from "./recovery-archive.ts";
import { restoreRecoveryTar, assertRecoveryLinkSet } from "./recovery-tar.ts";

let directory: string;
const idle = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };
beforeEach(async () => { directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "recovery-archive-test-"))); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
test("restores existing gzip base/patch/mixed-work archives and preserves all historical bytes", async () => {
  const f = await recoveryFixture(directory), index = originalGit(f.worktree, ["rev-parse", "--absolute-git-dir"]).toString().trim() + "/index", before = await readFile(index);
  const proof = await prepareOriginalWork(f.input, idle);
  expect(await readFile(index)).toEqual(before); expect(proof.restore).toHaveProperty("format", "base-work-tar/v1"); expect(proof.restore).not.toHaveProperty("bundleSha256");
  expect(proof.snapshot.clean).toBe(false); expect(proof.snapshot.untracked).toHaveLength(1);
  expect(proof.archive.inventory.some(entry => entry.path === "base.tar.gz.interrupted")).toBe(true);
  expect(proof.archive.inventory.some(entry => entry.path === "restore-verification/old-output")).toBe(true);
  expect((await lstat(path.join(f.archive, "base.tar.gz"))).mode & 0o777).toBe(0o644);
  const plan = originalWorkRetainedPlans(proof, f.resources);
  expect(plan.map(entry => entry.disposition)).toEqual(["retain-archive", "retain-archive-member"]);
  const prepared = await prepareFinalizationResources({ resources: f.resources, taskId: "task", sessionId: "primary", toolingRoot: directory, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [] }, retainedArchives: plan, originalWork: true }, idle);
  await assertFinalizationResources({ taskId: "task", resources: f.resources, plan: prepared, originalWork: true, removed: false }, idle);
  await assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: false }, idle);
});
test("new source changes, wrong task binding and altered ancillary bytes refuse recovery", async () => {
  const f = await recoveryFixture(directory);
  await expect(prepareOriginalWork({ ...f.input, toolingRevision: "b".repeat(40) }, idle)).rejects.toThrow("another original");
  await expect(prepareOriginalWork({ ...f.input, resources: f.resources.map(resource => resource.id === "archive" ? { ...resource, metadata: { manifestSha256: "f".repeat(64) } } : resource) }, idle)).rejects.toThrow("recorded identity or digest");
  const proof = await prepareOriginalWork(f.input, idle);
  await writeFile(path.join(f.worktree, "README.md"), "new work");
  await expect(assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: false }, idle)).rejects.toThrow();
  await writeFile(path.join(f.archive, "base.tar.gz.interrupted"), "changed partial");
  await expect(assertOriginalWork({ taskId: "task", resources: f.resources, originalWork: proof, removed: false }, idle)).rejects.toThrow("Retained archive changed");
});
test("archive permissions, unbound tooling records and missing parent retention fail closed", async () => {
  const f = await recoveryFixture(directory), proof = await prepareOriginalWork(f.input, idle), plan = originalWorkRetainedPlans(proof, f.resources);
  await expect(prepareFinalizationResources({ resources: [...f.resources, { ...f.resources[0]!, id: "unknown", key: "unknown" }], taskId: "task", sessionId: "primary", toolingRoot: directory, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [] }, retainedArchives: plan, originalWork: true }, idle)).rejects.toThrow("Unknown resource purpose");
  await expect(prepareFinalizationResources({ resources: [f.resources[1]!], taskId: "task", sessionId: "primary", toolingRoot: directory, sourcePaths: [], deliveries: [], ownership: { ownedPaths: [] }, retainedArchives: [plan[1]!], originalWork: true }, idle)).rejects.toThrow("member identity");
  await chmod(f.archive, 0o755); await expect(observeRecoveryArchive(f.archive, f.selection)).rejects.toThrow("private");
});
test("streamed tar rejects traversal, links, changed content and fake AppleDouble without extracting them", async () => {
  const file = path.join(directory, "input.gz"), good = Buffer.from("content"), expected = new Map([["file", { kind: "file" as const, size: good.length, executable: false, sha256: originalDigest(good) }]]);
  async function observe(entries: Parameters<typeof recoveryTar>[0], appleDouble = false) { const compressed = gzipSync(recoveryTar(entries)); await writeFile(file, compressed); return restoreRecoveryTar({ path: file, size: compressed.length, sha256: originalDigest(compressed) }, expected, undefined, { appleDouble }); }
  expect((await observe([{ name: "._file", content: recoveryAppleDouble() }, { name: "file", content: good }], true)).metadata).toBe(1);
  const pax = Buffer.concat([Buffer.from("SCHILY.xattr.com.apple.provenance="), Buffer.from([255, 0, 129])]);
  let length = pax.length + 3; while (length !== pax.length + String(length).length + 2) length = pax.length + String(length).length + 2;
  const record = Buffer.concat([Buffer.from(`${length} `), pax, Buffer.from("\n")]);
  expect((await observe([{ name: "pax", content: record, type: "x" }, { name: "file", content: good }])).files).toBe(1);
  await expect(observe([{ name: "../file", content: good }])).rejects.toThrow("unsafe path");
  await expect(observe([{ name: "file", type: "1", link: "outside" }])).rejects.toThrow("type or size");
  await expect(observe([{ name: "file", content: Buffer.from("changed") }])).rejects.toThrow("content changed");
  await expect(observe([{ name: "._file", content: Buffer.from("not metadata") }, { name: "file", content: good }], true)).rejects.toThrow("AppleDouble");
  await expect(observe([{ name: "file", content: good }, { name: "file", content: good }])).rejects.toThrow("duplicate");
  expect(() => assertRecoveryLinkSet(new Map([["deep/x", "../sub"], ["deep/a", "x/../../outside"]]))).toThrow("chain escapes");
  expect(() => assertRecoveryLinkSet(new Map([["a", "b"], ["b", "a"]]))).toThrow("cyclic");
  expect(() => assertRecoveryLinkSet(new Map([["deep/x", "../dir"], ["y", "deep/x/../.git"]]))).toThrow("Git administration");
  expect(() => assertRecoveryLinkSet(new Map([["deep/x", "../dir"], ["y", "deep/x/../.git/config"]]))).toThrow("Git administration");
  expect(() => assertRecoveryLinkSet(new Map([[".claude/skills/a", "../../.agents/skills/a"], ["CLAUDE.md", "AGENTS.md"]]))).not.toThrow();
});

test("a declared member above 512 MiB is streamed with exact byte/hash limits", async () => {
  const size = 513 * 1024 * 1024, file = path.join(directory, "large.gz"), chunk = Buffer.alloc(64 * 1024, 97), digest = createHash("sha256");
  async function* tar() { yield recoveryTarHeader("large", size); for (let n = 0; n < size / chunk.length; n++) { digest.update(chunk); yield chunk; } yield Buffer.alloc(1024); }
  await pipeline(Readable.from(tar()), createGzip(), createWriteStream(file, { mode: 0o600 }));
  const compressed = await readFile(file), expected = new Map([["large", { kind: "file" as const, executable: false, size, sha256: digest.digest("hex") }]]);
  const result = await restoreRecoveryTar({ path: file, size: compressed.length, sha256: originalDigest(compressed) }, expected);
  expect(result.files).toBe(1); expect(result.expandedBytes).toBe(size + 1536);
  expected.get("large")!.size--;
  await expect(restoreRecoveryTar({ path: file, size: compressed.length, sha256: originalDigest(compressed) }, expected)).rejects.toThrow("size changed");
}, 60_000);

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual client retries captured recovery original and retains both tooling archive receipts", async () => {
  const f = await recoveryFixture(directory), proof = await prepareOriginalWork(f.input, idle);
  const client = process.env.DRAFTED_INTEGRATION_ROOT!;
  const { retireArchivedWorktree } = await import(path.join(client, "src/archived-worktree.ts"));
  const { OriginalWork } = await import(path.join(client, "src/original-work-schema.ts"));
  const { assertResourcePlan } = await import(path.join(client, "src/finalization-plan.ts"));
  expect(OriginalWork.parse(proof)).toEqual(proof);
  const plans = originalWorkRetainedPlans(proof, f.resources);
  expect(() => assertResourcePlan({ resources: f.resources }, plans)).not.toThrow();
  const authority = () => assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: false }, idle);
  const input = { taskId: "task", worktree: f.worktree, revision: proof.snapshot.head, branch: proof.snapshot.branch, gitDirectory: proof.restore.gitDirectory, gitCwd: f.product, target: proof.target, administration: proof.administration, assertAuthority: authority, observation: idle };
  await expect(retireArchivedWorktree({ ...input, captureHooks: { afterCapture: async () => { throw new Error("response lost after capture"); } } })).rejects.toThrow("response lost");
  const captured = await lstat(proof.target.quarantine.path);
  await retireArchivedWorktree(input);
  expect((await lstat(proof.target.quarantine.path)).ino).toBe(captured.ino);
  await assertOriginalWork({ taskId: "task", originalWork: proof, resources: f.resources, removed: true }, idle);
  expect(await readFile(path.join(proof.target.quarantine.path, "README.md"), "utf8")).toBe("unfinished source\n");
  expect(await readFile(path.join(f.archive, "base.tar.gz.interrupted"), "utf8")).toBe("partial bytes are retained, never restored");
  expect(f.resources.map(resource => resource.state)).toEqual(["ready", "ready"]);
  expect(originalGit(f.product, ["rev-parse", "refs/heads/codex/original"]).toString().trim()).toBe(proof.snapshot.head);
}, 30_000);
