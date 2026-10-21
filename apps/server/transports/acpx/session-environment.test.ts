import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";

import { createAcpxSessionRuntime, sessionEnvironment } from "./session-runtime.ts";

describe("sessionEnvironment", () => {
  test("injects the session id and control socket, preserving caller env", () => {
    expect(
      sessionEnvironment("runtime-1", { controlIpcPath: "/tmp/control.sock" }, { FOO: "bar" }),
    ).toEqual({
      FOO: "bar",
      REMOTE_AGENT_SESSION_ID: "runtime-1",
      REMOTE_AGENT_SOCKET: "/tmp/control.sock",
    });
  });

  test("the installed acpx store preserves environment names for reconnects", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "acpx-env-test-"));
    try {
      const store = createRuntimeStore({ stateDir });
      const now = new Date().toISOString();
      const env = sessionEnvironment("runtime-1", { controlIpcPath: "/tmp/control.sock" }, { REMOTE_AGENT_TASK_ID: "task-one" });
      const record: AcpSessionRecord = {
        schema: "acpx.session.v1", acpxRecordId: "runtime-1", acpSessionId: "provider-1", agentCommand: "codex",
        cwd: stateDir, createdAt: now, lastUsedAt: now, lastSeq: 0,
        eventLog: { active_path: "runtime-1.events.jsonl", segment_count: 1, max_segment_bytes: 1_048_576, max_segments: 5 }, messages: [], updated_at: now,
        cumulative_token_usage: {}, request_token_usage: {}, acpx: { session_options: { env } },
      };
      await store.save(record);
      expect((await store.load(record.acpxRecordId))?.acpx?.session_options?.env).toEqual(env);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  test("a failure before provider startup settles the turn and closes its stream", async () => {
    const db = await createTestDatabase();
    const runtime = createAcpxSessionRuntime(db.prisma, testConfig());
    try {
      const turn = runtime.startTurn({ sessionId: "missing-session", text: "Do not hang" });
      const result = await turn.result;
      expect(result.status).toBe("failed");
      const events = [];
      for await (const event of turn.events) events.push(event);
      expect(events).toEqual([]);
    } finally { await runtime.shutdown(); await db.cleanup(); }
  });
});
