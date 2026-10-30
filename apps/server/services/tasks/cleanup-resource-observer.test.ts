import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCleanupResourceObserver, verifyCleanupObserver } from "./cleanup-resource-observer.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error("Fixture Git command failed");
  return result.stdout.toString().trim();
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cleanup-observer-"))); roots.push(root);
  const adapter = path.join(root, "adapter.ts");
  const source = `const input = JSON.parse(await Bun.stdin.text());
if (input.pidFile) await Bun.write(input.pidFile, String(process.pid));
if (input.mode === "descendant-exits" || input.mode === "descendant-hangs") {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", "await Bun.write(process.argv[1], String(process.pid)); await Bun.sleep(2200);", input.descendantPidFile], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  while (!await Bun.file(input.descendantPidFile).exists()) await Bun.sleep(5);
  console.log(JSON.stringify({ absent: true }));
  if (input.mode === "descendant-exits") process.exit(0);
  await Bun.sleep(60_000);
}
else if (input.mode === "hang") await Bun.sleep(60_000);
else if (input.mode === "stderr") { console.error("private-provider-value"); process.exit(1); }
else if (input.mode === "oversize") console.log("x".repeat(9 * 1024 * 1024));
else if (input.mode === "invalid") console.log("private-invalid-output");
else console.log(JSON.stringify({ taskId: input.taskId, resourceId: input.resourceId, args: process.argv.slice(2), hasControl: Boolean(process.env.REMOTE_AGENT_SOCKET || process.env.REMOTE_AGENT_SESSION_ID) }));\n`;
  await writeFile(adapter, source, { mode: 0o600 });
  await writeFile(path.join(root, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { cleanup: { instructions: "cleanup.md", adapter: "adapter.ts" } } }), { mode: 0o600 });
  await writeFile(path.join(root, "cleanup.md"), "Read-only fixture", { mode: 0o600 });
  git(root, "init", "--quiet"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "Pinned observer");
  return { root, adapter, source, capability: { version: 1 as const, source: "configured-host" as const, checkout: root, revision: git(root, "rev-parse", "HEAD"), adapter, adapterSha256: sha(source) } };
}

test("the pinned cleanup observer reads private stdin without inheriting task control authority", async () => {
  const f = await fixture(), previous = process.env.REMOTE_AGENT_SOCKET;
  process.env.REMOTE_AGENT_SOCKET = "/fixture/owner-control.sock";
  try {
    expect(await runCleanupResourceObserver({ capability: f.capability, request: { taskId: "original-task", resourceId: "owned-resource" } }))
      .toEqual({ taskId: "original-task", resourceId: "owned-resource", args: ["cleanup", "observe-resource"], hasControl: false });
  } finally { if (previous === undefined) delete process.env.REMOTE_AGENT_SOCKET; else process.env.REMOTE_AGENT_SOCKET = previous; }
});

test.each(["revision", "digest", "code", "manifest", "source", "permissions"])("changed observer %s fails before any child starts", async changed => {
  const f = await fixture(), pidFile = path.join(await realpath(tmpdir()), `observer-not-started-${crypto.randomUUID()}`);
  if (changed === "revision") f.capability.revision = "f".repeat(40);
  if (changed === "digest") f.capability.adapterSha256 = "f".repeat(64);
  if (changed === "code") await writeFile(f.adapter, `${f.source}\n// changed`);
  if (changed === "manifest") { await writeFile(path.join(f.root, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { cleanup: { adapter: "other.ts" } } })); git(f.root, "add", "."); git(f.root, "commit", "--quiet", "-m", "Changed manifest"); f.capability.revision = git(f.root, "rev-parse", "HEAD"); }
  if (changed === "source") await writeFile(path.join(f.root, "cleanup.md"), "Changed tracked dependency");
  if (changed === "permissions") await chmod(f.adapter, 0o666);
  await expect(runCleanupResourceObserver({ capability: f.capability, request: { pidFile } })).rejects.toThrow();
  expect(await Bun.file(pidFile).exists()).toBeFalse();
});

test.each(["stderr", "oversize", "invalid"])("observer %s fails without exposing provider output", async mode => {
  const f = await fixture();
  try { await runCleanupResourceObserver({ capability: f.capability, request: { mode } }); throw new Error("Unexpected observer success"); }
  catch (error) {
    expect(String(error)).toContain("resource absence is unverified");
    expect(String(error)).not.toContain("private-");
  }
});

test("a timed-out observer is killed and reaped, and the same committed observer remains usable", async () => {
  const f = await fixture(), outside = await realpath(await mkdtemp(path.join(tmpdir(), "observer-result-"))); roots.push(outside);
  const pidFile = path.join(outside, "pid");
  await expect(runCleanupResourceObserver({ capability: f.capability, request: { mode: "hang", pidFile }, timeoutMs: 250 })).rejects.toThrow("resource absence is unverified");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await verifyCleanupObserver(f.capability)).toEqual(f.capability);
  expect(await runCleanupResourceObserver({ capability: f.capability, request: { taskId: "same-task" } })).toMatchObject({ taskId: "same-task" });
});

// The descendant has a short independent lifetime so this regression fails
// boundedly on the original transport instead of hanging the test runner.
test.each(["descendant-exits", "descendant-hangs"])("an observer %s cannot retain pipes or outlive its deadline", async mode => {
  const f = await fixture(), outside = await realpath(await mkdtemp(path.join(tmpdir(), "observer-descendant-"))); roots.push(outside);
  const pidFile = path.join(outside, "parent"), descendantPidFile = path.join(outside, "descendant");
  const started = performance.now();
  await expect(runCleanupResourceObserver({ capability: f.capability, request: { mode, pidFile, descendantPidFile }, timeoutMs: 400 })).rejects.toThrow("resource absence is unverified");
  const elapsed = performance.now() - started;
  const pid = Number(await readFile(pidFile, "utf8")), descendantPid = Number(await readFile(descendantPidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(() => process.kill(descendantPid, 0)).toThrow();
  expect(elapsed).toBeLessThan(1800);
});
