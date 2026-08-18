import { describe, expect, test } from "bun:test";

import { createFakeBbClient } from "../../../../../../test-support/bb.ts";
import { testConfig } from "../../../../../../test-support/config.ts";
import type { BbEvent, BbThread } from "../../../../../../types/runtime/index.ts";
import type { RuntimeSessionEvent } from "../../../../../../types/sessions/index.ts";
import { resolveBbBackedEvent } from "./resolve-bb-backed-event.ts";

const CONFIG = testConfig();

const thread: BbThread = {
  id: "thr_canonical",
  projectId: CONFIG.bbProjectId,
  environmentId: "env_worktree",
  hostId: CONFIG.bbHostIds["macbook-air"] ?? null,
  providerId: "claude-code",
  title: "CUBE-1 · delegate",
  status: "active",
  parentThreadId: null,
  archivedAt: null,
};

const lifecycleEvent: RuntimeSessionEvent = {
  eventId: "provider-start",
  occurredAt: "2026-08-13T12:00:00.000Z",
  generation: 1,
  type: "session.started",
  runtime: {
    harnessSessionId: "provider-uuid",
    parentSessionId: null,
    worktreePath: "/worktrees/cube-1",
    branchName: "feature-cube-1",
    harness: "claude",
    machine: "macbook-air",
    role: "primary",
    lifecycle: null,
    cubeIssueIdentifier: null,
    bbThreadId: null,
  },
};

function identity(threadId: string, providerId: string): BbEvent {
  return {
    id: "evt_identity",
    threadId,
    seq: 1,
    createdAt: 1,
    type: "thread/identity",
    scope: { kind: "thread" },
    data: { providerThreadId: providerId },
  };
}

describe("resolveBbBackedEvent", () => {
  test("rewrites a provider hook to its canonical bb thread identity", async () => {
    const bb = createFakeBbClient([thread]);
    bb.putEnvironment({
      id: "env_worktree",
      projectId: CONFIG.bbProjectId,
      hostId: thread.hostId!,
      path: lifecycleEvent.runtime.worktreePath,
      branchName: lifecycleEvent.runtime.branchName ?? null,
    });
    bb.pushEvent(identity(thread.id, lifecycleEvent.runtime.harnessSessionId));

    expect(await resolveBbBackedEvent(CONFIG, lifecycleEvent, bb)).toMatchObject({
      runtime: {
        harnessSessionId: thread.id,
        bbThreadId: thread.id,
      },
    });
  });

  test("does not bind a matching provider UUID from another worktree", async () => {
    const bb = createFakeBbClient([thread]);
    bb.putEnvironment({
      id: "env_worktree",
      projectId: CONFIG.bbProjectId,
      hostId: thread.hostId!,
      path: "/worktrees/another-issue",
      branchName: "another-issue",
    });
    bb.pushEvent(identity(thread.id, lifecycleEvent.runtime.harnessSessionId));

    expect(await resolveBbBackedEvent(CONFIG, lifecycleEvent, bb)).toBe(lifecycleEvent);
  });
});
