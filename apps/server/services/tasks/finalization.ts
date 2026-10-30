import { realpath } from "node:fs/promises";
import { z } from "zod";
import { getRepositoryConfig } from "../../../../lib/config.ts";
import { linkedSourceIssue } from "../sessions/questions.ts";
import { assertCompletionAllowed } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { latestExternalBinding } from "./external-deliveries.ts";
import { prepareExternalFinalization, confirmExternalFinalization } from "./external-finalization.ts";
import { observeRetirementDelivery } from "./retirement-authority.ts";
import { assertRetirementAuthority, latestRetirement } from "./retirement-receipts.ts";
import { ensureArchiveRetention, verifyPreparedArchives } from "./archive-retention.ts";
import type { ArchiveRetentionReceipt } from "./archive-retention-schema.ts";
import { latestDoneRetirement, observeDoneRetirement } from "./delivered-retirement.ts";
import {
  FINALIZATION_PREPARED, FINALIZATION_CONFIRMED, PreparedFinalization,
  assertFinalizationAuthority, assertFinalizationRemoved, finalizationGit, finalizationWorktrees, worktreeIsMissing,
  type FinalizationContext,
} from "./finalization-receipts.ts";

export const FinalizationInput = z.object({ requestKey: z.string().trim().min(1).max(180), finalizationVersion: z.literal(2).optional(), authorityOnly: z.literal(true).optional() }).strict().refine((value) => !value.authorityOnly || value.finalizationVersion === 2, "Authority-only checks require finalization version 2");
export const finalizationDependencies = { source: linkedSourceIssue, completion: assertCompletionAllowed, snapshot: completionObservation.snapshot };
type Dependencies = typeof finalizationDependencies & { retirementRemote?: typeof observeRetirementDelivery };

async function owned(input: FinalizationContext) {
  FinalizationInput.parse({ requestKey: input.requestKey });
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  if (!task || !task.worktreePath || !task.connectionId || !task.issueIdentifier || task.ownerPaused || task.phase !== "complete" || session.role !== "primary" || session.status === "closed" || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || task.machineId !== input.config.machine) throw new Error("Finalization requires the open complete task's original primary");
  return task;
}

async function sourceAuthority(input: FinalizationContext, taskId: string, dependencies: Dependencies): Promise<Awaited<ReturnType<typeof linkedSourceIssue>> & { retirementAuthority?: PreparedFinalization["retirementAuthority"]; retirementSupplement?: PreparedFinalization["retirementAuthority"] }> {
  const source = await dependencies.source(input);
  if (source.issue.state.name === "Merge") return source;
  // A lost close response after successful publication may be retried, but a
  // bare Done state is not authority to clean up somebody else's delivery.
  if (source.issue.state.name === "Done") {
    if (await latestDoneRetirement(input.prisma, taskId, input.sessionId)) {
      const retirementSupplement = await observeDoneRetirement({ ...input, taskId }, source, { source: dependencies.source, snapshot: dependencies.snapshot, remote: dependencies.retirementRemote ?? observeRetirementDelivery });
      return { ...source, retirementSupplement };
    }
    if (await latestRetirement(input.prisma, taskId, input.sessionId)) {
      const { grant, reference } = await assertRetirementAuthority(input.prisma, input.config, taskId, input.sessionId, source.issue.id);
      const contract = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: grant.binding.contractRevision } });
      await (dependencies.retirementRemote ?? observeRetirementDelivery)(grant.delivery, grant.binding.branch, JSON.parse(contract.value!).reviewRequired ?? false);
      // A remote observation can take time; refresh mutable owner authority.
      await assertRetirementAuthority(input.prisma, input.config, taskId, input.sessionId, source.issue.id, reference);
      const current = await dependencies.source(input);
      if (current.issue.state.name !== "Done" || current.issue.id !== source.issue.id || current.issue.identifier !== source.issue.identifier || current.link.connectionId !== source.link.connectionId || current.session.id !== input.sessionId) throw new Error("Retirement source authority changed during delivery observation");
      return { ...source, retirementAuthority: reference };
    }
    const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, action: FINALIZATION_CONFIRMED, source: `finalizer:${taskId}`, key: input.requestKey } });
    const update = await input.prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: input.sessionId, requestKey: `${input.requestKey}:done` } } });
    const payload = update?.input as { state?: string; expectedState?: string } | undefined;
    if (confirmed && update?.published && update.issueId === source.issue.id && update.connectionId === source.link.connectionId && payload?.state === "Done" && payload.expectedState === "Merge") return source;
  }
  throw new Error("Finalization requires current owner Merge authority");
}

function result(prepared: PreparedFinalization, preparedRevision: number, confirmedRevision?: number, archiveRetention?: ArchiveRetentionReceipt, supplement?: PreparedFinalization["retirementAuthority"]) {
  const authority = supplement ?? prepared.retirementAuthority;
  return { requestKey: prepared.requestKey, taskId: prepared.taskId, sessionId: prepared.sessionId, preparedRevision,
    ...(confirmedRevision ? { confirmedRevision } : {}), worktree: prepared.worktree, revision: prepared.revision,
    branch: prepared.branch, gitDirectory: prepared.gitDirectory, gitCwd: prepared.gitCwd,
    ...(archiveRetention ? { archiveRetention } : {}),
    ...(authority ? { retirement: { authorityRevision: authority.revision, authorityDigest: authority.digest,
      doneHandoff: { requestKey: `${prepared.requestKey}:done`, expectedState: "Done" as const, state: "Done" as const,
        body: `Task ${prepared.taskId} retirement is confirmed under explicit owner authorization. Its accepted delivery at ${prepared.revision} is merged, ${archiveRetention ? "resources requiring removal are released and verified saved archives remain intact" : "recorded development, browser and review resources are released"}, and its exact development worktree and Git registration are absent. The issue remains Done; this coding session is now closing.` } } } : {}) };
}

async function assertObservedPreparationAuthority(input: FinalizationContext, prepared: PreparedFinalization, dependencies: Dependencies, confirmed = false) {
  // Content hashing and Git observations can outlast a source-state change.
  // Refresh the actual owner/source after them, before returning adapter authority.
  const source = await sourceAuthority(input, prepared.taskId, dependencies);
  if (source.issue.id !== prepared.issueId || source.issue.identifier !== prepared.issueIdentifier || source.link.connectionId !== prepared.connectionId || source.session.id !== prepared.sessionId
    || source.retirementAuthority?.revision !== prepared.retirementAuthority?.revision || source.retirementAuthority?.digest !== prepared.retirementAuthority?.digest) throw new Error("Finalization source authority changed during observation");
  await assertFinalizationAuthority(input.prisma, input.config, prepared, confirmed);
}

/** Verify delivery before deleting the only checkout that can prove it. This
 * creates no cleanup effects and never treats a model resource as authority. */
export async function prepareTaskFinalization(input: FinalizationContext, dependencies: Dependencies = finalizationDependencies) {
  const task = await owned(input);
  if (await latestExternalBinding(input.prisma, task.id, input.sessionId)) return prepareExternalFinalization(input);
  if (input.authorityOnly) throw new Error("Authority-only checks require external finalization version 2");
  if (input.finalizationVersion === 2) throw new Error("Finalization version 2 requires an adopted external delivery binding");
  const source = await sourceAuthority(input, task.id, dependencies);
  if (source.link.connectionId !== task.connectionId || source.issue.identifier !== task.issueIdentifier || source.session.id !== input.sessionId) throw new Error("Finalization source does not belong to this task");
  const where = { runtimeSessionId: input.sessionId, action: FINALIZATION_PREPARED, source: `finalizer:${task.id}`, key: input.requestKey };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where });
  if (prior) {
    const prepared = PreparedFinalization.parse(JSON.parse(prior.value!));
    if (Boolean(prepared.retirementAuthority) !== Boolean(source.retirementAuthority)) throw new Error("Finalization source retirement authority changed");
    if (prepared.issueId !== source.issue.id || prepared.requestKey !== input.requestKey) throw new Error("Finalization requestKey belongs to a different source");
    const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
    await assertFinalizationAuthority(input.prisma, input.config, prepared);
    const archiveRetention = await ensureArchiveRetention({ prisma: input.prisma, config: input.config, taskId: task.id, preparedRevision: prior.sequence });
    await assertFinalizationAuthority(input.prisma, input.config, prepared, Boolean(confirmed));
    if (confirmed) {
      // A completed cleanup is replayed, never expanded to a newly created
      // worktree or newly retained resource after Done was published.
      await assertFinalizationRemoved(prepared);
      await assertObservedPreparationAuthority(input, prepared, dependencies, true);
      return result(prepared, prior.sequence, confirmed.sequence, archiveRetention, source.retirementSupplement);
    }
    if (!(await worktreeIsMissing(prepared.worktree))) {
      const snapshot = await dependencies.snapshot(prepared.worktree);
      if (JSON.stringify(snapshot) !== JSON.stringify(prepared.delivery.receipts.snapshot)) throw new Error("Worktree changed since finalization preparation; inspect before using a new requestKey");
    }
    await assertObservedPreparationAuthority(input, prepared, dependencies);
    return result(prepared, prior.sequence, undefined, archiveRetention, source.retirementSupplement);
  }
  const delivery = await dependencies.completion(input);
  if (delivery.boundary !== "merge" || !delivery.receipts.merge.merged) throw new Error("Finalization requires verified authorized merge delivery");
  const worktree = await realpath(task.worktreePath!);
  const gitCwd = await realpath(getRepositoryConfig(input.config, task.repositoryId).root);
  if (worktree === gitCwd) throw new Error("Finalization may not remove the configured repository root");
  const gitDirectory = await realpath(await finalizationGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const repositoryGit = await realpath(await finalizationGit(gitCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (repositoryGit !== gitDirectory) throw new Error("Finalization worktree is not owned by the configured repository");
  const entries = finalizationWorktrees(await finalizationGit(gitCwd, ["--git-dir", gitDirectory, "worktree", "list", "--porcelain", "-z"]));
  const matching = [];
  for (const entry of entries) if (entry.worktree && await realpath(entry.worktree).catch(() => "") === worktree) matching.push(entry);
  const entry = matching[0];
  if (matching.length !== 1 || entry?.HEAD !== delivery.receipts.snapshot.head || entry?.branch !== `refs/heads/${task.branchName}`) throw new Error("Finalization Git registration does not match verified delivery");
  const prepared: PreparedFinalization = { taskId: task.id, sessionId: input.sessionId, requestKey: input.requestKey,
    repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId!, issueIdentifier: task.issueIdentifier!, issueId: source.issue.id,
    contractRevision: delivery.receipts.contractRevision,
    worktree, taskWorktree: task.worktreePath!, registeredWorktree: entry!.worktree!, revision: delivery.receipts.snapshot.head, branch: task.branchName, gitDirectory, gitCwd, delivery,
    ...(source.retirementAuthority ? { retirementAuthority: source.retirementAuthority } : {}) };
  const snapshot = await dependencies.snapshot(worktree);
  if (JSON.stringify(snapshot) !== JSON.stringify(delivery.receipts.snapshot)) throw new Error("Worktree changed during finalization preparation");
  await sourceAuthority(input, task.id, dependencies);
  const recorded = await input.prisma.$transaction(async (tx) => {
    await assertFinalizationAuthority(tx, input.config, prepared);
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where });
    if (duplicate) {
      if (duplicate.value !== JSON.stringify(prepared)) throw new Error("Finalization requestKey already belongs to another preparation");
      return result(prepared, duplicate.sequence);
    }
    const receipt = await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(prepared) } });
    return result(prepared, receipt.sequence);
  });
  const archiveRetention = await ensureArchiveRetention({ prisma: input.prisma, config: input.config, taskId: task.id, preparedRevision: recorded.preparedRevision });
  await assertObservedPreparationAuthority(input, prepared, dependencies);
  return result(prepared, recorded.preparedRevision, undefined, archiveRetention);
}

/** Confirmation observes cleanup; it neither deletes nor automatically repeats
 * anything after an interrupted adapter. The provider remains open for Done. */
export async function confirmTaskFinalization(input: FinalizationContext, dependencies: Dependencies = finalizationDependencies) {
  const task = await owned(input);
  if (input.authorityOnly) throw new Error("Authority-only checks cannot confirm finalization");
  if (await latestExternalBinding(input.prisma, task.id, input.sessionId)) return confirmExternalFinalization(input);
  if (input.finalizationVersion === 2) throw new Error("Finalization version 2 requires an adopted external delivery binding");
  const source = await sourceAuthority(input, task.id, dependencies);
  const where = { runtimeSessionId: input.sessionId, source: `finalizer:${task.id}`, key: input.requestKey };
  const preparation = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_PREPARED } });
  if (!preparation) throw new Error("Finalization was not prepared; missing cleanup cannot prove delivery");
  const prepared = PreparedFinalization.parse(JSON.parse(preparation.value!));
  if (Boolean(prepared.retirementAuthority) !== Boolean(source.retirementAuthority)) throw new Error("Finalization source retirement authority changed");
  if (prepared.taskId !== task.id || prepared.sessionId !== input.sessionId || prepared.requestKey !== input.requestKey || prepared.issueId !== source.issue.id || prepared.connectionId !== source.link.connectionId) throw new Error("Finalization source identity changed");
  await assertFinalizationAuthority(input.prisma, input.config, prepared, true);
  const archiveRetention = await verifyPreparedArchives(input.prisma, input.config, prepared);
  await assertFinalizationRemoved(prepared);
  await sourceAuthority(input, task.id, dependencies);
  return input.prisma.$transaction(async (tx) => {
    await assertFinalizationAuthority(tx, input.config, prepared, true);
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
    if (prior) return result(prepared, preparation.sequence, prior.sequence, archiveRetention, source.retirementSupplement);
    const receipt = await tx.runtimeMetadataEvent.create({ data: { ...where, action: FINALIZATION_CONFIRMED, value: JSON.stringify({ preparedRevision: preparation.sequence }) } });
    return result(prepared, preparation.sequence, receipt.sequence, archiveRetention, source.retirementSupplement);
  });
}

export async function assertPreparedDoneHandoff(input: FinalizationContext & { body?: string; state?: string; expectedState?: string }, dependencies: Dependencies = finalizationDependencies) {
  const task = await owned(input);
  const supplement = await latestDoneRetirement(input.prisma, task.id, input.sessionId);
  if (!supplement) throw new Error("Prepared Done retirement supplement is missing");
  const grant = JSON.parse(supplement.value!);
  const preparation = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: grant.preparedRevision } });
  const prepared = PreparedFinalization.parse(JSON.parse(preparation.value!));
  const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED, key: prepared.requestKey } });
  if (!confirmed || JSON.parse(confirmed.value!).preparedRevision !== preparation.sequence) throw new Error("Prepared Done handoff requires confirmed cleanup");
  const replay = await confirmTaskFinalization({ ...input, requestKey: prepared.requestKey }, dependencies);
  const handoff = "retirement" in replay ? replay.retirement?.doneHandoff : undefined;
  if (!handoff || input.requestKey !== handoff.requestKey || input.body !== handoff.body || input.state !== handoff.state || input.expectedState !== handoff.expectedState) throw new Error("Prepared Done retirement requires the exact immutable handoff");
}
