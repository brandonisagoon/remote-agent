import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const EvidenceReceipt = z.object({
  path: z.string(), title: z.string(), contentType: z.string(), sha256: z.string(), size: z.number(),
  assetUrl: z.string().optional(), attachmentId: z.string().optional(),
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
    const receipt: EvidenceReceipt = { ...input, contentType: mediaType(bytes), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    return { bytes, receipt };
  } finally { await handle.close(); }
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
