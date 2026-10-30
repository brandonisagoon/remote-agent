import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { linkedSourceIssue } from "../sessions/questions.ts";
import { CompletionContractInput, assertCompletionAllowed } from "./completion.ts";
import { completionObservation } from "./completion-observation.ts";
import { observeExternalRemote } from "./external-delivery-observation.ts";
import { assertRetirementAuthority, latestRetirement, RETIREMENT_AUTHORITY, RetirementDelivery, RetirementGrant, retirementBinding, retirementDigest } from "./retirement-receipts.ts";
import { assertRetirementResourcePreflight } from "./retirement-preview.ts";

const Request = z.object({ requestKey: z.string().trim().min(1).max(180), expectedRevision: z.number().int().nonnegative(), basis: z.string().trim().min(1).max(4000) });
export const RetirementAuthorityInput = z.discriminatedUnion("action", [
  Request.extend({ action: z.literal("authorize"), expectedBindingDigest: z.string().regex(/^[a-f0-9]{64}$/), delivery: RetirementDelivery }).strict(),
  Request.extend({ action: z.literal("revoke") }).strict(),
]);
type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string };
export async function observeRetirementDelivery(delivery: z.infer<typeof RetirementDelivery>, branch: string, reviewRequired: boolean) {
  // Reuse independent provider observations, including merge ancestry in the
  // current base. No source files, CI receipts or verification claims are made.
  return observeExternalRemote({ id: "retirement", repository: delivery.repository, pullRequest: delivery.pullRequest, sourcePath: "/", branch,
    reviewedHead: delivery.head, baseBranch: delivery.baseBranch, expectedMergeCommit: delivery.mergeCommit, verificationRefs: [] }, reviewRequired);
}
export const retirementDependencies = { source: linkedSourceIssue, completion: assertCompletionAllowed, snapshot: completionObservation.snapshot, remote: observeRetirementDelivery };

export async function inspectRetirementAuthority(input: Context, dependencies = retirementDependencies) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  const latest = task.primarySessionId ? await latestRetirement(input.prisma, task.id, task.primarySessionId) : null;
  const action = latest && JSON.parse(latest.value ?? "null")?.action;
  const status = { taskId: task.id, sessionId: task.primarySessionId, revision: latest?.sequence ?? 0, action: action === "authorize" || action === "revoke" ? action as "authorize" | "revoke" : null };
  let sourceState: string | null = null;
  try {
    if (!task.primarySessionId) throw new Error("Retirement requires an original primary");
    const source = await dependencies.source({ ...input, sessionId: task.primarySessionId });
    sourceState = source.issue.state.name;
    if (sourceState !== "Done" || source.issue.identifier !== task.issueIdentifier || source.link.connectionId !== task.connectionId) throw new Error("Retirement requires the exact Done source");
    const binding = await retirementBinding(input.prisma, input.config, task.id, source.issue.id);
    assertRetirementResourcePreflight(binding.resources);
    return { ...status, eligible: true as const, sourceState, bindingDigest: retirementDigest(binding), contractRevision: binding.contractRevision, verificationRevision: binding.verificationRevision,
      resources: binding.resources.map(({ metadata, ...resource }) => ({ ...resource, metadataDigest: retirementDigest(metadata) })) };
  } catch (error) {
    // The owner can recover a lost revision and revoke even after pause or
    // identity changes. Ineligible inspection never yields an authorization digest.
    const bindingError = error instanceof Error && /^(Retirement |Reconcile )/.test(error.message) ? error.message : "Current task, source or accepted verification cannot be bound for retirement.";
    return { ...status, eligible: false as const, sourceState, bindingError };
  }
}

/** Owner bearer API only. This records retirement authority, never a passing
 * check, a Merge transition, a resource release or a replacement task pin. */
export async function setRetirementAuthority(input: Context & { authorization: z.infer<typeof RetirementAuthorityInput> }, dependencies = retirementDependencies) {
  const authorization = RetirementAuthorityInput.parse(input.authorization);
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Retirement requires an original primary");
  const where = { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}`, action: RETIREMENT_AUTHORITY };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, key: authorization.requestKey } });
  if (prior) {
    const saved = JSON.parse(prior.value!);
    if (retirementDigest(saved.input) !== retirementDigest(authorization)) throw new Error("Retirement requestKey belongs to different authorization");
    if ((await latestRetirement(input.prisma, task.id, task.primarySessionId))?.sequence !== prior.sequence) throw new Error("Retirement authorization was superseded; inspect current authority");
    if (authorization.action === "authorize") await assertRetirementAuthority(input.prisma, input.config, task.id, task.primarySessionId, saved.binding.issueId, { revision: prior.sequence, digest: retirementDigest(saved) });
    return { revision: prior.sequence, action: authorization.action };
  }
  const latest = await latestRetirement(input.prisma, task.id, task.primarySessionId);
  if ((latest?.sequence ?? 0) !== authorization.expectedRevision) throw new Error("Retirement authority changed; inspect it before updating");
  let value: unknown = { version: 1, action: "revoke", input: authorization };
  let binding: Awaited<ReturnType<typeof retirementBinding>> | undefined;
  if (authorization.action === "authorize") {
    if (await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `finalizer:${task.id}`, action: "finalization-prepared" } })) throw new Error("A prepared finalization already fixes this task's authority; reconcile that receipt");
    if (await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}`, action: "external-delivery-binding" } })) throw new Error("External delivery retirement uses its own prepared authority");
    const context = { ...input, sessionId: task.primarySessionId };
    const source = await dependencies.source(context);
    if (source.issue.state.name !== "Done" || source.issue.identifier !== task.issueIdentifier || source.link.connectionId !== task.connectionId) throw new Error("Retirement authorization requires this task's current Done source");
    binding = await retirementBinding(input.prisma, input.config, task.id, source.issue.id);
    assertRetirementResourcePreflight(binding.resources);
    if (retirementDigest(binding) !== authorization.expectedBindingDigest) throw new Error("Retirement binding changed; inspect its exact identities again");
    const contractEvent = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: binding.contractRevision } });
    const contract = CompletionContractInput.parse(JSON.parse(contractEvent.value!));
    const delivered = await dependencies.completion(context);
    const delivery = authorization.delivery;
    if (delivered.boundary !== "merge" || !delivered.receipts.verification.matched || !delivered.receipts.snapshot.clean || delivered.receipts.snapshot.head !== delivery.head
      || delivered.receipts.pullRequest.url?.toLowerCase() !== `https://github.com/${delivery.repository}/pull/${delivery.pullRequest}` || delivered.receipts.merge.sha !== delivery.mergeCommit
      || contract.repository !== delivery.repository || contract.baseBranch !== delivery.baseBranch || contract.pullRequest && contract.pullRequest !== delivery.pullRequest) throw new Error("Retirement delivery does not match accepted verification and the exact merge");
    const remote = await dependencies.remote(delivery, binding.branch, contract.reviewRequired ?? false);
    const snapshot = await dependencies.snapshot(binding.taskWorktree);
    if (retirementDigest(snapshot) !== retirementDigest(delivered.receipts.snapshot)) throw new Error("Retirement worktree changed during delivery observation");
    const currentSource = await dependencies.source(context);
    if (currentSource.issue.state.name !== "Done" || currentSource.issue.id !== source.issue.id || currentSource.link.connectionId !== source.link.connectionId) throw new Error("Retirement source changed during authorization");
    value = RetirementGrant.parse({ version: 1, action: "authorize", input: authorization, binding, delivery, baseHead: remote.baseHead, deliveryDigest: retirementDigest(delivered) });
  }
  return input.prisma.$transaction(async tx => {
    if ((await latestRetirement(tx, task.id, task.primarySessionId!))?.sequence !== latest?.sequence) throw new Error("Retirement authority changed during authorization");
    if (binding && retirementDigest(await retirementBinding(tx, input.config, task.id, binding.issueId)) !== retirementDigest(binding)) throw new Error("Retirement binding changed during authorization");
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where, key: authorization.requestKey, value: JSON.stringify(value) } });
    return { revision: event.sequence, action: authorization.action };
  });
}
