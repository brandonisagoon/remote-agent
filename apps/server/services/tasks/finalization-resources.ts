import { CleanupAdapterPlan, assertCleanupAdapterResources, hasCleanupAdapter, hasHistoricalCleanupAdapter, prepareCleanupAdapterResources, type CleanupAdapterContext } from "./cleanup-adapter-resources.ts";
import { CleanupObserverResource } from "./cleanup-observer-schema.ts";
import type { runCleanupResourceObserver } from "./cleanup-resource-observer.ts";
import { observeInactiveUnixSocket } from "./unix-socket.ts";
import { createHash, randomUUID } from "node:crypto";
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
  z.object({ ...Entry, kind: z.literal("socket"), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), nlink: z.literal(1), size: z.number().int().nonnegative(), mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/) }).strict(),
  z.object({ ...Entry, kind: z.literal("opaque"), dependencyResourceId: z.string().min(1) }).strict(),
]);
export type FinalizationInventoryEntry = z.infer<typeof FinalizationInventoryEntry>;
export const FinalizationTreeTarget = z.object({ type: z.literal("tree"), path: Absolute, inventory: z.array(FinalizationInventoryEntry).min(1).max(250_000), sourcePaths: z.array(Absolute).min(1), quarantine: z.object({ directory: Absolute, path: Absolute, journal: Absolute }).strict() }).strict();
const Identity = { id: z.string().min(1), key: z.string().min(1), kind: z.string().min(1), purpose: z.enum(["development", "browser", "review"]), externalId: z.string().min(1), expiresAt: z.string().nullable(), identityDigest: Sha };
const FrozenFile = z.object({ path: Absolute, ...NodeIdentity, size: z.number().int().nonnegative(), sha256: Sha }).strict();
export const BrowserRetirementPlan = z.object({ ...Identity, kind: z.literal("browser-profile"), disposition: z.literal("retire-browser"), dependencies: z.array(z.string().min(1)).max(1),
  session: CleanupAdapterPlan, capture: z.discriminatedUnion("type", [
    z.object({ type: z.literal("registered"), parentResourceId: z.string().min(1), root: Absolute }).strict(),
    z.object({ type: z.literal("standalone"), target: FinalizationTreeTarget }).strict(),
  ]) }).strict();
export const LinkedWorktreePlan = z.object({ ...Identity, kind: z.literal("git-worktree"), disposition: z.literal("retire-worktree"), dependencies: z.array(z.string().min(1)).max(1000), stoppedConsumers: z.array(z.string().min(1)).max(1000), target: FinalizationTreeTarget,
  git: z.object({ repositoryRoot: Absolute, commonDirectory: Absolute, administrativeDirectory: Absolute,
    repositoryIdentity: z.object(NodeIdentity).strict(), commonIdentity: z.object(NodeIdentity).strict(), administrativeIdentity: z.object(NodeIdentity).strict(),
    head: z.string().regex(/^[a-f0-9]{40}$/), branch: z.string().min(1).nullable(), pointer: FrozenFile, index: FrozenFile,
    administrativeInventory: z.array(FinalizationInventoryEntry).min(1).max(256) }).strict(),
  retainedAdministration: z.object({ path: Absolute, inventoryDigest: Sha }).strict(),
  installedDependencies: z.array(z.object({ path: Absolute, ...NodeIdentity, packageFiles: z.array(FrozenFile).min(2).max(10) }).strict()).max(100),
}).strict();
export const RegisteredTreePlan = z.object({ ...Identity, disposition: z.literal("retire-tree"), treeKind: z.literal("registered-directory"), dependencies: z.array(z.string().min(1)).max(1000), stoppedConsumers: z.array(z.string().min(1)).max(1000), target: FinalizationTreeTarget }).strict();
export const ContainedFilePlan = z.object({ ...Identity, disposition: z.literal("retire-contained"), parentResourceId: z.string().min(1), dependencies: z.array(z.string().min(1)).length(1), target: z.object({ type: z.literal("file"), path: Absolute, ...NodeIdentity, size: z.number().int().nonnegative(), sha256: Sha }).strict() }).strict();
export const RetainedArchivePlan = z.object({ ...Identity, purpose: z.enum(["development", "browser", "review", "tooling"]), disposition: z.literal("retain-archive"), archive: z.object({ root: Absolute, manifestPath: Absolute, manifestSha256: Sha, inventoryDigest: Sha }).strict() }).strict();
export const RetainedArchiveMemberPlan = z.object({ ...Identity, kind: z.literal("resource-inventory"), purpose: z.literal("tooling"), disposition: z.literal("retain-archive-member"), archive: z.object({ resourceId: z.string().min(1), root: Absolute, inventoryDigest: Sha }).strict(), file: z.object({ path: Absolute, size: z.number().int().nonnegative(), sha256: Sha }).strict() }).strict();
export const RetainedResultPlan = z.object({ ...Identity, disposition: z.literal("retain-result"), reference: z.object({ archiveResourceId: z.string(), provenancePath: Absolute, provenanceSha256: Sha }).strict() }).strict();
export const FinalizationResourcePlan = z.discriminatedUnion("disposition", [
  CleanupAdapterPlan,
  BrowserRetirementPlan,
  LinkedWorktreePlan,
  RegisteredTreePlan,
  ContainedFilePlan,
  z.object({ ...Identity, disposition: z.literal("retain-reference"), reference: z.object({ deliveryId: z.string(), type: z.enum(["pull-request", "ci-run"]), repository: z.string(), number: z.number().int().positive(), reviewedHead: z.string(), mergeCommit: z.string().optional() }).strict() }).strict(),
  z.object({ ...Identity, disposition: z.literal("already-released") }).strict(),
  RetainedArchivePlan,
  RetainedArchiveMemberPlan,
  RetainedResultPlan,
  z.object({ ...Identity, disposition: z.literal("retire-owned"), dependencies: z.array(z.string()), target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("file"), path: Absolute, root: Absolute, size: z.number().int().nonnegative(), sha256: Sha, ...NodeIdentity }).strict(),
    FinalizationTreeTarget,
    z.object({ type: z.literal("profile"), path: Absolute, ownerFile: Absolute, ownerSha256: Sha, session: z.string(), toolingRoot: Absolute, dev: z.number().int().nonnegative().optional(), ino: z.number().int().nonnegative().optional() }).strict(),
    z.object({ type: z.literal("endpoint"), url: z.string().url(), pid: z.number().int().positive(), script: Absolute }).strict(),
  ]) }).strict(),
]);
export type FinalizationResourcePlan = z.infer<typeof FinalizationResourcePlan>;
export type RetainedMaterialPlan = Extract<FinalizationResourcePlan, { disposition: "retain-archive" | "retain-result" | "retain-archive-member" }>;
export function assertFinalizationPlanPurposes(resources: FinalizationResourceRecord[], plan: FinalizationResourcePlan[]) {
  for (const resource of resources) {
    if (["browser", "development", "review"].includes(resource.purpose)) continue;
    const entry = plan.find(entry => entry.id === resource.id);
    if (resource.purpose !== "tooling" || !entry || entry.purpose !== "tooling" || !(entry.disposition === "retain-archive" && resource.kind === "recovery-archive" && entry.kind === resource.kind && entry.externalId === entry.archive.root || entry.disposition === "retain-archive-member" && resource.kind === "resource-inventory" && entry.externalId === entry.file.path)) throw new Error("Unknown resource purpose cannot be adopted for cleanup");
  }
}
export function assertRetainedMaterialPlan(entry: RetainedMaterialPlan, plan: FinalizationResourcePlan[]) {
  if (entry.disposition === "retain-result") {
    if (!["rubin-chat", "rubin-property-revision", "studio-site-snapshot"].includes(entry.kind)) throw new Error("Retained result identity mismatch");
  } else if (entry.disposition === "retain-archive") {
    if ((entry.purpose === "tooling" ? entry.kind !== "recovery-archive" : entry.kind !== "source-archive") || entry.externalId !== entry.archive.root || !inside(entry.archive.root, entry.archive.manifestPath)) throw new Error("Retained archive identity mismatch");
  } else {
    const archive = plan.find(parent => parent.id === entry.archive.resourceId);
    if (!archive || archive.disposition !== "retain-archive" || archive.archive.root !== entry.archive.root || archive.archive.inventoryDigest !== entry.archive.inventoryDigest || entry.externalId !== entry.file.path || !inside(entry.archive.root, entry.file.path)) throw new Error("Retained archive member identity mismatch");
  }
}
type Retirement = Extract<FinalizationResourcePlan, { disposition: "retire-owned" }>;
type TreeTarget = Extract<Retirement["target"], { type: "tree" }>;
export const FinalizationQuarantineJournal = z.object({
  version: z.literal(1), taskId: z.string().min(1), resourceId: z.string().min(1), planDigest: Sha,
  sourcePath: Absolute, capturedPath: Absolute, source: z.object(NodeIdentity).strict(),
  quarantine: z.object({ dev: NodeIdentity.dev, ino: NodeIdentity.ino }).strict(),
}).strict();
export type FinalizationQuarantineJournal = z.infer<typeof FinalizationQuarantineJournal>;
export type FinalizationResourceRecord = { id: string; key: string; kind: string; purpose: string; externalId: string; state: string; expiresAt?: string | Date | null; metadata?: unknown };
type Delivery = { id: string; repository: string; pullRequest: number; url: string; reviewedHead: string; mergeCommit: string; ci: Array<{ runId: number; head: string }> };
export const ExternalResourceOwnership = z.object({ sourceCopyResourceId: z.string().min(1).optional(), ownedPaths: z.array(Absolute).max(1000) }).strict();
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
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("Finalization requires an unshared regular file");
    const hash = createHash("sha256");
    // One handle owns the descriptor through hashing and finally-close; no
    // separate stream may retain ownership after verification finishes.
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error("Finalization file changed during observation");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    const leaf = await lstat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || leaf.dev !== before.dev || leaf.ino !== before.ino || leaf.mode !== before.mode || leaf.uid !== before.uid || leaf.isSymbolicLink()) throw new Error("Finalization file changed during observation");
    return { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

export type ResourceObservation = {
  adapters?: typeof runCleanupResourceObserver;
  endpointAbsent(target: { url: string; pid: number; script: string }): Promise<void>;
  rootIdle(root: string): Promise<void>;
  linkedRootIdle?(root: string): Promise<void>;
  browserAbsent(target: { session: string; toolingRoot: string }): Promise<void>;
};
async function processList() {
  const result = await bunCommandClient.run("ps", ["-axo", "pid=,command="]);
  if (!result.ok) throw new Error("Could not independently inspect task processes");
  return result.stdout.split("\n");
}
export const finalizationResourceObservation: ResourceObservation = {
  async linkedRootIdle(root) { await (await import("./cleanup-open-handles.ts")).assertLinkedRootIdle(root); },
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
export async function finalizationInventory(root: string, allowed: string[], opaque: Map<string, string>, managedFiles: Map<string, string>) {
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
    else if (stat.isSocket()) entries.push({ path: common.path, kind: "socket", ...await observeInactiveUnixSocket(file) });
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

function referencePlan(resource: FinalizationResourceRecord, deliveries: Delivery[]) {
  const delivery = deliveries.find((item) => resource.kind !== "ci-run" ? resource.externalId === item.url : item.ci.some((run) => resource.externalId === `https://github.com/${item.repository}/actions/runs/${run.runId}` && run.head === item.reviewedHead));
  if (!delivery) throw new Error("Reference is not part of an independently verified external delivery");
  const number = resource.kind !== "ci-run" ? delivery.pullRequest : delivery.ci.find((run) => resource.externalId === `https://github.com/${delivery.repository}/actions/runs/${run.runId}`)!.runId;
  return FinalizationResourcePlan.parse({ ...finalizationResourceIdentity(resource), disposition: "retain-reference", reference: { deliveryId: delivery.id, type: resource.kind === "ci-run" ? "ci-run" : "pull-request", repository: delivery.repository, number, reviewedHead: delivery.reviewedHead, ...(resource.kind !== "ci-run" ? { mergeCommit: delivery.mergeCommit } : {}) } });
}

function observerResources(resources: FinalizationResourceRecord[]) {
  return resources.map(resource => CleanupObserverResource.parse({ id: resource.id, key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId, state: resource.state, expiresAt: resource.expiresAt instanceof Date ? resource.expiresAt.toISOString() : resource.expiresAt ?? null, metadata: resource.metadata ?? {} }));
}
function assertPlanDependencies(plan: FinalizationResourcePlan[]) {
  const entries = new Map(plan.map(entry => [entry.id, entry])), visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Prepared cleanup dependency graph contains a cycle");
    if (visited.has(id)) return;
    const entry = entries.get(id); if (!entry) throw new Error("Prepared cleanup dependency is outside its resource set");
    visiting.add(id);
    if ("dependencies" in entry) {
      if (new Set(entry.dependencies).size !== entry.dependencies.length || entry.dependencies.includes(id)) throw new Error("Prepared cleanup dependency identity changed");
      for (const dependency of entry.dependencies) visit(dependency);
    }
    if ("stoppedConsumers" in entry) {
      if (new Set(entry.stoppedConsumers).size !== entry.stoppedConsumers.length || entry.stoppedConsumers.includes(id) || entry.stoppedConsumers.some(id => entry.dependencies.includes(id))) throw new Error("Prepared stopped-consumer identity changed");
      for (const id of entry.stoppedConsumers) {
        const consumer = entries.get(id);
        if (!consumer || !(consumer.disposition === "retire-adapter" && consumer.targets.some(target => target.kind === "native-family") || consumer.disposition === "retire-browser" && consumer.session.targets.some(target => target.kind === "browser-session"))) throw new Error("Prepared stopped consumer has no exact native-family proof or browser-session proof");
      }
    }
    visiting.delete(id); visited.add(id);
  }
  for (const entry of plan) visit(entry.id);
}

export async function prepareFinalizationResources(input: { resources: FinalizationResourceRecord[]; taskId: string; sessionId: string; toolingRoot: string; sourcePaths: string[]; deliveries: Delivery[]; ownership: ExternalResourceOwnership; retainedArchives?: RetainedMaterialPlan[]; originalWork?: boolean; adapterContext?: CleanupAdapterContext }, observation = finalizationResourceObservation) {
  const ownership = ExternalResourceOwnership.parse(input.ownership);
  const resources = input.resources;
  assertFinalizationPlanPurposes(resources, input.retainedArchives ?? []);
  if (new Set(resources.map((r) => r.id)).size !== resources.length || new Set(resources.map((r) => r.key)).size !== resources.length) throw new Error("Resource inventory has duplicate identities");
  const retainedArchives = input.retainedArchives ?? [];
  const exceptional: FinalizationResourcePlan[] = [];
  const active = resources.filter((resource) => {
    if (resource.state === "released" && input.originalWork && !(!ownership.sourceCopyResourceId && hasHistoricalCleanupAdapter(resource))) { exceptional.push(FinalizationResourcePlan.parse({ ...finalizationResourceIdentity(resource), disposition: "already-released" })); return false; }
    const archive = retainedArchives.find((entry) => entry.id === resource.id);
    if (archive) { if (resource.state === "released" || archive.identityDigest !== finalizationResourceIdentity(resource).identityDigest) throw new Error("Retained archive identity mismatch"); assertRetainedMaterialPlan(archive, retainedArchives); exceptional.push(archive); return false; }
    return true;
  });
  if (!ownership.sourceCopyResourceId && input.originalWork) {
    const { prepareRegisteredCaptures, hasRegisteredCaptureResource } = await import("./cleanup-filesystem.ts");
    const { prepareLinkedWorktreeCaptures } = await import("./cleanup-worktrees.ts");
    const adapters = active.filter(resource => hasCleanupAdapter(resource.kind));
    const references = active.filter(resource => ["pull-request", "ci-run", "github-pull-request", "delivery-receipt"].includes(resource.kind));
    const unsupportedKinds = active.filter(resource => !adapters.includes(resource) && !references.includes(resource) && resource.kind !== "git-worktree" && !hasRegisteredCaptureResource(resource, active));
    if (unsupportedKinds.length) throw new Error(`Original-work adoption needs exact resource plans: ${unsupportedKinds.map(resource => `${resource.key} (${resource.kind})`).join(", ")}`);
    for (const resource of references) exceptional.push(referencePlan(resource, input.deliveries));
    if (adapters.length) {
      const context = input.adapterContext;
      if (!context || context.task.id !== input.taskId || context.task.primarySessionId !== input.sessionId) throw new Error("Physical adapter preparation requires the server-bound original task and committed cleanup capability");
      exceptional.push(...await prepareCleanupAdapterResources({ context, resources: observerResources(resources), identities: adapters.map(resource => ({ ...finalizationResourceIdentity(resource), purpose: z.enum(["development", "browser", "review"]).parse(resource.purpose) })) }, observation.adapters));
    }
    const { prepareBrowserCaptures } = await import("./cleanup-browsers.ts");
    const browserPlans = await prepareBrowserCaptures({ taskId: input.taskId, resources: active, plan: exceptional, ownedPaths: ownership.ownedPaths,
      protectedPaths: [input.toolingRoot, ...(input.adapterContext ? [input.adapterContext.task.worktreePath, input.adapterContext.capability.checkout] : [])] }, observation);
    for (const browser of browserPlans) exceptional[exceptional.findIndex(entry => entry.id === browser.id)] = browser;
    exceptional.push(...await prepareRegisteredCaptures({ resources: active, plan: exceptional, ownedPaths: ownership.ownedPaths,
      protectedPaths: [input.toolingRoot, ...(input.adapterContext ? [input.adapterContext.task.worktreePath, input.adapterContext.capability.checkout] : [])] }, observation));
    exceptional.push(...await prepareLinkedWorktreeCaptures({ resources: active, plan: exceptional, ownedPaths: ownership.ownedPaths,
      protectedPaths: [input.toolingRoot, ...(input.adapterContext ? [input.adapterContext.task.worktreePath, input.adapterContext.capability.checkout] : [])] }, observation));
    const unsupported = active.filter(resource => !exceptional.some(entry => entry.id === resource.id));
    if (unsupported.length) throw new Error(`Original-work adoption needs exact resource plans: ${unsupported.map((resource) => `${resource.key} (${resource.kind})`).join(", ")}`);
    assertPlanDependencies(exceptional);
    return exceptional;
  }
  const source = active.find((resource) => resource.id === ownership.sourceCopyResourceId);
  if (!source || source.kind !== "source-copies" || source.state === "released") throw new Error("Adoption requires the exact retained source-copy resource");
  const root = Absolute.parse(source.externalId);
  await assertFinalizationPath(root);
  if (path.parse(root).root === root || input.sourcePaths.length === 0 || [...input.sourcePaths, ...ownership.ownedPaths].some((file) => !inside(root, Absolute.parse(file)))) throw new Error("Source ownership scope must stay strictly inside its recorded root");
  await assertIgnoredOwnership(input.sourcePaths, ownership.ownedPaths);
  await observation.rootIdle(root);
  const opaque = new Map<string, string>(), managedFiles = new Map<string, string>();
  const allowed = [...input.sourcePaths, ...ownership.ownedPaths];
  const plan: FinalizationResourcePlan[] = [...exceptional];
  for (const resource of active) {
    if (resource.id === source.id) continue;
    if (resource.state === "released") throw new Error("Initial external adoption requires retained resource identities");
    const common = finalizationResourceIdentity(resource);
    const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata ?? {});
    if (["pull-request", "ci-run", "github-pull-request", "delivery-receipt"].includes(resource.kind)) {
      plan.push(referencePlan(resource, input.deliveries));
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
  const entries = await finalizationInventory(root, allowed, opaque, managedFiles);
  // Allocate only a frozen name here. The prepared client creates this private
  // same-filesystem sibling immediately before its exclusive capture rename.
  const directory = path.join(path.dirname(root), `.drafted-finalization-${randomUUID()}`);
  plan.push(FinalizationResourcePlan.parse({ ...finalizationResourceIdentity(source), disposition: "retire-owned", dependencies: plan.filter((entry) => entry.disposition === "retire-owned").map((entry) => entry.id), target: { type: "tree", path: root, inventory: entries, sourcePaths: input.sourcePaths,
    quarantine: { directory, path: path.join(directory, "contents"), journal: path.join(directory, "pending.json") } } }));
  return plan;
}

/** Whole-root capture preserves the complete frozen inventory. Neither missing
 * children nor new entries can become a successful quarantine proof. */
export async function assertFinalizationTree(target: TreeTarget, physicalPath = target.path) {
  await assertFinalizationPath(physicalPath);
  if (!(await statOrMissing(physicalPath))) throw new Error("Prepared source inventory is missing");
  const expected = new Map(target.inventory.map((entry) => [entry.path, entry]));
  if (expected.size !== target.inventory.length || expected.get(".")?.kind !== "directory") throw new Error("Prepared source inventory is invalid");
  for (const entry of target.inventory) {
    if (entry.path !== "." && (!inside(physicalPath, path.resolve(physicalPath, entry.path)) || expected.get(path.dirname(entry.path))?.kind !== "directory")) throw new Error("Prepared source inventory has an invalid parent");
  }
  const seen = new Set<string>();
  async function visit(file: string) {
    const relative = path.relative(physicalPath, file) || ".", entry = expected.get(relative);
    if (!entry) throw new Error("New material appeared in the prepared source root");
    seen.add(relative);
    const stat = await lstat(file);
    if (entry.dev !== stat.dev || entry.ino !== stat.ino || entry.mode !== stat.mode) throw new Error("Prepared source identity changed");
    if (entry.kind === "opaque") { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Browser dependency changed"); return; }
    if (entry.kind === "directory") { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Prepared directory changed"); for (const name of await readdir(file)) await visit(path.join(file, name)); }
    else if (entry.kind === "symlink") { if (!stat.isSymbolicLink() || await readlink(file) !== entry.link) throw new Error("Prepared symlink changed"); }
    else if (entry.kind === "socket") { const { path: _path, kind: _kind, ...expected } = entry; await observeInactiveUnixSocket(file, expected); }
    else { const identity = await fileIdentity(file); if (identity.dev !== entry.dev || identity.ino !== entry.ino || identity.mode !== entry.mode || identity.sha256 !== entry.sha256 || identity.size !== entry.size) throw new Error("Prepared file contents changed"); }
  }
  await visit(physicalPath);
  if (seen.size !== expected.size) throw new Error("Prepared source inventory is incomplete");
  await assertFinalizationPath(physicalPath);
  const after = await lstat(physicalPath), original = expected.get(".")!;
  if (after.dev !== original.dev || after.ino !== original.ino || after.mode !== original.mode) throw new Error("Prepared source root changed during inspection");
}

async function readQuarantineJournal(file: string) {
  await assertFinalizationPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    const limit = 64 * 1024;
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.uid !== process.getuid?.() || before.size > limit) throw new Error("Quarantine journal must be a bounded private regular file");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat(), leaf = await lstat(file);
    if (bytes.length > limit || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.dev !== leaf.dev || before.ino !== leaf.ino || before.mode !== leaf.mode || before.uid !== leaf.uid || leaf.isSymbolicLink()) throw new Error("Quarantine journal changed during inspection");
    return FinalizationQuarantineJournal.parse(JSON.parse(bytes.toString()));
  } finally { await handle.close(); }
}

/** Observes a frozen capture; never creates, repairs, restores, or removes its
 * contents. A pending journal can precede rename, but missing source without a
 * matching capture is never proof of retirement. */
export async function inspectFinalizationQuarantine(input: { taskId: string; resourceId: string; target: TreeTarget; quarantineParent?: { path: string; dev: number; ino: number; mode: number }; sourceParent?: { path: string; dev: number; ino: number; mode: number } }) {
  const { target } = input, { quarantine } = target;
  const destinationParent = input.quarantineParent;
  if (destinationParent && !input.sourceParent) throw new Error("External quarantine requires both frozen parent identities");
  if (destinationParent) {
    await assertFinalizationPath(destinationParent.path);
    const parent = await lstat(destinationParent.path);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o7777) !== 0o700 || parent.dev !== destinationParent.dev || parent.ino !== destinationParent.ino || parent.mode !== destinationParent.mode || parent.dev !== target.inventory[0]?.dev) throw new Error("Quarantine destination parent identity changed");
  }
  if (path.dirname(quarantine.directory) !== (destinationParent?.path ?? path.dirname(target.path)) || quarantine.directory === target.path || quarantine.path !== path.join(quarantine.directory, "contents") || quarantine.journal !== path.join(quarantine.directory, "pending.json") || !/^\.drafted-finalization-[0-9a-f-]{36}$/.test(path.basename(quarantine.directory))) throw new Error("Quarantine location does not match its frozen source root");
  await assertFinalizationPath(target.path);
  await assertFinalizationPath(quarantine.directory);
  const source = await statOrMissing(target.path), directory = await statOrMissing(quarantine.directory);
  if (input.sourceParent) {
    const parent = await statOrMissing(input.sourceParent.path);
    if (path.dirname(target.path) !== input.sourceParent.path || parent && (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.dev !== input.sourceParent.dev || parent.ino !== input.sourceParent.ino || parent.mode !== input.sourceParent.mode) || !parent && source) throw new Error("Evidence source parent identity changed");
  }
  if (!directory) {
    if (!source) throw new Error("Source disappearance has no retained quarantine proof");
    return { captured: false as const, physicalPath: target.path };
  }
  if (!directory.isDirectory() || (directory.mode & 0o7777) !== 0o700 || directory.uid !== process.getuid?.()) throw new Error("Quarantine must be an exact private directory");
  const root = target.inventory.find((entry) => entry.path === ".");
  if (!root || root.kind !== "directory" || directory.dev !== root.dev) throw new Error("Quarantine must preserve the original filesystem identity");
  const journal = await readQuarantineJournal(quarantine.journal);
  if (journal.taskId !== input.taskId || journal.resourceId !== input.resourceId || journal.planDigest !== finalizationDigest(target) || journal.sourcePath !== target.path || journal.capturedPath !== quarantine.path || journal.source.dev !== root.dev || journal.source.ino !== root.ino || journal.source.mode !== root.mode || journal.quarantine.dev !== directory.dev || journal.quarantine.ino !== directory.ino) throw new Error("Quarantine journal does not match the prepared resource");
  const entries = (await readdir(quarantine.directory)).sort();
  if (entries.some((name) => name !== "contents" && name !== "pending.json")) throw new Error("Quarantine contains unexpected material");
  await assertFinalizationPath(quarantine.path);
  const captured = await statOrMissing(quarantine.path);
  if (source && captured) throw new Error("Original source root was recreated after capture");
  if (!source && !captured) throw new Error("Source disappearance has no retained quarantine proof");
  if (captured && (!captured.isDirectory() || captured.dev !== root.dev || captured.ino !== root.ino || captured.mode !== root.mode)) throw new Error("Captured source root identity changed");
  const after = await lstat(quarantine.directory);
  if (after.dev !== directory.dev || after.ino !== directory.ino || after.mode !== directory.mode) throw new Error("Quarantine directory changed during inspection");
  return { captured: Boolean(captured), physicalPath: captured ? quarantine.path : target.path };
}

export async function assertFinalizationResources(input: { taskId: string; resources: FinalizationResourceRecord[]; plan: FinalizationResourcePlan[]; removed: boolean; originalWork?: boolean }, observation = finalizationResourceObservation) {
  const plan = z.array(FinalizationResourcePlan).parse(input.plan);
  const resources = input.resources;
  if (new Set(plan.map((r) => r.id)).size !== plan.length || resources.length !== plan.length || resources.length !== input.resources.length) throw new Error("Finalization resource set changed");
  assertFinalizationPlanPurposes(resources, plan);
  const trees = plan.filter((entry): entry is Retirement & { target: TreeTarget } => entry.disposition === "retire-owned" && entry.target.type === "tree");
  for (const entry of plan) {
    const record = resources.find((resource) => resource.id === entry.id);
    if (!record || finalizationResourceIdentity(record).identityDigest !== entry.identityDigest) throw new Error("Finalization resource identity changed");
    if (["retain-archive", "retain-result", "retain-archive-member"].includes(entry.disposition)) assertRetainedMaterialPlan(entry as RetainedMaterialPlan, plan);
    if (entry.disposition === "already-released" && record.state !== "released" || entry.disposition.startsWith("retain-") && record.state === "released") throw new Error("Retained history was falsely marked released or an already-released resource changed");
  }
  assertPlanDependencies(plan);
  const adapters = plan.flatMap(entry => entry.disposition === "retire-adapter" ? [entry] : entry.disposition === "retire-browser" ? [entry.session] : []);
  const adapterObservation = adapters.length ? await assertCleanupAdapterResources({ taskId: input.taskId, resources: observerResources(resources), plan: adapters, removed: input.removed }, observation.adapters) : undefined;
  if (plan.some(entry => entry.disposition === "retire-tree" || entry.disposition === "retire-contained")) {
    const { assertRegisteredCaptures } = await import("./cleanup-filesystem.ts");
    await assertRegisteredCaptures({ ...input, plan, adapterObservation }, observation);
  }
  if (plan.some(entry => entry.disposition === "retire-worktree")) {
    const { assertLinkedWorktreeCaptures } = await import("./cleanup-worktrees.ts");
    await assertLinkedWorktreeCaptures({ ...input, plan, adapterObservation }, observation);
  }
  if (plan.some(entry => entry.disposition === "retire-browser")) {
    const { assertBrowserCaptures } = await import("./cleanup-browsers.ts");
    await assertBrowserCaptures({ ...input, plan, adapterObservation }, observation);
  }
  if (trees.length === 0 && input.originalWork && plan.every((entry) => entry.disposition !== "retire-owned")) return;
  if (trees.length !== 1) throw new Error("Finalization requires one exact retained source-root capture");
  const tree = trees[0]!, target = tree.target;
  const physical = plan.filter((entry): entry is Retirement => entry.disposition === "retire-owned");
  if (new Set(tree.dependencies).size !== tree.dependencies.length || tree.dependencies.length !== physical.length - 1 || physical.some((entry) => entry.id !== tree.id && !tree.dependencies.includes(entry.id))) throw new Error("Source capture must include every owned resource");
  const capture = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: tree.id, target });
  if (input.removed && !capture.captured) throw new Error("Finalization still has owned filesystem resources at their active paths");
  await assertFinalizationTree(target, capture.physicalPath);
  const remap = (file: string) => {
    if (!inside(target.path, file)) throw new Error("Owned resource is outside its captured source root");
    return path.join(capture.physicalPath, path.relative(target.path, file));
  };
  for (const entry of plan) {
    const resource = resources.find((r) => r.id === entry.id);
    if (!resource || finalizationResourceIdentity(resource).identityDigest !== entry.identityDigest) throw new Error("Finalization resource identity changed");
    if (entry.disposition !== "retire-owned") continue;
    const child = entry.target;
    if (child.type === "endpoint") await observation.endpointAbsent(child);
    else if (child.type !== "tree") {
      const file = remap(child.path);
      await assertFinalizationPath(file);
      const stat = await statOrMissing(file);
      if (child.type === "file") {
        if (!stat) throw new Error("Captured evidence is missing");
        const identity = await fileIdentity(file);
        if (identity.dev !== child.dev || identity.ino !== child.ino || identity.mode !== child.mode || identity.sha256 !== child.sha256 || identity.size !== child.size) throw new Error("Prepared evidence changed");
      } else {
        if (stat ? !stat.isDirectory() || child.dev !== stat.dev || child.ino !== stat.ino : child.dev !== undefined || child.ino !== undefined) throw new Error("Prepared browser profile changed");
        if ((await fileIdentity(remap(child.ownerFile))).sha256 !== child.ownerSha256) throw new Error("Prepared browser ownership marker changed");
        if (capture.captured || input.removed || resource.state === "released") await observation.browserAbsent(child);
      }
      if (capture.captured) { await assertFinalizationPath(child.path); if (await statOrMissing(child.path)) throw new Error("Original owned resource was recreated after capture"); }
    }
    if (input.removed && resource.state !== "released") throw new Error("Physical retirement has no released resource receipt");
    if (resource.state === "released" && !capture.captured) throw new Error("Released resource has no retained quarantine proof");
  }
  await observation.rootIdle(target.path);
  if (capture.captured) await observation.rootIdle(capture.physicalPath);
  const rechecked = await inspectFinalizationQuarantine({ taskId: input.taskId, resourceId: tree.id, target });
  if (rechecked.captured !== capture.captured || rechecked.physicalPath !== capture.physicalPath) throw new Error("Quarantine capture changed during verification");
}
