import { ensureOriginalAdministration, originalAdministrationReceipt } from "./original-work-supplement.ts";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { assertExternalBindingAuthority, assertExternalResourceRecords, externalBindingDependencies, latestExternalBinding, observeBoundExternalDelivery, type ExternalDependencies } from "./external-deliveries.ts";
import { EXTERNAL_OBSERVATION, ExternalBinding, externalDigest } from "./external-delivery-schema.ts";
import { FinalizationResourcePlan, assertFinalizationResources, finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { FINALIZATION_CONFIRMED, FINALIZATION_PREPARED, assertFinalizationRemoved, finalizationGit, finalizationWorktrees, worktreeIsMissing, type FinalizationContext } from "./finalization-receipts.ts";


import { assertPreparedCleanup, bindPreparedCleanup, hasPreparedCleanup, inspectPreparedCleanupAuthority } from "./cleanup-lifecycle.ts";
import { queueCleanupReport } from "./cleanup-report.ts";
import { retirementDigest } from "./retirement-receipts.ts";
import { automaticCleanupTurn } from "./cleanup-inbox.ts";
import { assertExternalResourceProofs } from "./external-cleanup-authority.ts";
import { CleanupSnapshot, ExternalConfirmation, PreparedExternalFinalization } from "./external-finalization-schema.ts";
export { PreparedExternalFinalization } from "./external-finalization-schema.ts";
type Context = FinalizationContext & { finalizationVersion?: 2 };
const whereFor = (input: FinalizationContext, taskId: string) => ({ runtimeSessionId: input.sessionId, source: `finalizer:${taskId}`, key: input.requestKey });

export async function externalFinalizationResult(input: Pick<Context, "authorityOnly"> & { prisma: Pick<PrismaClient, "runtimeMetadataEvent"> }, prepared: PreparedExternalFinalization, preparedRevision: number, confirmedRevision?: number, cleanup?: { operationRevision: number; operationDigest: string }) {
  const extension = await originalAdministrationReceipt(input.prisma, prepared, preparedRevision);
  if (input.authorityOnly && !confirmedRevision && prepared.originalWork && !prepared.originalWork.administration && !extension) throw new Error("Original administration requires a full preparation supplement before retirement");
  return { ...(extension ? { originalWorkAdministration: extension } : {}), version: 2 as const, requestKey: prepared.requestKey, taskId: prepared.taskId, sessionId: prepared.sessionId, preparedRevision,
    ...(confirmedRevision ? { confirmedRevision } : {}), ...(cleanup ? { cleanup } : {}), worktree: prepared.worktree, revision: prepared.revision, branch: prepared.branch, gitDirectory: prepared.gitDirectory, gitCwd: prepared.gitCwd,
    contractRevision: prepared.contractRevision, bindingRevision: prepared.bindingRevision, bindingDigest: prepared.bindingDigest,
    delivery: prepared.delivery, ...(prepared.originalWork ? { originalWork: prepared.originalWork } : {}), ...(prepared.deliveredRetirement ? { deliveredRetirement: prepared.deliveredRetirement } : {}), resources: prepared.resources, resourcePlanDigest: prepared.resourcePlanDigest, doneHandoff: prepared.doneHandoff };
}

async function loadExternalBinding(input: Context) {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  if (!task) throw new Error("External finalization requires the task's original primary");
  if (input.requestKey !== `finalize:${task.id}`) throw new Error("External finalization requires the task's stable finalize requestKey");
  const event = await latestExternalBinding(input.prisma, task.id, input.sessionId);
  if (!event) throw new Error("External finalization requires an adopted delivery binding");
  const binding = ExternalBinding.parse(JSON.parse(event.value!));
  const authority = await assertExternalBindingAuthority(input.prisma, input.config, binding, event.sequence);
  if (!input.cleanup && !await hasPreparedCleanup(input.prisma, task.id, input.sessionId, input.requestKey) && authority.task.phase !== "complete") throw new Error("External finalization requires the complete task");
  return { task: authority.task, binding, revision: event.sequence };
}

async function sourceAuthority(input: Context, taskId: string, dependencies: ExternalDependencies) {
  const source = await dependencies.source(input);
  const adopted = await latestExternalBinding(input.prisma, taskId, input.sessionId);
  const binding = adopted && ExternalBinding.parse(JSON.parse(adopted.value!));
  if (binding?.version === 2) {
    if (source.issue.id !== binding.acceptance.issueId || source.issue.state.name !== "Done" || source.issue.state.type !== "completed" || source.issue.state.id !== binding.acceptance.stateId || source.link.connectionId !== binding.identity.connectionId || source.session.id !== binding.identity.sessionId) throw new Error("Present-day delivered retirement requires its current exact Done source");
    await assertExternalBindingAuthority(input.prisma, input.config, binding, adopted!.sequence);
    return source;
  }
  if (source.issue.state.name === "Merge") return source;
  if (source.issue.state.name === "Done") {
    const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...whereFor(input, taskId), action: FINALIZATION_CONFIRMED } });
    const update = await input.prisma.runtimeIssueUpdate.findUnique({ where: { runtimeSessionId_requestKey: { runtimeSessionId: input.sessionId, requestKey: `${input.requestKey}:done` } } });
    // Linear may have applied Done before its response or the local publication
    // transaction was acknowledged. Only reconcile this frozen handoff: a bare
    // Done state or a model-authored resource can never authorize fresh cleanup.
    if (confirmed && update?.commentPosted && update.connectionId === source.link.connectionId && update.issueId === source.issue.id) {
      const confirmation = ExternalConfirmation.parse(JSON.parse(confirmed.value!));
      const preparation = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: confirmation.preparedRevision } });
      const prepared = PreparedExternalFinalization.parse(JSON.parse(preparation.value!));
      if (preparation.action !== FINALIZATION_PREPARED || preparation.source !== confirmed.source || preparation.runtimeSessionId !== input.sessionId || preparation.key !== input.requestKey || prepared.taskId !== taskId || prepared.sessionId !== input.sessionId || prepared.requestKey !== input.requestKey || prepared.issueId !== source.issue.id || prepared.connectionId !== source.link.connectionId) throw new Error("Done reconciliation has no matching frozen finalization identity");
      const payload = z.object({ requestKey: z.string(), body: z.string(), state: z.literal("Done"), expectedState: z.literal("Merge"), evidence: z.array(z.never()).length(0) }).strict().parse(update.input);
      if (finalizationDigest(payload) !== finalizationDigest({ ...prepared.doneHandoff, evidence: [] }) || !Array.isArray(update.evidence) || update.evidence.length !== 0) throw new Error("Done reconciliation must use the exact frozen handoff payload");
      const comment = await dependencies.handoffComment(source.config.linearApiKey, update.id);
      if (comment?.id !== update.id || comment.issue?.id !== prepared.issueId || comment.body !== prepared.doneHandoff.body) throw new Error("Done reconciliation requires the exact posted handoff comment");
      await assertExternalResourceProofs(input.prisma, prepared, preparation.sequence, confirmed.value);
      // Callers still validate live binding/owner authority, every retained
      // resource and physical absence before returning the confirmed receipt.
      return source;
    }
  }
  throw new Error("External finalization requires current owner Merge authority");
}

async function preparedAuthority(input: Context, prepared: PreparedExternalFinalization, binding: ExternalBinding) {
  const current = await assertExternalBindingAuthority(input.prisma, input.config, binding, prepared.bindingRevision);
  const expectedBranch = binding.version === 2 ? binding.cleanupSnapshot.branch : current.task.branchName;
  if (binding.version === 2 ? finalizationDigest(prepared.deliveredRetirement) !== finalizationDigest({ kind: "present-day-owner", bindingRevision: prepared.bindingRevision, bindingDigest: binding.manifestDigest, recordedBranch: current.task.branchName, sourceStateId: binding.acceptance.stateId }) || prepared.doneHandoff.expectedState !== "Done" : prepared.deliveredRetirement !== undefined || prepared.doneHandoff.expectedState !== "Merge") throw new Error("Prepared retirement authority variant changed");
  if (current.task.phase !== "complete" || prepared.taskId !== current.task.id || prepared.sessionId !== input.sessionId || prepared.requestKey !== input.requestKey || prepared.contractRevision !== binding.contractRevision || prepared.bindingDigest !== binding.manifestDigest || prepared.resourcePlanDigest !== binding.resourcePlanDigest || finalizationDigest(prepared.resources) !== binding.resourcePlanDigest || prepared.baseCommit !== current.task.baseCommit || prepared.toolingRevision !== current.task.toolingRevision || prepared.pinnedToolingRoot !== current.task.pinnedToolingRoot || prepared.taskWorktree !== current.task.worktreePath || prepared.revision !== prepared.cleanupSnapshot.head || prepared.branch !== expectedBranch || prepared.cleanupSnapshot.branch !== prepared.branch) throw new Error("External finalization preparation identity changed");
  if (finalizationDigest(prepared.originalWork ?? null) !== finalizationDigest(binding.originalWork ?? null) || prepared.originalWork && prepared.originalWork.restore.gitDirectory !== prepared.gitDirectory || !prepared.originalWork && !prepared.cleanupSnapshot.clean) throw new Error("Original-work preservation authority changed");
  if (await realpath(getRepositoryConfig(input.config, current.task.repositoryId).root) !== prepared.gitCwd) throw new Error("Original cleanup repository identity changed");
  const observation = await input.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: prepared.delivery.observationRevision } });
  if (!observation || observation.action !== EXTERNAL_OBSERVATION || observation.runtimeSessionId !== input.sessionId || observation.source !== `observer:${prepared.taskId}` || observation.key !== prepared.requestKey) throw new Error("External finalization has no matching server observation");
  const observed = JSON.parse(observation.value!);
  if (observed.bindingRevision !== prepared.bindingRevision || observed.bindingDigest !== prepared.bindingDigest || observed.contractRevision !== prepared.contractRevision || externalDigest(observed.deliveries) !== externalDigest(prepared.delivery.deliveries)) throw new Error("External finalization observation changed");
}

async function resources(input: Context, prepared: PreparedExternalFinalization, removed: boolean, dependencies: ExternalDependencies) {
  await dependencies.assertResources({ taskId: prepared.taskId, resources: await input.prisma.remoteTaskResource.findMany({ where: { taskId: prepared.taskId } }), plan: prepared.resources, removed, ...(prepared.originalWork || prepared.deliveredRetirement ? { originalWork: true } : {}) });
  if (prepared.originalWork) await dependencies.assertOriginalWork({ taskId: prepared.taskId, originalWork: prepared.originalWork, resources: await input.prisma.remoteTaskResource.findMany({ where: { taskId: prepared.taskId } }), removed });
  if (prepared.originalWork && !prepared.originalWork.administration) {
    const event = await input.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { ...whereFor(input, prepared.taskId), action: FINALIZATION_PREPARED } });
    await ensureOriginalAdministration({ prisma: input.prisma, prepared, preparedRevision: event.sequence, removed, create: !removed, assertAuthority: async prisma => {
      const scope = { ...input, prisma };
      if (await hasPreparedCleanup(prisma, prepared.taskId, prepared.sessionId, prepared.requestKey)) await assertPreparedCleanup(scope);
      const adopted = await latestExternalBinding(prisma, prepared.taskId, prepared.sessionId);
      if (!adopted || adopted.sequence !== prepared.bindingRevision) throw new Error("Original administration binding changed");
      await assertExternalBindingAuthority(prisma, input.config, ExternalBinding.parse(JSON.parse(adopted.value!)), adopted.sequence);
      assertExternalResourceRecords(await prisma.remoteTaskResource.findMany({ where: { taskId: prepared.taskId } }), prepared.resources, removed);
    } });
  }
}


export async function prepareExternalFinalization(input: Context, dependencies = externalBindingDependencies): Promise<Awaited<ReturnType<typeof externalFinalizationResult>>> {
  if (input.finalizationVersion !== 2) throw new Error("External delivery requires finalizationVersion 2; v1 cannot authorize cleanup");
  const { task, binding, revision } = await loadExternalBinding(input);
  if (input.cleanup) await automaticCleanupTurn(input.prisma, task, false, input.runtime);
  const lifecycle = input.cleanup || await hasPreparedCleanup(input.prisma, task.id, input.sessionId, input.requestKey);
  const existing = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...whereFor(input, task.id), action: FINALIZATION_PREPARED } });
  if (lifecycle && existing) return prepareExternalCleanup(input, dependencies);
  const source = input.cleanup ? null : await sourceAuthority(input, task.id, dependencies);
  if (source && (source.issue.id !== binding.acceptance.issueId || source.link.connectionId !== task.connectionId || source.session.id !== input.sessionId)) throw new Error("External finalization source identity changed");
  const where = whereFor(input, task.id);
  const previous = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_PREPARED } });
  if (previous) {
    const prepared = PreparedExternalFinalization.parse(JSON.parse(previous.value!));
    await preparedAuthority(input, prepared, binding);
    const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
    if (input.authorityOnly) {
      if (confirmed) throw new Error("Confirmed finalization requires full replay verification");
      assertExternalResourceRecords(await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } }), prepared.resources, false);
      await preparedAuthority(input, prepared, binding);
      return externalFinalizationResult(input, prepared, previous.sequence);
    }
    await observeBoundExternalDelivery({ ...input, taskId: task.id, binding, revision, sources: false }, dependencies);
    await resources(input, prepared, Boolean(confirmed), dependencies);
    if (confirmed) { await assertExternalResourceProofs(input.prisma, prepared, previous.sequence, confirmed.value); await assertFinalizationRemoved(prepared); }
    else if (!(await worktreeIsMissing(prepared.worktree)) && externalDigest(await dependencies.snapshot(prepared.worktree)) !== externalDigest(prepared.cleanupSnapshot)) throw new Error("Original cleanup worktree changed since preparation");
    await preparedAuthority(input, prepared, binding);
    await sourceAuthority(input, task.id, dependencies);
    return externalFinalizationResult(input, prepared, previous.sequence, confirmed?.sequence);
  }
  if (input.authorityOnly) throw new Error("Authority-only checks require an existing unconfirmed preparation");
  const deliveries = await observeBoundExternalDelivery({ ...input, taskId: task.id, binding, revision, sources: true, ...(input.cleanup ? { acceptedCleanup: true as const } : {}) }, dependencies);
  await dependencies.assertResources({ taskId: task.id, resources: await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } }), plan: binding.resources, removed: false, ...(binding.originalWork || binding.version === 2 ? { originalWork: true } : {}) });
  if (binding.originalWork) await dependencies.assertOriginalWork({ taskId: task.id, originalWork: binding.originalWork, resources: await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id } }), removed: false });
  const cleanupSnapshot = CleanupSnapshot.parse(await dependencies.snapshot(task.worktreePath!));
  const worktree = await realpath(task.worktreePath!);
  const gitCwd = await realpath(getRepositoryConfig(input.config, task.repositoryId).root);
  if (worktree === gitCwd) throw new Error("External finalization may not remove the configured repository root");
  const gitDirectory = await realpath(await finalizationGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (await realpath(await finalizationGit(gitCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== gitDirectory) throw new Error("Original cleanup worktree belongs to another repository");
  const entries = finalizationWorktrees(await finalizationGit(gitCwd, ["--git-dir", gitDirectory, "worktree", "list", "--porcelain", "-z"]));
  const matching = [];
  for (const entry of entries) if (entry.worktree && await realpath(entry.worktree).catch(() => "") === worktree) matching.push(entry);
  const cleanupBranch = binding.version === 2 ? binding.cleanupSnapshot.branch : task.branchName;
  if (matching.length !== 1 || matching[0]!.HEAD !== cleanupSnapshot.head || matching[0]!.branch !== `refs/heads/${cleanupBranch}` || cleanupSnapshot.branch !== cleanupBranch) throw new Error("Original cleanup Git registration does not match the prepared identity");
  if (binding.version === 2) {
    if (externalDigest(cleanupSnapshot) !== externalDigest(binding.cleanupSnapshot)) throw new Error("Original cleanup content changed since present-day acceptance");
  } else {
    const approval = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: binding.acceptance.approvalEventSequence } });
    if (binding.originalWork ? finalizationDigest({ head: binding.originalWork.snapshot.head, branch: binding.originalWork.snapshot.branch, clean: binding.originalWork.snapshot.clean, fingerprint: binding.originalWork.snapshot.fingerprint }) !== finalizationDigest(cleanupSnapshot) : !cleanupSnapshot.clean || JSON.parse(approval.value!).snapshot.fingerprint !== cleanupSnapshot.fingerprint) throw new Error("Original cleanup content changed since owner acceptance");
  }
  const acceptance = binding.version === 2 ? "Cleanup is authorized by the present-day owner-authenticated retirement record. Required delivery checks and merge ancestry were independently observed; no historical Merge approval or original-head verification was invented. Source reporting is separate from cleanup authority." : `Acceptance: existing owner comment ${binding.acceptance.ownerCommentId}. Local verification reports remain owner-attested; CI was independently observed.`;
  const body = [`Delivered and verified:`, ...deliveries.map((delivery) => `- ${delivery.url} — reviewed head ${delivery.reviewedHead}, merged as ${delivery.mergeCommit}.`), "", `Removed the original ${task.repositoryId} task worktree (${cleanupBranch}, cleanup revision ${cleanupSnapshot.head}); the recorded task branch remains ${task.branchName}. Retired owned filesystem resources to verified retained quarantine; their original active paths are absent. Retained the linked PR and CI history.${binding.originalWork ? " Unfinished original work remains in its independently restored archive and exact whole-worktree quarantine; it is not claimed as delivered." : ""}`, "", acceptance, "Coding session is about to close."].join("\n");
  const original = { taskId: task.id, sessionId: input.sessionId, requestKey: input.requestKey, repositoryId: task.repositoryId, machineId: task.machineId,
    connectionId: task.connectionId!, issueId: binding.acceptance.issueId, issueIdentifier: task.issueIdentifier!, contractRevision: binding.contractRevision,
    worktree, taskWorktree: task.worktreePath!, registeredWorktree: matching[0]!.worktree!, revision: cleanupSnapshot.head, branch: cleanupBranch, gitDirectory, gitCwd,
    version: 2 as const, bindingRevision: revision, bindingDigest: binding.manifestDigest, resourcePlanDigest: binding.resourcePlanDigest,
    baseCommit: task.baseCommit, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, cleanupSnapshot,
    resources: binding.resources, ...(binding.originalWork ? { originalWork: binding.originalWork } : {}), ...(binding.version === 2 ? { deliveredRetirement: { kind: "present-day-owner" as const, bindingRevision: revision, bindingDigest: binding.manifestDigest, recordedBranch: task.branchName, sourceStateId: binding.acceptance.stateId } } : {}), doneHandoff: { requestKey: `${input.requestKey}:done`, body, expectedState: binding.version === 2 ? "Done" as const : "Merge" as const, state: "Done" as const } };
  if (externalDigest(await dependencies.snapshot(worktree)) !== externalDigest(cleanupSnapshot)) throw new Error("Original cleanup worktree changed during preparation");
  if (!input.cleanup) await sourceAuthority(input, task.id, dependencies);
  const result = await input.prisma.$transaction(async (tx) => {
    await assertExternalBindingAuthority(tx, input.config, binding, revision);
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_PREPARED } });
    if (prior) throw new Error("Finalization was prepared concurrently; retry the same requestKey");
    assertExternalResourceRecords(await tx.remoteTaskResource.findMany({ where: { taskId: task.id } }), binding.resources, false);
    const observed = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: input.sessionId, action: EXTERNAL_OBSERVATION, source: `observer:${task.id}`, key: input.requestKey,
      value: JSON.stringify({ bindingRevision: revision, bindingDigest: binding.manifestDigest, contractRevision: binding.contractRevision, deliveries }) } });
    const prepared = PreparedExternalFinalization.parse({ ...original, delivery: { kind: "external-merges/v1", observationRevision: observed.sequence, deliveries } });
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where, action: FINALIZATION_PREPARED, value: JSON.stringify(prepared) } });
    return externalFinalizationResult({ ...input, prisma: tx }, prepared, event.sequence);
  });
  return input.cleanup ? prepareExternalCleanup(input, dependencies) : binding.originalWork && !binding.originalWork.administration ? prepareExternalFinalization(input, dependencies) : result;
}

function cleanupReference(input: Context, active: Awaited<ReturnType<typeof assertPreparedCleanup>>) {
  return input.cleanup ? { operationRevision: active.operationRevision, operationDigest: retirementDigest(active.operation) } : undefined;
}

/** Full boundaries still observe providers, preserved bytes and exact physical
 * targets. A native batch requests authorityOnly and reads the same local epoch
 * used by v1 cleanup; source status is never a recurring authorization gate. */
async function prepareExternalCleanup(input: Context, dependencies: ExternalDependencies) {
  if (!input.authorityOnly) {
    const observe = async () => {
      const candidate = await inspectPreparedCleanupAuthority(input);
      if (candidate.kind !== "v2") throw new Error("External cleanup requires its exact v2 preparation");
      const { binding, revision } = await loadExternalBinding({ ...input, cleanup: true });
      await observeBoundExternalDelivery({ ...input, taskId: candidate.task.id, binding, revision, sources: false, acceptedCleanup: true }, dependencies);
      const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...whereFor(input, candidate.task.id), action: FINALIZATION_CONFIRMED } });
      await resources(input, candidate.prepared, Boolean(confirmed), dependencies);
      if (confirmed) await assertFinalizationRemoved(candidate.prepared);
      else if (!await worktreeIsMissing(candidate.prepared.worktree)
        && externalDigest(await dependencies.snapshot(candidate.prepared.worktree)) !== externalDigest(candidate.prepared.cleanupSnapshot)) throw new Error("Original cleanup worktree changed since preparation");
    };
    const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
    if (await hasPreparedCleanup(input.prisma, task.id, input.sessionId, input.requestKey)) {
      await assertPreparedCleanup(input);
      await observe();
    } else await bindPreparedCleanup(input, observe);
  }
  const active = await assertPreparedCleanup(input);
  if (active.kind !== "v2") throw new Error("External cleanup requires its exact v2 preparation");
  const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...whereFor(input, active.task.id), action: FINALIZATION_CONFIRMED } });
  return externalFinalizationResult(input, active.prepared, active.preparation.sequence, confirmed?.sequence, cleanupReference(input, active));
}

async function confirmExternalCleanup(input: Context, dependencies: ExternalDependencies) {
  const active = await assertPreparedCleanup(input);
  if (active.kind !== "v2") throw new Error("External cleanup requires its exact v2 preparation");
  const { task, binding, revision } = await loadExternalBinding({ ...input, cleanup: true });
  await observeBoundExternalDelivery({ ...input, taskId: task.id, binding, revision, sources: false, acceptedCleanup: true }, dependencies);
  await resources(input, active.prepared, true, dependencies);
  await assertFinalizationRemoved(active.prepared);
  return input.prisma.$transaction(async tx => {
    const current = await assertPreparedCleanup({ ...input, prisma: tx });
    if (current.kind !== "v2") throw new Error("External cleanup authority variant changed");
    assertExternalResourceRecords(await tx.remoteTaskResource.findMany({ where: { taskId: task.id } }), current.prepared.resources, true);
    const where = whereFor(input, task.id);
    let confirmed = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
    if (confirmed) await assertExternalResourceProofs(tx, current.prepared, current.preparation.sequence, confirmed.value);
    else {
      const proofs = [];
      for (const resource of current.prepared.resources) {
        const proof = await tx.runtimeMetadataEvent.create({ data: { ...where, action: "finalization-resource-proof", key: `${current.preparation.sequence}:${resource.id}:${resource.disposition}`,
          value: JSON.stringify({ preparedRevision: current.preparation.sequence, resourceId: resource.id, identityDigest: resource.identityDigest, disposition: resource.disposition }) } });
        proofs.push(proof.sequence);
      }
      confirmed = await tx.runtimeMetadataEvent.create({ data: { ...where, action: FINALIZATION_CONFIRMED, value: JSON.stringify({ version: 2, preparedRevision: current.preparation.sequence, resourceProofs: proofs, ...await administrationConfirmation(tx, current.prepared, current.preparation.sequence) }) } });
    }
    await queueCleanupReport(tx, current, confirmed.sequence);
    return externalFinalizationResult({ ...input, prisma: tx }, current.prepared, current.preparation.sequence, confirmed.sequence, cleanupReference(input, current));
  });
}

export async function confirmExternalFinalization(input: Context, dependencies = externalBindingDependencies) {
  if (input.finalizationVersion !== 2) throw new Error("External delivery requires finalizationVersion 2; v1 cannot confirm cleanup");
  if (input.authorityOnly) throw new Error("Authority-only checks cannot confirm finalization");
  const owned = await input.prisma.remoteTask.findUniqueOrThrow({ where: { primarySessionId: input.sessionId } });
  if (input.cleanup || await hasPreparedCleanup(input.prisma, owned.id, input.sessionId, input.requestKey)) return confirmExternalCleanup(input, dependencies);
  const { task, binding, revision } = await loadExternalBinding(input);
  const source = await sourceAuthority(input, task.id, dependencies);
  const where = whereFor(input, task.id);
  const event = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_PREPARED } });
  if (!event) throw new Error("External finalization was not prepared");
  const prepared = PreparedExternalFinalization.parse(JSON.parse(event.value!));
  if (prepared.issueId !== source.issue.id || prepared.connectionId !== source.link.connectionId) throw new Error("External finalization source identity changed");
  await preparedAuthority(input, prepared, binding);
  await observeBoundExternalDelivery({ ...input, taskId: task.id, binding, revision, sources: false }, dependencies);
  await resources(input, prepared, true, dependencies);
  await assertFinalizationRemoved(prepared);
  await sourceAuthority(input, task.id, dependencies);
  return input.prisma.$transaction(async (tx) => {
    await assertExternalBindingAuthority(tx, input.config, binding, revision);
    assertExternalResourceRecords(await tx.remoteTaskResource.findMany({ where: { taskId: task.id } }), prepared.resources, true);
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: FINALIZATION_CONFIRMED } });
    if (prior) {
      await assertExternalResourceProofs(tx, prepared, event.sequence, prior.value);
      return externalFinalizationResult({ ...input, prisma: tx }, prepared, event.sequence, prior.sequence);
    }
    const proofs = [];
    for (const resource of prepared.resources) {
      const proof = await tx.runtimeMetadataEvent.create({ data: { ...where, action: "finalization-resource-proof", key: `${event.sequence}:${resource.id}:${resource.disposition}`,
        value: JSON.stringify({ preparedRevision: event.sequence, resourceId: resource.id, identityDigest: resource.identityDigest, disposition: resource.disposition }) } });
      proofs.push(proof.sequence);
    }
    const receipt = await tx.runtimeMetadataEvent.create({ data: { ...where, action: FINALIZATION_CONFIRMED, value: JSON.stringify({ version: 2, preparedRevision: event.sequence, resourceProofs: proofs, ...await administrationConfirmation(tx, prepared, event.sequence) }) } });
    return externalFinalizationResult({ ...input, prisma: tx }, prepared, event.sequence, receipt.sequence);
  });
}

/** The terminal issue gate consumes only a confirmed v2 handoff. No aggregate
 * merge SHA is invented for the unrelated original cleanup repository. */
export async function assertExternalDoneAllowed(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string; requestKey?: string; body?: string; state?: string; expectedState?: string }, dependencies = externalBindingDependencies) {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  if (!task) throw new Error("External Done requires the original primary");
  const confirmed = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED }, orderBy: { sequence: "desc" } });
  if (!confirmed) throw new Error("External Done requires confirmed cleanup");
  const parsed = ExternalConfirmation.parse(JSON.parse(confirmed.value!));
  const preparation = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: parsed.preparedRevision } });
  const prepared = PreparedExternalFinalization.parse(JSON.parse(preparation.value!));
  if (preparation.action !== FINALIZATION_PREPARED || preparation.source !== confirmed.source || preparation.runtimeSessionId !== input.sessionId || preparation.key !== confirmed.key || prepared.taskId !== task.id || prepared.sessionId !== input.sessionId || prepared.requestKey !== confirmed.key) throw new Error("External Done receipt identity mismatch");
  if (input.requestKey !== prepared.doneHandoff.requestKey || input.body !== prepared.doneHandoff.body || input.state !== "Done" || input.expectedState !== prepared.doneHandoff.expectedState) throw new Error("External Done must use the immutable prepared handoff");
  await confirmExternalFinalization({ ...input, requestKey: prepared.requestKey, finalizationVersion: 2 }, dependencies);
}

/** A read-only projection usable after session closure. Only exact confirmed
 * entries survive, never a global exemption for PR/CI resource kinds. */
export async function externalFinalizationProjection(prisma: PrismaClient, task: { id: string; primarySessionId: string | null; resources?: Array<Parameters<typeof finalizationResourceIdentity>[0]> }): Promise<{
  finalizationVersion?: 2;
  finalizationRetention?: { requestKey: string; taskId: string; sessionId: string; preparedRevision: number; confirmedRevision: number; resourcePlanDigest: string; resources: Array<Extract<FinalizationResourcePlan, { disposition: "retain-reference" | "retain-archive" | "retain-result" | "retain-archive-member" | "retain-adapter" | "retain-backed" }>> };
}> {
  if (!task.primarySessionId) return {};
  const binding = await latestExternalBinding(prisma, task.id, task.primarySessionId);
  if (!binding) return {};
  const hint = { finalizationVersion: 2 as const };
  const confirmed = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: FINALIZATION_CONFIRMED }, orderBy: { sequence: "desc" } });
  if (!confirmed) return hint;
  try {
    const adopted = ExternalBinding.parse(JSON.parse(binding.value!));
    const data = ExternalConfirmation.parse(JSON.parse(confirmed.value!));
    const preparation = await prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: data.preparedRevision } });
    const prepared = PreparedExternalFinalization.parse(JSON.parse(preparation.value!));
    if (preparation.action !== FINALIZATION_PREPARED || preparation.source !== confirmed.source || preparation.runtimeSessionId !== task.primarySessionId || preparation.key !== confirmed.key || prepared.taskId !== task.id || prepared.sessionId !== task.primarySessionId || prepared.requestKey !== confirmed.key || prepared.bindingRevision !== binding.sequence || prepared.bindingDigest !== adopted.manifestDigest || prepared.resourcePlanDigest !== adopted.resourcePlanDigest || finalizationDigest(prepared.resources) !== prepared.resourcePlanDigest || finalizationDigest(adopted.resources) !== prepared.resourcePlanDigest || finalizationDigest(prepared.originalWork ?? null) !== finalizationDigest(adopted.originalWork ?? null)) return hint;
    const records = task.resources ?? await prisma.remoteTaskResource.findMany({ where: { taskId: task.id } });
    const relevant = records;
    assertExternalResourceRecords(relevant, prepared.resources, true);
    if (relevant.length !== records.length || relevant.length !== prepared.resources.length || prepared.resources.some((entry) => !relevant.some((record) => record.id === entry.id && finalizationResourceIdentity(record).identityDigest === entry.identityDigest && (entry.disposition.startsWith("retain-") ? record.state !== "released" : record.state === "released")))) return hint;
    await assertExternalResourceProofs(prisma, prepared, preparation.sequence, confirmed.value);
    return { ...hint, finalizationRetention: { requestKey: prepared.requestKey, taskId: task.id, sessionId: task.primarySessionId, preparedRevision: preparation.sequence, confirmedRevision: confirmed.sequence, resourcePlanDigest: prepared.resourcePlanDigest, resources: prepared.resources.filter((entry) => entry.disposition === "retain-reference" || entry.disposition === "retain-archive" || entry.disposition === "retain-result" || entry.disposition === "retain-archive-member" || entry.disposition === "retain-adapter" || entry.disposition === "retain-backed") } };
  } catch { return hint; }
}

async function administrationConfirmation(prisma: Pick<PrismaClient, "runtimeMetadataEvent">, prepared: PreparedExternalFinalization, revision: number) {
  const receipt = await originalAdministrationReceipt(prisma, prepared, revision);
  return receipt ? { originalWorkAdministration: { revision: receipt.revision, digest: receipt.digest } } : {};
}
