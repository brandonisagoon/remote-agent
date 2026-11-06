import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient, RuntimeInstruction } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { withToolingInstructions } from "../../../../lib/skills/compose.ts";
import { verifyPreparedToolingRelease } from "../tasks/tooling.ts";

const SOURCE = "tooling-turn";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const RecordedTurn = z.strictObject({ version: z.literal(1), instructionId: z.string(), sourceMessageId: z.string(), taskId: z.string(),
  releaseId: z.string(), revision: z.string(), generation: z.number().int().positive(), originalDigest: z.string(), text: z.string() });

async function authorizedAttempt(store: Pick<Prisma.TransactionClient, "runtimeMetadataEvent">, receipt: RuntimeInstruction, taskId: string, requestId: string) {
  if (!receipt.executionRequestId && requestId === receipt.id) return true;
  if (requestId === receipt.executionRequestId) return false;
  const decision = await store.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: receipt.sessionId,
    source: `task-supervisor:${taskId}`, action: "instruction-resolved", key: receipt.id }, orderBy: { sequence: "desc" } });
  if (!decision || requestId !== `${receipt.id}:retry:${decision.sequence}`) return false;
  try { return JSON.parse(decision.value ?? "null")?.action === "retry"; } catch { return false; }
}

/** Persist only a changed diagnosis, retaining the queued message for recovery.
 * Matching the attempted identity prevents a late failure from rewriting a
 * newer owner decision. Returning false also suppresses repeated log noise. */
export async function recordSourceToolingFailure(prisma: PrismaClient, receipt: RuntimeInstruction, error: unknown) {
  const detail = `Tooling adoption needs attention: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
  const changed = await prisma.runtimeInstruction.updateMany({ where: { id: receipt.id, sessionId: receipt.sessionId,
    state: "queued", executionRequestId: receipt.executionRequestId, updatedAt: receipt.updatedAt,
    OR: [{ detail: null }, { detail: { not: detail } }] }, data: { detail } });
  return changed.count > 0;
}

/** Source-origin messages are independent turn boundaries. The original inbox
 * payload stays unchanged as ingress evidence. The exact effective instruction
 * and release are journaled in the same transaction that claims delivery.
 * Synthetic compute/cleanup continuations retain their own producing binding. */
export async function prepareSourceToolingTurn(input: {
  prisma: PrismaClient; config: ServerConfig; receipt: RuntimeInstruction; requestId: string;
}, dependencies = { verify: verifyPreparedToolingRelease }) {
  const { prisma, receipt, config } = input;
  const unchanged = { text: receipt.text, claim: async (_tx: Prisma.TransactionClient) => true };
  if (!receipt.sourceMessageId) return unchanged;
  const task = await prisma.remoteTask.findUnique({ where: { primarySessionId: receipt.sessionId } });
  if (!task) return unchanged;
  const selection = await prisma.toolingSelection.findUnique({ where: { repositoryId: task.repositoryId } });
  const priorEvent = receipt.executionRequestId ? await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: receipt.sessionId,
    source: SOURCE, action: "instruction", key: receipt.executionRequestId } }) : null;
  const prior = priorEvent ? RecordedTurn.parse(JSON.parse(priorEvent.value ?? "null")) : null;
  if (prior && (prior.instructionId !== receipt.id || prior.sourceMessageId !== receipt.sourceMessageId || prior.taskId !== task.id
    || prior.originalDigest !== digest(receipt.text))) throw new Error("Recorded tooling turn does not match this source instruction");
  if (!selection && !prior) return { text: receipt.text, claim: async (tx: Prisma.TransactionClient) =>
    !(await tx.toolingSelection.findUnique({ where: { repositoryId: task.repositoryId } })) };
  if (receipt.state !== "queued" || !(await authorizedAttempt(prisma, receipt, task.id, input.requestId)) || task.ownerPaused || task.phase === "closed" || !task.worktreePath
    || task.machineId !== config.machine) throw new Error("Source tooling adoption requires an unstarted instruction of the open owning task");
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: receipt.sessionId } });
  if (session.role !== "primary" || session.closedAt || session.status !== "idle" || session.cwd !== task.worktreePath
    || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) throw new Error("Source tooling adoption ownership changed");
  const release = await prisma.toolingRelease.findUniqueOrThrow({ where: { id: prior?.releaseId ?? selection!.releaseId } });
  if (prior && prior.revision !== release.revision) throw new Error("Recorded tooling release provenance changed");
  const generation = prior?.generation ?? selection!.generation;
  if (release.repositoryId !== task.repositoryId) throw new Error("Selected tooling release belongs to another repository");
  await dependencies.verify(release); // Verification only: never prepare/install in an inbox tick.
  let request = receipt.text;
  if (!prior && request.startsWith("Owner-configured task instructions\n")) {
    const prefix = task.pinnedToolingRoot ? withToolingInstructions("", session.cwd, task.pinnedToolingRoot) : "";
    if (!prefix || !request.startsWith(prefix)) throw new Error("Queued source instructions have no verifiable original tooling prefix");
    request = request.slice(prefix.length);
  }
  const text = prior?.text ?? withToolingInstructions(request, session.cwd, release.checkout) +
    `\n\nTooling release for this independent turn: ${release.revision}, generation ${generation}, checkout ${release.checkout}. Use this release for new operations. Continue existing operations with their recorded release and request identity; preserve the task's audit pin and all owner pauses.`;
  return { text, claim: async (tx: Prisma.TransactionClient) => {
    const current = await tx.runtimeInstruction.findUnique({ where: { id: receipt.id } });
    const owner = await tx.remoteTask.findUnique({ where: { id: task.id } });
    const liveSession = await tx.runtimeSession.findUnique({ where: { id: session.id } });
    const selected = await tx.toolingSelection.findUnique({ where: { repositoryId: task.repositoryId } });
    if (!current || current.state !== "queued" || current.executionRequestId !== receipt.executionRequestId || current.text !== receipt.text
      || current.sourceMessageId !== receipt.sourceMessageId || current.sessionId !== session.id
      || !owner || owner.ownerPaused || owner.phase === "closed" || owner.primarySessionId !== session.id
      || owner.worktreePath !== task.worktreePath || owner.toolingRevision !== task.toolingRevision
      || owner.repositoryId !== task.repositoryId || owner.machineId !== task.machineId
      || !liveSession || liveSession.closedAt || liveSession.status !== "idle" || liveSession.role !== "primary"
      || liveSession.cwd !== session.cwd || liveSession.repositoryId !== task.repositoryId || liveSession.machineId !== task.machineId
      || (!prior && (selected?.releaseId !== release.id || selected.generation !== generation))) return false;
    if (!(await authorizedAttempt(tx, current, task.id, input.requestId))) return false;
    if (priorEvent && (await tx.runtimeMetadataEvent.findUnique({ where: { sequence: priorEvent.sequence } }))?.value !== priorEvent.value) return false;
    const previous = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, source: SOURCE, action: "instruction", key: input.requestId } });
    const value = JSON.stringify({ version: 1, instructionId: receipt.id, sourceMessageId: receipt.sourceMessageId, taskId: task.id,
      releaseId: release.id, revision: release.revision, generation, originalDigest: digest(receipt.text), text });
    if (previous) return previous.value === value;
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: SOURCE, action: "instruction", key: input.requestId, value } });
    return true;
  } };
}
