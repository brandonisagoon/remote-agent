import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { bunCommandClient } from "../../transports/command/index.ts";

export const FINALIZATION_PREPARED = "finalization-prepared";
export const FINALIZATION_CONFIRMED = "finalization-confirmed";
const Snapshot = z.object({ head: z.string(), branch: z.string(), clean: z.boolean(), fingerprint: z.string() });
export const CompletionDelivery = z.object({ boundary: z.string(), receipts: z.object({
  contractRevision: z.number().int(), snapshot: Snapshot,
  implementation: z.object({ source: z.string(), phase: z.string() }),
  verification: z.object({ source: z.string(), matched: z.boolean(), evidence: z.array(z.string()) }),
  commit: z.object({ observed: z.boolean(), sha: z.string(), clean: z.boolean() }),
  push: z.object({ observed: z.boolean(), matchesHead: z.boolean() }),
  pullRequest: z.object({ observed: z.boolean(), matchesHead: z.boolean(), url: z.string().nullable() }),
  review: z.object({ observed: z.boolean(), approved: z.boolean() }),
  merge: z.object({ observed: z.boolean(), merged: z.boolean(), sha: z.string().nullable() }),
}) });
export type CompletionDelivery = z.infer<typeof CompletionDelivery>;
export const PreparedFinalization = z.object({
  taskId: z.string(), sessionId: z.string(), requestKey: z.string(), repositoryId: z.string(), machineId: z.string(),
  connectionId: z.string(), issueId: z.string(), issueIdentifier: z.string(),
  contractRevision: z.number().int(),
  worktree: z.string(), taskWorktree: z.string(), registeredWorktree: z.string(), revision: z.string(), branch: z.string(), gitDirectory: z.string(), gitCwd: z.string(),
  delivery: CompletionDelivery,
});
export type PreparedFinalization = z.infer<typeof PreparedFinalization>;
export type FinalizationContext = { prisma: PrismaClient; config: ServerConfig; sessionId: string; requestKey: string; finalizationVersion?: 2; authorityOnly?: true };
type Database = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeMetadataEvent" | "runtimeSessionResourceLink" | "remoteTaskResource">;

export async function finalizationGit(cwd: string, args: string[]) {
  const result = await bunCommandClient.run("git", args, { cwd });
  if (!result.ok) throw new Error("Finalization Git identity could not be verified");
  return result.stdout.trimEnd();
}
export function finalizationWorktrees(value: string) {
  return value.split("\0\0").filter(Boolean).map((entry) => Object.fromEntries(entry.split("\0").filter(Boolean).map((field) => {
    const space = field.indexOf(" ");
    return space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
  })));
}
export async function worktreeIsMissing(worktree: string) {
  try { await lstat(worktree); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

/** Only server-observed Git registration and absence count as removal proof. */
export async function assertFinalizationRemoved(prepared: Pick<PreparedFinalization, "worktree" | "registeredWorktree" | "gitDirectory" | "gitCwd" | "branch">) {
  if (!(await worktreeIsMissing(prepared.worktree)) || !(await worktreeIsMissing(prepared.registeredWorktree))) throw new Error("Finalization worktree still exists; cleanup is not confirmed");
  if (await realpath(prepared.gitDirectory) !== prepared.gitDirectory || await realpath(prepared.gitCwd) !== prepared.gitCwd) throw new Error("Finalization repository identity changed");
  const directory = await realpath(await finalizationGit(prepared.gitCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (directory !== prepared.gitDirectory) throw new Error("Finalization repository Git identity changed");
  const entries = finalizationWorktrees(await finalizationGit(prepared.gitCwd, ["--git-dir", prepared.gitDirectory, "worktree", "list", "--porcelain", "-z"]));
  for (const entry of entries) {
    if (entry.branch === `refs/heads/${prepared.branch}` || entry.worktree === prepared.registeredWorktree || entry.worktree === prepared.worktree || entry.worktree && await realpath(entry.worktree).catch(() => entry.worktree) === prepared.worktree) throw new Error("Finalization worktree remains registered in Git");
  }
}

export async function assertFinalizationAuthority(prisma: Database, config: ServerConfig, prepared: PreparedFinalization, resourcesReleased = false) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: prepared.taskId } });
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: prepared.sessionId } });
  if (task.primarySessionId !== session.id || session.role !== "primary" || session.status === "closed" || task.ownerPaused || task.phase !== "complete") throw new Error("Finalization ownership, phase or task identity changed");
  if (task.repositoryId !== prepared.repositoryId || task.machineId !== prepared.machineId || task.machineId !== config.machine || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || session.cwd !== task.worktreePath || task.branchName !== prepared.branch || task.connectionId !== prepared.connectionId || task.issueIdentifier !== prepared.issueIdentifier) throw new Error("Finalization task identity changed");
  // Compare configured path identity without requiring the removed checkout.
  if (task.worktreePath !== prepared.taskWorktree) throw new Error("Finalization worktree ownership changed");
  if (await realpath(getRepositoryConfig(config, task.repositoryId).root) !== prepared.gitCwd) throw new Error("Finalization configured repository changed");
  const link = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: prepared.connectionId, resourceType: "issue-identifier", externalId: prepared.issueIdentifier, relationship: "handles", endedAt: null } });
  if (!link) throw new Error("Finalization source ownership changed");
  const contract = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: "completion-contract", source: `owner:${task.id}` }, orderBy: { sequence: "desc" } });
  if (contract?.sequence !== prepared.contractRevision || JSON.parse(contract.value ?? "null")?.boundary !== "merge") throw new Error("Finalization completion authority was revoked or replaced");
  if (prepared.delivery.boundary !== "merge" || prepared.delivery.receipts.contractRevision !== prepared.contractRevision || !prepared.delivery.receipts.merge.merged || !prepared.delivery.receipts.merge.sha || !prepared.delivery.receipts.snapshot.clean || prepared.delivery.receipts.snapshot.head !== prepared.revision || prepared.delivery.receipts.snapshot.branch !== prepared.branch) throw new Error("Finalization has no successful merge-delivery receipt");
  if (resourcesReleased && await prisma.remoteTaskResource.count({ where: { taskId: task.id, purpose: { in: ["browser", "development", "review"] }, state: { not: "released" } } })) throw new Error("Finalization has unreleased task resources");
  return task;
}

export async function confirmedFinalizationDelivery(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; taskId: string; contractRevision: number }) {
  const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: `finalizer:${input.taskId}`, action: FINALIZATION_CONFIRMED }, orderBy: { sequence: "desc" } });
  if (!confirmed) throw new Error("Worktree is missing without a confirmed finalization receipt");
  const value = z.object({ preparedRevision: z.number().int() }).parse(JSON.parse(confirmed.value!));
  const preparation = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: value.preparedRevision } });
  if (preparation.action !== FINALIZATION_PREPARED || preparation.source !== confirmed.source || preparation.runtimeSessionId !== input.sessionId || preparation.key !== confirmed.key) throw new Error("Finalization receipt identity mismatch");
  const prepared = PreparedFinalization.parse(JSON.parse(preparation.value!));
  if (prepared.taskId !== input.taskId || prepared.sessionId !== input.sessionId || prepared.contractRevision !== input.contractRevision || prepared.requestKey !== confirmed.key) throw new Error("Finalization receipt is stale for this task");
  await assertFinalizationAuthority(input.prisma, input.config, prepared, true);
  await assertFinalizationRemoved(prepared);
  // Recheck authority after filesystem observations, not just before them.
  await assertFinalizationAuthority(input.prisma, input.config, prepared, true);
  return prepared.delivery;
}
