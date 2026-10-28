import { realpath } from "node:fs/promises";
import { z } from "zod";
import { getRepositoryConfig } from "../../../../lib/config.ts";
import { linkedSourceIssue } from "../sessions/questions.ts";
import { assertCompletionAllowed } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import {
  FINALIZATION_PREPARED, FINALIZATION_CONFIRMED, PreparedFinalization,
  assertFinalizationAuthority, assertFinalizationRemoved, finalizationGit, finalizationWorktrees, worktreeIsMissing,
  type FinalizationContext,
} from "./finalization-receipts.ts";

export const FinalizationInput = z.object({ requestKey: z.string().trim().min(1).max(180) }).strict();
export const finalizationDependencies = { source: linkedSourceIssue, completion: assertCompletionAllowed, snapshot: completionObservation.snapshot };
type Dependencies = typeof finalizationDependencies;

async function owned(input: FinalizationContext) {
  FinalizationInput.parse({ requestKey: input.requestKey });
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  const session = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  if (!task || !task.worktreePath || !task.connectionId || !task.issueIdentifier || task.phase !== "complete" || task.controlMode !== "agent" || session.role !== "primary" || session.status === "closed" || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || task.machineId !== input.config.machine) throw new Error("Finalization requires the open complete task's original agent-controlled primary");
  return task;
}

async function sourceAuthority(input: FinalizationContext, taskId: string, dependencies: Dependencies) {
  const source = await dependencies.source(input);
  if (source.issue.state.name === "Merge") return source;
  // A lost close response after successful publication may be retried, but a
  // bare Done state is not authority to clean up somebody else's delivery.
  if (source.issue.state.name === "Done") {
    const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, action: FINALIZATION_CONFIRMED, source: `finalizer:${taskId}`, key: input.requestKey } });
    const update = await input.prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: input.sessionId, requestKey: `${input.requestKey}:done` } } });
    const payload = update?.input as { state?: string; expectedState?: string } | undefined;
    if (confirmed && update?.published && update.issueId === source.issue.id && update.connectionId === source.link.connectionId && payload?.state === "Done" && payload.expectedState === "Merge") return source;
  }
  throw new Error("Finalization requires current owner Merge authority");
}

function result(prepared: PreparedFinalization, preparedRevision: number, confirmedRevision?: number) {
  return { requestKey: prepared.requestKey, taskId: prepared.taskId, sessionId: prepared.sessionId, preparedRevision,
    ...(confirmedRevision ? { confirmedRevision } : {}), worktree: prepared.worktree, revision: prepared.revision,
    branch: prepared.branch, gitDirectory: prepared.gitDirectory, gitCwd: prepared.gitCwd };
}

/** Verify delivery before deleting the only checkout that can prove it. This
 * creates no cleanup effects and never treats a model resource as authority. */
export async function prepareTaskFinalization(input: FinalizationContext, dependencies: Dependencies = finalizationDependencies) {
  const task = await owned(input);
  const source = await sourceAuthority(input, task.id, dependencies);
  if (source.link.connectionId !== task.connectionId || source.issue.identifier !== task.issueIdentifier || source.session.id !== input.sessionId) throw new Error("Finalization source does not belong to this task");
  const where = { runtimeSessionId: input.sessionId, action: FINALIZATION_PREPARED, source: `finalizer:${task.id}`, key: input.requestKey };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where });
  if (prior) {
    const prepared = PreparedFinalization.parse(JSON.parse(prior.value!));
    if (prepared.issueId !== source.issue.id || prepared.requestKey !== input.requestKey) throw new Error("Finalization requestKey belongs to a different source");
    const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
    await assertFinalizationAuthority(input.prisma, input.config, prepared, Boolean(confirmed));
    if (confirmed) {
      // A completed cleanup is replayed, never expanded to a newly created
      // worktree or newly retained resource after Done was published.
      await assertFinalizationRemoved(prepared);
      return result(prepared, prior.sequence, confirmed.sequence);
    }
    if (!(await worktreeIsMissing(prepared.worktree))) {
      const snapshot = await dependencies.snapshot(prepared.worktree);
      if (JSON.stringify(snapshot) !== JSON.stringify(prepared.delivery.receipts.snapshot)) throw new Error("Worktree changed since finalization preparation; inspect before using a new requestKey");
    }
    return result(prepared, prior.sequence);
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
    contractRevision: delivery.receipts.contractRevision, controlGeneration: task.controlGeneration,
    worktree, taskWorktree: task.worktreePath!, registeredWorktree: entry!.worktree!, revision: delivery.receipts.snapshot.head, branch: task.branchName, gitDirectory, gitCwd, delivery };
  const snapshot = await dependencies.snapshot(worktree);
  if (JSON.stringify(snapshot) !== JSON.stringify(delivery.receipts.snapshot)) throw new Error("Worktree changed during finalization preparation");
  await sourceAuthority(input, task.id, dependencies);
  return input.prisma.$transaction(async (tx) => {
    await assertFinalizationAuthority(tx, input.config, prepared);
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where });
    if (duplicate) {
      if (duplicate.value !== JSON.stringify(prepared)) throw new Error("Finalization requestKey already belongs to another preparation");
      return result(prepared, duplicate.sequence);
    }
    const receipt = await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(prepared) } });
    return result(prepared, receipt.sequence);
  });
}

/** Confirmation observes cleanup; it neither deletes nor automatically repeats
 * anything after an interrupted adapter. The provider remains open for Done. */
export async function confirmTaskFinalization(input: FinalizationContext, dependencies: Dependencies = finalizationDependencies) {
  const task = await owned(input);
  const source = await sourceAuthority(input, task.id, dependencies);
  const where = { runtimeSessionId: input.sessionId, source: `finalizer:${task.id}`, key: input.requestKey };
  const preparation = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_PREPARED } });
  if (!preparation) throw new Error("Finalization was not prepared; missing cleanup cannot prove delivery");
  const prepared = PreparedFinalization.parse(JSON.parse(preparation.value!));
  if (prepared.taskId !== task.id || prepared.sessionId !== input.sessionId || prepared.requestKey !== input.requestKey || prepared.issueId !== source.issue.id || prepared.connectionId !== source.link.connectionId) throw new Error("Finalization source identity changed");
  await assertFinalizationAuthority(input.prisma, input.config, prepared, true);
  await assertFinalizationRemoved(prepared);
  await sourceAuthority(input, task.id, dependencies);
  return input.prisma.$transaction(async (tx) => {
    await assertFinalizationAuthority(tx, input.config, prepared, true);
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
    if (prior) return result(prepared, preparation.sequence, prior.sequence);
    const receipt = await tx.runtimeMetadataEvent.create({ data: { ...where, action: FINALIZATION_CONFIRMED, value: JSON.stringify({ preparedRevision: preparation.sequence }) } });
    return result(prepared, preparation.sequence, receipt.sequence);
  });
}
