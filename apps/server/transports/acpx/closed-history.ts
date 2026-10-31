import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentRuntimeSession } from "../../../../types/runtime/index.ts";

// Read only the persisted acpx.session.v1 identity and conversation projection.
// Nontext tool/media content remains opaque; none of it is executed or adopted.
const Content = z.object({ Text: z.string().optional() }).passthrough();
const Message = z.union([
  z.literal("Resume"),
  z.object({ User: z.object({ id: z.string(), content: z.array(Content) }) }),
  z.object({ Agent: z.object({ content: z.array(Content), tool_results: z.record(z.string(), z.unknown()) }) }),
]);
const Saved = z.object({ schema: z.literal("acpx.session.v1"), acpx_record_id: z.string().min(1), acp_session_id: z.string().min(1),
  cwd: z.string().min(1), agent_session_id: z.string().nullable().optional(), messages: z.array(Message), updated_at: z.string() });
const maximumBytes = 64 * 1024 * 1024;

/** The normal acpx store.load() creates its state directory and hides corrupt
 * records as undefined. Closed history must do neither, and needs no cwd. */
export async function readClosedSessionMessages(stateDir: string, session: AgentRuntimeSession): Promise<unknown[]> {
  if (!session.acpxRecordId || !session.acpxSessionId) throw new Error("Saved session history identity is unavailable");
  const directory = path.resolve(stateDir, "sessions"), file = path.join(directory, `${encodeURIComponent(session.acpxRecordId)}.json`);
  let bytes: Buffer;
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error("History directory is unavailable");
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await fd.stat();
      if (!before.isFile() || before.size > maximumBytes) throw new Error("History file exceeds its read bound");
      // Allocate and pread only the original bounded size. Concurrent growth
      // cannot extend this allocation/read; the final identity check refuses it.
      bytes = Buffer.alloc(before.size);
      for (let offset = 0; offset < bytes.length;) {
        const read = await fd.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        if (!read.bytesRead) throw new Error("History file was truncated");
        offset += read.bytesRead;
      }
      for (const after of [await fd.stat(), await lstat(file)]) if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new Error("History file changed during read");
      if (bytes.length !== before.size) throw new Error("History file was truncated");
    } finally { await fd.close(); }
  } catch { throw new Error("Saved session history is unavailable or changed during read"); }
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString()); } catch { throw new Error("Saved session history is corrupt"); }
  const parsed = Saved.safeParse(raw);
  if (!parsed.success) throw new Error("Saved session history is corrupt");
  const record = parsed.data;
  if (record.acpx_record_id !== session.acpxRecordId || record.acp_session_id !== session.acpxSessionId || record.cwd !== session.cwd
    || (record.agent_session_id ?? null) !== session.agentSessionId) throw new Error("Saved session history belongs to a different session");
  return record.messages;
}
