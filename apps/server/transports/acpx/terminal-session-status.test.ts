import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpRuntimeTurnResult, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createAcpxSessionRuntime } from "./session-runtime.ts";

// A late provider completion must never revive a closed session. Each case
// holds the provider immediately before the runtime's status write, closes
// the session, releases the write and proves closure (and its original
// timestamp) survived. Isolated fixtures only: no historical rows are touched.

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await mkdtemp(path.join(tmpdir(), "terminal-status-")); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });

const ID = "session", CONFIG = [{ id: "mode", name: "Mode", type: "select", currentValue: "late", options: [{ value: "late", name: "Late" }] }];
const saved = [{ role: "user" as const, text: "Original request" }, { role: "agent" as const, text: "Original answer" }];

function gate<T = void>() { return Promise.withResolvers<T>(); }

async function fixture(options: { cachedHandle?: boolean } = {}) {
  const stateDir = path.join(directory, "state"), cwd = path.join(directory, "checkout"), config = testConfig({ acpxStateDir: stateDir });
  config.repository = { ...config.repository, root: directory, worktreeRoot: directory }; config.repositories = { [config.repository.id]: config.repository };
  await db.prisma.runtimeSession.create({ data: { id: ID, scopeKey: ID, repositoryId: config.repository.id, machineId: config.machine, agentCommand: "codex", cwd, name: ID,
    status: "idle", acpxRecordId: "record", acpxSessionId: "backend", agentSessionId: "agent" } });
  const now = new Date().toISOString();
  const record: AcpSessionRecord = { schema: "acpx.session.v1", acpxRecordId: "record", acpSessionId: "backend", agentSessionId: "agent", agentCommand: "codex", cwd, name: ID,
    createdAt: now, lastUsedAt: now, lastSeq: 0, agentStartedAt: now, lastPromptAt: now, lastAgentExitAt: now, eventLog: { active_path: path.join(stateDir, "record.events.jsonl"), segment_count: 1, max_segment_bytes: 1048576, max_segments: 1 },
    messages: [{ User: { id: "user-0", content: [{ Text: saved[0]!.text }] } }, { Agent: { content: [{ Text: saved[1]!.text }], tool_results: {} } }],
    updated_at: now, cumulative_token_usage: {}, request_token_usage: {} };
  const store = createRuntimeStore({ stateDir });
  await store.save(record);

  // Provider seams the test holds open.
  const turnStarted = gate(), result = gate<AcpRuntimeTurnResult>(), events = gate<void>();
  const statusEntered = gate(), statusRelease = gate();
  let holdStatus = false, throwFromEvents = false;
  // Named provider calls the test can hold: ensureSession, setMode, setConfigOption, close.
  const holds = new Map<string, { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }>();
  const hold = (name: string) => { const value = { entered: gate(), release: gate() }; holds.set(name, value); return value; };
  const pause = async (name: string) => { const value = holds.get(name); if (value) { holds.delete(name); value.entered.resolve(); await value.release.promise; } };
  const closes: Array<{ handle: unknown; discardPersistentState?: boolean }> = [];
  const ensured: unknown[] = [];
  const handle = { sessionKey: ID, backend: "acpx", runtimeSessionName: ID, acpxRecordId: "record", backendSessionId: "backend", agentSessionId: "agent" };
  const provider = {
    ensureSession: async (input: { agent: string }) => {
      await pause("ensureSession");
      const started = { ...handle, runtimeSessionName: `${ID}:${ensured.length}`, agent: input.agent };
      ensured.push(started);
      return started;
    },
    setMode: async () => { await pause("setMode"); },
    setConfigOption: async () => { await pause("setConfigOption"); return { configOptions: CONFIG }; },
    startTurn: (input: { requestId: string }) => {
      turnStarted.resolve();
      return { requestId: input.requestId, promptStarted: Promise.resolve(),
        events: (async function* () { await events.promise; if (throwFromEvents) throw new Error("provider stream broke after closure"); })(),
        result: result.promise, cancel: async () => {}, closeStream: async () => {} };
    },
    getStatus: async () => {
      if (holdStatus) { statusEntered.resolve(); await statusRelease.promise; }
      return { agentSessionId: "agent-late", details: { configOptions: CONFIG } };
    },
    close: async (input: { handle: unknown; discardPersistentState?: boolean }) => {
      await pause("close");
      closes.push({ handle: input.handle, discardPersistentState: input.discardPersistentState });
    },
    cancel: async () => {},
  };
  const runtime = createAcpxSessionRuntime(db.prisma, config);
  (runtime as any).runtimes.set(ID, provider);
  if (options.cachedHandle !== false) (runtime as any).handles.set(ID, handle);
  const cached = () => ({ handle: (runtime as any).handles.has(ID), runtime: (runtime as any).runtimes.has(ID), executionDirectory: (runtime as any).executionDirectories.has(ID) });

  const start = async () => {
    const turn = runtime.startTurn({ sessionId: ID, text: "Do the work", requestId: "turn-1" });
    const chain: Promise<void> = (runtime as any).turnChains.get(ID);
    await turnStarted.promise;
    return { turn, chain };
  };
  const row = () => db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: ID } });
  return { config, runtime, provider, start, row, result, events, statusEntered, statusRelease, hold, closes, ensured, cached, store, record, turnStarted,
    holdStatusWrite: () => { holdStatus = true; }, failStream: () => { throwFromEvents = true; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Each completion is held at the last await before its status write.
const completions: Record<string, { expected: string; hold: (f: Fixture) => Promise<void>; release: (f: Fixture) => void }> = {
  success: {
    expected: "completed",
    // completed → refreshSessionState → getStatus (held) → write idle
    hold: async f => { f.holdStatusWrite(); f.events.resolve(); f.result.resolve({ status: "completed" }); await f.statusEntered.promise; },
    release: f => f.statusRelease.resolve(),
  },
  failure: {
    expected: "failed",
    // failed result (held) → write error
    hold: async f => { f.events.resolve(); },
    release: f => f.result.resolve({ status: "failed", error: { code: "ACP_TURN_FAILED", message: "provider failed after closure" } as any }),
  },
  cancellation: {
    expected: "cancelled",
    // cancelled → refreshSessionState → getStatus (held) → write idle
    hold: async f => { f.holdStatusWrite(); f.events.resolve(); f.result.resolve({ status: "cancelled", stopReason: "cancelled" }); await f.statusEntered.promise; },
    release: f => f.statusRelease.resolve(),
  },
  "stream error": {
    expected: "failed",
    // provider event stream (held) throws → catch → write error
    hold: async f => { f.failStream(); },
    release: f => f.events.resolve(),
  },
};

for (const [name, completion] of Object.entries(completions)) {
  test(`late ${name} completion after close leaves the session closed with its original closedAt`, async () => {
    const f = await fixture(), { turn, chain } = await f.start();
    expect((await f.row()).status).toBe("active");
    await completion.hold(f);
    await f.runtime.close(ID, "Owner closed the task");
    const closed = await f.row();
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeInstanceOf(Date);

    completion.release(f);
    expect((await turn.result).status).toBe(completion.expected as any);
    await chain;
    expect(await f.row()).toEqual(closed); // zero-row late write: status, closedAt, identity, options all unchanged

    // Closed history stays readable; new work stays refused.
    expect(await f.runtime.history(ID)).toEqual(saved);
    await expect(f.runtime.enqueue({ sessionId: ID, text: "More work" })).rejects.toThrow("closed");
    const refused = f.runtime.startTurn({ sessionId: ID, text: "More work" });
    expect(await refused.result).toMatchObject({ status: "failed" });
    expect(await f.row()).toEqual(closed);
    expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  });

  test(`late ${name} completion cannot rewrite a legacy idle row that already has closedAt`, async () => {
    const f = await fixture(), { turn, chain } = await f.start();
    await completion.hold(f);
    // A row recorded as closed whose status a pre-fix late write left idle.
    const legacyClosedAt = new Date("2026-10-01T12:00:00.000Z");
    await db.prisma.runtimeSession.update({ where: { id: ID }, data: { status: "idle", closedAt: legacyClosedAt, recoveryDetail: "legacy detail" } });
    const legacy = await f.row();

    completion.release(f);
    expect((await turn.result).status).toBe(completion.expected as any);
    await chain;
    expect(await f.row()).toEqual(legacy);
    expect((await f.row()).closedAt).toEqual(legacyClosedAt);

    expect(await f.runtime.history(ID)).toEqual(saved);
    const refused = f.runtime.startTurn({ sessionId: ID, text: "More work" });
    expect(await refused.result).toMatchObject({ status: "failed", error: expect.stringContaining("closed") });
    expect(await f.row()).toEqual(legacy);
  });
}

test("a close between the pre-turn checks and the active write refuses the turn instead of reopening", async () => {
  const f = await fixture();
  const entered = gate(), release = gate();
  // Hold the provider handle lookup that precedes the active write.
  const original = (f.runtime as any).handleFor.bind(f.runtime);
  (f.runtime as any).handleFor = async (...args: unknown[]) => { entered.resolve(); await release.promise; return original(...args); };
  const turn = f.runtime.startTurn({ sessionId: ID, text: "Do the work" });
  await entered.promise;
  await db.prisma.runtimeSession.update({ where: { id: ID }, data: { status: "closed", closedAt: new Date("2026-11-01T00:00:00.000Z") } });
  const closed = await f.row();
  release.resolve();
  expect(await turn.result).toMatchObject({ status: "failed", error: expect.stringContaining("closed") });
  for await (const _ of turn.events) {}
  expect(await f.row()).toEqual(closed);
});

test("ordinary open-session turns still move idle → active → idle and record provider state", async () => {
  const f = await fixture(), { turn, chain } = await f.start();
  expect((await f.row()).status).toBe("active");
  f.events.resolve(); f.result.resolve({ status: "completed" });
  expect((await turn.result).status).toBe("completed");
  await chain;
  const row = await f.row();
  expect(row).toMatchObject({ status: "idle", closedAt: null, recoveryDetail: null, agentSessionId: "agent-late" });
  expect(row.latestConfigOptions).toEqual(CONFIG);
});

test("ordinary open-session failures still record error, and a later close records closure", async () => {
  const f = await fixture(), { turn, chain } = await f.start();
  f.events.resolve(); f.result.resolve({ status: "failed", error: { code: "ACP_TURN_FAILED", message: "provider failed" } as any });
  expect((await turn.result).status).toBe("failed");
  await chain;
  expect(await f.row()).toMatchObject({ status: "error", closedAt: null, recoveryDetail: "provider failed" });
  await f.runtime.close(ID, "Owner closed the task");
  expect(await f.row()).toMatchObject({ status: "closed", recoveryDetail: null, closedAt: expect.any(Date) });
});

test("a session closed while its provider starts stops that provider, keeps history and leaves nothing cached", async () => {
  const f = await fixture({ cachedHandle: false }), savedRecord = await f.store.load("record");
  const starting = f.hold("ensureSession");
  const turn = f.runtime.startTurn({ sessionId: ID, text: "Do the work" });
  await starting.entered.promise;
  await f.runtime.close(ID, "Owner closed the task"); // no cached handle: closes via the recorded stopped provider
  const closed = await f.row();
  expect(closed.status).toBe("closed");
  starting.release.resolve();

  // close() aborts the waiting turn, so it settles as cancelled; the refused attach still stops the provider.
  expect(await turn.result).toEqual({ status: "cancelled", stopReason: "cancelled" });
  for await (const _ of turn.events) {}
  expect(f.ensured).toHaveLength(1);
  expect(f.closes).toEqual([{ handle: f.ensured[0], discardPersistentState: false }]);
  expect(f.cached()).toEqual({ handle: false, runtime: false, executionDirectory: false });
  expect(await f.row()).toEqual(closed);
  expect(await f.store.load("record")).toEqual(savedRecord!);
  expect(await f.runtime.history(ID)).toEqual(saved);
});

test("a refused attach whose provider stop fails reports the failure and keeps the handle owned", async () => {
  const f = await fixture({ cachedHandle: false });
  const starting = f.hold("ensureSession");
  f.provider.close = async () => { throw new Error("provider did not stop"); };
  const turn = f.runtime.startTurn({ sessionId: ID, text: "Do the work" });
  await starting.entered.promise;
  await db.prisma.runtimeSession.update({ where: { id: ID }, data: { status: "closed", closedAt: new Date("2026-11-01T00:00:00.000Z") } });
  const closed = await f.row();
  starting.release.resolve();
  const result = await turn.result;
  expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("provider did not stop") });
  expect(f.cached()).toMatchObject({ handle: true, runtime: true });
  expect(await f.row()).toEqual(closed);
});

test("ensureSession refuses and stops the provider when its session closes during startup", async () => {
  const f = await fixture({ cachedHandle: false });
  let createdId = "";
  (f.runtime as any).runtimeFor = (id: string) => { createdId = id; (f.runtime as any).runtimes.set(id, f.provider); return f.provider; };
  const starting = f.hold("ensureSession");
  const cwd = (await f.row()).cwd;
  const ensuring = f.runtime.ensureSession({ sessionKey: "fresh", agent: "codex", cwd, repositoryId: f.config.repository.id }).catch((error: Error) => error);
  await starting.entered.promise;
  await db.prisma.runtimeSession.update({ where: { id: createdId }, data: { status: "closed", closedAt: new Date("2026-11-01T00:00:00.000Z") } });
  const closed = await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: createdId } });
  starting.release.resolve();
  expect(String(await ensuring)).toContain("closed");
  expect(f.closes).toEqual([{ handle: f.ensured[0], discardPersistentState: false }]);
  expect((f.runtime as any).handles.has(createdId)).toBe(false);
  expect((f.runtime as any).runtimes.has(createdId)).toBe(false);
  expect(await db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: createdId } })).toEqual(closed);
});

for (const legacy of [false, true]) {
  test(`a provider switch racing ${legacy ? "a legacy idle closure" : "closure"} is refused and keeps the original closedAt`, async () => {
    const f = await fixture();
    const stopping = f.hold("close"); // old provider stop precedes the switch write
    const switching = f.runtime.switchAgent(ID, "claude").catch((error: Error) => error);
    await stopping.entered.promise;
    const closedAt = new Date("2026-10-01T12:00:00.000Z");
    await db.prisma.runtimeSession.update({ where: { id: ID }, data: { status: legacy ? "idle" : "closed", closedAt } });
    const closed = await f.row();
    stopping.release.resolve();
    expect(String(await switching)).toContain("closed");
    expect(await f.row()).toEqual(closed);
    expect(f.ensured).toHaveLength(0);
  });
}

test("a session closed after the switch write stops the new provider and stays closed", async () => {
  const f = await fixture();
  const starting = f.hold("ensureSession");
  const switching = f.runtime.switchAgent(ID, "claude").catch((error: Error) => error);
  await starting.entered.promise;
  await db.prisma.runtimeSession.update({ where: { id: ID }, data: { status: "closed", closedAt: new Date("2026-11-01T00:00:00.000Z") } });
  const closed = await f.row();
  starting.release.resolve();
  expect(String(await switching)).toContain("closed");
  expect(f.closes.at(-1)).toEqual({ handle: f.ensured[0], discardPersistentState: false });
  expect(f.cached()).toEqual({ handle: false, runtime: false, executionDirectory: false });
  expect(await f.row()).toEqual(closed);
});

test("an open provider switch still restarts the session on the new provider", async () => {
  const f = await fixture();
  const switched = await f.runtime.switchAgent(ID, "claude");
  expect(switched).toMatchObject({ agent: "claude", status: "idle", closedAt: null });
  expect(f.ensured).toHaveLength(1);
});

for (const control of ["setMode", "setConfigOption"] as const) {
  test(`a late ${control} result after close leaves the session closed`, async () => {
    const f = await fixture();
    const held = f.hold(control);
    const call = (control === "setMode" ? f.runtime.setMode(ID, "plan") : f.runtime.setConfigOption(ID, "mode", "late")).catch((error: Error) => error);
    await held.entered.promise;
    await f.runtime.close(ID, "Owner closed the task");
    const closed = await f.row();
    held.release.resolve();
    await call;
    expect(await f.row()).toEqual(closed);
  });
}

test("legacy idle rows with closedAt refuse new delivery before any provider work", async () => {
  const f = await fixture({ cachedHandle: false });
  const legacyClosedAt = new Date("2026-10-01T12:00:00.000Z");
  await db.prisma.runtimeSession.update({ where: { id: ID }, data: { status: "idle", closedAt: legacyClosedAt } });
  const legacy = await f.row();
  await expect(f.runtime.enqueue({ sessionId: ID, text: "More work" })).rejects.toThrow("closed");
  const turn = f.runtime.startTurn({ sessionId: ID, text: "More work" });
  expect(await turn.result).toMatchObject({ status: "failed", error: expect.stringContaining("closed") });
  for await (const _ of turn.events) {}
  expect(f.ensured).toHaveLength(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
  expect(await f.row()).toEqual(legacy);
  expect(await f.runtime.history(ID)).toEqual(saved);
});

test("interrupted-session reconciliation refuses a legacy row with closedAt", async () => {
  const f = await fixture({ cachedHandle: false });
  await db.prisma.runtimeSession.update({ where: { id: ID }, data: { status: "active", closedAt: new Date("2026-10-01T12:00:00.000Z") } });
  const legacy = await f.row();
  await expect(f.runtime.reconcileInterruptedSession!(ID)).rejects.toThrow("closed");
  expect(await f.row()).toEqual(legacy);
});
