import { realpath } from "node:fs/promises";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { updateSourceIssue } from "../../integrations/linear/session-store/source-issue/update.ts";
import { CompletionContractInput } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { ExternalTaskIdentity } from "./external-delivery-schema.ts";
import { PreparedFinalization, FINALIZATION_PREPARED, assertFinalizationRemoved, finalizationGit, finalizationWorktrees, worktreeIsMissing } from "./finalization-receipts.ts";
import { observeRetirementDelivery } from "./retirement-authority.ts";
import { retirementDigest, type RetirementDatabase } from "./retirement-receipts.ts";
import { CLEANUP_RESUME, CLEANUP_RESUME_CONFIRMED, CleanupResumeInput, CleanupResumeBinding, CleanupResumeReceipt, cleanupResumeRequestKey } from "./cleanup-resume-schema.ts";
import { observeCleanupResumeSource } from "./cleanup-resume-provider.ts";

type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string };
export const cleanupResumeDependencies = { source: observeCleanupResumeSource, update: updateSourceIssue, remote: observeRetirementDelivery, snapshot: completionObservation.snapshot };
type Dependencies = typeof cleanupResumeDependencies;

async function currentBinding(prisma: RetirementDatabase, config: ServerConfig, taskId: string, preparedRevision?: number) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const session = task.primarySessionId && await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!session || session.role !== "primary" || session.status === "closed" || task.ownerPaused || !["blocked", "waiting", "complete"].includes(task.phase) || !task.worktreePath || !task.connectionId || !task.issueIdentifier || task.machineId !== config.machine || session.machineId !== task.machineId || session.repositoryId !== task.repositoryId || session.cwd !== task.worktreePath) throw new Error("Cleanup resume requires the unpaused original open primary and interrupted cleanup task");
  const link = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } });
  if (!link) throw new Error("Cleanup resume source ownership changed");
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: FINALIZATION_PREPARED, source: `finalizer:${task.id}` }, orderBy: { sequence: "desc" } });
  if (!event || preparedRevision !== undefined && event.sequence !== preparedRevision) throw new Error("Cleanup resume requires the unchanged existing preparation");
  if (await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: "external-delivery-binding", source: `owner:${task.id}` } })) throw new Error("Cleanup resume cannot replace an external-delivery finalization");
  const raw = JSON.parse(event.value!);
  if (raw.version !== undefined || raw.retirementAuthority !== undefined) throw new Error("Cleanup resume currently requires the original Merge-based v1 preparation");
  const prepared = PreparedFinalization.parse(raw);
  if (prepared.taskId !== task.id || prepared.sessionId !== session.id || prepared.requestKey !== `finalize:${task.id}` || event.key !== prepared.requestKey || prepared.taskWorktree !== task.worktreePath || prepared.worktree !== task.worktreePath || prepared.branch !== task.branchName || prepared.repositoryId !== task.repositoryId || prepared.machineId !== task.machineId || prepared.connectionId !== task.connectionId || prepared.issueIdentifier !== task.issueIdentifier) throw new Error("Cleanup preparation does not match the original task identity");
  const owner = { runtimeSessionId: session.id, source: `owner:${task.id}` };
  const contractEvent = await prisma.runtimeMetadataEvent.findFirst({ where: { ...owner, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  const verification = await prisma.runtimeMetadataEvent.findFirst({ where: { ...owner, action: "completion-verification" }, orderBy: { sequence: "desc" } });
  if (!contractEvent || contractEvent.sequence !== prepared.contractRevision || !verification || verification.sequence > event.sequence) throw new Error("Cleanup contract or accepted verification changed");
  const contract = CompletionContractInput.parse(JSON.parse(contractEvent.value!)), accepted = JSON.parse(verification.value!);
  const saved = prepared.delivery.receipts, pr = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(saved.pullRequest.url ?? "");
  if (contract.boundary !== "merge" || prepared.delivery.boundary !== "merge" || accepted?.contractRevision !== contractEvent.sequence || accepted?.verification?.passed !== true || accepted?.snapshot?.fingerprint !== saved.snapshot.fingerprint || !saved.snapshot.clean || saved.snapshot.head !== prepared.revision || saved.snapshot.branch !== prepared.branch || saved.contractRevision !== contractEvent.sequence || !saved.merge.merged || !saved.merge.sha || !saved.pullRequest.matchesHead || !pr || pr[1] !== contract.repository || contract.pullRequest && Number(pr[2]) !== contract.pullRequest || !contract.baseBranch) throw new Error("Cleanup resume has no unchanged verified merged delivery");
  const identity = ExternalTaskIdentity.parse({ taskId: task.id, sessionId: session.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, taskWorktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot });
  const binding = CleanupResumeBinding.parse({ identity, issueId: prepared.issueId, preparedRevision: event.sequence, preparedDigest: retirementDigest(raw), finalizationRequestKey: prepared.requestKey,
    contractRevision: contractEvent.sequence, contractDigest: retirementDigest(contract), verificationRevision: verification.sequence, verificationDigest: retirementDigest(accepted),
    delivery: { repository: pr[1], pullRequest: Number(pr[2]), head: prepared.revision, mergeCommit: saved.merge.sha, baseBranch: contract.baseBranch } });
  return { task, prepared, binding, contract, scoped: scopeConfig(config, { repositoryId: task.repositoryId, connectionId: task.connectionId }) };
}

async function observePrepared(input: Context, current: Awaited<ReturnType<typeof currentBinding>>, dependencies: Dependencies) {
  await observeOriginal(input, current, dependencies);
  await dependencies.remote(current.binding.delivery, current.prepared.branch, current.contract.reviewRequired ?? false);
  // The remote observation can be slow. Do not publish using a source checkout
  // which changed while that independent delivery proof was being read.
  await observeOriginal(input, current, dependencies);
}

async function observeOriginal(input: Context, current: Awaited<ReturnType<typeof currentBinding>>, dependencies: Dependencies) {
  const { prepared, task } = current;
  if (await realpath(getRepositoryConfig(input.config, task.repositoryId).root) !== prepared.gitCwd || await realpath(prepared.gitDirectory) !== prepared.gitDirectory) throw new Error("Original cleanup repository identity changed");
  if (await worktreeIsMissing(prepared.worktree)) await assertFinalizationRemoved(prepared);
  else {
    if (retirementDigest(await dependencies.snapshot(prepared.worktree)) !== retirementDigest(prepared.delivery.receipts.snapshot)) throw new Error("Original worktree changed after cleanup preparation");
    if (await realpath(await finalizationGit(prepared.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== prepared.gitDirectory) throw new Error("Original cleanup Git identity changed");
    const entries = finalizationWorktrees(await finalizationGit(prepared.gitCwd, ["--git-dir", prepared.gitDirectory, "worktree", "list", "--porcelain", "-z"])).filter((entry) => entry.worktree === prepared.registeredWorktree);
    if (entries.length !== 1 || entries[0]!.HEAD !== prepared.revision || entries[0]!.branch !== `refs/heads/${prepared.branch}`) throw new Error("Original cleanup registration changed");
  }
}

async function sourceObservation(current: Awaited<ReturnType<typeof currentBinding>>, dependencies: Dependencies) {
  const observed = await dependencies.source(current.scoped, current.binding.issueId);
  const { issue, viewer } = observed;
  const subscribed = Object.values(current.scoped.webhooks).some((webhook) => webhook.connectionId === current.task.connectionId
    && webhook.repositoryRouting[current.task.repositoryId]?.when?.some((condition) => condition["linear.userId"]?.includes(viewer.id)));
  if (!issue || issue.id !== current.binding.issueId || issue.identifier !== current.binding.identity.issueIdentifier || !current.scoped.agentUserId || viewer.id !== current.scoped.agentUserId || subscribed) throw new Error("Cleanup resume requires the exact source and independently verified service actor");
  const targets = issue.team.states.nodes.filter((state) => state.name === "Merge");
  if (targets.length !== 1 || targets[0]!.type === "completed" || targets[0]!.id === issue.state.id && issue.state.name !== "Merge") throw new Error("Cleanup stage is unavailable or ambiguous in this source team");
  return { issue, viewer, target: targets[0]! };
}

export async function inspectCleanupResume(input: Context, dependencies = cleanupResumeDependencies) {
  const current = await currentBinding(input.prisma, input.config, input.taskId);
  const source = await sourceObservation(current, dependencies);
  const scope = { runtimeSessionId: current.task.primarySessionId!, source: `owner:${input.taskId}` };
  let expectedStateId = source.issue.state.id, expectedUpdatedAt = source.issue.updatedAt;
  // After an applied state update with a lost acknowledgment, recover the
  // original attempt rather than deriving a new key from the resulting Merge.
  if (source.issue.state.id === source.target.id) {
    const latest = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...scope, action: CLEANUP_RESUME }, orderBy: { sequence: "desc" } });
    const saved = latest && CleanupResumeReceipt.parse(JSON.parse(latest.value!));
    if (saved && retirementDigest(saved.binding) === retirementDigest(current.binding) && saved.serviceActorId === source.viewer.id && saved.targetStateId === source.target.id) {
      expectedStateId = saved.input.expectedStateId; expectedUpdatedAt = saved.input.expectedUpdatedAt;
    }
  }
  const requestKey = cleanupResumeRequestKey({ preparedRevision: current.binding.preparedRevision, expectedStateId, expectedUpdatedAt });
  const where = { ...scope, key: requestKey };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: CLEANUP_RESUME } });
  const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: CLEANUP_RESUME_CONFIRMED } });
  return { taskId: input.taskId, sessionId: current.task.primarySessionId!, preparedRevision: current.binding.preparedRevision, requestKey,
    bindingDigest: retirementDigest(current.binding), contractRevision: current.binding.contractRevision, verificationRevision: current.binding.verificationRevision, expectedStateId, expectedUpdatedAt,
    sourceState: source.issue.state.name, phase: current.task.phase, resumeRevision: prior?.sequence ?? null, confirmedRevision: confirmed?.sequence ?? null,
    request: prior ? CleanupResumeReceipt.parse(JSON.parse(prior.value!)).input : null,
    eligible: source.issue.state.name === "Blocked" || Boolean(prior && source.issue.state.name === "Merge") };
}

const writes = new Map<string, Promise<unknown>>();
/** Owner bearer API only. This resumes an existing finalizer; it does not
 * issue a Merge approval, edit a preparation, merge code or release resources. */
export async function resumePreparedCleanup(input: Context & { resume: CleanupResumeInput }, dependencies = cleanupResumeDependencies) {
  const previous = writes.get(input.taskId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => resume(input, dependencies)); writes.set(input.taskId, run);
  try { return await run; } finally { if (writes.get(input.taskId) === run) writes.delete(input.taskId); }
}

async function resume(input: Context & { resume: CleanupResumeInput }, dependencies: Dependencies) {
  const request = CleanupResumeInput.parse(input.resume);
  let current = await currentBinding(input.prisma, input.config, input.taskId, request.preparedRevision);
  if (request.requestKey !== cleanupResumeRequestKey(request) || retirementDigest(current.binding) !== request.expectedBindingDigest) throw new Error("Cleanup resume must use the exact stable request and current binding");
  const where = { runtimeSessionId: current.task.primarySessionId!, source: `owner:${input.taskId}`, key: request.requestKey };
  let event = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: CLEANUP_RESUME } });
  let saved = event ? CleanupResumeReceipt.parse(JSON.parse(event.value!)) : undefined;
  if (saved && (retirementDigest(saved.input) !== retirementDigest(request) || retirementDigest(saved.binding) !== retirementDigest(current.binding))) throw new Error("Cleanup resume request belongs to different immutable authority");
  let source = await sourceObservation(current, dependencies);
  const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: CLEANUP_RESUME_CONFIRMED } });
  if (confirmed) {
    const proof = JSON.parse(confirmed.value!);
    if (!event || proof.resumeRevision !== event.sequence || proof.receiptDigest !== retirementDigest(saved)) throw new Error("Cleanup resume confirmation does not match its immutable request");
    return { taskId: input.taskId, sessionId: current.task.primarySessionId!, preparedRevision: request.preparedRevision, resumeRevision: event.sequence, confirmedRevision: confirmed.sequence, alreadyCompleted: true, sourceState: source.issue.state.name, phase: current.task.phase };
  }
  if (!event && (source.issue.state.name !== request.expectedState || source.issue.state.id !== request.expectedStateId || source.issue.updatedAt !== request.expectedUpdatedAt)) throw new Error("Cleanup resume requires the expected current Blocked source revision");
  await observePrepared(input, current, dependencies);
  const fresh = await currentBinding(input.prisma, input.config, input.taskId, request.preparedRevision);
  if (retirementDigest(fresh.binding) !== retirementDigest(current.binding)) throw new Error("Cleanup authority changed during delivery observation");
  current = fresh;
  const rechecked = await sourceObservation(current, dependencies);
  if (!event && (rechecked.issue.state.id !== source.issue.state.id || rechecked.issue.updatedAt !== source.issue.updatedAt)) throw new Error("Source changed during cleanup-resume observation");
  source = rechecked;
  if (!event) {
    saved = CleanupResumeReceipt.parse({ version: 1, input: request, binding: current.binding, serviceActorId: source.viewer.id, sourceStateId: source.issue.state.id, sourceUpdatedAt: source.issue.updatedAt, targetStateId: source.target.id });
    const value = JSON.stringify(saved);
    event = await input.prisma.$transaction(async (tx) => {
      const duplicate = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: CLEANUP_RESUME } });
      if (duplicate) { if (duplicate.value !== value) throw new Error("Cleanup resume was prepared concurrently with different source authority"); return duplicate; }
      if (retirementDigest((await currentBinding(tx, input.config, input.taskId, request.preparedRevision)).binding) !== retirementDigest(current.binding)) throw new Error("Cleanup authority changed before publication");
      return tx.runtimeMetadataEvent.create({ data: { ...where, action: CLEANUP_RESUME, value } });
    });
  }
  const receipt = saved!;
  const assertCurrent = async () => {
    const latest = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: where.runtimeSessionId, source: where.source, action: CLEANUP_RESUME }, orderBy: { sequence: "desc" } });
    if (latest?.sequence !== event.sequence) throw new Error("A newer cleanup-resume attempt superseded this pending request");
    const binding = await currentBinding(input.prisma, input.config, input.taskId, request.preparedRevision);
    if (retirementDigest(binding.binding) !== retirementDigest(receipt.binding)) throw new Error("Cleanup authority changed before publication");
    const observed = await sourceObservation(binding, dependencies);
    if (observed.viewer.id !== receipt.serviceActorId || observed.target.id !== receipt.targetStateId || observed.issue.state.id !== receipt.targetStateId && (observed.issue.state.id !== receipt.sourceStateId || observed.issue.updatedAt !== receipt.sourceUpdatedAt)) throw new Error("Cleanup source changed; the old request cannot overwrite a later owner decision");
    return { binding, observed };
  };
  const before = await assertCurrent();
  if (before.observed.issue.state.id !== receipt.targetStateId) await dependencies.update(before.binding.scoped, { id: receipt.binding.issueId }, { stateId: receipt.targetStateId });
  const after = await assertCurrent();
  if (after.observed.issue.state.id !== receipt.targetStateId) throw new Error("Cleanup source publication is unconfirmed; retry the same request");
  const confirmation = await input.prisma.$transaction(async (tx) => {
    const latest = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: where.runtimeSessionId, source: where.source, action: CLEANUP_RESUME }, orderBy: { sequence: "desc" } });
    if (latest?.sequence !== event.sequence) throw new Error("A newer cleanup-resume attempt superseded this pending request");
    if (retirementDigest((await currentBinding(tx, input.config, input.taskId, request.preparedRevision)).binding) !== retirementDigest(receipt.binding)) throw new Error("Cleanup authority changed after publication");
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: CLEANUP_RESUME_CONFIRMED } });
    if (prior) return prior;
    await tx.remoteTask.update({ where: { id: input.taskId }, data: { phase: "complete" } });
    return tx.runtimeMetadataEvent.create({ data: { ...where, action: CLEANUP_RESUME_CONFIRMED, value: JSON.stringify({ resumeRevision: event.sequence, receiptDigest: retirementDigest(receipt), preparedRevision: request.preparedRevision, sourceUpdatedAt: after.observed.issue.updatedAt }) } });
  });
  return { taskId: input.taskId, sessionId: current.task.primarySessionId!, preparedRevision: request.preparedRevision, resumeRevision: event.sequence, confirmedRevision: confirmation.sequence, alreadyCompleted: false, sourceState: "Merge", phase: "complete" };
}
