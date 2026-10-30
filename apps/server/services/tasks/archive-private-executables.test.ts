import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { observeArchive, observeSavedArchive, privateArchiveInventory } from "./archive-observation.ts";
import { finalizationDigest } from "./finalization-resources.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(format: "sha256-lines" | "files-v1" = "sha256-lines") {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "private-executable-archive-"))); roots.push(temporary);
  const root = path.join(temporary, "archive"), scenario = path.join(root, "scenario"); await mkdir(scenario, { recursive: true, mode: 0o700 });
  const marker = path.join(temporary, "must-not-execute"), entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const name of ["seed-existing-objects.sh", "seed-fresh-chat.sh", "seed-lot.sh", "saved-state.json"]) {
    const body = name.endsWith(".sh") ? `#!/bin/sh\nprintf executed > '${marker}'\n` : '{"saved":"keep"}\n';
    await writeFile(path.join(scenario, name), body, { mode: name.endsWith(".sh") ? 0o700 : 0o600 });
    entries.push({ path: `scenario/${name}`, sha256: sha(body), bytes: Buffer.byteLength(body) });
  }
  const manifest = path.join(root, format === "sha256-lines" ? "MANIFEST.sha256" : "MANIFEST.json");
  const body = format === "sha256-lines" ? entries.map(entry => `${entry.sha256}  ${entry.path}\n`).join("") : JSON.stringify({ createdAt: "2026-10-30T00:00:00Z", root, previous: "historical", files: entries });
  await writeFile(manifest, body, { mode: 0o600 });
  return { temporary, root, manifest, digest: sha(body), entries, script: path.join(scenario, "seed-lot.sh"), marker, read: () => observeArchive(root, manifest, sha(body), format) };
}

test.each(["sha256-lines", "files-v1"] as const)("%s retains private executable members without running or rewriting them", async format => {
  const f = await fixture(format), before = await lstat(f.script), manifest = await readFile(f.manifest), bytes = await readFile(f.script);
  const proof = await f.read(), entry = proof.inventory.find(entry => entry.path === "scenario/seed-lot.sh");
  expect(entry).toMatchObject({ kind: "file", dev: before.dev, ino: before.ino, mode: before.mode, size: bytes.length, sha256: sha(bytes) });
  expect(proof.inventory.filter(entry => entry.kind === "file" && (entry.mode & 0o7777) === 0o700)).toHaveLength(3);
  expect(await f.read()).toEqual(proof); expect(await readFile(f.manifest)).toEqual(manifest); expect(await readFile(f.script)).toEqual(bytes);
  const after = await lstat(f.script); expect([after.ino, after.mode, after.uid]).toEqual([before.ino, before.mode, before.uid]);
  expect(await Bun.file(f.marker).exists()).toBeFalse();
});

test.each([0o400, 0o500, 0o644, 0o704, 0o710, 0o755, 0o777, 0o1700, 0o2700, 0o4700])("ordinary retained member mode %s remains unsupported", async mode => {
  const f = await fixture();
  const changed = Bun.spawnSync(["chmod", mode.toString(8), f.script], { stdout: "pipe", stderr: "pipe" });
  expect(changed.exitCode).toBe(0); expect((await lstat(f.script)).mode & 0o7777).toBe(mode);
  await expect(f.read()).rejects.toThrow("private"); expect(await Bun.file(f.marker).exists()).toBeFalse();
});

test("archive roots, nested directories and manifests keep their existing private modes", async () => {
  const f = await fixture();
  for (const [file, mode, restore] of [[f.root, 0o750, 0o700], [path.dirname(f.script), 0o755, 0o700], [f.manifest, 0o700, 0o600]] as const) {
    await chmod(file, mode); await expect(f.read()).rejects.toThrow("private"); await chmod(file, restore);
  }
});

test("shared, redirected and non-task-owned private executables remain rejected", async () => {
  const f = await fixture(), alias = path.join(f.temporary, "shared-script");
  await link(f.script, alias); await expect(f.read()).rejects.toThrow(); await rm(alias);
  const original = await readFile(f.script); await rm(f.script); await writeFile(alias, original, { mode: 0o700 }); await symlink(alias, f.script);
  await expect(f.read()).rejects.toThrow(); await rm(f.script); await writeFile(f.script, original, { mode: 0o700 });
  const uid = process.getuid!(), owner = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try { await expect(privateArchiveInventory(f.root)).rejects.toThrow("task-owned"); } finally { owner.mockRestore(); }
});

test("saved historical manifests retain executable payloads but do not gain executable manifest permissions", async () => {
  const f = await fixture();
  const body = JSON.stringify({ task: "task", issue: "DRA-98", mergedCommit: "a".repeat(40), entries: f.entries.map(entry => ({ archivePath: entry.path, sha256: entry.sha256, bytes: entry.bytes })) });
  await writeFile(f.manifest, body);
  const selection = { root: f.root, taskId: "task", issueIdentifier: "DRA-98", mergeCommit: "a".repeat(40), manifests: [{ path: path.basename(f.manifest), sha256: sha(body), entries: 4 }] };
  const observed = await observeSavedArchive(selection); expect(observed.manifestEntries).toBe(4); expect(observed.ancillary).toEqual([]);
  await chmod(f.manifest, 0o700); await expect(observeSavedArchive(selection)).rejects.toThrow("manifest");
});

test("immutable inventory keeps exact executable mode, inode, bytes and coverage", async () => {
  const f = await fixture(), proof = await f.read();
  await chmod(f.script, 0o600); expect(finalizationDigest((await f.read()).inventory)).not.toBe(proof.inventoryDigest); await chmod(f.script, 0o700);
  const body = await readFile(f.script), original = await lstat(f.script);
  await rename(f.script, path.join(f.temporary, "retained-original-inode")); await writeFile(f.script, body, { mode: 0o700 });
  expect((await lstat(f.script)).ino).not.toBe(original.ino);
  expect(finalizationDigest((await f.read()).inventory)).not.toBe(proof.inventoryDigest);
  await writeFile(f.script, "changed", { mode: 0o700 }); await expect(f.read()).rejects.toThrow("manifest");
  await writeFile(f.script, body); await writeFile(path.join(f.root, "unmanifested"), "extra", { mode: 0o600 }); await expect(f.read()).rejects.toThrow("unmanifested");
});

test.skipIf(!process.env.DRAFTED_INTEGRATION_ROOT)("actual client accepts frozen0700 inventory and refuses later mode changes", async () => {
  const f = await fixture("files-v1"), proof = await f.read();
  const { verifyPreparedInventory } = await import(path.join(process.env.DRAFTED_INTEGRATION_ROOT!, "src/finalization-resources.ts"));
  let checks = 0; const verify = () => verifyPreparedInventory({ path: f.root, inventory: proof.inventory }, f.root, async () => { checks++; });
  await verify(); expect(checks).toBeGreaterThan(0); expect(await Bun.file(f.marker).exists()).toBeFalse();
  await chmod(f.script, 0o600); await expect(verify()).rejects.toThrow("identity");
});
