import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateBackupFixture } from "../../../../test-support/private-backup.ts";
import { observeSavedArchive } from "./archive-observation.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(extended = true) { const root = await realpath(await mkdtemp(path.join(tmpdir(), "private-backup-"))); roots.push(root); return privateBackupFixture(path.join(root, "saved"), "task", "DRA-80", extended); }

test.each([false, true])("nested backup format (extended=%s) verifies all bytes, private modes and explicit ancillary provenance", async extended => {
  const f = await fixture(extended), observed = await observeSavedArchive(f.selection);
  expect(observed.inventory.filter(x => x.kind === "file").map(x => x.path).sort()).toEqual(f.files.sort());
  expect(observed.ancillary.map(x => x.path)).toEqual(["README.md"]);
  expect(observed.manifestEntries).toBe(extended ? 18 : 12);
  expect(observed.inventory.some(x => (x.mode & 0o7777) === 0o400)).toBeTrue();
  expect(observed.inventory.some(x => x.kind === "file" && (x.mode & 0o7777) === 0o700)).toBeTrue();
  expect(await observeSavedArchive(f.selection)).toEqual(observed);
});

test.each(["task", "issue", "root-hash", "component-hash", "object", "permission", "symlink", "hardlink", "escape", "count"])("invalid backup %s never becomes a verified retained inventory", async kind => {
  const f = await fixture();
  if (kind === "task") f.selection.taskId = "other";
  if (kind === "issue") f.selection.issueIdentifier = "DRA-other";
  if (kind === "root-hash") f.selection.manifests[0].sha256 = "a".repeat(64);
  if (kind === "component-hash") await writeFile(path.join(f.root, "development-runtime-config.sha256"), "changed");
  if (kind === "object") await writeFile(path.join(f.root, "development/objects/nested/雪 +?#.bin"), "changed");
  if (kind === "permission") await chmod(path.join(f.root, "README.md"), 0o640);
  if (kind === "symlink") { await rename(path.join(f.root, "README.md"), path.join(f.root, "original")); await symlink("original", path.join(f.root, "README.md")); }
  if (kind === "hardlink") await link(path.join(f.root, "README.md"), path.join(f.root, "alias"));
  if (kind === "escape") { (f.manifest.purposes.development as any).mysql.file = "../outside"; const body=JSON.stringify(f.manifest); await writeFile(path.join(f.root, "MANIFEST.json"), body); f.selection.manifests[0].sha256=createHash("sha256").update(body).digest("hex"); }
  if (kind === "count") { (f.manifest.purposes.development as any).objects.count = 2; const body=JSON.stringify(f.manifest); await writeFile(path.join(f.root, "MANIFEST.json"), body); f.selection.manifests[0].sha256=createHash("sha256").update(body).digest("hex"); }
  await expect(observeSavedArchive(f.selection)).rejects.toThrow();
});

test("backup hashing streams an actual file above 512 MiB and rejects the fixed byte bound", async () => {
  const f = await fixture(false), file = path.join(f.root, "large.log"), size = 513 * 1024 * 1024;
  const handle = await open(file, "wx", 0o600); await handle.truncate(size); await handle.close();
  const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024); for (let i=0;i<size;i+=chunk.length) hash.update(chunk);
  const observed = await observeSavedArchive(f.selection);
  expect(observed.ancillary.find(x=>x.path==="large.log")).toEqual({path:"large.log",size,sha256:hash.digest("hex")});
  const larger = await open(file, "r+"); await larger.truncate(8 * 1024 * 1024 * 1024 + 1); await larger.close();
  await expect(observeSavedArchive(f.selection)).rejects.toThrow("excessive");
}, 30_000);
