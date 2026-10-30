import { dlopen } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { z } from "zod";

const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const InactiveSocketIdentity = z.object({
  dev: Integer, ino: Integer, mode: Integer, uid: Integer, gid: Integer,
  nlink: z.literal(1), size: Integer, mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/),
}).strict();
export type InactiveSocketIdentity = z.infer<typeof InactiveSocketIdentity>;

function identity(stat: BigIntStats): InactiveSocketIdentity {
  if (!stat.isSocket() || stat.uid !== BigInt(process.getuid!()) || stat.nlink !== 1n) throw new Error("Cleanup requires an exact unshared task-owned Unix socket");
  return InactiveSocketIdentity.parse({ dev: Number(stat.dev), ino: Number(stat.ino), mode: Number(stat.mode), uid: Number(stat.uid), gid: Number(stat.gid), nlink: Number(stat.nlink), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
}
const same = (left: InactiveSocketIdentity, right: InactiveSocketIdentity) => Object.keys(left).every(key => left[key as keyof typeof left] === right[key as keyof typeof right]);

// This constant program runs in an isolated process, with the exact parent
// directory inherited as fd 3. fchdir changes only that child's cwd. Connecting
// to a basename works even when the captured tree exceeds sockaddr_un's limit.
// No task path or metadata is interpolated into executable code.
const probeProgram = String.raw`
import { dlopen, toArrayBuffer } from "bun:ffi";
import { closeSync, fstatSync, lstatSync, readSync } from "node:fs";
let library;
try {
  const bytes = Buffer.alloc(8193); let size = 0;
  while (size < bytes.length) { const count = readSync(0, bytes, size, bytes.length - size); if (!count) break; size += count; }
  if (size > 8192) throw Error();
  const input = JSON.parse(bytes.subarray(0, size).toString());
  if (typeof input.name !== "string" || !input.name || input.name === "." || input.name === ".." || input.name.includes("/") || input.name.includes("\0")) throw Error();
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") throw Error();
  const name = Buffer.from(input.name);
  if (name.length > (mac ? 103 : 107)) throw Error();
  library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    fchdir: { args: ["i32"], returns: "i32" },
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
    [mac ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
  });
  const parent = fstatSync(3, { bigint: true });
  if (!parent.isDirectory() || String(parent.dev) !== input.parent.dev || String(parent.ino) !== input.parent.ino || String(parent.mode) !== input.parent.mode || library.symbols.fchdir(3) !== 0) throw Error();
  const inspect = () => {
    const stat = lstatSync(input.name, { bigint: true });
    if (!stat.isSocket() || stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n) throw Error();
    const actual = { dev: Number(stat.dev), ino: Number(stat.ino), mode: Number(stat.mode), uid: Number(stat.uid), gid: Number(stat.gid), nlink: Number(stat.nlink), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    if (Object.keys(actual).some(key => actual[key] !== input.expected[key])) throw Error();
    return actual;
  };
  const address = Buffer.alloc(2 + name.length + 1);
  if (mac) { address[0] = address.length; address[1] = 1; } else address.writeUInt16LE(1);
  name.copy(address, 2);
  for (const type of [1, 2]) {
    inspect();
    const fd = library.symbols.socket(1, type, 0);
    if (fd < 0) throw Error();
    try {
      const result = library.symbols.connect(fd, address, address.length);
      const errno = new Int32Array(toArrayBuffer(library.symbols[mac ? "__error" : "__errno_location"](), 0, 4))[0];
      // Both protocols must find an unbound inode. Wrong protocol is a live
      // endpoint, including STREAM sockets which have not called listen().
      if (result !== -1 || errno !== (mac ? 61 : 111)) throw Error();
    } finally { closeSync(fd); }
    inspect();
  }
  const after = fstatSync(3, { bigint: true });
  if (after.dev !== parent.dev || after.ino !== parent.ino || after.mode !== parent.mode) throw Error();
  process.stdout.write(JSON.stringify({ version: 1, inactive: true, identity: inspect() }));
} catch { process.exitCode = 1; }
finally { if (library) library.close(); }
`;

type Hooks = { beforeProbe?: () => void | Promise<void>; afterProbe?: () => void | Promise<void>; afterSpawn?: (pid: number) => void };
/** A single refused STREAM connection cannot distinguish stale from bound but
 * non-listening. Require refused STREAM and DGRAM probes against the same inode.
 * All other outcomes (including timeout) preserve the tree and reject cleanup. */
export async function observeInactiveUnixSocket(file: string, expected?: InactiveSocketIdentity, hooks: Hooks = {}): Promise<InactiveSocketIdentity> {
  if (!process.getuid || !["darwin", "linux"].includes(process.platform)) throw new Error("Unix socket observation is unsupported on this platform");
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.includes("\0")) throw new Error("Socket observation requires an exact absolute path");
  const mac = process.platform === "darwin";
  const openat = mac ? "__openat" : "openat";
  const library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { [openat]: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" } });
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (mac ? 0x01000000 : 0x80000);
  const held: Array<{ fd: number; file: string; stat: BigIntStats }> = [];
  try {
    const root = openSync(path.parse(file).root, flags);
    held.push({ fd: root, file: path.parse(file).root, stat: fstatSync(root, { bigint: true }) });
    for (const part of path.dirname(file).slice(path.parse(file).root.length).split(path.sep).filter(Boolean)) {
      const prior = held.at(-1)!;
      const fd = library.symbols[openat]!(prior.fd, Buffer.from(`${part}\0`), flags, 0) as number;
      if (fd < 0) throw new Error("Socket parent directory identity is unverified");
      held.push({ fd, file: path.join(prior.file, part), stat: fstatSync(fd, { bigint: true }) });
    }
    const assertParents = () => {
      for (const entry of held) {
        const current = lstatSync(entry.file, { bigint: true }), fd = fstatSync(entry.fd, { bigint: true });
        if (!current.isDirectory() || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino || current.mode !== entry.stat.mode || fd.dev !== entry.stat.dev || fd.ino !== entry.stat.ino || fd.mode !== entry.stat.mode) throw new Error("Socket parent directory identity changed");
      }
    };
    assertParents();
    const before = identity(lstatSync(file, { bigint: true }));
    if (expected && !same(before, InactiveSocketIdentity.parse(expected))) throw new Error("Prepared socket identity changed");
    await hooks.beforeProbe?.();
    const parent = held.at(-1)!;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", probeProgram], { env: {}, stdio: ["pipe", "pipe", "pipe", parent.fd] });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(9); }, 2000);
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = []; let length = 0;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length;
          if (length > 4096) { child.kill(9); throw new Error("Socket observation exceeded its output bound"); }
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString();
      } finally { reader.releaseLock(); }
    };
    try {
      hooks.afterSpawn?.(child.pid);
      child.stdin.write(JSON.stringify({ name: path.basename(file), expected: before, parent: { dev: String(parent.stat.dev), ino: String(parent.stat.ino), mode: String(parent.stat.mode) } }));
      child.stdin.end();
      const [stdout, stderr, code] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
      if (timedOut || code !== 0 || stderr) throw new Error("Unix socket is active or its inactivity could not be verified");
      const proof = z.object({ version: z.literal(1), inactive: z.literal(true), identity: InactiveSocketIdentity }).strict().parse(JSON.parse(stdout));
      if (!same(before, proof.identity)) throw new Error("Socket observation identity changed");
    } finally {
      // Input failures happen before output collection starts. Always terminate
      // and reap that owned child before releasing its deadline or parent fd.
      try { if (child.exitCode === null) child.kill(9); await child.exited; }
      finally { clearTimeout(timeout); }
    }
    await hooks.afterProbe?.();
    assertParents();
    if (!same(before, identity(lstatSync(file, { bigint: true })))) throw new Error("Socket identity changed during observation");
    return before;
  } finally { for (const entry of held.reverse()) closeSync(entry.fd); library.close(); }
}
