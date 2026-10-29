import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PreparedVideo, prepareVideoEvidence, preparedVideoPath } from "./video-evidence.ts";

// `path`, `contentType`, `sha256` and `size` describe the source capture.
// Receipts created before video preparation have no `prepared` field.
export const EvidenceReceipt = z.object({
  path: z.string(), title: z.string(), contentType: z.string(), sha256: z.string(), size: z.number(),
  prepared: PreparedVideo.optional(), assetUrl: z.string().optional(), attachmentId: z.string().optional(),
});
export type EvidenceReceipt = z.infer<typeof EvidenceReceipt>;
export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

function mediaType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) && bytes.subarray(0, 4096).includes(Buffer.from("webm"))) return "video/webm";
  throw new Error("Evidence must be a PNG, JPEG, WebP, GIF, MP4 or WebM capture");
}

/** Resolve symlinks before checking ownership; an external capture needs an
 * exact evidence resource receipt, not just a caller-supplied path. */
export async function readIssueEvidence(input: { path: string; title: string }, cwd: string, ownedPaths: string[]) {
  if (!path.isAbsolute(input.path)) throw new Error("Evidence needs an absolute path on the session's machine");
  const [file, root] = await Promise.all([realpath(input.path), realpath(cwd)]);
  const relative = path.relative(root, file);
  const inside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!inside && !ownedPaths.includes(file)) throw new Error("Evidence outside the worktree needs an exact task resource with kind=evidence");
  const bytes = await readBoundedFile(file);
  const receipt: EvidenceReceipt = { ...input, contentType: mediaType(bytes), size: bytes.length, sha256: sha256(bytes) };
  return { bytes, receipt };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readBoundedFile(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_EVIDENCE_BYTES) throw new Error("Evidence must be a nonempty regular file up to 50 MiB");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Evidence changed while reading; capture it again");
      offset += read.bytesRead;
    }
    if ((await handle.stat()).size !== stat.size) throw new Error("Evidence changed while reading; capture it again");
    return bytes;
  } finally { await handle.close(); }
}

/** Private server cache owned by one session's update request. */
export function evidenceCacheDirectory(stateDir: string, sessionId: string, requestKey: string): string {
  return path.join(stateDir, "issue-evidence", sha256(Buffer.from(sessionId)), sha256(Buffer.from(requestKey)));
}

type Context = { cwd: string; ownedPaths: string[]; cacheDirectory: string };

async function readUnchanged(file: EvidenceReceipt, context: Context): Promise<Buffer> {
  const { bytes, receipt } = await readIssueEvidence(file, context.cwd, context.ownedPaths);
  if (receipt.sha256 !== file.sha256) throw new Error("Evidence changed since this update began; restore the capture before retrying");
  return bytes;
}

/** Prepare every not-yet-uploaded video before any remote effect. A video
 * already uploaded by an older receipt keeps its asset. Returns whether any
 * receipt changed. */
export async function prepareIssueEvidence(evidence: EvidenceReceipt[], context: Context): Promise<boolean> {
  let changed = false;
  for (const file of evidence) {
    if (!file.contentType.startsWith("video/") || file.prepared || file.assetUrl) continue;
    const bytes = await readUnchanged(file, context);
    file.prepared = await prepareVideoEvidence({ bytes, title: file.title, name: path.basename(file.path) }, context.cacheDirectory, { maxBytes: MAX_EVIDENCE_BYTES });
    changed = true;
  }
  return changed;
}

/** The name, type and digest actually uploaded for a receipt. */
export function evidenceUpload(file: EvidenceReceipt) {
  if (file.prepared) return { name: file.prepared.name, contentType: file.prepared.contentType, sha256: file.prepared.sha256, size: file.prepared.size };
  return { name: path.basename(file.path), contentType: file.contentType, sha256: file.sha256, size: file.size };
}

/** Revalidate the source, then return the exact bytes recorded for upload.
 * A prepared video is never re-encoded here; a missing or changed output fails. */
export async function readEvidenceUpload(file: EvidenceReceipt, context: Context) {
  const source = await readUnchanged(file, context);
  const upload = evidenceUpload(file);
  if (file.contentType.startsWith("video/") && !file.prepared) throw new Error(`Video evidence '${file.title}' was not prepared; retry the same update`);
  if (!file.prepared || file.prepared.transform === "none") {
    if (sha256(source) !== upload.sha256) throw new Error(`Video evidence '${file.title}' no longer matches its validated digest; publish a new update with a new requestKey`);
    return { ...upload, bytes: source };
  }
  const bytes = await readBoundedFile(preparedVideoPath(context.cacheDirectory, file.prepared)).catch(() => undefined);
  if (!bytes || sha256(bytes) !== upload.sha256) {
    throw new Error(`Prepared video for '${file.title}' is missing or changed since validation; it is not re-encoded under the same request. Publish a new update with a new requestKey`);
  }
  return { ...upload, bytes };
}

export function issueUpdateBody(body: string, evidence: EvidenceReceipt[]): string {
  if (!evidence.length) return body;
  const media = evidence.map((item) => {
    if (!item.assetUrl || !item.attachmentId) throw new Error("Evidence delivery is incomplete");
    const title = item.title.replace(/[\\[\]\r\n]/g, " ");
    const link = `[${title}](<${item.assetUrl}>)`;
    return item.contentType.startsWith("image/") ? `!${link}` : link;
  });
  return `${body}\n\n### Evidence\n\n${media.join("\n\n")}`;
}
