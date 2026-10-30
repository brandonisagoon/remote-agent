import { afterEach, expect, test } from "bun:test";
import { fetchIssueCommentIdentity } from "./comments.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const missing = () => ({ data: null, errors: [{ message: "Entity not found: Comment", path: ["comment"], locations: [{ line: 1, column: 46 }], extensions: { type: "invalid input", code: "INPUT_ERROR", statusCode: 400, userError: true, userPresentableMessage: "Could not find referenced Comment." } }] });

test("the exact GraphQL missing-comment response reconciles a reserved UUID as absent", async () => {
  const calls: unknown[] = [];
  globalThis.fetch = (async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json(missing()); }) as typeof fetch;
  expect(await fetchIssueCommentIdentity("disposable-key", "reserved-uuid")).toBeNull();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ variables: { commentId: "reserved-uuid" } });
});

test.each(["auth", "permission", "wrong-path", "wrong-entity", "message-only", "mixed-errors", "partial-data", "missing-data", "wrong-status", "extra-extension"])("%s GraphQL failure remains an error instead of comment absence", async kind => {
  const payload: any = missing();
  if (kind === "auth") payload.errors[0].extensions.code = "UNAUTHENTICATED";
  if (kind === "permission") payload.errors[0].extensions.code = "FORBIDDEN";
  if (kind === "wrong-path") payload.errors[0].path = ["comment", "issue"];
  if (kind === "wrong-entity") payload.errors[0].message = "Entity not found: Issue";
  if (kind === "message-only") delete payload.errors[0].extensions;
  if (kind === "mixed-errors") payload.errors.push({ message: "Permission denied", extensions: { code: "FORBIDDEN" } });
  if (kind === "partial-data") payload.data = { comment: { id: "reserved-uuid", body: "Partial private content", issue: null } };
  if (kind === "missing-data") delete payload.data;
  if (kind === "wrong-status") payload.errors[0].extensions.statusCode = 403;
  if (kind === "extra-extension") payload.errors[0].extensions.permissionDenied = true;
  globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch;
  const error = await fetchIssueCommentIdentity("disposable-key", "reserved-uuid").then(() => null, error => error);
  expect(error).toBeInstanceOf(Error);
  expect(JSON.stringify(error)).not.toContain("Partial private content");
});

test.each([401, 403, 404, 429, 503])("HTTP %s never turns a missing-looking body into absence", async status => {
  globalThis.fetch = (async () => Response.json(missing(), { status })) as unknown as typeof fetch;
  await expect(fetchIssueCommentIdentity("disposable-key", "reserved-uuid")).rejects.toThrow(`HTTP ${status}`);
});

test.each(["network", "timeout", "invalid-json", "empty-data", "missing-comment", "wrong-id", "invalid-body"])("%s lookup cannot confirm an absent comment", async kind => {
  globalThis.fetch = (async () => {
    if (kind === "network") throw new Error("Network unavailable");
    if (kind === "timeout") throw new DOMException("Request timed out", "TimeoutError");
    if (kind === "invalid-json") return new Response("not JSON");
    if (kind === "empty-data") return Response.json({ data: null });
    if (kind === "missing-comment") return Response.json({ data: {} });
    return Response.json({ data: { comment: { id: kind === "wrong-id" ? "foreign-comment" : "reserved-uuid", body: kind === "invalid-body" ? null : "saved body", issue: { id: "issue" } } } });
  }) as unknown as typeof fetch;
  await expect(fetchIssueCommentIdentity("disposable-key", "reserved-uuid")).rejects.toThrow();
});

test("ordinary null and exact document-anchored identities preserve their existing behavior", async () => {
  globalThis.fetch = (async () => Response.json({ data: { comment: null } })) as unknown as typeof fetch;
  expect(await fetchIssueCommentIdentity("disposable-key", "reserved-uuid")).toBeNull();
  globalThis.fetch = (async () => Response.json({ data: { comment: { id: "reserved-uuid", body: "saved body", parentId: "parent", issue: null, documentContent: { issue: { id: "issue" } } } } })) as unknown as typeof fetch;
  expect(await fetchIssueCommentIdentity("disposable-key", "reserved-uuid")).toMatchObject({ id: "reserved-uuid", body: "saved body", parentId: "parent", issue: { id: "issue" } });
});
