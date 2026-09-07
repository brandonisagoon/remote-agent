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
  parseRepoConfig,
  parseServiceFile,
  REPO_CONFIG_FILE,
  type RepoConfig,
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

/** Atomic replace; mode 0o600 for the credential-bearing app config, 0o644
    for committed repo configs. */
function atomicWrite(file: string, raw: string, mode: number): void {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, raw, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    chmodSync(file, mode);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
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
  atomicWrite(input.file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  return readConfigDocument(input.file);
}

export type RepoConfigDocument =
  | {
      path: string;
      revision: string;
      raw: string;
      valid: true;
      value: RepoConfig;
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

const REPO_SCHEMA_URL =
  "https://raw.githubusercontent.com/brandonisagoon/remote-agent/main/remote-agent.repo-config.schema.json";

/** The repository's committed config as a document. A missing file is a
    VALID document holding the defaults (revision "absent") — adoption is
    gradual, and saving it creates the file. */
export function readRepoConfigDocument(root: string): RepoConfigDocument {
  const file = path.join(root, REPO_CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {
      path: file,
      revision: "absent",
      raw: "",
      valid: true,
      value: parseRepoConfig({}),
      error: null,
    };
  }
  try {
    return {
      path: file,
      revision: revision(raw),
      raw,
      valid: true,
      value: parseRepoConfig(JSON.parse(raw)),
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

export function writeRepoConfigDocument(input: {
  root: string;
  expectedRevision: string;
  value: unknown;
}): RepoConfigDocument {
  const current = readRepoConfigDocument(input.root);
  if (current.revision !== input.expectedRevision) {
    throw new Error("repository config changed on disk; reload before saving");
  }
  const { $schema: _ignored, ...rest } = parseRepoConfig(input.value);
  const body = { $schema: REPO_SCHEMA_URL, ...rest };
  atomicWrite(current.path, `${JSON.stringify(body, null, 2)}\n`, 0o644);
  return readRepoConfigDocument(input.root);
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
