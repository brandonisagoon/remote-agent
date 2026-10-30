import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeInactiveUnixSocket } from "./unix-socket.ts";
import { fixtureSocket } from "./unix-socket.test-support.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "d187-")));
  roots.push(root); return { root, file: path.join(root, "test.sock") };
}

for (const state of ["stale", "stale-datagram"] as const) test(`preserves and independently verifies ${state} socket inode`, async () => {
  const f = await fixture(); fixtureSocket(f.file, state);
  const before = await lstat(f.file, { bigint: true }), proof = await observeInactiveUnixSocket(f.file);
  expect(proof).toMatchObject({ ino: Number(before.ino), uid: process.getuid!(), nlink: 1, mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) });
  expect(await observeInactiveUnixSocket(f.file, proof)).toEqual(proof);
  expect((await lstat(f.file)).isSocket()).toBeTrue();
});

for (const state of ["bound", "listening", "datagram"] as const) test(`rejects ${state} endpoints without treating refused STREAM alone as inactivity`, async () => {
  const f = await fixture(), socket = fixtureSocket(f.file, state), before = await lstat(f.file);
  try {
    await expect(observeInactiveUnixSocket(f.file)).rejects.toThrow("inactivity could not be verified");
    expect((await lstat(f.file)).ino).toBe(before.ino);
  } finally { socket.close(); }
  expect((await observeInactiveUnixSocket(f.file)).ino).toBe(before.ino);
});

test("probes through the captured parent descriptor beyond sockaddr_un path length", async () => {
  const f = await fixture(); await mkdir(path.join(f.root, "source")); const file = path.join(f.root, "source", "test.sock"); fixtureSocket(file);
  const before = await observeInactiveUnixSocket(file), captured = path.join(f.root, "retained-".repeat(20));
  await rename(path.dirname(file), captured);
  expect(path.join(captured, "test.sock").length).toBeGreaterThan(108);
  expect(await observeInactiveUnixSocket(path.join(captured, "test.sock"), before)).toEqual(before);
});

for (const when of ["beforeProbe", "afterProbe"] as const) test(`rejects socket replacement ${when} while preserving both inodes`, async () => {
  const f = await fixture(); fixtureSocket(f.file); const original = await lstat(f.file), saved = path.join(f.root, "saved.sock");
  await expect(observeInactiveUnixSocket(f.file, undefined, { [when]: async () => { await rename(f.file, saved); fixtureSocket(f.file); } })).rejects.toThrow();
  expect((await lstat(saved)).ino).toBe(original.ino);
  expect((await lstat(f.file)).isSocket()).toBeTrue();
});

test("rejects replaced ancestors and leaf symlinks without following an outside endpoint", async () => {
  const f = await fixture(), parent = path.join(f.root, "parent"), saved = path.join(f.root, "saved"), outside = path.join(f.root, "outside");
  await mkdir(parent); await mkdir(outside); await writeFile(path.join(outside, "sentinel"), "preserve");
  const file = path.join(parent, "socket"); fixtureSocket(file); fixtureSocket(path.join(outside, "socket"));
  await expect(observeInactiveUnixSocket(file, undefined, { beforeProbe: async () => { await rename(parent, saved); await symlink(outside, parent); } })).rejects.toThrow("parent directory identity changed");
  expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("preserve");
  expect((await lstat(path.join(saved, "socket"))).isSocket()).toBeTrue();
  await symlink(path.join(outside, "socket"), f.file);
  await expect(observeInactiveUnixSocket(f.file)).rejects.toThrow("task-owned Unix socket");
});

test("rejects missing entries, ordinary files, FIFOs and changed owner proofs", async () => {
  const f = await fixture();
  await expect(observeInactiveUnixSocket(f.file)).rejects.toThrow();
  await writeFile(f.file, "ordinary"); await expect(observeInactiveUnixSocket(f.file)).rejects.toThrow("task-owned Unix socket"); await rm(f.file);
  expect(Bun.spawnSync(["mkfifo", f.file]).exitCode).toBe(0);
  await expect(observeInactiveUnixSocket(f.file)).rejects.toThrow("task-owned Unix socket"); await rm(f.file);
  fixtureSocket(f.file); const proof = await observeInactiveUnixSocket(f.file);
  await expect(observeInactiveUnixSocket(f.file, { ...proof, uid: proof.uid + 1 })).rejects.toThrow("Prepared socket identity changed");
});


test("a failed input setup reaps its owned probe child before returning", async () => {
  const f = await fixture(); fixtureSocket(f.file); let pid = 0;
  await expect(observeInactiveUnixSocket(f.file, undefined, { afterSpawn(childPid) { pid = childPid; throw new Error("injected input failure"); } })).rejects.toThrow("injected input failure");
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await lstat(f.file)).isSocket()).toBeTrue();
});


test("an unresponsive owned probe is killed and reaped at its deadline", async () => {
  const f = await fixture(); fixtureSocket(f.file); let pid = 0; const started = Date.now();
  await expect(observeInactiveUnixSocket(f.file, undefined, { afterSpawn(childPid) { pid = childPid; process.kill(pid, "SIGSTOP"); } })).rejects.toThrow("inactivity could not be verified");
  expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  expect(Date.now() - started).toBeLessThan(4500);
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await lstat(f.file)).isSocket()).toBeTrue();
});
