import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import type { BeginToolingOperationRequest, ToolingOperationBinding, ToolingReleaseRecord, ToolingReleaseSelection } from "../../../../types/tooling-release.ts";
import { bindToolingOperation, canonicalDigest, getActiveToolingRelease, readToolingOperation } from "./tooling-releases.ts";

/** `remote-agent.tooling-operation/v1` adoption. A binding is identity, never
 * authority: every guarded callback still runs its own ownership, pause,
 * admission and delivery checks after this one. */
export const TOOLING_OPERATION_HEADER = "x-remote-agent-operation";
/** Process context for release-aware adapters spawned by the server. Old
 * protocols never receive new stdin/envelope fields; REMOTE_AGENT_TOOLING_ROOT
 * keeps its historical (task pin) meaning. */
export const TOOLING_OPERATION_ENV = "REMOTE_AGENT_TOOLING_OPERATION";
/** `FINALIZATION_PREPARED` in finalization-receipts.ts (pinned by test). This
 * module stays a leaf: importing the finalization graph creates load cycles. */
export const FINALIZATION_PREPARED_ACTION = "finalization-prepared";
export const NEXT_OPERATION_ROUTE = "POST /api/sessions/:sessionId/tooling-operations";

/** Exhaustive operation kinds for adapter effect callbacks (wire values). */
export const TOOLING_OPERATION_KINDS = ["compute-admission", "compute-configure", "compute-enroll", "development-intent", "finalization"] as const;
export type ToolingOperationKind = typeof TOOLING_OPERATION_KINDS[number];
/** Existing durable operation families an operation may continue. The wire
 * `existingOperationId` is the raw durable ID of that family. */
export type ExistingReference = { type: "compute-offer" | "compute-environment" | "finalization" | "development-intent"; id: string };

export const BeginToolingOperationInput = z.object({
  requestKey: z.string().trim().min(1).max(256),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(TOOLING_OPERATION_KINDS),
  existingOperationId: z.string().min(1).max(512).optional(),
  resourceKey: z.string().min(1).max(512).optional(),
}).strict();

export type ToolingOperationRefusalCode = "operation-required" | "operation-unknown" | "operation-mismatch" | "operation-ownership" | "operation-input";
export class ToolingOperationRefused extends Error {
  constructor(readonly code: ToolingOperationRefusalCode, message: string) { super(message); }
}
const refuse = (code: ToolingOperationRefusalCode, detail: string) => new ToolingOperationRefused(code, `${detail}. Begin the next independent operation with ${NEXT_OPERATION_ROUTE} from the release-aware adapter and send its operation ID in ${TOOLING_OPERATION_HEADER}; a cached adapter path cannot start new work on an inactive release.`);

type OwnershipStore = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink">;

/** The open owning task primary on this machine with unrevoked source
 * ownership. Pause/closure policy is the caller's: it differs per boundary. */
export async function assertOpenTaskPrimary(input: { prisma: OwnershipStore; config: ServerConfig; sessionId: string }) {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
  if (!task || !session || session.role !== "primary" || session.status === "closed" || !task.worktreePath
    || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId
    || task.machineId !== input.config.machine || task.phase === "closed") throw new Error("Only the open owning task primary may use tooling operations");
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
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
const finalizationInput = (requestKey: string) => ({ requestKey });
const developmentInput = (body: Body) => ({ intentRevision: body.intentRevision, intentDigest: body.intentDigest });

type CallbackContext = { latestFinalizationKey: () => Promise<string | null> };
export interface ToolingCallback {
  /** Documentation and test identity, e.g. `POST /api/tasks/:taskId/compute-claim`. */
  route: string;
  method: "POST" | "PUT";
  path: RegExp;
  scope: "task" | "session";
  kind: ToolingOperationKind;
  /** Projection whose canonical digest equals the binding's inputDigest. */
  input: (body: Body, context: CallbackContext) => Promise<unknown> | unknown;
  /** Existing durable operation the callback continues, if any. */
  reference?: (body: Body, context: CallbackContext) => Promise<ExistingReference | null> | ExistingReference | null;
  /** Bound mode: `existing` — the binding's existingOperationId must name this
   * reference; `associated` — the reference must already be associated with
   * this operation (or be its existingOperationId); unset — the input digest
   * already pins the reference (finalization requestKey). Legacy mode always
   * requires an unassociated pre-transition reference.
   */
  referenceRule?: "existing" | "associated";
  associate?: (body: Body, response: Body) => ExistingReference[];
}

const offer = (body: Body): ExistingReference | null => text(body.offerId) ? { type: "compute-offer", id: body.offerId as string } : null;
const finalization = (body: Body): ExistingReference | null => text(body.requestKey) ? { type: "finalization", id: body.requestKey as string } : null;
const latestFinalization = async (_body: Body, context: CallbackContext): Promise<ExistingReference | null> => {
  const key = await context.latestFinalizationKey();
  return key ? { type: "finalization", id: key } : null;
};
const development = (body: Body): ExistingReference | null => Number.isSafeInteger(body.intentRevision) ? { type: "development-intent", id: String(body.intentRevision) } : null;
const withoutVolatile = (body: Body, ...keys: string[]) => Object.fromEntries(Object.entries(body).filter(([key]) => !keys.includes(key)));
const taskPath = (route: string) => new RegExp(`^/api/tasks/([^/]+)/${route}$`);
const sessionPath = (route: string) => new RegExp(`^/api/sessions/([^/]+)/${route}$`);
const finalizationCallbacks = (["prepare-finalization", "confirm-finalization"] as const).flatMap(route => (["task", "session"] as const).map((scope): ToolingCallback => ({
  route: `POST /api/${scope === "task" ? "tasks/:taskId" : "sessions/:sessionId"}/${route}`, method: "POST", path: scope === "task" ? taskPath(route) : sessionPath(route), scope,
  kind: "finalization", input: body => finalizationInput(String(body.requestKey)), reference: finalization,
  associate: (body) => route === "prepare-finalization" && text(body.requestKey) ? [{ type: "finalization", id: body.requestKey as string }] : [],
})));
const requestKeyFinalization = (route: string): ToolingCallback => ({ route: `POST /api/tasks/:taskId/${route}`, method: "POST", path: taskPath(route), scope: "task",
  kind: "finalization", input: body => finalizationInput(String(body.requestKey)), reference: finalization });
const preparedFinalization = (route: string, scope: "task" | "session"): ToolingCallback => ({ route: `POST /api/${scope === "task" ? "tasks/:taskId" : "sessions/:sessionId"}/${route}`, method: "POST",
  path: scope === "task" ? taskPath(route) : sessionPath(route), scope, kind: "finalization",
  input: async (_body, context) => finalizationInput(String(await context.latestFinalizationKey())), reference: latestFinalization });

/** Every adapter callback that precedes a provider effect. Owner/desktop
 * intent recording (`/automation`), cleanup scheduling (`/cleanup-request`),
 * owner-bearer adoption and ordinary session tools are not adapter effects
 * and are deliberately excluded; GET routes are read-only. */
export const TOOLING_CALLBACKS: readonly ToolingCallback[] = [
  { route: "POST /api/tasks/:taskId/compute-request", method: "POST", path: taskPath("compute-request"), scope: "task", kind: "compute-admission",
    input: body => body, associate: (_body, response) => [
      ...(text((response.environment as Body | undefined)?.id) ? [{ type: "compute-environment" as const, id: (response.environment as Body).id as string }] : []),
      ...(text(response.allocationId) ? [{ type: "compute-offer" as const, id: response.allocationId as string }] : [])] },
  { route: "POST /api/tasks/:taskId/compute-claim", method: "POST", path: taskPath("compute-claim"), scope: "task", kind: "compute-admission",
    input: body => withoutVolatile(body, "offerId"), reference: offer, referenceRule: "associated", associate: body => offer(body) ? [offer(body)!] : [] },
  { route: "POST /api/tasks/:taskId/compute-decline", method: "POST", path: taskPath("compute-decline"), scope: "task", kind: "compute-admission",
    input: () => undefined, reference: offer, referenceRule: "associated" },
  { route: "POST /api/tasks/:taskId/compute-bind", method: "POST", path: taskPath("compute-bind"), scope: "task", kind: "compute-admission",
    input: () => undefined, reference: offer, referenceRule: "associated",
    associate: (body, response) => [...(offer(body) ? [offer(body)!] : []), ...(text(response.environmentId) ? [{ type: "compute-environment" as const, id: response.environmentId as string }] : [])] },
  { route: "POST /api/tasks/:taskId/compute-configure", method: "POST", path: taskPath("compute-configure"), scope: "task", kind: "compute-configure",
    input: body => body, reference: offer, referenceRule: "existing",
    associate: (_body, response) => text(response.environmentId) ? [{ type: "compute-environment", id: response.environmentId as string }] : [] },
  { route: "POST /api/tasks/:taskId/compute-enroll", method: "POST", path: taskPath("compute-enroll"), scope: "task", kind: "compute-enroll",
    input: body => body, reference: body => text(body.environmentId) ? { type: "compute-environment", id: body.environmentId as string } : null, referenceRule: "existing",
    associate: body => text(body.environmentId) ? [{ type: "compute-environment", id: body.environmentId as string }] : [] },
  { route: "POST /api/tasks/:taskId/development-authority", method: "POST", path: taskPath("development-authority"), scope: "task", kind: "development-intent",
    input: developmentInput, reference: development, referenceRule: "existing" },
  { route: "POST /api/tasks/:taskId/development-complete", method: "POST", path: taskPath("development-complete"), scope: "task", kind: "development-intent",
    input: developmentInput, reference: development, referenceRule: "existing" },
  ...finalizationCallbacks,
  requestKeyFinalization("cleanup-authority"),
  requestKeyFinalization("cleanup-progress"),
  requestKeyFinalization("cleanup-status"),
  requestKeyFinalization("cleanup-report"),
  requestKeyFinalization("cleanup-inventory-ownership"),
  preparedFinalization("browser-stop-authority", "session"),
  preparedFinalization("archive-retention", "session"),
  preparedFinalization("legacy-evidence", "session"),
];
/** A development-scoped local service stop belongs to its development intent;
 * otherwise it belongs to the accepted finalization. */
const LOCAL_SERVICE_STOP: Record<"development" | "finalization", ToolingCallback> = {
  development: { route: "POST /api/sessions/:sessionId/local-service-stop-authority", method: "POST", path: sessionPath("local-service-stop-authority"), scope: "session",
    kind: "development-intent", input: body => developmentInput((body.development ?? {}) as Body), reference: body => development((body.development ?? {}) as Body), referenceRule: "existing" },
  finalization: preparedFinalization("local-service-stop-authority", "session"),
};

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
export const isToolingCallbackPath = (method: string, pathname: string) => method !== "GET" && (sessionPath("local-service-stop-authority").test(pathname) || TOOLING_CALLBACKS.some(callback => callback.method === method && callback.path.test(pathname)));

export type ToolingOperationDependencies = {
  active: (input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string }) => Promise<ToolingReleaseSelection | null>;
  bind: (input: { prisma: PrismaClient; config: ServerConfig; taskId: string; sessionId: string; turnId: string | null; request: BeginToolingOperationRequest }) => Promise<ToolingOperationBinding>;
  read: (input: { prisma: PrismaClient; operationId: string }) => Promise<ToolingOperationBinding | null>;
  digest: (value: unknown) => string;
  /** Activation time of the current selection; legacy continuation requires
   * an existing receipt recorded no later than this. */
  activatedAt: (input: { prisma: PrismaClient; repositoryId: string }) => Promise<Date | null>;
};
export const toolingOperationDependencies: ToolingOperationDependencies = {
  active: getActiveToolingRelease,
  bind: bindToolingOperation,
  read: readToolingOperation,
  digest: canonicalDigest,
  // ToolingReleaseSelection does not yet expose activation time (contract
  // says the selection contains it); read DRA-28's row until it does.
  activatedAt: async ({ prisma, repositoryId }) => (await prisma.toolingSelection.findUnique({ where: { repositoryId } }))?.activatedAt ?? null,
};

/** Request-scoped binding for inner consumers. Only the guarded callback
 * boundary sets it; inner code never selects a release itself. A legacy
 * continuation scope pins the pre-protocol configured revision instead. */
type Scope = { binding: ToolingOperationBinding } | { legacy: ExistingReference };
const scope = new AsyncLocalStorage<Scope>();
export const runWithToolingOperation = <T>(binding: ToolingOperationBinding, operation: () => Promise<T>) => scope.run({ binding }, operation);
export const runAsLegacyContinuation = <T>(reference: ExistingReference, operation: () => Promise<T>) => scope.run({ legacy: reference }, operation);
export const currentToolingOperation = (): ToolingOperationBinding | undefined => { const value = scope.getStore(); return value && "binding" in value ? value.binding : undefined; };
export const inLegacyContinuation = () => { const value = scope.getStore(); return Boolean(value && "legacy" in value); };

const ASSOCIATION = "tooling-operation-association";
const associationSource = (taskId: string) => `tooling-operation:${taskId}`;
const associationKey = (reference: ExistingReference) => `${reference.type}:${reference.id}`;
type Store = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeMetadataEvent" | "computeOffer" | "computeEnvironment">;

/** Lifecycle association between a durable existing operation (offer,
 * environment, finalization, intent) and the binding that produced or last
 * continued it. Stored as an append-only metadata receipt on the primary. */
export async function associatedOperationId(store: Pick<PrismaClient, "runtimeMetadataEvent">, task: Pick<RemoteTask, "id" | "primarySessionId">, reference: ExistingReference) {
  if (!task.primarySessionId) return null;
  const event = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: associationSource(task.id), action: ASSOCIATION, key: associationKey(reference) }, orderBy: { sequence: "desc" } });
  if (!event?.value) return null;
  return z.object({ version: z.literal(1), operationId: z.string() }).passthrough().parse(JSON.parse(event.value)).operationId;
}
export async function associateToolingOperation(store: Pick<PrismaClient, "runtimeMetadataEvent">, binding: ToolingOperationBinding, references: ExistingReference[]) {
  for (const reference of references) {
    if (await associatedOperationId(store, { id: binding.taskId, primarySessionId: binding.sessionId }, reference) === binding.operationId) continue;
    await store.runtimeMetadataEvent.create({ data: { runtimeSessionId: binding.sessionId, source: associationSource(binding.taskId), action: ASSOCIATION, key: associationKey(reference),
      value: JSON.stringify({ version: 1, operationId: binding.operationId, kind: binding.kind, generation: binding.generation, releaseId: binding.release.id }) } });
  }
}

/** The binding that produced (or last continued) an existing resource group.
 * Observers, proofs and retries use it; they never read the active selection. */
export async function producingToolingOperation(input: { prisma: Pick<PrismaClient, "runtimeMetadataEvent">; task: Pick<RemoteTask, "id" | "primarySessionId" | "repositoryId"> ; reference: ExistingReference },
  dependencies: Pick<ToolingOperationDependencies, "read"> = toolingOperationDependencies): Promise<ToolingOperationBinding | null> {
  const operationId = await associatedOperationId(input.prisma, input.task, input.reference);
  if (!operationId) return null;
  const binding = await dependencies.read({ prisma: input.prisma as PrismaClient, operationId });
  if (!binding || binding.taskId !== input.task.id || binding.repositoryId !== input.task.repositoryId || binding.release.repositoryId !== input.task.repositoryId) throw new Error("Producing tooling operation does not belong to this task");
  return binding;
}

async function latestPreparedFinalization(store: Store, task: RemoteTask) {
  if (!task.primarySessionId) return null;
  return store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_PREPARED_ACTION }, orderBy: { sequence: "desc" } });
}

/** When the durable existing operation was first recorded, or null when it
 * does not exist for this exact task. */
async function existingReceiptTime(store: Store, task: RemoteTask, reference: ExistingReference): Promise<Date | null> {
  if (reference.type === "compute-offer") {
    const row = await store.computeOffer.findUnique({ where: { id: reference.id } });
    const environment = row && await store.computeEnvironment.findUnique({ where: { id: row.environmentId } });
    return row && environment?.taskId === task.id ? row.createdAt : null;
  }
  if (reference.type === "compute-environment") {
    const row = await store.computeEnvironment.findUnique({ where: { id: reference.id } });
    return row?.taskId === task.id ? row.createdAt : null;
  }
  if (!task.primarySessionId) return null;
  if (reference.type === "finalization") {
    const row = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_PREPARED_ACTION, key: reference.id }, orderBy: { sequence: "asc" } });
    return row?.occurredAt ?? null;
  }
  const sequence = Number(reference.id);
  if (!Number.isSafeInteger(sequence)) return null;
  const row = await store.runtimeMetadataEvent.findUnique({ where: { sequence } });
  return row && row.runtimeSessionId === task.primarySessionId && row.source === `development:${task.id}` && row.action === "development-compute-intent" ? row.occurredAt : null;
}

async function callbackTask(store: Store, callback: ToolingCallback, param: string) {
  if (callback.scope === "task") return store.remoteTask.findUnique({ where: { id: param } });
  return store.remoteTask.findUnique({ where: { primarySessionId: param } });
}

export type CallbackAdmission =
  | { mode: "pre-protocol" }
  | { mode: "legacy-continuation"; reference: ExistingReference }
  | { mode: "bound"; binding: ToolingOperationBinding; callback: ToolingCallback; reference?: ExistingReference };

/** Validate an adapter callback before its handler runs. Repositories with no
 * release-aware generation keep their pre-protocol behavior. Afterward a new
 * effect requires a header naming an exact binding; only an unassociated
 * receipt recorded before the active generation may continue without one. */
export async function admitToolingCallback(input: { prisma: PrismaClient; config: ServerConfig; method: string; pathname: string; header: string | undefined; body: Body },
  dependencies: ToolingOperationDependencies = toolingOperationDependencies): Promise<CallbackAdmission | null> {
  const matched = matchToolingCallback(input.method, input.pathname, input.body);
  if (!matched) return null;
  const { callback, param } = matched;
  const store = input.prisma as unknown as Store;
  const task = await callbackTask(store, callback, param);
  // Unknown tasks fall through to the handler's own ownership error.
  if (!task) {
    if (input.header) throw refuse("operation-ownership", "The operation does not belong to this task");
    return { mode: "pre-protocol" };
  }
  const context: CallbackContext = { latestFinalizationKey: async () => (await latestPreparedFinalization(store, task))?.key ?? null };
  const active = await dependencies.active({ prisma: input.prisma, config: input.config, repositoryId: task.repositoryId });
  if (!input.header) {
    if (!active) return { mode: "pre-protocol" };
    const reference = callback.reference ? await callback.reference(input.body, context) : null;
    if (!reference) throw refuse("operation-required", `${callback.route} starts a new effect after release-aware activation`);
    const recorded = await existingReceiptTime(store, task, reference);
    const activatedAt = await dependencies.activatedAt({ prisma: input.prisma, repositoryId: task.repositoryId });
    if (!recorded || !activatedAt || recorded.getTime() > activatedAt.getTime()) throw refuse("operation-required", `${callback.route} has no exact pre-transition ${reference.type} receipt`);
    if (await associatedOperationId(store, task, reference)) throw refuse("operation-required", `${reference.type} ${reference.id} belongs to a bound operation`);
    if (reference.type === "compute-offer") {
      const row = await store.computeOffer.findUnique({ where: { id: reference.id } });
      if (row && await associatedOperationId(store, task, { type: "compute-environment", id: row.environmentId })) throw refuse("operation-required", `compute environment ${row.environmentId} belongs to a bound operation`);
    }
    return { mode: "legacy-continuation", reference };
  }
  const binding = await dependencies.read({ prisma: input.prisma, operationId: input.header });
  if (!binding) throw refuse("operation-unknown", "Unknown tooling operation");
  if (binding.taskId !== task.id || binding.repositoryId !== task.repositoryId || binding.release.repositoryId !== task.repositoryId
    || binding.sessionId !== task.primarySessionId || (callback.scope === "session" && binding.sessionId !== param)) throw refuse("operation-ownership", "The operation does not belong to this task's primary session");
  if (binding.kind !== callback.kind) throw refuse("operation-mismatch", `${callback.route} requires a ${callback.kind} operation, not ${binding.kind}`);
  const projection = await callback.input(input.body, context);
  if (projection !== undefined && dependencies.digest(projection) !== binding.inputDigest) throw refuse("operation-input", `${callback.route} input differs from the bound operation`);
  const reference = callback.reference ? await callback.reference(input.body, context) : null;
  if (callback.reference && !reference) throw refuse("operation-input", `${callback.route} names no existing operation`);
  if (reference) {
    if (callback.referenceRule === "existing" && binding.existingOperationId !== reference.id) throw refuse("operation-mismatch", `${callback.route} continues ${reference.type} ${reference.id}, not the bound existing operation`);
    if (callback.referenceRule === "associated" && binding.existingOperationId !== reference.id) {
      let associated = await associatedOperationId(store, task, reference);
      if (!associated && reference.type === "compute-offer") {
        const row = await store.computeOffer.findUnique({ where: { id: reference.id } });
        if (row) associated = await associatedOperationId(store, task, { type: "compute-environment", id: row.environmentId });
      }
      if (associated !== binding.operationId) throw refuse("operation-mismatch", `${reference.type} ${reference.id} is not associated with this operation`);
    }
  }
  if (binding.resourceKey && typeof input.body.resourceKey === "string" && input.body.resourceKey !== binding.resourceKey) throw refuse("operation-input", `${callback.route} resource differs from the bound operation`);
  return { mode: "bound", binding, callback, ...(reference ? { reference } : {}) };
}

/** Executing turn identity for a binding: the session's current started turn,
 * or null for a server-initiated continuation. */
async function executingTurn(prisma: PrismaClient, sessionId: string, runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">) {
  const observed = runtime?.observeSessionActivity?.(sessionId);
  if (observed?.state === "executing" && observed.requestId) return observed.requestId;
  const turn = await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: sessionId }, orderBy: { sequence: "desc" } });
  return turn?.phase === "started" && turn.requestId ? turn.requestId : null;
}

async function assertExistingForKind(prisma: PrismaClient, task: RemoteTask, kind: ToolingOperationKind, existingOperationId: string | undefined) {
  if (!existingOperationId) {
    if (kind === "compute-configure" || kind === "compute-enroll" || kind === "development-intent") throw new ToolingOperationRefused("operation-input", `${kind} operations continue an exact existing operation`);
    return;
  }
  const type: ExistingReference["type"] = kind === "compute-admission" || kind === "compute-configure" ? "compute-offer"
    : kind === "compute-enroll" ? "compute-environment" : kind === "finalization" ? "finalization" : "development-intent";
  if (!await existingReceiptTime(prisma as unknown as Store, task, { type, id: existingOperationId })) throw new ToolingOperationRefused("operation-input", `Existing ${type} ${existingOperationId} does not belong to this task`);
}

/** POST /api/sessions/:sessionId/tooling-operations. Binds identity before
 * effects; the effect callbacks keep their own authority checks. A paused
 * task gets no new operation; only an owner development intent (the owner's
 * own pause/resume request) may still bind while paused. */
export async function beginSessionToolingOperation(input: { prisma: PrismaClient; config: ServerConfig; runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">; sessionId: string; request: unknown },
  dependencies: ToolingOperationDependencies = toolingOperationDependencies) {
  const parsed = BeginToolingOperationInput.safeParse(input.request);
  if (!parsed.success) throw new ToolingOperationRefused("operation-input", "A requestKey, canonical inputDigest and known operation kind are required");
  const request = parsed.data;
  const owned = async () => {
    const value = await assertOpenTaskPrimary({ prisma: input.prisma, config: input.config, sessionId: input.sessionId });
    if (value.task.ownerPaused && request.kind !== "development-intent") throw new ToolingOperationRefused("operation-ownership", "Task is paused by its owner; no new tooling operation starts");
    return value;
  };
  const before = await owned();
  await assertExistingForKind(input.prisma, before.task, request.kind, request.existingOperationId);
  const turnId = await executingTurn(input.prisma, input.sessionId, input.runtime);
  const binding = await dependencies.bind({ prisma: input.prisma, config: input.config, taskId: before.task.id, sessionId: input.sessionId, turnId, request });
  if (binding.contract !== "remote-agent.tooling-operation/v1" || binding.taskId !== before.task.id || binding.sessionId !== input.sessionId || binding.repositoryId !== before.task.repositoryId
    || binding.requestKey !== request.requestKey || binding.kind !== request.kind || binding.inputDigest !== request.inputDigest
    || binding.existingOperationId !== (request.existingOperationId ?? null) || binding.resourceKey !== (request.resourceKey ?? null)) throw new ToolingOperationRefused("operation-mismatch", "Operation request key already names a different operation");
  // Binding persistence awaited; ownership/pause may have changed meanwhile.
  // The binding remains audit identity only — no effect is authorized by it.
  const after = await owned();
  if (after.task.id !== before.task.id || after.task.worktreePath !== before.task.worktreePath) throw new ToolingOperationRefused("operation-ownership", "Task ownership changed while binding the operation");
  return { binding };
}

/** GET /api/sessions/:sessionId/tooling-operations/:operationId — only the
 * exact owned binding; never another task's or a delegate's. */
export async function readSessionToolingOperation(input: { prisma: PrismaClient; sessionId: string; operationId: string }, dependencies: Pick<ToolingOperationDependencies, "read"> = toolingOperationDependencies) {
  const binding = await dependencies.read({ prisma: input.prisma, operationId: input.operationId });
  if (!binding || binding.sessionId !== input.sessionId) return null;
  const task = await input.prisma.remoteTask.findUnique({ where: { id: binding.taskId } });
  if (!task || task.primarySessionId !== input.sessionId || task.repositoryId !== binding.repositoryId) return null;
  return { binding };
}

/** Server-initiated operation (compute continuation). Same identity rules as
 * an adapter begin; ownership/pause checks remain the caller's operation's. */
export async function bindServerToolingOperation(input: { prisma: PrismaClient; config: ServerConfig; task: Pick<RemoteTask, "id" | "primarySessionId" | "repositoryId">; request: z.input<typeof BeginToolingOperationInput> },
  dependencies: ToolingOperationDependencies = toolingOperationDependencies): Promise<ToolingOperationBinding | null> {
  if (!input.task.primarySessionId) throw new Error("Tooling operation requires the task's original primary");
  if (!await dependencies.active({ prisma: input.prisma, config: input.config, repositoryId: input.task.repositoryId })) return null;
  const request = BeginToolingOperationInput.parse(input.request);
  const binding = await dependencies.bind({ prisma: input.prisma, config: input.config, taskId: input.task.id, sessionId: input.task.primarySessionId, turnId: null, request });
  if (binding.taskId !== input.task.id || binding.kind !== request.kind || binding.inputDigest !== request.inputDigest || binding.requestKey !== request.requestKey) throw new Error("Server tooling operation identity changed");
  return binding;
}

/** Release for a consumer: an explicit binding wins, then the request-scoped
 * callback binding. Inner consumers never read the active selection. */
export function boundRelease(explicit?: ToolingReleaseRecord | null): ToolingReleaseRecord | null | undefined {
  if (explicit !== undefined) return explicit;
  if (inLegacyContinuation()) return null;
  return currentToolingOperation()?.release;
}
