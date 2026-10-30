import { hasCleanupAdapter } from "./cleanup-adapter-resources.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { completionObservation } from "./completion-observation.ts";
import { assertExternalBindingAuthority, assertExternalResourceRecords, externalBindingDependencies, externalOwnerHistory, externalTaskOwnership, latestExternalBinding } from "./external-deliveries.ts";
import { EXTERNAL_BINDING, ExternalBinding, DeliveredRetirementBinding, DeliveredRetirementInput, externalDigest } from "./external-delivery-schema.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { originalWorkRetainedPlans } from "./original-work.ts";

type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string };
export const legacyDeliveryDependencies = { ...externalBindingDependencies, repository: completionObservation.repository };
type Dependencies = typeof legacyDeliveryDependencies;

async function ownership(input: Context) {
  const current = await externalTaskOwnership(input.prisma, input.config, input.taskId);
  if (!current.task.pinnedToolingRoot || !["waiting", "blocked", "complete"].includes(current.task.phase)) throw new Error("Delivered retirement requires the interrupted or complete original task and immutable tooling pin");
  const resources = await input.prisma.remoteTaskResource.findMany({ where: { taskId: input.taskId }, orderBy: { id: "asc" } });
  const ownerHistoryRevision = await externalOwnerHistory(input.prisma, input.taskId, current.session.id);
  const identityDigest = externalDigest({ identity: current.identity, ownerHistoryRevision, resources: resources.map(finalizationResourceIdentity) });
  return { ...current, resources, ownerHistoryRevision, identityDigest };
}

async function source(input: Context, current: Awaited<ReturnType<typeof ownership>>, dependencies: Dependencies) {
  const value = await dependencies.source({ ...input, sessionId: current.session.id });
  if (value.session.id !== current.session.id || value.issue.identifier !== current.identity.issueIdentifier || value.link.connectionId !== current.identity.connectionId || value.issue.state.name !== "Done" || value.issue.state.type !== "completed") throw new Error("Delivered retirement requires the exact current Done source");
  return DeliveredRetirementInput.shape.source.parse({ issueId: value.issue.id, stateId: value.issue.state.id, updatedAt: value.issue.updatedAt });
}

export async function inspectLegacyDelivery(input: Context, dependencies = legacyDeliveryDependencies) {
  const current = await ownership(input);
  const prior = await latestExternalBinding(input.prisma, input.taskId, current.session.id);
  return { taskId: input.taskId, sessionId: current.session.id, revision: prior?.sequence ?? 0, identity: current.identity, identityDigest: current.identityDigest,
    source: await source(input, current, dependencies), cleanupSnapshot: await dependencies.snapshot(current.identity.taskWorktree),
    resources: current.resources.map(finalizationResourceIdentity), ...(prior ? { saved: ExternalBinding.parse(JSON.parse(prior.value!)).input } : {}) };
}

/** Authenticated present-day acceptance, explicitly distinct from historical
 * Merge workflow approval. The original unmerged head is never called shipped. */
export async function adoptLegacyDelivery(input: Context & { retirement: DeliveredRetirementInput }, dependencies = legacyDeliveryDependencies) {
  const request = DeliveredRetirementInput.parse(input.retirement), current = await ownership(input);
  const where = { runtimeSessionId: current.session.id, source: `owner:${input.taskId}`, action: EXTERNAL_BINDING };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, key: request.requestKey } });
  if (prior) {
    const binding = DeliveredRetirementBinding.parse(JSON.parse(prior.value!));
    if (externalDigest(binding.input) !== externalDigest(request)) throw new Error("Delivered retirement requestKey belongs to another decision");
    await assertExternalBindingAuthority(input.prisma, input.config, binding, prior.sequence);
    const observed = await source(input, current, dependencies);
    if (observed.issueId !== binding.acceptance.issueId || observed.stateId !== binding.acceptance.stateId) throw new Error("Delivered retirement source changed");
    return { revision: prior.sequence, binding };
  }
  const latest = await latestExternalBinding(input.prisma, input.taskId, current.session.id);
  if ((latest?.sequence ?? 0) !== request.expectedBindingRevision || current.identityDigest !== request.expectedIdentityDigest) throw new Error("Delivered retirement ownership or resources changed; inspect again");
  if (await input.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: current.session.id, source: `finalizer:${input.taskId}`, action: "finalization-prepared" } })) throw new Error("Existing preparations require their additive Done supplement");
  if (externalDigest(await source(input, current, dependencies)) !== externalDigest(request.source)) throw new Error("Delivered retirement source version changed");
  const cleanup = await dependencies.snapshot(current.identity.taskWorktree);
  if (externalDigest(cleanup) !== externalDigest(request.cleanupSnapshot)) throw new Error("Original cleanup checkout changed since inspection");
  if (JSON.stringify(current.resources.map(r => r.id).sort()) !== JSON.stringify([...request.resourceIds].sort())) throw new Error("Delivered retirement must bind every exact task resource");
  const repository = await dependencies.repository(current.identity.taskWorktree);
  if (request.deliveries.some(delivery => delivery.repository !== repository.repository)) throw new Error("Delivered scope belongs to another original repository");
  const deliveries: Awaited<ReturnType<Dependencies["delivered"]>>[] = [];
  for (const id of request.mergeOrder) deliveries.push(await dependencies.delivered(request.deliveries.find(delivery => delivery.id === id)!));
  if (deliveries.some((delivery, index) => index && Date.parse(deliveries[index - 1]!.mergedAt) > Date.parse(delivery.mergedAt))) throw new Error("Delivered scope merge order changed");
  if (!request.originalWork && !request.deliveries.some(delivery => cleanup.clean && (cleanup.head === delivery.expectedMergeCommit && cleanup.branch === delivery.baseBranch || cleanup.head === delivery.reviewedHead && cleanup.branch === delivery.branch && cleanup.branch === current.identity.branch))) throw new Error("Clean original checkout is not the exact accepted PR head or merge/base correspondence");
  if (request.originalWork && cleanup.branch !== current.identity.branch) throw new Error("Archived original work no longer has its recorded task branch");
  const originalWork = request.originalWork ? await dependencies.originalWork({ taskId: input.taskId, toolingRevision: current.identity.toolingRevision, worktree: current.identity.taskWorktree,
    branch: current.identity.branch, approvedHead: cleanup.head, resources: current.resources, originalWork: request.originalWork }) : undefined;
  const retainedArchives = originalWork ? originalWorkRetainedPlans(originalWork, current.resources) : [];
  const adapterContext = current.resources.some(resource => resource.state !== "released" && hasCleanupAdapter(resource.kind))
    ? { capability: await dependencies.cleanupObserver({ task: current.task, config: input.config }), task: { id: current.task.id, primarySessionId: current.session.id, worktreePath: current.identity.taskWorktree, toolingRevision: current.identity.toolingRevision } } : undefined;
  const plan = await dependencies.resources({ resources: current.resources, taskId: input.taskId, sessionId: current.session.id, toolingRoot: current.task.pinnedToolingRoot!, sourcePaths: [], deliveries,
    ownership: request.ownership, originalWork: true, ...(adapterContext ? { adapterContext } : {}), retainedArchives });
  await dependencies.assertResources({ taskId: input.taskId, resources: current.resources, plan, removed: false, originalWork: true });
  if (originalWork) await dependencies.assertOriginalWork({ taskId: input.taskId, originalWork, resources: current.resources, removed: false });
  if (externalDigest(await dependencies.snapshot(current.identity.taskWorktree)) !== externalDigest(cleanup) || externalDigest(await source(input, current, dependencies)) !== externalDigest(request.source)) throw new Error("Original source or owner decision changed during retirement observation");
  const binding = DeliveredRetirementBinding.parse({ version: 2, input: request, identity: current.identity, contractRevision: null, contractDigest: null, verificationRevision: null,
    manifestDigest: externalDigest(request), acceptance: { kind: "present-day-owner", issueId: request.source.issueId, stateId: request.source.stateId, sourceUpdatedAt: request.source.updatedAt, basis: request.basis, createdAt: new Date().toISOString() },
    ownerHistoryRevision: current.ownerHistoryRevision, cleanupSnapshot: cleanup, deliveries, resources: plan, resourcePlanDigest: finalizationDigest(plan), ...(originalWork ? { originalWork } : {}) });
  return input.prisma.$transaction(async tx => {
    const live = await externalTaskOwnership(tx, input.config, input.taskId);
    if (externalDigest(live.identity) !== externalDigest(current.identity) || live.task.phase !== current.task.phase || await externalOwnerHistory(tx, input.taskId, current.session.id) !== current.ownerHistoryRevision || ((await latestExternalBinding(tx, input.taskId, current.session.id))?.sequence ?? 0) !== request.expectedBindingRevision) throw new Error("Delivered retirement authority changed during adoption");
    if (await tx.runtimeMetadataEvent.count({ where: { runtimeSessionId: current.session.id, source: `finalizer:${input.taskId}`, action: "finalization-prepared" } })) throw new Error("Finalization was prepared concurrently");
    assertExternalResourceRecords(await tx.remoteTaskResource.findMany({ where: { taskId: input.taskId } }), plan, false);
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where, key: request.requestKey, value: JSON.stringify(binding) } });
    await tx.remoteTask.update({ where: { id: input.taskId }, data: { phase: "complete" } });
    return { revision: event.sequence, binding };
  });
}
