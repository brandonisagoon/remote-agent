import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient, RuntimeIssueUpdate } from "../../../../generated/prisma/client.ts";

const Id = z.string().trim().min(1).max(512);
const FailureSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instruction"), id: Id }).strict(),
  z.object({ kind: z.literal("operation"), id: Id }).strict(),
  z.object({ kind: z.literal("question"), id: Id }).strict(),
  z.object({ kind: z.literal("result"), id: Id }).strict(),
  z.object({ kind: z.literal("projection"), id: Id, sessionId: Id, stage: z.enum(["notify", "project"]) }).strict(),
  z.object({ kind: z.literal("execution"), id: Id }).strict(),
]);
const VersionedSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instruction"), id: Id }).strict(),
  z.object({ kind: z.literal("operation"), id: Id }).strict(),
  z.object({ kind: z.literal("task-event"), id: z.string().regex(/^[1-9][0-9]{0,15}$/) }).strict(),
  z.object({ kind: z.literal("evidence"), id: Id }).strict(),
]);
const Code = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
export const TaskPublication = z.discriminatedUnion("category", [
  z.object({ category: z.enum(["blocker", "recovery"]), subject: FailureSubject, code: Code, occurrence: z.number().int().positive().optional() }).strict(),
  z.object({ category: z.enum(["milestone", "review-handoff"]), subject: VersionedSubject, version: Id }).strict(),
]);
export type TaskPublication = z.infer<typeof TaskPublication>;
export type PublicationOwner = { sessionId: string; taskId: string | null; repositoryId: string; machineId: string; connectionId: string; issueId: string };
type Subject = TaskPublication["subject"];
type Fact = { status: "blocked" | "pending" | "resolved"; code?: string; version?: string; witness: Record<string, unknown> };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child)).digest("hex");
const json = (value: string | null) => { try { return JSON.parse(value ?? "null"); } catch { throw new Error("Publication subject has unreadable durable evidence"); } };
const Episode = z.object({ subject: FailureSubject, connectionId: Id, issueId: Id, version: z.literal(1), occurrence: z.number().int().positive(), code: Code, state: z.enum(["blocked", "resolved"]), entry: z.record(z.string(), z.unknown()) }).strict();

/** Ownership follows recorded family edges, never a shared cwd or an issue
 * identifier supplied by the model. Moved and closed delegates retain their
 * ancestry; another task's primary cannot become this task's subject. */
async function assertFamily(tx: Prisma.TransactionClient, owner: PublicationOwner, sessionId: string) {
  const seen = new Set<string>(); let id = sessionId;
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(id)) throw new Error("Publication subject family is cyclic"); seen.add(id);
    const session = await tx.runtimeSession.findUnique({ where: { id } });
    if (!session || session.repositoryId !== owner.repositoryId || session.machineId !== owner.machineId) throw new Error("Publication subject belongs to another repository or host");
    if (id === owner.sessionId) return;
    if (session.role !== "delegate" || await tx.remoteTask.count({ where: { primarySessionId: id } })) throw new Error("Publication subject belongs to another primary");
    const edges = await tx.runtimeSessionRelation.findMany({ where: { sourceSessionId: id, relationship: "spawned-by", endedAt: null }, take: 2 });
    if (edges.length !== 1) throw new Error("Publication subject has no single recorded parent");
    id = edges[0]!.targetSessionId;
  }
  throw new Error("Publication family exceeds its bound");
}

export async function readPublicationFact(tx: Prisma.TransactionClient, owner: PublicationOwner, subject: Subject): Promise<Fact> {
  const primary = await tx.runtimeSession.findUnique({ where: { id: owner.sessionId } });
  if (!primary || primary.status === "closed" || primary.role === "delegate" || primary.repositoryId !== owner.repositoryId || primary.machineId !== owner.machineId)
    throw new Error("Task publication requires its original open primary");
  const task = owner.taskId ? await tx.remoteTask.findUnique({ where: { id: owner.taskId } }) : null;
  if (owner.taskId && (!task || task.primarySessionId !== primary.id || task.repositoryId !== primary.repositoryId || task.machineId !== primary.machineId || task.worktreePath !== primary.cwd || task.phase === "closed"))
    throw new Error("Task publication ownership changed");
  if (subject.kind === "instruction") {
    const row = await tx.runtimeInstruction.findUnique({ where: { id: subject.id } });
    if (!row) throw new Error("Publication instruction is missing"); await assertFamily(tx, owner, row.sessionId);
    const blocked = ["unknown", "failed"].includes(row.state), resolved = ["completed", "cancelled"].includes(row.state);
    return { status: blocked ? "blocked" : resolved ? "resolved" : "pending", ...(blocked ? { code: `instruction-${row.state}` } : {}),
      ...(row.state === "completed" ? { version: "completed" } : {}), witness: { kind: subject.kind, id: row.id, state: row.state } };
  }
  if (subject.kind === "operation") {
    const row = await tx.toolingOperation.findUnique({ where: { id: subject.id } });
    if (!row || !task || row.taskId !== task.id || row.sessionId !== primary.id || row.repositoryId !== task.repositoryId) throw new Error("Publication operation belongs to another task");
    const witness = { kind: subject.kind, id: row.id, state: row.status };
    if (row.status === "completed") return { status: "resolved", version: "completed", witness };
    const event = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: primary.id, source: `tooling-operation:${task.id}`, action: "tooling-operation-association", key: `outcome:${row.id}` }, orderBy: { sequence: "desc" } });
    const value = event ? z.object({ operationId: z.literal(row.id), inputDigest: z.literal(row.inputDigest), state: z.enum(["intent", "unknown", "refused", "acknowledged", "reconciled"]), attemptId: Id }).passthrough().parse(json(event.value)) : null;
    if (value && ["unknown", "refused"].includes(value.state)) {
      const diagnostic = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: primary.id, source: `compute:${task.id}`, action: "compute-configuration-failure", key: value.attemptId }, orderBy: { sequence: "desc" } });
      const detail = diagnostic ? z.object({ operationId: z.literal(row.id), attemptId: z.literal(value.attemptId), code: Code }).passthrough().parse(json(diagnostic.value)) : null;
      return { status: "blocked", code: detail?.code ?? `operation-${value.state}`, witness: { ...witness, event: event!.sequence, attemptId: value.attemptId } };
    }
    return { status: row.status === "unknown" ? "blocked" : "pending", ...(row.status === "unknown" ? { code: "operation-unknown" } : {}), witness };
  }
  if (subject.kind === "question") {
    const row = await tx.runtimeQuestion.findUnique({ where: { id: subject.id } });
    if (!row) throw new Error("Publication question is missing"); await assertFamily(tx, owner, row.runtimeSessionId);
    if (row.connectionId !== owner.connectionId || row.issueId !== owner.issueId) throw new Error("Publication question belongs to another source issue");
    return { status: row.state === "unknown" ? "blocked" : ["posted", "answered"].includes(row.state) ? "resolved" : "pending",
      ...(row.state === "unknown" ? { code: "question-delivery-unknown" } : {}), witness: { kind: subject.kind, id: row.id, state: row.state } };
  }
  if (subject.kind === "result") {
    const event = await tx.runtimeLifecycleEvent.findUnique({ where: { id: subject.id } });
    if (!event || !["completed", "failed", "cancelled"].includes(event.phase) || event.runtimeSessionId === primary.id) throw new Error("Publication result is not a terminal delegate event");
    await assertFamily(tx, owner, event.runtimeSessionId);
    if (!await tx.runtimeSessionRelation.count({ where: { sourceSessionId: event.runtimeSessionId, targetSessionId: primary.id, relationship: "notifies-parent", endedAt: null } })) throw new Error("Delegate result has no primary notification relation");
    const receipt = await tx.runtimeInstruction.findUnique({ where: { id: `delegate-result:${primary.id}:${event.id}` } });
    if (receipt && receipt.sessionId !== primary.id) throw new Error("Delegate result belongs to another inbox");
    const blocked = !receipt || ["failed", "unknown"].includes(receipt.state);
    return { status: blocked ? "blocked" : receipt?.state === "completed" ? "resolved" : "pending",
      ...(blocked ? { code: receipt ? "delegate-result-delivery-failed" : "delegate-result-missing" } : {}), witness: { kind: subject.kind, id: event.id, instructionId: receipt?.id ?? null, state: receipt?.state ?? "missing" } };
  }
  if (subject.kind === "projection") {
    await assertFamily(tx, owner, subject.sessionId);
    const event = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: subject.sessionId, source: `runtime-event-projection:v1:${subject.stage}`, action: "projection-delivery-retry", key: subject.id }, orderBy: { sequence: "desc" } });
    if (!event) throw new Error("Publication projection has no retry receipt");
    const value = z.object({ state: z.enum(["backoff", "exhausted", "ready", "recovered"]) }).passthrough().parse(json(event.value));
    return { status: value.state === "exhausted" ? "blocked" : value.state === "recovered" ? "resolved" : "pending",
      ...(value.state === "exhausted" ? { code: `projection-${subject.stage}-exhausted` } : {}), witness: { kind: subject.kind, id: subject.id, state: value.state, event: event.sequence } };
  }
  if (subject.kind === "execution") {
    if (subject.id !== primary.id) throw new Error("Execution publication belongs to another primary");
    const event = await tx.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: primary.id }, orderBy: { sequence: "desc" } });
    if (!event) throw new Error("Execution publication has no durable lifecycle fact");
    const resolved = await tx.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: primary.id, phase: { in: ["completed", "cancelled"] }, sequence: { lt: event.sequence } }, orderBy: { sequence: "desc" } });
    return { status: event.phase === "failed" ? "blocked" : ["completed", "cancelled"].includes(event.phase) ? "resolved" : "pending",
      ...(event.phase === "failed" ? { code: "task-execution-failed" } : {}), witness: { kind: subject.kind, id: primary.id, eventId: event.id, sequence: event.sequence, lastResolvedSequence: resolved?.sequence ?? 0, phase: event.phase } };
  }
  if (subject.kind === "task-event") {
    const event = await tx.runtimeMetadataEvent.findUnique({ where: { sequence: Number(subject.id) } });
    if (!task || !event || event.runtimeSessionId !== primary.id || event.source !== `owner:${task.id}` || !["completion-contract", "completion-verification", "completion-owner-approval"].includes(event.action)) throw new Error("Publication task event is not this task's accepted completion fact");
    if (event.action === "completion-verification" && z.object({ verification: z.object({ passed: z.boolean() }) }).passthrough().parse(json(event.value)).verification.passed !== true) throw new Error("Failed verification cannot be a milestone or handoff");
    return { status: "resolved", version: String(event.sequence), witness: { kind: subject.kind, id: event.sequence, action: event.action } };
  }
  const resource = await tx.remoteTaskResource.findUnique({ where: { id: subject.id } });
  const evidence = resource ? z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().safeParse(resource.metadata) : null;
  if (!task || !resource || resource.taskId !== task.id || resource.kind !== "evidence" || resource.state === "released" || !evidence?.success) throw new Error("Publication evidence is not this task's registered capture");
  return { status: "resolved", version: evidence.data.sha256, witness: { kind: subject.kind, id: resource.id, sha256: evidence.data.sha256 } };
}

/** Caller holds one SQL transaction through receipt reservation. This reuses
 * the existing projection cursor; no prose hash, turn ID, retry counter or
 * mutable timestamp determines an occurrence. Pending retries keep their
 * original episode until a durable resolution is observed. */
export async function resolveTaskPublication(tx: Prisma.TransactionClient, owner: PublicationOwner, raw: TaskPublication) {
  const publication = TaskPublication.parse(raw);
  const scope = { taskId: owner.taskId, sessionId: owner.sessionId, connectionId: owner.connectionId, issueId: owner.issueId };
  const consumer = `task-publication:v1:${digest({ ...scope, subject: publication.subject })}`;
  // A real write takes SQLite's writer lock before the fact/episode read.
  const cursor = await tx.runtimeEventCursor.upsert({ where: { runtimeSessionId_consumer: { runtimeSessionId: owner.sessionId, consumer } },
    create: { runtimeSessionId: owner.sessionId, consumer }, update: { generation: { increment: 0 } } });
  const fact = await readPublicationFact(tx, owner, publication.subject);
  if ("version" in publication) {
    if (!fact.version || fact.version !== publication.version) throw new Error("Publication version does not match its durable subject");
    return { requestKey: `task-publication:v1:${digest({ ...scope, ...publication })}`, publication, witness: fact.witness };
  }
  if (publication.category === "recovery" && publication.occurrence !== undefined) {
    const transitions = await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: "task-publication-episode", key: cursor.id }, orderBy: { sequence: "desc" }, take: 1000 });
    const resolution = transitions.map((event) => Episode.passthrough().parse(json(event.value))).find((entry) => entry.state === "resolved" && entry.occurrence === publication.occurrence && entry.code === publication.code);
    if (resolution) return { requestKey: `task-publication:v1:${digest({ ...scope, ...publication })}`, publication, witness: { entry: resolution.entry, resolution: resolution.observed } };
  }
  const episode = await observeEpisode(tx, owner, publication.subject, cursor, fact);
  if (!episode || episode.code !== publication.code || publication.occurrence !== undefined && publication.occurrence !== episode.occurrence
    || publication.category === "blocker" && episode.state !== "blocked" || publication.category === "recovery" && (episode.state !== "resolved" || fact.status !== "resolved"))
    throw new Error("Publication does not match the current durable blocker occurrence or resolution");
  const identified = { ...publication, occurrence: episode.occurrence };
  return { requestKey: `task-publication:v1:${digest({ ...scope, ...identified })}`, publication: identified, witness: { entry: episode.entry, current: fact.witness } };
}

async function observeEpisode(tx: Prisma.TransactionClient, owner: PublicationOwner, subject: z.infer<typeof FailureSubject>, cursor: { id: string; sourceCursor: string | null; generation: bigint }, fact: Fact) {
  let episode = cursor.sourceCursor ? Episode.parse(json(cursor.sourceCursor)) : null;
  let changed = false;
  // Lifecycle projection may catch up after several turns. A recorded resolved
  // turn between two failures is still an observed boundary, even after restart.
  if (episode?.state === "blocked" && fact.status === "blocked" && subject.kind === "execution" && Number(fact.witness.lastResolvedSequence) > Number(episode.entry.sequence)) {
    episode = { ...episode, state: "resolved" };
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: "task-publication-episode", key: cursor.id, value: JSON.stringify({ ...episode, observed: { sequence: fact.witness.lastResolvedSequence } }) } });
  }
  if (fact.status === "blocked" && (!episode || episode.state === "resolved" || episode.code !== fact.code)) {
    const occurrence = Number(cursor.generation) + 1;
    if (!Number.isSafeInteger(occurrence)) throw new Error("Publication occurrence exceeds its bound");
    episode = Episode.parse({ subject, connectionId: owner.connectionId, issueId: owner.issueId, version: 1, occurrence, code: fact.code, state: "blocked", entry: fact.witness });
    changed = true;
  } else if (fact.status === "resolved" && episode?.state === "blocked") {
    episode = { ...episode, state: "resolved" }; changed = true;
  }
  if (changed && episode) {
    await tx.runtimeEventCursor.update({ where: { id: cursor.id }, data: { sourceCursor: JSON.stringify(episode), generation: BigInt(episode.occurrence) } });
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: "task-publication-episode", key: cursor.id,
      value: JSON.stringify({ ...episode, observed: fact.witness }) } });
  }
  return episode;
}

/** Periodic delivery already scans task truth. Observe only subjects previously
 * reported here so resolution is durable even when its publication is offline.
 * Recoveries use the same receipt as an explicit primary report. */
export async function observePublicationRecoveries(prisma: PrismaClient, owner: PublicationOwner): Promise<TaskPublication[]> {
  return prisma.$transaction(async (tx) => {
    const cursors = await tx.runtimeEventCursor.findMany({ where: { runtimeSessionId: owner.sessionId, consumer: { startsWith: "task-publication:v1:" } }, orderBy: { id: "asc" }, take: 1000 });
    const result: TaskPublication[] = [];
    for (const stale of cursors) {
      if (!stale.sourceCursor) continue;
      const saved = Episode.parse(json(stale.sourceCursor));
      if (saved.connectionId !== owner.connectionId || saved.issueId !== owner.issueId) continue;
      const cursor = await tx.runtimeEventCursor.update({ where: { id: stale.id }, data: { generation: { increment: 0 } } });
      let fact: Fact;
      try { fact = await readPublicationFact(tx, owner, saved.subject); }
      catch { console.error(`[task-publication] Retaining unresolved subject for cursor ${cursor.id}; its current ownership or evidence is unavailable`); continue; }
      await observeEpisode(tx, owner, saved.subject, cursor, fact);
      const transitions = await tx.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: "task-publication-episode", key: cursor.id }, orderBy: { sequence: "desc" }, take: 1000 });
      for (const event of transitions) {
        const resolution = Episode.passthrough().parse(json(event.value));
        if (resolution.state === "resolved") result.push({ category: "recovery", subject: saved.subject, code: resolution.code, occurrence: resolution.occurrence });
      }
    }
    return result;
  });
}

type PublicationInput = { requestKey: string; body: string; state?: string; expectedState?: string; evidence: Array<{ path: string; title: string }>; publication?: TaskPublication };
const ALIAS = "issue-update-publication-alias";
const aliasKey = (requestKey: string) => digest(requestKey);
const Alias = z.object({ payloadDigest: Id, receiptId: Id, connectionId: Id, issueId: Id }).strict();
const mismatch = () => new Error("Update requestKey already belongs to a different update; use the original payload to retry");

export async function publicationAlias(prisma: PrismaClient | Prisma.TransactionClient, owner: PublicationOwner, input: PublicationInput): Promise<RuntimeIssueUpdate | null> {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: ALIAS, key: aliasKey(input.requestKey) }, orderBy: { sequence: "desc" } });
  if (!event) return null;
  const alias = Alias.parse(json(event.value));
  if (alias.payloadDigest !== digest(input) || alias.connectionId !== owner.connectionId || alias.issueId !== owner.issueId) throw mismatch();
  const receipt = await prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: alias.receiptId } });
  if (receipt.runtimeSessionId !== owner.sessionId || receipt.connectionId !== owner.connectionId || receipt.issueId !== owner.issueId) throw mismatch();
  return receipt;
}

async function reserveInTransaction(tx: Prisma.TransactionClient, owner: PublicationOwner, input: PublicationInput, evidence: Prisma.InputJsonValue | undefined, adopted?: RuntimeIssueUpdate) {
  if (!input.publication) throw new Error("Task publication metadata is required");
    // Resolve takes the writer lock before reading truth or reserving aliases.
    const resolved = await resolveTaskPublication(tx, owner, input.publication!);
    const replay = await publicationAlias(tx, owner, input);
    if (replay) return replay;
    let receipt = await canonicalPublicationReceipt(tx, owner, resolved.requestKey);
    if (!receipt && adopted) {
      const legacy = await tx.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: adopted.id } });
      if (legacy.runtimeSessionId !== owner.sessionId || legacy.connectionId !== owner.connectionId || legacy.issueId !== owner.issueId || !legacy.published || !legacy.commentPosted) throw new Error("Legacy publication is not a confirmed receipt for this source");
      receipt = legacy;
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: "task-publication-adopted", key: resolved.requestKey, value: JSON.stringify({ receiptId: legacy.id, publication: resolved.publication, witness: resolved.witness }) } });
    }
    if (!receipt && evidence === undefined) return null;
    const canonical = { ...input, requestKey: resolved.requestKey, publication: resolved.publication };
    if (receipt) {
      const saved = receipt.input as PublicationInput;
      if (receipt.connectionId !== owner.connectionId || receipt.issueId !== owner.issueId || saved.state !== input.state || saved.expectedState !== input.expectedState || JSON.stringify(saved.evidence) !== JSON.stringify(input.evidence))
        throw new Error("Task publication already has an incompatible state or evidence claim");
    } else {
      receipt = await tx.runtimeIssueUpdate.create({ data: { runtimeSessionId: owner.sessionId, requestKey: resolved.requestKey, connectionId: owner.connectionId, issueId: owner.issueId, input: canonical, evidence: evidence! } });
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: "task-publication-reserved", key: receipt.id, value: JSON.stringify({ ...resolved, cacheKey: input.requestKey }) } });
    }
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: ALIAS, key: aliasKey(input.requestKey),
      value: JSON.stringify({ payloadDigest: digest(input), receiptId: receipt.id, connectionId: owner.connectionId, issueId: owner.issueId }) } });
    return receipt;
}

export async function reserveTaskPublication(prisma: PrismaClient, owner: PublicationOwner, input: PublicationInput, evidence: Prisma.InputJsonValue, adopted?: RuntimeIssueUpdate) {
  return prisma.$transaction(async tx => {
    const receipt = await reserveInTransaction(tx, owner, input, evidence, adopted);
    if (!receipt) throw new Error("Publication reservation did not retain its evidence");
    return receipt;
  });
}

export async function reuseTaskPublication(prisma: PrismaClient, owner: PublicationOwner, input: PublicationInput) {
  return prisma.$transaction(tx => reserveInTransaction(tx, owner, input, undefined));
}

export async function canonicalPublicationReceipt(prisma: PrismaClient | Prisma.TransactionClient, owner: PublicationOwner, requestKey: string) {
  let receipt = await prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: owner.sessionId, requestKey } } });
  if (!receipt) {
    const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owner.sessionId, source: "task-publication:v1", action: "task-publication-adopted", key: requestKey }, orderBy: { sequence: "desc" } });
    if (event) receipt = await prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: z.object({ receiptId: Id }).parse(json(event.value)).receiptId } });
  }
  if (receipt && (receipt.connectionId !== owner.connectionId || receipt.issueId !== owner.issueId || receipt.runtimeSessionId !== owner.sessionId)) throw new Error("Publication receipt belongs to another source");
  return receipt;
}

/** Bounded read-only facts for inspect_task. Agents need the actual code and
 * version to reference a transition; they must not invent publication tokens. */
export async function taskPublicationContext(prisma: PrismaClient, task: { id: string; primarySessionId: string | null; repositoryId: string; machineId: string }) {
  if (!task.primarySessionId) return { publicationSubjects: [], publicationEpisodes: [] };
  const sessionId = task.primarySessionId;
  const [instructions, operations, events, evidence, cursors] = await Promise.all([
    prisma.runtimeInstruction.findMany({ where: { sessionId, state: { in: ["unknown", "failed", "completed"] } }, orderBy: { updatedAt: "desc" }, take: 50 }),
    prisma.toolingOperation.findMany({ where: { taskId: task.id, sessionId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: sessionId, source: `owner:${task.id}`, action: { in: ["completion-contract", "completion-verification", "completion-owner-approval"] } }, orderBy: { sequence: "desc" }, take: 50 }),
    prisma.remoteTaskResource.findMany({ where: { taskId: task.id, kind: "evidence", state: { not: "released" } }, take: 50 }),
    prisma.runtimeEventCursor.findMany({ where: { runtimeSessionId: sessionId, consumer: { startsWith: "task-publication:v1:" }, sourceCursor: { not: null } }, orderBy: { id: "desc" }, take: 100 }),
  ]);
  const owner = { sessionId, taskId: task.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: "", issueId: "" };
  const subjects: Subject[] = [
    ...instructions.map(row => ({ kind: "instruction" as const, id: row.id })),
    ...operations.map(row => ({ kind: "operation" as const, id: row.id })),
    ...events.map(row => ({ kind: "task-event" as const, id: String(row.sequence) })),
    ...evidence.map(row => ({ kind: "evidence" as const, id: row.id })),
    { kind: "execution", id: sessionId },
  ];
  const publicationSubjects = [];
  for (const subject of subjects) {
    try {
      const fact = await readPublicationFact(prisma, owner, subject);
      if (fact.status !== "pending") publicationSubjects.push({ subject, status: fact.status, ...(fact.code ? { code: fact.code } : {}), ...(fact.version ? { version: fact.version } : {}) });
    } catch { /* Closed/changed/missing facts are not publishable claims. */ }
  }
  return { publicationSubjects, publicationEpisodes: cursors.flatMap(row => {
    const parsed = Episode.safeParse(json(row.sourceCursor));
    return parsed.success ? [{ subject: parsed.data.subject, code: parsed.data.code, occurrence: parsed.data.occurrence, state: parsed.data.state, connectionId: parsed.data.connectionId, issueId: parsed.data.issueId }] : [];
  }) };
}


export async function publicationEvidenceCacheKey(prisma: PrismaClient, sessionId: string, receiptId: string) {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source: "task-publication:v1", action: "task-publication-reserved", key: receiptId }, orderBy: { sequence: "asc" } });
  return event ? z.object({ cacheKey: Id }).passthrough().parse(json(event.value)).cacheKey : null;
}
