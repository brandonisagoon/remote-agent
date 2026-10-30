import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, symlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { archiveMember } from "./archive-observation.ts";
import { assertFinalizationPath } from "./finalization-resources.ts";

export type RecoveryTarMember = { kind: "file" | "symlink"; size: number; executable: boolean; sha256?: string; gitSha?: string };
type TarInput = { path: string; size: number; sha256: string };
const utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (value: Uint8Array) => utf8.decode(value).replace(/\0.*$/s, "");
const octal = (value: Uint8Array) => { const raw = text(value).trim(); if (!/^[0-7]*$/.test(raw)) throw new Error("Unsupported recovery tar numeric encoding"); const result = raw ? parseInt(raw, 8) : 0; if (!Number.isSafeInteger(result)) throw new Error("Recovery tar number is too large"); return result; };
export function safeRecoveryLink(relative: string, link: string) {
  if (!link || path.isAbsolute(link) || link.includes("\0") || link.includes("\\")) throw new Error("Recovery symlink escapes its archive");
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), link));
  archiveMember("/archive", target);
  if (target === ".git" || target.startsWith(".git/")) throw new Error("Recovery symlink points into Git administration");
}
/** Resolve links as data, without following them on disk. Lexically in-root
 * links can still escape through another link followed by '..'. */
export function assertRecoveryLinkSet(links: Map<string, string>) {
  for (const [relative, link] of links) {
    safeRecoveryLink(relative, link);
    const queue = [...path.posix.dirname(relative).split("/"), ...link.split("/")], stack: string[] = []; let expansions = 0;
    while (queue.length) {
      const part = queue.shift()!; if (part === "." || part === "") continue;
      if (part === "..") { if (!stack.length) throw new Error("Recovery symlink chain escapes its archive"); stack.pop(); continue; }
      const candidate = [...stack, part].join("/"), target = links.get(candidate);
      if (target !== undefined) { if (++expansions > links.size + 1) throw new Error("Recovery symlink chain is cyclic"); queue.unshift(...target.split("/")); }
      else stack.push(part);
    }
    const resolved = stack.join("/");
    if (resolved === ".git" || resolved.startsWith(".git/")) throw new Error("Recovery symlink chain points into Git administration");
  }
}
function appleDouble(bytes: Buffer) {
  if (bytes.length < 26 || bytes.readUInt32BE(0) !== 0x00051607 || bytes.readUInt32BE(4) !== 0x00020000) throw new Error("Unlisted recovery tar member is not AppleDouble metadata");
  const count = bytes.readUInt16BE(24), end = 26 + count * 12, spans: Array<[number, number]> = [];
  if (!count || end > bytes.length) throw new Error("Invalid AppleDouble metadata");
  const ids = new Set<number>();
  for (let n = 0; n < count; n++) {
    const id = bytes.readUInt32BE(26 + n * 12), offset = bytes.readUInt32BE(30 + n * 12), length = bytes.readUInt32BE(34 + n * 12);
    if (![2, 9].includes(id) || ids.has(id) || offset < end || offset + length > bytes.length || spans.some(([a, b]) => length && offset < b && offset + length > a)) throw new Error("Unsupported AppleDouble metadata");
    ids.add(id); spans.push([offset, offset + length]);
  }
}

/** Each gzip/tar stream is owned by one no-follow file descriptor. Member sizes
 * and hashes come from the selected receipt and independently observed Git tree.
 * No host tar extraction, whole-file buffers, links-as-directories or xattrs. */
export async function restoreRecoveryTar(input: TarInput, expected: Map<string, RecoveryTarMember>, destination?: string, options: { appleDouble?: boolean; write?: (relative: string) => boolean } = {}) {
  await assertFinalizationPath(input.path);
  if (!Number.isSafeInteger(input.size) || input.size < 0 || expected.size > 250_000) throw new Error("Recovery archive exceeds its declared bound");
  const directories = new Set<string>();
  for (const [name, entry] of expected) {
    archiveMember("/archive", name);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || name === ".git" || name.startsWith(".git/")) throw new Error("Recovery archive contains invalid declared material");
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (expected.has(parent)) throw new Error("Recovery archive traverses a file or symlink"); directories.add(parent);
    }
  }
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size !== input.size) { await handle.close(); throw new Error("Recovery archive identity or size changed"); }
  const hash = createHash("sha256"); let compressed = 0, expanded = 0;
  const total = [...expected.values()].reduce((sum, entry) => sum + entry.size, 0);
  // Tar headers, padding, bounded PAX and paired AppleDouble are accounted for
  // separately from the exact declared content size; gzip bombs stop here.
  const expansionLimit = total + (expected.size + 1) * 131_072 + 10_240;
  if (!Number.isSafeInteger(expansionLimit)) { await handle.close(); throw new Error("Recovery archive declared size is invalid"); }
  const source = Readable.from((async function* () {
    while (compressed < before.size) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, before.size - compressed));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, compressed);
      if (!bytesRead) throw new Error("Recovery archive changed while reading");
      compressed += bytesRead; hash.update(buffer.subarray(0, bytesRead)); yield buffer.subarray(0, bytesRead);
    }
  })());
  const unzip = createGunzip({ chunkSize: 64 * 1024 });
  source.on("error", error => unzip.destroy(error)); source.pipe(unzip);
  const iterator = unzip[Symbol.asyncIterator](); let pending = Buffer.alloc(0), cursor = 0;
  const take = async (length: number, consume: (chunk: Buffer) => void | Promise<void>) => {
    while (length) {
      if (cursor === pending.length) {
        const next = await iterator.next(); if (next.done) throw new Error("Incomplete recovery tar archive");
        pending = Buffer.from(next.value); cursor = 0; expanded += pending.length;
        if (expanded > expansionLimit) throw new Error("Recovery archive exceeds its declared expansion bound");
      }
      const count = Math.min(length, pending.length - cursor), chunk = pending.subarray(cursor, cursor + count);
      await consume(chunk); cursor += count; length -= count;
    }
  };
  const buffer = async (length: number) => { const output = Buffer.alloc(length); let offset = 0; await take(length, chunk => { output.set(chunk, offset); offset += chunk.length; }); return output; };
  const seen = new Set<string>(), metadata = new Set<string>(), directorySeen = new Set<string>(), links = new Map<string, string>(); let pendingPath: string | undefined, headers = 0;
  try {
    while (true) {
      const header = await buffer(512);
      if (header.every(byte => byte === 0)) {
        if (pendingPath !== undefined) throw new Error("Dangling recovery extended header");
        if ((await buffer(512)).some(byte => byte !== 0)) throw new Error("Recovery tar lacks its complete end marker");
        // Consume all padding and the gzip checksum before accepting any proof.
        if (pending.subarray(cursor).some(byte => byte !== 0)) throw new Error("Recovery tar has trailing data");
        cursor = pending.length;
        while (true) { const next = await iterator.next(); if (next.done) break; expanded += next.value.length; if (expanded > expansionLimit || next.value.some((byte: number) => byte !== 0)) throw new Error("Recovery tar has trailing data"); }
        break;
      }
      if (++headers > (expected.size + directories.size + 1) * 4) throw new Error("Recovery tar has excessive headers");
      let checksum = 0; for (let n = 0; n < 512; n++) checksum += n >= 148 && n < 156 ? 32 : header[n]!;
      if (checksum !== octal(header.subarray(148, 156))) throw new Error("Invalid recovery tar checksum");
      const size = octal(header.subarray(124, 136)), mode = octal(header.subarray(100, 108)), type = String.fromCharCode(header[156] || 48);
      if (type === "x" || type === "g") {
        if (size > 64 * 1024 || pendingPath !== undefined) throw new Error("Invalid recovery extended header");
        const content = await buffer(size); let at = 0;
        while (at < content.length) {
          const space = content.indexOf(32, at), length = Number(content.subarray(at, space).toString());
          if (space < at || !Number.isSafeInteger(length) || length < 5 || at + length > content.length || content[at + length - 1] !== 10) throw new Error("Invalid recovery PAX record");
          const record = content.subarray(space + 1, at + length - 1), equals = record.indexOf(61);
          if (equals < 1) throw new Error("Invalid recovery PAX value");
          const key = utf8.decode(record.subarray(0, equals));
          if (["LIBARCHIVE.xattr.com.apple.provenance", "SCHILY.xattr.com.apple.provenance"].includes(key)) {
            // libarchive stores some xattrs as raw bytes. They are bounded,
            // checksum-covered metadata, never paths or restored attributes.
          } else {
            const value = utf8.decode(record.subarray(equals + 1));
            if (value.includes("\0")) throw new Error("Invalid recovery PAX value");
            if (key === "path" && type === "x") { if (pendingPath !== undefined) throw new Error("Duplicate recovery PAX path"); pendingPath = value; }
            else if (!["mtime", "atime", "ctime", "comment"].includes(key)) throw new Error("Unsupported recovery PAX identity");
          }
          at += length;
        }
        await take((512 - size % 512) % 512, () => {}); continue;
      }
      const prefix = text(header.subarray(345, 500)); let name = pendingPath ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join("/"); pendingPath = undefined;
      if (name.startsWith("./")) name = name.slice(2);
      if (type === "5" && name.endsWith("/")) name = name.slice(0, -1);
      archiveMember("/archive", name);
      if (type === "5") {
        if (!directories.has(name) || directorySeen.has(name) || size !== 0) throw new Error("Unlisted or duplicate recovery directory"); directorySeen.add(name); continue;
      }
      const entry = expected.get(name);
      if (!entry && options.appleDouble && path.posix.basename(name).startsWith("._")) {
        const paired = path.posix.join(path.posix.dirname(name), path.posix.basename(name).slice(2));
        if (!expected.has(paired) || metadata.has(paired) || type !== "0" || size > 64 * 1024) throw new Error("Unpaired recovery metadata");
        appleDouble(await buffer(size)); metadata.add(paired); await take((512 - size % 512) % 512, () => {}); continue;
      }
      if (!entry || seen.has(name) || Boolean(mode & 0o111) !== entry.executable || (mode & 0o7000)) throw new Error("Unlisted, duplicate or changed recovery tar member");
      if (type !== (entry.kind === "symlink" ? "2" : "0") || size !== (entry.kind === "symlink" ? 0 : entry.size)) throw new Error("Recovery tar member type or size changed");
      const digest = createHash("sha256"), git = createHash("sha1").update(`blob ${entry.size}\0`);
      const output = destination && (!options.write || options.write(name)) ? archiveMember(destination, name) : undefined;
      if (output) { await assertFinalizationPath(path.dirname(output)); await mkdir(path.dirname(output), { recursive: true, mode: 0o700 }); await assertFinalizationPath(path.dirname(output)); }
      if (entry.kind === "symlink") {
        const link = text(header.subarray(157, 257)); safeRecoveryLink(name, link);
        links.set(name, link);
        const content = Buffer.from(link); if (content.length !== entry.size) throw new Error("Recovery symlink size changed"); digest.update(content); git.update(content);
        if (output) await symlink(link, output);
      } else {
        const out = output ? await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o700 : 0o600) : undefined;
        try { await take(size, async chunk => { digest.update(chunk); git.update(chunk); if (out) { let offset = 0; while (offset < chunk.length) { const written = await out.write(chunk, offset); if (!written.bytesWritten) throw new Error("Recovery restore write failed"); offset += written.bytesWritten; } } }); }
        finally { await out?.close(); }
      }
      if (entry.sha256 && digest.digest("hex") !== entry.sha256 || entry.gitSha && git.digest("hex") !== entry.gitSha) throw new Error("Recovery tar member content changed");
      seen.add(name); await take((512 - size % 512) % 512, () => {});
    }
    if (seen.size !== expected.size || compressed !== input.size || hash.digest("hex") !== input.sha256) throw new Error("Recovery tar is incomplete or its compressed digest changed");
    assertRecoveryLinkSet(links);
    const after = await handle.stat(), leaf = await lstat(input.path);
    if (["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after] || before[key as keyof typeof before] !== leaf[key as keyof typeof leaf])) throw new Error("Recovery archive changed during restore");
    await assertFinalizationPath(input.path);
    return { files: seen.size, metadata: metadata.size, expandedBytes: expanded };
  } finally { source.destroy(); unzip.destroy(); await handle.close(); }
}
