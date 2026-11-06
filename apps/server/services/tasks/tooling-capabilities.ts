import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { ToolingReleaseRecord, ToolingReleaseSelection } from "../../../../types/tooling-release.ts";
import { resolveToolingCompatibility } from "./tooling-compatibility.ts";
import { DevelopmentReference, assertDevelopmentRequest } from "./development-intent.ts";
import { assertOpenTaskPrimary, currentToolingOperation, inLegacyContinuation } from "./tooling-operations.ts";
import { getActiveToolingRelease } from "./tooling-releases.ts";

export { assertOpenTaskPrimary };

// Merge is deliberately not exposed: its workflow has a separate owner
// approval boundary. A caller may select a name, never a path or revision.
export const ToolingCapabilityInput = z.union([
  z.object({ capability: z.enum(["development-credentials", "cleanup", "runtime", "browser"]) }).strict(),
  z.object({ capability: z.literal("runtime"), development: DevelopmentReference }).strict(),
]);
type Context = { prisma: PrismaClient; config: ServerConfig; sessionId: string };
/** Release for this capability: an explicit binding/selection from the outer
 * boundary, else the guarded callback's request-scoped binding, else (a new
 * independent resolution) the current active generation. Null keeps the
 * pre-protocol configured-host behavior. */
export async function selectCapabilityRelease(input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string; release?: ToolingReleaseRecord | null },
  active: (input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string }) => Promise<ToolingReleaseSelection | null> = getActiveToolingRelease): Promise<ToolingReleaseRecord | null> {
  if (input.release !== undefined) return input.release;
  if (inLegacyContinuation()) return null;
  const bound = currentToolingOperation();
  if (bound) {
    if (bound.repositoryId !== input.repositoryId) throw new Error("Bound tooling operation belongs to another repository");
    return bound.release;
  }
  return (await active(input))?.release ?? null;
}

export async function resolveSessionToolingCapability(input: Context & z.infer<typeof ToolingCapabilityInput> & { release?: ToolingReleaseRecord | null; install?: boolean },
  resolve = resolveToolingCompatibility, active: Parameters<typeof selectCapabilityRelease>[1] = getActiveToolingRelease) {
  const parsed = ToolingCapabilityInput.parse({ capability: input.capability, ...("development" in input ? { development: input.development } : {}) });
  const { capability } = parsed;
  const assertOwnership = async (prisma: Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "remoteTaskResource" | "runtimeInstruction" | "runtimeLifecycleEvent" | "runtimeMetadataEvent" | "computeEnvironment" | "computeTraffic" | "computeOffer" | "computeSlot">) => {
    const owned = await assertOpenTaskPrimary({ prisma, config: input.config, sessionId: input.sessionId });
    if ("development" in parsed) await assertDevelopmentRequest({ prisma, config: input.config, taskId: owned.task.id, ...parsed.development });
    if (owned.task.ownerPaused && !("development" in parsed)) throw new Error("Task capability resolution is paused or closed");
    return owned;
  };
  // Check before any host checkout or dependency installation, then again
  // before recording/returning the capability. Resolution never runs it.
  const owned = await assertOwnership(input.prisma);
  const release = await selectCapabilityRelease({ prisma: input.prisma, config: input.config, repositoryId: owned.task.repositoryId, ...(input.release !== undefined ? { release: input.release } : {}) }, active);
  const result = await resolve({ ...(release ? { release } : {}), ...(input.install === false ? { install: false } : {}), task: owned.task, repository: owned.repository, installRoot: input.config.installRoot,
    capability, worktreePath: owned.session.cwd, pinnedToolingRoot: owned.task.pinnedToolingRoot ?? undefined,
    seed: capability === "cleanup"
      ? "Recover this task's incomplete or unsupported cleanup receipts without changing its tooling pin. Inspect exact ownership, use supported lifecycle operations within existing authority, verify absence, then resume the original primary's finalizer. Never fabricate released state or broaden deletion targets."
      : capability === "runtime"
      ? "Use the reviewed remote environment commands for this existing task. Inspect and reuse its saved environment and data, select only needed services, check the approved test identity, and report actual setup progress. Preserve task and tooling identity."
      : capability === "browser"
      ? "Use reviewed headless browser commands for this existing task. Reuse its exact owned profile and purpose; capture actual feature evidence without changing its task or tooling pin."
      : "Recover only the development configuration required by this existing task; inspect names and integrity, then verify the original live operation. Distinguish missing configuration, authorization denial, invalid credentials and provider outage. Never use production fallback." });
  const key = `${owned.task.id}:${createHash("sha256").update(JSON.stringify(result.receipt)).digest("hex")}`;
  await input.prisma.$transaction(async (tx) => {
    const current = await assertOwnership(tx);
    if (current.task.id !== owned.task.id
      || current.task.worktreePath !== owned.task.worktreePath || current.task.toolingRevision !== owned.task.toolingRevision
      || current.task.pinnedToolingRoot !== owned.task.pinnedToolingRoot) throw new Error("Task ownership changed during capability resolution");
    if (!(await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owned.session.id, action: "tooling-capability", key } }))) {
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owned.session.id, action: "tooling-capability", key,
        source: `task:${owned.task.id}`, value: JSON.stringify(result.receipt) } });
    }
  });
  return { receipt: result.receipt, instructions: result.prompt };
}
