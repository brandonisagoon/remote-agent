import { afterEach, describe, expect, test } from "bun:test";

import { getMachine } from "../../../machines/index.ts";
import { testConfig } from "../../../../test-support/config.ts";
import {
  buildWorktreeLinkComment,
  postWorktreeLinkComment,
  predictWorktreePath,
  waitForWorktreeReady,
  WORKTREE_LINK_SEARCH_TEXT,
} from "./comment.ts";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

describe("orchestration worktree link comment", () => {
  test("builds an SSH worktree link with the runtime session", () => {
    const body = buildWorktreeLinkComment({
      machine: getMachine({ id: "macbook-air" }),
      zedRemoteHost: "test-remote",
      worktreePath: "/srv/worktrees/foo-cube-2829",
      runtimeSessionId: "runtime_2829",
    });
    expect(body).toContain(
      "[Open Worktree in Zed](zed://ssh/test-remote/srv/worktrees/foo-cube-2829)",
    );
    expect(body).toContain("Remote Agent session `runtime_2829`");
    expect(body).not.toContain("<!--");
  });

  test("builds the exact local-machine comment body", () => {
    expect(
      buildWorktreeLinkComment({
        machine: getMachine({ id: "macbook-pro" }),
        zedRemoteHost: "unused",
        worktreePath: "/srv/worktrees/foo cube",
        runtimeSessionId: "runtime_local",
      }),
    ).toContain(
      "[Open Worktree in Zed](zed://file/srv/worktrees/foo%20cube)",
    );
  });

  test("predicts the default worktree path and sanitizes branch slashes", () => {
    expect(
      predictWorktreePath(
        "/workspace/.worktrees",
        "feature/deep-link-cube-2829",
      ),
    ).toBe("/workspace/.worktrees/feature-deep-link-cube-2829");
  });

  test("waits for matching bootstrap stamps", async () => {
    let now = 0;
    let polls = 0;
    const ready = await waitForWorktreeReady(
      {
        worktreePath: "/tmp/.worktrees/feature-cube-2829",
        branchName: "feature-cube-2829",
        timeoutMs: 10,
        pollIntervalMs: 1,
      },
      {
        exists: (file) => {
          if (file.endsWith("/branch")) return true;
          return file.endsWith("/session-generation") && polls >= 1;
        },
        now: () => now,
        read: (file) => {
          if (file.endsWith("/branch")) return "feature-cube-2829\n";
          return "generation-1\n";
        },
        sleep: async (milliseconds) => {
          now += milliseconds;
          polls += 1;
        },
      },
    );

    expect(ready).toBeTrue();
    expect(polls).toBe(1);
  });

  test("stops waiting after the bootstrap timeout", async () => {
    let now = 0;
    const ready = await waitForWorktreeReady(
      {
        worktreePath: "/tmp/.worktrees/feature-cube-2829",
        branchName: "feature-cube-2829",
        timeoutMs: 2,
        pollIntervalMs: 1,
      },
      {
        exists: () => false,
        now: () => now,
        read: () => "",
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );

    expect(ready).toBeFalse();
  });

  test("performs one stamp check without sleeping when timeout is zero", async () => {
    let checks = 0;
    let sleeps = 0;
    const ready = await waitForWorktreeReady(
      {
        worktreePath: "/tmp/.worktrees/feature-cube-2829",
        branchName: "feature-cube-2829",
        timeoutMs: 0,
        pollIntervalMs: 0,
      },
      {
        exists: () => {
          checks += 1;
          return false;
        },
        now: () => 0,
        read: () => "",
        sleep: async () => {
          sleeps += 1;
        },
      },
    );

    expect(ready).toBeFalse();
    expect(checks).toBe(1);
    expect(sleeps).toBe(0);
  });

  test("skips a duplicate visible link without creating a comment", async () => {
    const created: string[] = [];
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        branchName: "feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        waitForReady: async () => true,
        hasCommentContaining: async () => true,
        createComment: async (_key, _issueId, body) => {
          created.push(body);
          return true;
        },
      },
    );

    expect(outcome).toBe("skipped");
    expect(created).toHaveLength(0);
  });

  test("posts a new worktree comment", async () => {
    const created: Array<{ issueId: string; body: string }> = [];
    const events: string[] = [];
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig({
          repository: {
            ...testConfig().repository,
            root: "/workspace/repository",
            worktreeRoot: "/workspace/.worktrees",
          },
        }),
        issueId: "issue-id",
        branchName: "feature/deep-link-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        waitForReady: async ({ worktreePath, branchName }) => {
          events.push(`ready:${worktreePath}:${branchName}`);
          return true;
        },
        hasCommentContaining: async () => {
          events.push("inspect");
          return false;
        },
        createComment: async (_key, issueId, body) => {
          events.push("create");
          created.push({ issueId, body });
          return true;
        },
      },
    );

    expect(outcome).toBe("posted");
    expect(events).toEqual([
      "ready:/workspace/.worktrees/feature-deep-link-cube-2829:feature/deep-link-cube-2829",
      "inspect",
      "create",
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]?.issueId).toBe("issue-id");
    expect(created[0]?.body).toContain(WORKTREE_LINK_SEARCH_TEXT);
    expect(created[0]?.body).toContain("Remote Agent session `runtime_2829`");
    expect(created[0]?.body).not.toContain("<!--");
  });

  test("threads watchdog timing options into the readiness check", async () => {
    let readinessInput: unknown;
    await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        branchName: "feature-cube-2829",
        runtimeSessionId: "runtime_2829",
        timeoutMs: 0,
        pollIntervalMs: 0,
      },
      {
        waitForReady: async (input) => {
          readinessInput = input;
          return true;
        },
        hasCommentContaining: async () => true,
        createComment: async () => true,
      },
    );

    expect(readinessInput).toEqual({
      worktreePath: "/nonexistent/.worktrees/feature-cube-2829",
      branchName: "feature-cube-2829",
      timeoutMs: 0,
      pollIntervalMs: 0,
    });
  });

  test("reports comment creation failure without throwing", async () => {
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        branchName: "feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        waitForReady: async () => true,
        hasCommentContaining: async () => false,
        createComment: async () => false,
      },
    );

    expect(outcome).toBe("failed");
  });

  test("converts an unexpected dependency error into failure", async () => {
    console.error = () => {};
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        branchName: "feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        waitForReady: async () => true,
        hasCommentContaining: async () => {
          throw new Error("unexpected");
        },
        createComment: async () => true,
      },
    );

    expect(outcome).toBe("failed");
  });

  test("does not inspect or create comments when bootstrap times out", async () => {
    console.error = () => {};
    let linearCalls = 0;
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        branchName: "feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        waitForReady: async () => false,
        hasCommentContaining: async () => {
          linearCalls += 1;
          return false;
        },
        createComment: async () => {
          linearCalls += 1;
          return true;
        },
      },
    );

    expect(outcome).toBe("failed");
    expect(linearCalls).toBe(0);
  });
});
