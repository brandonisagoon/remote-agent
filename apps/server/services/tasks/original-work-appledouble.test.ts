import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { originalArchiveFixture, originalDigest, originalGit } from "../../../../test-support/original-work.ts";
import { recoveryTar } from "../../../../test-support/recovery-work.ts";
import { assertOriginalWork, originalWorkTar, originalWorkUntrackedTar, prepareOriginalWork } from "./original-work.ts";

// Apple copyfile's two-entry format, with synthetic provenance bytes. Layout
// matches the seven 163-byte metadata members observed in DRA-98's saved tar.
function macMetadata() {
  const bytes = Buffer.alloc(163);
  bytes.writeUInt32BE(0x00051607); bytes.writeUInt32BE(0x00020000, 4); bytes.write("Mac OS X        ", 8);
  bytes.writeUInt16BE(2, 24);
  bytes.writeUInt32BE(9, 26); bytes.writeUInt32BE(50, 30); bytes.writeUInt32BE(113, 34);
  bytes.writeUInt32BE(2, 38); bytes.writeUInt32BE(163, 42);
  bytes.write("ATTR", 84); bytes.writeUInt32BE(163, 92); bytes.writeUInt32BE(152, 96); bytes.writeUInt32BE(11, 100); bytes.writeUInt16BE(1, 118);
  bytes.writeUInt32BE(152, 120); bytes.writeUInt32BE(11, 124); bytes[130] = 21; bytes.write("com.apple.provenance\0", 131);
  bytes.fill(7, 152); return bytes;
}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const idle = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {} };

async function fixture(genuine: "none" | "ordinary" | "metadata" = "none") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-archive-test-"))); roots.push(root);
  const product = path.join(root, "product"), worktree = path.join(root, "original"), archive = path.join(root, "archive");
  await mkdir(product); originalGit(product, ["init", "-b", "main"]);
  originalGit(product, ["config", "user.name", "Fixture"]); originalGit(product, ["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(product, "README.md"), "base\n"); originalGit(product, ["add", "."]); originalGit(product, ["commit", "-m", "base"]);
  originalGit(product, ["worktree", "add", "-b", "codex/task", worktree]);
  const names = ["untracked.bin", ...Array.from({ length: 6 }, (_, n) => `nested/file-${n}.ts`)];
  await mkdir(path.join(worktree, "nested"));
  for (const name of names.slice(1)) await writeFile(path.join(worktree, name), `content ${name}\n`, { mode: 0o600 });
  await chmod(path.join(worktree, names[1]!), 0o700);
  if (genuine !== "none") {
    names.push("._owner-data");
    await writeFile(path.join(worktree, "._owner-data"), genuine === "metadata" ? macMetadata() : Buffer.from("real owner data"), { mode: 0o600 });
  }
  const selection = await originalArchiveFixture(worktree, archive, "archive");
  const entries = await Promise.all(names.map(async (name, index) => [{ name: path.posix.join(path.posix.dirname(name), `._${path.posix.basename(name)}`), content: macMetadata() }, { name, content: await readFile(path.join(worktree, name)), mode: index === 1 ? 0o755 : 0o644 }]));
  const tar = recoveryTar(entries.flat()); await writeFile(path.join(archive, selection.untrackedArchivePath), tar, { mode: 0o600 });
  const manifest = (await readFile(selection.manifestPath, "utf8")).replace(/^[a-f0-9]{64}  untracked\.tar$/m, `${originalDigest(tar)}  untracked.tar`);
  await writeFile(selection.manifestPath, manifest); selection.manifestSha256 = originalDigest(manifest);
  const index = originalGit(worktree, ["rev-parse", "--absolute-git-dir"]).toString().trim() + "/index", indexBefore = await readFile(index);
  const resources = [{ id: "archive", key: "archive", kind: "source-archive", purpose: "review", externalId: archive, state: "ready", metadata: {} }];
  const input = { taskId: "task", worktree, branch: "codex/task", approvedHead: originalGit(worktree, ["rev-parse", "HEAD"]).toString().trim(), resources, originalWork: selection };
  return { input, worktree, archive, names, selection, index, indexBefore, tar, manifest, resources };
}

test("bundle restore accepts seven exact files with seven Mac metadata records without altering source or archive", async () => {
  const { input, names, selection, index, indexBefore, tar, manifest, archive, resources } = await fixture();
  expect(originalWorkTar(tar).size).toBe(14);
  const parsed = originalWorkUntrackedTar(tar, new Set(names));
  expect(parsed.files.size).toBe(7); expect(parsed.metadata).toHaveLength(7);
  const proof = await prepareOriginalWork(input, idle);
  expect(proof.snapshot.untracked).toHaveLength(7);
  expect(proof.restore.workingTree).toBe(selection.expectedWorkingTree);
  expect(proof.restore.fingerprint).toBe(proof.snapshot.fingerprint);
  expect(await readFile(index)).toEqual(indexBefore);
  expect(await readFile(path.join(archive, selection.untrackedArchivePath))).toEqual(tar);
  expect(await readFile(selection.manifestPath, "utf8")).toBe(manifest);
  await assertOriginalWork({ taskId: "task", resources, originalWork: proof, removed: false }, idle);
});


test.each(["ordinary", "metadata"] as const)("genuine expected ._ file with %s bytes is restored and retained as user content", async kind => {
  const f = await fixture(kind), before = await readFile(path.join(f.worktree, "._owner-data"));
  const parsed = originalWorkUntrackedTar(f.tar, new Set(f.names));
  expect(parsed.files.get("._owner-data")?.bytes).toEqual(before);
  expect(parsed.metadata).not.toContain("._owner-data");
  const proof = await prepareOriginalWork(f.input, idle);
  expect(proof.snapshot.untracked.find(entry => entry.path === "._owner-data")?.sha256).toBe(originalDigest(before));
  expect(proof.restore.workingTree).toBe(f.selection.expectedWorkingTree);
  expect(await readFile(path.join(f.worktree, "._owner-data"))).toEqual(before);
});

test("an ignored original ._ path cannot be disguised as generated archive metadata", async () => {
  const f = await fixture(), collision = path.join(f.worktree, "._untracked.bin");
  // .git/info/exclude changes no tracked patch or expected content tree.
  const common = originalGit(f.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
  await writeFile(path.join(common, "info/exclude"), "._untracked.bin\n");
  await writeFile(collision, "ignored owner material", { mode: 0o600 });
  await expect(prepareOriginalWork(f.input, idle)).rejects.toThrow("collides with an original source path");
  expect(await readFile(collision, "utf8")).toBe("ignored owner material");
  expect(await readFile(path.join(f.archive, f.selection.untrackedArchivePath))).toEqual(f.tar);
});

test("metadata recognition never relaxes exact real-file content or executable matching", async () => {
  const f = await fixture();
  await writeFile(path.join(f.worktree, "untracked.bin"), "changed real bytes");
  await expect(prepareOriginalWork(f.input, idle)).rejects.toThrow("untracked files do not match");
  expect(await readFile(path.join(f.archive, f.selection.untrackedArchivePath))).toEqual(f.tar);
});

const normal = { name: "nested/file", content: Buffer.from("real content") };
const metadata = (content: Buffer = macMetadata(), name = "nested/._file", mode = 0o644) => ({ name, content, mode });
const parse = (entries: Parameters<typeof recoveryTar>[0]) => originalWorkUntrackedTar(recoveryTar(entries), new Set([normal.name]));

test.each([
  ["unpaired metadata", [metadata(macMetadata(), "nested/._other"), normal]],
  ["unrelated directory", [metadata(macMetadata(), "elsewhere/._file"), normal]],
  ["missing real member", [metadata()]],
  ["ordinary extra data", [{ name: "nested/owner-data", content: Buffer.from("keep me") }, normal]],
  ["arbitrary prefix bytes", [metadata(Buffer.from("keep me")), normal]],
  ["duplicate metadata", [metadata(), metadata(), normal]],
  ["executable metadata", [metadata(macMetadata(), "nested/._file", 0o755), normal]],
  ["special-mode metadata", [metadata(macMetadata(), "nested/._file", 0o4644), normal]],
] as const)("refuses %s without dropping any member", (_name, entries) => {
  expect(() => parse([...entries])).toThrow();
});

const corruptions: Array<[string, (bytes: Buffer) => Buffer | void]> = [
  ["wrong magic", b => { b.writeUInt32BE(0, 0); }],
  ["wrong version", b => { b.writeUInt32BE(0, 4); }],
  ["foreign filler", b => { b[8] = 88; }],
  ["truncated table", b => b.subarray(0, 40)],
  ["duplicate entry ID", b => { b.writeUInt32BE(9, 38); }],
  ["extra entry", b => { b.writeUInt16BE(3, 24); }],
  ["overlapping entry", b => { b.writeUInt32BE(50, 42); b.writeUInt32BE(1, 46); }],
  ["nonempty resource fork", b => { b.writeUInt32BE(162, 42); b.writeUInt32BE(1, 46); }],
  ["wrong ATTR magic", b => { b.writeUInt32BE(0, 84); }],
  ["wrong ATTR total", b => { b.writeUInt32BE(162, 92); }],
  ["reserved flags", b => { b[104] = 1; }],
  ["too many attributes", b => { b.writeUInt16BE(1025, 118); }],
  ["missing attributes", b => { b.writeUInt16BE(0, 118); }],
  ["bad data start", b => { b.writeUInt32BE(164, 96); }],
  ["bad data length", b => { b.writeUInt32BE(12, 100); }],
  ["attribute flags", b => { b.writeUInt16BE(1, 128); }],
  ["attribute outside data", b => { b.writeUInt32BE(150, 120); }],
  ["attribute gap", b => { b.writeUInt32BE(153, 120); b.writeUInt32BE(10, 124); }],
  ["attribute trailing gap", b => { b.writeUInt32BE(10, 124); }],
  ["attribute overrun", b => { b.writeUInt32BE(12, 124); }],
  ["empty attribute name", b => { b[130] = 1; }],
  ["oversized attribute name", b => { b[130] = 129; }],
  ["unterminated name", b => { b[151] = 65; }],
  ["embedded name NUL", b => { b[136] = 0; }],
  ["invalid UTF8 name", b => { b[132] = 255; }],
  ["unclaimed tail", b => Buffer.concat([b, Buffer.from("owner payload")])],
  ["oversized metadata", b => Buffer.concat([b, Buffer.alloc(65536)])],
];
test.each(corruptions)("refuses malformed Mac metadata: %s", (_name, corrupt) => {
  const bytes = macMetadata(), changed = corrupt(bytes) ?? bytes;
  expect(() => parse([metadata(changed), normal])).toThrow();
});

test("Finder-info-only metadata is accepted only with its complete exact layout", () => {
  const bytes = macMetadata().subarray(0, 82);
  bytes.writeUInt32BE(32, 34); bytes.writeUInt32BE(82, 42);
  expect(parse([metadata(bytes), normal]).files.size).toBe(1);
  expect(parse([metadata(bytes), normal]).metadata).toEqual(["nested/._file"]);
});

test("multiple attribute records require unique names, aligned headers and exact nonoverlapping data", () => {
  const bytes = Buffer.alloc(167); macMetadata().copy(bytes, 0, 0, 120);
  bytes.writeUInt32BE(117, 34); bytes.writeUInt32BE(167, 42); bytes.writeUInt32BE(167, 92);
  bytes.writeUInt32BE(160, 96); bytes.writeUInt32BE(7, 100); bytes.writeUInt16BE(2, 118);
  for (const [cursor, name, offset, size] of [[120, "com.one", 160, 4], [140, "com.two", 164, 3]] as const) {
    bytes.writeUInt32BE(offset, cursor); bytes.writeUInt32BE(size, cursor + 4); bytes[cursor + 10] = 8; bytes.write(`${name}\0`, cursor + 11);
  }
  bytes.fill(7, 160);
  expect(parse([metadata(bytes), normal]).metadata).toHaveLength(1);
  const duplicate = Buffer.from(bytes); duplicate.write("com.one\0", 151);
  expect(() => parse([metadata(duplicate), normal])).toThrow();
  const overlap = Buffer.from(bytes); overlap.writeUInt32BE(163, 140);
  expect(() => parse([metadata(overlap), normal])).toThrow();
  const padding = Buffer.from(bytes); padding[139] = 1;
  expect(() => parse([metadata(padding), normal])).toThrow();
});
