import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RemoteTask } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { CleanupObservationContracts, resolveToolingCompatibility } from "./tooling-compatibility.ts";
import { CleanupObserverBatchInput } from "./cleanup-observer-schema.ts";
import { CleanupObserverError, observerFailureEnvelope, type CleanupObserverCode } from "./cleanup-observer-diagnostics.ts";

const Absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && path.normalize(value) === value);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const CleanupObserverCapability = z.object({ version: z.literal(1), source: z.literal("configured-host"),
  checkout: Absolute, revision: z.string().regex(/^[a-f0-9]{40}$/), adapter: Absolute, adapterSha256: Sha }).strict();
export type CleanupObserverCapability = z.infer<typeof CleanupObserverCapability>;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, file: string) => file !== root && file.startsWith(`${root}${path.sep}`);
const failure = (code: CleanupObserverCode = "OBSERVER_CAPABILITY") => new CleanupObserverError(code);

function bounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const result = (async () => {
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength; if (length > limit) throw failure("OBSERVER_OUTPUT_LIMIT");
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, length).toString("utf8");
    } finally { reader.releaseLock(); }
  })();
  return { result, cancel: () => reader.cancel().catch(() => {}) };
}

async function waitForOwnedGroupExit(group: number) {
  const deadline = Date.now() + 1000;
  while (true) {
    // The helper has already killed its group. This is observation only:
    // never signal a numeric group after its leader could have been reaped.
    const current = Bun.spawnSync(["/bin/ps", "-axo", "pgid="], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 250, maxBuffer: 1024 * 1024 });
    if (current.exitCode !== 0 || current.stderr.length || current.stdout.length > 1024 * 1024) throw failure("OBSERVER_GROUP");
    if (!current.stdout.toString().split("\n").some(line => Number(line.trim()) === group)) return;
    if (Date.now() >= deadline) throw failure("OBSERVER_GROUP");
    await Bun.sleep(10);
  }
}

export async function executeOwnedObserver(args: string[], options: { cwd: string; input?: string; timeoutMs: number; env?: Record<string, string>; failureRequest?: unknown }) {
  if (!["darwin", "linux"].includes(process.platform)) throw failure("OBSERVER_TRANSPORT");
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
  const timer = setTimeout(() => { timedOut = true; cancel(); rejectDeadline(failure("OBSERVER_TIMEOUT")); }, options.timeoutMs);
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
    if (timedOut) throw failure("OBSERVER_TIMEOUT");
    if (!complete) throw failure("OBSERVER_TRANSPORT");
    if (complete.code !== 0) throw observerFailureEnvelope(err, options.failureRequest) ?? failure("OBSERVER_EXIT");
    // Even a valid failure envelope on a successful exit is unexpected stderr,
    // never a successful response or a resource-scoped diagnostic.
    if (err.trim()) throw failure("OBSERVER_STDERR");
    return out;
  } catch (error) { throw error instanceof CleanupObserverError ? error : failure("OBSERVER_TRANSPORT"); }
  finally {
    cancel();
    try {
      await child.exited.catch(() => {});
      await output.catch(() => {});
      try { await waitForOwnedGroupExit(child.pid); } catch { throw failure("OBSERVER_GROUP"); }
    } finally { clearTimeout(timer); }
    if (timedOut) throw failure("OBSERVER_TIMEOUT");
  }
}

/** A server-configured committed capability is distinct from the task's old
 * policy pin. Resource metadata never selects an executable or Git revision. */
async function checkedCapability(capability: CleanupObserverCapability, retainedPreview = false) {
  const value = CleanupObserverCapability.parse(capability);
  const root = await lstat(value.checkout), file = await lstat(value.adapter);
  if (!root.isDirectory() || root.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024
    || root.uid !== process.getuid?.() || file.uid !== process.getuid?.() || root.mode & 0o022 || file.mode & 0o022
    || await realpath(value.checkout) !== value.checkout || await realpath(value.adapter) !== value.adapter || !inside(value.checkout, value.adapter)) throw failure();
  const git = (...args: string[]) => executeOwnedObserver(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: value.checkout, timeoutMs: 10_000 });
  if ((await git("rev-parse", "HEAD")).trim() !== value.revision || (await git("status", "--porcelain=v1", "--untracked-files=normal")).trim()) throw failure();
  const manifest = JSON.parse(await git("show", `${value.revision}:.remote-agent-capabilities.json`));
  const relative = path.relative(value.checkout, value.adapter);
  const declared = z.object({ version: z.literal(1), capabilities: z.object({ cleanup: z.object({ adapter: z.string() }) }) }).parse(manifest);
  if (declared.capabilities.cleanup.adapter !== relative) throw failure();
  if (retainedPreview) {
    const contracts = CleanupObservationContracts.safeParse(manifest.capabilities?.cleanup?.observationContracts);
    if (!contracts.success || !contracts.data.includes("retained-preview-inputs/v1")) throw failure("OBSERVER_COMPATIBILITY");
  }
  const mode = (await git("ls-tree", value.revision, "--", relative)).trim();
  if (!/^100(?:644|755) blob /.test(mode)) throw failure();
  const committed = await git("show", `${value.revision}:${relative}`), actual = await readFile(value.adapter);
  if (hash(Buffer.from(committed)) !== value.adapterSha256 || hash(actual) !== value.adapterSha256) throw failure();
  return value;
}

export async function verifyCleanupObserver(capability: CleanupObserverCapability, retainedPreview = false) {
  try { return await checkedCapability(capability, retainedPreview); } catch (error) { throw error instanceof CleanupObserverError ? error : failure(); }
}

export async function resolveCleanupObserver(input: { task: RemoteTask; config: ServerConfig }, resolve = resolveToolingCompatibility) {
  try {
    if (!input.task.worktreePath) throw failure();
    const selected = await resolve({ task: input.task, repository: getRepositoryConfig(input.config, input.task.repositoryId), installRoot: input.config.installRoot,
      capability: "cleanup", worktreePath: input.task.worktreePath, seed: "Read-only exact resource observation", ...(input.task.pinnedToolingRoot ? { pinnedToolingRoot: input.task.pinnedToolingRoot } : {}) });
    const receipt = selected.receipt;
    if (receipt.capability !== "cleanup" || receipt.source !== "configured-host" || !receipt.adapter || receipt.taskToolingRevision !== input.task.toolingRevision) throw failure();
    const value = CleanupObserverCapability.parse({ version: 1, source: receipt.source, checkout: receipt.checkout, revision: receipt.capabilityRevision,
      adapter: receipt.adapter, adapterSha256: hash(await readFile(receipt.adapter)) });
    if (value.checkout === input.task.worktreePath || inside(input.task.worktreePath, value.checkout)) throw failure();
    return await verifyCleanupObserver(value);
  } catch { throw failure(); }
}

/** Private stdin and bounded JSON output only. The CLI action must use the
 * tooling's read-only inspectors; no control socket or primary-session identity
 * is inherited, and calling ordinary reconciliation is not this protocol. */
export async function runCleanupResourceObserver(input: { capability: CleanupObserverCapability; request: unknown; timeoutMs?: number; compatibleCapability?: CleanupObserverCapability }) {
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw failure("OBSERVER_INPUT");
  let bytes: string, request: unknown;
  try {
    bytes = JSON.stringify(input.request);
    if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw failure("OBSERVER_INPUT");
    request = JSON.parse(bytes);
  } catch { throw failure("OBSERVER_INPUT"); }
  const original = await verifyCleanupObserver(input.capability);
  if (input.compatibleCapability) {
    const parsed = CleanupObserverBatchInput.safeParse(request);
    if (!parsed.success || parsed.data.stage !== "confirm" || !parsed.data.retainedPreviewInputs?.length
      || parsed.data.observations.some(item => !item.expectedTargets?.every(target => ["cloudflare-dns-record", "cloudflare-tunnel", "cloudflare-ingress-route", "local-ingress-route"].includes(target.kind)))) throw failure("OBSERVER_INPUT");
  }
  const capability = input.compatibleCapability ? await verifyCleanupObserver(input.compatibleCapability, true) : original;
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "USER", "CLOUDFLARE_API_TOKEN", "DRAFTED_CLOUDFLARE_CREDENTIALS"]) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  let output: string;
  try { output = await executeOwnedObserver([process.execPath, "--no-env-file", capability.adapter, "cleanup", "observe-resource"], { cwd: capability.checkout, input: bytes, timeoutMs, env, failureRequest: request }); }
  catch (error) { throw error instanceof CleanupObserverError ? error : failure("OBSERVER_TRANSPORT"); }
  // Revalidate the code identity after the child finishes. An interrupted or
  // changed observer can never leave a successful physical-proof response.
  await verifyCleanupObserver(capability, Boolean(input.compatibleCapability));
  if (input.compatibleCapability) await verifyCleanupObserver(original);
  try { return JSON.parse(output) as unknown; } catch { throw failure("OBSERVER_JSON"); }
}
