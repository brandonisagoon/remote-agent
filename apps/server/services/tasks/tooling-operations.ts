import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Prisma, PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import type { BeginToolingOperationRequest, ToolingOperationBinding, ToolingReleaseRecord, ToolingReleaseSelection, ToolingStateFormat } from "../../../../types/tooling-release.ts";
import {
  bindToolingOperation, canonicalDigest, getActiveToolingRelease, readToolingLegacyBoundary, readToolingLegacyConsumer, readToolingOperation, transitionToolingOperation,
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
const EXISTING_TYPE: Record<ToolingOperationKind, ExistingReference["type"]> = {
  "compute-admission": "compute-offer", "compute-configure": "compute-offer", "compute-enroll": "compute-environment",
  "development-intent": "development-intent", finalization: "finalization", "cleanup-schedule": "cleanup-request",
};

/** Root fence for one complete adapter command, bound before its first effect
 * (including effects with no server callback). Callback bindings name it as
 * `parentOperationId` and inherit its release; it is never a callback kind. */
export const ADAPTER_COMMAND_KIND = "adapter-command";
export const BeginToolingOperationInput = z.object({
  requestKey: z.string().trim().min(1).max(256),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum([...TOOLING_OPERATION_KINDS, ADAPTER_COMMAND_KIND]),
  existingOperationId: z.string().min(1).max(512).optional(),
  resourceKey: z.string().min(1).max(512).optional(),
  parentOperationId: z.string().min(1).max(256).optional(),
}).strict().refine(value => value.kind !== ADAPTER_COMMAND_KIND || !value.parentOperationId, "An adapter command is a root binding");

export type ToolingOperationRefusalCode = "operation-required" | "operation-unknown" | "operation-mismatch" | "operation-ownership" | "operation-input" | "operation-closed" | "retained-release-required" | "producer-unknown";
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

type Body = Record<string, unknown>;
type Store = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeMetadataEvent" | "computeOffer" | "computeEnvironment" | "remoteTaskResource">;
type CallbackContext = { store: Store; task: RemoteTask; latestFinalizationKey: () => Promise<string | null> };
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
    input: body => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "offerId")), reference: offer, referenceRule: "admission" },
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
type Scope = { binding: ToolingOperationBinding } | { legacy: ExistingReference; code: ToolingCodeIdentity | null };
const scope = new AsyncLocalStorage<Scope>();
export const runWithToolingOperation = <T>(binding: ToolingOperationBinding, operation: () => Promise<T>) => scope.run({ binding }, operation);
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
const Association = z.object({ version: z.literal(1), operationId: z.string(), role: z.enum(["owner", "admission", "producer", "completion"]), state: z.enum(["intent", "confirmed", "failed"]), evidence: z.string().optional() }).passthrough();
type Role = z.infer<typeof Association>["role"];
const associationKey = (role: Role, id: string) => `${role}:${id}`;
const referenceId = (reference: Pick<ExistingReference, "type" | "id">) => `${reference.type}:${reference.id}`;
async function associations(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, role: Role, id: string) {
  if (!task.primarySessionId) return [];
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `tooling-operation:${task.id}`, action: ASSOCIATION, key: associationKey(role, id) }, orderBy: { sequence: "desc" }, take: 64 });
  return events.map(event => Association.parse(JSON.parse(event.value ?? "null")));
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
export async function owningOperationId(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, reference: ExistingReference) {
  return (await associations(store, task, "owner", referenceId(reference))).at(-1)?.operationId ?? null;
}
async function admittingOperationId(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, environmentKey: string) {
  return (await associations(store, task, "admission", `environment-key:${environmentKey}`))[0]?.operationId ?? null;
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
  | { mode: "legacy-continuation"; reference: ExistingReference; code: ToolingCodeIdentity }
  | { mode: "bound"; binding: ToolingOperationBinding; callback: ToolingCallback; body: Body; context: CallbackContext; reference?: ExistingReference };

async function callbackTask(store: Store, callback: Pick<ToolingCallback, "scope">, param: string) {
  return callback.scope === "task" ? store.remoteTask.findUnique({ where: { id: param } }) : store.remoteTask.findUnique({ where: { primarySessionId: param } });
}
const PAUSE_BLOCKED: readonly string[] = ["compute-admission", "compute-configure", "compute-enroll", "cleanup-schedule"];

/** Current authority for a bound callback; repeated immediately before the
 * handler so an await cannot carry a stale owner/pause/source decision. */
async function assertBindingAuthority(input: { prisma: PrismaClient; config: ServerConfig; binding: ToolingOperationBinding }) {
  const task = await input.prisma.remoteTask.findUnique({ where: { id: input.binding.taskId } });
  if (!task || task.primarySessionId !== input.binding.sessionId || task.repositoryId !== input.binding.repositoryId) throw refuse("operation-ownership", "The operation no longer belongs to this task's primary session");
  if (input.binding.kind !== "finalization") {
    try { await assertOpenTaskPrimary({ prisma: input.prisma, config: input.config, sessionId: input.binding.sessionId }); }
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
    await assertBindingAuthority({ prisma: input.prisma, config: input.config, binding });
    return null;
  }
  const matched = matchToolingCallback(input.method, input.pathname, input.body);
  if (!matched) return null;
  const { callback, param } = matched;
  const task = await callbackTask(store, callback, param);
  if (!task) {
    if (input.header) throw refuse("operation-ownership", "The operation does not belong to this task");
    return { mode: "pre-protocol" };
  }
  const context: CallbackContext = { store, task, latestFinalizationKey: async () => (await latestPreparedFinalization(store, task))?.key ?? null };
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
  if (reference && callback.referenceRule === "admission") {
    const environment = await offerEnvironment(context, reference.id);
    const admitting = environment ? await admittingOperationId(store, task, environment.key) : null;
    if (binding.existingOperationId !== reference.id && (!admitting || !await sameLineage(input.prisma, admitting, binding, dependencies.read))) throw refuse("operation-mismatch", `${reference.type} ${reference.id} was not admitted by this operation`);
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
  await assertBindingAuthority({ prisma: input.prisma, config: input.config, binding });
  return { mode: "bound", binding, callback, body: input.body, context, ...(reference ? { reference } : {}) };
}

/** Before effects: mark running and persist ownership/admission/producer
 * intent, then recheck authority. Every write precedes the handler, so a lost
 * response leaves a durable, reconcilable association, not an unbound effect. */
export async function beforeBoundCallback(prisma: PrismaClient, config: ServerConfig, admission: Extract<CallbackAdmission, { mode: "bound" }>, dependencies: ToolingOperationDependencies = toolingOperationDependencies) {
  let { binding } = admission;
  if (binding.status === "bound") {
    try { binding = await dependencies.transition({ prisma, operationId: binding.operationId, from: "bound", to: "running" }); }
    catch { binding = (await dependencies.read({ prisma, operationId: binding.operationId })) ?? binding; }
  }
  const { callback, body, context, reference } = admission;
  if (reference && callback.referenceRule !== "admission" && !await owningOperationId(prisma, context.task, reference)) await recordAssociation(prisma, binding, "owner", referenceId(reference), "confirmed");
  const admitted = callback.admits?.(body);
  if (admitted && await admittingOperationId(prisma, context.task, admitted) !== binding.operationId) await recordAssociation(prisma, binding, "admission", `environment-key:${admitted}`, "confirmed");
  const produced = binding.status === "completed" ? [] : await callback.produces?.(body, context) ?? [];
  for (const environmentId of produced) await recordAssociation(prisma, binding, "producer", `compute-environment:${environmentId}`, "intent");
  await assertBindingAuthority({ prisma, config, binding });
  return { binding, produced };
}

/** After the handler: success confirms producer intent and may complete the
 * operation with its protocol evidence; a refused (4xx) handler fails the
 * intent; an exception or 5xx leaves it unknown and the operation `unknown`. */
export async function afterBoundCallback(prisma: PrismaClient, admission: Extract<CallbackAdmission, { mode: "bound" }>, state: { binding: ToolingOperationBinding; produced: string[] }, status: number | "exception",
  dependencies: ToolingOperationDependencies = toolingOperationDependencies) {
  const ok = typeof status === "number" && status >= 200 && status < 300, refused = typeof status === "number" && status >= 400 && status < 500;
  for (const environmentId of state.produced) if (ok || refused) await recordAssociation(prisma, state.binding, "producer", `compute-environment:${environmentId}`, ok ? "confirmed" : "failed");
  const current = await dependencies.read({ prisma, operationId: state.binding.operationId });
  if (!current) return;
  if (!ok && !refused && current.status === "running") await dependencies.transition({ prisma, operationId: current.operationId, from: "running", to: "unknown" }).catch(() => undefined);
  const evidence = ok ? admission.callback.completes?.(admission.body) : null;
  if (evidence && (current.status === "running" || current.status === "unknown")) {
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
    const value = await assertOpenTaskPrimary({ prisma: input.prisma, config: input.config, sessionId: input.sessionId });
    if (value.task.ownerPaused && PAUSE_BLOCKED.includes(request.kind)) throw new ToolingOperationRefused("operation-ownership", "Task is paused by its owner; no new tooling operation starts");
    return value;
  };
  const before = await owned();
  if ((request.kind === "compute-configure" || request.kind === "compute-enroll" || request.kind === "development-intent") && !request.existingOperationId) throw new ToolingOperationRefused("operation-input", `${request.kind} operations continue an exact existing operation`);
  // The release this request would run: its command parent's (validated and
  // inherited atomically by the binding primitive), else the active one.
  const parent = request.parentOperationId ? await dependencies.read({ prisma: input.prisma, operationId: request.parentOperationId }) : null;
  if (request.parentOperationId && (!parent || parent.kind !== ADAPTER_COMMAND_KIND || parent.taskId !== before.task.id || parent.sessionId !== input.sessionId)) throw new ToolingOperationRefused("operation-ownership", "Parent must be this primary's adapter-command binding");
  if (request.existingOperationId && request.kind !== ADAPTER_COMMAND_KIND) {
    const type = EXISTING_TYPE[request.kind];
    const reference: ExistingReference = { type, id: type === "finalization" || type === "cleanup-request" ? `${before.task.id}:${request.existingOperationId}` : request.existingOperationId };
    if (!await existingReceipt(input.prisma, before.task, reference)) throw new ToolingOperationRefused("operation-input", `Existing ${type} ${request.existingOperationId} does not belong to this task`);
    let ownerId = await owningOperationId(input.prisma, before.task, reference);
    if (!ownerId && request.kind === "compute-admission") {
      const environment = await offerEnvironment({ store: input.prisma as unknown as Store, task: before.task }, reference.id);
      ownerId = environment ? await admittingOperationId(input.prisma, before.task, environment.key) : null;
    }
    if (ownerId) {
      const original = await dependencies.read({ prisma: input.prisma, operationId: ownerId });
      if (!original) throw new ToolingOperationRefused("operation-unknown", "Existing operation binding is missing");
      // The original binding continues under a fresh key or a new command
      // fence only when it would run the same retained code; never newer code.
      const requested = parent?.release ?? (await dependencies.active({ prisma: input.prisma, config: input.config, repositoryId: before.task.repositoryId }))?.release;
      if (original.kind === request.kind && original.inputDigest === request.inputDigest && original.resourceKey === (request.resourceKey ?? null)
        && ((original.parentOperationId ?? null) === (request.parentOperationId ?? null) || requested?.id === original.release.id)) return { binding: original };
      throw new ToolingOperationRefused("retained-release-required", `${type} ${request.existingOperationId} belongs to operation ${original.operationId} (${original.kind}, release ${original.release.revision}); continue that operation with its release`);
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

/** Server-initiated continuation of an existing group (idle suspension). Runs
 * the group's own code: its producer's release (only when that is also the
 * active release, until DRA-28 offers retained-release binding), or its
 * retained legacy snapshot without a binding. */
export async function bindServerContinuation(input: { prisma: PrismaClient; config: ServerConfig; task: RemoteTask; environmentId: string; request: z.input<typeof BeginToolingOperationInput> },
  dependencies: ToolingOperationDependencies = toolingOperationDependencies): Promise<{ binding: ToolingOperationBinding | null; code: ToolingCodeIdentity | null }> {
  if (!input.task.primarySessionId) throw new Error("Tooling operation requires the task's original primary");
  const group = await resourceGroupCode({ prisma: input.prisma, task: input.task, reference: { type: "compute-environment", id: input.environmentId } }, dependencies);
  if (!group.binding) return { binding: null, code: group.code };
  const request = BeginToolingOperationInput.parse(input.request);
  const ownerId = request.existingOperationId ? await owningOperationId(input.prisma, input.task, { type: "development-intent", id: request.existingOperationId }) : null;
  const prior = ownerId ? await dependencies.read({ prisma: input.prisma, operationId: ownerId }) : null;
  if (prior) {
    if (prior.kind === request.kind && prior.inputDigest === request.inputDigest && prior.release.id === group.binding.release.id) return { binding: prior, code: prior.release };
    throw new ToolingOperationRefused("retained-release-required", `Development intent ${request.existingOperationId} belongs to operation ${prior.operationId}`);
  }
  const active = await dependencies.active({ prisma: input.prisma, config: input.config, repositoryId: input.task.repositoryId });
  if (!active || active.release.id !== group.binding.release.id) throw new ToolingOperationRefused("retained-release-required", `Compute environment ${input.environmentId} runs release ${group.binding.release.revision}; continuation requires a retained-release binding`);
  const binding = await dependencies.bind({ prisma: input.prisma, config: input.config, taskId: input.task.id, sessionId: input.task.primarySessionId, turnId: null, request });
  if (binding.taskId !== input.task.id || binding.kind !== request.kind || binding.inputDigest !== request.inputDigest || binding.release.id !== group.binding.release.id) throw new Error("Server tooling operation identity changed");
  if (request.existingOperationId) await recordAssociation(input.prisma, binding, "owner", referenceId({ type: "development-intent", id: request.existingOperationId }), "confirmed");
  return { binding, code: binding.release };
}

const CapabilityReceipt = z.object({ capability: z.string(), source: z.literal("configured-host"), capabilityRevision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), checkout: z.string().startsWith("/") }).passthrough();
async function recordedCapability(tx: Prisma.TransactionClient, task: Pick<RemoteTask, "id" | "primarySessionId">, capability: "runtime" | "cleanup") {
  if (!task.primarySessionId) return null;
  const events = await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `task:${task.id}`, action: "tooling-capability" }, orderBy: { sequence: "desc" }, take: 200 });
  for (const event of events) {
    const receipt = CapabilityReceipt.safeParse(JSON.parse(event.value ?? "null"));
    if (receipt.success && receipt.data.capability === capability) return receipt.data;
  }
  return null;
}
const provenance = (receipt: z.infer<typeof CapabilityReceipt> | null, what: string): ToolingLegacyConsumerInput["provenance"] =>
  receipt ? { revision: receipt.capabilityRevision, checkout: receipt.checkout, receipt } : { unavailable: `No recorded configured-host ${what} capability receipt; original executable unknown` };

/** DRA-28 `ToolingLegacyInventory`: every pre-boundary consumer with the
 * exact executable receipt it used, from durable receipts only — never the
 * current configuration. Runs inside the first activation transaction. */
export const inventoryLegacyToolingConsumers: ToolingLegacyInventory = async (tx, input) => {
  const tasks = await tx.remoteTask.findMany({ where: { repositoryId: input.repositoryId, phase: { not: "closed" } }, orderBy: { id: "asc" }, take: 2001 });
  if (tasks.length > 2000) throw new Error("Legacy consumer inventory exceeds its bound");
  const consumers: ToolingLegacyConsumerInput[] = [];
  for (const task of tasks) {
    const runtime = await recordedCapability(tx, task, "runtime"), cleanup = await recordedCapability(tx, task, "cleanup");
    for (const environment of await tx.computeEnvironment.findMany({ where: { taskId: task.id }, take: 101 })) {
      consumers.push({ taskId: task.id, consumerKind: "compute-environment", consumerId: environment.id, provenance: provenance(runtime, "runtime") });
      for (const row of await tx.computeOffer.findMany({ where: { environmentId: environment.id, state: { in: ["queued", "offered", "validating", "claimed", "running", "unknown"] } }, take: 101 }))
        consumers.push({ taskId: task.id, consumerKind: "compute-offer", consumerId: row.id, provenance: provenance(runtime, "runtime") });
    }
    for (const baseline of await tx.computeBaseline.findMany({ where: { taskId: task.id }, take: 11 }))
      consumers.push({ taskId: task.id, consumerKind: "compute-baseline", consumerId: `${task.id}:${baseline.purpose}`, provenance: provenance(runtime, "runtime") });
    if (!task.primarySessionId) continue;
    const intent = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `development:${task.id}`, action: DEVELOPMENT_INTENT_ACTION }, orderBy: { sequence: "desc" } });
    if (intent) consumers.push({ taskId: task.id, consumerKind: "development-intent", consumerId: String(intent.sequence), provenance: provenance(runtime, "runtime") });
    const prepared = await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_PREPARED_ACTION }, take: 101 });
    for (const key of new Set(prepared.map(event => event.key)))
      consumers.push({ taskId: task.id, consumerKind: "finalization", consumerId: `${task.id}:${key}`, provenance: provenance(cleanup, "cleanup") });
    for (const request of await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: CLEANUP_REQUEST_ACTION }, take: 101 })) {
      // The scheduled instruction's marker holds its exact immutable adapter.
      const instructionId = z.object({ instructionId: z.string() }).safeParse(JSON.parse(request.value ?? "null")).data?.instructionId;
      const marker = instructionId ? await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: "cleanup-inbox", action: CLEANUP_INSTRUCTION_ACTION, key: instructionId } }) : null;
      const capability = marker ? z.object({ capability: CapabilityReceipt }).passthrough().safeParse(JSON.parse(marker.value ?? "null")).data?.capability ?? null : null;
      consumers.push({ taskId: task.id, consumerKind: "cleanup-request", consumerId: `${task.id}:${request.key}`, provenance: provenance(capability, "cleanup") });
    }
  }
  return consumers;
};

// ---------------------------------------------------------------------------
// Guarded state evidence for the owning operation (frozen wire shapes in
// types/tooling-release.ts). Task/repository come from the stored operation;
// callers cannot choose another task, release or arbitrary path scope.
export const StateQuery = z.object({ family: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/), scopeKey: z.string().min(1).max(512) }).strict();
export const StateWriteInput = StateQuery.extend({ version: z.number().int().positive() }).strict();
const LIVE_OPERATION = ["bound", "running", "unknown"];

async function ownedStateOperation(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; operationId: string; header: string | undefined; scopeKey: string },
  dependencies: Pick<ToolingOperationDependencies, "read">) {
  if (!input.header || input.header !== input.operationId) throw refuse("operation-required", "State evidence requires the matching operation header");
  const binding = await dependencies.read({ prisma: input.prisma, operationId: input.operationId });
  if (!binding || binding.sessionId !== input.sessionId) throw refuse("operation-unknown", "Unknown tooling operation for this session");
  if (!LIVE_OPERATION.includes(binding.status)) throw refuse("operation-closed", `Operation ${binding.operationId} is ${binding.status}`);
  if (input.scopeKey !== "task" && input.scopeKey !== binding.resourceKey) throw refuse("operation-input", "State scope must be this operation's resource key or task");
  await assertBindingAuthority({ prisma: input.prisma, config: input.config, binding });
  return binding;
}

/** GET .../tooling-operations/:operationId/state?family&scopeKey */
export async function readOperationStateEvidence(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; operationId: string; header: string | undefined; query: unknown },
  dependencies: Pick<ToolingOperationDependencies, "read"> & { readable?: typeof import("./tooling-releases.ts").assertToolingStateReadable; retained?: typeof import("./tooling-releases.ts").readToolingRetainedConsumers } = toolingOperationDependencies): Promise<import("../../../../types/tooling-release.ts").ToolingStateEvidenceResponse> {
  const parsed = StateQuery.safeParse(input.query);
  if (!parsed.success) throw refuse("operation-input", "A state family and scopeKey are required");
  const { family, scopeKey } = parsed.data;
  const binding = await ownedStateOperation({ ...input, scopeKey }, dependencies);
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
  for (const row of legacy) {
    if (row.provenance === "unavailable") throw new ToolingOperationRefused("operation-unknown", `Retained ${row.consumerKind} ${row.consumerId} has unresolved executable provenance: ${row.detail ?? "unavailable"}`);
    consumers.set(`legacy:${row.id}`, null);
  }
  await assertBindingAuthority({ prisma: input.prisma, config: input.config, binding });
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
  const write = await (dependencies.register ?? (await import("./tooling-releases.ts")).registerToolingStateWrite)({ prisma: input.prisma, operationId: binding.operationId, ...parsed.data });
  // The receipt is not an effect; refuse to hand it out if authority changed.
  await assertBindingAuthority({ prisma: input.prisma, config: input.config, binding });
  if (write.operationId !== binding.operationId || write.version !== parsed.data.version) throw new ToolingOperationRefused("operation-mismatch", "State write receipt does not match this operation");
  return { operationId: binding.operationId, taskId: binding.taskId, family: parsed.data.family, scopeKey: parsed.data.scopeKey, write };
}
