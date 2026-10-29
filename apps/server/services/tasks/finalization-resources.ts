import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, readdir, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { bunCommandClient } from "../../transports/command/index.ts";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Absolute = z.string().min(1).refine((value) => path.isAbsolute(value) && path.normalize(value) === value, "An exact absolute path is required");
const NodeIdentity = { dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), mode: z.number().int().nonnegative() };
const Relative = z.string().refine((value) => value === "." || !path.isAbsolute(value) && path.normalize(value) === value && !value.split(path.sep).includes(".."), "An exact relative inventory path is required");
const Entry = { path: Relative, ...NodeIdentity };
export const FinalizationInventoryEntry = z.discriminatedUnion("kind", [
  z.object({ ...Entry, kind: z.literal("directory") }).strict(),
  z.object({ ...Entry, kind: z.literal("file"), size: z.number().int().nonnegative(), sha256: Sha, dependencyResourceId: z.string().optional() }).strict(),
  z.object({ ...Entry, kind: z.literal("symlink"), link: z.string().min(1) }).strict(),
  z.object({ ...Entry, kind: z.literal("opaque"), dependencyResourceId: z.string().min(1) }).strict(),
]);
export type FinalizationInventoryEntry = z.infer<typeof FinalizationInventoryEntry>;
const Identity = { id: z.string().min(1), key: z.string().min(1), kind: z.string().min(1), purpose: z.enum(["development", "browser", "review"]), externalId: z.string().min(1), expiresAt: z.string().nullable(), identityDigest: Sha };
export const FinalizationResourcePlan = z.discriminatedUnion("disposition", [
  z.object({ ...Identity, disposition: z.literal("retain-reference"), reference: z.object({ deliveryId: z.string(), type: z.enum(["pull-request", "ci-run"]), repository: z.string(), number: z.number().int().positive(), reviewedHead: z.string(), mergeCommit: z.string().optional() }).strict() }).strict(),
  z.object({ ...Identity, disposition: z.literal("retire-owned"), dependencies: z.array(z.string()), target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("file"), path: Absolute, root: Absolute, size: z.number().int().nonnegative(), sha256: Sha, ...NodeIdentity }).strict(),
    z.object({ type: z.literal("tree"), path: Absolute, inventory: z.array(FinalizationInventoryEntry).min(1).max(250_000), sourcePaths: z.array(Absolute).min(1) }).strict(),
    z.object({ type: z.literal("profile"), path: Absolute, ownerFile: Absolute, ownerSha256: Sha, session: z.string(), toolingRoot: Absolute, dev: z.number().int().nonnegative().optional(), ino: z.number().int().nonnegative().optional() }).strict(),
    z.object({ type: z.literal("endpoint"), url: z.string().url(), pid: z.number().int().positive(), script: Absolute }).strict(),
  ]) }).strict(),
]);
export type FinalizationResourcePlan = z.infer<typeof FinalizationResourcePlan>;
export type FinalizationResourceRecord = { id: string; key: string; kind: string; purpose: string; externalId: string; state: string; expiresAt?: string | Date | null; metadata?: unknown };
type Delivery = { id: string; repository: string; pullRequest: number; url: string; reviewedHead: string; mergeCommit: string; ci: Array<{ runId: number; head: string }> };
export const ExternalResourceOwnership = z.object({ sourceCopyResourceId: z.string().min(1), ownedPaths: z.array(Absolute).max(1000) }).strict();
export type ExternalResourceOwnership = z.infer<typeof ExternalResourceOwnership>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function finalizationDigest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function finalizationResourceIdentity(resource: FinalizationResourceRecord) {
  const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata ?? {});
  const { observed: _observed, observedAt: _at, ...immutable } = metadata;
  const identity = { id: resource.id, key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId, expiresAt: resource.expiresAt instanceof Date ? resource.expiresAt.toISOString() : resource.expiresAt ?? null };
  return { ...identity, identityDigest: finalizationDigest({ ...identity, metadata: immutable }) };
}
function inside(root: string, item: string) { const relative = path.relative(root, item); return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); }
async function statOrMissing(file: string) { return lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }); }
/** Check every ancestor without following a symlink, including when the leaf has been removed. */
export async function assertFinalizationPath(file: string) {
  Absolute.parse(file);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await statOrMissing(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error("Finalization path contains a symlink");
    if (current !== file && !stat.isDirectory()) throw new Error("Finalization path ancestor changed");
  }
}
async function fileIdentity(file: string) {
  await assertFinalizationPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("Finalization requires an unshared regular file");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    const leaf = await lstat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || leaf.dev !== before.dev || leaf.ino !== before.ino || leaf.isSymbolicLink()) throw new Error("Finalization file changed during observation");
    return { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

export type ResourceObservation = {
  endpointAbsent(target: { url: string; pid: number; script: string }): Promise<void>;
  rootIdle(root: string): Promise<void>;
  browserAbsent(target: { session: string; toolingRoot: string }): Promise<void>;
};
async function processList() {
  const result = await bunCommandClient.run("ps", ["-axo", "pid=,command="]);
  if (!result.ok) throw new Error("Could not independently inspect task processes");
  return result.stdout.split("\n");
}
export const finalizationResourceObservation: ResourceObservation = {
  async endpointAbsent(target) {
    const url = new URL(target.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Only exact loopback fixture endpoints can be adopted");
    const lines = await processList();
    if (lines.some((line) => Number(line.trim().split(/\s+/, 1)[0]) === target.pid || line.includes(target.script))) throw new Error("Fixture process is present or its PID was reused; preserve it");
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: Number(url.port) });
      socket.once("connect", () => { socket.destroy(); reject(new Error("Fixture endpoint is still listening")); });
      socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(); else reject(new Error("Fixture endpoint absence could not be verified", { cause: error })); });
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Fixture endpoint inspection timed out")); });
    });
  },
  async rootIdle(root) {
    if ((await processList()).some((line) => line.includes(root))) throw new Error("A process still references the owned source root");
    if (!(await statOrMissing(root))) return;
    const result = await observationCommand(["lsof", "-nP", "+D", root, "-F", "pn"]);
    // lsof returns 1 with empty output when there are no open files. Diagnostics
    // or a killed/failed command are never treated as an absence proof.
    if (result.exitCode !== 1 || result.stdout.trim() || result.stderr.trim()) throw new Error("Source root has open files or could not be inspected");
  },
  async browserAbsent(target) {
    const executable = path.join(target.toolingRoot, "node_modules", ".bin", "agent-browser");
    const result = await observationCommand([executable, "--json", "session", "list"], { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", AGENT_BROWSER_NAMESPACE: "drafted" });
    if (result.exitCode !== 0) throw new Error("Browser session absence could not be verified");
    const sessions = z.object({ success: z.literal(true), data: z.object({ sessions: z.array(z.string()) }) }).parse(JSON.parse(result.stdout)).data.sessions;
    if (sessions.includes(target.session)) throw new Error("Task browser session is still running");
  },
};

async function observationCommand(command: string[], env?: Record<string, string>) {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(9); }, 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) throw new Error("Resource observation timed out; absence is unverified");
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
}

/** Adoption has explicit owner-authenticated path scope. No task-name pattern or
 * resource metadata can broaden it. Browser cookies remain an opaque child. */
async function inventory(root: string, allowed: string[], opaque: Map<string, string>, managedFiles: Map<string, string>) {
  await assertFinalizationPath(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || await realpath(root) !== root) throw new Error("Source root is not an exact directory");
  const entries: FinalizationInventoryEntry[] = [];
  async function visit(file: string) {
    if (entries.length >= 250_000) throw new Error("Owned source inventory exceeds its bound");
    const stat = await lstat(file);
    if (stat.dev !== rootStat.dev) throw new Error("Source inventory crosses a filesystem boundary");
    const common = { path: path.relative(root, file) || ".", dev: stat.dev, ino: stat.ino, mode: stat.mode };
    const scope = allowed.some((item) => item === file || inside(item, file));
    const ancestor = stat.isDirectory() && allowed.some((item) => inside(file, item));
    if (file !== root && !scope && !ancestor && !opaque.has(file)) throw new Error("Source root contains material outside the adopted ownership scope");
    if (opaque.has(file)) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Browser dependency directory changed");
      entries.push({ ...common, kind: "opaque", dependencyResourceId: opaque.get(file)! });
    } else if (stat.isSymbolicLink()) entries.push({ ...common, kind: "symlink", link: await readlink(file) });
    else if (stat.isFile()) entries.push({ path: common.path, kind: "file", ...await fileIdentity(file), ...(managedFiles.has(file) ? { dependencyResourceId: managedFiles.get(file)! } : {}) });
    else if (stat.isDirectory()) {
      entries.push({ ...common, kind: "directory" });
      const names = (await readdir(file)).sort();
      for (const name of names) await visit(path.join(file, name));
      if (JSON.stringify(names) !== JSON.stringify((await readdir(file)).sort())) throw new Error("Source inventory changed while being captured");
      const after = await lstat(file);
      if (after.ino !== stat.ino || after.dev !== stat.dev) throw new Error("Source directory identity changed");
    } else throw new Error("Source inventory contains an unsupported filesystem entry");
  }
  await visit(root);
  return entries;
}

async function assertIgnoredOwnership(sourcePaths: string[], ownedPaths: string[]) {
  for (const source of sourcePaths) {
    await assertFinalizationPath(source);
    const ignored = await bunCommandClient.run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: source });
    if (!ignored.ok) throw new Error("Ignored source material could not be inventoried");
    for (const relative of ignored.stdout.split("\0").filter(Boolean)) {
      Relative.parse(relative);
      const file = path.resolve(source, relative);
      if (!inside(source, file) || !ownedPaths.some((owned) => file === owned || inside(owned, file))) throw new Error("Ignored source material needs explicit adopted ownership");
    }
  }
}

export async function prepareFinalizationResources(input: { resources: FinalizationResourceRecord[]; taskId: string; sessionId: string; toolingRoot: string; sourcePaths: string[]; deliveries: Delivery[]; ownership: ExternalResourceOwnership }, observation = finalizationResourceObservation) {
  const ownership = ExternalResourceOwnership.parse(input.ownership);
  const resources = input.resources.filter((resource) => ["browser", "development", "review"].includes(resource.purpose));
  if (resources.length !== input.resources.length) throw new Error("Unknown resource purpose cannot be adopted for cleanup");
  if (new Set(resources.map((r) => r.id)).size !== resources.length || new Set(resources.map((r) => r.key)).size !== resources.length) throw new Error("Resource inventory has duplicate identities");
  const source = resources.find((resource) => resource.id === ownership.sourceCopyResourceId);
  if (!source || source.kind !== "source-copies" || source.state === "released") throw new Error("Adoption requires the exact retained source-copy resource");
  const root = Absolute.parse(source.externalId);
  await assertFinalizationPath(root);
  if (path.parse(root).root === root || input.sourcePaths.length === 0 || [...input.sourcePaths, ...ownership.ownedPaths].some((file) => !inside(root, Absolute.parse(file)))) throw new Error("Source ownership scope must stay strictly inside its recorded root");
  await assertIgnoredOwnership(input.sourcePaths, ownership.ownedPaths);
  await observation.rootIdle(root);
  const opaque = new Map<string, string>(), managedFiles = new Map<string, string>();
  const allowed = [...input.sourcePaths, ...ownership.ownedPaths];
  const plan: FinalizationResourcePlan[] = [];
  for (const resource of resources) {
    if (resource.id === source.id) continue;
    if (resource.state === "released") throw new Error("Initial external adoption requires retained resource identities");
    const common = finalizationResourceIdentity(resource);
    const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata ?? {});
    if (resource.kind === "pull-request" || resource.kind === "ci-run") {
      const delivery = input.deliveries.find((item) => resource.kind === "pull-request" ? resource.externalId === item.url : item.ci.some((run) => resource.externalId === `https://github.com/${item.repository}/actions/runs/${run.runId}` && run.head === item.reviewedHead));
      if (!delivery) throw new Error("Reference is not part of an independently verified external delivery");
      const number = resource.kind === "pull-request" ? delivery.pullRequest : delivery.ci.find((run) => resource.externalId === `https://github.com/${delivery.repository}/actions/runs/${run.runId}`)!.runId;
      plan.push(FinalizationResourcePlan.parse({ ...common, disposition: "retain-reference", reference: { deliveryId: delivery.id, type: resource.kind, repository: delivery.repository, number, reviewedHead: delivery.reviewedHead, ...(resource.kind === "pull-request" ? { mergeCommit: delivery.mergeCommit } : {}) } }));
    } else if (resource.kind === "evidence") {
      if (!inside(root, resource.externalId)) throw new Error("Legacy evidence is outside the adopted source root");
      const identity = await fileIdentity(resource.externalId);
      const size = metadata.size ?? metadata.byteSize;
      if (metadata.size !== undefined && metadata.byteSize !== undefined && metadata.size !== metadata.byteSize || size !== identity.size || metadata.sha256 !== identity.sha256) throw new Error("Recorded evidence bytes do not match their receipt");
      allowed.push(resource.externalId); managedFiles.set(resource.externalId, resource.id);
      plan.push(FinalizationResourcePlan.parse({ ...common, disposition: "retire-owned", dependencies: [], target: { type: "file", path: resource.externalId, root, ...identity } }));
    } else if (resource.kind === "browser-profile") {
      const meta = z.object({ namespace: z.literal("drafted"), ownerFile: Absolute, ownerSha256: Sha, session: z.string(), toolingRoot: Absolute }).passthrough().parse(metadata);
      // The executable comes from the original server-owned tooling pin. A
      // resource author cannot nominate arbitrary code for server execution.
      if (meta.toolingRoot !== Absolute.parse(input.toolingRoot) || await realpath(meta.toolingRoot) !== meta.toolingRoot) throw new Error("Browser inspection tooling does not match the original task pin");
      const expectedSession = resource.key === "browser-profile" && resource.purpose === "browser" ? input.taskId : resource.key === "browser-profile:review" && resource.purpose === "review" ? `${input.taskId}-review` : null;
      if (meta.session !== expectedSession || !inside(root, resource.externalId) || meta.ownerFile !== path.join(path.dirname(resource.externalId), "profile-owner.json") || path.basename(resource.externalId) !== "profile") throw new Error("Browser receipt is not bound to this task and purpose");
      const marker = await fileIdentity(meta.ownerFile);
      const markerBytes = await readFile(meta.ownerFile);
      const owner = z.object({ taskId: z.string(), profile: z.string(), nonce: z.string().uuid(), session: z.string().optional() }).strict().parse(JSON.parse(markerBytes.toString()));
      if (marker.sha256 !== meta.ownerSha256 || createHash("sha256").update(markerBytes).digest("hex") !== meta.ownerSha256 || owner.taskId !== input.taskId || owner.profile !== resource.externalId || owner.session && owner.session !== meta.session) throw new Error("Browser marker does not match the adopted task");
      await assertFinalizationPath(resource.externalId);
      const stat = await statOrMissing(resource.externalId);
      if (stat && !stat.isDirectory()) throw new Error("Browser profile is not an exact directory");
      allowed.push(meta.ownerFile, resource.externalId, path.join(path.dirname(resource.externalId), "browser-task.json"));
      opaque.set(resource.externalId, resource.id);
      managedFiles.set(path.join(path.dirname(resource.externalId), "browser-task.json"), resource.id);
      plan.push(FinalizationResourcePlan.parse({ ...common, disposition: "retire-owned", dependencies: [], target: { type: "profile", path: resource.externalId, ownerFile: meta.ownerFile, ownerSha256: meta.ownerSha256, session: meta.session, toolingRoot: meta.toolingRoot, ...(stat ? { dev: stat.dev, ino: stat.ino } : {}) } }));
    } else if (resource.kind === "local-http") {
      const meta = z.object({ pid: z.number().int().positive(), script: Absolute }).passthrough().parse(metadata);
      if (!inside(root, meta.script)) throw new Error("Fixture script is outside the adopted source root");
      allowed.push(meta.script);
      const target = { type: "endpoint" as const, url: resource.externalId, pid: meta.pid, script: meta.script };
      await observation.endpointAbsent(target);
      plan.push(FinalizationResourcePlan.parse({ ...common, disposition: "retire-owned", dependencies: [], target }));
    } else throw new Error("External finalization has an unsupported resource; preserve it");
  }
  const entries = await inventory(root, allowed, opaque, managedFiles);
  plan.push(FinalizationResourcePlan.parse({ ...finalizationResourceIdentity(source), disposition: "retire-owned", dependencies: plan.filter((entry) => entry.disposition === "retire-owned").map((entry) => entry.id), target: { type: "tree", path: root, inventory: entries, sourcePaths: input.sourcePaths } }));
  return plan;
}

/** Replays permit only removal of the originally frozen inventory. New entries,
 * replacements and changed bytes never become newly authorized cleanup. */
export async function assertFinalizationTree(target: Extract<Extract<FinalizationResourcePlan, { disposition: "retire-owned" }>["target"], { type: "tree" }>) {
  await assertFinalizationPath(target.path);
  if (!(await statOrMissing(target.path))) return;
  const expected = new Map(target.inventory.map((entry) => [entry.path, entry]));
  if (expected.size !== target.inventory.length || expected.get(".")?.kind !== "directory") throw new Error("Prepared source inventory is invalid");
  async function visit(file: string) {
    const relative = path.relative(target.path, file) || ".", entry = expected.get(relative);
    if (!entry) throw new Error("New material appeared in the prepared source root");
    const stat = await lstat(file);
    if (entry.dev !== stat.dev || entry.ino !== stat.ino || entry.mode !== stat.mode) throw new Error("Prepared source identity changed");
    if (entry.kind === "opaque") { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Browser dependency changed"); return; }
    if (entry.kind === "directory") { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Prepared directory changed"); for (const name of await readdir(file)) await visit(path.join(file, name)); }
    else if (entry.kind === "symlink") { if (!stat.isSymbolicLink() || await readlink(file) !== entry.link) throw new Error("Prepared symlink changed"); }
    else { const identity = await fileIdentity(file); if (identity.sha256 !== entry.sha256 || identity.size !== entry.size) throw new Error("Prepared file contents changed"); }
  }
  await visit(target.path);
}

export async function assertFinalizationResources(input: { resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; removed: boolean }, observation = finalizationResourceObservation) {
  const plan = z.array(FinalizationResourcePlan).parse(input.plan);
  const resources = input.resources.filter((r) => ["development", "review", "browser"].includes(r.purpose));
  if (new Set(plan.map((r) => r.id)).size !== plan.length || resources.length !== plan.length || resources.length !== input.resources.length) throw new Error("Finalization resource set changed");
  for (const entry of plan) {
    const resource = resources.find((r) => r.id === entry.id);
    if (!resource || finalizationResourceIdentity(resource).identityDigest !== entry.identityDigest) throw new Error("Finalization resource identity changed");
    if (entry.disposition === "retain-reference") { if (resource.state === "released") throw new Error("Retained history was falsely marked released"); continue; }
    const target = entry.target;
    if (target.type === "endpoint") await observation.endpointAbsent(target);
    else {
      await assertFinalizationPath(target.path);
      const stat = await statOrMissing(target.path);
      if (input.removed && stat) throw new Error("Finalization still has owned filesystem resources");
      if (!input.removed && stat) {
        if (target.type === "tree") await assertFinalizationTree(target);
        else if (target.type === "file") { const identity = await fileIdentity(target.path); if (identity.dev !== target.dev || identity.ino !== target.ino || identity.mode !== target.mode || identity.sha256 !== target.sha256 || identity.size !== target.size) throw new Error("Prepared evidence changed"); }
        else if (!stat.isDirectory() || target.dev !== stat.dev || target.ino !== stat.ino) throw new Error("Prepared browser profile changed");
      }
      if (target.type === "profile" && (input.removed || resource.state === "released")) await observation.browserAbsent(target);
      if (target.type === "tree") await observation.rootIdle(target.path);
    }
    if (input.removed && resource.state !== "released") throw new Error("Physical cleanup has no released resource receipt");
    if (resource.state === "released" && target.type !== "endpoint" && await statOrMissing(target.path)) throw new Error("A released resource was recreated");
  }
}
