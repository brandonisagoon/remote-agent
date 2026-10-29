import { afterEach, expect, test } from "bun:test";
import { attachIssueEvidence, uploadIssueEvidence } from "./evidence.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("upload copies signed headers, keeps the app credential off storage, and checks PUT failure", async () => {
  let status = 403;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const target = String(url); seen.push(target);
    if (target === "https://api.linear.app/graphql") {
      const body = JSON.parse(String(options?.body));
      expect(body.variables).toEqual({ contentType: "image/png", filename: "capture.png", size: 3 });
      return Response.json({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: "https://storage.example.com/signed", assetUrl: "https://uploads.linear.app/capture", headers: [{ key: "x-goog-test", value: "signed-header" }] } } } });
    }
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-goog-test")).toBe("signed-header");
    expect(headers.get("content-type")).toBe("image/png");
    expect(options?.method).toBe("PUT");
    expect(options?.redirect).toBe("error");
    return new Response(null, { status });
  }) as typeof fetch;
  const input = { name: "capture.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
  await expect(uploadIssueEvidence("secret-app-token", input)).rejects.toThrow("HTTP 403");
  status = 200;
  expect(await uploadIssueEvidence("secret-app-token", input)).toBe("https://uploads.linear.app/capture");
  expect(seen).toHaveLength(4);
});

test("a prepared MP4 allocates and PUTs exactly its own name, type, size and bytes", async () => {
  const bytes = new Uint8Array(4096).map((_, index) => index % 251);
  let body: Uint8Array | undefined;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url) === "https://api.linear.app/graphql") {
      expect(JSON.parse(String(options?.body)).variables).toEqual({ contentType: "video/mp4", filename: "flow.mp4", size: 4096 });
      return Response.json({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: "https://storage.example.com/signed", assetUrl: "https://uploads.linear.app/flow", headers: [] } } } });
    }
    expect(new Headers(options?.headers).get("content-type")).toBe("video/mp4");
    body = options?.body as Uint8Array;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  expect(await uploadIssueEvidence("key", { name: "flow.mp4", contentType: "video/mp4", bytes })).toBe("https://uploads.linear.app/flow");
  expect(Buffer.from(body!).equals(Buffer.from(bytes))).toBeTrue();
});

test("attachments are scoped to the bound issue and only confirmed attachment IDs are returned", async () => {
  let success = false;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    expect(body.variables.input).toEqual({ issueId: "bound-issue", title: "Save flow", url: "https://uploads.linear.app/video" });
    return Response.json({ data: { attachmentCreate: { success, attachment: success ? { id: "attachment" } : null } } });
  }) as typeof fetch;
  const input = { issueId: "bound-issue", title: "Save flow", url: "https://uploads.linear.app/video" };
  await expect(attachIssueEvidence("key", input)).rejects.toThrow("did not confirm");
  success = true;
  expect(await attachIssueEvidence("key", input)).toBe("attachment");
});
