import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { ToolingOperationBinding } from "../../../../types/tooling-release.ts";
import { acknowledgedStoppedConfiguration, ComputeConfiguration } from "./compute-configuration.ts";
import { assertOpenTaskPrimary, attemptRecords, configurationRequestIdentity, producerOperationId } from "./tooling-operations.ts";
import { canonicalDigest } from "./tooling-releases.ts";

const Route = "POST /api/tasks/:taskId/compute-configure";
const Commit = z.object({ version: z.literal(1), operationId: z.string(), parentOperationId: z.string(), inputDigest: z.string(), attemptId: z.string(), requestDigest: z.string(),
  transitionKey: z.string(), environmentId: z.string(), readerId: z.string() }).strict();
const parse = (value: string | null) => { try { return JSON.parse(value ?? "null"); } catch { return null; } };

/** A supported stopped-configuration replay proves the parent's requested
 * final state, not that an older failed callback secretly succeeded. Retire
 * only ended configure children of that exact command/offer/release. Their
 * original request digests and refused/unknown outcomes remain unchanged.
 * This is also the compatibility boundary for old full-body/PID digests:
 * they are superseded by the verified same-parent transition, never rewritten
 * or treated as matching a different process's request. */
export async function reconcileConfigurationChildren(input: { prisma: PrismaClient; config: ServerConfig; binding: ToolingOperationBinding; body: Record<string, unknown>; attemptId: string }) {
  const { prisma, config, binding, attemptId } = input;
  if (binding.kind !== "compute-configure" || !binding.parentOperationId) return 0;
  const request = ComputeConfiguration.parse(input.body);
  return prisma.$transaction(async tx => {
    // Take the write lock before validating the complete family. A late child
    // callback or command settlement either precedes this proof or waits.
    const marker = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: binding.sessionId, source: `tooling-operation:${binding.taskId}`,
      action: "configuration-command-recovery", key: `${binding.operationId}:${attemptId}`, value: "null" } });
    const { task } = await assertOpenTaskPrimary({ prisma: tx as PrismaClient, config, sessionId: binding.sessionId });
    if (task.id !== binding.taskId || task.repositoryId !== binding.repositoryId || task.ownerPaused) throw new Error("Configuration recovery owner changed");
    const parent = await tx.toolingOperation.findUnique({ where: { id: binding.parentOperationId! } });
    const current = await tx.toolingOperation.findUnique({ where: { id: binding.operationId } });
    if (!parent || !current || parent.kind !== "adapter-command" || !["bound", "running"].includes(parent.status)
      || current.kind !== "compute-configure" || !["running", "unknown"].includes(current.status) || current.parentOperationId !== parent.id || current.existingOperationId !== request.offerId
      || current.inputDigest !== binding.inputDigest || current.releaseId !== binding.release.id || current.generation !== binding.generation)
      throw new Error("Configuration recovery requires the original open command and callback");
    const sameOwner = (row: typeof current) => row.taskId === task.id && row.sessionId === task.primarySessionId && row.repositoryId === task.repositoryId
      && row.releaseId === parent.releaseId && row.generation === parent.generation && row.protocol === parent.protocol;
    if (!sameOwner(parent) || !sameOwner(current)) throw new Error("Configuration recovery lineage changed");
    const children = await tx.toolingOperation.findMany({ where: { parentOperationId: parent.id, kind: "compute-configure" }, take: 101 });
    if (children.length > 100) throw new Error("Configuration child inventory exceeds its bound");
    // Never-attempted bound children remain for ordinary parent settlement.
    const candidates = children.filter(row => ["running", "unknown"].includes(row.status) && row.existingOperationId === request.offerId);
    if (!candidates.some(row => row.id !== current.id || row.status === "unknown")) {
      await tx.runtimeMetadataEvent.delete({ where: { sequence: marker.sequence } });
      return 0;
    }
    const state = await acknowledgedStoppedConfiguration({ prisma: tx, config, taskId: task.id, request });
    if (await producerOperationId(tx, task, state.environment.id) !== current.id) throw new Error("Configuration recovery producer changed");
    const commits = await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: binding.sessionId, source: `tooling-operation:${binding.taskId}`,
      action: "configuration-attempt-committed", key: `${current.id}:${attemptId}` }, take: 2 });
    const commit = commits[0], proof = Commit.safeParse(parse(commit?.value ?? null));
    if (commits.length !== 1 || !commit || !proof.success || proof.data.operationId !== current.id || proof.data.parentOperationId !== parent.id
      || proof.data.attemptId !== attemptId || proof.data.inputDigest !== current.inputDigest || proof.data.requestDigest !== canonicalDigest(configurationRequestIdentity(request))
      || proof.data.transitionKey !== state.key || proof.data.environmentId !== state.environment.id || commit.sequence <= state.event!.sequence)
      throw new Error("Configuration replay has no exact atomic transition receipt");
    const currentRecords = await attemptRecords(tx, binding, current.id);
    const intent = currentRecords.find(record => record.value?.state === "intent");
    const acknowledgments = currentRecords.filter(record => record.value?.attemptId === attemptId && record.value.state === "acknowledged");
    if (!intent || intent.value?.attemptId !== attemptId || intent.sequence >= commit.sequence || acknowledgments.length !== 1
      || acknowledgments[0]!.sequence <= commit.sequence || !acknowledgments[0]!.value?.status
      || acknowledgments[0]!.value!.status! < 200 || acknowledgments[0]!.value!.status! >= 300)
      throw new Error("Configuration replay is not the latest acknowledged attempt");
    const histories: Array<{ operationId: string; inputDigest: string; attempts: Awaited<ReturnType<typeof attemptRecords>> }> = [];
    for (const child of candidates) {
      if (!sameOwner(child) || child.resourceKey !== current.resourceKey) throw new Error("An interrupted configure child changed lineage or scope");
      const records = child.id === current.id ? currentRecords : await attemptRecords(tx, binding, child.id);
      if (!records.length || records.some(record => !record.value || record.value.operationId !== child.id || record.value.inputDigest !== child.inputDigest
        || record.value.route !== Route || !["intent", "acknowledged", "refused", "unknown"].includes(record.value.state)))
        throw new Error("Configuration child has unreadable or unrelated callback history");
      const intents = records.filter(record => record.value?.state === "intent");
      if (!intents.length || new Set(intents.map(record => record.value!.attemptId)).size !== intents.length) throw new Error("Configuration child has no unique recorded attempts");
      for (const original of intents) {
        const results = records.filter(record => record.value?.attemptId === original.value!.attemptId && record.value.state !== "intent");
        if (results.length !== 1 || results[0]!.sequence <= original.sequence) throw new Error("A configure attempt is still in flight or has conflicting outcomes");
        if (child.id !== current.id || original.value!.attemptId !== attemptId) {
          if (results[0]!.sequence >= intent.sequence) throw new Error("An earlier configure attempt did not end before this replay");
        }
      }
      if (records.some(record => !intents.some(original => original.value!.attemptId === record.value!.attemptId))) throw new Error("Configuration outcome has no original intent");
      const readers = await tx.toolingRetainedConsumer.findMany({ where: { operationId: child.id }, take: 2 });
      const reader = readers[0];
      if (readers.length !== 1 || !reader || reader.taskId !== task.id || reader.repositoryId !== task.repositoryId || reader.consumerKind !== "compute-environment"
        || reader.consumerId !== state.environment.id || reader.releaseId !== child.releaseId || reader.generation !== child.generation || reader.protocol !== child.protocol
        || reader.scopeKey !== (child.resourceKey ?? "task"))
        throw new Error("Configuration child reader changed");
      if (child.id === current.id) {
        if (reader.id !== proof.data.readerId || !reader.confirmedAt || !["confirmed", "resolved"].includes(reader.status)
          || canonicalDigest(reader.evidence) !== canonicalDigest({ kind: "compute-configure", reference: request.offerId })) throw new Error("Configuration replay reader is unconfirmed");
        if (reader.status === "resolved" && (!reader.resolvedAt || !z.object({ kind: z.enum(["stopped", "absent"]), reference: z.literal(state.environment.id) }).strict().safeParse(reader.resolution).success))
          throw new Error("Configuration replay reader has unrelated retirement evidence");
      } else {
        const resolution = z.object({ kind: z.enum(["stopped", "absent", "replaced", "superseded"]), reference: z.string() }).strict().safeParse(reader.resolution);
        if (reader.status !== "resolved" || !reader.resolvedAt || !resolution.success
          || resolution.data.reference !== (["stopped", "absent"].includes(resolution.data.kind) ? state.environment.id : proof.data.readerId))
          throw new Error("Interrupted configuration reader has no matching retirement evidence");
      }
      if (await tx.toolingStateWrite.count({ where: { operationId: child.id } })) throw new Error("Configure child has separate state-write effects");
      histories.push({ operationId: child.id, inputDigest: child.inputDigest, attempts: records });
      if (histories.reduce((total, history) => total + history.attempts.length, 0) > 1000) throw new Error("Configuration command history exceeds its bound");
    }
    for (const child of candidates) {
      if ((await tx.toolingOperation.updateMany({ where: { id: child.id, status: child.status, parentOperationId: parent.id },
        // The successful current callback remains replayable until the outer
        // command settles. Its acknowledgment can itself be lost in transit.
        data: child.id === current.id ? { status: "running" } : { status: "completed", completionEvidence: { kind: "verified-configuration-transition", reference: `${current.id}:${attemptId}` } } })).count !== 1)
        throw new Error("Configuration child changed during reconciliation");
    }
    await tx.runtimeMetadataEvent.update({ where: { sequence: marker.sequence }, data: { value: JSON.stringify({ version: 1, parentOperationId: parent.id,
      operationId: current.id, attemptId, transitionSequence: state.event!.sequence, replaySequence: commit.sequence, readerId: proof.data.readerId,
      environmentId: state.environment.id, offerId: request.offerId, history: histories }) } });
    return candidates.length;
  });
}

/** An earlier unknown attempt of the still-open callback can be settled only
 * through the immutable history captured by the verified configuration replay.
 * A later unknown result is not covered by that historical proof. */
export async function configurationAttemptReconciled(store: Pick<PrismaClient, "runtimeMetadataEvent">, binding: { sessionId: string; taskId: string },
  operation: { id: string; inputDigest: string }, records: Awaited<ReturnType<typeof attemptRecords>>, attemptId: string) {
  const original = records.find(record => record.value?.attemptId === attemptId && record.value.state === "intent");
  const unknown = records.find(record => record.value?.attemptId === attemptId && record.value.state === "unknown");
  if (!original || !unknown || original.value?.route !== Route || unknown.value?.route !== Route || unknown.sequence <= original.sequence) return false;
  const events = await store.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: binding.sessionId, source: `tooling-operation:${binding.taskId}`,
    action: "configuration-command-recovery", key: { startsWith: `${operation.id}:` } }, orderBy: { sequence: "desc" }, take: 101 });
  if (events.length > 100) return false;
  const Audit = z.object({ version: z.literal(1), operationId: z.literal(operation.id), attemptId: z.string(), replaySequence: z.number().int().positive(),
    history: z.array(z.object({ operationId: z.string(), inputDigest: z.string(), attempts: z.array(z.object({ sequence: z.number().int().positive(), value: z.unknown() })) }).strict()).max(100),
  });
  for (const event of events) {
    const parsed = Audit.safeParse(parse(event.value)); if (!parsed.success) return false;
    const audit = parsed.data, saved = audit.history.filter(row => row.operationId === operation.id);
    if (saved.length !== 1 || saved[0]!.inputDigest !== operation.inputDigest || saved[0]!.attempts.length > 1000 || event.key !== `${operation.id}:${audit.attemptId}`) return false;
    const frozen = saved[0]!.attempts;
    if (frozen.some(record => !records.some(current => current.sequence === record.sequence && canonicalDigest(current) === canonicalDigest(record)))) return false;
    const replay = records.find(record => record.value?.attemptId === audit.attemptId && record.value.state === "intent");
    const acknowledged = records.filter(record => record.value?.attemptId === audit.attemptId && record.value.state === "acknowledged");
    if (replay && acknowledged.length === 1 && replay.value?.route === Route && acknowledged[0]!.value?.route === Route
      && replay.sequence > unknown.sequence && audit.replaySequence > replay.sequence && acknowledged[0]!.sequence > audit.replaySequence && event.sequence > acknowledged[0]!.sequence
      && typeof acknowledged[0]!.value!.status === "number" && acknowledged[0]!.value!.status! >= 200 && acknowledged[0]!.value!.status! < 300
      && [original, unknown, replay, acknowledged[0]!].every(record => frozen.some(saved => saved.sequence === record.sequence))) return true;
  }
  return false;
}
