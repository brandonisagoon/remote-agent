import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Prisma, PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { assertClosedCleanupFamily, assertSettledClosedFamily } from "./closed-cleanup.ts";
import type { BeginToolingOperationRequest, ToolingOperationBinding, ToolingReleaseRecord, ToolingReleaseSelection, ToolingStateFormat } from "../../../../types/tooling-release.ts";
import {
  bindRetainedToolingOperation, bindToolingOperation, canonicalDigest, confirmToolingConsumer, getActiveToolingRelease, readToolingLegacyBoundary, readToolingLegacyConsumer, readToolingOperation, reconcileUnknownAdmissionChild, resolveToolingConsumer, retainToolingConsumer, transitionToolingOperation,
  type ToolingLegacyConsumerInput, type ToolingLegacyConsumerState, type ToolingLegacyInventory,
} from "./tooling-releases.ts";

/** `remote-agent.tooling-operation/v1` adoption (DRA-29). A binding is code
 * identity, never authority: guarded handlers keep every ownership, pause,
 * admission and delivery check. This module stays a leaf: importing the
 * finalization/development graphs creates load cycles. */
export const TOOLING_OPERATION_HEADER = "x-remote-agent-operation";
/** Process context for release-aware adapters the server spawns. Strict old
 * envelopes never gain fields; REMOTE_AGENT_TOOLING_ROOT keeps its task-pin
 * meaning. */
export const TOOLING_OPERATION_ENV = "REMOTE_AGENT_TOOLING_OPERATION";
export const NEXT_OPERATION_ROUTE = "POST /api/sessions/:sessionId/tooling-operations";
/** Mirrors finalization-receipts.ts `FINALIZATION_PREPARED` (pinned by test). */
export const FINALIZATION_PREPARED_ACTION = "finalization-prepared";
const CLEANUP_REQUEST_ACTION = "finalization-cleanup-request", CLEANUP_INSTRUCTION_ACTION = "finalization-cleanup-instruction";
const DEVELOPMENT_INTENT_ACTION = "development-compute-intent";

/** The code an operation or retained consumer runs: a release, or the exact
 * first-bootstrap legacy snapshot. Never the boot configuration once a
 * repository has a legacy boundary. */
export type ToolingCodeIdentity = Pick<ToolingReleaseRecord, "repositoryId" | "revision" | "checkout">;

export const TOOLING_OPERATION_KINDS = ["compute-admission", "compute-configure", "compute-enroll", "development-intent", "finalization", "cleanup-schedule"] as const;
export type ToolingOperationKind = typeof TOOLING_OPERATION_KINDS[number];
/** Existing durable operations. `type` is also DRA-28's legacy consumerKind;
 * finalization and cleanup-request IDs are `<taskId>:<requestKey>`. */
export type ExistingReference = { type: "compute-offer" | "compute-environment" | "finalization" | "development-intent" | "cleanup-request" | "compute-baseline"; id: string };
/** Narrows a begin kind to a callback kind (the only kinds that continue an
 * existing domain record through existingOperationId). */
const isCallbackKind = (kind: string): kind is ToolingOperationKind => (TOOLING_OPERATION_KINDS as readonly string[]).includes(kind);
const EXISTING_TYPE: Record<ToolingOperationKind, ExistingReference["type"]> = {
  "compute-admission": "compute-offer", "compute-configure": "compute-offer", "compute-enroll": "compute-environment",
  "development-intent": "development-intent", finalization: "finalization", "cleanup-schedule": "cleanup-request",
};

/** Root fence for one complete adapter command, bound before its first effect
 * (including effects with no server callback). Callback bindings name it as
 * `parentOperationId` and inherit its release; it is never a callback kind. */
export const ADAPTER_COMMAND_KIND = "adapter-command";
/** One already-owned legacy resource's cleanup on a closed task (contract
 * 7a6fe03). Digest of ClosedResourceReleaseInput {key, action}; cannot parent
 * callbacks or authorize starts, resumes, finalization or migration. */
export const CLOSED_RESOURCE_RELEASE_KIND = "closed-resource-release";
const CLOSED_RELEASE_ACTIONS = ["reconcile", "stop", "release"] as const;
export const BeginToolingOperationInput = z.object({
  requestKey: z.string().trim().min(1).max(256),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum([...TOOLING_OPERATION_KINDS, ADAPTER_COMMAND_KIND, CLOSED_RESOURCE_RELEASE_KIND]),
  existingOperationId: z.string().min(1).max(512).optional(),
  resourceKey: z.string().min(1).max(512).optional(),
  parentOperationId: z.string().min(1).max(256).optional(),
}).strict().refine(value => value.kind !== ADAPTER_COMMAND_KIND || !value.parentOperationId, "An adapter command is a root binding")
  .refine(value => value.kind !== CLOSED_RESOURCE_RELEASE_KIND || (value.resourceKey && !value.parentOperationId && !value.existingOperationId), "A closed resource release names exactly its resourceKey, with no parent or existing operation");

export type ToolingOperationRefusalCode = "operation-required" | "operation-unknown" | "operation-mismatch" | "operation-ownership" | "operation-input" | "operation-closed" | "retained-release-required" | "producer-unknown";
/** Registration may already be durable: the caller must treat the write as
 * unknown (HTTP 503), never as a definite refusal, and receives no receipt. */
export class StateWriteOutcomeUnknown extends Error {
  readonly code = "state-write-outcome-unknown";
  constructor(detail: string) { super(`State write registration outcome is unknown: ${detail}. Reconcile before writing; no authorization receipt was returned.`); }
}
export class ToolingOperationRefused extends Error {
  constructor(readonly code: ToolingOperationRefusalCode, message: string) { super(message); }
}
const refuse = (code: ToolingOperationRefusalCode, detail: string) => new ToolingOperationRefused(code, `${detail}. Begin the next independent operation with ${NEXT_OPERATION_ROUTE} from the release-aware adapter and send its operation ID in ${TOOLING_OPERATION_HEADER}; a cached adapter path cannot start new work on an inactive release.`);

type OwnershipStore = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink">;
/** The open owning task primary on this machine with unrevoked source
 * ownership. Pause policy is the caller's: it differs per boundary. */
export async function assertOpenTaskPrimary(input: { prisma: OwnershipStore; config: ServerConfig; sessionId: string }) {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  // Closure is reported distinctly: it is a lifecycle state, not an ownership mismatch.
  if (task?.phase === "closed") throw new Error("Task is closed; tooling capability resolution and operations are unavailable");
  if (!task || !session || session.role !== "primary" || session.status === "closed" || !task.worktreePath
    || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId
    || task.machineId !== input.config.machine) throw new Error("Only the open owning task primary may use tooling operations");
  const repository = input.config.repositories[task.repositoryId];
  if (!repository || !repository.tooling) throw new Error("Task repository has no configured tooling capability source");
  if (task.issueIdentifier) {
    if (!task.connectionId || !input.config.connections[task.connectionId]) throw new Error("Task connection is no longer configured");
    const link = await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear",
      connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
    if (!link) throw new Error("Task source ownership was revoked");
  }
  return { task, session, repository };
}

const CLOSED_CLEANUP_KINDS: readonly string[] = [ADAPTER_COMMAND_KIND, "finalization"];
/** The only path across closure: the task's own existing cleanup operation
 * (`finalize:<taskId>`, recorded before settled primary closure, family
 * stopped) — the same authority finalization's assertPreparedCleanup uses.
 * Grants no new work; handlers still check the full prepared cleanup. */
/** Shared ownership still binds after closure (cleanup-lifecycle's closed
 * rule): configured repository/connection and the original source link, which
 * closure may have ended but revocation removes. */
async function assertClosedOwnership(prisma: PrismaClient, config: ServerConfig, task: RemoteTask, session: { id: string }) {
  const repository = config.repositories[task.repositoryId];
  if (!repository || !repository.tooling) throw new Error("Task repository has no configured tooling capability source");
  if ((task.connectionId === null) !== (task.issueIdentifier === null)) throw new Error("Closed cleanup source identity is incomplete");
  if (task.issueIdentifier) {
    if (!task.connectionId || !config.connections[task.connectionId]) throw new Error("Task connection is no longer configured");
    const link = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles" } });
    if (!link) throw new Error("Task source ownership was revoked");
  }
}
export async function assertClosedCleanupPrimary(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity"> }) {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  if (!task || !session || task.phase !== "closed" || session.role !== "primary" || !task.worktreePath || session.cwd !== task.worktreePath
    || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || task.machineId !== input.config.machine || task.ownerPaused) throw new Error("Only the closed task's original primary may continue its existing cleanup");
  await assertClosedOwnership(input.prisma, input.config, task, session);
  const operation = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, source: `finalizer:${task.id}`, action: "finalization-cleanup-started", key: `finalize:${task.id}` } });
  await assertClosedCleanupFamily(input.prisma, task, session, operation, input.runtime);
  return { task, session, cleanupKey: `finalize:${task.id}` };
}
/** Closed legacy resource cleanup (contract 7a6fe03): the closed, unpaused,
 * settled original task with shared ownership intact, no finalization history
 * (prepared, cleanup, v2, confirmation) and no non-reference retention, and
 * the exact existing unreleased receipt. Closure alone grants nothing. */
export async function assertClosedLegacyRelease(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; resourceKey: string; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">; admission?: boolean }) {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  if (!task || !session || task.phase !== "closed" || session.role !== "primary" || !task.worktreePath || session.cwd !== task.worktreePath
    || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || task.machineId !== input.config.machine) throw new Error("Only a closed task's original primary may release its legacy resources");
  if (task.ownerPaused) throw new Error("Task is paused by its owner; no resource is released");
  await assertClosedOwnership(input.prisma, input.config, task, session);
  await assertSettledClosedFamily(input.prisma, task, session, input.runtime);
  if (await input.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: session.id, source: `finalizer:${task.id}` } })) throw new Error("This task has finalization history; its resources are released only through finalize:" + task.id);
  if (await input.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: session.id, action: { in: ["finalization-archive-retention", "legacy-evidence-retained"] } } })) throw new Error("This task retains resources; they are released only through its finalization");
  const resource = await input.prisma.remoteTaskResource.findUnique({ where: { taskId_key: { taskId: task.id, key: input.resourceKey } } });
  // Admission needs an unreleased receipt; the bound operation's own release
  // must not revoke its later state record or settlement.
  if (!resource || (input.admission !== false && resource.state === "released")) throw new Error(`Closed task ${task.id} has no unreleased resource ${input.resourceKey}`);
  return { task, session, resource };
}
/** The exact closed-cleanup lineage: a fence naming the task's own cleanup
 * operation as its existing operation. No other command crosses closure. */
const closedCleanupFence = (binding: Pick<ToolingOperationBinding, "kind" | "existingOperationId" | "taskId">) => binding.kind === ADAPTER_COMMAND_KIND && binding.existingOperationId === `finalize:${binding.taskId}`;

type Body = Record<string, unknown>;
type Store = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeMetadataEvent" | "computeOffer" | "computeEnvironment" | "remoteTaskResource">;
type CallbackContext = { store: Store; task: RemoteTask; latestFinalizationKey: () => Promise<string | null>; config?: ServerConfig };
// A bound prepared-finalization callback derives its exact key from the
// finalization its own command lineage prepared; only unbound (legacy) calls
// fall back to the latest preparation. The digest is always checked.
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
const developmentInput = (body: Body) => ({ intentRevision: body.intentRevision, intentDigest: body.intentDigest });

export interface ToolingCallback {
  route: string;
  method: "POST" | "PUT";
  path: RegExp;
  scope: "task" | "session";
  kind: ToolingOperationKind;
  /** Projection whose canonical digest is the binding's inputDigest
   * (undefined: this callback carries no operation input). */
  input: (body: Body, context: CallbackContext) => Promise<unknown> | unknown;
  /** Existing durable operation continued (legacy eligibility; ownership). */
  reference?: (body: Body, context: CallbackContext) => Promise<ExistingReference | null> | ExistingReference | null;
  /** `existing`: must be the binding's existingOperationId or owned by it.
   * `admission`: the offer's environment key must be admitted by this
   * operation. Unset: the input digest pins it (finalization requestKey). */
  referenceRule?: "existing" | "admission";
  /** Environment key admitted (scope only, never producer) before effects. */
  admits?: (body: Body) => string | null;
  /** Environments whose producer becomes this operation once confirmed. */
  produces?: (body: Body, context: CallbackContext) => Promise<string[]>;
  /** Environments that may gain a physical reader through this callback's
   * authority: a pending retained reader is recorded before it runs. */
  retains?: (body: Body, context: CallbackContext) => Promise<string[]>;
  /** Existing protocol evidence that completes the operation on success. */
  completes?: (body: Body) => { kind: string; reference: string } | null;
}

const offer = (body: Body): ExistingReference | null => text(body.offerId) ? { type: "compute-offer", id: body.offerId as string } : null;
const finalizationRef = (context: CallbackContext, requestKey: string | null): ExistingReference | null => requestKey ? { type: "finalization", id: `${context.task.id}:${requestKey}` } : null;
const development = (body: Body): ExistingReference | null => Number.isSafeInteger(body.intentRevision) ? { type: "development-intent", id: String(body.intentRevision) } : null;
const taskPath = (route: string) => new RegExp(`^/api/tasks/([^/]+)/${route}$`);
const sessionPath = (route: string) => new RegExp(`^/api/sessions/([^/]+)/${route}$`);
async function offerEnvironment(context: Pick<CallbackContext, "store" | "task">, offerId: unknown) {
  const row = text(offerId) ? await context.store.computeOffer.findUnique({ where: { id: offerId as string } }) : null;
  const environment = row && await context.store.computeEnvironment.findUnique({ where: { id: row.environmentId } });
  return environment?.taskId === context.task.id ? environment : null;
}
async function resumedEnvironments(body: Body, context: CallbackContext) {
  const revision = Number(body.intentRevision);
  const event = Number.isSafeInteger(revision) ? await context.store.runtimeMetadataEvent.findUnique({ where: { sequence: revision } }) : null;
  if (!event || event.action !== DEVELOPMENT_INTENT_ACTION || event.source !== `development:${context.task.id}`) return [];
  if (z.object({ action: z.string() }).passthrough().safeParse(JSON.parse(event.value ?? "null")).data?.action !== "resume") return [];
  const keys = z.array(z.object({ key: z.string() }).passthrough()).safeParse(body.resources).data?.map(resource => resource.key) ?? [];
  const resources = keys.length ? await context.store.remoteTaskResource.findMany({ where: { taskId: context.task.id, key: { in: keys } } }) : [];
  const environments = resources.length ? await context.store.computeEnvironment.findMany({ where: { taskId: context.task.id, resourceId: { in: resources.map(resource => resource.id) } } }) : [];
  return environments.map(environment => environment.id);
}

const finalizationCallbacks = (["prepare-finalization", "confirm-finalization"] as const).flatMap(route => (["task", "session"] as const).map((scope): ToolingCallback => ({
  route: `POST /api/${scope === "task" ? "tasks/:taskId" : "sessions/:sessionId"}/${route}`, method: "POST", path: scope === "task" ? taskPath(route) : sessionPath(route), scope,
  kind: "finalization", input: body => ({ requestKey: body.requestKey }), reference: (body, context) => finalizationRef(context, text(body.requestKey)),
})));
const requestKeyFinalization = (route: string): ToolingCallback => ({ route: `POST /api/tasks/:taskId/${route}`, method: "POST", path: taskPath(route), scope: "task",
  kind: "finalization", input: body => ({ requestKey: body.requestKey }), reference: (body, context) => finalizationRef(context, text(body.requestKey)) });
const preparedFinalization = (route: string): ToolingCallback => ({ route: `POST /api/sessions/:sessionId/${route}`, method: "POST", path: sessionPath(route), scope: "session",
  kind: "finalization", input: async (_body, context) => ({ requestKey: await context.latestFinalizationKey() }),
  reference: async (_body, context) => finalizationRef(context, await context.latestFinalizationKey()) });
const offerProducer = async (body: Body, context: CallbackContext) => { const environment = await offerEnvironment(context, body.offerId); return environment ? [environment.id] : []; };

/** Bound adapter effect callbacks. TOOLING_CALLBACK_CLASSIFICATION lists
 * every other callback and why it needs no operation. */
export const TOOLING_CALLBACKS: readonly ToolingCallback[] = [
  { route: "POST /api/tasks/:taskId/compute-request", method: "POST", path: taskPath("compute-request"), scope: "task", kind: "compute-admission",
    input: body => body, admits: body => text(body.key) },
  { route: "POST /api/tasks/:taskId/compute-claim", method: "POST", path: taskPath("compute-claim"), scope: "task", kind: "compute-admission",
    input: body => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "offerId")), reference: offer, referenceRule: "admission", retains: offerProducer },
  { route: "POST /api/tasks/:taskId/compute-decline", method: "POST", path: taskPath("compute-decline"), scope: "task", kind: "compute-admission",
    input: () => undefined, reference: offer, referenceRule: "admission", completes: body => text(body.offerId) ? { kind: "compute-decline", reference: body.offerId as string } : null },
  // A bound resource is the confirmed start: only now does the producer move.
  { route: "POST /api/tasks/:taskId/compute-bind", method: "POST", path: taskPath("compute-bind"), scope: "task", kind: "compute-admission",
    input: () => undefined, reference: offer, referenceRule: "admission", produces: offerProducer,
    completes: body => text(body.offerId) ? { kind: "compute-bind", reference: body.offerId as string } : null },
  { route: "POST /api/tasks/:taskId/compute-configure", method: "POST", path: taskPath("compute-configure"), scope: "task", kind: "compute-configure",
    input: body => body, reference: offer, referenceRule: "existing", produces: offerProducer,
    completes: body => text(body.offerId) ? { kind: "compute-configure", reference: body.offerId as string } : null },
  { route: "POST /api/tasks/:taskId/compute-enroll", method: "POST", path: taskPath("compute-enroll"), scope: "task", kind: "compute-enroll",
    input: body => body, reference: body => text(body.environmentId) ? { type: "compute-environment", id: body.environmentId as string } : null, referenceRule: "existing",
    produces: async body => text(body.environmentId) ? [body.environmentId as string] : [],
    completes: body => text(body.environmentId) ? { kind: "compute-enroll", reference: body.environmentId as string } : null },
  { route: "POST /api/tasks/:taskId/development-authority", method: "POST", path: taskPath("development-authority"), scope: "task", kind: "development-intent",
    input: developmentInput, reference: development, referenceRule: "existing" },
  { route: "POST /api/tasks/:taskId/development-complete", method: "POST", path: taskPath("development-complete"), scope: "task", kind: "development-intent",
    input: developmentInput, reference: development, referenceRule: "existing", produces: resumedEnvironments,
    completes: body => Number.isSafeInteger(body.intentRevision) ? { kind: "development-complete", reference: String(body.intentRevision) } : null },
  ...finalizationCallbacks,
  requestKeyFinalization("cleanup-authority"),
  requestKeyFinalization("cleanup-progress"),
  requestKeyFinalization("cleanup-status"),
  requestKeyFinalization("cleanup-report"),
  requestKeyFinalization("cleanup-inventory-ownership"),
  preparedFinalization("browser-stop-authority"),
  preparedFinalization("archive-retention"),
  preparedFinalization("legacy-evidence"),
  // Queues and delivers a provider turn: a provider effect, so it is bound.
  { route: "POST /api/tasks/:taskId/cleanup-request", method: "POST", path: taskPath("cleanup-request"), scope: "task", kind: "cleanup-schedule",
    input: body => body, reference: (body, context) => text(body.requestKey) ? { type: "cleanup-request", id: `${context.task.id}:${body.requestKey}` } : null,
    completes: body => text(body.requestKey) ? { kind: "cleanup-request", reference: body.requestKey as string } : null },
];
const LOCAL_SERVICE_STOP: Record<"development" | "finalization", ToolingCallback> = {
  development: { route: "POST /api/sessions/:sessionId/local-service-stop-authority", method: "POST", path: sessionPath("local-service-stop-authority"), scope: "session",
    kind: "development-intent", input: body => developmentInput((body.development ?? {}) as Body), reference: body => development((body.development ?? {}) as Body), referenceRule: "existing" },
  finalization: preparedFinalization("local-service-stop-authority"),
};

/** Every adapter/session callback and its rule. `operation` rows are
 * TOOLING_CALLBACKS; every other row demonstrably runs no tooling executable
 * itself, or only records evidence inside a guarded operation. */
export const TOOLING_CALLBACK_CLASSIFICATION = [
  ...TOOLING_CALLBACKS.map(callback => ({ route: callback.route, rule: "operation" as const, kind: callback.kind as string })),
  { route: "POST /api/sessions/:sessionId/local-service-stop-authority", rule: "operation" as const, kind: "development-intent (with development) | finalization" },
  { route: "PUT /api/sessions/:sessionId/task/resources", rule: "evidence" as const, kind: "optional; validated when present",
    reason: "Records resource receipts only; cleanup/development transitions keep their executing-turn and intent checks. Ordinary evidence registration is never blocked." },
  { route: "POST /api/tasks/:taskId/automation", rule: "owner-control" as const, kind: "none",
    reason: "Pause/close/stop cancel work, resume clears a flag, development requests only record intent; the handler runs no adapter or provider start. Recorded intents execute through bound development callbacks." },
  { route: "POST /api/sessions/:sessionId/tooling-capability", rule: "resolution" as const, kind: "none",
    reason: "Returns instructions and an immutable adapter path and never executes it. Uses the guarded binding, else the active generation at this independent boundary; bound resolution never installs." },
  { route: "POST /api/sessions/:sessionId/tooling-operations", rule: "identity" as const, kind: "none", reason: "Persists identity before effects; grants no authority." },
  { route: "POST|PUT /api/sessions/:sessionId/{issue-update,question,source-reply,reply-context,child-issue-update,source-attachment,work-graph,plan,threads,delegate}", rule: "session-tool" as const, kind: "none",
    reason: "Agent session tools keep their own source/primary authority and never run tooling executables." },
  { route: "GET *", rule: "read" as const, kind: "none", reason: "Read-only projections; they cannot start any effect." },
] as const;

export function matchToolingCallback(method: string, pathname: string, body?: Body): { callback: ToolingCallback; param: string } | null {
  if (method === "POST" && sessionPath("local-service-stop-authority").test(pathname)) {
    const callback = body && typeof body.development === "object" && body.development !== null ? LOCAL_SERVICE_STOP.development : LOCAL_SERVICE_STOP.finalization;
    return { callback, param: decodeURIComponent(callback.path.exec(pathname)![1]!) };
  }
  for (const callback of TOOLING_CALLBACKS) {
    const match = callback.method === method ? callback.path.exec(pathname) : null;
    if (match) return { callback, param: decodeURIComponent(match[1]!) };
  }
  return null;
}
const RESOURCE_REGISTRATION = sessionPath("task/resources");
export const isToolingCallbackPath = (method: string, pathname: string) => method === "PUT" && RESOURCE_REGISTRATION.test(pathname)
  || method !== "GET" && (sessionPath("local-service-stop-authority").test(pathname) || TOOLING_CALLBACKS.some(callback => callback.method === method && callback.path.test(pathname)));

export type ToolingOperationDependencies = {
  active: (input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string }) => Promise<ToolingReleaseSelection | null>;
  bind: (input: { prisma: PrismaClient; config: ServerConfig; taskId: string; sessionId: string; turnId: string | null; request: BeginToolingOperationRequest }) => Promise<ToolingOperationBinding>;
  read: (input: { prisma: PrismaClient; operationId: string }) => Promise<ToolingOperationBinding | null>;
  transition: typeof transitionToolingOperation;
  boundary: (input: { prisma: PrismaClient; repositoryId: string }) => Promise<{ recordedAt: Date } | null>;
  legacy: (input: { prisma: PrismaClient; repositoryId: string; consumerKind: string; consumerId: string }) => Promise<ToolingLegacyConsumerState>;
  digest: (value: unknown) => string;
};
export const toolingOperationDependencies: ToolingOperationDependencies = {
  active: getActiveToolingRelease, bind: bindToolingOperation, read: readToolingOperation, transition: transitionToolingOperation,
  boundary: readToolingLegacyBoundary, legacy: readToolingLegacyConsumer, digest: canonicalDigest,
};

/** Request scope set only by the guarded callback boundary. A legacy
 * continuation carries its exact first-bootstrap snapshot. */
type Scope = { binding: ToolingOperationBinding; socket?: string } | { legacy: ExistingReference; code: ToolingCodeIdentity | null };
const scope = new AsyncLocalStorage<Scope>();
export const runWithToolingOperation = <T>(binding: ToolingOperationBinding, operation: () => Promise<T>, socket?: string) => scope.run({ binding, ...(socket ? { socket } : {}) }, operation);
/** Complete bound process context for a release-aware adapter or observer:
 * the operation plus the control socket, task and primary session it must
 * call back with. Empty for unbound (legacy) processes. */
export function toolingProcessContext(binding: Pick<ToolingOperationBinding, "operationId" | "taskId" | "sessionId"> | null | undefined, socket?: string): Record<string, string> {
  if (!binding) return {};
  const scoped = scope.getStore(), controlSocket = socket ?? (scoped && "binding" in scoped ? scoped.socket : undefined);
  if (!controlSocket) throw new Error(`Bound process for operation ${binding.operationId} has no control socket`);
  return { [TOOLING_OPERATION_ENV]: binding.operationId, REMOTE_AGENT_SOCKET: controlSocket, REMOTE_AGENT_TASK_ID: binding.taskId, REMOTE_AGENT_SESSION_ID: binding.sessionId };
}
export const runAsLegacyContinuation = <T>(reference: ExistingReference, code: ToolingCodeIdentity | null, operation: () => Promise<T>) => scope.run({ legacy: reference, code }, operation);
export const currentToolingOperation = (): ToolingOperationBinding | undefined => { const value = scope.getStore(); return value && "binding" in value ? value.binding : undefined; };
export const inLegacyContinuation = () => { const value = scope.getStore(); return Boolean(value && "legacy" in value); };
/** Explicit identity, else the request scope (legacy snapshot or binding).
 * Undefined means no scope: only an outer independent boundary may select. */
export function boundCode(explicit?: ToolingCodeIdentity | null): ToolingCodeIdentity | null | undefined {
  if (explicit !== undefined) return explicit;
  const value = scope.getStore();
  if (!value) return undefined;
  return "legacy" in value ? value.code : value.binding.release;
}

// Association receipts: append-only metadata on the original primary.
// owner — the operation that owns an existing receipt (first record wins);
// admission — the operation that admitted an environment key (scope only);
// producer — intent before the effect, confirmed/failed after. A newest
// producer intent without an outcome is an unknown effect: fail closed.
const ASSOCIATION = "tooling-operation-association";
const Association = z.object({ version: z.literal(1), operationId: z.string(), role: z.enum(["owner", "admission", "producer", "completion", "outcome"]), state: z.enum(["intent", "confirmed", "failed", "acknowledged", "refused", "unknown", "reconciled"]), attemptId: z.string().optional(), evidence: z.string().optional() }).passthrough();
type Role = z.infer<typeof Association>["role"];
const associationKey = (role: Role, id: string) => `${role}:${id}`;
const referenceId = (reference: Pick<ExistingReference, "type" | "id">) => `${reference.type}:${reference.id}`;
async function associations(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, role: Role, id: string) {
  if (!task.primarySessionId) return [];
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `tooling-operation:${task.id}`, action: ASSOCIATION, key: associationKey(role, id) }, orderBy: { sequence: "desc" }, take: 64 });
  return events.map(event => Association.parse(JSON.parse(event.value ?? "null")));
}
/** One record per callback attempt: `intent` before its handler, then its
 * own definite outcome. Settlement trusts only the latest attempt's own
 * acknowledgment, so an older slow acknowledgment never covers a newer
 * in-flight or unknown attempt. */
async function recordCallbackOutcome(store: Pick<PrismaClient, "runtimeMetadataEvent">, binding: ToolingOperationBinding, route: string, attemptId: string, state: "intent" | "acknowledged" | "refused" | "unknown", status: number | null) {
  await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: binding.sessionId, source: `tooling-operation:${binding.taskId}`, action: ASSOCIATION, key: associationKey("outcome", binding.operationId),
    value: JSON.stringify({ version: 1, operationId: binding.operationId, role: "outcome", state, attemptId, route, inputDigest: binding.inputDigest, requestKey: binding.requestKey, status }) } });
}
/** One operation's callback attempt records, newest first, bounded (overflow
 * refuses rather than dropping an older attempt). */
const AttemptRecord = z.object({ state: z.string(), attemptId: z.string(), operationId: z.string(), inputDigest: z.string(), route: z.string().optional(),
  status: z.number().nullable().optional(), acknowledgedAttemptId: z.string().optional() }).passthrough();
async function attemptRecords(store: Pick<PrismaClient, "runtimeMetadataEvent">, binding: { sessionId: string; taskId: string }, operationId: string) {
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: binding.sessionId, source: `tooling-operation:${binding.taskId}`, action: ASSOCIATION, key: associationKey("outcome", operationId) }, orderBy: { sequence: "desc" }, take: 1001 });
  if (events.length > 1000) throw refuse("operation-input", `Callback attempt history of ${operationId} exceeds its bound`);
  return events.map(event => ({ sequence: event.sequence, value: AttemptRecord.safeParse(JSON.parse(event.value ?? "null")).data }));
}
const REQUEST_ROUTE = "POST /api/tasks/:taskId/compute-request";
/** A reconciliation record is valid only when it names an earlier unknown
 * compute-request attempt of this operation and a LATER acknowledged 2xx
 * compute-request attempt with the same request digest. */
function validReconciliation(records: Awaited<ReturnType<typeof attemptRecords>>, attemptId: string, operation: { id: string; inputDigest: string }) {
  const values = records.flatMap(record => record.value ? [{ ...record.value, sequence: record.sequence }] : []);
  const intentOf = (id: string) => values.find(value => value.attemptId === id && value.state === "intent");
  const original = intentOf(attemptId);
  if (!original || original.route !== REQUEST_ROUTE || !values.some(value => value.attemptId === attemptId && value.state === "unknown" && value.route === REQUEST_ROUTE)) return false;
  return values.some(value => {
    if (value.state !== "reconciled" || value.attemptId !== attemptId || value.operationId !== operation.id || value.inputDigest !== operation.inputDigest || !value.acknowledgedAttemptId) return false;
    const replay = intentOf(value.acknowledgedAttemptId);
    const acknowledged = values.find(entry => entry.attemptId === value.acknowledgedAttemptId && entry.state === "acknowledged");
    return Boolean(replay && acknowledged && replay.route === REQUEST_ROUTE && acknowledged.route === REQUEST_ROUTE && replay.sequence > original.sequence
      && typeof acknowledged.status === "number" && acknowledged.status >= 200 && acknowledged.status < 300);
  });
}
/** Settled callback history: every recorded attempt has a definite result
 * (acknowledged or refused) and the latest attempt is acknowledged. An older
 * in-flight or unknown attempt never disappears behind a newer
 * acknowledgment; it needs reconciliation first. The only accepted
 * reconciliation is a validated link from an unknown compute-request attempt
 * to a later exact acknowledged replay; the original attempt is kept. */
async function latestAttemptAcknowledged(store: Pick<PrismaClient, "runtimeMetadataEvent">, binding: { sessionId: string; taskId: string }, operation: { id: string; inputDigest: string }) {
  const records = await attemptRecords(store, binding, operation.id);
  if (records.some(record => !record.value)) return false;
  const values = records.map(record => record.value!);
  if (values.some(value => value.operationId !== operation.id || value.inputDigest !== operation.inputDigest)) return false;
  const intents = values.filter(value => value.state === "intent");
  if (!intents.length) return false;
  for (const intent of intents) {
    const results = values.filter(value => value.attemptId === intent.attemptId && value.state !== "intent" && value.state !== "reconciled").map(value => value.state);
    if (!results.length) return false;
    if (results.includes("unknown") && !validReconciliation(records, intent.attemptId, operation)) return false;
  }
  return values.some(value => value.attemptId === intents[0]!.attemptId && value.state === "acknowledged");
}
async function recordAssociation(store: Pick<PrismaClient, "runtimeMetadataEvent">, binding: Pick<ToolingOperationBinding, "operationId" | "taskId" | "sessionId" | "kind" | "generation">, role: Role, id: string, state: "intent" | "confirmed" | "failed", evidence?: string) {
  await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: binding.sessionId, source: `tooling-operation:${binding.taskId}`, action: ASSOCIATION, key: associationKey(role, id),
    value: JSON.stringify({ version: 1, operationId: binding.operationId, role, state, kind: binding.kind, generation: binding.generation, ...(evidence ? { evidence } : {}) }) } });
}
/** Same lineage: the operation itself, or a sibling callback of the same
 * adapter command (and therefore the same retained release). */
async function sameLineage(store: PrismaClient, operationId: string, binding: Pick<ToolingOperationBinding, "operationId" | "parentOperationId">, read: ToolingOperationDependencies["read"]) {
  if (operationId === binding.operationId) return true;
  if (!binding.parentOperationId) return false;
  return (await read({ prisma: store, operationId }))?.parentOperationId === binding.parentOperationId;
}
/** Finalization request key owned by this binding's command lineage. */
async function lineageFinalizationKey(store: PrismaClient, task: RemoteTask, binding: Pick<ToolingOperationBinding, "operationId" | "parentOperationId">, read: ToolingOperationDependencies["read"]) {
  if (!task.primarySessionId) return null;
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `tooling-operation:${task.id}`, action: ASSOCIATION, key: { startsWith: `owner:finalization:${task.id}:` } }, orderBy: { sequence: "desc" }, take: 64 });
  for (const event of events) {
    const value = Association.safeParse(JSON.parse(event.value ?? "null"));
    if (value.success && await sameLineage(store, value.data.operationId, binding, read)) return event.key.slice(`owner:finalization:${task.id}:`.length);
  }
  return null;
}
/** The first recorded owner (lowest sequence) is the owner: a concurrent
 * second claim loses deterministically, whatever its insertion order. */
export async function owningOperationId(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, reference: ExistingReference) {
  if (!task.primarySessionId) return null;
  const first = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `tooling-operation:${task.id}`, action: ASSOCIATION, key: associationKey("owner", referenceId(reference)) }, orderBy: { sequence: "asc" } });
  return first ? Association.parse(JSON.parse(first.value ?? "null")).operationId : null;
}
/** Claim ownership, then re-read: only the first recorded owner (or its
 * command lineage) proceeds to effects. */
async function claimOwnership(prisma: PrismaClient, binding: ToolingOperationBinding, task: RemoteTask, reference: ExistingReference, read: ToolingOperationDependencies["read"]) {
  if (!await owningOperationId(prisma, task, reference)) await recordAssociation(prisma, binding, "owner", referenceId(reference), "confirmed");
  const owner = await owningOperationId(prisma, task, reference);
  if (!owner || !await sameLineage(prisma, owner, binding, read)) throw refuse("operation-mismatch", `${reference.type} ${reference.id} belongs to operation ${owner}`);
}
/** Admissions in newest-first order of each operation's latest record. Only
 * exact domain proof marks one `failed` (it never admitted anything); an
 * `intent` without an outcome may have, so it still counts (fail closed).
 * The whole bounded history is read: overflow refuses rather than dropping
 * an older holder. */
const ADMISSION_HISTORY_BOUND = 1000;
async function admissionHistory(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, environmentKey: string) {
  if (!task.primarySessionId) return [];
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `tooling-operation:${task.id}`, action: ASSOCIATION,
    key: associationKey("admission", `environment-key:${environmentKey}`) }, orderBy: { sequence: "desc" }, take: ADMISSION_HISTORY_BOUND + 1 });
  if (events.length > ADMISSION_HISTORY_BOUND) throw refuse("operation-input", `Admission history of environment key ${environmentKey} exceeds its bound; reconcile it before any admission`);
  const latest = new Map<string, z.infer<typeof Association>["state"]>();
  for (const value of events.map(event => Association.parse(JSON.parse(event.value ?? "null")))) if (!latest.has(value.operationId)) latest.set(value.operationId, value.state);
  return [...latest].filter(([, state]) => state !== "failed").map(([operationId, state]) => ({ operationId, state }));
}
async function admittingOperationId(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, environmentKey: string) {
  return (await admissionHistory(store, task, environmentKey))[0]?.operationId ?? null;
}
type AdmissionStore = PrismaClient | Prisma.TransactionClient;
/** The newest admission of another command lineage: what this binding's
 * admission would supersede. */
async function priorAdmission(store: AdmissionStore, task: RemoteTask, environmentKey: string, binding: ToolingOperationBinding, read: ToolingOperationDependencies["read"]) {
  for (const value of await admissionHistory(store, task, environmentKey)) {
    if (!await sameLineage(store as PrismaClient, value.operationId, binding, read)) return value;
  }
  return null;
}
const commandOf = async (store: AdmissionStore, operation: ToolingOperationBinding, read: ToolingOperationDependencies["read"]) =>
  operation.parentOperationId ? read({ prisma: store as PrismaClient, operationId: operation.parentOperationId }) : operation;
/** A cross-release compute-request may not take over an environment key that
 * another lineage still genuinely holds: its admitting command is not settled,
 * an offer is live, or a producer is unknown or still has a live reader.
 * Returns the refusal reason, or null. Same-release re-admission is unchanged. */
async function admissionHeld(store: AdmissionStore, task: RemoteTask, environmentKey: string, binding: ToolingOperationBinding, read: ToolingOperationDependencies["read"], ownIntentWritten = false) {
  // The CURRENT holder decides: the newest admission, or (once this
  // operation's own intent is written, holding the write lock) the one it
  // supersedes. The caller's own lineage holding it is its own retry or
  // sibling, never a conflict; an older holder it already superseded is
  // history. Checked even before any environment row exists: a first request
  // whose domain create has not happened yet still holds the key.
  const history = await admissionHistory(store, task, environmentKey);
  if (ownIntentWritten && history[0]?.operationId !== binding.operationId) return `Admission of environment key ${environmentKey} changed while it was recorded`;
  const prior = history[ownIntentWritten ? 1 : 0];
  if (!prior || await sameLineage(store as PrismaClient, prior.operationId, binding, read)) return null;
  const original = await read({ prisma: store as PrismaClient, operationId: prior.operationId });
  if (!original) return `Environment key ${environmentKey} was admitted by unknown operation ${prior.operationId}`;
  if (original.release.id === binding.release.id) return null;
  const held = `Environment key ${environmentKey} is held by operation ${original.operationId} (release ${original.release.revision})`;
  const command = await commandOf(store, original, read);
  if (!command || command.status !== "completed") return `${held}: its command is ${command?.status ?? "missing"}`;
  if (prior.state !== "confirmed") return `${held}: its admission outcome is unknown`;
  const environment = await store.computeEnvironment.findUnique({ where: { taskId_key: { taskId: task.id, key: environmentKey } } });
  if (!environment) return null;
  if (await store.computeOffer.count({ where: { environmentId: environment.id, state: { in: ACTIVE_OFFERS } } })) return `${held}: an offer is live`;
  try { await producerOperationId(store, task, environment.id); } catch { return `${held}: its producer outcome is unknown`; }
  if (await store.toolingRetainedConsumer.count({ where: { consumerKind: "compute-environment", consumerId: environment.id, status: { in: ["pending", "confirmed"] } } })) return `${held}: a reader is retained`;
  return null;
}
/** Eligibility of a never-produced waiting offer for adoption by another
 * release's lineage (offers delivered after an activation tell the primary to
 * use the active release). Only exact waiting work that never started and
 * whose admitting command definitively settled. Returns the refusal, or null. */
async function adoptionRefused(store: AdmissionStore, task: RemoteTask, offerId: string, binding: Pick<ToolingOperationBinding, "operationId" | "parentOperationId" | "release" | "inputDigest">,
  dependencies: Pick<ToolingOperationDependencies, "read" | "legacy">, body?: Body) {
  const offer = await store.computeOffer.findUnique({ where: { id: offerId } });
  const environment = offer ? await store.computeEnvironment.findUnique({ where: { id: offer.environmentId } }) : null;
  const current = await store.remoteTask.findUnique({ where: { id: task.id } });
  if (!offer || !environment || !current || environment.taskId !== current.id || environment.primarySessionId !== current.primarySessionId || current.primarySessionId !== task.primarySessionId) return "The offer's environment does not belong to this task's primary";
  if (current.ownerPaused || current.phase === "closed") return "Task is paused or closed";
  if (body && (["key", "purpose", "revision", "recipeDigest"] as const).some(key => body[key] !== environment[key])) return "The claim does not match the waiting environment's recipe and revision";
  const prior = await priorAdmission(store, current, environment.key, binding as ToolingOperationBinding, dependencies.read);
  if (!prior) return "The offer has no admitting operation to adopt";
  const original = await dependencies.read({ prisma: store as PrismaClient, operationId: prior.operationId });
  if (!original || prior.state !== "confirmed" || original.release.id === binding.release.id || original.inputDigest !== binding.inputDigest) return `Offer ${offerId} belongs to operation ${prior.operationId}`;
  const command = await commandOf(store, original, dependencies.read);
  if (!command || command.status !== "completed") return `Admitting command ${command?.operationId ?? prior.operationId} has not settled`;
  if (offer.claimedAt !== null || !["queued", "offered"].includes(offer.state)) return `Offer ${offerId} is ${offer.state}`;
  if (await store.computeOffer.count({ where: { environmentId: environment.id, OR: [{ claimedAt: { not: null } }, { state: { in: ["validating", "claimed", "running", "unknown"] } }] } })) return `Environment ${environment.id} has a claimed effect`;
  for (const reference of [{ type: "compute-offer", id: offerId }, { type: "compute-environment", id: environment.id }] as const) {
    if (await owningOperationId(store, current, reference)) return `${reference.type} ${reference.id} has an owner`;
    const legacy = await dependencies.legacy({ prisma: store as PrismaClient, repositoryId: current.repositoryId, consumerKind: reference.type, consumerId: reference.id });
    if (legacy.status === "legacy" || legacy.status === "unavailable") return `${reference.type} ${reference.id} is a retained first-bootstrap legacy consumer`;
  }
  if ((await associations(store, current, "producer", `compute-environment:${environment.id}`)).length) return `Environment ${environment.id} has a producer`;
  if (await store.toolingRetainedConsumer.count({ where: { consumerKind: "compute-environment", consumerId: environment.id, status: { in: ["pending", "confirmed"] } } })) return `Environment ${environment.id} has a retained reader`;
  return null;
}
/** Confirmed producer of a resource group, or null if none. Throws on a
 * newest producer change without an outcome; retrying that exact operation
 * reconciles it — newer code is never selected instead. */
export async function producerOperationId(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, environmentId: string) {
  const all = await associations(store, task, "producer", `compute-environment:${environmentId}`);
  const settled = new Set(all.filter(value => value.state !== "intent").map(value => value.operationId));
  for (const value of all) {
    if (value.state === "confirmed") return value.operationId;
    if (value.state === "intent" && !settled.has(value.operationId)) throw new ToolingOperationRefused("producer-unknown", `Compute environment ${environmentId} has an unconfirmed producer change by ${value.operationId}; retry that operation to reconcile it`);
  }
  return null;
}

/** Code for an existing consumer: its confirmed producer/owner binding, else
 * its exact retained first-bootstrap snapshot. Before any boundary the
 * pre-protocol configured revision applies (null). `unstarted` is the
 * admitting binding of a group that has never been started. Anything else
 * fails closed — the active release is never borrowed. */
export async function resourceGroupCode(input: { prisma: PrismaClient; task: RemoteTask; reference: ExistingReference; unstarted?: ToolingOperationBinding },
  dependencies: Pick<ToolingOperationDependencies, "read" | "legacy"> = toolingOperationDependencies): Promise<{ code: ToolingCodeIdentity | null; binding: ToolingOperationBinding | null }> {
  const operationId = input.reference.type === "compute-environment" ? await producerOperationId(input.prisma, input.task, input.reference.id) : await owningOperationId(input.prisma, input.task, input.reference);
  if (operationId) {
    const binding = await dependencies.read({ prisma: input.prisma, operationId });
    if (!binding || binding.taskId !== input.task.id || binding.release.repositoryId !== input.task.repositoryId) throw new Error("Producing tooling operation does not belong to this task");
    return { code: binding.release, binding };
  }
  const consumer = await dependencies.legacy({ prisma: input.prisma, repositoryId: input.task.repositoryId, consumerKind: input.reference.type, consumerId: input.reference.id });
  if (consumer.status === "no-boundary") return { code: null, binding: null };
  if (consumer.status === "legacy" && consumer.taskId === input.task.id) return { code: { repositoryId: input.task.repositoryId, revision: consumer.revision, checkout: consumer.checkout }, binding: null };
  if (consumer.status === "not-legacy" && input.unstarted && input.unstarted.taskId === input.task.id) return { code: input.unstarted.release, binding: input.unstarted };
  throw new ToolingOperationRefused("producer-unknown", `${input.reference.type} ${input.reference.id} has no bound producer or retained legacy snapshot (${consumer.status})`);
}

async function latestPreparedFinalization(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: RemoteTask) {
  if (!task.primarySessionId) return null;
  return store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_PREPARED_ACTION }, orderBy: { sequence: "desc" } });
}
export async function latestFinalizationReference(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: RemoteTask): Promise<ExistingReference | null> {
  const prepared = await latestPreparedFinalization(store, task);
  return prepared ? { type: "finalization", id: `${task.id}:${prepared.key}` } : null;
}

/** Legacy eligibility: only an exact retained first-bootstrap consumer. A
 * post-boundary server-recorded suspension of a retained legacy group runs
 * that group's own snapshot. */
async function legacySnapshot(input: { prisma: PrismaClient; task: RemoteTask; reference: ExistingReference }, dependencies: ToolingOperationDependencies): Promise<ToolingCodeIdentity | null> {
  const read = async (reference: ExistingReference) => {
    const consumer = await dependencies.legacy({ prisma: input.prisma, repositoryId: input.task.repositoryId, consumerKind: reference.type, consumerId: reference.id });
    return consumer.status === "legacy" && consumer.taskId === input.task.id ? { repositoryId: input.task.repositoryId, revision: consumer.revision, checkout: consumer.checkout } : null;
  };
  const direct = await read(input.reference);
  if (direct || input.reference.type !== "development-intent") return direct;
  const event = await input.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: Number(input.reference.id) } });
  if (!event || event.action !== DEVELOPMENT_INTENT_ACTION || event.source !== `development:${input.task.id}` || event.runtimeSessionId !== input.task.primarySessionId) return null;
  const suspension = z.object({ reason: z.literal("runtime-suspended"), suspension: z.object({ environmentId: z.string() }).passthrough() }).passthrough().safeParse(JSON.parse(event.value ?? "null"));
  return suspension.success ? read({ type: "compute-environment", id: suspension.data.suspension.environmentId }) : null;
}

export type CallbackAdmission =
  | { mode: "pre-protocol" }
  | { mode: "evidence"; binding: ToolingOperationBinding }
  | { mode: "legacy-continuation"; reference: ExistingReference; code: ToolingCodeIdentity }
  | { mode: "bound"; binding: ToolingOperationBinding; callback: ToolingCallback; body: Body; context: CallbackContext; reference?: ExistingReference;
    /** A claim adopting a never-produced waiting environment admitted by another settled release lineage. */
    adopt?: { environmentKey: string; offerId: string } };

async function callbackTask(store: Store, callback: Pick<ToolingCallback, "scope">, param: string) {
  return callback.scope === "task" ? store.remoteTask.findUnique({ where: { id: param } }) : store.remoteTask.findUnique({ where: { primarySessionId: param } });
}
const PAUSE_BLOCKED: readonly string[] = ["compute-admission", "compute-configure", "compute-enroll", "cleanup-schedule"];

/** Current authority for a bound callback; repeated immediately before the
 * handler so an await cannot carry a stale owner/pause/source decision. */
async function assertBindingAuthority(input: { prisma: PrismaClient; config: ServerConfig; binding: ToolingOperationBinding }) {
  const task = await input.prisma.remoteTask.findUnique({ where: { id: input.binding.taskId } });
  if (!task || task.primarySessionId !== input.binding.sessionId || task.repositoryId !== input.binding.repositoryId) throw refuse("operation-ownership", "The operation no longer belongs to this task's primary session");
  if (input.binding.kind === CLOSED_RESOURCE_RELEASE_KIND) {
    try { await assertClosedLegacyRelease({ prisma: input.prisma, config: input.config, sessionId: input.binding.sessionId, resourceKey: input.binding.resourceKey ?? "", admission: false }); }
    catch (error) { throw refuse("operation-ownership", error instanceof Error ? error.message : String(error)); }
    return task;
  }
  if (input.binding.kind !== "finalization") {
    try {
      if (task.phase === "closed" && input.binding.kind === ADAPTER_COMMAND_KIND) {
        if (!closedCleanupFence(input.binding)) throw new Error("Only the task's own cleanup command continues after closure");
        await assertClosedCleanupPrimary({ prisma: input.prisma, config: input.config, sessionId: input.binding.sessionId });
      }
      else await assertOpenTaskPrimary({ prisma: input.prisma, config: input.config, sessionId: input.binding.sessionId });
    }
    catch (error) { throw refuse("operation-ownership", error instanceof Error ? error.message : String(error)); }
  }
  if (task.ownerPaused && PAUSE_BLOCKED.includes(input.binding.kind)) throw refuse("operation-ownership", "Task is paused by its owner; no tooling effect starts");
  return task;
}

/** Validate an adapter callback before its handler. Without a release-aware
 * generation: pre-protocol behavior. Afterward a header naming an exact,
 * open, matching binding is required; only a retained first-bootstrap legacy
 * consumer may continue without one. */
export async function admitToolingCallback(input: { prisma: PrismaClient; config: ServerConfig; method: string; pathname: string; header: string | undefined; body: Body },
  dependencies: ToolingOperationDependencies = toolingOperationDependencies): Promise<CallbackAdmission | null> {
  const store = input.prisma as unknown as Store;
  if (input.method === "PUT" && RESOURCE_REGISTRATION.test(input.pathname)) {
    if (!input.header) return null;
    const sessionId = decodeURIComponent(RESOURCE_REGISTRATION.exec(input.pathname)![1]!);
    const binding = await dependencies.read({ prisma: input.prisma, operationId: input.header });
    if (!binding || binding.sessionId !== sessionId) throw refuse("operation-ownership", "Resource evidence names an operation of another session");
    // A closed resource release updates only its own exact existing receipt;
    // identity and cleanup transitions are rechecked by the handler.
    if (binding.kind === CLOSED_RESOURCE_RELEASE_KIND && (input.body.key !== binding.resourceKey || ["bound", "running", "unknown"].indexOf(binding.status) < 0)) throw refuse("operation-mismatch", `A closed resource release updates only resource ${binding.resourceKey}`);
    await assertBindingAuthority({ prisma: input.prisma, config: input.config, binding });
    // The handler sees this binding so its write transaction can recheck it.
    return { mode: "evidence", binding };
  }
  const matched = matchToolingCallback(input.method, input.pathname, input.body);
  if (!matched) return null;
  const { callback, param } = matched;
  const task = await callbackTask(store, callback, param);
  if (!task) {
    if (input.header) throw refuse("operation-ownership", "The operation does not belong to this task");
    return { mode: "pre-protocol" };
  }
  const context: CallbackContext = { store, task, latestFinalizationKey: async () => (await latestPreparedFinalization(store, task))?.key ?? null, config: input.config };
  const active = await dependencies.active({ prisma: input.prisma, config: input.config, repositoryId: task.repositoryId });
  if (!input.header) {
    if (!active) return { mode: "pre-protocol" };
    const reference = callback.reference ? await callback.reference(input.body, context) : null;
    if (!reference) throw refuse("operation-required", `${callback.route} starts a new effect after release-aware activation`);
    if (await owningOperationId(store, task, reference)) throw refuse("operation-required", `${reference.type} ${reference.id} belongs to a bound operation`);
    if (reference.type === "compute-offer") {
      const environment = await offerEnvironment(context, reference.id);
      if (environment && (await admittingOperationId(store, task, environment.key) || await producerOperationId(store, task, environment.id).catch(() => "unknown"))) throw refuse("operation-required", `${reference.type} ${reference.id} belongs to a bound operation`);
    }
    const code = await legacySnapshot({ prisma: input.prisma, task, reference }, dependencies);
    if (!code) throw refuse("operation-required", `${callback.route} names no retained first-bootstrap ${reference.type}`);
    return { mode: "legacy-continuation", reference, code };
  }
  const binding = await dependencies.read({ prisma: input.prisma, operationId: input.header });
  if (!binding) throw refuse("operation-unknown", "Unknown tooling operation");
  const latest = context.latestFinalizationKey;
  context.latestFinalizationKey = async () => (await lineageFinalizationKey(input.prisma, task, binding, dependencies.read)) ?? latest();
  if (binding.taskId !== task.id || binding.repositoryId !== task.repositoryId || binding.release.repositoryId !== task.repositoryId
    || binding.sessionId !== task.primarySessionId || (callback.scope === "session" && binding.sessionId !== param)) throw refuse("operation-ownership", "The operation does not belong to this task's primary session");
  if (binding.kind !== callback.kind) throw refuse("operation-mismatch", `${callback.route} requires a ${callback.kind} operation, not ${binding.kind}`);
  const projection = await callback.input(input.body, context);
  if (projection !== undefined && dependencies.digest(projection) !== binding.inputDigest) throw refuse("operation-input", `${callback.route} input differs from the bound operation`);
  const reference = callback.reference ? await callback.reference(input.body, context) : null;
  if (callback.reference && !reference) throw refuse("operation-input", `${callback.route} names no existing operation`);
  let adopt: { environmentKey: string; offerId: string } | undefined;
  if (reference && callback.referenceRule === "admission") {
    const environment = await offerEnvironment(context, reference.id);
    const admitting = environment ? await admittingOperationId(store, task, environment.key) : null;
    if (!admitting || !await sameLineage(input.prisma, admitting, binding, dependencies.read)) {
      if (binding.existingOperationId !== reference.id) throw refuse("operation-mismatch", `${reference.type} ${reference.id} was not admitted by this operation`);
      // Admitted by another lineage: only a claim may adopt exact,
      // never-produced waiting work, rechecked atomically before effects.
      if (admitting && environment) {
        const refused = callback.route === "POST /api/tasks/:taskId/compute-claim" ? await adoptionRefused(input.prisma, task, reference.id, binding, dependencies, input.body) : `${callback.route} cannot adopt another lineage's offer`;
        if (refused) throw refuse("retained-release-required", `${reference.type} ${reference.id} was admitted by operation ${admitting}: ${refused}`);
        adopt = { environmentKey: environment.key, offerId: reference.id };
      }
    }
  } else if (reference) {
    const owner = await owningOperationId(store, task, reference);
    if (owner && !await sameLineage(input.prisma, owner, binding, dependencies.read)) throw refuse("operation-mismatch", `${reference.type} ${reference.id} belongs to operation ${owner}`);
    if (callback.referenceRule === "existing" && !owner && binding.existingOperationId !== reference.id.slice(reference.id.startsWith(`${task.id}:`) ? task.id.length + 1 : 0)) throw refuse("operation-mismatch", `${callback.route} continues ${reference.type} ${reference.id}, not this operation's existing operation`);
    // Never take over an uncertain first-bootstrap consumer with newer code.
    if (!owner) {
      const consumer = await dependencies.legacy({ prisma: input.prisma, repositoryId: task.repositoryId, consumerKind: reference.type, consumerId: reference.id });
      if (consumer.status === "legacy" || consumer.status === "unavailable") throw refuse("retained-release-required", `${reference.type} ${reference.id} is a retained first-bootstrap legacy consumer`);
    }
  }
  if (binding.resourceKey && typeof input.body.resourceKey === "string" && input.body.resourceKey !== binding.resourceKey) throw refuse("operation-input", `${callback.route} resource differs from the bound operation`);
  // A completed operation authorizes only an exact replay of its completing
  // callback (lost acknowledgment), never a different fresh effect.
  if (binding.status === "completed") {
    const evidence = callback.completes?.(input.body);
    const replay = evidence && (await associations(store, task, "completion", binding.operationId)).some(value => value.evidence === `${evidence.kind}:${evidence.reference}`);
    if (!replay) throw refuse("operation-closed", `Operation ${binding.operationId} is completed`);
  }
  // A cross-release request never takes over a key another lineage holds.
  const admits = callback.admits?.(input.body);
  if (admits) {
    const held = await admissionHeld(input.prisma, task, admits, binding, dependencies.read);
    if (held) throw refuse("retained-release-required", held);
  }
  await assertBindingAuthority({ prisma: input.prisma, config: input.config, binding });
  return { mode: "bound", binding, callback, body: input.body, context, ...(reference ? { reference } : {}), ...(adopt ? { adopt } : {}) };
}

/** Before effects: mark running and persist ownership/admission/producer
 * intent, then recheck authority. Every write precedes the handler, so a lost
 * response leaves a durable, reconcilable association, not an unbound effect. */
export async function beforeBoundCallback(prisma: PrismaClient, config: ServerConfig, admission: Extract<CallbackAdmission, { mode: "bound" }>, dependencies: ToolingOperationDependencies = toolingOperationDependencies) {
  // One short transaction, intent written FIRST (taking the write lock), then
  // the current child and command parent re-read: either this attempt is
  // durable before a settlement (which then refuses) or it sees the settled
  // command and refuses, leaving no intent. No slow effect runs inside.
  const attemptId = crypto.randomUUID(), replay = admission.binding.status === "completed";
  await prisma.$transaction(async tx => {
    await recordCallbackOutcome(tx, admission.binding, admission.callback.route, attemptId, "intent", null);
    const row = await tx.toolingOperation.findUnique({ where: { id: admission.binding.operationId } });
    if (!row || !(replay ? row.status === "completed" : ["bound", "running", "unknown"].includes(row.status))) throw refuse("operation-closed", `Operation ${admission.binding.operationId} is ${row?.status ?? "missing"}`);
    if (row.parentOperationId) {
      const parent = await tx.toolingOperation.findUnique({ where: { id: row.parentOperationId } });
      if (!parent || !["bound", "running"].includes(parent.status)) throw refuse("operation-closed", `Command ${row.parentOperationId} is ${parent?.status ?? "missing"}; it starts no further callbacks`);
    }
    if (row.status === "bound") await tx.toolingOperation.updateMany({ where: { id: row.id, status: "bound" }, data: { status: "running" } });
  });
  const binding = (await dependencies.read({ prisma, operationId: admission.binding.operationId })) ?? admission.binding;
  // This attempt is in flight from here until its own outcome is recorded.
  try { return { ...await prepareBoundEffects(prisma, config, admission, binding, dependencies), attemptId }; }
  catch (error) { await recordCallbackOutcome(prisma, binding, admission.callback.route, attemptId, "refused", null).catch(() => undefined); throw error; }
}
async function prepareBoundEffects(prisma: PrismaClient, config: ServerConfig, admission: Extract<CallbackAdmission, { mode: "bound" }>, binding: ToolingOperationBinding, dependencies: ToolingOperationDependencies) {
  const { callback, body, context, reference } = admission;
  if (reference && callback.referenceRule !== "admission") await claimOwnership(prisma, binding, context.task, reference, dependencies.read);
  // Admission (a request, or a claim adopting waiting work): the intent is
  // written FIRST, taking the write lock, then eligibility is rechecked with
  // it visible, so of two competing lineages exactly one proceeds. The
  // handler's own outcome later confirms or fails it.
  const admitted = callback.admits?.(body) ?? admission.adopt?.environmentKey;
  let admittedKey: string | undefined;
  const current = admitted ? (await admissionHistory(prisma, context.task, admitted))[0] : undefined;
  // The same operation retrying its own unconfirmed admission (409 after
  // commit, lost response): no new intent; its success confirms the original.
  if (admitted && current?.operationId === binding.operationId && current.state !== "confirmed") admittedKey = admitted;
  else if (admitted && current?.operationId !== binding.operationId) {
    await prisma.$transaction(async tx => {
      await recordAssociation(tx, binding, "admission", `environment-key:${admitted}`, "intent");
      const refused = admission.adopt ? await adoptionRefused(tx, context.task, admission.adopt.offerId, binding, dependencies, body) : await admissionHeld(tx, context.task, admitted, binding, dependencies.read, true);
      if (refused) throw refuse("retained-release-required", refused);
    });
    admittedKey = admitted;
  }
  const produced = binding.status === "completed" ? [] : await callback.produces?.(body, context) ?? [];
  // A durable reader for each producing consumer, independent of command or
  // callback completion: DRA-28 registration defers incompatible writes while
  // it is live, until replacement, no-effect, stopped or absent evidence.
  const consumers: string[] = [];
  for (const environmentId of produced) await recordAssociation(prisma, binding, "producer", `compute-environment:${environmentId}`, "intent");
  const retained = binding.status === "completed" ? [] : [...new Set([...produced, ...await callback.retains?.(body, context) ?? []])];
  for (const environmentId of retained)
    consumers.push((await retainToolingConsumer({ prisma, operationId: binding.operationId, consumerKind: "compute-environment", consumerId: environmentId, scopeKey: binding.resourceKey ?? "task" })).id);
  await assertBindingAuthority({ prisma, config, binding });
  return { binding, produced, consumers, ...(admittedKey ? { admitted: admittedKey } : {}) };
}

/**
 * Reconcile an unknown command-parented compute-request child from its own
 * exact acknowledged replay. All six proof rules are checked in ONE
 * transaction whose first write (the reconciliation records, taking the
 * write lock) commits or rolls back together with the status change:
 *  1. the child is an unknown compute-admission whose open adapter-command
 *     parent has the same task/session/repository and lineage (primitive);
 *  2. every unknown attempt is an earlier compute-request; no other route's
 *     unknown, and no attempt without a result, exists;
 *  3. each has the operation's canonical request digest and precedes this
 *     acknowledged 2xx replay, which is the latest attempt;
 *  4. the environment readback exactly matches the task/primary and the
 *     request's key/purpose/revision/recipe digest;
 *  5. no producer association or pending reader belongs to the operation, and
 *     its admission of the key is confirmed and current for its lineage;
 *  6. current primary, source and pause authority hold (before, and the task
 *     identity/pause again inside the transaction).
 * Every original attempt is kept; each record links original and replay.
 */
async function reconcileUnknownRequest(prisma: PrismaClient, admission: Extract<CallbackAdmission, { mode: "bound" }>, current: ToolingOperationBinding, acknowledgedAttemptId: string, dependencies: ToolingOperationDependencies) {
  const body = admission.body, config = admission.context.config;
  if (!config) throw new Error("Reconciliation needs the server configuration");
  if (dependencies.digest(body) !== current.inputDigest) throw new Error("The acknowledged replay is not the operation's exact request");
  await assertBindingAuthority({ prisma, config, binding: current });
  const before = await attemptRecords(prisma, current, current.operationId);
  const values = before.flatMap(record => record.value ? [{ ...record.value, sequence: record.sequence }] : []);
  if (values.length !== before.length) throw new Error("Unreadable attempt record");
  const unknown = [...new Set(values.filter(value => value.state === "unknown").map(value => value.attemptId))]
    .filter(id => !values.some(value => value.attemptId === id && value.state === "reconciled"));
  if (!unknown.length) throw new Error("No unknown attempt to reconcile");
  await prisma.$transaction(async tx => {
    for (const attemptId of unknown) {
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.sessionId, source: `tooling-operation:${current.taskId}`, action: ASSOCIATION, key: associationKey("outcome", current.operationId),
        value: JSON.stringify({ version: 1, operationId: current.operationId, role: "outcome", state: "reconciled", attemptId, acknowledgedAttemptId, route: REQUEST_ROUTE,
          inputDigest: current.inputDigest, requestKey: current.requestKey, evidence: `idempotent-replay:${acknowledgedAttemptId}` }) } });
    }
    // Under the lock: nothing but these records changed since the proof read.
    const records = await attemptRecords(tx, current, current.operationId);
    if (records.length !== before.length + unknown.length || records.slice(unknown.length).some((record, index) => record.sequence !== before[index]!.sequence)) throw new Error("Attempt history changed during reconciliation");
    const intents = values.filter(value => value.state === "intent");
    if (intents[0]?.attemptId !== acknowledgedAttemptId) throw new Error("The acknowledged replay is not the latest attempt");
    for (const intent of intents) {
      const results = values.filter(value => value.attemptId === intent.attemptId && value.state !== "intent" && value.state !== "reconciled").map(value => value.state);
      if (!results.length) throw new Error(`Attempt ${intent.attemptId} has no result`);
      if (results.includes("unknown") && !validReconciliation(records, intent.attemptId, { id: current.operationId, inputDigest: current.inputDigest })) throw new Error(`Attempt ${intent.attemptId} (${intent.route}) cannot be reconciled by a request replay`);
    }
    if (values.some(value => value.operationId !== current.operationId || value.inputDigest !== current.inputDigest)) throw new Error("Attempt records name another operation or request");
    const task = await tx.remoteTask.findUnique({ where: { id: current.taskId } });
    if (!task || task.primarySessionId !== current.sessionId || task.repositoryId !== current.repositoryId || task.phase === "closed" || task.ownerPaused) throw new Error("Task ownership, closure or pause changed");
    const environment = typeof body.key === "string" ? await tx.computeEnvironment.findUnique({ where: { taskId_key: { taskId: task.id, key: body.key } } }) : null;
    if (!environment || environment.primarySessionId !== task.primarySessionId || (["purpose", "revision", "recipeDigest"] as const).some(key => environment[key] !== body[key])) throw new Error("Environment readback does not match the request");
    const admitted = (await admissionHistory(tx, task, environment.key)).find(value => value.operationId === current.operationId);
    const holder = (await admissionHistory(tx, task, environment.key))[0];
    if (admitted?.state !== "confirmed" || !holder || !await sameLineage(tx as unknown as PrismaClient, holder.operationId, current, dependencies.read)) throw new Error("The operation's admission is not confirmed and current");
    const produced = await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: current.sessionId, source: `tooling-operation:${current.taskId}`, action: ASSOCIATION, key: { startsWith: "producer:" } }, take: 1001 });
    if (produced.some(event => Association.safeParse(JSON.parse(event.value ?? "null")).data?.operationId === current.operationId)) throw new Error("The operation has a producer association");
    if (await tx.toolingRetainedConsumer.count({ where: { operationId: current.operationId, status: "pending" } })) throw new Error("The operation has a pending reader");
    await reconcileUnknownAdmissionChild(tx, { operationId: current.operationId, acknowledgedAttemptId });
  });
}

/** After the handler: success confirms producer intent and may complete the
 * operation with its protocol evidence; a refused (4xx) handler fails the
 * intent; an exception or 5xx leaves it unknown and the operation `unknown`. */
export async function afterBoundCallback(prisma: PrismaClient, admission: Extract<CallbackAdmission, { mode: "bound" }>, state: { binding: ToolingOperationBinding; produced: string[]; consumers?: string[]; attemptId?: string; admitted?: string }, status: number | "exception",
  dependencies: ToolingOperationDependencies = toolingOperationDependencies) {
  const ok = typeof status === "number" && status >= 200 && status < 300, refused = typeof status === "number" && status >= 400 && status < 500;
  // Exact per-callback outcome for command settlement: an acknowledgment of
  // this operation's route and request digest, distinct from physical proof.
  await recordCallbackOutcome(prisma, state.binding, admission.callback.route, state.attemptId ?? "legacy-attempt", ok ? "acknowledged" : refused ? "refused" : "unknown", typeof status === "number" ? status : null);
  for (const environmentId of state.produced) if (ok || refused) await recordAssociation(prisma, state.binding, "producer", `compute-environment:${environmentId}`, ok ? "confirmed" : "failed");
  // An HTTP refusal is not proof: a handler may commit before refusing, or a
  // response may be lost. The admission stays an intent (it still holds the
  // key) until this same operation succeeds, unless exact domain proof shows
  // an adopting claim was never granted.
  if (state.admitted) {
    if (ok) await recordAssociation(prisma, state.binding, "admission", `environment-key:${state.admitted}`, "confirmed");
    else if (admission.adopt && await claimNeverGranted(prisma, admission.adopt.offerId)) await recordAssociation(prisma, state.binding, "admission", `environment-key:${state.admitted}`, "failed");
  }
  // An HTTP status never proves absence: a bind/configure follows the
  // physical start, and a handler may commit before refusing. Readers are
  // confirmed only by the producing callback's verified result (which also
  // replaces this lineage's earlier pending reader), resolved only by exact
  // domain proof, and otherwise stay pending.
  const proof = admission.callback.produces ? admission.callback.completes?.(admission.body) : null;
  for (const id of state.consumers ?? []) {
    if (ok && proof) await confirmProducingReader(prisma, id, proof, state.binding, dependencies.read);
    else if (admission.callback.retains) await resolveIfClaimNotGranted(prisma, id, admission.body);
  }
  const current = await dependencies.read({ prisma, operationId: state.binding.operationId });
  if (!current) return;
  // An exact acknowledged replay of an earlier unknown request may reconcile
  // it, only with full proof; otherwise the operation stays unknown.
  if (ok && current.status === "unknown" && admission.callback.route === REQUEST_ROUTE && state.attemptId) {
    await reconcileUnknownRequest(prisma, admission, current, state.attemptId, dependencies)
      .catch(error => console.warn(`Operation ${current.operationId} stays unknown: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (!ok && !refused && current.status === "running") await dependencies.transition({ prisma, operationId: current.operationId, from: "running", to: "unknown" }).catch(() => undefined);
  const evidence = ok ? admission.callback.completes?.(admission.body) : null;
  // A command-parented callback stays open through its enclosing command
  // (runtime renewals repeat claim/bind); its acknowledgment above is the
  // durable outcome settlement completes it from. Standalone operations keep
  // completing on their own protocol evidence.
  if (evidence && !current.parentOperationId && (current.status === "running" || current.status === "unknown")) {
    await dependencies.transition({ prisma, operationId: current.operationId, from: current.status, to: "completed", evidence });
    await recordAssociation(prisma, current, "completion", current.operationId, "confirmed", `${evidence.kind}:${evidence.reference}`);
  }
}

async function executingTurn(prisma: PrismaClient, sessionId: string, runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">) {
  const observed = runtime?.observeSessionActivity?.(sessionId);
  if (observed?.state === "executing" && observed.requestId) return observed.requestId;
  const turn = await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: sessionId }, orderBy: { sequence: "desc" } });
  return turn?.phase === "started" && turn.requestId ? turn.requestId : null;
}

/** The task's durable receipt named by `existingOperationId`. */
async function existingReceipt(prisma: PrismaClient, task: RemoteTask, reference: ExistingReference) {
  if (reference.type === "compute-offer") return Boolean(await offerEnvironment({ store: prisma as unknown as Store, task }, reference.id));
  if (reference.type === "compute-environment") return (await prisma.computeEnvironment.findUnique({ where: { id: reference.id } }))?.taskId === task.id;
  if (!task.primarySessionId) return false;
  const requestKey = reference.id.startsWith(`${task.id}:`) ? reference.id.slice(task.id.length + 1) : null;
  if (reference.type === "finalization") return Boolean(requestKey && await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_PREPARED_ACTION, key: requestKey } }));
  if (reference.type === "cleanup-request") return Boolean(requestKey && await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: CLEANUP_REQUEST_ACTION, key: requestKey } }));
  const row = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: Number(reference.id) } });
  return Boolean(row && row.runtimeSessionId === task.primarySessionId && row.source === `development:${task.id}` && row.action === DEVELOPMENT_INTENT_ACTION);
}

/** POST /api/sessions/:sessionId/tooling-operations. Identity is bound before
 * effects; callbacks keep their own authority. Continuing an existing
 * operation returns its original binding even under a fresh request key; an
 * incompatible continuation or an uncertain legacy consumer is refused, never
 * rebound to newer code. */
export async function beginSessionToolingOperation(input: { prisma: PrismaClient; config: ServerConfig; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">; sessionId: string; request: unknown },
  dependencies: ToolingOperationDependencies = toolingOperationDependencies) {
  const parsed = BeginToolingOperationInput.safeParse(input.request);
  if (!parsed.success) throw new ToolingOperationRefused("operation-input", "A requestKey, canonical inputDigest and known operation kind are required");
  const request = parsed.data;
  const owned = async () => {
    const closed = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId }, select: { phase: true } });
    let value;
    if (request.kind === CLOSED_RESOURCE_RELEASE_KIND) {
      // An exact retry of a stored request (lost settlement acknowledgment,
      // crash after release) returns its original binding: current ownership,
      // pause, source, family and exact receipt still bind, but its own
      // earlier release does not. A fresh request needs an unreleased receipt.
      const owner = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId }, select: { id: true } });
      const stored = owner ? await input.prisma.toolingOperation.findUnique({ where: { taskId_requestKey: { taskId: owner.id, requestKey: request.requestKey } } }) : null;
      const replay = Boolean(stored && stored.kind === CLOSED_RESOURCE_RELEASE_KIND && stored.sessionId === input.sessionId && stored.resourceKey === request.resourceKey && stored.inputDigest === request.inputDigest
        && stored.parentOperationId === null && stored.existingOperationId === null);
      const eligible = await assertClosedLegacyRelease({ prisma: input.prisma, config: input.config, sessionId: input.sessionId, resourceKey: request.resourceKey!, admission: !replay, ...(input.runtime ? { runtime: input.runtime } : {}) });
      // The digest must be exactly one allowed action for this stored key.
      if (!CLOSED_RELEASE_ACTIONS.some(action => dependencies.digest({ key: eligible.resource.key, action }) === request.inputDigest)) throw new ToolingOperationRefused("operation-input", `inputDigest is not a reconcile, stop or release of resource ${eligible.resource.key}`);
      value = eligible;
    } else if (closed?.phase === "closed" && CLOSED_CLEANUP_KINDS.includes(request.kind)) {
      value = await assertClosedCleanupPrimary({ prisma: input.prisma, config: input.config, sessionId: input.sessionId, ...(input.runtime ? { runtime: input.runtime } : {}) });
      // Exact cleanup lineage only: the fence names the cleanup operation, and
      // its finalization children continue exactly that request key.
      if (request.kind === ADAPTER_COMMAND_KIND && request.existingOperationId !== value.cleanupKey) throw new ToolingOperationRefused("operation-ownership", `A closed task's command must name its cleanup operation ${value.cleanupKey} as existingOperationId`);
      if (request.kind === "finalization") {
        if (request.inputDigest !== dependencies.digest({ requestKey: value.cleanupKey })) throw new ToolingOperationRefused("operation-ownership", `A closed task only continues finalization ${value.cleanupKey}`);
        const parent = request.parentOperationId ? await dependencies.read({ prisma: input.prisma, operationId: request.parentOperationId }) : null;
        if (request.parentOperationId && (!parent || !closedCleanupFence(parent))) throw new ToolingOperationRefused("operation-ownership", "A closed task's finalization must belong to its cleanup command");
      }
    } else value = await assertOpenTaskPrimary({ prisma: input.prisma, config: input.config, sessionId: input.sessionId });
    if (value.task.ownerPaused && PAUSE_BLOCKED.includes(request.kind)) throw new ToolingOperationRefused("operation-ownership", "Task is paused by its owner; no new tooling operation starts");
    return value;
  };
  const before = await owned();
  if ((request.kind === "compute-configure" || request.kind === "compute-enroll" || request.kind === "development-intent") && !request.existingOperationId) throw new ToolingOperationRefused("operation-input", `${request.kind} operations continue an exact existing operation`);
  // The release this request would run: its command parent's (validated and
  // inherited atomically by the binding primitive), else the active one.
  const parent = request.parentOperationId ? await dependencies.read({ prisma: input.prisma, operationId: request.parentOperationId }) : null;
  if (request.parentOperationId && (!parent || parent.kind !== ADAPTER_COMMAND_KIND || parent.taskId !== before.task.id || parent.sessionId !== input.sessionId)) throw new ToolingOperationRefused("operation-ownership", "Parent must be this primary's adapter-command binding");
  if (request.existingOperationId && isCallbackKind(request.kind)) {
    const type = EXISTING_TYPE[request.kind];
    const reference: ExistingReference = { type, id: type === "finalization" || type === "cleanup-request" ? `${before.task.id}:${request.existingOperationId}` : request.existingOperationId };
    if (!await existingReceipt(input.prisma, before.task, reference)) throw new ToolingOperationRefused("operation-input", `Existing ${type} ${request.existingOperationId} does not belong to this task`);
    let ownerId = await owningOperationId(input.prisma, before.task, reference), admitted = false;
    if (!ownerId && request.kind === "compute-admission") {
      const environment = await offerEnvironment({ store: input.prisma as unknown as Store, task: before.task }, reference.id);
      ownerId = environment ? await admittingOperationId(input.prisma, before.task, environment.key) : null;
      admitted = Boolean(ownerId);
    }
    if (ownerId) {
      const original = await dependencies.read({ prisma: input.prisma, operationId: ownerId });
      if (!original) throw new ToolingOperationRefused("operation-unknown", "Existing operation binding is missing");
      // The original binding continues under a fresh key or a new command
      // fence only when it would run the same retained code; never newer code.
      const requested = parent?.release ?? (await dependencies.active({ prisma: input.prisma, config: input.config, repositoryId: before.task.repositoryId }))?.release;
      if (original.kind === request.kind && original.inputDigest === request.inputDigest && original.resourceKey === (request.resourceKey ?? null)
        && ((original.parentOperationId ?? null) === (request.parentOperationId ?? null) || requested?.id === original.release.id)) return { binding: original };
      // Never-produced waiting work whose admitting command settled may be
      // adopted by the requested release; the claim rechecks atomically.
      const adoptable = admitted && requested && requested.id !== original.release.id && !await adoptionRefused(input.prisma, before.task, request.existingOperationId,
        { operationId: "", parentOperationId: request.parentOperationId ?? null, release: requested, inputDigest: request.inputDigest }, dependencies);
      if (!adoptable) throw new ToolingOperationRefused("retained-release-required", `${type} ${request.existingOperationId} belongs to operation ${original.operationId} (${original.kind}, release ${original.release.revision}); continue that operation with its release`);
    }
    const consumer = await dependencies.legacy({ prisma: input.prisma, repositoryId: before.task.repositoryId, consumerKind: type, consumerId: reference.id });
    if (consumer.status === "legacy" || consumer.status === "unavailable") throw new ToolingOperationRefused("retained-release-required", `${type} ${request.existingOperationId} is a retained first-bootstrap legacy consumer; only its legacy path may continue it until reconciled`);
  }
  const turnId = await executingTurn(input.prisma, input.sessionId, input.runtime);
  const binding = await dependencies.bind({ prisma: input.prisma, config: input.config, taskId: before.task.id, sessionId: input.sessionId, turnId, request });
  if (binding.contract !== "remote-agent.tooling-operation/v1" || binding.taskId !== before.task.id || binding.sessionId !== input.sessionId || binding.repositoryId !== before.task.repositoryId
    || binding.requestKey !== request.requestKey || binding.kind !== request.kind || binding.inputDigest !== request.inputDigest
    || binding.existingOperationId !== (request.existingOperationId ?? null) || binding.resourceKey !== (request.resourceKey ?? null)
    || (binding.parentOperationId ?? null) !== (request.parentOperationId ?? null)) throw new ToolingOperationRefused("operation-mismatch", "Operation request key already names a different operation");
  const after = await owned();
  if (after.task.id !== before.task.id || after.task.worktreePath !== before.task.worktreePath) throw new ToolingOperationRefused("operation-ownership", "Task ownership changed while binding the operation");
  return { binding };
}

export async function readSessionToolingOperation(input: { prisma: PrismaClient; sessionId: string; operationId: string }, dependencies: Pick<ToolingOperationDependencies, "read"> = toolingOperationDependencies) {
  const binding = await dependencies.read({ prisma: input.prisma, operationId: input.operationId });
  if (!binding || binding.sessionId !== input.sessionId) return null;
  const task = await input.prisma.remoteTask.findUnique({ where: { id: binding.taskId } });
  if (!task || task.primarySessionId !== input.sessionId || task.repositoryId !== binding.repositoryId) return null;
  return { binding };
}

/** Server-initiated continuation of an existing group (idle suspension). The
 * command fence is derived from the group's confirmed retained reader, so it
 * and every child callback run that reader's release even after a newer
 * activation; it never selects the active release. A retained first-bootstrap
 * group runs its legacy snapshot without a binding. */
export async function bindServerContinuation(input: { prisma: PrismaClient; config: ServerConfig; task: RemoteTask; environmentId: string; request: { requestKey: string; inputDigest: string } },
  dependencies: Pick<ToolingOperationDependencies, "read" | "legacy"> & { bindRetained?: typeof bindRetainedToolingOperation } = toolingOperationDependencies): Promise<{ binding: ToolingOperationBinding | null; code: ToolingCodeIdentity | null }> {
  if (!input.task.primarySessionId) throw new Error("Tooling operation requires the task's original primary");
  const group = await resourceGroupCode({ prisma: input.prisma, task: input.task, reference: { type: "compute-environment", id: input.environmentId } }, dependencies);
  if (!group.binding) return { binding: null, code: group.code };
  const consumer = await input.prisma.toolingRetainedConsumer.findFirst({ where: { taskId: input.task.id, consumerKind: "compute-environment", consumerId: input.environmentId, status: "confirmed" }, orderBy: { createdAt: "desc" } });
  if (!consumer) throw new ToolingOperationRefused("retained-release-required", `Compute environment ${input.environmentId} has no confirmed retained reader to continue from`);
  const fence = await (dependencies.bindRetained ?? bindRetainedToolingOperation)({ prisma: input.prisma, config: input.config, taskId: input.task.id, sessionId: input.task.primarySessionId, turnId: null,
    request: { requestKey: input.request.requestKey, inputDigest: input.request.inputDigest, kind: ADAPTER_COMMAND_KIND }, retainedConsumerId: consumer.id });
  if (fence.kind !== ADAPTER_COMMAND_KIND || fence.taskId !== input.task.id || fence.release.id !== consumer.releaseId || fence.inputDigest !== input.request.inputDigest) throw new Error("Server continuation fence identity changed");
  return { binding: fence, code: fence.release };
}

// ---------------------------------------------------------------------------
// Command settlement (frozen in docs/tooling-release-contract.md b6bd147).
export const SettlementInput = z.object({ requestKey: z.string().min(1).max(256), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(["completed", "no-effect"]) }).strict();
const settlementEvidence = (outcome: "completed" | "no-effect", requestKey: string) => ({ kind: outcome === "completed" ? "command-completed" : "command-no-effect", reference: requestKey });

/** POST .../tooling-operations/:operationId/settlement. Records a finished
 * adapter command after checking its stored identity, current ownership and
 * every child/consumer outcome. Unknown effects are never declared
 * successful; completion never resolves retained readers or children. */
export async function settleToolingCommand(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; operationId: string; header: string | undefined; body: unknown },
  dependencies: Pick<ToolingOperationDependencies, "read" | "transition"> = toolingOperationDependencies): Promise<{ binding: ToolingOperationBinding; outcome: "completed" | "no-effect" }> {
  const parsed = SettlementInput.safeParse(input.body);
  if (!parsed.success) throw refuse("operation-input", "Settlement requires the command's requestKey, inputDigest and an outcome");
  if (!input.header || input.header !== input.operationId) throw refuse("operation-required", "Settlement requires the matching operation header");
  const { requestKey, inputDigest, outcome } = parsed.data;
  const binding = await dependencies.read({ prisma: input.prisma, operationId: input.operationId });
  if (!binding || binding.sessionId !== input.sessionId || ![ADAPTER_COMMAND_KIND, CLOSED_RESOURCE_RELEASE_KIND].includes(binding.kind)) throw refuse("operation-unknown", "No such adapter command for this session");
  if (binding.requestKey !== requestKey || binding.inputDigest !== inputDigest) throw refuse("operation-mismatch", "Settlement identity differs from the stored command");
  // Ownership of the recorded command: settlement records an outcome, so a
  // later closure of the task does not strand its retry journal.
  const task = await input.prisma.remoteTask.findUnique({ where: { id: binding.taskId } });
  if (!task || task.primarySessionId !== binding.sessionId || task.repositoryId !== binding.repositoryId || task.machineId !== input.config.machine) throw refuse("operation-ownership", "The command no longer belongs to this task's primary session");
  const evidence = settlementEvidence(outcome, requestKey);
  const recorded = async (store: Pick<PrismaClient, "toolingOperation"> = input.prisma) => (await store.toolingOperation.findUnique({ where: { id: binding.operationId } }))?.completionEvidence as { kind?: string; reference?: string } | null | undefined;
  const same = (prior: { kind?: string; reference?: string } | null | undefined) => prior?.kind === evidence.kind && prior?.reference === evidence.reference;
  if (binding.status === "completed") {
    if (same(await recorded())) return { binding, outcome };
    throw refuse("operation-closed", `Command ${binding.operationId} was already settled with a different outcome`);
  }
  if (binding.status === "unknown") throw refuse("operation-closed", `Command ${binding.operationId} has an unknown outcome; reconcile it before settling`);
  // One transaction, parent compare-and-swap FIRST: it takes the write lock, so
  // a concurrent child begin either committed before (and is inventoried
  // below) or reads a completed parent afterwards and is refused.
  try {
    await input.prisma.$transaction(async tx => {
      const swapped = await tx.toolingOperation.updateMany({ where: { id: binding.operationId, status: binding.status, kind: binding.kind }, data: { status: "completed", completionEvidence: evidence } });
      if (swapped.count !== 1) throw new ToolingOperationRefused("operation-closed", "Command state changed during settlement");
      const task = await tx.remoteTask.findUnique({ where: { id: binding.taskId } });
      if (!task || task.primarySessionId !== binding.sessionId || task.repositoryId !== binding.repositoryId) throw refuse("operation-ownership", "The command no longer belongs to this task's primary session");
      const children = await tx.toolingOperation.findMany({ where: { parentOperationId: binding.operationId }, take: 1001 });
      if (children.length > 1000) throw refuse("operation-input", "Command child inventory exceeds its bound");
      const ids = [binding.operationId, ...children.map(child => child.id)];
      const consumers = await tx.toolingRetainedConsumer.findMany({ where: { operationId: { in: ids } }, take: 1001 });
      if (consumers.length > 1000) throw refuse("operation-input", "Command consumer inventory exceeds its bound");
      const writes = await tx.toolingStateWrite.count({ where: { operationId: { in: ids } } });
      if (outcome === "no-effect") {
        if (binding.status !== "bound" || children.length || consumers.length || writes) throw refuse("operation-input", "A no-effect settlement requires a bound command with no children, state writes or retained consumers");
        return;
      }
      const pending = consumers.find(consumer => consumer.status === "pending");
      if (pending) throw refuse("operation-closed", `Retained ${pending.consumerKind} ${pending.consumerId} has an unconfirmed producing effect; the command cannot be declared successful`);
      for (const child of children) {
        if (child.status === "completed") continue;
        // Finite callback lifetimes end only on the latest attempt's own
        // definite acknowledgment.
        if (child.status !== "running" || !await latestAttemptAcknowledged(tx, binding, child))
          throw refuse("operation-closed", `Child operation ${child.id} is ${child.status} without a confirmed latest callback outcome; the command cannot be declared successful`);
        const done = await tx.toolingOperation.updateMany({ where: { id: child.id, status: "running" }, data: { status: "completed", completionEvidence: { kind: "callback-acknowledged", reference: binding.operationId } } });
        if (done.count !== 1) throw refuse("operation-closed", `Child operation ${child.id} changed during settlement`);
      }
    });
  } catch (error) {
    // Lost acknowledgment or concurrent settlement: replay only the same outcome.
    if (!same(await recorded())) throw error;
  }
  const settled = await dependencies.read({ prisma: input.prisma, operationId: binding.operationId });
  if (!settled || settled.status !== "completed" || !same(await recorded())) throw refuse("operation-closed", "Command settlement did not complete");
  return { binding: settled, outcome };
}

const CapabilityReceipt = z.object({ capability: z.string(), source: z.literal("configured-host"), capabilityRevision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), checkout: z.string().startsWith("/") }).passthrough();
const ObserverCapability = z.object({ version: z.literal(1), source: z.literal("configured-host"), checkout: z.string().startsWith("/"), revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/) }).passthrough();
const FINALIZATION_CONFIRMED_ACTION = "finalization-confirmed", DEVELOPMENT_COMPLETE_ACTION = "development-compute-complete", DEVELOPMENT_SUPERSEDED_ACTION = "development-compute-superseded";
const COUNTED_COMPUTE_KINDS = ["native-app", "launch-agent", "launch-agents", "task-runtime", "docker-container", "docker-compose-project"];
const ACTIVE_OFFERS = ["queued", "offered", "validating", "claimed", "running", "unknown"];
const PENDING_INSTRUCTION = ["queued", "preparing", "dispatching", "unknown"];
type Provenance = ToolingLegacyConsumerInput["provenance"];
const bounded = <T>(rows: T[], limit: number, what: string) => { if (rows.length > limit) throw new Error(`Legacy consumer inventory: ${what} exceeds its bound of ${limit}`); return rows; };

/** Exactly one distinct executable, or an explicit ambiguity: several
 * pre-boundary receipts (e.g. after the configured ref moved) never resolve
 * to "the newest". */
function single(receipts: Array<{ revision: string; checkout: string; receipt: unknown }>, what: string): Provenance {
  const distinct = new Map(receipts.map(value => [`${value.revision}\0${value.checkout}`, value]));
  if (distinct.size === 1) { const [value] = distinct.values(); return { revision: value!.revision, checkout: value!.checkout, receipt: value!.receipt }; }
  if (!distinct.size) return { unavailable: `No recorded configured-host ${what} capability receipt; original executable unknown` };
  return { unavailable: `ambiguous: ${distinct.size} distinct recorded ${what} executables (${[...distinct.values()].map(value => value.revision.slice(0, 12)).join(", ")})` };
}
async function recordedCapabilities(tx: Prisma.TransactionClient, task: Pick<RemoteTask, "id" | "primarySessionId">, capability: "runtime" | "cleanup") {
  if (!task.primarySessionId) return [];
  const events = bounded(await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `task:${task.id}`, action: "tooling-capability" }, orderBy: { sequence: "asc" }, take: 5001 }), 5000, `task ${task.id} capability receipts`);
  return events.flatMap(event => {
    const receipt = CapabilityReceipt.safeParse(JSON.parse(event.value ?? "null"));
    return receipt.success && receipt.data.capability === capability ? [{ revision: receipt.data.capabilityRevision, checkout: receipt.data.checkout, receipt: receipt.data }] : [];
  });
}
/** The prepared plan's own persisted observer capabilities. */
function plannedObservers(value: unknown, found: Array<{ revision: string; checkout: string; receipt: unknown }> = []) {
  if (Array.isArray(value)) for (const item of value) plannedObservers(item, found);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    const capability = key === "observer" ? ObserverCapability.safeParse((item as Record<string, unknown> | null)?.capability) : null;
    if (capability?.success) found.push({ revision: capability.data.revision, checkout: capability.data.checkout, receipt: capability.data });
    else plannedObservers(item, found);
  }
  return found;
}

type ConsumerStore = Prisma.TransactionClient;
/** Liveness of a consumer from protocol evidence; terminal ones are neither
 * inventoried nor kept retained. */
async function liveConsumer(tx: ConsumerStore, task: RemoteTask, kind: string, id: string): Promise<boolean> {
  if (kind === "compute-offer") return Boolean(await tx.computeOffer.findFirst({ where: { id, state: { in: ACTIVE_OFFERS } } }));
  if (kind === "compute-environment") {
    const environment = await tx.computeEnvironment.findUnique({ where: { id } });
    if (!environment) return false;
    if (["running", "unknown", "starting", "offered"].includes(environment.state) || await tx.computeOffer.count({ where: { environmentId: id, state: { in: ACTIVE_OFFERS } } })) return true;
    const resource = environment.resourceId ? await tx.remoteTaskResource.findUnique({ where: { id: environment.resourceId } }) : null;
    return Boolean(resource && resource.state !== "released");
  }
  if (kind === "compute-baseline") {
    const purpose = id.slice(task.id.length + 1);
    return Boolean(await tx.remoteTaskResource.count({ where: { taskId: task.id, purpose, state: { not: "released" }, kind: { in: COUNTED_COMPUTE_KINDS } } }));
  }
  if (!task.primarySessionId) return false;
  if (kind === "development-intent") {
    const intent = await tx.runtimeMetadataEvent.findUnique({ where: { sequence: Number(id) } });
    if (!intent || intent.action !== DEVELOPMENT_INTENT_ACTION) return false;
    const complete = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `development:${task.id}`, action: DEVELOPMENT_COMPLETE_ACTION, key: intent.key } });
    const superseded = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `development:${task.id}`, action: DEVELOPMENT_SUPERSEDED_ACTION, sequence: { gt: intent.sequence } } });
    return !complete && !superseded;
  }
  const requestKey = id.slice(task.id.length + 1);
  if (kind === "finalization") return !await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED_ACTION, key: requestKey } });
  if (kind === "cleanup-request") {
    const request = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: CLEANUP_REQUEST_ACTION, key: requestKey } });
    const instructionId = request ? z.object({ instructionId: z.string() }).safeParse(JSON.parse(request.value ?? "null")).data?.instructionId : undefined;
    return Boolean(instructionId && await tx.runtimeInstruction.findFirst({ where: { id: instructionId, state: { in: PENDING_INSTRUCTION } } }));
  }
  return true; // Unknown kinds stay retained (conservative).
}

/** DRA-28 `ToolingLegacyInventory`: every live pre-boundary consumer, open or
 * closed task alike, with its exact unambiguous executable. Bounds fail
 * activation rather than silently dropping consumers. */
export const inventoryLegacyToolingConsumers: ToolingLegacyInventory = async (tx, input) => {
  const tasks = bounded(await tx.remoteTask.findMany({ where: { repositoryId: input.repositoryId }, orderBy: { id: "asc" }, take: 5001 }), 5000, "tasks");
  const consumers: ToolingLegacyConsumerInput[] = [];
  for (const task of tasks) {
    const runtime = single(await recordedCapabilities(tx, task, "runtime"), "runtime"), cleanupReceipts = await recordedCapabilities(tx, task, "cleanup");
    const push = async (consumerKind: string, consumerId: string, provenance: Provenance) => { if (await liveConsumer(tx, task, consumerKind, consumerId)) consumers.push({ taskId: task.id, consumerKind, consumerId, provenance }); };
    for (const environment of bounded(await tx.computeEnvironment.findMany({ where: { taskId: task.id }, take: 1001 }), 1000, `task ${task.id} environments`)) {
      await push("compute-environment", environment.id, runtime);
      for (const row of bounded(await tx.computeOffer.findMany({ where: { environmentId: environment.id, state: { in: ACTIVE_OFFERS } }, take: 1001 }), 1000, `environment ${environment.id} offers`))
        await push("compute-offer", row.id, runtime);
    }
    // Baseline groups computed as refreshComputeBaselines does: existing rows
    // plus unreleased counted resources not attached to an environment.
    const purposes = new Set(bounded(await tx.computeBaseline.findMany({ where: { taskId: task.id }, take: 101 }), 100, `task ${task.id} baselines`).map(row => row.purpose));
    const attached = new Set((await tx.computeEnvironment.findMany({ where: { taskId: task.id, resourceId: { not: null } }, select: { resourceId: true }, take: 1001 })).map(row => row.resourceId));
    for (const resource of bounded(await tx.remoteTaskResource.findMany({ where: { taskId: task.id, purpose: { in: ["development", "review"] }, state: { not: "released" }, kind: { in: COUNTED_COMPUTE_KINDS } }, take: 10001 }), 10000, `task ${task.id} resources`))
      if (!attached.has(resource.id)) purposes.add(resource.purpose);
    for (const purpose of purposes) await push("compute-baseline", `${task.id}:${purpose}`, runtime);
    if (!task.primarySessionId) continue;
    const intent = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `development:${task.id}`, action: DEVELOPMENT_INTENT_ACTION }, orderBy: { sequence: "desc" } });
    if (intent) await push("development-intent", String(intent.sequence), runtime);
    const prepared = bounded(await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_PREPARED_ACTION }, orderBy: { sequence: "asc" }, take: 1001 }), 1000, `task ${task.id} finalizations`);
    for (const key of new Set(prepared.map(event => event.key))) {
      // The prepared plan's persisted observer is the exact executable.
      const planned = prepared.filter(event => event.key === key).flatMap(event => plannedObservers(JSON.parse(event.value ?? "null")));
      await push("finalization", `${task.id}:${key}`, single(planned.length ? planned : cleanupReceipts, "cleanup"));
    }
    for (const request of bounded(await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: CLEANUP_REQUEST_ACTION }, take: 1001 }), 1000, `task ${task.id} cleanup requests`)) {
      // The scheduled instruction's marker holds its exact immutable adapter.
      const instructionId = z.object({ instructionId: z.string() }).safeParse(JSON.parse(request.value ?? "null")).data?.instructionId;
      const marker = instructionId ? await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: "cleanup-inbox", action: CLEANUP_INSTRUCTION_ACTION, key: instructionId } }) : null;
      const capability = marker ? CapabilityReceipt.safeParse(z.object({ capability: z.unknown() }).passthrough().safeParse(JSON.parse(marker.value ?? "null")).data?.capability).data : undefined;
      await push("cleanup-request", `${task.id}:${request.key}`, capability ? { revision: capability.capabilityRevision, checkout: capability.checkout, receipt: capability } : single([], "cleanup marker"));
    }
  }
  return consumers;
};

/** Resolve retained first-bootstrap consumers whose protocol evidence now
 * shows them finished, lifting state-write deferral and legacy continuation
 * for them. Bounded; conservative (unknown kinds stay retained). */
export async function resolveFinishedLegacyConsumers(input: { prisma: PrismaClient; repositoryId: string; taskId?: string }, resolve = (async (value: { prisma: PrismaClient; id: string; evidence: { kind: string; reference: string } }) => (await import("./tooling-releases.ts")).resolveToolingLegacyConsumer(value))) {
  const rows = bounded(await input.prisma.toolingLegacyConsumer.findMany({ where: { repositoryId: input.repositoryId, status: "retained", ...(input.taskId ? { taskId: input.taskId } : {}) }, take: 1001 }), 1000, "retained legacy consumers");
  let resolved = 0;
  for (const row of rows) {
    const task = await input.prisma.remoteTask.findUnique({ where: { id: row.taskId } });
    if (!task || await input.prisma.$transaction(tx => liveConsumer(tx, task, row.consumerKind, row.consumerId))) continue;
    await resolve({ prisma: input.prisma, id: row.id, evidence: { kind: `${row.consumerKind}-finished`, reference: row.consumerId.slice(0, 512) } }).then(() => resolved++).catch(() => undefined);
  }
  return { resolved };
}

// ---------------------------------------------------------------------------
// Guarded state evidence for the owning operation (frozen wire shapes in
// types/tooling-release.ts). Task/repository come from the stored operation;
// callers cannot choose another task, release or arbitrary path scope.
// A scope is a state key (resource key or `task`), never a file path.
export const StateQuery = z.object({ family: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/), scopeKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/) }).strict();
export const StateWriteInput = StateQuery.extend({ version: z.number().int().positive() }).strict();
const LIVE_OPERATION = ["bound", "running", "unknown"];

async function ownedStateOperation(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; operationId: string; header: string | undefined; scopeKey: string },
  dependencies: Pick<ToolingOperationDependencies, "read">) {
  if (!input.header || input.header !== input.operationId) throw refuse("operation-required", "State evidence requires the matching operation header");
  const binding = await dependencies.read({ prisma: input.prisma, operationId: input.operationId });
  if (!binding || binding.sessionId !== input.sessionId) throw refuse("operation-unknown", "Unknown tooling operation for this session");
  if (!LIVE_OPERATION.includes(binding.status)) throw refuse("operation-closed", `Operation ${binding.operationId} is ${binding.status}`);
  // A task-wide adapter command (null resource key) is already a reader of
  // every scope of its own task; keyed operations reach their key or task.
  const taskWide = binding.kind === ADAPTER_COMMAND_KIND && binding.resourceKey === null;
  if (binding.kind === CLOSED_RESOURCE_RELEASE_KIND && input.scopeKey !== binding.resourceKey) throw refuse("operation-input", "A closed resource release reaches only its own resource's state");
  if (!taskWide && input.scopeKey !== "task" && input.scopeKey !== binding.resourceKey) throw refuse("operation-input", "State scope must be this operation's resource key or task");
  await assertStateAuthority(input.prisma, input.config, binding);
  return binding;
}
/** Current authority for state evidence/writes: owner pause withholds every
 * receipt except for the owner's own development intent. */
async function assertStateAuthority(prisma: PrismaClient, config: ServerConfig, binding: ToolingOperationBinding) {
  const task = await assertBindingAuthority({ prisma, config, binding });
  if (task.ownerPaused && binding.kind !== "development-intent") throw refuse("operation-ownership", "Task is paused by its owner; no state receipt is issued");
  return task;
}

/** GET .../tooling-operations/:operationId/state?family&scopeKey */
export async function readOperationStateEvidence(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; operationId: string; header: string | undefined; query: unknown },
  dependencies: Pick<ToolingOperationDependencies, "read"> & { readable?: typeof import("./tooling-releases.ts").assertToolingStateReadable; retained?: typeof import("./tooling-releases.ts").readToolingRetainedConsumers } = toolingOperationDependencies): Promise<import("../../../../types/tooling-release.ts").ToolingStateEvidenceResponse> {
  const parsed = StateQuery.safeParse(input.query);
  if (!parsed.success) throw refuse("operation-input", "A state family and scopeKey are required");
  const { family, scopeKey } = parsed.data;
  const binding = await ownedStateOperation({ ...input, scopeKey }, dependencies);
  await resolveFinishedLegacyConsumers({ prisma: input.prisma, repositoryId: binding.repositoryId, taskId: binding.taskId });
  const releases = await import("./tooling-releases.ts");
  const readable = await (dependencies.readable ?? releases.assertToolingStateReadable)({ prisma: input.prisma, operationId: binding.operationId, family, scopeKey });
  const consumers = new Map<string, ToolingStateFormat | null>();
  const add = (operationId: string, format: ToolingStateFormat | null, what: string) => {
    if (format === null && !operationId.startsWith("legacy:")) throw new ToolingOperationRefused("operation-mismatch", `${what} cannot read ${family}: its release does not declare this state; the state is blocked`);
    consumers.set(operationId, format);
  };
  // Unfinished release-bound operations of this task that can reach the state.
  const open = await input.prisma.toolingOperation.findMany({ where: { taskId: binding.taskId, status: { in: LIVE_OPERATION } }, take: 1001 });
  if (open.length > 1000) throw new ToolingOperationRefused("operation-input", "Unfinished operation inventory exceeds its bound");
  for (const row of open) {
    if (row.resourceKey !== null && scopeKey !== "task" && row.resourceKey !== scopeKey) continue;
    const other = await dependencies.read({ prisma: input.prisma, operationId: row.id });
    if (!other) throw new ToolingOperationRefused("operation-unknown", `Operation ${row.id} provenance is unavailable`);
    add(other.operationId, other.release.manifest.stateFormats[family] ?? null, `Unfinished operation ${other.operationId}`);
  }
  // Retained readers outlive their producing operations.
  for (const reader of await (dependencies.retained ?? releases.readToolingRetainedConsumers)({ prisma: input.prisma, taskId: binding.taskId, family, scopeKey }))
    add(reader.operationId, reader.format, `Retained ${reader.consumerKind} ${reader.consumerId}`);
  // Retained first-bootstrap readers: exact provenance, or a 409 refusal.
  const legacy = await input.prisma.toolingLegacyConsumer.findMany({ where: { repositoryId: binding.repositoryId, taskId: binding.taskId, status: "retained" }, take: 1001 });
  if (legacy.length > 1000) throw new ToolingOperationRefused("operation-input", "Retained legacy consumer inventory exceeds its bound; this state cannot be proven");
  for (const row of legacy) {
    if (row.provenance === "unavailable") throw new ToolingOperationRefused("operation-unknown", `Retained ${row.consumerKind} ${row.consumerId} has unresolved executable provenance: ${row.detail ?? "unavailable"}`);
    consumers.set(`legacy:${row.id}`, null);
  }
  await assertStateAuthority(input.prisma, input.config, binding);
  return { operationId: binding.operationId, taskId: binding.taskId, family, scopeKey, version: readable.version, source: readable.source,
    consumers: [...consumers].map(([operationId, format]) => ({ operationId, format })) };
}

/** POST .../tooling-operations/:operationId/state-writes — registered before
 * the adapter changes bytes; DRA-28's atomic per-state checks decide. */
export async function registerOperationStateWrite(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; operationId: string; header: string | undefined; body: unknown },
  dependencies: Pick<ToolingOperationDependencies, "read"> & { register?: typeof import("./tooling-releases.ts").registerToolingStateWrite } = toolingOperationDependencies): Promise<import("../../../../types/tooling-release.ts").ToolingStateWriteResponse> {
  const parsed = StateWriteInput.safeParse(input.body);
  if (!parsed.success) throw refuse("operation-input", "A state family, scopeKey and positive version are required");
  const binding = await ownedStateOperation({ ...input, scopeKey: parsed.data.scopeKey }, dependencies);
  if (binding.kind === CLOSED_RESOURCE_RELEASE_KIND) {
    // Cleanup keeps the recorded format version (legacy-assumed v1 when none):
    // never a migration, raise or rewind.
    const { readToolingStateVersion, LEGACY_STATE_FORMATS } = await import("./tooling-releases.ts");
    const recorded = (await readToolingStateVersion({ prisma: input.prisma, taskId: binding.taskId, family: parsed.data.family, scopeKey: parsed.data.scopeKey }))?.version ?? LEGACY_STATE_FORMATS[parsed.data.family]?.write ?? 1;
    if (parsed.data.version !== recorded) throw refuse("operation-input", `A closed resource release keeps ${parsed.data.family} version ${recorded}; it cannot change it to ${parsed.data.version}`);
  }
  // Finished first-bootstrap readers no longer defer this task's writes.
  await resolveFinishedLegacyConsumers({ prisma: input.prisma, repositoryId: binding.repositoryId, taskId: binding.taskId });
  const { ToolingStateFormatError } = await import("./tooling-releases.ts");
  let write: Awaited<ReturnType<typeof import("./tooling-releases.ts").registerToolingStateWrite>>;
  try { write = await (dependencies.register ?? (await import("./tooling-releases.ts")).registerToolingStateWrite)({ prisma: input.prisma, operationId: binding.operationId, ...parsed.data }); }
  catch (error) {
    // The helper's structured refusals precede any record; anything else may
    // have committed.
    if (error instanceof ToolingStateFormatError) throw error;
    throw new StateWriteOutcomeUnknown(error instanceof Error ? error.message : String(error));
  }
  // Registration is durable from here: any later failure is unknown, and the
  // receipt is withheld (preserving a pause or ownership change).
  try {
    await assertStateAuthority(input.prisma, input.config, binding);
    if (write.operationId !== binding.operationId || write.version !== parsed.data.version) throw new Error("receipt does not match this operation");
  } catch (error) { throw new StateWriteOutcomeUnknown(error instanceof Error ? error.message : String(error)); }
  return { operationId: binding.operationId, taskId: binding.taskId, family: parsed.data.family, scopeKey: parsed.data.scopeKey, write };
}

/** Stopped/absent physical proof ends every live reader of an environment,
 * whichever release produced it. Retention otherwise outlives commands. */
export async function resolveEnvironmentConsumers(prisma: PrismaClient, environmentId: string, evidence: { kind: "stopped" | "absent"; reference: string }) {
  const live = await prisma.toolingRetainedConsumer.findMany({ where: { consumerKind: "compute-environment", consumerId: environmentId, status: { in: ["pending", "confirmed"] } }, take: 101 });
  if (live.length > 100) throw new Error(`Retained readers of environment ${environmentId} exceed their bound`);
  for (const row of live) await resolveToolingConsumer({ prisma, id: row.id, evidence });
  return live.length;
}

/** Confirm a producing reader and replace this lineage's earlier pending
 * readers of the same environment (e.g. its claim's), which it supersedes. */
async function confirmProducingReader(prisma: PrismaClient, id: string, evidence: { kind: string; reference: string }, binding: ToolingOperationBinding, read: ToolingOperationDependencies["read"]) {
  const confirmed = await confirmToolingConsumer({ prisma, id, evidence });
  const pending = await prisma.toolingRetainedConsumer.findMany({ where: { taskId: confirmed.taskId, consumerKind: confirmed.consumerKind, consumerId: confirmed.consumerId, status: "pending", id: { not: id } }, take: 101 });
  for (const row of pending) if (await sameLineage(prisma, row.operationId, binding, read)) await resolveToolingConsumer({ prisma, id: row.id, evidence: { kind: "replaced", reference: id } });
}
/** Exact domain proof that a claim was never granted: the offer is durably
 * withdrawn and was never claimed. */
async function claimNeverGranted(prisma: PrismaClient, offerId: string | null) {
  const row = offerId ? await prisma.computeOffer.findUnique({ where: { id: offerId } }) : null;
  return Boolean(row && row.claimedAt === null && ["expired", "declined", "ineligible"].includes(row.state));
}
/** Exact pre-effect domain proof: the claimed offer is durably withdrawn and
 * was never claimed, so no start authority existed. Anything else (claimed,
 * validating, uncertain) keeps the reader pending. */
async function resolveIfClaimNotGranted(prisma: PrismaClient, id: string, body: Body) {
  const offerId = text(body.offerId);
  if (!await claimNeverGranted(prisma, offerId)) return;
  // Start authority is exactly a durable claim (assertComputeStartIntent).
  await resolveToolingConsumer({ prisma, id, evidence: { kind: "claim-not-granted", reference: offerId! } });
}

/** Inside the resource handler's own write transaction: a closed legacy
 * resource release may update only its exact receipt, never resurrect a
 * released one or change its expiry, and may change metadata only as the
 * existing cleanup writers do. (The ordinary cleanup update check does not
 * apply to never-finalized tasks, so these rules are the binding limits.)
 *  - every kind: `observed`/`observedAt` observation strings;
 *  - task-runtime receipts (Drafted runtime.ts save): additionally the
 *    `progress` record and monotonic provider release — the same providers,
 *    in order, with identical identity, whose `released` only goes to true.
 * All identity metadata (recipe, revision, container, volume, network,
 * compute, review membership, provider IDs) stays exactly equal. */
const ObservationString = z.string().max(4096);
const RuntimeProgress = z.object({ step: z.string().max(512), detail: z.string().max(8192), state: z.enum(["running", "failed", "complete"]), updatedAt: z.string().max(64) }).strict().nullable();
const RuntimeProvider = z.record(z.string(), z.unknown()).refine(value => value.released === undefined || typeof value.released === "boolean");
function assertRuntimeProviderProgress(key: string, before: unknown, after: unknown) {
  const previous = z.array(RuntimeProvider).safeParse(before), next = z.array(RuntimeProvider).safeParse(after);
  if (!previous.success || !next.success || previous.data.length !== next.data.length) throw refuse("operation-mismatch", `A closed resource release cannot change ${key}'s providers`);
  previous.data.forEach((provider, index) => {
    const { released: was, ...identity } = provider, { released: now, ...current } = next.data[index]!;
    const keys = new Set([...Object.keys(identity), ...Object.keys(current)]);
    if ([...keys].some(field => JSON.stringify(identity[field]) !== JSON.stringify(current[field])) || was === true && now !== true) throw refuse("operation-mismatch", `A closed resource release can only mark ${key}'s existing providers released`);
  });
}
const PREVIEW_KINDS = new Set(["cloudflare-tunnel", "cloudflare-dns-record", "cloudflare-dns-route", "local-http"]);
const Hex32 = z.string().regex(/^[a-f0-9]{32}$/), Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Hostname = z.string().regex(/^[a-z0-9.-]+\.[a-z]+$/i).max(253);
/** Identities Drafted's public-preview cleanup discovers and records before
 * deleting; each may be added where absent, never changed once known. */
const PREVIEW_DISCOVERY: Record<string, z.ZodType> = { hostname: Hostname, tunnelId: Uuid, zoneId: Hex32, accountId: Hex32, dnsRecordId: Hex32.nullable() };
const CLEANUP_OBSERVED = ["exact-dns-record-absent", "exact-tunnel-absent", "task-hostname-removed-shared-tunnel-preserved"];
const PreviewCleanup = z.object({ complete: z.literal(true), hostname: Hostname, tunnelId: Uuid.optional(), sharedTunnelPreserved: z.boolean().optional(),
  quickTunnelConnectorRemoved: z.literal(true).optional(), observedAt: z.string().max(64) }).strict();
/** The identity a receipt already carries under the writer's aliases
 * (Drafted hostOf/tunnelOf/dnsId and its zone/account recovery). */
function ownPreviewIdentity(existing: { kind?: string; externalId?: string }, before: Record<string, unknown>): Record<string, unknown> {
  const tunnel = (before.publicTunnel && typeof before.publicTunnel === "object" ? before.publicTunnel : {}) as Record<string, unknown>;
  const route = (before.routeResult && typeof before.routeResult === "object" ? before.routeResult : {}) as Record<string, unknown>;
  const first = (schema: z.ZodType, ...values: unknown[]) => values.find((value) => schema.safeParse(value).success);
  const external = existing.externalId ?? "";
  return {
    hostname: hostOf(before.publicUrl) ?? hostOf(before.hostname) ?? hostOf(tunnel.hostname) ?? (Hostname.safeParse(external).success ? external.toLowerCase() : undefined),
    tunnelId: first(Uuid, tunnel.id, before.tunnelId, before.id, external, /^([a-f0-9-]+)\.cfargotunnel\.com\.?$/i.exec(String(before.content ?? before.target ?? ""))?.[1]),
    dnsRecordId: first(Hex32, before.dnsRecordId, before.recordId, route.dnsTag, existing.kind === "cloudflare-dns-record" ? external : undefined),
    zoneId: first(Hex32, before.zoneId, before.zone, tunnel.zoneId),
    accountId: first(Hex32, before.accountId, before.account, tunnel.accountId),
  };
}
const hostOf = (value: unknown) => { try { return typeof value === "string" ? new URL(value.startsWith("http") ? value : `https://${value}`).hostname : undefined; } catch { return undefined; } };
/** Public-preview cleanup progress (Drafted public-preview.ts): exact
 * discovered identities consistent with the receipt's existing identity, the
 * observed-absence marker on the released write, clearing publicUrl only with
 * a completion marker for the same host, and once-only connector keys naming
 * existing same-purpose connector receipts. Returns the keys it decided. */
async function assertPreviewProgress(store: Pick<PrismaClient, "remoteTaskResource">, existing: { taskId: string; key: string; kind?: string; purpose?: string; externalId?: string },
  before: Record<string, unknown>, after: Record<string, unknown>, nextState: string) {
  const decided = new Set<string>();
  const own = ownPreviewIdentity(existing, before), knownHost = own.hostname as string | undefined;
  for (const [key, schema] of Object.entries(PREVIEW_DISCOVERY)) {
    if (!(key in after) && !(key in before)) continue;
    decided.add(key);
    if (before[key] !== undefined && before[key] !== null) { if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw refuse("operation-mismatch", `A closed resource release cannot change ${existing.key}'s known ${key}`); continue; }
    if (after[key] === undefined) continue;
    if (!schema.safeParse(after[key]).success) throw refuse("operation-mismatch", `A closed resource release records ${existing.key} ${key} only in its exact provider form`);
    if (own[key] !== undefined && after[key] !== own[key]) throw refuse("operation-mismatch", `Discovered ${key} does not match ${existing.key}'s existing identity`);
  }
  if ("cleanupObserved" in after || "cleanupObserved" in before) {
    decided.add("cleanupObserved");
    if (JSON.stringify(before.cleanupObserved) !== JSON.stringify(after.cleanupObserved)
      && (nextState !== "released" || !CLEANUP_OBSERVED.includes(String(after.cleanupObserved)))) throw refuse("operation-mismatch", `${existing.key} records an observed absence only on its own release`);
  }
  if ("publicPreviewCleanup" in after || "publicPreviewCleanup" in before) {
    decided.add("publicPreviewCleanup");
    if (before.publicPreviewCleanup !== undefined) { if (JSON.stringify(before.publicPreviewCleanup) !== JSON.stringify(after.publicPreviewCleanup)) throw refuse("operation-mismatch", `${existing.key}'s recorded preview cleanup cannot be rewritten`); }
    else {
      const marker = PreviewCleanup.safeParse(after.publicPreviewCleanup);
      if (!marker.success || knownHost && marker.data.hostname !== knownHost) throw refuse("operation-mismatch", `${existing.key} records preview cleanup only for its own host in the writer's shape`);
    }
  }
  if ("publicUrl" in after || "publicUrl" in before) {
    decided.add("publicUrl");
    if (JSON.stringify(before.publicUrl) !== JSON.stringify(after.publicUrl)
      && (after.publicUrl !== null || !PreviewCleanup.safeParse(after.publicPreviewCleanup).success || hostOf(before.publicUrl) !== (after.publicPreviewCleanup as { hostname?: string }).hostname)) throw refuse("operation-mismatch", `${existing.key}'s publicUrl may only be cleared with its completed cleanup`);
  }
  if ("connectorKeys" in after || "connectorKeys" in before) {
    decided.add("connectorKeys");
    if (before.connectorKeys !== undefined) { if (JSON.stringify(before.connectorKeys) !== JSON.stringify(after.connectorKeys)) throw refuse("operation-mismatch", `${existing.key}'s connector keys cannot change`); }
    else {
      const keys = z.array(z.string().min(1).max(512)).max(100).safeParse(after.connectorKeys);
      if (!keys.success || keys.data.length === 0 || keys.data.join("\0") !== [...new Set(keys.data)].sort().join("\0") || keys.data.includes(existing.key)) throw refuse("operation-mismatch", `${existing.key} records connector keys only as its sorted connector receipts`);
      const connectors = await store.remoteTaskResource.findMany({ where: { taskId: existing.taskId, key: { in: keys.data }, kind: { in: ["launch-agent", "docker-container"] }, ...(existing.purpose ? { purpose: existing.purpose } : {}) } });
      if (connectors.length !== keys.data.length) throw refuse("operation-mismatch", `${existing.key}'s connector keys must name its existing connector receipts`);
    }
  }
  return decided;
}
export async function assertClosedReleaseResourceUpdate(existing: { taskId: string; key: string; kind?: string; purpose?: string; externalId?: string; state: string; metadata: unknown; expiresAt: Date | null },
  next: { state: string; metadata?: unknown; expiresAt: Date | null }, store?: Pick<PrismaClient, "remoteTaskResource">) {
  const binding = currentToolingOperation();
  if (!binding || binding.kind !== CLOSED_RESOURCE_RELEASE_KIND) return;
  if (existing.taskId !== binding.taskId || existing.key !== binding.resourceKey) throw refuse("operation-mismatch", `A closed resource release updates only resource ${binding.resourceKey}`);
  if (existing.state === "released" && next.state !== "released") throw refuse("operation-mismatch", `Released resource ${existing.key} cannot be resurrected`);
  if ((existing.expiresAt?.getTime() ?? null) !== (next.expiresAt?.getTime() ?? null)) throw refuse("operation-mismatch", `A closed resource release cannot change ${existing.key}'s expiry`);
  if (next.metadata === undefined) return;
  const before = (existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}) as Record<string, unknown>;
  const after = (next.metadata && typeof next.metadata === "object" ? next.metadata : {}) as Record<string, unknown>;
  const runtime = existing.kind === "task-runtime";
  const preview = existing.kind !== undefined && PREVIEW_KINDS.has(existing.kind) && store ? await assertPreviewProgress(store, existing, before, after, next.state) : new Set<string>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (preview.has(key)) continue;
    if (key === "observed" || key === "observedAt") { if (key in after && !ObservationString.safeParse(after[key]).success) throw refuse("operation-mismatch", `A closed resource release records ${key} only as an observation string`); continue; }
    if (runtime && key === "progress") { if (!RuntimeProgress.safeParse(after[key] ?? null).success) throw refuse("operation-mismatch", `A closed resource release records ${existing.key} progress only in its runtime shape`); continue; }
    if (runtime && key === "providers") { assertRuntimeProviderProgress(existing.key, before[key], after[key]); continue; }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw refuse("operation-mismatch", `A closed resource release cannot change ${existing.key} metadata ${key}`);
  }
}
