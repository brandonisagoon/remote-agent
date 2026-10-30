import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RemoteTask } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { resolveToolingCompatibility } from "./tooling-compatibility.ts";

const Absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const CleanupObserverCapability = z.object({ version: z.literal(1), source: z.literal("configured-host"),
  checkout: Absolute, revision: z.string().regex(/^[a-f0-9]{40}$/), adapter: Absolute, adapterSha256: Sha }).strict();
export type CleanupObserverCapability = z.infer<typeof CleanupObserverCapability>;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, file: string) => file !== root && file.startsWith(`${root}${path.sep}`);
const failure = () => new Error("The pinned cleanup resource observer failed; resource absence is unverified");

function bounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const result = (async () => {
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength; if (length > limit) throw failure();
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, length).toString("utf8");
    } finally { reader.releaseLock(); }
  })();
  return { result, cancel: () => reader.cancel().catch(() => {}) };
}

async function execute(args: string[], options: { cwd: string; input?: string; timeoutMs: number; env?: Record<string, string> }) {
  if (!["darwin", "linux"].includes(process.platform)) throw failure();
  let complete: { code: number } | undefined;
  // A dedicated session leader outlives the command and its inherited pipes.
  // Only that helper signals its own group; no saved PID/group is rediscovered.
  const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "cleanup-observer-process.ts"), String(options.timeoutMs), ...args], {
    detached: true, cwd: options.cwd, env: options.env, stdin: options.input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
    ipc(message, process) {
      if (message && Object.keys(message).sort().join(",") === "code,version" && message.version === 1 && Number.isInteger(message.code)) complete = { code: message.code };
      try { process.send({ finish: true }); } catch { /* The helper may have reached its own deadline. */ }
    },
  });
  const stdout = bounded(child.stdout, 8 * 1024 * 1024), stderr = bounded(child.stderr, 64 * 1024);
  let timedOut = false;
  const cancel = () => {
    try { child.send({ finish: true }); } catch { /* The owned helper already exited. */ }
    void stdout.cancel(); void stderr.cancel();
  };
  let rejectDeadline!: (reason: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { timedOut = true; cancel(); rejectDeadline(failure()); }, options.timeoutMs);
  // Start readers before writing stdin. Cancellation does not wait for EOF
  // from a provider child and never returns a successful partial response.
  const output = Promise.all([stdout.result, stderr.result, child.exited]);
  output.catch(cancel);
  try {
    const operation = (async () => {
      if (options.input !== undefined && child.stdin && typeof child.stdin !== "number") { await child.stdin.write(options.input); await child.stdin.end(); }
      return await output;
    })();
    const [out, err] = await Promise.race([operation, deadline]);
    if (timedOut || !complete || complete.code !== 0 || err.trim()) throw failure();
    return out;
  } catch { throw failure(); }
  finally {
    cancel();
    await child.exited.catch(() => {});
    await output.catch(() => {});
    clearTimeout(timer);
  }
}

/** A server-configured committed capability is distinct from the task's old
 * policy pin. Resource metadata never selects an executable or Git revision. */
async function checkedCapability(capability: CleanupObserverCapability) {
  const value = CleanupObserverCapability.parse(capability);
  const root = await lstat(value.checkout), file = await lstat(value.adapter);
  if (!root.isDirectory() || root.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024
    || root.uid !== process.getuid?.() || file.uid !== process.getuid?.() || root.mode & 0o022 || file.mode & 0o022
    || await realpath(value.checkout) !== value.checkout || await realpath(value.adapter) !== value.adapter || !inside(value.checkout, value.adapter)) throw failure();
  const git = (...args: string[]) => execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: value.checkout, timeoutMs: 10_000 });
  if ((await git("rev-parse", "HEAD")).trim() !== value.revision || (await git("status", "--porcelain=v1", "--untracked-files=normal")).trim()) throw failure();
  const manifest = JSON.parse(await git("show", `${value.revision}:.remote-agent-capabilities.json`));
  const relative = path.relative(value.checkout, value.adapter);
  const declared = z.object({ version: z.literal(1), capabilities: z.object({ cleanup: z.object({ adapter: z.string() }) }) }).parse(manifest);
  if (declared.capabilities.cleanup.adapter !== relative) throw failure();
  const mode = (await git("ls-tree", value.revision, "--", relative)).trim();
  if (!/^100(?:644|755) blob /.test(mode)) throw failure();
  const committed = await git("show", `${value.revision}:${relative}`), actual = await readFile(value.adapter);
  if (hash(Buffer.from(committed)) !== value.adapterSha256 || hash(actual) !== value.adapterSha256) throw failure();
  return value;
}

export async function verifyCleanupObserver(capability: CleanupObserverCapability) {
  try { return await checkedCapability(capability); } catch { throw failure(); }
}

export async function resolveCleanupObserver(input: { task: RemoteTask; config: ServerConfig }, resolve = resolveToolingCompatibility) {
  if (!input.task.worktreePath) throw failure();
  const selected = await resolve({ task: input.task, repository: getRepositoryConfig(input.config, input.task.repositoryId), installRoot: input.config.installRoot,
    capability: "cleanup", worktreePath: input.task.worktreePath, seed: "Read-only exact resource observation", ...(input.task.pinnedToolingRoot ? { pinnedToolingRoot: input.task.pinnedToolingRoot } : {}) });
  const receipt = selected.receipt;
  if (receipt.capability !== "cleanup" || receipt.source !== "configured-host" || !receipt.adapter || receipt.taskToolingRevision !== input.task.toolingRevision) throw failure();
  const value = CleanupObserverCapability.parse({ version: 1, source: receipt.source, checkout: receipt.checkout, revision: receipt.capabilityRevision,
    adapter: receipt.adapter, adapterSha256: hash(await readFile(receipt.adapter)) });
  if (value.checkout === input.task.worktreePath || inside(input.task.worktreePath, value.checkout)) throw failure();
  return verifyCleanupObserver(value);
}

/** Private stdin and bounded JSON output only. The CLI action must use the
 * tooling's read-only inspectors; no control socket or primary-session identity
 * is inherited, and calling ordinary reconciliation is not this protocol. */
export async function runCleanupResourceObserver(input: { capability: CleanupObserverCapability; request: unknown; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw failure();
  const bytes = JSON.stringify(input.request);
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw failure();
  const capability = await verifyCleanupObserver(input.capability);
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "USER", "CLOUDFLARE_API_TOKEN", "DRAFTED_CLOUDFLARE_CREDENTIALS"]) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  const output = await execute([process.execPath, "--no-env-file", capability.adapter, "cleanup", "observe-resource"], { cwd: capability.checkout, input: bytes, timeoutMs, env });
  // Revalidate the code identity after the child finishes. An interrupted or
  // changed observer can never leave a successful physical-proof response.
  await verifyCleanupObserver(capability);
  try { return JSON.parse(output) as unknown; } catch { throw failure(); }
}
