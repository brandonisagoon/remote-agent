import { describe, expect, test } from "bun:test";

import type { BbThread } from "../../../../../../types/runtime/index.ts";
import type {
  AgentIssue,
  SessionRuntime,
} from "../../../../../../types/sessions/index.ts";
import { locatorConflict, threadStillOwnsSession } from "./index.ts";

const runtime: SessionRuntime = {
  harnessSessionId: "session-1",
  parentSessionId: null,
  worktreePath: "/tmp/worktree",
  branchName: "feature-cube-1",
  harness: "codex",
  machine: "macbook-air",
  role: "primary",
  lifecycle: "persistent",
  bbThreadId: "thr_registered",
};

const issue = {
  state: { name: "Connected" },
} as AgentIssue;

const thread: BbThread = {
  id: "thr_registered",
  projectId: "proj_1",
  environmentId: "env_1",
  hostId: "host_air",
  providerId: "codex",
  title: null,
  status: "idle",
  parentThreadId: null,
  archivedAt: null,
};

describe("bb locator guard", () => {
  test("detects an attempt to replace a connected thread", () => {
    expect(
      locatorConflict(issue, runtime, {
        ...runtime,
        bbThreadId: "thr_incoming",
      }),
    ).toEqual({ bbThreadId: "thr_registered" });
  });

  test("allows the same thread and disconnected issues", () => {
    expect(locatorConflict(issue, runtime, runtime)).toBeNull();
    expect(
      locatorConflict(
        { ...issue, state: { ...issue.state, name: "Disconnected" } },
        runtime,
        { ...runtime, bbThreadId: "thr_incoming" },
      ),
    ).toBeNull();
  });

  test("requires the exact non-archived, non-error bb thread", () => {
    expect(threadStillOwnsSession(thread, runtime)).toBeTrue();
    expect(
      threadStillOwnsSession({ ...thread, id: "thr_other" }, runtime),
    ).toBeFalse();
    expect(
      threadStillOwnsSession({ ...thread, archivedAt: Date.now() }, runtime),
    ).toBeFalse();
    expect(
      threadStillOwnsSession({ ...thread, status: "error" }, runtime),
    ).toBeFalse();
  });
});
