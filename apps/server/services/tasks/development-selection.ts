import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { RemoteTask, RemoteTaskResource } from "../../../../generated/prisma/client.ts";
import { assertFinalizationPath } from "./finalization-resources.ts";
import { retainedDevelopment, type RetainedDevelopmentReader } from "./retained-development.ts";

/** Small existing local proofs only. Never inspect endpoint credentials,
 * archives, provider data or processes while selecting development compute. */
export const readDevelopmentJson: RetainedDevelopmentReader = async (file, expectedHash) => {
  await assertFinalizationPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    const owned = (value: typeof before) => value.isFile() && value.uid === process.getuid?.() && value.nlink === 1
      && [0o400, 0o600, 0o700].includes(value.mode & 0o7777) && value.size <= 1024 * 1024;
    if (!owned(before)) throw new Error("Retained development proof must be a bounded private owned file");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Retained development proof changed while reading");
      offset += result.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(file);
    if (!owned(after) || !owned(named) || [after, named].some(value => value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size
      || value.mode !== before.mode || value.mtimeMs !== before.mtimeMs || value.ctimeMs !== before.ctimeMs)) throw new Error("Retained development proof identity changed");
    if (expectedHash && createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("Retained development proof bytes changed");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("Retained development proof is not valid JSON"); }
  } finally { await handle.close(); }
};

export async function retainedDevelopmentIds(task: RemoteTask, resources: RemoteTaskResource[], read = readDevelopmentJson) {
  return new Set((await retainedDevelopment({ ...task, resources }, read)).resourceIds);
}
