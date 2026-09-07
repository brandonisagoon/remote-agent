import { afterEach, describe, expect, test } from "bun:test";

import {
  createIssueComment,
  createThreadedIssueComment,
  fetchIssueCommentBody,
  issueHasCommentContaining,
  updateIssueComment,
} from "./comments.ts";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

describe("Linear issue comments", () => {
  test("creates a comment with the issue id and body", async () => {
    const requests: Array<{ query: string; variables: unknown }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        data: { commentCreate: { success: true, comment: { id: "comment-1" } } },
      });
    }) as typeof fetch;

    expect(
      await createIssueComment("linear-key", "issue-id", "comment body"),
    ).toBe("comment-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain("commentCreate");
    expect(requests[0]?.variables).toEqual({
      issueId: "issue-id",
      body: "comment body",
    });
  });

  test("reports comment creation failure without throwing", async () => {
    console.error = () => {};
    globalThis.fetch = (async (_input, _init) =>
      Response.json({ errors: [{ message: "comment rejected" }] })) as typeof fetch;

    expect(
      await createIssueComment("linear-key", "issue-id", "comment body"),
    ).toBeNull();
  });

  test("creates top-level and threaded comments and returns their ids", async () => {
    const requests: Array<{ query: string; variables: unknown }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        data: { commentCreate: { success: true, comment: { id: "comment-1" } } },
      });
    }) as typeof fetch;

    expect(
      await createThreadedIssueComment("linear-key", {
        issueId: "issue-id",
        body: "root body",
      }),
    ).toEqual({ id: "comment-1" });
    expect(
      await createThreadedIssueComment("linear-key", {
        issueId: "issue-id",
        body: "reply body",
        parentId: "comment-root",
      }),
    ).toEqual({ id: "comment-1" });
    expect(requests[0]?.variables).toEqual({
      input: { issueId: "issue-id", body: "root body" },
    });
    expect(requests[1]?.variables).toEqual({
      input: {
        issueId: "issue-id",
        body: "reply body",
        parentId: "comment-root",
      },
    });
  });

  test("updates and fetches an issue comment", async () => {
    const requests: Array<{ query: string; variables: unknown }> = [];
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return request.query.includes("commentUpdate")
        ? Response.json({ data: { commentUpdate: { success: true } } })
        : Response.json({ data: { comment: { body: "current body" } } });
    }) as typeof fetch;

    expect(
      await updateIssueComment("linear-key", "comment-1", "updated body"),
    ).toBe(true);
    expect(
      await fetchIssueCommentBody("linear-key", "comment-1"),
    ).toBe("current body");
    expect(requests.map((request) => request.variables)).toEqual([
      { commentId: "comment-1", body: "updated body" },
      { commentId: "comment-1" },
    ]);
  });

  test("finds a marker in existing issue comments", async () => {
    globalThis.fetch = (async (_input, _init) =>
      Response.json({
        data: {
          issue: {
            comments: {
              nodes: [
                { body: "ordinary comment" },
                { body: "<!-- marker -->\nOpen Worktree" },
              ],
            },
          },
        },
      })) as typeof fetch;

    expect(
      await issueHasCommentContaining(
        "linear-key",
        "issue-id",
        "<!-- marker -->",
      ),
    ).toBe(true);
  });

  test("returns false when the marker is absent", async () => {
    globalThis.fetch = (async (_input, _init) =>
      Response.json({
        data: {
          issue: { comments: { nodes: [{ body: "ordinary comment" }] } },
        },
      })) as typeof fetch;

    expect(
      await issueHasCommentContaining(
        "linear-key",
        "issue-id",
        "<!-- marker -->",
      ),
    ).toBe(false);
  });

  test("fails closed when comments cannot be inspected", async () => {
    console.error = () => {};
    globalThis.fetch = (async (_input, _init): Promise<Response> => {
      throw new Error("network unavailable");
    }) as typeof fetch;

    expect(
      await issueHasCommentContaining(
        "linear-key",
        "issue-id",
        "<!-- marker -->",
      ),
    ).toBe(true);
  });
});
