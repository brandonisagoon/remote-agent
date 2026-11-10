import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RepositoryConfig } from "../../../../lib/config.ts";
import { readToolingSourceAt } from "../../../../lib/tooling-source.ts";
import type { ToolingReleaseManifest } from "../../../../types/tooling-release.ts";
import { assertServerDataContracts } from "../../../../lib/server-data-contracts.ts";

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

export const RELEASE_MANIFEST_FILE = ".remote-agent-release.json";
export const CAPABILITY_MANIFEST_FILE = ".remote-agent-capabilities.json";
export const RELEASE_LOCKFILE = "bun.lock";
/** Operation protocol versions this server implements. */
// Protocol 3 adds configure-attempt observation and PID-independent callback
// identity. Existing protocol-1/2 operations and readers remain executable.
export const SERVER_TOOLING_PROTOCOL = { min: 1, max: 3 } as const;

const FormatVersion = z.number().int().min(1).max(1000);
export const ToolingReleaseManifestSchema = z.strictObject({
  contract: z.literal("remote-agent.tooling-release/v1"),
  serverContracts: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}\/v[1-9][0-9]{0,2}$/)).max(32).refine(values => new Set(values).size === values.length).optional(),
  serverProtocol: z.strictObject({ min: z.number().int().min(1), max: z.number().int().min(1) }).refine(value => value.min <= value.max, "serverProtocol.min must not exceed max"),
  stateFormats: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63}){1,3}$/), z.strictObject({
    read: z.array(FormatVersion).min(1).max(32).refine(values => new Set(values).size === values.length, "read versions must be unique"),
    write: FormatVersion,
    /** Every version this release may persist, including explicit migrations
     * and compatible saves of older state. Omitted means exactly [write]. */
    writeVersions: z.array(FormatVersion).min(1).max(32).refine(values => new Set(values).size === values.length, "writeVersions must be unique").optional(),
    preservesUnknown: z.boolean(),
  }).refine(value => value.read.includes(value.write), "Every declared writer format must also be readable")
    .refine(value => !value.writeVersions || value.writeVersions.includes(value.write), "writeVersions must include the default write version")
    .refine(value => (value.writeVersions ?? [value.write]).every(version => value.read.includes(version)), "Every writable version must also be readable")),
});

const ProcessId = z.number().int().positive();
const LockOwner = z.strictObject({ version: z.literal(1), pid: ProcessId, attempt: z.string().uuid(), startedAt: z.string() });

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Exclusive preparation lock with an owner record. An abandoned lock is
 * recovered only when its recorded process provably no longer exists; a live,
 * reused or unreadable owner is never stolen. Recovered locks are retained as
 * evidence beside the checkout rather than deleted. */
export function acquirePreparationLock(destination: string, isAlive = processExists): () => void {
  const lock = `${destination}.lock`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = { version: 1 as const, pid: process.pid, attempt: randomUUID(), startedAt: new Date().toISOString() };
    let created = false;
    try {
      mkdirSync(lock, { mode: 0o700 });
      created = true;
      writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
      return () => {
        const current = readFileSync(path.join(lock, "owner.json"), "utf8");
        if (LockOwner.parse(JSON.parse(current)).attempt !== owner.attempt) throw new Error(`Tooling preparation lock ${lock} changed owner`);
        rmSync(lock, { recursive: true });
      };
    } catch (error) {
      if (created) { rmSync(lock, { recursive: true, force: true }); throw error; }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const busy = new Error(`Tooling preparation lock exists: ${lock}. Its owner is live or unproven; reconcile the prior attempt before retrying.`);
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy;
    let raw: string, recorded: z.infer<typeof LockOwner>;
    try { raw = readFileSync(path.join(lock, "owner.json"), "utf8"); recorded = LockOwner.parse(JSON.parse(raw)); }
    catch { throw busy; }
    if (isAlive(recorded.pid)) throw busy;
    // One recoverer owns the abandoned directory until it moves it aside.
    const recovering = path.join(lock, "recovering");
    try { mkdirSync(recovering, { mode: 0o700 }); } catch { throw busy; }
    try {
      if (readFileSync(path.join(lock, "owner.json"), "utf8") !== raw || isAlive(recorded.pid)) throw busy;
      renameSync(lock, `${destination}.lock-abandoned-${recorded.attempt}`);
    } catch (error) { rmSync(recovering, { recursive: true, force: true }); throw error; }
  }
  throw new Error(`Tooling preparation lock ${lock} was acquired by another attempt during recovery`);
}

function samePath(candidate: string, real: string): boolean {
  try { return realpathSync(candidate) === real; } catch { return false; }
}

/** Lock the registered linked worktree against `git worktree prune`. A legacy
 * checkout that is not a registered worktree is left as-is (`required: false`). */
async function lockWorktree(root: string, destination: string, revision: string, required = true) {
  const listing = await run(["git", "worktree", "list", "--porcelain"], root);
  const real = realpathSync(destination);
  const entry = listing.split(/\n\n+/).find(block => {
    const line = block.split("\n").find(value => value.startsWith("worktree "));
    return line !== undefined && samePath(line.slice("worktree ".length), real);
  });
  if (!entry) {
    if (!required) return;
    throw new Error(`Prepared tooling checkout ${destination} is not a registered worktree of ${root}`);
  }
  if (!entry.split("\n").some(line => line === "locked" || line.startsWith("locked "))) {
    await run(["git", "worktree", "lock", "--reason", `remote-agent tooling release ${revision}`, destination], root);
  }
}

const preparing = new Map<string, Promise<string>>();

/** One immutable source checkout per revision. Dependencies are installed in
 * the tooling checkout, never added to the product. An abandoned lock is
 * recovered only when its owner process provably exited. */
export async function prepareTooling(repository: RepositoryConfig, installRoot: string): Promise<string> {
  if (!repository.tooling) return repository.root;
  const source = repository.tooling;
  const destination = path.join(installRoot, "tooling", repository.id, source.revision);
  const existing = preparing.get(destination);
  if (existing) return existing;
  const operation = (async () => {
    mkdirSync(path.dirname(destination), { recursive: true });
    const release = acquirePreparationLock(destination);
    try {
      if (!existsSync(destination)) {
        await run(["git", "worktree", "add", "--detach", destination, source.revision], source.root);
      }
      const actual = await run(["git", "rev-parse", "HEAD"], destination);
      if (actual !== source.revision) throw new Error("Tooling checkout revision does not match its receipt");
      if (await run(["git", "status", "--porcelain", "--untracked-files=normal"], destination)) throw new Error("Pinned tooling checkout has local changes; preserve and reconcile them before reuse");
      await lockWorktree(source.root, destination, source.revision, false);
      if (!existsSync(`${destination}.ready`)) {
        await run([process.execPath, "install", "--frozen-lockfile"], destination);
        writeFileSync(`${destination}.ready`, `${source.revision}\n`, { mode: 0o600 });
      } else if (readFileSync(`${destination}.ready`, "utf8").trim() !== source.revision) {
        throw new Error("Tooling installation receipt does not match its revision");
      }
      return destination;
    } finally { release(); }
  })();
  preparing.set(destination, operation);
  try { return await operation; } finally { preparing.delete(destination); }
}

export interface PreparedToolingRelease {
  repositoryId: string;
  revision: string;
  tree: string;
  policyBlob: string;
  checkout: string;
  manifest: ToolingReleaseManifest;
  lockfileDigest: string;
  bunVersion: string;
}

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const InstallReceipt = z.strictObject({ version: z.literal(1), revision: z.string(), tree: z.string(), lockfileDigest: Sha256, bunVersion: z.string().min(1), packagesDigest: Sha256 });
const installReceiptFile = (checkout: string) => `${checkout}.install.json`;

/** Digest of every installed package manifest (including scoped packages).
 * This detects replaced or edited dependencies without hashing whole trees. */
export function installedPackagesDigest(checkout: string): string {
  const root = path.join(checkout, "node_modules");
  const hash = createHash("sha256");
  if (!existsSync(root)) return hash.update("no-node-modules").digest("hex");
  const entries: string[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith(".")) continue;
      const full = path.join(directory, name);
      if (!prefix && name.startsWith("@")) { visit(full, `${name}/`); continue; }
      if (entries.length >= 20_000) throw new Error("Installed tooling dependency inventory exceeds its bound");
      const manifest = path.join(full, "package.json");
      entries.push(`${prefix}${name}\0${existsSync(manifest) ? createHash("sha256").update(readFileSync(manifest)).digest("hex") : "-"}`);
    }
  };
  visit(root, "");
  return hash.update(entries.join("\n")).digest("hex");
}

async function committedRegularBlob(root: string, revision: string, file: string): Promise<string | null> {
  const entry = await run(["git", "ls-tree", revision, "--", file], root);
  if (!entry) return null;
  const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t/.exec(entry);
  if (!match) throw new Error(`${file} must be a committed regular file at ${revision}`);
  return match[1]!;
}

async function blobBytes(root: string, blob: string): Promise<Buffer> {
  const child = Bun.spawn(["git", "cat-file", "blob", blob], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [bytes, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
  if (code !== 0) throw new Error(`Could not read committed blob ${blob}`);
  return Buffer.from(bytes);
}

export interface PrepareToolingReleaseInput {
  repositoryId: string;
  toolingRoot: string;
  installRoot: string;
  revision: string;
}

/** Validate the exact committed candidate, then prepare (or re-verify) its
 * locked immutable checkout. Never changes any selection; a failure leaves
 * only an unused checkout or recoverable lock behind. */
const preparingReleases = new Map<string, Promise<PreparedToolingRelease>>();
type Install = (checkout: string) => Promise<void>;
const frozenInstall: Install = async (checkout) => { await run([process.execPath, "install", "--frozen-lockfile"], checkout); };

export async function prepareToolingRelease(input: PrepareToolingReleaseInput, install: Install = frozenInstall): Promise<PreparedToolingRelease> {
  const key = JSON.stringify([input.repositoryId, input.toolingRoot, input.installRoot, input.revision]);
  const existing = preparingReleases.get(key);
  if (existing) return existing;
  const operation = prepareToolingReleaseOnce(input, install);
  preparingReleases.set(key, operation);
  try { return await operation; } finally { preparingReleases.delete(key); }
}

async function prepareToolingReleaseOnce(input: PrepareToolingReleaseInput, install: Install): Promise<PreparedToolingRelease> {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(input.repositoryId)) throw new Error("Invalid tooling repository ID");
  const source = readToolingSourceAt(input.toolingRoot, input.revision);
  const manifestBlob = await committedRegularBlob(input.toolingRoot, source.revision, RELEASE_MANIFEST_FILE);
  if (!manifestBlob) throw new Error(`Tooling revision ${source.revision} has no ${RELEASE_MANIFEST_FILE}; legacy releases cannot be activated`);
  let manifest: ToolingReleaseManifest;
  try { manifest = ToolingReleaseManifestSchema.parse(JSON.parse((await blobBytes(input.toolingRoot, manifestBlob)).toString("utf8"))); }
  catch (error) { throw new Error(`Invalid ${RELEASE_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`); }
  assertServerDataContracts(manifest.serverContracts);
  if (manifest.serverProtocol.max < SERVER_TOOLING_PROTOCOL.min || manifest.serverProtocol.min > SERVER_TOOLING_PROTOCOL.max) {
    throw new Error(`Tooling revision ${source.revision} supports operation protocol ${manifest.serverProtocol.min}-${manifest.serverProtocol.max}; this server supports ${SERVER_TOOLING_PROTOCOL.min}-${SERVER_TOOLING_PROTOCOL.max}`);
  }
  const capabilitiesBlob = await committedRegularBlob(input.toolingRoot, source.revision, CAPABILITY_MANIFEST_FILE);
  if (!capabilitiesBlob) throw new Error(`Tooling revision ${source.revision} has no ${CAPABILITY_MANIFEST_FILE}`);
  const capabilities = z.object({ capabilities: z.record(z.string(), z.object({ instructions: z.string().min(1), adapter: z.string().min(1) }).passthrough()) }).passthrough()
    .parse(JSON.parse((await blobBytes(input.toolingRoot, capabilitiesBlob)).toString("utf8")));
  for (const [name, entry] of Object.entries(capabilities.capabilities)) {
    for (const file of [entry.instructions, entry.adapter]) {
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error(`Capability ${name} path escapes its checkout: ${file}`);
      if (!(await committedRegularBlob(input.toolingRoot, source.revision, file))) throw new Error(`Capability ${name} is missing committed file ${file}`);
    }
  }
  const lockBlob = await committedRegularBlob(input.toolingRoot, source.revision, RELEASE_LOCKFILE);
  if (!lockBlob) throw new Error(`Tooling revision ${source.revision} has no committed ${RELEASE_LOCKFILE}`);
  const lockfileDigest = createHash("sha256").update(await blobBytes(input.toolingRoot, lockBlob)).digest("hex");

  const destination = path.join(input.installRoot, "tooling", input.repositoryId, source.revision);
  mkdirSync(path.dirname(destination), { recursive: true });
  const release = acquirePreparationLock(destination);
  try {
    if (!existsSync(destination)) await run(["git", "worktree", "add", "--detach", destination, source.revision], input.toolingRoot);
    const checkout = realpathSync(destination);
    await lockWorktree(input.toolingRoot, checkout, source.revision);
    const assertClean = async () => {
      if (await run(["git", "rev-parse", "HEAD"], checkout) !== source.revision || await run(["git", "rev-parse", "HEAD^{tree}"], checkout) !== source.tree) throw new Error("Prepared tooling checkout does not match its exact commit and tree");
      if (await run(["git", "status", "--porcelain", "--untracked-files=normal"], checkout)) throw new Error("Prepared tooling checkout has local changes; preserve and reconcile them before activation");
    };
    await assertClean();
    let receipt = readInstallReceipt(checkout);
    if (!receipt) {
      await install(checkout);
      await assertClean();
      receipt = { version: 1, revision: source.revision, tree: source.tree, lockfileDigest, bunVersion: Bun.version, packagesDigest: installedPackagesDigest(checkout) };
      const temporary = `${installReceiptFile(checkout)}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, installReceiptFile(checkout));
      if (!existsSync(`${checkout}.ready`)) writeFileSync(`${checkout}.ready`, `${source.revision}\n`, { mode: 0o600 });
    }
    if (receipt.revision !== source.revision || receipt.tree !== source.tree || receipt.lockfileDigest !== lockfileDigest) throw new Error("Tooling install receipt does not match this exact release");
    if (installedPackagesDigest(checkout) !== receipt.packagesDigest) throw new Error("Installed tooling dependencies changed after their install receipt");
    return { repositoryId: input.repositoryId, revision: source.revision, tree: source.tree, policyBlob: source.policyBlob, checkout, manifest, lockfileDigest, bunVersion: receipt.bunVersion };
  } finally { release(); }
}

function readInstallReceipt(checkout: string): z.infer<typeof InstallReceipt> | null {
  const file = installReceiptFile(checkout);
  if (!existsSync(file)) return null;
  try { return InstallReceipt.parse(JSON.parse(readFileSync(file, "utf8"))); }
  catch { throw new Error(`Tooling install receipt ${file} is unreadable; reconcile it before reuse`); }
}

/** Read-only integrity check for a recorded release; never installs. */
export async function verifyPreparedToolingRelease(release: Pick<PreparedToolingRelease, "revision" | "tree" | "checkout" | "lockfileDigest">): Promise<void> {
  if (realpathSync(release.checkout) !== release.checkout) throw new Error("Prepared tooling checkout path changed");
  if (await run(["git", "rev-parse", "HEAD"], release.checkout) !== release.revision || await run(["git", "rev-parse", "HEAD^{tree}"], release.checkout) !== release.tree) throw new Error("Prepared tooling checkout does not match its exact commit and tree");
  if (await run(["git", "status", "--porcelain", "--untracked-files=normal"], release.checkout)) throw new Error("Prepared tooling checkout has local changes");
  const receipt = readInstallReceipt(release.checkout);
  if (!receipt || receipt.revision !== release.revision || receipt.tree !== release.tree || receipt.lockfileDigest !== release.lockfileDigest) throw new Error("Tooling install receipt is missing or does not match this release");
  if (installedPackagesDigest(release.checkout) !== receipt.packagesDigest) throw new Error("Installed tooling dependencies changed after their install receipt");
}
