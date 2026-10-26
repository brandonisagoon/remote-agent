import { afterEach, expect, test } from "bun:test";
import { downloadLinearUpload, issueContainsUpload, issueUploadUrls, linearUploadUrl, MAX_ATTACHMENT_BYTES } from "./downloads.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const url = "https://uploads.linear.app/workspace/image/file";

test("only Linear's exact HTTPS upload origin can receive the credential", async () => {
  let calls = 0;
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    calls++;
    expect(String(target)).toBe(url);
    expect(new Headers(init?.headers).get("authorization")).toBe("private-key");
    expect(init?.redirect).toBe("error");
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  for (const invalid of ["http://uploads.linear.app/file", "https://uploads.linear.app.evil.test/file", "https://uploads.linear.app@evil.test/file", "https://user:secret@uploads.linear.app/file", "https://uploads.linear.app:444/file", "file:///tmp/image", "https://uploads.linear.app/"]) {
    await expect(downloadLinearUpload("private-key", invalid)).rejects.toThrow();
  }
  expect(calls).toBe(0);
  expect((await downloadLinearUpload("private-key", url + "?signature=expired")).bytes).toEqual(Buffer.from([137, 80, 78, 71]));
  expect(calls).toBe(1);
  expect(linearUploadUrl(url + "?signature=expired")).toBe(url);
  expect(issueUploadUrls(`![Example](<${url}?signature=expired>) and ![duplicate](${url})`)).toEqual([url]);
});

test("an app token is refreshed once for 401, while 403 is not retried or exposed", async () => {
  const credential = { type: "app" as const, clientId: "download-test", clientSecret: "private-app-secret" };
  let grants = 0;
  let downloads = 0;
  let forbidden = false;
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    if (String(target) === "https://api.linear.app/oauth/token") {
      grants++;
      return Response.json({ access_token: `token-${grants}`, token_type: "Bearer", expires_in: 3600 });
    }
    downloads++;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer token-${grants}`);
    if (forbidden) return new Response("private diagnostic body", { status: 403 });
    return downloads === 1 ? new Response(null, { status: 401 }) : new Response("image", { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  expect((await downloadLinearUpload(credential, url)).bytes.toString()).toBe("image");
  expect([grants, downloads]).toEqual([2, 2]);
  forbidden = true;
  await expect(downloadLinearUpload(credential, url)).rejects.toThrow("Linear attachment download failed (HTTP 403)");
  expect([grants, downloads]).toEqual([2, 3]);
});

test("redirects, empty files, and oversized declared or streamed responses are rejected", async () => {
  let response = new Response(null, { status: 302, headers: { location: "https://other.test/asset" } });
  globalThis.fetch = (async (_target: unknown) => response) as typeof fetch;
  await expect(downloadLinearUpload("key", url)).rejects.toThrow("HTTP 302");
  response = new Response("");
  await expect(downloadLinearUpload("key", url)).rejects.toThrow("empty");
  response = new Response("small", { headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) } });
  await expect(downloadLinearUpload("key", url)).rejects.toThrow("50 MiB");
  let cancelled = false;
  response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)); }, cancel() { cancelled = true; } }));
  await expect(downloadLinearUpload("key", url)).rejects.toThrow("50 MiB");
  expect(cancelled).toBeTrue();
});

test("membership follows only the bound issue's description, paginated comments and attachments", async () => {
  const seen: unknown[] = [];
  globalThis.fetch = (async (_target: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body.variables);
    expect(body.variables.id).toBe("bound-issue");
    return Response.json({ data: { issue: {
      comments: { nodes: body.variables.commentsAfter ? [{ body: `![Screenshot](${url})` }] : [], pageInfo: { hasNextPage: !body.variables.commentsAfter, endCursor: "comment-100" } },
      attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } });
  }) as typeof fetch;
  expect(await issueContainsUpload("key", "bound-issue", `![image](${url})`, url)).toBeTrue();
  expect(seen).toHaveLength(0);
  expect(await issueContainsUpload("key", "bound-issue", null, url)).toBeTrue();
  expect(seen).toEqual([{ id: "bound-issue", commentsAfter: null, attachmentsAfter: null }, { id: "bound-issue", commentsAfter: "comment-100", attachmentsAfter: null }]);
  globalThis.fetch = (async (_target: unknown) => Response.json({ data: { issue: {
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    attachments: { nodes: [{ url: url + "?signature=short-lived" }], pageInfo: { hasNextPage: false, endCursor: null } },
  } } })) as typeof fetch;
  expect(await issueContainsUpload("key", "bound-issue", null, url)).toBeTrue();
  expect(await issueContainsUpload("key", "bound-issue", null, url + "-unrelated")).toBeFalse();
});
