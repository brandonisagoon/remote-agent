import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import { linearAppAuth } from "./app-auth.ts";
import { linearGraphql } from "./client.ts";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Credentials are only sent to Linear's upload origin, never a supplied host
 * or redirect. Strip temporary signatures when comparing issue membership. */
export function linearUploadUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== "https://uploads.linear.app" || url.username || url.password || url.hash || url.pathname === "/") {
    throw new Error("Only Linear upload URLs are supported");
  }
  url.search = "";
  return url.href;
}

export function issueUploadUrls(text: string | null): string[] {
  const urls = new Set<string>();
  for (const match of (text ?? "").matchAll(/https:\/\/uploads\.linear\.app\/[^\s<>"'\)\]]+/g)) {
    try { urls.add(linearUploadUrl(match[0])); } catch { /* Not a supported asset. */ }
  }
  return [...urls];
}

/** The caller supplies a server-resolved issue ID, not an agent-chosen issue.
 * Check comments and attachments too, including paginated older uploads. */
export async function issueContainsUpload(apiKey: LinearCredential, issueId: string, description: string | null, url: string): Promise<boolean> {
  if (issueUploadUrls(description).includes(url)) return true;
  type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  type IssueUploads = { issue: { comments: Page<{ body: string }>; attachments: Page<{ url: string }> } | null };
  let commentsAfter: string | null = null;
  let attachmentsAfter: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: IssueUploads = await linearGraphql<IssueUploads>(apiKey, `query SourceIssueUploads($id: String!, $commentsAfter: String, $attachmentsAfter: String) {
      issue(id: $id) {
        comments(first: 100, after: $commentsAfter) { nodes { body } pageInfo { hasNextPage endCursor } }
        attachments(first: 100, after: $attachmentsAfter) { nodes { url } pageInfo { hasNextPage endCursor } }
      }
    }`, { id: issueId, commentsAfter, attachmentsAfter });
    if (!data.issue) throw new Error("Linked issue not found");
    const { comments, attachments } = data.issue;
    if (comments.nodes.some((comment) => issueUploadUrls(comment.body).includes(url)) || attachments.nodes.some((attachment) => {
      try { return linearUploadUrl(attachment.url) === url; } catch { return false; }
    })) return true;
    if (!comments.pageInfo.hasNextPage && !attachments.pageInfo.hasNextPage) return false;
    if ((comments.pageInfo.hasNextPage && (!comments.pageInfo.endCursor || comments.pageInfo.endCursor === commentsAfter)) ||
        (attachments.pageInfo.hasNextPage && (!attachments.pageInfo.endCursor || attachments.pageInfo.endCursor === attachmentsAfter))) {
      throw new Error("Linear attachment pagination did not advance");
    }
    commentsAfter = comments.pageInfo.endCursor ?? commentsAfter;
    attachmentsAfter = attachments.pageInfo.endCursor ?? attachmentsAfter;
  }
  throw new Error("Linked issue has too many attachment pages to inspect in one request");
}

/** Same auth as the GraphQL API. A renewable app token gets one explicit 401
 * refresh; a 403 or other error is never treated as permission to broaden access. */
export async function downloadLinearUpload(apiKey: LinearCredential, value: string) {
  const url = linearUploadUrl(value);
  const signal = AbortSignal.timeout(120_000);
  const send = (authorization: string) => fetch(url, { headers: { Authorization: authorization }, redirect: "error", signal });
  const authorization = await linearAppAuth.authorization(apiKey);
  let response = await send(authorization);
  if (response.status === 401 && typeof apiKey !== "string") {
    await response.body?.cancel();
    linearAppAuth.reject(apiKey, authorization);
    response = await send(await linearAppAuth.authorization(apiKey));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Linear attachment download failed (HTTP ${response.status})`);
  }
  if (Number(response.headers.get("content-length")) > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel();
    throw new Error("Linear attachment exceeds the 50 MiB limit");
  }
  if (!response.body) throw new Error("Linear returned an empty attachment");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error("Linear attachment exceeds the 50 MiB limit");
      chunks.push(chunk);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!size) throw new Error("Linear returned an empty attachment");
  return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream" };
}
