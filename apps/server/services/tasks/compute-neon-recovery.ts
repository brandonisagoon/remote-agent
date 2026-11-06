import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { assertComputeEnvironmentOwner, computeTaskOwner } from "./compute-admission.ts";
import { assertComputeStartIntent, developmentProjection } from "./development-intent.ts";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";
import { isSavedComputeEnvironment } from "./compute-saved-resource.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";

/**
 * DRA-16 / DRA-24: a development runtime that failed before any application
 * container, with an interrupted `create-neon` and only earlier provider
 * receipts saved, may advance its recipe digest to the reviewed Neon
 * template-child recipe. This is deliberately separate from
 * `compute-configure` (which requires a prepared, stopped container and
 * coverage) and never broadens it.
 *
 * Authority comes only from: the original task/primary/source/pin, the exact
 * environment and resource, the exact last-claimed allocation (retained or
 * terminal history) and a server-selected immutable runtime observer that
 * proves the private receipt, baseline, live lock, provisioning stage and
 * journaled provider reconciliation. Absence must be the provider's journaled
 * rejection of the exact request or a complete settled inventory; a create
 * with no pre-request journal remains pending (unknown), never absent. No offer, slot, wait, start instruction,
 * pin, provider or traffic is created, revived or released.
 */
export const NeonRecoveryContract = "runtime-neon-recovery/v1";
export const NeonRecoveryTransition = "neon-template-child";
const Action = "compute-neon-recovery";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.string().regex(/^[a-f0-9]{40}$/);
const Id = z.string().min(1).max(256);
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/);
const Absolute = z.string().max(4096).refine(p => path.isAbsolute(p) && path.normalize(p) === p);
const Instant = z.iso.datetime();

export const ComputeNeonRecovery = z.object({
  offerId: z.string().uuid(), operationId: z.string().uuid(), resourceKey: Key,
  previousRecipeHash: Sha, recipeHash: Sha, baselineFile: Absolute, lockPid: z.number().int().positive(),
  outcome: z.enum(["absent", "owned"]),
  // The task worktree's current HEAD, pinned by the operation binding. The
  // environment keeps its original provisioning revision; normal product
  // commits since then are expected and are never rewritten here.
  sourceRevision: Revision,
}).strict().refine(value => value.previousRecipeHash !== value.recipeHash, "Recovery must change the recipe digest");

/** Mirrors the tooling runtime receipt's provider entry (wire contract). */
const ProviderReceipt = z.object({
  provider: z.enum(["planetscale", "neon", "redis", "storage"]), id: Id, name: Id, createdAt: z.string().max(64).optional(),
  released: z.boolean().optional(), parentId: Id.optional(), parentLsn: z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/).optional(), templateBranchId: Id.optional(),
}).strict();
/** Mirrors the tooling NeonCreateAttempt journal (wire contract). */
const Attempt = z.object({
  // `requestId` is DRA-24's provider annotation marker for the exact POST.
  version: z.literal(1), requestId: z.string().uuid().optional(), name: Id, projectId: Id, templateBranchId: Id, parentLsn: z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/),
  requestedAt: Instant, expiresAt: Instant,
  rejection: z.object({ status: z.number().int().min(400).max(499), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(), observedAt: Instant }).strict().optional(),
}).strict();
const InventoryBranch = z.object({ id: Id, name: z.string().min(1).max(256), parentId: Id.optional(), createdAt: Instant }).strict();
/** Absence is never inferred from a name search. It needs either the
 * provider's own rejection of the exact journaled request, or a complete,
 * unfiltered, settled project inventory listed after that request's lifetime. */
const Inventory = z.object({ complete: z.literal(true), projectId: Id, listedAt: Instant, pages: z.number().int().min(1).max(100),
  branches: z.array(InventoryBranch).min(1).max(2000) }).strict();
const ProgressEvent = z.object({ event: z.literal("runtime-progress"), taskId: Id, step: z.string().min(1).max(64), detail: z.string().max(512),
  state: z.enum(["running", "failed", "complete"]), updatedAt: Instant }).strict();
/** DRA-16 class: a pre-journal (legacy) create whose provider response body
 * was discarded, but whose HTTP status survives in the original CLI log.
 * The status is interpreted only through reviewed source semantics and must
 * be corroborated by server-held turn/capability history and a complete
 * settled provider inventory. The log locator and content come from the
 * observer's reviewed release, never from the request. */
const LegacyRejection = z.object({ basis: z.literal("legacy-provider-rejection"), requestName: Id, baselineBranchId: Id,
  source: z.object({ revision: Revision, blobs: z.object({ "src/runtime-providers.ts": Revision, "src/runtime.ts": Revision }).strict() }).strict(),
  // Optional: required only when the receipt no longer holds the failure.
  log: z.object({ file: Absolute, bytes: z.number().int().min(1).max(65_536), sha256: Sha, events: z.array(ProgressEvent).min(2).max(64), stderr: z.string().max(512) }).strict().optional(),
  // The baseline receipt's own progress, written by the pinned tool. It is
  // either the original failure itself or the later interruption guard.
  receiptProgress: z.object({ step: z.string().min(1).max(64), detail: z.string().max(512), state: z.enum(["running", "failed", "complete"]), updatedAt: Instant }).strict(),
  inventory: Inventory }).strict();
const Absence = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("provider-rejection") }).strict(),
  Inventory.extend({ basis: z.literal("complete-inventory") }).strict(),
  LegacyRejection,
]);
/** Reviewed pinned-source semantics (Drafted f4f93c8): `api()` uses
 * `redirect: "error"`, no retries and no body read on failure, and throws
 * exactly `Remote dependency ${method} failed (${status})` for a non-ok
 * response (runtime-providers.ts:33-38). In the `neon` step the only reachable
 * POST before the receipt is recorded is the branch create (line 179); the
 * later database POST (183) follows `record` (181-182), which persists the
 * Neon receipt first. A pending `create-neon` with no Neon receipt stops every
 * later run at the interruption guard before any provider call
 * (runtime.ts:448-471). Only blobs reviewed for these semantics qualify. */
export const ReviewedLegacyNeonSources: readonly { "src/runtime-providers.ts": string; "src/runtime.ts": string }[] = [
  { "src/runtime-providers.ts": "addccdd030cf1aa5f153a3ff2a8b5cde13b7d6ec", "src/runtime.ts": "da605c79682c2909183b603dff04c355e1291233" },
];
const legacyGuard = "Interrupted runtime operation (create-neon); preserve resources and reconcile the exact provider result before retrying";
const legacyRequestTimeoutMs = 31_000;
/** Statuses that prove the provider did not create the branch. Timeouts,
 * conflicts (a same-named branch may exist) and 5xx stay unknown. */
const definitiveRejections = new Set([400, 401, 403, 404, 422, 429]);
/** Journaled reconciliation evidence (the exact saved entry, not a fresh
 * provider read, so repeated observations are byte-stable). Both outcomes
 * require the attempt journaled before the POST: a create without one (for
 * example a legacy POST whose response was discarded) stays pending. */
const Reconciliation = z.object({
  operation: z.literal("create-neon"), outcome: z.enum(["absent", "owned"]), name: Id, projectId: Id, observedAt: Instant,
  branchId: Id.optional(), attempt: Attempt.optional(), absence: Absence.optional(),
}).strict();
/** Accepted provider skew before, and bounded request lifetime after, the
 * journaled request. Matches the tooling create reconciliation window. */
const createdBeforeMs = 60_000, requestLifetimeMs = 15 * 60_000;
const Stage = z.object({
  phase: z.enum(["preparing", "failed"]), pending: z.literal("create-neon").nullable(),
  setupComplete: z.literal(false), schemaApplied: z.literal(false), fixturesComplete: z.literal(false),
  // DRA-25 `spatialSchema` is additive receipt evidence, not a recipe field.
  // Recovery never covers schema state: neither receipt may carry it.
  spatialSchema: z.literal(false),
  container: z.literal(false), containerOperation: z.literal(false), configuration: z.literal(false), coverage: z.literal(false), startBundle: z.literal(false),
}).strict();
export const ComputeNeonRecoveryProof = z.object({
  version: z.literal(1), contract: z.literal(NeonRecoveryContract), transition: z.literal(NeonRecoveryTransition),
  taskId: Id, primarySessionId: Id, toolingRevision: Revision, environmentId: z.string().uuid(), resourceId: Id, resourceKey: Key,
  offerId: z.string().uuid(), operationId: z.string().uuid(), revision: Revision, sourceRevision: Revision,
  previousRecipeHash: Sha, recipeHash: Sha, receiptSha256: Sha, baselineSha256: Sha, lockSha256: Sha, lockPid: z.number().int().positive(),
  stage: Stage, baselineProviders: z.array(ProviderReceipt).max(8), providers: z.array(ProviderReceipt).max(8), reconciliation: Reconciliation,
  // Canonical SHA-256 of the failed baseline receipt's own `neonCreate`
  // journal (written before the POST, plus its recorded response).
  // null only for the legacy basis: the baseline had no journal at all.
  baselineNeonCreateSha256: Sha.nullable(),
  // The release the observer derived from its own checkout (git HEAD/tree),
  // which must be the bound operation's release.
  operation: z.object({ operationId: Id, releaseId: Id, revision: Revision, tree: Revision }).strict(),
}).strict();
export type ComputeNeonRecoveryProof = z.infer<typeof ComputeNeonRecoveryProof>;

type Request = z.infer<typeof ComputeNeonRecovery>;
type Input = { prisma: PrismaClient; config: ServerConfig; taskId: string; request: Request; operation: BoundToolingOperation };
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
/** Structural subset of DRA-28's `ToolingOperationBinding`
 * (types/tooling-release.ts). The route supplies the binding admitted for
 * this exact request; the request body never names a release or path. */
export const NeonRecoveryOperationKind = "compute-neon-recovery";
export type BoundToolingRelease = { id: string; repositoryId: string; revision: string; tree: string; checkout: string };
export type BoundToolingOperation = { contract: "remote-agent.tooling-operation/v1"; operationId: string; requestKey: string; inputDigest: string; repositoryId: string;
  taskId: string; sessionId: string; kind: string; existingOperationId: string | null; resourceKey: string | null; generation: number; release: BoundToolingRelease };
/** Identity of the observer the server actually executed. */
const ObserverIdentity = z.object({ operationId: Id, releaseId: Id, revision: Revision, tree: Revision, adapterSha256: Sha }).strict();
type ObserverIdentity = z.infer<typeof ObserverIdentity>;
export type NeonRecoveryReader = (input: Input, before: Snapshot) => Promise<{ proof: unknown; observer: ObserverIdentity }>;
const Metadata = z.record(z.string(), z.json());
export type ComputeNeonRecoveryResult = { environmentId: string; resourceId: string; resourceIdentity: string; offerId: string; operationId: string;
  previousRecipeHash: string; recipeHash: string; sourceRevision: string; outcome: "absent" | "owned"; basis: "provider-rejection" | "complete-inventory" | "legacy-provider-rejection" | "exact-owned-child";
  reconciliationSha256: string; observer: ObserverIdentity;
  allocation: "retained-existing-claim" | "previously-stopped-await-normal-admission" };
const allocation = (stopped: boolean) => stopped ? "previously-stopped-await-normal-admission" as const : "retained-existing-claim" as const;

function journalKey(environmentId: string, resourceId: string, request: Request) {
  return finalizationDigest({ environmentId, resourceId, offerId: request.offerId, operationId: request.operationId, previousRecipeHash: request.previousRecipeHash, recipeHash: request.recipeHash });
}
/** The evidence a lost acknowledgment must reproduce exactly. The receipt and
 * lock bytes are excluded: a retry may hold a new lock or have saved progress. */
function evidence(proof: ComputeNeonRecoveryProof) {
  const { baselineSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision } = proof;
  return finalizationDigest({ baselineSha256, baselineProviders, providers, reconciliation, stage, previousRecipeHash, recipeHash, offerId, operationId, revision, toolingRevision });
}
/** A retry after a lost acknowledgment may hold a new runtime lock. */
const retryable = ({ lockPid: _pid, ...request }: Request) => request;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().flatMap(key => (value as Record<string, unknown>)[key] === undefined ? [] : [[key, canonical((value as Record<string, unknown>)[key])]]));
  return value;
}
/** Same algorithm as DRA-28 `canonicalDigest` (code-unit key order, undefined dropped). */
export const canonicalSha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
/** The operation binding's inputDigest: the stable request without its lock. */
export const neonRecoveryInputDigest = (request: z.input<typeof ComputeNeonRecovery>) => canonicalSha256(retryable(ComputeNeonRecovery.parse(request)));
/** Identity ignoring progress publication and the owned receipt's later
 * registry publication; nothing physical or authoritative may differ. */
function projectionIdentity(resource: Parameters<typeof finalizationResourceIdentity>[0], proof: ComputeNeonRecoveryProof) {
  const { observed: _observed, observedAt: _at, progress: _progress, providers, ...fields } = z.record(z.string(), z.unknown()).parse(resource.metadata);
  const same = (value: unknown) => finalizationDigest(value) === finalizationDigest(proof.baselineProviders) || finalizationDigest(value) === finalizationDigest(proof.providers);
  return finalizationResourceIdentity({ ...resource, metadata: { ...fields, providers: same(providers) ? proof.baselineProviders : providers } }).identityDigest;
}

async function snapshot(input: Omit<Input, "prisma"> & { prisma: Prisma.TransactionClient }) {
  const { request } = input;
  const owner = await computeTaskOwner(input.prisma, input.taskId, input.config.machine);
  const offer = await input.prisma.computeOffer.findUniqueOrThrow({ where: { id: request.offerId } });
  const environment = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: offer.environmentId } });
  await assertComputeEnvironmentOwner(input.prisma, environment);
  const resource = await input.prisma.remoteTaskResource.findUniqueOrThrow({ where: { taskId_key: { taskId: input.taskId, key: request.resourceKey } } });
  const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata);
  const offers = await input.prisma.computeOffer.findMany({ where: { environmentId: environment.id }, orderBy: { id: "asc" }, take: 1001 });
  const slots = await input.prisma.computeSlot.findMany({ where: { allocationId: { in: offers.map(value => value.id) } }, orderBy: { id: "asc" }, take: 1001 });
  if (offers.length > 1000 || slots.length > 1000) throw new Error("Recovery allocation history exceeds its bound");
  const wait = await input.prisma.computeWait.findUnique({ where: { environmentId: environment.id } });
  const active = offers.filter(o => ["queued", "offered", "validating", "claimed", "running", "unknown"].includes(o.state));
  const lastClaim = offers.filter(value => value.claimedAt).sort((a, b) => b.claimedAt!.getTime() - a.claimedAt!.getTime())[0];
  const retained = ["claimed", "running", "unknown"].includes(offer.state) && !offer.completedAt && active.length === 1 && active[0]!.id === offer.id
    && slots.length === 1 && slots[0]!.allocationId === offer.id && slots[0]!.machineId === input.config.machine;
  const stopped = offer.state === "stopped" && Boolean(offer.completedAt) && environment.state === "suspended" && active.length === 0 && slots.length === 0;
  const intent = await developmentProjection(input);
  if (owner.task.phase === "complete" || intent.developmentBlocked || intent.developmentIntent?.blocked
    || intent.developmentIntent?.action === "stop" && intent.developmentIntent.reason !== "runtime-suspended") throw new Error("Recovery was superseded by a development stop");
  if (retained) await assertComputeStartIntent(input.prisma, input.taskId, environment.id, offer.id);
  const providers = z.array(ProviderReceipt).max(8).safeParse(metadata.providers ?? []);
  if (environment.taskId !== input.taskId || environment.primarySessionId !== owner.session.id || environment.taskIdentity !== owner.identity || environment.machineId !== input.config.machine
    || environment.purpose !== "development" || environment.configuration !== null || environment.key !== request.resourceKey || isSavedComputeEnvironment(environment)
    || resource.kind !== "task-runtime" || resource.purpose !== environment.purpose || resource.state === "released" || environment.resourceId !== resource.id
    || metadata.revision !== environment.revision || metadata.containerId != null || metadata.compute != null || !providers.success || providers.data.some(value => value.released)
    || ![request.previousRecipeHash, request.recipeHash].includes(environment.recipeDigest) || metadata.recipeHash !== environment.recipeDigest
    || offer.environmentId !== environment.id || offer.machineId !== input.config.machine || !offer.claimedAt || lastClaim?.id !== offer.id || !retained && !stopped) {
    throw new Error("Recovery requires the exact container-less runtime and its retained claim or terminal allocation history");
  }
  const operation = input.operation;
  if (operation.contract !== "remote-agent.tooling-operation/v1" || operation.kind !== NeonRecoveryOperationKind || operation.taskId !== input.taskId
    || operation.sessionId !== owner.session.id || operation.repositoryId !== owner.task.repositoryId || operation.release.repositoryId !== owner.task.repositoryId
    || operation.existingOperationId !== request.offerId || operation.resourceKey !== request.resourceKey || operation.inputDigest !== neonRecoveryInputDigest(request)
    || !Revision.safeParse(operation.release.revision).success || !Revision.safeParse(operation.release.tree).success || !path.isAbsolute(operation.release.checkout)) throw new Error("Recovery requires its exact bound tooling operation");
  const key = journalKey(environment.id, resource.id, request);
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owner.session.id, source: `compute:${input.taskId}`, action: Action, key } });
  if (environment.recipeDigest === request.recipeHash && !event) throw new Error("Recovery transition has no durable acknowledgment");
  if (environment.recipeDigest === request.previousRecipeHash && event) throw new Error("Recovery journal and projection disagree");
  if (!event && environment.resourceIdentity !== finalizationResourceIdentity(resource).identityDigest) throw new Error("Recovery resource changed after its last binding");
  const traffic = await input.prisma.computeTraffic.findMany({ where: { environmentId: environment.id }, orderBy: { routeId: "asc" }, take: 1 });
  if (traffic.length) throw new Error("Recovery cannot inherit traffic coverage");
  return { owner, offer, environment, resource, allocations: { offers, slots, wait }, event, key, stopped, intent };
}

/** Integration seam for DRA-29: return the binding that callback admission
 * accepted for this exact request (mode "bound" only; never a legacy
 * continuation or pre-protocol fallback, because this is a new effect kind).
 * This isolated candidate has no binding store, so recovery cannot run. */
export async function admittedNeonRecoveryOperation(_input: { prisma: PrismaClient; header: string | undefined }): Promise<BoundToolingOperation | null> {
  return null;
}

type Execute = typeof executeOwnedObserver;
export type RecoverySourceReader = (task: { worktreePath: string; branchName: string }, baseRevision: string) => Promise<string>;
/** Current source of the exact trusted task worktree: its own top level, on
 * the task's branch, descending from the environment's original revision.
 * Returns HEAD; never resets, checks out or repins anything. */
export async function readRecoverySource(task: { worktreePath: string; branchName: string }, baseRevision: string, execute: Execute = executeOwnedObserver) {
  if (await realpath(task.worktreePath) !== task.worktreePath || !(await lstat(task.worktreePath)).isDirectory()) throw new Error("Recovery worktree is not the task's exact directory");
  const env = { ...Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])), GIT_TERMINAL_PROMPT: "0" };
  const git = async (...args: string[]) => (await execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: task.worktreePath, timeoutMs: 10_000, env })).trim();
  if (await git("rev-parse", "--show-toplevel") !== task.worktreePath) throw new Error("Recovery worktree is not its own repository top level");
  if (await git("symbolic-ref", "-q", "HEAD") !== `refs/heads/${task.branchName}`) throw new Error("Recovery worktree is not on the task branch");
  const head = await git("rev-parse", "--verify", "HEAD^{commit}");
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Recovery worktree revision is unavailable");
  // A non-descendant (rewritten or unrelated) source exits nonzero and refuses.
  await git("merge-base", "--is-ancestor", baseRevision, head);
  return head;
}
/** The bound release's already prepared checkout, verified at its exact
 * revision and tree. Never installs, never reads the active selection or the
 * task pin, and never resolves a session capability (no grant is recorded). */
export async function verifyBoundObserver(release: BoundToolingRelease, execute: Execute = executeOwnedObserver) {
  const git = (...args: string[]) => execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: release.checkout, timeoutMs: 10_000 });
  const manifest = JSON.parse(await git("show", `${release.revision}:.remote-agent-capabilities.json`));
  const relative = z.string().min(1).max(512).parse(manifest.capabilities?.runtime?.adapter);
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Recovery observer path escapes its release");
  if (!manifest.capabilities?.runtime?.observationContracts?.includes(NeonRecoveryContract)) throw new Error("Bound release cannot verify Neon recovery transitions");
  const adapterPath = path.join(release.checkout, relative);
  const check = async () => {
    const root = await realpath(release.checkout), adapter = await realpath(adapterPath), stat = await lstat(adapterPath);
    if (root !== release.checkout || adapter !== adapterPath || !stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o022 || stat.size > 1024 * 1024) throw new Error("Recovery observer identity changed");
    if ((await git("rev-parse", "HEAD")).trim() !== release.revision || (await git("rev-parse", "HEAD^{tree}")).trim() !== release.tree
      || (await git("status", "--porcelain=v1", "--untracked-files=normal")).trim()) throw new Error("Recovery observer checkout is not its bound release");
    const committed = await git("show", `${release.revision}:${relative}`);
    if (!Buffer.from(committed).equals(await readFile(adapterPath))) throw new Error("Recovery observer bytes changed");
    return createHash("sha256").update(committed).digest("hex");
  };
  return { adapterPath, check, adapterSha256: await check() };
}

/** Production reader: executes only the bound release's observer. Binding
 * identity travels in the declared envelope and in process context. */
export async function readNeonRecovery(input: Input, before: Snapshot, dependencies: { verify?: typeof verifyBoundObserver; execute?: Execute } = {}) {
  const execute = dependencies.execute ?? executeOwnedObserver, verify = dependencies.verify ?? verifyBoundObserver;
  const { operation } = input, { release } = operation;
  const observer = await verify(release, execute);
  const request = { version: 1, contract: NeonRecoveryContract, request: input.request,
    operation: { contract: operation.contract, operationId: operation.operationId, kind: operation.kind, generation: operation.generation, inputDigest: operation.inputDigest,
      release: { id: release.id, revision: release.revision, tree: release.tree } },
    task: { id: input.taskId, primarySessionId: before.owner.session.id, worktreePath: before.owner.task.worktreePath, branchName: before.owner.task.branchName, toolingRevision: before.owner.task.toolingRevision },
    environment: { id: before.environment.id, key: before.environment.key, purpose: before.environment.purpose, revision: before.environment.revision, recipeDigest: before.environment.recipeDigest },
    resource: { id: before.resource.id, key: before.resource.key, kind: before.resource.kind, purpose: before.resource.purpose, externalId: before.resource.externalId, metadata: before.resource.metadata },
    allocation: { offerId: before.offer.id, state: before.offer.state, mode: allocation(before.stopped) } };
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Recovery observation input exceeds its bound");
  // Same process context as DRA-29's toolingProcessContext: the Drafted
  // observer guard reads its binding back over the control socket.
  const env = { ...Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    REMOTE_AGENT_TOOLING_OPERATION: operation.operationId, REMOTE_AGENT_SOCKET: input.config.controlIpcPath, REMOTE_AGENT_TASK_ID: operation.taskId, REMOTE_AGENT_SESSION_ID: operation.sessionId };
  const output = await execute([process.execPath, "--no-env-file", observer.adapterPath, "compute", "neon-recovery-observe"], { cwd: release.checkout, timeoutMs: 60_000, env, input: payload });
  if (observer.adapterSha256 !== await observer.check()) throw new Error("Recovery observer changed");
  return { proof: JSON.parse(output), observer: { operationId: operation.operationId, releaseId: release.id, revision: release.revision, tree: release.tree, adapterSha256: observer.adapterSha256 } };
}

function assertAbsence(absence: Exclude<z.infer<typeof Absence>, { basis: "legacy-provider-rejection" }>, attempt: z.infer<typeof Attempt>, observed: number) {
  const requested = Date.parse(attempt.requestedAt);
  if (absence.basis === "provider-rejection") {
    // The provider's own 4xx response to this exact request, journaled with it.
    const rejected = attempt.rejection && definitiveRejections.has(attempt.rejection.status) && Date.parse(attempt.rejection.observedAt);
    if (!rejected || rejected < requested || rejected > requested + requestLifetimeMs || observed < rejected) throw new Error("Neon rejection evidence is not the journaled provider response");
    return;
  }
  // A timer plus a listing does not prove that a transport-unknown create
  // has settled: the provider guarantees neither request settlement nor
  // listing consistency. Until a server-verifiable provider settlement record
  // exists, this basis cannot turn an unknown create into absence; the create
  // stays pending. (Legacy exact retained 4xx evidence remains supported.)
  void absence; void observed;
  throw new Error("Neon inventory alone does not prove a journaled create absent; the pending create is preserved until provider settlement evidence exists");
}

/** Server reads the executed revision's blobs from the bound release's own
 * object store (the tooling repository history), not from the proof. */
export async function readReleaseBlobs(release: BoundToolingRelease, revision: string, execute: Execute = executeOwnedObserver) {
  const git = (...args: string[]) => execute(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: release.checkout, timeoutMs: 10_000 });
  if ((await git("cat-file", "-t", revision)).trim() !== "commit") throw new Error("Legacy source revision is not a commit in the bound release");
  return { "src/runtime-providers.ts": (await git("rev-parse", `${revision}:src/runtime-providers.ts`)).trim(), "src/runtime.ts": (await git("rev-parse", `${revision}:src/runtime.ts`)).trim() };
}

/** A legacy record's corroborating inventory must be current when first
 * committed: at most 15 minutes old by the server's own clock, never in the
 * future. A branch created out of band after an old listing would otherwise
 * be invisible. Replays of a committed event skip only this age check. */
export const LEGACY_INVENTORY_FRESHNESS_MS = 15 * 60_000;
function assertLegacyFreshness(proof: ComputeNeonRecoveryProof, nowMs: number) {
  const legacy = proof.reconciliation.absence;
  if (legacy?.basis !== "legacy-provider-rejection") return;
  const listed = Date.parse(legacy.inventory.listedAt);
  if (!Number.isFinite(nowMs) || listed > nowMs) throw new Error("Legacy Neon rejection evidence is insufficient: the corroborating inventory is dated after the server's evaluation");
  if (nowMs - listed > LEGACY_INVENTORY_FRESHNESS_MS) throw new Error("Legacy Neon rejection evidence is insufficient: the corroborating inventory is older than 15 minutes at the server's evaluation; list again");
}

async function assertLegacyRejection(proof: ComputeNeonRecoveryProof, input: Input, before: Snapshot, blobs: typeof readReleaseBlobs) {
  const { reconciliation } = proof, legacy = reconciliation.absence;
  if (legacy?.basis !== "legacy-provider-rejection") return;
  const fail = (reason: string): never => { throw new Error(`Legacy Neon rejection evidence is insufficient: ${reason}`); };
  type Record = { step: string; detail: string; state: string; updatedAt: string };
  const rejection = (record: Record) => {
    const status = /^Remote dependency POST failed \((\d{3})\)$/.exec(record.detail)?.[1];
    return record.step === "neon" && record.state === "failed" && Boolean(status) && definitiveRejections.has(Number(status));
  };
  const same = (a: Record, b: Record) => a.step === b.step && a.detail === b.detail && a.state === b.state && a.updatedAt === b.updatedAt;
  const progress = legacy.receiptProgress, log = legacy.log;
  // The pinned catch handler records the error under the last progress step,
  // so a Neon-step POST failure with no Neon receipt is the branch create.
  let failure: Record, startedAt: number;
  if (rejection(progress)) failure = progress;
  else {
    if (progress.step !== "neon" || progress.state !== "failed" || progress.detail !== legacyGuard || !log) fail("no retained record of the original provider response");
    failure = log!.events[log!.events.length - 1]!;
  }
  const failedAt = Date.parse(failure.updatedAt);
  if (Date.parse(progress.updatedAt) < failedAt) fail("receipt progress precedes the rejection");
  if (log) {
    const { events, stderr } = log, count = events.length, [running, failed] = [events[count - 2]!, events[count - 1]!], prior = events[count - 3];
    const times = events.map(event => Date.parse(event.updatedAt));
    if (events.some(event => event.taskId !== input.taskId) || times.some((time, index) => index && time < times[index - 1]!)) fail("log belongs to another task or is out of order");
    // Source-derived tail for any flow (fresh or resumed): the Neon create
    // progress immediately precedes its failure; only PlanetScale precedes Neon.
    if (running.step !== "neon" || running.state !== "running" || running.detail !== "Creating a task-owned neon dependency" || !rejection(failed) || stderr.trim() !== failed.detail
      || prior && (prior.step !== "planetscale" || prior.state !== "running")) fail("log does not end in the branch-create rejection");
    if (!same(failed, failure)) fail("log contradicts the receipt's retained failure");
    if (!log.file.includes(`${path.sep}${input.taskId}${path.sep}`) || log.file.startsWith(`${before.owner.task.worktreePath}${path.sep}`)) fail("log is not task-private");
    startedAt = Date.parse(running.updatedAt);
    if (failedAt - startedAt > legacyRequestTimeoutMs) fail("rejection is not bounded by the single request timeout");
  } else startedAt = failedAt - legacyRequestTimeoutMs; // a response at failedAt means the single request was sent within its 30s timeout
  // Server-held projection: the pinned tool publishes each progress record
  // through the owner registry when it saves the receipt. The registry row
  // (database-maintained updatedAt) must still show exactly this record.
  const registered = z.record(z.string(), z.unknown()).parse(before.resource.metadata).progress;
  if (finalizationDigest(registered ?? null) !== finalizationDigest(progress) || before.resource.updatedAt.getTime() < Date.parse(progress.updatedAt)) fail("the owner registry does not hold this receipt's progress record");
  if (legacy.requestName !== reconciliation.name || !proof.baselineProviders.length || proof.baselineProviders.some(value => value.name !== legacy.requestName)) fail("request name is not the task resource name");
  const inventory = legacy.inventory, listed = Date.parse(inventory.listedAt);
  if (inventory.projectId !== reconciliation.projectId || !inventory.branches.some(branch => branch.id === legacy.baselineBranchId)
    || listed < failedAt + requestLifetimeMs || Date.parse(reconciliation.observedAt) < listed || new Set(inventory.branches.map(value => value.id)).size !== inventory.branches.length
    || inventory.branches.some(branch => branch.name === legacy.requestName
      // Any branch created around the request window, whatever its name or
      // parent (a schema-only branch is a root), defeats the absence proof.
      || Date.parse(branch.createdAt) >= startedAt - createdBeforeMs && Date.parse(branch.createdAt) <= failedAt + createdBeforeMs)) fail("inventory does not prove the create absent");
  if (!before.offer.claimedAt || before.offer.claimedAt.getTime() > startedAt) fail("request did not run under this allocation");
  // Executed code: the task pin, or a runtime capability the server granted
  // this primary before the request. Its blobs must be the reviewed ones.
  const pinned = legacy.source.revision === before.owner.task.toolingRevision;
  if (!pinned) {
    const grants = await input.prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: before.owner.session.id, action: "tooling-capability", source: `task:${input.taskId}`, occurredAt: { lte: new Date(startedAt) } }, take: 1001 });
    if (grants.length > 1000 || !grants.some(grant => { const value = JSON.parse(grant.value ?? "{}"); return value.capability === "runtime" && value.capabilityRevision === legacy.source.revision; })) fail("executed revision is neither the task pin nor a granted runtime capability");
  }
  const actual = await blobs(input.operation.release, legacy.source.revision);
  if (finalizationDigest(actual) !== finalizationDigest(legacy.source.blobs) || !ReviewedLegacyNeonSources.some(value => finalizationDigest(value) === finalizationDigest(actual))) fail("executed source is not reviewed for these semantics");
  // Contemporaneous server history: the original primary was executing one
  // turn across the whole request window.
  const turn = await input.prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: before.owner.session.id, occurredAt: { lte: new Date(startedAt) } }, orderBy: [{ occurredAt: "desc" }, { sequence: "desc" }] });
  if (turn?.phase !== "started" || await input.prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: before.owner.session.id, requestId: turn.requestId, phase: { not: "started" }, occurredAt: { lt: new Date(failedAt) } } })) fail("no original primary turn spans the request");
}

function assertProof(proof: ComputeNeonRecoveryProof, input: Input, before: Snapshot) {
  const { request } = input, { reconciliation } = proof;
  if (proof.taskId !== input.taskId || proof.primarySessionId !== before.owner.session.id || proof.toolingRevision !== before.owner.task.toolingRevision
    || proof.environmentId !== before.environment.id || proof.resourceId !== before.resource.id || proof.resourceKey !== request.resourceKey
    || proof.offerId !== request.offerId || proof.operationId !== request.operationId || proof.revision !== before.environment.revision || proof.sourceRevision !== request.sourceRevision
    || proof.previousRecipeHash !== request.previousRecipeHash || proof.recipeHash !== request.recipeHash || proof.lockPid !== request.lockPid) throw new Error("Recovery proof changed ownership");
  const { operation } = input;
  if (proof.operation.operationId !== operation.operationId || proof.operation.releaseId !== operation.release.id || proof.operation.revision !== operation.release.revision
    || proof.operation.tree !== operation.release.tree) throw new Error("Recovery observer is not the bound operation's release");
  const legacy = reconciliation.absence?.basis === "legacy-provider-rejection";
  if (legacy ? request.outcome !== "absent" || reconciliation.attempt || proof.baselineNeonCreateSha256 !== null
    : !reconciliation.attempt || proof.baselineNeonCreateSha256 !== canonicalSha256(reconciliation.attempt)) throw new Error("Neon reconciliation is not the baseline's journaled request");
  const neon = (values: typeof proof.providers) => values.filter(value => value.provider === "neon");
  const others = (values: typeof proof.providers) => finalizationDigest(values.filter(value => value.provider !== "neon"));
  if (neon(proof.baselineProviders).length || proof.baselineProviders.some(value => value.released) || proof.providers.some(value => value.released)
    || others(proof.providers) !== others(proof.baselineProviders) || reconciliation.outcome !== request.outcome) throw new Error("Recovery changed retained provider receipts");
  const observed = Date.parse(reconciliation.observedAt);
  if (request.outcome === "absent") {
    if (proof.stage.pending !== null || reconciliation.branchId || neon(proof.providers).length || finalizationDigest(proof.providers) !== finalizationDigest(proof.baselineProviders)
      || !reconciliation.absence) throw new Error("Neon absence evidence is inconsistent");
    if (reconciliation.absence.basis !== "legacy-provider-rejection") {
      const attempt = reconciliation.attempt!;
      if (attempt.name !== reconciliation.name || attempt.projectId !== reconciliation.projectId || observed < Date.parse(attempt.requestedAt)) throw new Error("Neon reconciliation is not bound to its journaled request");
      assertAbsence(reconciliation.absence, attempt, observed);
    }
  } else {
    const attempt = reconciliation.attempt!;
    if (attempt.name !== reconciliation.name || attempt.projectId !== reconciliation.projectId || observed < Date.parse(attempt.requestedAt)) throw new Error("Neon reconciliation is not bound to its journaled request");
    const [child, ...extra] = neon(proof.providers);
    if (proof.stage.pending !== "create-neon" || !reconciliation.branchId || reconciliation.absence || attempt.rejection || extra.length || !child
      || child.id !== reconciliation.branchId || child.name !== reconciliation.name
      || child.templateBranchId !== attempt.templateBranchId || child.parentId !== attempt.templateBranchId || child.parentLsn !== attempt.parentLsn
      || proof.providers.length !== proof.baselineProviders.length + 1) throw new Error("Owned Neon evidence is inconsistent");
  }
  // The registry may still show the failed receipt's providers, or (after a
  // later ordinary publication) the reconciled ones; nothing else.
  const registered = z.record(z.string(), z.unknown()).parse(before.resource.metadata).providers ?? [];
  if (![proof.baselineProviders, proof.providers].some(value => finalizationDigest(value) === finalizationDigest(registered))) throw new Error("Registered provider receipts changed");
}

/** Atomic projection of the verified child recipe. Lost acknowledgments
 * re-observe and must reproduce the original evidence; they never write. */
export async function recoverComputeNeon(input: Input, read: NeonRecoveryReader = readNeonRecovery, head: RecoverySourceReader = readRecoverySource,
  blobs: typeof readReleaseBlobs = readReleaseBlobs, clock: () => number = Date.now): Promise<ComputeNeonRecoveryResult> {
  if (!input.config.compute?.enabled) throw new Error("Compute admission is disabled");
  input = { ...input, request: ComputeNeonRecovery.parse(input.request) };
  const before = await snapshot(input);
  const source = { worktreePath: before.owner.task.worktreePath!, branchName: before.owner.task.branchName };
  if (await head(source, before.environment.revision) !== input.request.sourceRevision) throw new Error("Recovery source is not the operation's recorded worktree revision");
  const first = await read(input, before), proof = ComputeNeonRecoveryProof.parse(first.proof), observer = ObserverIdentity.parse(first.observer);
  if (observer.operationId !== input.operation.operationId || observer.releaseId !== input.operation.release.id || observer.revision !== input.operation.release.revision
    || observer.tree !== input.operation.release.tree) throw new Error("Recovery observer is not the bound operation's release");
  assertProof(proof, input, before);
  await assertLegacyRejection(proof, input, before, blobs);
  // First commit only: the trusted server clock, never a request or proof value.
  if (!before.event) assertLegacyFreshness(proof, clock());
  const second = await read(input, before);
  if (finalizationDigest(ComputeNeonRecoveryProof.parse(second.proof)) !== finalizationDigest(proof)
    || finalizationDigest(ObserverIdentity.parse(second.observer)) !== finalizationDigest(observer)) throw new Error("Recovery evidence changed during observation");
  if (await head(source, before.environment.revision) !== input.request.sourceRevision) throw new Error("Recovery source changed during observation");
  return input.prisma.$transaction(async tx => {
    // Fresh snapshot: pause, primary/source link, pin, intent, allocation
    // family, wait entry, resource and prior journal must all be unchanged.
    const current = await snapshot({ ...input, prisma: tx });
    const stable = (value: Snapshot) => ({ identity: value.owner.identity, ownerPaused: value.owner.task.ownerPaused, phase: value.owner.task.phase, environment: value.environment,
      resource: value.resource, offer: value.offer, allocations: value.allocations, event: value.event, intent: value.intent });
    if (finalizationDigest(stable(current)) !== finalizationDigest(stable(before))) throw new Error("Recovery authority changed during observation");
    if (current.event) {
      const prior = JSON.parse(current.event.value!);
      if (prior.evidence !== evidence(proof) || finalizationDigest(retryable(prior.request)) !== finalizationDigest(retryable(input.request))
        || finalizationDigest(prior.observer) !== finalizationDigest(observer)) throw new Error("Recovery evidence, operation or observer release changed after acknowledgment");
      if (projectionIdentity(current.resource, proof) !== prior.projectionIdentity) throw new Error("Recovery projection changed its physical or configuration identity");
      return prior.result as ComputeNeonRecoveryResult;
    }
    // Again immediately before the first write: a slow observation cannot age past the bound.
    assertLegacyFreshness(proof, clock());
    const metadata = { ...Metadata.parse(current.resource.metadata), recipeHash: input.request.recipeHash };
    const resource = await tx.remoteTaskResource.update({ where: { id: current.resource.id }, data: { metadata } });
    const identity = finalizationResourceIdentity(resource).identityDigest;
    const result: ComputeNeonRecoveryResult = { environmentId: current.environment.id, resourceId: resource.id, resourceIdentity: identity, offerId: current.offer.id, operationId: input.request.operationId,
      previousRecipeHash: input.request.previousRecipeHash, recipeHash: input.request.recipeHash, sourceRevision: input.request.sourceRevision, outcome: input.request.outcome,
      basis: proof.reconciliation.absence?.basis ?? "exact-owned-child", reconciliationSha256: finalizationDigest(proof.reconciliation), observer, allocation: allocation(current.stopped) };
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.owner.session.id, source: `compute:${input.taskId}`, action: Action, key: current.key,
      value: JSON.stringify({ version: 1, contract: NeonRecoveryContract, transition: NeonRecoveryTransition, taskIdentity: current.owner.identity, request: input.request,
        environment: current.environment, resource: current.resource, offer: current.offer, allocations: current.allocations, operation: input.operation, proof, observer, evidence: evidence(proof),
        projectionIdentity: projectionIdentity(resource, proof), result }) } });
    await tx.computeEnvironment.update({ where: { id: current.environment.id }, data: { recipeDigest: input.request.recipeHash, resourceIdentity: identity } });
    return result;
  });
}
