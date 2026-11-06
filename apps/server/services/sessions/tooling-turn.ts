import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, RuntimeInstruction } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { withToolingInstructions } from "../../../../lib/skills/compose.ts";
import { verifyPreparedToolingRelease } from "../tasks/tooling.ts";

const SOURCE = "tooling-turn";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

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
  if (!selection) return { text: receipt.text, claim: async (tx: Prisma.TransactionClient) =>
    !(await tx.toolingSelection.findUnique({ where: { repositoryId: task.repositoryId } })) };
  if (receipt.state !== "queued" || receipt.executionRequestId || task.ownerPaused || task.phase === "closed" || !task.worktreePath
    || task.machineId !== config.machine) throw new Error("Source tooling adoption requires an unstarted instruction of the open owning task");
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: receipt.sessionId } });
  if (session.role !== "primary" || session.closedAt || session.status !== "idle" || session.cwd !== task.worktreePath
    || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId) throw new Error("Source tooling adoption ownership changed");
  const release = await prisma.toolingRelease.findUniqueOrThrow({ where: { id: selection.releaseId } });
  if (release.repositoryId !== task.repositoryId) throw new Error("Selected tooling release belongs to another repository");
  await dependencies.verify(release); // Verification only: never prepare/install in an inbox tick.
  let request = receipt.text;
  if (request.startsWith("Owner-configured task instructions\n")) {
    const prefix = task.pinnedToolingRoot ? withToolingInstructions("", session.cwd, task.pinnedToolingRoot) : "";
    if (!prefix || !request.startsWith(prefix)) throw new Error("Queued source instructions have no verifiable original tooling prefix");
    request = request.slice(prefix.length);
  }
  const text = withToolingInstructions(request, session.cwd, release.checkout) +
    `\n\nTooling release for this independent turn: ${release.revision}, generation ${selection.generation}, checkout ${release.checkout}. Use this release for new operations. Continue existing operations with their recorded release and request identity; preserve the task's audit pin and all owner pauses.`;
  return { text, claim: async (tx: Prisma.TransactionClient) => {
    const current = await tx.runtimeInstruction.findUnique({ where: { id: receipt.id } });
    const owner = await tx.remoteTask.findUnique({ where: { id: task.id } });
    const liveSession = await tx.runtimeSession.findUnique({ where: { id: session.id } });
    const selected = await tx.toolingSelection.findUnique({ where: { repositoryId: task.repositoryId } });
    if (!current || current.state !== "queued" || current.executionRequestId || current.text !== receipt.text
      || current.sourceMessageId !== receipt.sourceMessageId || current.sessionId !== session.id
      || !owner || owner.ownerPaused || owner.phase === "closed" || owner.primarySessionId !== session.id
      || owner.worktreePath !== task.worktreePath || owner.toolingRevision !== task.toolingRevision
      || owner.repositoryId !== task.repositoryId || owner.machineId !== task.machineId
      || !liveSession || liveSession.closedAt || liveSession.status !== "idle" || liveSession.role !== "primary"
      || liveSession.cwd !== session.cwd || liveSession.repositoryId !== task.repositoryId || liveSession.machineId !== task.machineId
      || selected?.releaseId !== release.id || selected.generation !== selection.generation) return false;
    const previous = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, source: SOURCE, action: "instruction", key: input.requestId } });
    const value = JSON.stringify({ version: 1, instructionId: receipt.id, sourceMessageId: receipt.sourceMessageId, taskId: task.id,
      releaseId: release.id, revision: release.revision, generation: selection.generation, originalDigest: digest(receipt.text), text });
    if (previous) return previous.value === value;
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: SOURCE, action: "instruction", key: input.requestId, value } });
    return true;
  } };
}
