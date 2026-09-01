import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ServerConfig } from "../../config.ts";

function ownerPath(config: ServerConfig): string {
  const hash = createHash("sha256")
    .update(config.databaseUrl)
    .update("\0")
    .update(config.acpxStateDir)
    .digest("hex")
    .slice(0, 24);
  return path.join(tmpdir(), `remote-agent-owner-${hash}.lock`);
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireRuntimeOwnership(
  config: ServerConfig,
): { release(): void } {
  const file = ownerPath(config);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      closeSync(descriptor);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            const owner = Number(readFileSync(file, "utf8").trim());
            if (owner === process.pid) unlinkSync(file);
          } catch {
            // The file may already have been cleaned after an abnormal exit.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(file, "utf8").trim());
      } catch {
        // Treat unreadable state as stale and retry once.
      }
      if (Number.isInteger(owner) && processIsLive(owner)) {
        throw new Error(
          `another Remote Agent process (${owner}) owns this database/acpx state`,
        );
      }
      unlinkSync(file);
    }
  }
  throw new Error("failed to acquire Remote Agent runtime ownership");
}
