import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { completionObservation } from "./completion-observation.ts";
import type { LinearIssueWebhook } from "../../integrations/linear/webhook-types/issue.ts";
import { confirmedFinalizationDelivery, worktreeIsMissing, type CompletionDelivery } from "./finalization-receipts.ts";

const Text = z.string().trim().min(1).max(4000);
export const CompletionContractInput = z.object({
  requestKey: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(),
  boundary: z.enum(["research", "local-only", "commit", "push", "pr", "review", "merge", "revoked"]),
  basis: Text, verificationRequired: z.boolean().default(true), reviewRequired: z.boolean().optional(),
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).default("origin"),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  pullRequest: z.number().int().positive().optional(),
  baseBranch: z.string().min(1).max(200).optional(),
}).strict().superRefine((value, context) => {
  if (["push", "pr", "review", "merge"].includes(value.boundary) && !value.repository) context.addIssue({ code: "custom", message: "Remote delivery requires the authorized GitHub owner/repository", path: ["repository"] });
  if (["pr", "review", "merge"].includes(value.boundary) && !value.baseBranch) context.addIssue({ code: "custom", message: "PR delivery requires the authorized base branch", path: ["baseBranch"] });
});
export const CompletionVerificationInput = z.object({ requestKey: z.string().min(1).max(200), passed: z.boolean(), evidence: z.array(Text).min(1).max(20) }).strict();
type Contract = z.infer<typeof CompletionContractInput>;
type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string };
const CONTRACT = "completion-contract";
const VERIFICATION = "completion-verification";
const OBSERVATION = "completion-observation";
const APPROVAL = "completion-owner-approval";
export type OwnerMergeApproval = { requestKey: string; contractRevision: number; [key: string]: unknown };

/** Valid inside the enqueue transaction and immediately before inbox claim. */
export async function isCurrentMergeApproval(prisma: Pick<PrismaClient, "runtimeMetadataEvent">, input: {
  taskId: string; sessionId: string; approval: OwnerMergeApproval;
}) {
  const latest = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, action: CONTRACT, source: `owner:${input.taskId}` }, orderBy: { sequence: "desc" } });
  if (!latest || latest.sequence !== input.approval.contractRevision || latest.key !== input.approval.requestKey) return false;
  const parsed = CompletionContractInput.safeParse(JSON.parse(latest.value ?? "null"));
  return parsed.success && parsed.data.boundary === "merge";
}

async function ownedTask({ prisma, config, taskId }: Context) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  getRepositoryConfig(config, task.repositoryId);
  const session = task.primarySessionId && await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!session || !task.worktreePath || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId || session.machineId !== task.machineId || task.machineId !== config.machine) throw new Error("Completion requires the task's original primary, worktree, repository and machine");
  return { task, session };
}

async function contractFor(prisma: PrismaClient, taskId: string, sessionId: string) {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, action: CONTRACT, source: `owner:${taskId}` }, orderBy: { sequence: "desc" } });
  return event ? { revision: event.sequence, value: CompletionContractInput.parse(JSON.parse(event.value!)) } : null;
}

/** Called only by the bearer-authenticated owner API, never session tools. */
export async function setCompletionContract(input: Context & { contract: Contract }) {
  const { task, session } = await ownedTask(input);
  const contract = CompletionContractInput.parse(input.contract);
  const source = `owner:${task.id}`;
  return input.prisma.$transaction(async (tx) => {
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: CONTRACT, source, key: contract.requestKey } });
    const value = JSON.stringify(contract);
    if (prior) {
      if (prior.value !== value) throw new Error("Completion requestKey belongs to a different owner decision");
      return { revision: prior.sequence, contract };
    }
    const latest = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: CONTRACT, source }, orderBy: { sequence: "desc" } });
    if ((latest?.sequence ?? 0) !== contract.expectedRevision) throw new Error("Completion authority changed; inspect it before setting another boundary");
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, action: CONTRACT, source, key: contract.requestKey, value } });
    return { revision: event.sequence, contract };
  });
}

/** An explicit owner's verification receipt, bound to the observed worktree.
 * Model progress and generic resources cannot create or replace this receipt. */
export async function recordCompletionVerification(input: Context & { verification: z.infer<typeof CompletionVerificationInput> }, observer = completionObservation) {
  const { task, session } = await ownedTask(input);
  const verification = CompletionVerificationInput.parse(input.verification);
  const contract = await contractFor(input.prisma, task.id, session.id);
  if (!contract || contract.value.boundary === "revoked") throw new Error("Set an explicit completion boundary before recording verification");
  const source = `owner:${task.id}`;
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: VERIFICATION, source, key: verification.requestKey } });
  if (prior) {
    const data = JSON.parse(prior.value!);
    if (JSON.stringify(data.verification) !== JSON.stringify(verification)) throw new Error("Verification requestKey belongs to different evidence");
    return { revision: prior.sequence, ...data };
  }
  const snapshot = await observer.snapshot(task.worktreePath!);
  const data = { contractRevision: contract.revision, verification, snapshot };
  return input.prisma.$transaction(async (tx) => {
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: VERIFICATION, source, key: verification.requestKey } });
    if (duplicate) {
      const saved = JSON.parse(duplicate.value!);
      if (JSON.stringify(saved.verification) !== JSON.stringify(verification)) throw new Error("Verification requestKey belongs to different evidence");
      return { revision: duplicate.sequence, ...saved };
    }
    const latest = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: CONTRACT, source }, orderBy: { sequence: "desc" } });
    if (latest?.sequence !== contract.revision) throw new Error("Completion authority changed during verification");
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, action: VERIFICATION, source, key: verification.requestKey, value: JSON.stringify(data) } });
    return { revision: event.sequence, ...data };
  });
}

export async function inspectTaskCompletion(input: Context) {
  const { task, session } = await ownedTask(input);
  const contract = await contractFor(input.prisma, task.id, session.id);
  const receipts = await input.prisma.runtimeMetadataEvent.findMany({ where: {
    runtimeSessionId: session.id, source: { in: [`owner:${task.id}`, `observer:${task.id}`] }, action: { in: [VERIFICATION, OBSERVATION, APPROVAL] },
  }, orderBy: { sequence: "desc" }, take: 100 });
  return { boundary: contract?.value.boundary ?? "unknown", contract, implementation: { source: "model-reported", phase: task.phase }, receipts: receipts.map((event) => ({ revision: event.sequence, kind: event.action, source: event.source, observedAt: event.occurredAt, ...JSON.parse(event.value!) })) };
}

/** Terminal issue states only. Manual Review remains an ordinary progress
 * update. Re-read on every unpublished attempt and immediately before write. */
export async function assertCompletionAllowed(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string }, observer = completionObservation): Promise<CompletionDelivery> {
  const task = await input.prisma.remoteTask.findUnique({ where: { primarySessionId: input.sessionId } });
  if (!task) throw new Error("Terminal completion requires an explicit managed-task completion boundary");
  const owned = await ownedTask({ ...input, taskId: task.id });
  if (task.phase === "closed" || task.controlMode !== "agent" || owned.session.status === "closed") throw new Error("Task completion is paused, closed or under human control");
  const contract = await contractFor(input.prisma, task.id, input.sessionId);
  if (!contract || contract.value.boundary === "revoked") throw new Error("Completion boundary is unknown or revoked; an explicit owner decision is required");
  if (await worktreeIsMissing(task.worktreePath!)) return confirmedFinalizationDelivery({ ...input, taskId: task.id, contractRevision: contract.revision });
  const { value: boundary } = contract;
  const snapshot = await observer.snapshot(task.worktreePath!);
  if (snapshot.branch !== task.branchName) throw new Error("Worktree branch changed; completion evidence belongs to another branch");
  const local = boundary.boundary === "local-only" || boundary.boundary === "research";
  const verificationEvent = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: input.sessionId, action: VERIFICATION, source: `owner:${task.id}` }, orderBy: { sequence: "desc" } });
  const verification = verificationEvent ? JSON.parse(verificationEvent.value!) : null;
  const verified = Boolean(verification?.contractRevision === contract.revision && verification?.verification.passed === true && verification?.snapshot.fingerprint === snapshot.fingerprint);
  let remote: Awaited<ReturnType<typeof observer.remote>> | null = null;
  let pullRequest = boundary.pullRequest;
  if (["pr", "review", "merge"].includes(boundary.boundary) && !pullRequest) {
    const discovered = await observer.discover(task.worktreePath!, task.branchName);
    if (discovered.repository !== boundary.repository || discovered.remote !== boundary.remote || discovered.baseBranch !== boundary.baseBranch || discovered.head !== snapshot.head) throw new Error("Discovered PR does not match the owner's authorized task repository, branch, base and current commit");
    pullRequest = discovered.pullRequest;
  }
  if (["push", "pr", "review", "merge"].includes(boundary.boundary)) remote = await observer.remote(task.worktreePath!, { repository: boundary.repository!, remote: boundary.remote, branch: task.branchName, pullRequest, baseBranch: boundary.baseBranch });
  const pr = remote?.pullRequest;
  const prMatches = Boolean(pr && pr.headRefOid === snapshot.head && pr.headRefName === task.branchName && pr.baseRefName === boundary.baseBranch && !pr.isDraft && ["OPEN", "MERGED"].includes(pr.state));
  const receipts = {
    contractRevision: contract.revision, snapshot,
    implementation: { source: "model-reported", phase: task.phase },
    verification: { source: "owner-attested", matched: verified, evidence: verification?.verification.evidence ?? [] },
    commit: { observed: true, sha: snapshot.head, clean: snapshot.clean },
    push: { observed: remote !== null, matchesHead: remote?.remoteHead === snapshot.head },
    pullRequest: { observed: Boolean(pr), matchesHead: prMatches, url: pr?.url ?? null },
    review: { observed: Boolean(pr), approved: prMatches && pr?.reviewDecision === "APPROVED" },
    merge: { observed: Boolean(pr), merged: prMatches && pr?.state === "MERGED" && Boolean(pr.mergeCommit?.oid), sha: pr?.mergeCommit?.oid ?? null },
  };
  await input.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: input.sessionId, action: OBSERVATION, source: `observer:${task.id}`, key: String(contract.revision), value: JSON.stringify(receipts) } });
  if (boundary.verificationRequired && !verified) throw new Error("Implementation verification is missing, failed or stale for this completion boundary and worktree");
  if (!local && !snapshot.clean) throw new Error("Verified implementation is still dirty or untracked; the authorized delivery boundary is not complete");
  if (["push", "pr", "review"].includes(boundary.boundary) && remote?.remoteHead !== snapshot.head) throw new Error("Local commit has not been published to the authorized remote branch");
  if (["pr", "review", "merge"].includes(boundary.boundary) && !prMatches) throw new Error("The authorized non-draft pull request does not match this task's current commit and base");
  const reviewRequired = boundary.boundary === "review" || boundary.reviewRequired === true;
  if (reviewRequired && pr?.reviewDecision !== "APPROVED") throw new Error("Required human review is still pending or changes were requested");
  if (boundary.boundary === "merge" && (pr?.state !== "MERGED" || !pr.mergeCommit?.oid)) throw new Error("The authorized pull request has not been merged");
  const latest = await contractFor(input.prisma, task.id, input.sessionId);
  const currentTask = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
  if (latest?.revision !== contract.revision || currentTask.controlMode !== "agent" || currentTask.phase === "closed") throw new Error("Completion authority or task control changed during verification");
  const current = await observer.snapshot(task.worktreePath!);
  if (current.fingerprint !== snapshot.fingerprint || current.branch !== snapshot.branch || current.head !== snapshot.head || current.clean !== snapshot.clean) throw new Error("Worktree changed during completion verification");
  return { boundary: boundary.boundary, receipts };
}

/** Server-only integration for the authenticated owner's configured Merge
 * transition. A worker or session reporting "ready" cannot call this API. */
export async function recordOwnerMergeApproval(input: Context & {
  runId: string; workflowId: string; webhook: LinearIssueWebhook; currentIssueState: string;
}, observer = completionObservation): Promise<OwnerMergeApproval> {
  const { task, session } = await ownedTask(input);
  const { webhook, config } = input;
  const workflow = config.repository.workflows[input.workflowId];
  const actorId = webhook.actor?.id;
  const subscribed = actorId && actorId !== config.agentUserId && config.webhooks[config.activeWebhookId]?.repositoryRouting[task.repositoryId]?.when
    ?.some((condition) => condition["linear.userId"]?.includes(actorId));
  if (!subscribed || webhook.data.state?.name !== "Merge" || input.currentIssueState !== "Merge" || !webhook.updatedFrom?.stateId || workflow?.on !== "issue.state-changed" || !workflow.when?.some((condition) => condition["issue.state"]?.includes("Merge"))) {
    throw new Error("Completion authority requires the subscribed owner's current configured Merge transition");
  }
  if (task.controlMode !== "agent" || task.phase === "closed" || session.status === "closed") throw new Error("Task completion authority is paused or closed");
  const run = await input.prisma.workerRun.findUnique({ where: { id: input.runId }, include: { receipt: true } });
  const receipt = run?.receipt;
  if (!run || !receipt || run.workerKey !== `product.workflow:${input.workflowId}` || receipt.provider !== "linear" || receipt.eventType !== "issue" || receipt.webhookId !== config.activeWebhookId || receipt.connectionId !== task.connectionId || receipt.repositoryId !== task.repositoryId || receipt.resourceId !== task.issueIdentifier || receipt.resourceId !== webhook.data.identifier || !receipt.trigger?.split(",").includes(input.workflowId)) {
    throw new Error("Owner Merge approval is not backed by this task's accepted workflow receipt");
  }
  const source = `owner:${task.id}`;
  const requestKey = `merge:${receipt.id}`;
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: APPROVAL, source, key: requestKey } });
  const current = await contractFor(input.prisma, task.id, session.id);
  if (prior) {
    if (current?.value.requestKey !== requestKey || current.value.boundary !== "merge") throw new Error("A newer owner completion decision superseded this Merge event");
    return JSON.parse(prior.value!);
  }
  const latestEvent = current && await input.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: current.revision } });
  if (latestEvent && latestEvent.occurredAt.getTime() > webhook.webhookTimestamp) throw new Error("A newer owner completion decision superseded this Merge event");
  const snapshot = await observer.snapshot(task.worktreePath!);
  const repository = await observer.repository(task.worktreePath!);
  const baseBranch = (getRepositoryConfig(config, task.repositoryId).baseBranch ?? "main").replace(/^origin\//, "");
  if (snapshot.branch !== task.branchName) throw new Error("Owner Merge acceptance must match the task's original branch");
  const contract = CompletionContractInput.parse({
    requestKey, expectedRevision: current?.revision ?? 0, boundary: "merge", verificationRequired: true,
    reviewRequired: current?.value.reviewRequired ?? false,
    basis: `Owner ${actorId} accepted ${webhook.data.identifier} by moving it to Merge (delivery ${receipt.deliveryId}, workflow ${input.workflowId}).`,
    remote: repository.remote, repository: repository.repository, baseBranch,
  });
  const provenance = { requestKey, actorId, organizationId: webhook.organizationId ?? null, issueId: webhook.data.id, issueIdentifier: webhook.data.identifier, webhookTimestamp: webhook.webhookTimestamp, receiptId: receipt.id, deliveryId: receipt.deliveryId, connectionId: receipt.connectionId, runId: run.id, workflowId: workflow.id, repository: repository.repository, baseBranch, snapshot };
  return input.prisma.$transaction(async (tx) => {
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: APPROVAL, source, key: requestKey } });
    const latest = await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: session.id, action: CONTRACT, source }, orderBy: { sequence: "desc" } });
    const currentTask = await tx.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    if (duplicate) {
      const authority = latest && CompletionContractInput.parse(JSON.parse(latest.value!));
      if (authority?.requestKey !== requestKey || authority.boundary !== "merge" || currentTask.controlMode !== "agent" || currentTask.phase === "closed") throw new Error("Owner completion authority or control changed during Merge acceptance");
      return JSON.parse(duplicate.value!);
    }
    if ((latest?.sequence ?? 0) !== contract.expectedRevision || currentTask.controlMode !== "agent" || currentTask.phase === "closed") throw new Error("Owner completion authority or control changed during Merge acceptance");
    const event = await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, action: CONTRACT, source, key: requestKey, value: JSON.stringify(contract) } });
    const approval = { ...provenance, contractRevision: event.sequence };
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, action: VERIFICATION, source, key: requestKey, value: JSON.stringify({ contractRevision: event.sequence, snapshot, verification: { requestKey, passed: true, evidence: [contract.basis] }, provenance: approval }) } });
    await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, action: APPROVAL, source, key: requestKey, value: JSON.stringify(approval) } });
    return approval;
  });
}
