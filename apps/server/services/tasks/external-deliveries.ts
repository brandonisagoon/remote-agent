import { hasCleanupAdapter, hasHistoricalCleanupAdapter } from "./cleanup-adapter-resources.ts";
import { resolveCleanupObserver } from "./cleanup-resource-observer.ts";
import { prepareOriginalWork, assertOriginalWork, originalWorkRetainedPlans } from "./original-work.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { fetchIssueCommentIdentity, fetchQualifiedIssueComment } from "../../integrations/linear/comments.ts";
import { linkedSourceIssue } from "../sessions/questions.ts";
import { CompletionContractInput } from "./completion.ts";
import { observeReadonlyCompletionSnapshot } from "./completion-observation.ts";
import { EXTERNAL_BINDING, EXTERNAL_OBSERVATION, ExternalBinding, ExternalDeliveryBindingInput, ExternalTaskIdentity, externalDigest } from "./external-delivery-schema.ts";
import { externalDeliveryObservation, observeExternalDeliveries } from "./external-delivery-observation.ts";
import { observeDeliveredScope } from "./delivered-retirement-observation.ts";
import { assertFinalizationResources, assertFinalizationPlanPurposes, finalizationDigest, finalizationResourceIdentity, prepareFinalizationResources, type FinalizationResourcePlan, type FinalizationResourceRecord } from "./finalization-resources.ts";

export type ExternalDatabase = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeMetadataEvent" | "runtimeSessionResourceLink" | "remoteTaskResource"> & Partial<Pick<PrismaClient, "runtimeInstruction">>;
type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string };
export const externalBindingDependencies = { source: linkedSourceIssue, comment: fetchQualifiedIssueComment, observer: externalDeliveryObservation,
  delivered: observeDeliveredScope, cleanupObserver: resolveCleanupObserver,
  handoffComment: fetchIssueCommentIdentity, snapshot: observeReadonlyCompletionSnapshot, resources: prepareFinalizationResources, assertResources: assertFinalizationResources, originalWork: prepareOriginalWork, assertOriginalWork };
export type ExternalDependencies = typeof externalBindingDependencies;

/** Transaction-time CAS uses only registry identity/state. Expensive filesystem
 * and provider observations finish before acquiring the database write lock. */
export function assertExternalResourceRecords(records: FinalizationResourceRecord[], plan: FinalizationResourcePlan[], removed: boolean) {
  const resources = records;
  assertFinalizationPlanPurposes(resources, plan);
  if (resources.length !== records.length || resources.length !== plan.length) throw new Error("External finalization resource set changed");
  for (const entry of plan) {
    const record = resources.find((item) => item.id === entry.id);
    if (!record || finalizationResourceIdentity(record).identityDigest !== entry.identityDigest || entry.disposition.startsWith("retain-") && record.state === "released" || (entry.disposition === "retain-adapter" || entry.disposition === "retain-backed") && record.state !== "ready" || entry.disposition === "already-released" && record.state !== "released" || removed && entry.disposition.startsWith("retire-") && record.state !== "released") throw new Error("External finalization resource identity or state changed");
  }
}

export async function externalTaskOwnership(prisma: ExternalDatabase, config: ServerConfig, taskId: string, options: { allowConfirmedClosed?: boolean } = {}) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const session = task.primarySessionId && await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!session || session.role !== "primary" || !options.allowConfirmedClosed && (session.status === "closed" || task.phase === "closed") || task.ownerPaused || !task.worktreePath || !task.connectionId || !task.issueIdentifier || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || task.machineId !== config.machine) throw new Error("External delivery requires the open original primary and unchanged task ownership");
  getRepositoryConfig(config, task.repositoryId);
  const closed = session.status === "closed" || task.phase === "closed";
  const link = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", ...(options.allowConfirmedClosed && closed ? {} : { endedAt: null }) } });
  if (!link) throw new Error("External delivery source ownership changed");
  const identity = ExternalTaskIdentity.parse({ taskId: task.id, sessionId: session.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, taskWorktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot });
  return { task, session, identity };
}
export async function externalTaskAuthority(prisma: ExternalDatabase, config: ServerConfig, taskId: string, options: { allowConfirmedClosed?: boolean } = {}) {
  const { task, session, identity } = await externalTaskOwnership(prisma, config, taskId, options);
  const where = { runtimeSessionId: session.id, source: `owner:${task.id}` };
  const contractEvent = await prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  if (!contractEvent) throw new Error("External delivery has no owner completion contract");
  const contract = CompletionContractInput.parse(JSON.parse(contractEvent.value!));
  if (contract.boundary !== "merge") throw new Error("External delivery completion authority was revoked or replaced");
  const verification = await prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "completion-verification" }, orderBy: { sequence: "desc" } });
  if (!verification || JSON.parse(verification.value ?? "null")?.verification?.passed !== true) throw new Error("External delivery verification was revoked or is missing");
  const binding = await prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: EXTERNAL_BINDING }, orderBy: { sequence: "desc" } });
  return { task, session, identity, contract, contractEvent, verification, binding };
}

export async function latestExternalBinding(prisma: Pick<PrismaClient, "runtimeMetadataEvent">, taskId: string, sessionId: string) {
  return prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, action: EXTERNAL_BINDING, source: `owner:${taskId}` }, orderBy: { sequence: "desc" } });
}

async function approvalLineage(input: Context, sessionId: string, sequence: number) {
  const event = await input.prisma.runtimeMetadataEvent.findUnique({ where: { sequence } });
  if (!event || event.action !== "completion-owner-approval" || event.source !== `owner:${input.taskId}` || event.runtimeSessionId !== sessionId) throw new Error("Acceptance is not this task's server-owned approval event");
  const approval = z.object({ requestKey: z.string(), actorId: z.string(), organizationId: z.string().nullable(), issueId: z.string(), issueIdentifier: z.string(),
    receiptId: z.string(), deliveryId: z.string(), connectionId: z.string(), runId: z.string(), workflowId: z.string(), contractRevision: z.number().int(),
    snapshot: z.object({ head: z.string(), branch: z.string(), clean: z.boolean(), fingerprint: z.string() }), webhookTimestamp: z.number().finite() }).passthrough().parse(JSON.parse(event.value!));
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const config = scopeConfig(input.config, { repositoryId: task.repositoryId, connectionId: task.connectionId! });
  const run = await input.prisma.workerRun.findUnique({ where: { id: approval.runId }, include: { receipt: true } });
  const receipt = run?.receipt;
  const workflow = config.repository.workflows[approval.workflowId];
  const subscribed = approval.actorId !== config.agentUserId && config.webhooks[config.activeWebhookId]?.repositoryRouting[task.repositoryId]?.when?.some((condition) => condition["linear.userId"]?.includes(approval.actorId));
  if (!subscribed || !receipt || receipt.status !== "accepted" || receipt.id !== approval.receiptId || receipt.deliveryId !== approval.deliveryId || run?.workerKey !== `product.workflow:${approval.workflowId}` || receipt.provider !== "linear" || receipt.eventType !== "issue" || receipt.webhookId !== config.activeWebhookId || receipt.repositoryId !== task.repositoryId || receipt.connectionId !== task.connectionId || approval.connectionId !== task.connectionId || receipt.resourceId !== task.issueIdentifier || approval.issueIdentifier !== task.issueIdentifier || !receipt.trigger?.split(",").includes(approval.workflowId) || workflow?.on !== "issue.state-changed" || !workflow.when?.some((condition) => condition["issue.state"]?.includes("Merge"))) throw new Error("Acceptance approval is not backed by this owner's accepted workflow lineage");
  const original = await input.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: approval.contractRevision } });
  const verification = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, action: "completion-verification", source: event.source, key: approval.requestKey } });
  const originalContract = original && CompletionContractInput.parse(JSON.parse(original.value!));
  const verificationValue = verification && JSON.parse(verification.value!);
  if (!original || original.action !== "completion-contract" || original.source !== event.source || original.runtimeSessionId !== sessionId || original.key !== approval.requestKey || originalContract?.boundary !== "merge" || event.key !== approval.requestKey || verificationValue?.contractRevision !== approval.contractRevision || verificationValue?.verification?.passed !== true || externalDigest(verificationValue.provenance) !== externalDigest(JSON.parse(event.value!))) throw new Error("Acceptance approval and its original contract/verification lineage disagree");
  return { event, approval, config };
}

export async function assertExternalBindingAuthority(prisma: ExternalDatabase, config: ServerConfig, binding: ExternalBinding, revision: number, options: { allowConfirmedClosed?: boolean } = {}) {
  const { assertPreservationSources } = await import("./cleanup-preservation.ts");
  await assertPreservationSources(prisma, binding.identity.taskId, binding.identity.sessionId, binding.resources);
  const { assertRegisteredCaptureSharing } = await import("./cleanup-filesystem.ts");
  await assertRegisteredCaptureSharing(prisma, binding.identity.taskId, binding.resources);
  // Historical approvals must also honor a later explicit revocation. The
  // present-day branch below binds the complete owner-history revision.
  if (binding.version === 1 && await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: binding.identity.sessionId, source: `owner:${binding.identity.taskId}`, action: "delivered-retirement-revoked", sequence: { gt: revision } } })) throw new Error("External cleanup was explicitly revoked after this binding");
  if (binding.version === 2) {
    const current = await externalTaskOwnership(prisma, config, binding.identity.taskId, options);
    const event = await latestExternalBinding(prisma, current.task.id, current.session.id);
    if (externalDigest(current.identity) !== externalDigest(binding.identity) || event?.sequence !== revision || event.value !== JSON.stringify(binding) || await externalOwnerHistory(prisma, current.task.id, current.session.id) !== binding.ownerHistoryRevision) throw new Error("Present-day retirement task, binding or owner authority changed");
    return { ...current, contract: null };
  }
  const current = await externalTaskAuthority(prisma, config, binding.identity.taskId, options);
  if (externalDigest(current.identity) !== externalDigest(binding.identity) || current.contractEvent.sequence !== binding.contractRevision || externalDigest(current.contract) !== binding.contractDigest || current.verification.sequence !== binding.verificationRevision || current.binding?.sequence !== revision || current.binding.value !== JSON.stringify(binding)) throw new Error("External delivery task, binding, contract or verification authority changed");
  const approval = await prisma.runtimeMetadataEvent.findUnique({ where: { sequence: binding.acceptance.approvalEventSequence } });
  if (!approval || externalDigest(JSON.parse(approval.value!)) !== binding.acceptance.approvalDigest) throw new Error("External acceptance provenance changed");
  return current;
}

export async function externalOwnerHistory(prisma: Pick<PrismaClient, "runtimeMetadataEvent">, taskId: string, sessionId: string) {
  const latest = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source: `owner:${taskId}`, action: { in: ["completion-contract", "completion-verification", "completion-owner-approval", "completion-retirement-authority", "delivered-retirement-revoked"] } }, orderBy: { sequence: "desc" } });
  return latest?.sequence ?? 0;
}

async function checkComment(input: Context, sessionId: string, bindingInput: ExternalDeliveryBindingInput, dependencies: ExternalDependencies) {
  const lineage = await approvalLineage(input, sessionId, bindingInput.acceptance.approvalEventSequence);
  const observed = await dependencies.comment(lineage.config.linearApiKey, bindingInput.acceptance.ownerCommentId);
  const comment = observed.comment;
  const digest = createHash("sha256").update(comment.body).digest("hex");
  if (comment.id !== bindingInput.acceptance.ownerCommentId || comment.user.id !== lineage.approval.actorId || comment.issue.id !== lineage.approval.issueId || comment.issue.identifier !== lineage.approval.issueIdentifier || digest !== bindingInput.acceptance.ownerCommentDigest || lineage.approval.organizationId && observed.organization.id !== lineage.approval.organizationId || Date.parse(comment.createdAt) > Date.parse(comment.updatedAt) || Date.parse(comment.updatedAt) > Date.now()) throw new Error("Owner acceptance comment author, issue, organization, digest or timestamps do not match");
  return { lineage, acceptance: { approvalEventSequence: lineage.event.sequence, approvalDigest: externalDigest(JSON.parse(lineage.event.value!)), ownerCommentId: comment.id, ownerCommentDigest: digest, actorId: comment.user.id, issueId: comment.issue.id, organizationId: observed.organization.id, createdAt: comment.createdAt, updatedAt: comment.updatedAt } };
}

/** Bearer-owner-only scope adoption. Existing contracts and verification events
 * remain untouched. A model resource receipt cannot reach this authority. */
export async function adoptExternalDeliveries(input: Context & { binding: ExternalDeliveryBindingInput }, dependencies = externalBindingDependencies) {
  const manifest = ExternalDeliveryBindingInput.parse(input.binding);
  const current = await externalTaskAuthority(input.prisma, input.config, input.taskId);
  if (!current.task.pinnedToolingRoot) throw new Error("External adoption requires the task's immutable pinned tooling checkout");
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: current.session.id, action: EXTERNAL_BINDING, source: `owner:${input.taskId}`, key: manifest.requestKey } });
  if (prior) {
    const binding = ExternalBinding.parse(JSON.parse(prior.value!));
    if (externalDigest(binding.input) !== externalDigest(manifest)) throw new Error("External delivery requestKey belongs to a different adoption");
    await assertExternalBindingAuthority(input.prisma, input.config, binding, prior.sequence);
    return { revision: prior.sequence, binding };
  }
  if (current.contractEvent.sequence !== manifest.expectedContractRevision || (current.binding?.sequence ?? 0) !== manifest.expectedBindingRevision) throw new Error("External delivery contract or binding revision changed");
  if (await input.prisma.runtimeMetadataEvent.count({ where: { runtimeSessionId: current.session.id, source: `finalizer:${input.taskId}`, action: "finalization-prepared" } })) throw new Error("Existing finalization preparation must be reconciled before adopting or replacing external delivery");
  const { lineage, acceptance } = await checkComment(input, current.session.id, manifest, dependencies);
  const source = await dependencies.source({ ...input, sessionId: current.session.id });
  if (source.issue.id !== acceptance.issueId || source.link.connectionId !== current.identity.connectionId) throw new Error("Accepted source does not belong to the current task");
  const originalSnapshot = await dependencies.snapshot(current.identity.taskWorktree);
  if (originalSnapshot.branch !== current.identity.branch || (manifest.originalWork ? originalSnapshot.head !== lineage.approval.snapshot.head : !originalSnapshot.clean || originalSnapshot.fingerprint !== lineage.approval.snapshot.fingerprint)) throw new Error("Original cleanup worktree changed from the owner's accepted content");
  const deliveries = await observeExternalDeliveries(manifest.deliveries, manifest.mergeOrder, current.contract.reviewRequired === true, dependencies.observer);
  const resources = await input.prisma.remoteTaskResource.findMany({ where: { taskId: input.taskId } });
  const resourceIds = resources.map((resource) => resource.id).sort();
  if (JSON.stringify(resourceIds) !== JSON.stringify([...manifest.resourceIds].sort())) throw new Error("Adoption must name the complete exact task resource set");
  const originalWork = manifest.originalWork ? await dependencies.originalWork({ taskId: input.taskId, toolingRevision: current.identity.toolingRevision, worktree: current.identity.taskWorktree, branch: current.identity.branch, approvedHead: lineage.approval.snapshot.head, resources, originalWork: manifest.originalWork }) : undefined;
  const retainedArchives = originalWork ? originalWorkRetainedPlans(originalWork, resources) : [];
  const { preparePreservationEvidence, assertPreservationSources } = await import("./cleanup-preservation.ts");
  const preservation = await preparePreservationEvidence({ prisma: input.prisma, taskId: input.taskId, sessionId: current.session.id, resources, plan: retainedArchives, selection: manifest.ownership.preservation });
  const adapterContext = !manifest.ownership.sourceCopyResourceId && originalWork && resources.some(resource => resource.state === "released" ? hasHistoricalCleanupAdapter(resource) : hasCleanupAdapter(resource.kind))
    ? { capability: await dependencies.cleanupObserver({ task: current.task, config: input.config }), task: { id: current.task.id, primarySessionId: current.session.id, worktreePath: current.identity.taskWorktree, toolingRevision: current.identity.toolingRevision } } : undefined;
  const plan = await dependencies.resources({ resources, taskId: input.taskId, sessionId: current.session.id, toolingRoot: current.task.pinnedToolingRoot, sourcePaths: manifest.deliveries.map((delivery) => delivery.sourcePath), deliveries, ownership: manifest.ownership, ...(preservation ? { preservation } : {}), ...(adapterContext ? { adapterContext } : {}), ...(originalWork ? { originalWork: true, retainedArchives } : {}) });
  const { assertRegisteredCaptureSharing } = await import("./cleanup-filesystem.ts");
  await assertRegisteredCaptureSharing(input.prisma, input.taskId, plan);
  if (originalWork) {
    const overlaps = (left: string, right: string) => left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
    for (const entry of plan) {
      if (entry.disposition === "retire-file") {
        for (const file of [entry.target.path, entry.target.quarantine.directory]) if ([originalWork.archive, ...originalWork.additionalArchives ?? []].some(archive => overlaps(file, archive.root)) || overlaps(file, originalWork.target.path)) throw new Error("Standalone file capture must stay outside original-work archives and capture");
        continue;
      }
      if (entry.disposition === "retire-browser" && entry.capture.type === "standalone") {
        const root = entry.capture.target.path;
        if ([originalWork.archive, ...originalWork.additionalArchives ?? []].some(archive => overlaps(root, archive.root)) || overlaps(root, originalWork.target.path)) throw new Error("Browser capture must stay outside original-work archives and capture");
        continue;
      }
      if (entry.disposition !== "retire-tree" && entry.disposition !== "retire-worktree" && entry.disposition !== "retire-owned" || entry.target.type !== "tree") continue;
      const root = entry.target.path;
      if ([originalWork.archive, ...originalWork.additionalArchives ?? []].some((archive) => overlaps(root, archive.root)) || overlaps(root, originalWork.target.path)) throw new Error("Archive and original-work capture must stay outside every other cleanup root");
    }
  }
  const binding = ExternalBinding.parse({ version: 1, input: manifest, identity: current.identity, contractRevision: current.contractEvent.sequence, contractDigest: externalDigest(current.contract), verificationRevision: current.verification.sequence, manifestDigest: externalDigest(manifest), acceptance, deliveries, resources: plan, resourcePlanDigest: finalizationDigest(plan), ...(originalWork ? { originalWork } : {}) });
  // Slow provider reads never turn a stale owner decision into new authority.
  const recheckedComment = await checkComment(input, current.session.id, manifest, dependencies);
  if (externalDigest(recheckedComment.acceptance) !== externalDigest(acceptance)) throw new Error("Owner acceptance changed during adoption");
  if (externalDigest(await dependencies.snapshot(current.identity.taskWorktree)) !== externalDigest(originalSnapshot)) throw new Error("Original cleanup worktree changed during adoption");
  for (const observed of deliveries) if (externalDigest(await dependencies.observer.source(manifest.deliveries.find((delivery) => delivery.id === observed.id)!)) !== externalDigest(observed.snapshot)) throw new Error("External source changed during adoption");
  await dependencies.assertResources({ taskId: input.taskId, resources: await input.prisma.remoteTaskResource.findMany({ where: { taskId: input.taskId } }), plan, removed: false, ...(originalWork ? { originalWork: true } : {}) });
  if (originalWork) await dependencies.assertOriginalWork({ taskId: input.taskId, originalWork, resources: await input.prisma.remoteTaskResource.findMany({ where: { taskId: input.taskId } }), removed: false });
  return input.prisma.$transaction(async (tx) => {
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: current.session.id, action: EXTERNAL_BINDING, source: `owner:${input.taskId}`, key: manifest.requestKey } });
    if (duplicate) {
      const saved = ExternalBinding.parse(JSON.parse(duplicate.value!));
      if (externalDigest(saved.input) !== externalDigest(manifest)) throw new Error("External delivery requestKey belongs to a different adoption");
      await assertExternalBindingAuthority(tx, input.config, saved, duplicate.sequence);
      return { revision: duplicate.sequence, binding: saved };
    }
    const latest = await externalTaskAuthority(tx, input.config, input.taskId);
    if (externalDigest(latest.identity) !== externalDigest(current.identity) || latest.contractEvent.sequence !== current.contractEvent.sequence || latest.verification.sequence !== current.verification.sequence || (latest.binding?.sequence ?? 0) !== manifest.expectedBindingRevision) throw new Error("External delivery authority changed during adoption");
    if (await tx.runtimeMetadataEvent.count({ where: { runtimeSessionId: current.session.id, source: `finalizer:${input.taskId}`, action: "finalization-prepared" } })) throw new Error("Finalization was prepared during external adoption");
    assertExternalResourceRecords(await tx.remoteTaskResource.findMany({ where: { taskId: input.taskId } }), plan, false);
    await assertPreservationSources(tx, input.taskId, current.session.id, plan);
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: current.session.id, action: EXTERNAL_BINDING, source: `owner:${input.taskId}`, key: manifest.requestKey, value: JSON.stringify(binding) } });
    return { revision: event.sequence, binding };
  });
}

/** Revalidates owner comment and exact remote identity even after source roots
 * have been retired. Frozen reports are not reread from a removed directory. */
export async function observeBoundExternalDelivery(input: Context & { revision: number; binding: ExternalBinding; sources: boolean; acceptedCleanup?: true }, dependencies = externalBindingDependencies) {
  const authority = await assertExternalBindingAuthority(input.prisma, input.config, input.binding, input.revision);
  if (input.binding.version === 2) {
    const observations = [];
    for (const frozen of input.binding.deliveries) {
      const delivery = input.binding.input.deliveries.find(entry => entry.id === frozen.id)!;
      const observed = await dependencies.delivered(delivery);
      if (observed.mergeCommit !== frozen.mergeCommit || observed.mergedAt !== frozen.mergedAt || externalDigest(observed.checks) !== externalDigest(frozen.checks)) throw new Error("Delivered retirement provider evidence changed");
      observations.push(observed);
    }
    await assertExternalBindingAuthority(input.prisma, input.config, input.binding, input.revision);
    return observations;
  }
  if (input.acceptedCleanup) {
    // The server's accepted cleanup path retains the frozen comment proof and
    // revalidates its local owner/workflow lineage. Linear availability is not
    // a recurring cleanup gate; explicit local revocation still applies above.
    const lineage = await approvalLineage(input, input.binding.identity.sessionId, input.binding.acceptance.approvalEventSequence);
    if (externalDigest(JSON.parse(lineage.event.value!)) !== input.binding.acceptance.approvalDigest || lineage.approval.actorId !== input.binding.acceptance.actorId
      || lineage.approval.issueId !== input.binding.acceptance.issueId || lineage.approval.organizationId && lineage.approval.organizationId !== input.binding.acceptance.organizationId) throw new Error("Accepted external comment provenance changed");
  } else {
    const checked = await checkComment(input, input.binding.identity.sessionId, input.binding.input, dependencies);
    if (externalDigest(checked.acceptance) !== externalDigest(input.binding.acceptance)) throw new Error("Accepted owner comment changed since external adoption");
  }
  const observations = [];
  for (const frozen of input.binding.deliveries) {
    const delivery = input.binding.input.deliveries.find((entry) => entry.id === frozen.id)!;
    const remote = await dependencies.observer.remote(delivery, authority.contract?.reviewRequired === true);
    if (remote.mergeCommit !== frozen.mergeCommit || remote.mergedAt !== frozen.mergedAt || externalDigest(remote.ci) !== externalDigest(frozen.ci)) throw new Error("External merge or CI evidence changed since adoption");
    if (input.sources && (externalDigest(await dependencies.observer.source(delivery)) !== externalDigest(frozen.snapshot) || externalDigest(await dependencies.observer.reports(delivery)) !== externalDigest(frozen.reports))) throw new Error("External source or accepted report changed since adoption");
    observations.push({ ...frozen, ...remote });
  }
  await assertExternalBindingAuthority(input.prisma, input.config, input.binding, input.revision);
  return observations;
}

export async function inspectExternalDeliveries(input: Context) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const event = task.primarySessionId && await latestExternalBinding(input.prisma, task.id, task.primarySessionId);
  return event ? { revision: event.sequence, binding: ExternalBinding.parse(JSON.parse(event.value!)) } : { revision: 0, binding: null };
}
