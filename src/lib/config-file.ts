import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import chokidar from "chokidar";

import {
  parseServiceFile,
  type ServiceFile,
} from "./config.ts";

export type ConfigDocument =
  | {
      path: string;
      revision: string;
      raw: string;
      valid: true;
      value: ServiceFile;
      error: null;
    }
  | {
      path: string;
      revision: string;
      raw: string;
      valid: false;
      value: null;
      error: string;
    };

function revision(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function readConfigDocument(file: string): ConfigDocument {
  const raw = readFileSync(file, "utf8");
  try {
    return {
      path: file,
      revision: revision(raw),
      raw,
      valid: true,
      value: parseServiceFile(JSON.parse(raw)),
      error: null,
    };
  } catch (error) {
    return {
      path: file,
      revision: revision(raw),
      raw,
      valid: false,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeConfigDocument(input: {
  file: string;
  expectedRevision: string;
  value: unknown;
}): ConfigDocument {
  const current = readConfigDocument(input.file);
  if (current.revision !== input.expectedRevision) {
    throw new Error("config changed on disk; reload before saving");
  }
  const value = parseServiceFile(input.value);
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = path.join(
    path.dirname(input.file),
    `.${path.basename(input.file)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, raw, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, input.file);
    chmodSync(input.file, 0o600);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
  return readConfigDocument(input.file);
}

export function watchConfigDocument(
  file: string,
  listener: (document: ConfigDocument) => void,
): () => Promise<void> {
  const watcher = chokidar.watch(file, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        listener(readConfigDocument(file));
      } catch (error) {
        listener({
          path: file,
          revision: "missing",
          raw: "",
          valid: false,
          value: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 75);
  };
  watcher.on("add", changed).on("change", changed).on("unlink", changed);
  return async () => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}
