import { afterEach, describe, expect, test } from "bun:test";

import {
  advanceRuntimeEventCursor,
  appendRuntimeLifecycleEvent,
  attachRuntimeSession,
  attachRuntimeSessionToMirror,
  beginRuntimeSession,
  findRuntimeSession,
  getRuntimeEventCursor,
  listRuntimeLifecycleEvents,
  prepareRuntimeAgentSwitch,
  pruneRuntimeLifecycleEvents,
  runtimeScopeKey,
  updateRuntimeSessionState,
} from "./runtime-registry.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../../test-support/db.ts";

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.cleanup();
  database = null;
});

describe("runtime session registry", () => {
  test("provisions one stable row for repeated ensures of the same scope", async () => {
    database = await createTestDatabase();
    const input = {
      sessionKey: "linear:ENG-42:primary",
      agent: "codex" as const,
      cwd: "/tmp/repo/../repo",
      worktreePath: "/tmp/repo",
      executionTarget: "studio-mac",
    };

    const first = await beginRuntimeSession(database.prisma, input);
    const second = await beginRuntimeSession(database.prisma, input);

    expect(second.id).toBe(first.id);
    expect(second.scopeKey).toBe(
      runtimeScopeKey({ ...input, cwd: "/tmp/repo" }),
    );
    expect(await database.prisma.runtimeSession.count()).toBe(1);
  });

  test("attaches acpx identity and caches complete UI state", async () => {
    database = await createTestDatabase();
    const started = await beginRuntimeSession(database.prisma, {
      sessionKey: "zed:one",
      agent: "codex",
      cwd: "/tmp/repo",
    });
    const attached = await attachRuntimeSession(database.prisma, {
      id: started.id,
      acpxRecordId: "record-1",
      acpxSessionId: "acp-1",
      agentSessionId: "provider-1",
      configOptions: [
        {
          id: "reasoning_effort",
          name: "Reasoning",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ],
    });

    expect(attached).toMatchObject({
      id: started.id,
      status: "idle",
      acpxRecordId: "record-1",
      acpxSessionId: "acp-1",
      agentSessionId: "provider-1",
    });
    expect(attached.configOptions[0]).toMatchObject({
      id: "reasoning_effort",
      currentValue: "high",
    });

    await updateRuntimeSessionState(database.prisma, started.id, {
      usage: { used: 25_000, size: 100_000 },
    });
    expect(await findRuntimeSession(database.prisma, started.id)).toMatchObject({
      usage: { used: 25_000, size: 100_000 },
    });
  });

  test("keeps consumer cursors independent and links Linear optionally", async () => {
    database = await createTestDatabase();
    const session = await beginRuntimeSession(database.prisma, {
      sessionKey: "zed:two",
      agent: "claude",
      cwd: "/tmp/repo",
    });
    const issue = await database.prisma.sessionMirror.create({
      data: {
        sessionKey: "harness-two",
        externalId: "linear-id",
      },
    });
    await attachRuntimeSessionToMirror(database.prisma, {
      runtimeSessionId: session.id,
      sessionMirrorId: issue.id,
    });
    await advanceRuntimeEventCursor(database.prisma, {
      runtimeSessionId: session.id,
      consumer: "linear",
      sourceCursor: "request-1:4",
      generation: 4n,
    });

    expect(
      await getRuntimeEventCursor(database.prisma, {
        runtimeSessionId: session.id,
        consumer: "linear",
      }),
    ).toEqual({ sourceCursor: "request-1:4", generation: 4n });
    expect(
      await getRuntimeEventCursor(database.prisma, {
        runtimeSessionId: session.id,
        consumer: "zed-replay",
      }),
    ).toEqual({ sourceCursor: null, generation: 0n });
    expect(
      await database.prisma.runtimeSession.findUnique({
        where: { id: session.id },
      }),
    ).toMatchObject({ sessionMirrorId: issue.id });
  });

  test("does not silently reopen a closed logical scope", async () => {
    database = await createTestDatabase();
    const input = {
      sessionKey: "closed",
      agent: "codex" as const,
      cwd: "/tmp/repo",
    };
    const session = await beginRuntimeSession(database.prisma, input);
    await updateRuntimeSessionState(database.prisma, session.id, {
      status: "closed",
      closedAt: new Date(),
    });

    await expect(beginRuntimeSession(database.prisma, input)).rejects.toThrow(
      "use a new session key",
    );
  });

  test("journals lifecycle events until the projector advances", async () => {
    database = await createTestDatabase();
    const session = await beginRuntimeSession(database.prisma, {
      sessionKey: "journal",
      agent: "codex",
      cwd: "/tmp/repo",
    });
    const event = await appendRuntimeLifecycleEvent(database.prisma, {
      kind: "turn",
      id: "request-1:completed",
      sessionId: session.id,
      requestId: "request-1",
      createdAt: 1_788_000_000_000,
      phase: "completed",
    });
    expect(event.sequence).toBeGreaterThan(0);
    expect(await listRuntimeLifecycleEvents(database.prisma)).toEqual([event]);

    await pruneRuntimeLifecycleEvents(database.prisma, {
      runtimeSessionId: session.id,
      throughSequence: event.sequence!,
    });
    expect(await listRuntimeLifecycleEvents(database.prisma)).toEqual([]);
  });

  describe("terminal closure", () => {
    async function session(data: { status: string; closedAt: Date | null }) {
      database = await createTestDatabase();
      return database.prisma.runtimeSession.create({ data: { id: "s", scopeKey: "s", agentCommand: "codex", cwd: "/tmp/closure", recoveryDetail: "kept", ...data } });
    }
    const row = () => database!.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "s" } });
    const original = new Date("2026-10-01T12:00:00.000Z");

    for (const [name, data] of [["closed", { status: "closed", closedAt: original }], ["legacy idle with closedAt", { status: "idle", closedAt: original }]] as const) {
      test(`late nonterminal writes are zero-row no-ops on a ${name} row`, async () => {
        const before = await session({ ...data });
        for (const write of [
          { status: "idle" as const, recoveryDetail: null, agentSessionId: "late" },
          { status: "error" as const, recoveryDetail: "late failure" },
          { status: "active" as const },
          { usage: { used: 1, size: 2 } },
        ]) expect(await updateRuntimeSessionState(database!.prisma, "s", write)).toBe(false);
        expect(await row()).toEqual(before);
        await expect(attachRuntimeSession(database!.prisma, { id: "s", acpxRecordId: "late" })).rejects.toThrow("closed");
        await expect(prepareRuntimeAgentSwitch(database!.prisma, { id: "s", agent: "claude" })).rejects.toThrow("closed");
        expect(await row()).toEqual(before);
      });
    }

    test("closing again keeps the original closure timestamp", async () => {
      await session({ status: "idle", closedAt: original });
      expect(await updateRuntimeSessionState(database!.prisma, "s", { status: "closed", closedAt: new Date(), recoveryDetail: null })).toBe(true);
      expect(await row()).toMatchObject({ status: "closed", closedAt: original, recoveryDetail: null });
    });

    test("open rows still accept every transition; reopening and missing rows are refused", async () => {
      await session({ status: "provisioning", closedAt: null });
      for (const status of ["idle", "active", "error", "idle"] as const) {
        expect(await updateRuntimeSessionState(database!.prisma, "s", { status })).toBe(true);
        expect((await row()).status).toBe(status);
      }
      await expect(updateRuntimeSessionState(database!.prisma, "s", { status: "idle", closedAt: null })).rejects.toThrow("closing status");
      expect(await prepareRuntimeAgentSwitch(database!.prisma, { id: "s", agent: "claude" })).toMatchObject({ agent: "claude", status: "provisioning", closedAt: null });
      const closedAt = new Date();
      expect(await updateRuntimeSessionState(database!.prisma, "s", { status: "closed", closedAt })).toBe(true);
      expect(await row()).toMatchObject({ status: "closed", closedAt });
      await expect(updateRuntimeSessionState(database!.prisma, "missing", { status: "idle" })).rejects.toThrow();
      await expect(updateRuntimeSessionState(database!.prisma, "missing", { status: "closed", closedAt })).rejects.toThrow("not found");
    });
  });
});
