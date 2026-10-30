import { chmod, lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { originalDigest, originalGit } from "./original-work.ts";
import type { RecoveryWorkInput } from "../apps/server/services/tasks/original-work-schema.ts";

export function recoveryTarHeader(name: string, size: number, mode = 0o644, type = "0", link = "") {
  const header = Buffer.alloc(512); header.write(name, 0, 100); header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  header.write("0000000\0", 108); header.write("0000000\0", 116); header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100); header.write("ustar\0", 257); header.write("00", 263);
  let sum = 0; for (const byte of header) sum += byte; header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148); return header;
}
export function recoveryTar(entries: Array<{ name: string; content?: Buffer; mode?: number; type?: string; link?: string }>) {
  return Buffer.concat([...entries.flatMap(entry => { const content = entry.content ?? Buffer.alloc(0); return [recoveryTarHeader(entry.name, content.length, entry.mode, entry.type, entry.link), content, Buffer.alloc((512 - content.length % 512) % 512)]; }), Buffer.alloc(1024)]);
}
export function recoveryAppleDouble() {
  const value = Buffer.alloc(50); value.writeUInt32BE(0x00051607); value.writeUInt32BE(0x00020000, 4); value.writeUInt16BE(2, 24);
  value.writeUInt32BE(9, 26); value.writeUInt32BE(50, 30); value.writeUInt32BE(2, 38); value.writeUInt32BE(50, 42); return value;
}
export async function recoveryFixture(directory: string) {
  const product = path.join(directory, "product"), worktree = path.join(directory, "original"), archive = path.join(directory, "archive");
  await mkdir(product); originalGit(product, ["init", "-b", "main"]); originalGit(product, ["config", "user.name", "Fixture"]); originalGit(product, ["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(product, "README.md"), "base\n"); await writeFile(path.join(product, "executable"), "base executable\n", { mode: 0o755 });
  await symlink("README.md", path.join(product, "readme-link")); originalGit(product, ["add", "."]); originalGit(product, ["commit", "-m", "base"]);
  originalGit(product, ["worktree", "add", "-b", "codex/original", worktree]);
  return { product, ...await recoveryArchiveFixture(worktree, archive) };
}
export async function recoveryArchiveFixture(worktree: string, archive: string, options: { taskId?: string; toolingRevision?: string; archiveResourceId?: string; inventoryId?: string } = {}) {
  await mkdir(archive, { mode: 0o700 });
  const head = originalGit(worktree, ["rev-parse", "HEAD"]).toString().trim();
  const base = originalGit(worktree, ["archive", "--format=tar", "HEAD"]); await writeFile(path.join(archive, "base.tar.gz"), gzipSync(base), { mode: 0o644 });
  await writeFile(path.join(worktree, "README.md"), "unfinished source\n"); await writeFile(path.join(worktree, "staged"), "staged\n"); originalGit(worktree, ["add", "staged"]);
  await writeFile(path.join(worktree, "untracked"), Buffer.from([255, 0, 1, 23]));
  const changed = new Set(["README.md", "staged", "untracked"]), manifest = [];
  const names = [...new Set(originalGit(worktree, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean))].sort();
  for (const name of names) {
    const file = path.join(worktree, name), stat = await lstat(file), content = stat.isSymbolicLink() ? Buffer.from(await readlink(file)) : await readFile(file);
    manifest.push({ path: name, kind: stat.isSymbolicLink() ? "symlink" as const : "file" as const, mode: stat.mode & 0o111 ? 0o755 : 0o644, size: content.length, sha256: originalDigest(content), changed: changed.has(name), untracked: name === "untracked" });
  }
  const workEntries = [{ name: "._README.md", content: recoveryAppleDouble() }, ...await Promise.all([...changed].map(async name => ({ name, content: await readFile(path.join(worktree, name)) })))];
  await writeFile(path.join(archive, "work.tar.gz"), gzipSync(recoveryTar(workEntries)), { mode: 0o644 });
  await writeFile(path.join(archive, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  const controls: Record<string, Buffer> = { "index.patch": originalGit(worktree, ["diff", "--binary", "--cached", "HEAD"]), "tracked.patch": originalGit(worktree, ["diff", "--binary"]), "status.porcelain": originalGit(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), "base-tree.txt": originalGit(worktree, ["ls-tree", "-r", "-l", "HEAD"]), "changed-files.txt": Buffer.from([...changed].join("\n") + "\n") };
  for (const [name, content] of Object.entries(controls)) await writeFile(path.join(archive, name), content, { mode: 0o600 });
  const taskId = options.taskId ?? "task", toolingRevision = options.toolingRevision ?? "a".repeat(40), archiveResourceId = options.archiveResourceId ?? "archive", inventoryId = options.inventoryId ?? "inventory";
  const checksums = await Promise.all([...Object.keys(controls), "manifest.json", "base.tar.gz", "work.tar.gz"].map(async file => { const data = await readFile(path.join(archive, file)); return { file, size: data.length, sha256: originalDigest(data) }; }));
  const receipt = { task: taskId, source: worktree, archive, base: head, branch: originalGit(worktree, ["branch", "--show-current"]).toString().trim(), toolingPin: toolingRevision, checksums, trackedFiles: manifest.filter(entry => !entry.untracked).length, modifiedFiles: 2, untrackedFiles: 1, verifiedRestoredFiles: manifest.length };
  const receiptBytes = JSON.stringify(receipt); await writeFile(path.join(archive, "receipt.json"), receiptBytes, { mode: 0o600 });
  const sumBytes = [...checksums.map(entry => `${entry.sha256}  ${entry.file}`), `${originalDigest(receiptBytes)}  receipt.json`].join("\n") + "\n";
  await writeFile(path.join(archive, "SHA256SUMS"), sumBytes, { mode: 0o600 });
  await writeFile(path.join(archive, "resource-inventory.json"), JSON.stringify({ task: taskId, unrelated: "retain this inventory" }), { mode: 0o600 });
  await writeFile(path.join(archive, "base.tar.gz.interrupted"), "partial bytes are retained, never restored", { mode: 0o644 });
  await mkdir(path.join(archive, "restore-verification"), { mode: 0o700 }); await writeFile(path.join(archive, "restore-verification/old-output"), "older observation", { mode: 0o644 });
  await chmod(archive, 0o700);
  const selection: RecoveryWorkInput = { format: "base-work-tar/v1", archiveResourceId, manifestPath: path.join(archive, "manifest.json"), manifestSha256: originalDigest(JSON.stringify(manifest)), checksumsPath: "SHA256SUMS", checksumsSha256: originalDigest(sumBytes), receiptPath: "receipt.json", receiptSha256: originalDigest(receiptBytes), ownedPaths: [], retainedArchiveMembers: [{ resourceId: inventoryId }] };
  const resources = [{ id: archiveResourceId, key: "recovery", kind: "recovery-archive", purpose: "tooling", externalId: archive, state: "ready", metadata: {} }, { id: inventoryId, key: "inventory", kind: "resource-inventory", purpose: "tooling", externalId: path.join(archive, "resource-inventory.json"), state: "ready", metadata: {} }];
  return { worktree, archive, manifest, resources, selection, input: { taskId, toolingRevision, worktree, branch: receipt.branch, approvedHead: head, resources, originalWork: selection } };
}
