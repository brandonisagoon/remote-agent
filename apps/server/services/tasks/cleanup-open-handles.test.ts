import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertLinkedPathsIdle, assertLinkedRootIdle, assertRootHandleInventory } from "./cleanup-open-handles.ts";
import { preparationFailure } from "./preparation-errors.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const record = (name: string, fd = "cwd", type = "DIR") => Buffer.from(`p123\0f${fd}\0t${type}\0n${name}\0\n`);
test.each([
  ["p123\0f167\0nvnode: Permission denied at /private/secret\0\n", "missing", "missing-type", "nonabsolute"],
  ["p123\0f167\0tUNKN\0n/private/secret\0\n", "UNKN", "unknown-type", "absolute"],
  ["p123\0f167\0tREG\0\n", "REG", "missing-name", "missing"],
  ["p123\0f167\0tREG\0nrelative-secret\0\n", "REG", "nonabsolute-path", "nonabsolute"],
] as const)("unidentified handle survives the preparation diagnostic boundary: %s", (raw, type, problem, name) => {
  let error: unknown; try { assertRootHandleInventory("/private/task", Buffer.from(raw)); } catch (caught) { error = caught; }
  const diagnostic = preparationFailure(error);
  expect(diagnostic).toMatchObject({ code: "FILESYSTEM_UNVERIFIED", filesystemHandle: { processId: 123, descriptor: "167", type, problem, name } });
  expect(diagnostic.reason).toContain(problem);
  expect(JSON.stringify(diagnostic)).not.toMatch(/secret|Permission denied|\/private|vnode:/);
});
test("unsupported descriptor and type text are classified without retaining their contents", () => {
  let error: unknown;
  try { assertRootHandleInventory("/private/task", Buffer.from("p123\0fprivate-descriptor-token\0tprivate-type-token\0\n")); } catch (caught) { error = caught; }
  expect(preparationFailure(error)).toMatchObject({ code: "FILESYSTEM_UNVERIFIED", filesystemHandle: { processId: 123, descriptor: "other", type: "other", problem: "missing-name", name: "missing" } });
  expect(JSON.stringify(preparationFailure(error))).not.toMatch(/private|token/);
});
test.each(["/private/task", "/private/task/file with spaces", "/private/task/file\nwith newline", "/private/task (deleted)"])("exact open handle refuses %s without pathname tokenization", file => {
  expect(() => assertRootHandleInventory("/private/task", record(file))).toThrow("still holds");
});
test("unrelated paths and non-filesystem handles do not invent a root match", () => {
  assertRootHandleInventory("/private/task", Buffer.concat([record("/private/task-other"), record("0x123 -> 0x456", "5", "PIPE")]));
});
test.each(["NPOLICY", "NEXUS", "PIPE"])("a nameless %s kernel descriptor does not hide filesystem handles", type => {
  const kernel = Buffer.from(`p123\0f5\0t${type}\0\n`);
  assertRootHandleInventory("/private/task", kernel);
  expect(() => assertRootHandleInventory("/private/task", Buffer.concat([kernel, record("/private/task", "6")]))).toThrow("still holds");
});
test.each(["DIR", "REG", "FIFO", "UNKN", "NEW-TYPE"])("a nameless %s handle fails closed", type => {
  expect(() => assertRootHandleInventory("/private/task", Buffer.from(`p123\0f5\0t${type}\0\n`))).toThrow();
});
test.each(["", "p1\0", "p1\0fcwd\0tDIR\0nunknown\0", "p1\0fcwd\0n/private/elsewhere\0", "p1\0f3\0tunknown\0nunknown\0", "p1\0xunexpected\0"])("unknown or incomplete handle inventory fails closed", value => {
  expect(() => assertRootHandleInventory("/private/task", Buffer.from(value))).toThrow();
});
test.each(["timeout", "diagnostic", "empty", "malformed", "command"])("an uncertain %s observation cannot become absence", async failure => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handle-observer-"))); roots.push(root);
  const result = { exitCode: 0, stdout: record("/outside"), stderr: Buffer.alloc(0) };
  await expect(assertLinkedRootIdle(root, args => args[0] === "ps" ? { ...result, stdout: Buffer.from(failure === "command" ? `123 bun ${root}/server.ts\n` : "123 unrelated\n") }
    : { ...result, ...(failure === "timeout" ? { exitCode: null, signalCode: "SIGKILL" } : failure === "diagnostic" ? { stderr: Buffer.from("partial data") } : failure === "empty" ? { stdout: Buffer.alloc(0) } : failure === "malformed" ? { stdout: Buffer.from("partial") } : {}) })).rejects.toThrow();
});
test("actual disposable cwd writer is refused without walking a dependency tree", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handle-live-fixture-"))); roots.push(root);
  const program = path.join(root, "idle.ts"); await writeFile(program, 'console.log("ready"); setTimeout(() => {}, 30000);\n');
  const child = Bun.spawn([process.execPath, "--no-env-file", "idle.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader(); await reader.read(); await reader.cancel();
  // Keep real kernel descriptor/path observation, scoped to this disposable
  // writer. Unrelated CI processes may correctly make the global scan unknown.
  const observeWriter = (args: string[]) => Bun.spawnSync(args[0] === "lsof" ? [...args, "-a", "-p", String(child.pid)] : args,
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  try { await expect(assertLinkedRootIdle(root, observeWriter)).rejects.toThrow("still holds"); }
  finally { child.kill(9); await child.exited; }
  const gone = observeWriter(["lsof", "-nP", "-F0pftn"]);
  expect(gone.exitCode).toBe(1); expect(gone.stdout.length).toBe(0); expect(gone.stderr.length).toBe(0);
}, 20_000);

test("one complete handle snapshot covers every selected exact file", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handles-batch-"))); roots.push(root);
  const files = [path.join(root, "one"), path.join(root, "two")], calls: string[] = [];
  const run = (args: string[]) => { calls.push(args[0]!); return { exitCode: 0, stdout: args[0] === "ps" ? Buffer.from("123 unrelated\n") : record("/outside"), stderr: Buffer.alloc(0) }; };
  await assertLinkedPathsIdle(files, run); expect(calls).toEqual(["ps", "lsof"]);
  await expect(assertLinkedPathsIdle(files, args => ({ ...run(args), ...(args[0] === "lsof" ? { stdout: record(files[1]!, "7", "REG") } : {}) }))).rejects.toThrow("still holds");
  await expect(assertLinkedPathsIdle(files, args => ({ ...run(args), ...(args[0] === "lsof" ? { stdout: Buffer.from("partial") } : {}) }))).rejects.toThrow("incomplete");
});

// Real Darwin lsof 4.91 output captured while a disposable process closed its
// own file descriptors: exit 0, empty stderr, but no type/path for this vnode.
const unavailable = Buffer.from("p123\0f167\0nvnode: FD unavailable\0\n");
async function inspectSamples(samples: Buffer[], processOutput = "123 unrelated\n") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handle-retry-"))); roots.push(root);
  const commands: string[][] = [];
  let sample = 0;
  const pending = assertLinkedPathsIdle([root], args => {
    commands.push(args);
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: args[0] === "ps" ? Buffer.from(processOutput.replace("<root>", root)) : samples[Math.min(sample++, samples.length - 1)]! };
  });
  return { root, commands, pending };
}
test("a disappearing vnode requires a complete fresh process and handle inventory", async () => {
  const f = await inspectSamples([unavailable, record("/outside")]);
  await f.pending;
  expect(f.commands.map(command => command[0])).toEqual(["ps", "lsof", "ps", "lsof"]);
  expect(f.commands.filter(command => command[0] === "lsof")).toEqual(Array(2).fill(["lsof", "-nP", "-F0pftn"]));
});
test("persistent disappearing vnodes remain unverified after the bounded retries", async () => {
  const f = await inspectSamples([unavailable]);
  await expect(f.pending).rejects.toThrow("unavailable");
  expect(f.commands.map(command => command[0])).toEqual(["ps", "lsof", "ps", "lsof", "ps", "lsof"]);
});
test("a known active process is never retried as an unavailable vnode", async () => {
  const f = await inspectSamples([unavailable, record("/outside")], "123 bun <root>/writer.ts\n");
  await expect(f.pending).rejects.toThrow("command still references");
  expect(f.commands).toHaveLength(1);
});
test.each([
  Buffer.from("p123\0f167\0nvnode: Permission denied\0\n"),
  Buffer.from("p123\0f167\0tREG\0nvnode: FD unavailable\0\n"),
  Buffer.from("p123\0f167\0t\0nvnode: FD unavailable\0\n"),
  Buffer.from("p123\0fcwd\0nvnode: FD unavailable\0\n"),
  Buffer.from("p123\0f12345678901\0nvnode: FD unavailable\0\n"),
  Buffer.concat([unavailable, Buffer.from("p123\0f168\0nunknown failure\0\n")]),
  Buffer.concat([unavailable, Buffer.from("xmalformed\0")]),
])("other incomplete observations never receive the unavailable-vnode retry", async output => {
  const f = await inspectSamples([output, record("/outside")]);
  await expect(f.pending).rejects.toThrow();
  expect(f.commands).toHaveLength(2);
});
test("an active handle later in an incomplete sample is preserved without retry", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handle-busy-retry-"))); roots.push(root);
  let calls = 0;
  await expect(assertLinkedPathsIdle([root], args => {
    calls++;
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: args[0] === "ps" ? Buffer.from("123 unrelated\n") : Buffer.concat([unavailable, record(root)]) };
  })).rejects.toThrow("still holds");
  expect(calls).toBe(2);
});
test("a writer in the next full sample still blocks retirement", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handle-next-writer-"))); roots.push(root);
  let samples = 0;
  await expect(assertLinkedPathsIdle([root], args => ({ exitCode: 0, stderr: Buffer.alloc(0), stdout: args[0] === "ps" ? Buffer.from("123 unrelated\n") : samples++ ? record(root) : unavailable }))).rejects.toThrow("still holds");
  expect(samples).toBe(2);
});
test("a process appearing before the next handle sample blocks without another lsof", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handle-next-process-"))); roots.push(root);
  const calls: string[] = []; let processReads = 0;
  await expect(assertLinkedPathsIdle([root], args => {
    calls.push(args[0]!);
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: args[0] === "ps" ? Buffer.from(processReads++ ? `123 bun ${root}/writer.ts\n` : "123 unrelated\n") : unavailable };
  })).rejects.toThrow("command still references");
  expect(calls).toEqual(["ps", "lsof", "ps"]);
});

test.each([
  ["p123\0f167\0nvnode: Permission denied at /private/secret\0\n", "missing"],
  ["p123\0f167\0tUNKN\0nsecret provider payload\0\n", "UNKN"],
  ["p123\0f167\0tREG\0nrelative-secret-name\0\n", "REG"],
])("unknown handle diagnostics retain only bounded process/descriptor/type", (raw, type) => {
  let message = ""; try { assertRootHandleInventory("/private/task", Buffer.from(raw)); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("process 123"); expect(message).toContain('descriptor "167"'); expect(message).toContain(`type "${type}"`);
  expect(message).not.toContain("secret"); expect(message).not.toContain("Permission denied"); expect(message).not.toContain("provider payload");
});

test("retry validates every selected root and keeps the original strict batch scope", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "handle-batch-retry-"))); roots.push(root);
  const files = [path.join(root, "one"), path.join(root, "two")], calls: string[] = [];
  await expect(assertLinkedPathsIdle(files, args => { calls.push(args[0]!); return { exitCode: 0, stderr: Buffer.alloc(0), stdout: args[0] === "ps" ? Buffer.from("123 unrelated\n") : Buffer.concat([unavailable, record(files[1]!, "9", "REG")]) }; })).rejects.toThrow("still holds");
  expect(calls).toEqual(["ps", "lsof"]);
  await expect(assertLinkedPathsIdle([files[0]!, files[0]!], () => { throw new Error("must not run"); })).rejects.toThrow("scope");
});

test("persistent diagnostics bound descriptors and never include handle names", async () => {
  const sample = Buffer.from(Array.from({ length: 20 }, (_, i) => `p123\0f${i + 100}\0nvnode: FD unavailable\0\n`).join(""));
  const f = await inspectSamples([sample]); let message = "";
  try { await f.pending; } catch (error) { message = (error as Error).message; }
  expect(message).toContain("123:100"); expect(message).toContain("123:107"); expect(message).not.toContain("123:108"); expect(message).not.toContain("vnode:");
  expect(message.length).toBeLessThan(200); expect(f.commands).toHaveLength(6);
});
