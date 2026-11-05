import { expect, test } from "bun:test";
import { lstat, readlink } from "node:fs/promises";
import { observeCompletionSnapshot } from "./completion-observation.ts";
import { fingerprintScan, withFingerprintDiagnostics, type FingerprintDiagnostic } from "./fingerprint-diagnostics.ts";

test("a held metadata batch reports its counts and age without paths, contents or false progress", async () => {
  const events: FingerprintDiagnostic[] = [];
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve);
  const files = Array.from({ length: 101 }, (_, i) => `private-secret-${String(i).padStart(3, "0")}.txt`);
  const metadata = new Proxy(lstat, { async apply(target, receiver, args) {
    if (String(args[0]).endsWith(files[100]!)) { entered(); await wait; }
    return { isSymbolicLink: () => false, isFile: () => true, mode: 0o644 };
  } });
  const scan = withFingerprintDiagnostics({ worker: "original-worker", acceptedRevision: 42 }, () => observeCompletionSnapshot("/private/worktree-secret", {
    async run(_command, args) {
      const stdout = args[0] === "rev-parse" ? "a".repeat(40) : args[0] === "symbolic-ref" ? "branch-secret" : args[0] === "ls-files" && args.includes("--cached") ? files.join("\0") + "\0" : args[0] === "hash-object" ? args.slice(3).map(() => "b".repeat(40)).join("\n") : "";
      return { ok: true, stdout, stderr: "" };
    },
  }, { lstat: metadata, readlink }), { record: event => events.push(event), heartbeatMs: 5 });
  await started;
  try {
    await Bun.sleep(15);
    const heartbeat = [...events].reverse().find(event => event.event === "heartbeat");
    expect(heartbeat).toMatchObject({ worker: "original-worker", acceptedRevision: 42, scan: 1, operation: "metadata", chunk: 2, files: 101, completedFiles: 100 });
    expect(heartbeat!.operationElapsedMs).toBeGreaterThanOrEqual(0);
    expect(events.some(event => event.event === "worker-settled")).toBe(false);
    expect(events.some(event => event.event === "step-end" && event.chunk === 2)).toBe(false);
  } finally { release(); }
  expect((await scan).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(events.at(-1)).toMatchObject({ event: "worker-settled", outcome: "returned" });
  expect(events.filter(event => event.event === "step-start" && event.operation === "hash")).toHaveLength(2);
  expect(JSON.stringify(events)).not.toMatch(/private|secret|branch-secret|bbbbbbbb/);
  const ended = events.length; await Bun.sleep(15); expect(events).toHaveLength(ended);
});

test("a failed fingerprint is reported as thrown and never as journal authority", async () => {
  const events: FingerprintDiagnostic[] = [];
  const failure = new Error("private-secret-file");
  await expect(withFingerprintDiagnostics({ worker: "worker", acceptedRevision: 7 }, () => fingerprintScan(step =>
    step("hash", { files: 1, chunk: 1, completedFiles: 0 }, async () => { throw failure; })), { record: event => events.push(event) })).rejects.toBe(failure);
  expect(events.at(-2)).toMatchObject({ event: "step-end", operation: "hash", outcome: "threw" });
  expect(events.at(-1)).toMatchObject({ event: "worker-settled", outcome: "threw" });
  expect(events.some(event => event.event === "journal-terminal")).toBe(false);
  expect(JSON.stringify(events)).not.toContain("private-secret-file");
});

test("a broken diagnostic sink cannot bypass or replace the actual verification result", async () => {
  const failure = new Error("verification failed");
  await expect(withFingerprintDiagnostics({ worker: "worker", acceptedRevision: 7 }, () => fingerprintScan(step =>
    step("status", {}, async () => { throw failure; })), { record() { throw new Error("log unavailable"); } })).rejects.toBe(failure);
});
