import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { ToolingReleaseSelection } from "../../../../types/tooling-release.ts";
import { resolveToolingCompatibility } from "./tooling-compatibility.ts";
import { DevelopmentReference, assertDevelopmentRequest } from "./development-intent.ts";
import { assertOpenTaskPrimary, boundCode, type ToolingCodeIdentity } from "./tooling-operations.ts";
import { getActiveToolingRelease } from "./tooling-releases.ts";
import { recordCapabilityOutcome } from "./tooling-capability-outcome.ts";

export { assertOpenTaskPrimary };

// Merge is deliberately not exposed: its workflow has a separate owner
// approval boundary. A caller may select a name, never a path or revision.
export const ToolingCapabilityInput = z.union([
  z.object({ capability: z.enum(["development-credentials", "cleanup", "runtime", "browser"]) }).strict(),
  z.object({ capability: z.literal("runtime"), development: DevelopmentReference }).strict(),
]);
type Context = { prisma: PrismaClient; config: ServerConfig; sessionId: string };
/** Code for this capability: an explicit identity from the outer boundary,
 * else the guarded callback's binding or legacy snapshot, else (a new
 * independent resolution) the current active generation. Null keeps the
 * pre-protocol configured-host behavior of a repository never activated. */
export async function selectCapabilityRelease(input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string; release?: ToolingCodeIdentity | null },
  active: (input: { prisma: PrismaClient; config: ServerConfig; repositoryId: string }) => Promise<ToolingReleaseSelection | null> = getActiveToolingRelease): Promise<ToolingCodeIdentity | null> {
  const scoped = boundCode(input.release);
  if (scoped !== undefined) {
    if (scoped && scoped.repositoryId !== input.repositoryId) throw new Error("Bound tooling code belongs to another repository");
    return scoped;
  }
  return (await active(input))?.release ?? null;
}

export async function resolveSessionToolingCapability(input: Context & z.infer<typeof ToolingCapabilityInput> & { release?: ToolingCodeIdentity | null; install?: boolean },
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
  const assertUnchanged = async (tx: Parameters<typeof assertOwnership>[0]) => {
    const current = await assertOwnership(tx);
    if (current.task.id !== owned.task.id || current.task.worktreePath !== owned.task.worktreePath
      || current.task.toolingRevision !== owned.task.toolingRevision || current.task.pinnedToolingRoot !== owned.task.pinnedToolingRoot
      || current.task.repositoryId !== owned.task.repositoryId || current.task.machineId !== owned.task.machineId
      || current.task.connectionId !== owned.task.connectionId || current.task.issueIdentifier !== owned.task.issueIdentifier)
      throw new Error("Task ownership changed during capability resolution");
  };
  const outcome = { version: 1 as const, capability, taskId: owned.task.id, sessionId: owned.session.id,
    worktreePath: owned.session.cwd, taskToolingRevision: owned.task.toolingRevision,
    connectionId: owned.task.connectionId, issueIdentifier: owned.task.issueIdentifier,
    capabilityRevision: release?.revision ?? owned.repository.tooling?.revision ?? owned.task.toolingRevision };
  let result: Awaited<ReturnType<typeof resolve>>;
  try {
    result = await resolve({ ...(release ? { release } : {}), ...(input.install === false ? { install: false } : {}), task: owned.task, repository: owned.repository, installRoot: input.config.installRoot,
    capability, worktreePath: owned.session.cwd, pinnedToolingRoot: owned.task.pinnedToolingRoot ?? undefined,
    seed: capability === "cleanup"
      ? "Recover this task's incomplete or unsupported cleanup receipts without changing its tooling pin. Inspect exact ownership, use supported lifecycle operations within existing authority, verify absence, then resume the original primary's finalizer. Never fabricate released state or broaden deletion targets."
      : capability === "runtime"
      ? "Use the reviewed remote environment commands for this existing task. Inspect and reuse its saved environment and data, select only needed services, check the approved test identity, and report actual setup progress. Preserve task and tooling identity."
      : capability === "browser"
      ? "Use reviewed headless browser commands for this existing task. Reuse its exact owned profile and purpose; capture actual feature evidence without changing its task or tooling pin."
      : "Recover only the development configuration required by this existing task; inspect names and integrity, then verify the original live operation. Distinguish missing configuration, authorization denial, invalid credentials and provider outage. Never use production fallback." });
  } catch (error) {
    await input.prisma.$transaction(async tx => {
      await assertUnchanged(tx);
      await recordCapabilityOutcome(tx, { ...outcome, state: "blocked" });
    });
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Use inspect_task for the durable capability blocker and its publication code.`, { cause: error });
  }
  const key = `${owned.task.id}:${createHash("sha256").update(JSON.stringify(result.receipt)).digest("hex")}`;
  await input.prisma.$transaction(async (tx) => {
    await assertUnchanged(tx);
    if (!(await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: owned.session.id, action: "tooling-capability", key } }))) {
      await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: owned.session.id, action: "tooling-capability", key,
        source: `task:${owned.task.id}`, value: JSON.stringify(result.receipt) } });
    }
    await recordCapabilityOutcome(tx, { ...outcome, capabilityRevision: result.receipt.capabilityRevision, state: "resolved" });
  });
  return { receipt: result.receipt, instructions: result.prompt };
}
