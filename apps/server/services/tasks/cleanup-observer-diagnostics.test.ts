import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupObserverFixture } from "../../../../test-support/cleanup-observer.ts";
import { CleanupObserverError, CleanupObserverFailureCode, cleanupObserverReasons, observerFailureEnvelope } from "./cleanup-observer-diagnostics.ts";
import { runCleanupResourceObserver } from "./cleanup-resource-observer.ts";
import { PreparationFailure, preparationFailure } from "./preparation-errors.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const resource = (id: string, kind = "docker-container") => ({ id, key: `original-${id}`, kind, purpose: "development", externalId: "c".repeat(64), state: "ready", expiresAt: null, metadata: {} });
const resources = [resource("first"), resource("second", "cloudflare-tunnel"), resource("unselected")];
const task = { id: "original-task", primarySessionId: "original-primary", worktreePath: "/private/original", toolingRevision: "a".repeat(40) };
const request = { version: 1, task, resources, stage: "prepare", observations: [{ resourceId: "first" }, { resourceId: "second" }] };
const envelope = { version: 1, type: "cleanup-observer-failure", stage: "resource", code: "preview-binding-missing", resource: { id: "second", key: "original-second", kind: "cloudflare-tunnel", adapter: "preview" } };

test("only the selected exact resource supplies a safe typed diagnostic", () => {
  const failure = observerFailureEnvelope(JSON.stringify(envelope) + "\n", request)!;
  expect(failure.diagnostic).toEqual({ code: "OBSERVER_PREVIEW_BINDING_MISSING", reason: "The preview receipt has no verified hostname and tunnel binding. Resource original-second (cloudflare-tunnel/preview). The resource absence is unverified." });
  failure.message = "private mutated message";
  expect(preparationFailure(failure)).toEqual(failure.diagnostic);
  expect(PreparationFailure.parse(failure.diagnostic)).toEqual(failure.diagnostic);
  const single = { version: 1, task, resources, resource: resources[1], stage: "prepare" };
  expect(observerFailureEnvelope(JSON.stringify(envelope), single)?.diagnostic).toEqual(failure.diagnostic);
});

test.each(["unselected", "key", "kind", "adapter", "id", "unsafe", "oversized-key", "extra", "unknown-code", "wrong-stage", "duplicate-selection", "foreign-task", "multiple-lines", "oversized-envelope"])("failure envelope %s is rejected without exposing its fields", changed => {
  const value: any = structuredClone(envelope), input: any = structuredClone(request);
  if (changed === "unselected") value.resource = { id: "unselected", key: "original-unselected", kind: "docker-container", adapter: "docker" };
  if (changed === "key") value.resource.key = "another-key";
  if (changed === "kind") value.resource.kind = "docker-container";
  if (changed === "adapter") value.resource.adapter = "docker";
  if (changed === "id") value.resource.id = "foreign";
  if (changed === "unsafe") value.resource.key = "/private/secret?token=value";
  if (changed === "oversized-key") value.resource.key = "a".repeat(129);
  if (changed === "extra") value.message = "secret-provider-body";
  if (changed === "unknown-code") value.code = "secret-code";
  if (changed === "wrong-stage") value.stage = "input";
  if (changed === "duplicate-selection") input.observations.push({ resourceId: "second" });
  if (changed === "foreign-task") input.task = { ...input.task, secret: "value" };
  let line = JSON.stringify(value);
  if (changed === "multiple-lines") line += "\nprivate-provider-body\n";
  if (changed === "oversized-envelope") line = " ".repeat(2049) + line;
  expect(observerFailureEnvelope(line, input)).toBeNull();
});

test("stopped-writer diagnostics require the complete selected writer scope", () => {
  const evidence = { ...resource("evidence", "evidence"), externalId: "/private/evidence" };
  const input = { version: 1, mode: "stopped-writers", task, resources: [resources[0], evidence], evidence: { resourceId: evidence.id, path: evidence.externalId, planDigest: "b".repeat(64) }, writerResourceIds: ["first"] };
  const value = { ...envelope, stage: "writers", resource: { id: "first", key: "original-first", kind: "docker-container", adapter: "docker" } };
  expect(observerFailureEnvelope(JSON.stringify(value), input)).toBeInstanceOf(CleanupObserverError);
  expect(observerFailureEnvelope(JSON.stringify(value), { ...input, writerResourceIds: [] })).toBeNull();
  expect(observerFailureEnvelope(JSON.stringify(value), request)).toBeNull();
});

test("every code stays fixed and within the existing preparation wire bound", () => {
  for (const code of CleanupObserverFailureCode.options) {
    const selected = { ...envelope.resource, key: "a".repeat(128) };
    const input = structuredClone(request); input.resources[1]!.key = selected.key;
    const failure = observerFailureEnvelope(JSON.stringify({ ...envelope, code, resource: selected }), input)!;
    expect(PreparationFailure.safeParse(failure.diagnostic).success).toBeTrue();
    expect(failure.diagnostic.reason.length).toBeLessThanOrEqual(320);
    expect(failure.message).not.toContain(task.worktreePath);
  }
  for (const code of Object.keys(cleanupObserverReasons) as Array<keyof typeof cleanupObserverReasons>) expect(PreparationFailure.safeParse(new CleanupObserverError(code).diagnostic).success).toBeTrue();
  expect(preparationFailure(Object.assign(new Error("[OBSERVER_TIMEOUT] private body"), { diagnostic: { code: "OBSERVER_TIMEOUT", reason: "private" } })).code).toBe("UNCLASSIFIED_FAILURE");
});

async function realFixture(source: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "observer-failure-"))); roots.push(root);
  return { root, capability: await cleanupObserverFixture(root, source) };
}

test.each([
  ["valid", 1, "OBSERVER_PREVIEW_BINDING_MISSING"], ["valid", 0, "OBSERVER_STDERR"],
  ["mixed", 1, "OBSERVER_EXIT"], ["private", 1, "OBSERVER_EXIT"], ["empty", 1, "OBSERVER_EXIT"],
  ["oversized", 1, "OBSERVER_OUTPUT_LIMIT"],
] as const)("real child %s stderr with exit %i remains a failed boundary (%s)", async (format, exit, expected) => {
  const stderr = format === "valid" ? JSON.stringify(envelope) : format === "mixed" ? JSON.stringify(envelope) + "\nprivate-provider-body" : format === "private" ? "Bearer private-provider-body" : format === "oversized" ? "x".repeat(70_000) : "";
  const f = await realFixture(`await Bun.stdin.text(); console.log(JSON.stringify({version:1,taskId:"original-task",observations:[]})); await Bun.stderr.write(${JSON.stringify(stderr)}); process.exit(${exit});`);
  const error = await runCleanupResourceObserver({ capability: f.capability, request }).catch(error => error);
  expect(error).toBeInstanceOf(CleanupObserverError);
  if (!(error instanceof CleanupObserverError)) throw new Error("Expected typed failure");
  expect(error.diagnostic.code).toBe(expected);
  expect(error.message).not.toMatch(/private-provider-body|Bearer/);
  expect(error.message).toContain("absence is unverified");
});

test("capability drift after real execution refuses otherwise complete output", async () => {
  const f = await realFixture(`await Bun.stdin.text(); await Bun.write(import.meta.dir + "/changed", "private-provider-body"); console.log("{}");`);
  await expect(runCleanupResourceObserver({ capability: f.capability, request })).rejects.toThrow("[OBSERVER_CAPABILITY]");
});

test("owned process-group observation failure cannot return successful output or leak ps stderr", async () => {
  const f = await realFixture(`const input=JSON.parse(await Bun.stdin.text()); await Bun.write(input.pidFile,String(process.pid)); console.log("{}");`);
  const pidFile = path.join(f.root, "pid"), spawn = Bun.spawnSync;
  const mock = spyOn(Bun, "spawnSync").mockImplementation(((...args: Parameters<typeof Bun.spawnSync>) => {
    const result = spawn(...args);
    return Array.isArray(args[0]) && args[0][0] === "/bin/ps" && existsSync(pidFile) ? { ...result, exitCode: 1, stderr: Buffer.from("private-process-body") } : result;
  }) as typeof Bun.spawnSync);
  try {
    const error = await runCleanupResourceObserver({ capability: f.capability, request: { pidFile } }).catch(error => error);
    if (!(error instanceof CleanupObserverError)) throw new Error("Expected typed failure");
    expect(error.diagnostic.code).toBe("OBSERVER_GROUP");
    expect(error.message).not.toContain("private-process-body");
    const pid = Number(await Bun.file(pidFile).text()); expect(() => process.kill(pid, 0)).toThrow();
  } finally { mock.mockRestore(); }
});
