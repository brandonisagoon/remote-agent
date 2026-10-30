import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupDigest, cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { runCleanupResourceObserver, verifyCleanupObserver } from "./cleanup-resource-observer.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error("Fixture Git command failed");
  return result.stdout.toString().trim();
}
async function fixture(supportsRetained = false, contracts: unknown = ["retained-preview-inputs/v1"]) {
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
  await writeFile(path.join(root, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { cleanup: { instructions: "cleanup.md", adapter: "adapter.ts", ...(supportsRetained ? { observationContracts: contracts } : {}) } } }), { mode: 0o600 });
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
  await expect(runCleanupResourceObserver({ capability: f.capability, request: { pidFile } })).rejects.toThrow("[OBSERVER_CAPABILITY]");
  expect(await Bun.file(pidFile).exists()).toBeFalse();
});

test.each([["stderr", "OBSERVER_EXIT"], ["oversize", "OBSERVER_OUTPUT_LIMIT"], ["invalid", "OBSERVER_JSON"]])("observer %s fails without exposing provider output", async (mode, code) => {
  const f = await fixture();
  try { await runCleanupResourceObserver({ capability: f.capability, request: { mode } }); throw new Error("Unexpected observer success"); }
  catch (error) {
    expect(String(error)).toContain("resource absence is unverified");
    expect(String(error)).toContain(`[${code}]`);
    expect(String(error)).not.toContain("private-");
  }
});

test("invalid request size, serialization or deadline fails before any observer starts", async () => {
  const f = await fixture(), circular: Record<string, unknown> = {}; circular.self = circular;
  for (const input of [{ request: { private: "x".repeat(2 * 1024 * 1024) } }, { request: circular }, { request: undefined }, { request: {}, timeoutMs: 60_001 }, { request: {}, timeoutMs: 0 }]) {
    await expect(runCleanupResourceObserver({ capability: f.capability, ...input })).rejects.toThrow("[OBSERVER_INPUT]");
  }
  expect(await verifyCleanupObserver(f.capability)).toEqual(f.capability);
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

test("observer timeout identifies the failed boundary while preserving process absence", async () => {
  const f = await fixture(), outside = await realpath(await mkdtemp(path.join(tmpdir(), "observer-diagnostic-"))); roots.push(outside);
  const pidFile = path.join(outside, "pid");
  await expect(runCleanupResourceObserver({ capability: f.capability, request: { mode: "hang", pidFile }, timeoutMs: 250 })).rejects.toThrow("[OBSERVER_TIMEOUT]");
  const pid = Number(await Bun.file(pidFile).text());
  expect(() => process.kill(pid, 0)).toThrow();
});

function retainedRequest() {
  const environment = { id: "environment", key: "development-env-directory", kind: "private-directory", purpose: "development", externalId: "/private/original-env", state: "released", expiresAt: null, metadata: {} };
  const preview = { ...environment, id: "preview", key: "development-tunnel", kind: "cloudflare-tunnel", externalId: "tunnel" };
  const { state: _, ...identity } = environment;
  const file = { dev: 1, ino: 2, mode: 33152, size: 12, sha256: "b".repeat(64) };
  const target = { kind: "local-ingress-route", id: "preview.example.com", scope: { taskId: "task", purpose: "development", configFile: "/private/original-env/cloudflared.yml", tunnelId: "tunnel" }, hostname: "preview.example.com", sourceDigest: "a".repeat(64), routeDigest: "c".repeat(64), presentAtPrepare: true } as const;
  return { version: 1, task: { id: "task", primarySessionId: "primary", worktreePath: "/private/original", toolingRevision: "a".repeat(40) }, resources: [environment, preview], stage: "confirm",
    observations: [{ resourceId: preview.id, expectedTargets: [{ ...target, identityDigest: cleanupTargetDigest(target) }] }],
    retainedPreviewInputs: [{ resourceId: environment.id, identityDigest: cleanupDigest(identity), planDigest: "e".repeat(64), sourcePath: environment.externalId,
      quarantine: { directory: "/private/capture", path: "/private/capture/contents", journal: "/private/capture/pending.json" }, root: { dev: 1, ino: 3, mode: 16832 },
      config: { ...file, path: "/private/original-env/cloudflared.yml" }, connector: { ...file, path: "/private/original-env/credentials.json" } }] };
}

test("retained preview compatibility requires a committed declared contract and verifies the original capability too", async () => {
  const original = await fixture(), unsupported = await fixture(), current = await fixture(true), request = retainedRequest();
  await expect(runCleanupResourceObserver({ capability: original.capability, compatibleCapability: unsupported.capability, request })).rejects.toThrow("OBSERVER_COMPATIBILITY");
  expect(await runCleanupResourceObserver({ capability: original.capability, compatibleCapability: current.capability, request })).toMatchObject({ hasControl: false, args: ["cleanup", "observe-resource"] });
  await writeFile(original.adapter, original.source + "\n// original changed");
  await expect(runCleanupResourceObserver({ capability: original.capability, compatibleCapability: current.capability, request })).rejects.toThrow("OBSERVER_CAPABILITY");
});

test.each(["prepare", "missing-input", "duplicate-input", "environment", "target-kind", "current-code"])("compatible observer rejects %s without falling back", async changed => {
  const original = await fixture(), current = await fixture(true), request: any = retainedRequest();
  if (changed === "prepare") request.stage = "prepare";
  if (changed === "missing-input") delete request.retainedPreviewInputs;
  if (changed === "duplicate-input") request.retainedPreviewInputs.push(request.retainedPreviewInputs[0]);
  if (changed === "environment") request.resources[0].metadata = { replacement: true };
  if (changed === "target-kind") request.observations[0].expectedTargets = [{ kind: "docker-volume", id: "volume", scope: { taskId: "task", purpose: "development" }, identity: null, presentAtPrepare: false, identityDigest: "a".repeat(64) }];
  if (changed === "current-code") await writeFile(current.adapter, current.source + "\n// changed");
  await expect(runCleanupResourceObserver({ capability: original.capability, compatibleCapability: current.capability, request })).rejects.toThrow();
});


test("a compatible manifest may advertise other bounded contracts without changing the selected contract", async () => {
  const original = await fixture(), current = await fixture(true, ["future-observation/v2", "retained-preview-inputs/v1"]);
  expect(await runCleanupResourceObserver({ capability: original.capability, compatibleCapability: current.capability, request: retainedRequest() })).toMatchObject({ hasControl: false });
});
test.each([[], ["future-observation/v2"], ["retained-preview-inputs/v1", "malformed arbitrary value"], ["retained-preview-inputs/v1", "retained-preview-inputs/v1"]].map(contracts => [contracts]))("unsupported or malformed advertised contracts %j refuse compatibility", async contracts => {
  const original = await fixture(), current = await fixture(true, contracts);
  await expect(runCleanupResourceObserver({ capability: original.capability, compatibleCapability: current.capability, request: retainedRequest() })).rejects.toThrow("OBSERVER_COMPATIBILITY");
});
