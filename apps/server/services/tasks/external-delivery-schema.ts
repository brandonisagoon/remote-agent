import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { isSafeBranchName } from "../../workers/product/workflow/branch.ts";
import { OriginalWork, OriginalWorkInput } from "./original-work-schema.ts";
import { FinalizationResourcePlan } from "./finalization-resources.ts";

export const EXTERNAL_BINDING = "external-delivery-binding";
export const EXTERNAL_OBSERVATION = "external-delivery-observation";
export const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const AbsolutePath = z.string().max(4096).refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const Ref = z.string().max(200).refine(isSafeBranchName);
const Repository = z.string().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
export const ExternalEvidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ci-run"), runId: z.number().int().positive(), workflowId: z.number().int().positive(), head: Sha }).strict(),
  z.object({ kind: z.literal("report"), path: AbsolutePath, sha256: Digest, head: Sha }).strict(),
]);
export const ExternalDeliveryInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), repository: Repository, pullRequest: z.number().int().positive(),
  sourcePath: AbsolutePath, branch: Ref, reviewedHead: Sha, baseBranch: Ref, expectedMergeCommit: Sha,
  verificationRefs: z.array(ExternalEvidence).min(1).max(20),
}).strict();
export type ExternalDeliveryInput = z.infer<typeof ExternalDeliveryInput>;
export const ExternalDeliveryBindingInput = z.object({
  version: z.literal(1), requestKey: z.string().trim().min(1).max(180),
  expectedContractRevision: z.number().int().positive(), expectedBindingRevision: z.number().int().nonnegative(),
  acceptance: z.object({ approvalEventSequence: z.number().int().positive(), ownerCommentId: z.string().min(1).max(200), ownerCommentDigest: Digest }).strict(),
  deliveries: z.array(ExternalDeliveryInput).min(1).max(10), mergeOrder: z.array(z.string()).min(1).max(10),
  resourceIds: z.array(z.string().min(1)).min(1).max(1000),
  originalWork: OriginalWorkInput.optional(),
  ownership: z.object({ sourceCopyResourceId: z.string().min(1).optional(), ownedPaths: z.array(AbsolutePath).max(100) }).strict(),
}).strict().superRefine((value, ctx) => {
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(value.deliveries.map((entry) => entry.id)) || !unique(value.deliveries.map((entry) => `${entry.repository}/${entry.pullRequest}`)) || !unique(value.deliveries.map((entry) => entry.sourcePath)) || !unique(value.resourceIds) || !unique(value.ownership.ownedPaths) || !unique(value.mergeOrder) || value.mergeOrder.length !== value.deliveries.length || value.mergeOrder.some((id) => !value.deliveries.some((entry) => entry.id === id))) ctx.addIssue({ code: "custom", message: "Delivery, resource and merge-order identities must be unique and complete" });
  if (value.ownership.sourceCopyResourceId ? !value.resourceIds.includes(value.ownership.sourceCopyResourceId) : !value.originalWork) ctx.addIssue({ code: "custom", message: "The adopted source-copy resource must be in the exact resource set" });
  if (value.originalWork && !value.resourceIds.includes(value.originalWork.archiveResourceId)) ctx.addIssue({ code: "custom", message: "Original-work archive must belong to the exact resource set" });
  if (value.originalWork && ("format" in value.originalWork ? value.originalWork.retainedArchiveMembers ?? [] : [...value.originalWork.retainedResults ?? [], ...value.originalWork.additionalArchives ?? []]).some((entry) => !value.resourceIds.includes(entry.resourceId))) ctx.addIssue({ code: "custom", message: "Every retained resource must belong to the exact resource set" });
  for (const delivery of value.deliveries) if (delivery.verificationRefs.some((ref) => ref.head !== delivery.reviewedHead)) ctx.addIssue({ code: "custom", message: "Every verification reference must identify its reviewed source head" });
});
export type ExternalDeliveryBindingInput = z.infer<typeof ExternalDeliveryBindingInput>;
export const ExternalSnapshot = z.object({ head: Sha, branch: z.string(), clean: z.literal(true), fingerprint: Digest,
  sourcePath: AbsolutePath, gitDirectory: AbsolutePath, tree: Sha, device: z.number(), inode: z.number() }).strict();
export const ExternalDeliveryObservation = z.object({
  id: z.string(), repository: Repository, pullRequest: z.number().int().positive(), url: z.url(), reviewedHead: Sha, mergeCommit: Sha,
  mergedAt: z.iso.datetime(), baseHead: Sha,
  ci: z.array(z.object({ runId: z.number().int().positive(), head: Sha, workflowId: z.number().int().positive(), name: z.string(), conclusion: z.literal("success") }).strict()),
  reports: z.array(z.object({ path: AbsolutePath, sha256: Digest, head: Sha, attribution: z.literal("owner-attested") }).strict()),
  snapshot: ExternalSnapshot,
}).strict();
export type ExternalDeliveryObservation = z.infer<typeof ExternalDeliveryObservation>;
export const ExternalTaskIdentity = z.object({ taskId: z.string(), sessionId: z.string(), repositoryId: z.string(), machineId: z.string(),
  connectionId: z.string(), issueIdentifier: z.string(), taskWorktree: z.string(), branch: z.string(), baseCommit: z.string().nullable(), toolingRoot: z.string(), toolingRevision: z.string(), pinnedToolingRoot: z.string().nullable() }).strict();
export function externalDigest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export const ExternalBinding = z.object({ version: z.literal(1), input: ExternalDeliveryBindingInput, identity: ExternalTaskIdentity,
  contractRevision: z.number().int(), contractDigest: Digest, verificationRevision: z.number().int(), manifestDigest: Digest,
  acceptance: z.object({ approvalEventSequence: z.number().int(), approvalDigest: Digest, ownerCommentId: z.string(), ownerCommentDigest: Digest,
    actorId: z.string(), issueId: z.string(), organizationId: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict(),
  deliveries: z.array(ExternalDeliveryObservation),
  resources: z.array(FinalizationResourcePlan), resourcePlanDigest: Digest, originalWork: OriginalWork.optional(),
}).strict();
export type ExternalBinding = z.infer<typeof ExternalBinding>;
