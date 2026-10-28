import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import { linearGraphql } from "./client.ts";

/** The signed storage request carries only Linear's upload headers, never
 * the app credential. Check the PUT result before advertising the asset. */
export async function uploadIssueEvidence(apiKey: LinearCredential, input: { name: string; contentType: string; bytes: Uint8Array }) {
  const data = await linearGraphql<{
    fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null };
  }>(apiKey, `mutation IssueEvidenceUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      success uploadFile { uploadUrl assetUrl headers { key value } }
    }
  }`, { contentType: input.contentType, filename: input.name, size: input.bytes.byteLength });
  const upload = data.fileUpload.uploadFile;
  if (!data.fileUpload.success || !upload) throw new Error("Linear did not allocate the evidence upload");
  for (const value of [upload.uploadUrl, upload.assetUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Linear returned an invalid evidence URL");
  }
  const headers = new Headers({ "content-type": input.contentType, "cache-control": "public, max-age=31536000" });
  for (const { key, value } of upload.headers) headers.set(key, value);
  const result = await fetch(upload.uploadUrl, { method: "PUT", headers, body: new Uint8Array(input.bytes), redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!result.ok) throw new Error(`Evidence upload failed (HTTP ${result.status}); the issue status was not advanced`);
  return upload.assetUrl;
}

/** Linear upserts attachments by issue and URL. Safe after a lost response. */
export async function attachIssueEvidence(apiKey: LinearCredential, input: { issueId: string; title: string; url: string }) {
  const data = await linearGraphql<{ attachmentCreate: { success: boolean; attachment: { id: string } | null } }>(apiKey,
    "mutation AttachIssueEvidence($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id } } }", { input });
  if (!data.attachmentCreate.success || !data.attachmentCreate.attachment) throw new Error("Linear did not confirm the evidence attachment");
  return data.attachmentCreate.attachment.id;
}
