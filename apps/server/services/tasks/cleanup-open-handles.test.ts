import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertLinkedRootIdle, assertRootHandleInventory } from "./cleanup-open-handles.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const record = (name: string, fd = "cwd", type = "DIR") => Buffer.from(`p123\0f${fd}\0t${type}\0n${name}\0\n`);
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
  try { await expect(assertLinkedRootIdle(root)).rejects.toThrow("still holds"); }
  finally { child.kill(9); await child.exited; }
  await assertLinkedRootIdle(root);
}, 20_000);
