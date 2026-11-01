import { constants, closeSync, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { dlopen, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { retirementDigest } from "./retirement-receipts.ts";

const limits = { files: 4096, directories: 256, bytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024 };
const identity = (s: BigIntStats) => ({ dev: Number(s.dev), ino: Number(s.ino), mode: Number(s.mode), uid: Number(s.uid), gid: Number(s.gid),
  size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), nlink: Number(s.nlink) });
export type GeneratedCacheEntry = ReturnType<typeof identity> & { path: string; kind: "directory" | "file"; sha256?: string };
export type GeneratedCacheScan = { entries: GeneratedCacheEntry[]; bytes: number; digest: string };
const same = (a: unknown, b: unknown) => retirementDigest(a) === retirementDigest(b);

/** Data-only traversal. Every component is opened relative to a held directory
 * descriptor; no child is reopened through its mutable absolute pathname. */
export function scanOwnedGeneratedCache(root: string): GeneratedCacheScan {
  const darwin = process.platform === "darwin";
  if (!darwin && process.platform !== "linux") throw Error("Generated cache capture platform is unsupported");
  if (!path.isAbsolute(root) || path.normalize(root) !== root || path.basename(root) !== "node_modules") throw Error("Generated cache root is invalid");
  const library = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
    fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" }, readdir: { args: ["ptr"], returns: "ptr" }, closedir: { args: ["ptr"], returns: "i32" },
    [darwin ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
  });
  const api = library.symbols;
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const openChild = (fd: number, name: string, directory: boolean) => {
    const next = api.openat!(fd, Buffer.from(name + "\0"), flags | (directory ? constants.O_DIRECTORY : 0), 0) as number;
    if (next < 0) throw Error("Generated cache descriptor could not be opened without following links");
    if (api.fcntl!(next, 2, 1) !== 0) { closeSync(next); throw Error("Generated cache descriptor could not be isolated"); }
    return next;
  };
  const openRoot = () => {
    let fd = openSync("/", flags | constants.O_DIRECTORY);
    try {
      for (const name of root.slice(1).split("/")) {
        if (!name || name === "." || name === ".." || name.includes("\0")) throw Error("Generated cache ancestor is invalid");
        const next = openChild(fd, name, true); closeSync(fd); fd = next;
      }
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  };
  const names = (fd: number) => {
    // A new open description is required: dup shares the directory offset.
    const duplicate = openChild(fd, ".", true);
    const directory = api.fdopendir!(duplicate);
    if (!directory) { closeSync(duplicate); throw Error("Generated cache directory stream is unavailable"); }
    const result: string[] = [];
    try {
      const errno = api[darwin ? "__error" : "__errno_location"]!();
      if (!errno) throw Error("Generated cache enumeration status is unavailable");
      const status = new Int32Array(toArrayBuffer(errno as Pointer, 0, 4));
      while (true) {
        status[0] = 0;
        const entry = api.readdir!(directory);
        if (!entry) { if (status[0]) throw Error("Generated cache enumeration was incomplete"); break; }
        const recordBytes = read.u16(entry, 16), offset = darwin ? 21 : 19;
        const length = darwin ? read.u16(entry, 18) : recordBytes - offset - 1;
        if (recordBytes <= offset || length < 1 || length > 1023 || offset + length >= recordBytes) throw Error("Generated cache directory record is invalid");
        const raw = Buffer.from(toArrayBuffer(entry, offset, darwin ? length : recordBytes - offset));
        const end = darwin ? length : raw.indexOf(0);
        if (end < 0) throw Error("Generated cache name is unterminated");
        const name = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, end));
        if ([".", ".."].includes(name)) continue;
        if (!name || name.includes("/") || name.includes("\0") || result.includes(name) || result.length >= 4352) throw Error("Generated cache member name is invalid");
        result.push(name);
      }
      return result.sort();
    } finally { api.closedir!(directory); }
  };
  let rootFd = -1;
  try {
    rootFd = openRoot();
    const baseline = fstatSync(rootFd, { bigint: true });
    const entries: GeneratedCacheEntry[] = []; let files = 0, directories = 0, bytes = 0;
    const check = (s: BigIntStats) => {
      if (s.uid !== BigInt(process.getuid!()) || s.dev !== baseline.dev || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1n))) throw Error("Generated cache contains foreign, shared, mounted or special material");
    };
    const visit = (fd: number, relative: string) => {
      const before = fstatSync(fd, { bigint: true }); check(before);
      if (relative !== "." && !relative.includes("/") && !before.isDirectory()) throw Error("Generated cache top-level entries must be directories");
      if (before.isDirectory()) {
        if (++directories > limits.directories) throw Error("Generated cache directory bound exceeded");
        const children = names(fd);
        if (relative === "." && (!children.length || children.some(name => ![".vite", ".vite-temp"].includes(name)))) throw Error("Generated cache is not an explicitly bounded Vite data tree");
        entries.push({ path: relative, kind: "directory", ...identity(before) });
        for (const name of children) {
          // Opening with no-follow precedes all type decisions. Nonblocking
          // means an injected FIFO cannot stall this observer.
          const child = openChild(fd, name, false);
          try { visit(child, relative === "." ? name : relative + "/" + name); } finally { closeSync(child); }
        }
        if (!same(children, names(fd))) throw Error("Generated cache membership changed during observation");
      } else {
        if (++files > limits.files || before.size > BigInt(limits.fileBytes) || bytes + Number(before.size) > limits.bytes) throw Error("Generated cache byte bound exceeded");
        const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let offset = 0;
        while (offset < Number(before.size)) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
          if (!count) throw Error("Generated cache file changed during observation");
          hash.update(buffer.subarray(0, count)); offset += count;
        }
        bytes += offset; entries.push({ path: relative, kind: "file", ...identity(before), sha256: hash.digest("hex") });
      }
      if (!same(identity(before), identity(fstatSync(fd, { bigint: true })))) throw Error("Generated cache identity changed during observation");
    };
    visit(rootFd, ".");
    const fresh = openRoot();
    try { if (!same(identity(baseline), identity(fstatSync(fresh, { bigint: true })))) throw Error("Generated cache ancestor or root changed during observation"); }
    finally { closeSync(fresh); }
    return { entries, bytes, digest: retirementDigest(entries) };
  } finally { if (rootFd >= 0) closeSync(rootFd); library.close(); }
}
