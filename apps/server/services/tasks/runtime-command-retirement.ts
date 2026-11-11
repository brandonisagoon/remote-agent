import { z } from "zod";
import type { Prisma, PrismaClient, RemoteTask, ComputeEnvironment, ToolingOperation } from "../../../../generated/prisma/client.ts";
import { attemptRecords, producerOperationId } from "./tooling-operations.ts";
import { canonicalDigest } from "./tooling-releases.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";

type Store = PrismaClient | Prisma.TransactionClient;
const parse = (value: string | null | undefined) => { try { return JSON.parse(value ?? "null"); } catch { return null; } };
const Commit = z.object({ version: z.literal(1), operationId: z.string(), parentOperationId: z.string(), inputDigest: z.string(), attemptId: z.string(),
  requestDigest: z.string(), transitionKey: z.string(), environmentId: z.string(), readerId: z.string() }).strict();
const Compute = z.object({ configurationFile: z.string(), configurationSha256: z.string() }).strict();
const Transition = z.object({ version: z.literal(1), taskIdentity: z.string(),
  environment: z.object({ id: z.string(), recipeDigest: z.string() }).passthrough(),
  resource: z.object({ id: z.string(), key: z.string(), kind: z.string(), purpose: z.string(), state: z.string(), externalId: z.string(), expiresAt: z.string().nullable(), metadata: z.record(z.string(), z.unknown()) }).passthrough(),
  proof: z.object({ version: z.literal(1), taskId: z.string(), primarySessionId: z.string(), environmentId: z.string(), resourceId: z.string(), offerId: z.string(),
    revision: z.string(), previousRecipeHash: z.string(), recipeHash: z.string(), stopped: z.literal(true), compute: Compute }).passthrough(),
  compute: Compute, baselineFile: z.string(), stoppedObservation: z.object({ state: z.literal("stopped"), taskId: z.string(), primarySessionId: z.string(), environmentId: z.string(), resourceId: z.string(),
    revision: z.string(), recipeDigest: z.string(), configurationDigest: z.string() }).passthrough(),
}).passthrough();
export type RuntimeCommandRetirement = { parent: ToolingOperation; children: ToolingOperation[]; successorId: string; transitionSequence: number; commitSequence: number; readerIds: string[] };

/** Read-only proof for an older failed runtime command. The caller must also
 * verify ordinary adoption (fresh stopped physical resource, terminal offers,
 * current authority, no live readers), then recompute under its write lock.
 * This never infers command success from successful callbacks. */
export async function planRuntimeCommandRetirement(store: Store, input: { task: RemoteTask; environment: ComputeEnvironment; parentId: string;
  admittingCommandId: string; admissionSequence: number; offerCreatedAt: Date }): Promise<{ plan: RuntimeCommandRetirement } | { reason: string }> {
  const { task, environment } = input;
  const no = (reason: string) => ({ reason: `Runtime command ${input.parentId} cannot retire: ${reason}` });
  const parent = await store.toolingOperation.findUnique({ where: { id: input.parentId } });
  const successor = await store.toolingOperation.findUnique({ where: { id: input.admittingCommandId } });
  const owned = (row: ToolingOperation) => row.taskId === task.id && row.sessionId === task.primarySessionId && row.repositoryId === task.repositoryId;
  if (!parent || !successor || parent.id === successor.id || !owned(parent) || !owned(successor)
    || parent.kind !== "adapter-command" || parent.parentOperationId || parent.existingOperationId || parent.retainedConsumerId || parent.resourceKey !== "runtime-development"
    || !["bound", "running"].includes(parent.status) || parent.completionEvidence !== null || !parent.turnId
    || successor.kind !== "adapter-command" || successor.status !== "completed" || successor.resourceKey !== parent.resourceKey
    || parent.generation > successor.generation || parent.createdAt >= successor.createdAt
    || canonicalDigest(successor.completionEvidence) !== canonicalDigest({ kind: "command-completed", reference: successor.requestKey })) return no("no later successful command with the same runtime scope");
  const ended = await store.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: parent.sessionId, requestId: parent.turnId }, orderBy: { sequence: "desc" } });
  if (!ended || !["completed", "failed", "cancelled"].includes(ended.phase) || ended.occurredAt < parent.createdAt || ended.occurredAt >= successor.createdAt)
    return no("the original execution has not provably ended before its successor");
  const producerId = await producerOperationId(store, task, environment.id);
  const producer = producerId ? await store.toolingOperation.findUnique({ where: { id: producerId } }) : null;
  if (!producer || !owned(producer) || producer.kind !== "compute-configure" || producer.parentOperationId !== successor.id || producer.status !== "completed"
    || producer.releaseId !== successor.releaseId || producer.generation !== successor.generation || producer.protocol !== successor.protocol) return no("latest producer is not the successor's completed configuration");
  const attempts = await attemptRecords(store, { taskId: task.id, sessionId: task.primarySessionId! }, producer.id);
  const latest = attempts.find(row => row.value?.state === "intent"), acknowledged = attempts.filter(row => row.value?.attemptId === latest?.value?.attemptId && row.value?.state === "acknowledged");
  if (!latest?.value || acknowledged.length !== 1 || !acknowledged[0]!.value?.status || acknowledged[0]!.value!.status! < 200 || acknowledged[0]!.value!.status! >= 300)
    return no("successor has no latest acknowledged configuration");
  const commits = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId!, source: `tooling-operation:${task.id}`, action: "configuration-attempt-committed", key: `${producer.id}:${latest.value.attemptId}` }, take: 2 });
  const commit = commits[0], receipt = Commit.safeParse(parse(commit?.value));
  if (commits.length !== 1 || !commit || !receipt.success || receipt.data.operationId !== producer.id || receipt.data.parentOperationId !== successor.id
    || receipt.data.inputDigest !== producer.inputDigest || receipt.data.attemptId !== latest.value.attemptId || receipt.data.environmentId !== environment.id
    || commit.sequence <= latest.sequence || commit.sequence >= acknowledged[0]!.sequence || acknowledged[0]!.sequence >= input.admissionSequence) return no("configuration acknowledgment has no exact atomic receipt");
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: task.primarySessionId!, source: `compute:${task.id}`, action: "compute-runtime-configuration", key: receipt.data.transitionKey }, take: 2 });
  const event = events[0], transition = Transition.safeParse(parse(event?.value));
  const resource = environment.resourceId ? await store.remoteTaskResource.findUnique({ where: { id: environment.resourceId } }) : null;
  if (events.length !== 1 || !event || !transition.success || event.sequence >= commit.sequence || !resource || resource.taskId !== task.id
    || resource.key !== parent.resourceKey || resource.kind !== "task-runtime" || resource.purpose !== "development" || resource.state === "released") return no("no exact retained runtime transition");
  const t = transition.data, proof = t.proof, stopped = t.stoppedObservation;
  if (t.taskIdentity !== environment.taskIdentity || t.environment.id !== environment.id || t.resource.id !== resource.id
    || proof.taskId !== task.id || proof.primarySessionId !== task.primarySessionId || proof.environmentId !== environment.id || proof.resourceId !== resource.id
    || proof.offerId !== producer.existingOperationId || proof.revision !== environment.revision || proof.recipeHash !== environment.recipeDigest
    || proof.previousRecipeHash !== t.environment.recipeDigest
    || canonicalDigest(t.compute) !== canonicalDigest(proof.compute)
    || receipt.data.requestDigest !== producer.inputDigest
    || stopped.taskId !== task.id || stopped.primarySessionId !== task.primarySessionId || stopped.environmentId !== environment.id || stopped.resourceId !== resource.id
    || stopped.revision !== environment.revision || stopped.recipeDigest !== environment.recipeDigest || stopped.configurationDigest !== proof.compute.configurationSha256)
    return no("configuration proof no longer matches this task, recipe or resource");
  // Progress is mutable; container/provider/network/source/configuration identity is not.
  const stable = (row: typeof t.resource) => {
    const { observed: _observed, observedAt: _at, progress: _progress, ...metadata } = row.metadata;
    return finalizationResourceIdentity({ ...row, metadata });
  };
  if (canonicalDigest(stable({ ...resource, expiresAt: resource.expiresAt?.toISOString() ?? null, metadata: z.record(z.string(), z.unknown()).parse(resource.metadata) }))
    !== canonicalDigest(stable({ ...t.resource, metadata: { ...t.resource.metadata, recipeHash: proof.recipeHash, compute: proof.compute } }))) return no("retained runtime identity changed after configuration");
  const oldOffer = await store.computeOffer.findUnique({ where: { id: proof.offerId } });
  if (!oldOffer || oldOffer.environmentId !== environment.id || oldOffer.state !== "stopped" || !oldOffer.completedAt || oldOffer.completedAt >= input.offerCreatedAt)
    return no("the configured offer did not stop before this lifetime");
  const children = await store.toolingOperation.findMany({ where: { parentOperationId: parent.id }, take: 101 });
  if (!children.length || children.length > 100) return no("child inventory is empty or exceeds its bound");
  const ids = [parent.id, ...children.map(child => child.id)];
  if (await store.toolingOperation.count({ where: { parentOperationId: { in: children.map(child => child.id) } } })) return no("nested commands are outside runtime retirement");
  if (await store.toolingRetainedConsumer.count({ where: { operationId: parent.id } })) return no("parent has separate retained effects");
  const writes = await store.toolingStateWrite.findMany({ where: { operationId: { in: ids } }, take: 101 });
  if (writes.length > 100 || writes.some(row => row.operationId !== parent.id || row.repositoryId !== task.repositoryId || row.taskId !== task.id || row.releaseId !== parent.releaseId
    || row.family !== "drafted.runtime" || row.scopeKey !== parent.resourceKey || row.version !== 1 || !row.preservesUnknown || row.createdAt >= event.occurredAt))
    return no("command has later, unknown or unrelated state writes");
  const readers = await store.toolingRetainedConsumer.findMany({ where: { consumerKind: "compute-environment", consumerId: environment.id }, take: 1001 });
  if (readers.length > 1000) return no("reader history exceeds its bound");
  const byId = new Map(readers.map(reader => [reader.id, reader]));
  const readerProof = (reader: typeof readers[number]) => reader.taskId === task.id && reader.repositoryId === task.repositoryId && reader.status === "resolved"
    && reader.confirmedAt && reader.resolvedAt && z.object({ kind: z.enum(["compute-bind", "compute-configure"]), reference: z.literal(oldOffer.id) }).strict().safeParse(reader.evidence).success;
  const anchor = byId.get(receipt.data.readerId);
  if (!anchor || anchor.operationId !== producer.id || !readerProof(anchor)) return no("configuration reader is not resolved");
  const resolvedChain = (reader: typeof readers[number]) => {
    const seen = new Set<string>(); let next: typeof reader | undefined = reader;
    while (next && !seen.has(next.id)) {
      seen.add(next.id);
      if (!readerProof(next)) return false;
      const resolution = z.object({ kind: z.enum(["stopped", "absent", "superseded", "replaced"]), reference: z.string() }).strict().safeParse(next.resolution);
      if (!resolution.success) return false;
      if (["stopped", "absent"].includes(resolution.data.kind)) return resolution.data.reference === environment.id;
      next = byId.get(resolution.data.reference);
    }
    return false;
  };
  if (!resolvedChain(anchor)) return no("configuration reader has no stopped retirement chain");
  const readerIds: string[] = [];
  let recordCount = 0;
  for (const child of children) {
    if (!owned(child) || child.releaseId !== parent.releaseId || child.generation !== parent.generation || child.protocol !== parent.protocol || child.retainedConsumerId
      || !["compute-admission", "compute-configure"].includes(child.kind) || !["running", "completed"].includes(child.status)
      || child.resourceKey !== null && child.resourceKey !== parent.resourceKey || child.existingOperationId !== null && child.existingOperationId !== oldOffer.id)
      return no("child lineage, status or scope changed");
    const records = await attemptRecords(store, { taskId: task.id, sessionId: task.primarySessionId! }, child.id);
    recordCount += records.length;
    const routes = child.kind === "compute-configure" ? ["compute-configure"] : ["compute-request", "compute-claim", "compute-bind"];
    if (!records.length || recordCount > 1000 || records.some(row => !row.value || row.sequence >= event.sequence || row.value.operationId !== child.id || row.value.inputDigest !== child.inputDigest
      || !routes.some(route => row.value!.route === `POST /api/tasks/:taskId/${route}`) || !["intent", "acknowledged", "refused"].includes(row.value.state))) return no("child has an unknown, late or unrelated callback");
    const intents = records.filter(row => row.value!.state === "intent");
    if (!intents.length || new Set(intents.map(row => row.value!.attemptId)).size !== intents.length) return no("child attempts are ambiguous");
    for (const intent of intents) {
      const outcomes = records.filter(row => row.value!.attemptId === intent.value!.attemptId && row.value!.state !== "intent");
      if (outcomes.length !== 1 || outcomes[0]!.sequence <= intent.sequence || outcomes[0]!.value!.route !== intent.value!.route
        || intent === intents[0] && (outcomes[0]!.value!.state !== "acknowledged" || !outcomes[0]!.value!.status || outcomes[0]!.value!.status! < 200 || outcomes[0]!.value!.status! >= 300))
        return no("child has no unique acknowledged latest outcome");
    }
    if (records.some(row => !intents.some(intent => intent.value!.attemptId === row.value!.attemptId))) return no("child outcome has no original attempt");
    const consumers = await store.toolingRetainedConsumer.findMany({ where: { operationId: child.id }, take: 2 });
    const reader = consumers[0];
    if (consumers.length !== 1 || !reader || !byId.has(reader.id) || reader.releaseId !== child.releaseId || reader.generation !== child.generation || reader.protocol !== child.protocol
      || reader.scopeKey !== (child.resourceKey ?? "task") || !resolvedChain(reader)) return no("child has unresolved or unrelated retained effects");
    readerIds.push(reader.id);
  }
  return { plan: { parent, children, successorId: successor.id, transitionSequence: event.sequence, commitSequence: commit.sequence, readerIds } };
}

/** Called only at the end of the write-locked adoption transaction. Original
 * callback history, request identities and failure evidence stay immutable. */
export async function retireRuntimeCommand(tx: Prisma.TransactionClient, plan: RuntimeCommandRetirement) {
  const { parent } = plan;
  if ((await tx.toolingOperation.updateMany({ where: { id: parent.id, status: parent.status, updatedAt: parent.updatedAt },
    data: { status: "completed", completionEvidence: { kind: "runtime-command-superseded", reference: plan.successorId } } })).count !== 1) throw new Error("Runtime command changed during retirement");
  for (const child of plan.children) if (child.status !== "completed") {
    if ((await tx.toolingOperation.updateMany({ where: { id: child.id, status: child.status, updatedAt: child.updatedAt },
      data: { status: "completed", completionEvidence: { kind: "callback-acknowledged", reference: parent.id } } })).count !== 1) throw new Error("Runtime callback changed during retirement");
  }
  await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: parent.sessionId, source: `tooling-operation:${parent.taskId}`, action: "runtime-command-retired", key: parent.id,
    value: JSON.stringify({ version: 1, parentOperationId: parent.id, successorId: plan.successorId, inputDigest: parent.inputDigest, previousStatus: parent.status,
      transitionSequence: plan.transitionSequence, commitSequence: plan.commitSequence, children: plan.children.map(child => ({ operationId: child.id, inputDigest: child.inputDigest, previousStatus: child.status })), readerIds: plan.readerIds }) } });
}
