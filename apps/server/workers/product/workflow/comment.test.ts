import { afterEach, describe, expect, test } from "bun:test";

import { testConfig } from "../../../../../test-support/config.ts";
import {
  buildWorktreeLinkComment,
  postWorktreeLinkComment,
  WORKTREE_LINK_SEARCH_TEXT,
} from "./comment.ts";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

describe("orchestration worktree link comment", () => {
  test("builds an SSH worktree link with the runtime session", () => {
    const body = buildWorktreeLinkComment({
      editors: [{ name: "Zed", scheme: "zed", connection: "ssh", remoteHost: "test-remote" }],
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
        editors: [{ name: "Zed", scheme: "zed", connection: "local", remoteHost: null }],
        worktreePath: "/srv/worktrees/foo cube",
        runtimeSessionId: "runtime_local",
      }),
    ).toContain(
      "[Open Worktree in Zed](zed://file/srv/worktrees/foo%20cube)",
    );
  });

  test("skips a duplicate visible link without creating a comment", async () => {
    const created: string[] = [];
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        worktreePath: "/workspace/.worktrees/feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => true,
        createComment: async (_key, _issueId, body) => {
          created.push(body);
          return "comment-1";
        },
      },
    );

    expect(outcome).toBe("skipped");
    expect(created).toHaveLength(0);
  });

  test("posts a comment linking the provisioned worktree path", async () => {
    const created: Array<{ issueId: string; body: string }> = [];
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        worktreePath: "/workspace/.worktrees/cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => false,
        createComment: async (_key, issueId, body) => {
          created.push({ issueId, body });
          return "comment-1";
        },
      },
    );

    expect(outcome).toBe("posted");
    expect(created).toHaveLength(1);
    expect(created[0]?.issueId).toBe("issue-id");
    expect(created[0]?.body).toContain(WORKTREE_LINK_SEARCH_TEXT);
    expect(created[0]?.body).toContain("/workspace/.worktrees/cube-2829");
    expect(created[0]?.body).toContain("Remote Agent session `runtime_2829`");
    expect(created[0]?.body).not.toContain("<!--");
  });

  test("reports comment creation failure without throwing", async () => {
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        worktreePath: "/workspace/.worktrees/feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => false,
        createComment: async () => null,
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
        worktreePath: "/workspace/.worktrees/feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => {
          throw new Error("boom");
        },
        createComment: async () => "comment-1",
      },
    );

    expect(outcome).toBe("failed");
  });
});
