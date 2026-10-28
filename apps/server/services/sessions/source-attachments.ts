import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { downloadLinearUpload, issueContainsUpload, linearUploadUrl } from "../../integrations/linear/downloads.ts";
import { assertTaskAutomationAllowed } from "../tasks/control.ts";
import { linkedSourceIssue } from "./questions.ts";

const client = { source: linkedSourceIssue, contains: issueContainsUpload, download: downloadLinearUpload };
const extensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "application/pdf": "pdf", "text/plain": "txt",
};

/** Files live in the server's private session cache, never an agent-supplied
 * destination or tracked product path. The credential stays in this process. */
export async function downloadSourceAttachment(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; url: string }, delivery = client) {
  const url = linearUploadUrl(input.url);
  const { session, config, issue } = await delivery.source(input);
  await assertTaskAutomationAllowed(input.prisma, session.cwd);
  if (!(await delivery.contains(config.linearApiKey, issue.id, issue.description, url))) {
    throw new Error("Attachment is not linked from this session's source issue or comments");
  }
  const { bytes, contentType } = await delivery.download(config.linearApiKey, url);
  await assertTaskAutomationAllowed(input.prisma, session.cwd);
  const current = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: session.id } });
  if (current.status === "closed") throw new Error("Session is closed");
  const sessionKey = createHash("sha256").update(session.id).digest("hex");
  const root = path.join(config.acpxStateDir, "source-attachments", sessionKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, "download-"));
  const file = path.join(directory, `attachment.${extensions[contentType] ?? "bin"}`);
  try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { issueIdentifier: issue.identifier, url, path: file, contentType, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}
