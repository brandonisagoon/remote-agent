import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createAcpxSessionRuntime } from "./session-runtime.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await mkdtemp(path.join(tmpdir(), "session-recovery-")); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });

async function fixture(overrides: Partial<AcpSessionRecord> = {}) {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  const now = new Date().toISOString();
  const record: AcpSessionRecord = {
    schema: "acpx.session.v1", acpxRecordId: "record", acpSessionId: "provider", agentCommand: "codex", cwd: directory,
    createdAt: now, lastUsedAt: now, lastSeq: 0, pid: child.pid,
    eventLog: { active_path: "record.events.jsonl", segment_count: 1, max_segment_bytes: 1_048_576, max_segments: 5 },
    messages: [], updated_at: now, cumulative_token_usage: {}, request_token_usage: {}, ...overrides,
  };
  const store = createRuntimeStore({ stateDir: directory });
  await store.save(record);
  await db.prisma.runtimeSession.create({ data: {
    id: "session", scopeKey: "scope", agentCommand: "codex", cwd: directory, status: "active", acpxRecordId: "record", acpxSessionId: "provider",
  } });
  const runtime = createAcpxSessionRuntime(db.prisma, { ...testConfig(), acpxStateDir: directory });
  return { runtime, store, record };
}

test("explicit reconciliation proves a dead provider, clears stale active, and leaves the outcome unknown", async () => {
  const { runtime } = await fixture();
  await db.prisma.runtimeInstruction.create({ data: { id: "unknown", sessionId: "session", text: "possibly ran", state: "unknown" } });
  expect((await runtime.reconcileInterruptedSession!("session")).status).toBe("idle");
  expect((await db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: "unknown" } })).state).toBe("unknown");
});

test("a live provider, including this process, cannot be declared idle", async () => {
  const { runtime } = await fixture({ pid: process.pid });
  await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("still alive");
  expect((await runtime.getSession("session"))?.status).toBe("active");
});

test("permission errors cannot be mistaken for a stopped provider", async () => {
  const { runtime } = await fixture();
  const probe = spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  try { await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("could not be verified"); }
  finally { probe.mockRestore(); }
  expect((await runtime.getSession("session"))?.status).toBe("active");
});

test("missing PID is uncertain unless a recorded exit follows both spawn and prompt", async () => {
  const { runtime, store, record } = await fixture({ pid: undefined });
  await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("evidence is unavailable");
  await store.save({ ...record, agentStartedAt: "2026-01-01T00:00:00Z", lastPromptAt: "2026-01-01T00:00:02Z", lastAgentExitAt: "2026-01-01T00:00:01Z" });
  await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("evidence is unavailable");
  await store.save({ ...record, agentStartedAt: "2026-01-01T00:00:00Z", lastPromptAt: "2026-01-01T00:00:02Z", lastAgentExitAt: "2026-01-01T00:00:03Z" });
  await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("evidence is unavailable"); // Exit predates this active registry generation.
  const now = Date.now();
  await store.save({ ...record, agentStartedAt: new Date(now - 1000).toISOString(), lastPromptAt: new Date(now).toISOString(), lastAgentExitAt: new Date(now + 1).toISOString() });
  expect((await runtime.reconcileInterruptedSession!("session")).status).toBe("idle");
});

test("mismatched and changing provider records fail closed", async () => {
  const { runtime, store, record } = await fixture({ cwd: "/wrong-task" });
  await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("identity changed");
  await store.save({ ...record, cwd: directory });
  const file = path.join(directory, "sessions", "record.json");
  const probe = spyOn(process, "kill").mockImplementation(() => {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.pid = process.pid;
    writeFileSync(file, JSON.stringify(saved));
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  try { await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("changed during recovery"); }
  finally { probe.mockRestore(); }
  expect((await runtime.getSession("session"))?.status).toBe("active");
});

test("locally owned turns block recovery even before the provider starts", async () => {
  const { runtime } = await fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  const turn = runtime.startTurn({ sessionId: "session", text: "never start", signal: cancelled.signal });
  await expect(runtime.reconcileInterruptedSession!("session")).rejects.toThrow("work in flight");
  await turn.result;
  for await (const _ of turn.events) {}
});

test("new local turns are refused during the provider liveness check", async () => {
  const { runtime } = await fixture();
  const recovering = runtime.reconcileInterruptedSession!("session");
  expect(() => runtime.startTurn({ sessionId: "session", text: "race" })).toThrow("being reconciled");
  await recovering;
});
