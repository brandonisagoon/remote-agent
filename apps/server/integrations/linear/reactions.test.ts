import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { TrackerReaction, reactToComment, reactToIssue } from "./reactions.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function successfulReaction() {
  const requests: Array<{ query: string; variables: Record<string, string> }> = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      data: { reactionCreate: { success: true } },
    });
  }) as typeof fetch;
  return requests;
}

describe("Linear reactions", () => {
  test("creates a comment reaction", async () => {
    const requests = successfulReaction();

    const result = await reactToComment(
      "linear-key",
      "comment-id",
      TrackerReaction.Received,
    );

    expect(result).toBe(true);
    expect(requests[0]?.query).toContain("commentId: $commentId");
    expect(requests[0]?.variables).toEqual({
      commentId: "comment-id",
      emoji: "mailbox_with_mail",
    });
  });

  test("creates the describing reaction on an issue", async () => {
    const requests = successfulReaction();

    const result = await reactToIssue(
      "linear-key",
      "issue-id",
      TrackerReaction.Describing,
    );

    expect(result).toBe(true);
    expect(requests[0]?.query).toContain("issueId: $issueId");
    expect(requests[0]?.variables).toEqual({
      issueId: "issue-id",
      emoji: "pencil2",
    });
  });

  test("keeps a failed issue reaction best-effort", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async (_input, _init) =>
      new Response("unavailable", { status: 503 })) as typeof fetch;

    const result = await reactToIssue(
      "linear-key",
      "issue-id",
      TrackerReaction.Describing,
    );

    expect(result).toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
