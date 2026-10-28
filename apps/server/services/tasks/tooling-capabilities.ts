import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { resolveToolingCompatibility } from "./tooling-compatibility.ts";

// Merge is deliberately not exposed: its workflow has a separate owner
// approval boundary. A caller may select a name, never a path or revision.
export const ToolingCapabilityInput = z.object({ capability: z.enum(["development-credentials", "cleanup"]) }).strict();
type Context = { prisma: PrismaClient; config: ServerConfig; sessionId: string };

export async function resolveSessionToolingCapability(input: Context & z.infer<typeof ToolingCapabilityInput>, resolve = resolveToolingCompatibility) {
  const { capability } = ToolingCapabilityInput.parse({ capability: input.capability });
  const assertOwnership = async (prisma: Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink">) => {
    const task = await prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
    const session = await prisma.runtimeSession.findUnique({ where: { id: input.sessionId } });
    if (!task || !session || session.role !== "primary" || session.status === "closed" || !task.worktreePath
      || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId
      || task.machineId !== input.config.machine) throw new Error("Only the open owning task primary may resolve tooling capabilities");
    if (task.controlMode !== "agent" || task.phase === "closed") throw new Error("Task capability resolution is paused or closed; explicit resume is required");
    const repository = input.config.repositories[task.repositoryId];
    if (!repository || !repository.tooling) throw new Error("Task repository has no configured tooling capability source");
    if (task.issueIdentifier) {
      if (!task.connectionId || !input.config.connections[task.connectionId]) throw new Error("Task connection is no longer configured");
      const link = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear",
        connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
      if (!link) throw new Error("Task source ownership was revoked");
    }
    return { task, session, repository };
  };
  // Check before any host checkout or dependency installation, then again
  // before recording/returning the capability. Resolution never runs it.
  const owned = await assertOwnership(input.prisma);
  const result = await resolve({ task: owned.task, repository: owned.repository, installRoot: input.config.installRoot,
    capability, worktreePath: owned.session.cwd, pinnedToolingRoot: owned.task.pinnedToolingRoot ?? undefined,
    seed: capability === "cleanup"
      ? "Recover this task's incomplete or unsupported cleanup receipts without changing its tooling pin. Inspect exact ownership, use supported lifecycle operations within existing authority, verify absence, then resume the original primary's finalizer. Never fabricate released state or broaden deletion targets."
      : "Recover only the development configuration required by this existing task; inspect names and integrity, then verify the original live operation. Distinguish missing configuration, authorization denial, invalid credentials and provider outage. Never use production fallback." });
  const key = `${owned.task.id}:${createHash("sha256").update(JSON.stringify(result.receipt)).digest("hex")}`;
  await input.prisma.$transaction(async (tx) => {
    const current = await assertOwnership(tx);
    if (current.task.id !== owned.task.id || current.task.controlGeneration !== owned.task.controlGeneration
      || current.task.worktreePath !== owned.task.worktreePath || current.task.toolingRevision !== owned.task.toolingRevision
      || current.task.pinnedToolingRoot !== owned.task.pinnedToolingRoot) throw new Error("Task ownership or control changed during capability resolution");
    if (!(await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owned.session.id, action: "tooling-capability", key } }))) {
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owned.session.id, action: "tooling-capability", key,
        source: `task:${owned.task.id}`, value: JSON.stringify(result.receipt) } });
    }
  });
  return { receipt: result.receipt, instructions: result.prompt };
}
