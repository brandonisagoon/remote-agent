import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getRepositoryConfig, type ServerConfig } from "../../../../lib/config.ts";
import { linkedSourceIssue } from "../sessions/questions.ts";
import { completionObservation } from "./completion-observation.ts";
import { FINALIZATION_PREPARED, PreparedFinalization, assertFinalizationRemoved, finalizationGit, finalizationWorktrees, worktreeIsMissing } from "./finalization-receipts.ts";
import { RetirementBinding, RetirementDelivery, RetirementReference, assertRetirementBinding, retirementBinding, retirementDigest, type RetirementDatabase } from "./retirement-receipts.ts";
import { observeRetirementDelivery } from "./retirement-authority.ts";

export const DONE_RETIREMENT = "prepared-done-retirement";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DoneSource = z.object({ issueId: z.string().min(1), stateId: z.string().min(1), updatedAt: z.iso.datetime() }).strict();
export const DoneRetirementInput = z.object({ version: z.literal(1), mode: z.literal("existing-preparation"), requestKey: z.string().trim().min(1).max(180),
  expectedRevision: z.number().int().nonnegative(), expectedBindingDigest: Digest, preparedRevision: z.number().int().positive(), preparedDigest: Digest,
  source: DoneSource, basis: z.string().trim().min(1).max(4000) }).strict();
export const DoneRetirementGrant = z.object({ version: z.literal(1), input: DoneRetirementInput, binding: RetirementBinding,
  delivery: RetirementDelivery, baseHead: z.string().regex(/^[a-f0-9]{40}$/), preparedRevision: z.number().int().positive(), preparedDigest: Digest }).strict();
type Context = { prisma: PrismaClient; config: ServerConfig; taskId: string };
export const doneRetirementDependencies = { source: linkedSourceIssue, snapshot: completionObservation.snapshot, remote: observeRetirementDelivery };
const bytesDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export const latestDoneRetirement = (prisma: RetirementDatabase, taskId: string, sessionId: string) => prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source: `owner:${taskId}`, action: DONE_RETIREMENT }, orderBy: { sequence: "desc" } });

async function preparation(prisma: RetirementDatabase, taskId: string, sessionId: string, revision?: number) {
  const event = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source: `finalizer:${taskId}`, action: FINALIZATION_PREPARED }, orderBy: { sequence: "desc" } });
  if (!event?.value || revision && event.sequence !== revision) throw new Error("Done retirement requires the unchanged latest preparation");
  const value = JSON.parse(event.value);
  if (value.version !== undefined || value.retirementAuthority !== undefined) throw new Error("Done supplement requires the original Merge-based v1 preparation");
  const prepared = PreparedFinalization.parse(value);
  if (prepared.taskId !== taskId || prepared.sessionId !== sessionId || prepared.requestKey !== event.key) throw new Error("Done retirement preparation identity changed");
  return { event, prepared, digest: bytesDigest(event.value) };
}

function assertPreparedBinding(prepared: PreparedFinalization, binding: RetirementBinding) {
  if (prepared.taskId !== binding.taskId || prepared.sessionId !== binding.sessionId || prepared.requestKey !== `finalize:${binding.taskId}` || prepared.repositoryId !== binding.repositoryId || prepared.machineId !== binding.machineId || prepared.connectionId !== binding.connectionId || prepared.issueIdentifier !== binding.issueIdentifier || prepared.issueId !== binding.issueId || prepared.taskWorktree !== binding.taskWorktree || prepared.branch !== binding.branch || prepared.contractRevision !== binding.contractRevision || prepared.delivery.boundary !== "merge" || !prepared.delivery.receipts.snapshot.clean || prepared.delivery.receipts.snapshot.head !== prepared.revision || prepared.delivery.receipts.snapshot.branch !== prepared.branch || !prepared.delivery.receipts.merge.merged || !prepared.delivery.receipts.merge.sha) throw new Error("Original prepared delivery does not match current retirement ownership");
}

function sourceIdentity(source: Awaited<ReturnType<typeof linkedSourceIssue>>, binding: RetirementBinding, expected?: z.infer<typeof DoneSource>) {
  if (source.issue.state.name !== "Done" || source.issue.state.type !== "completed" || source.issue.id !== binding.issueId || source.issue.identifier !== binding.issueIdentifier || source.link.connectionId !== binding.connectionId || source.session.id !== binding.sessionId) throw new Error("Done retirement requires the exact current Done source");
  const observed = DoneSource.parse({ issueId: source.issue.id, stateId: source.issue.state.id, updatedAt: source.issue.updatedAt });
  if (expected && retirementDigest(observed) !== retirementDigest(expected)) throw new Error("Done source changed during retirement adoption");
  return observed;
}

/** Separate present-day evidence: never rewrites the original preparation,
 * completion contract, verification, legacy evidence proof or Linear issue. */
export async function inspectDoneRetirement(input: Context, dependencies = doneRetirementDependencies) {
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Done retirement requires the original primary");
  const source = await dependencies.source({ ...input, sessionId: task.primarySessionId });
  const binding = await retirementBinding(input.prisma, input.config, task.id, source.issue.id, true);
  const current = await preparation(input.prisma, task.id, task.primarySessionId);
  assertPreparedBinding(current.prepared, binding);
  const accepted = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: binding.verificationRevision } });
  if (accepted.sequence > current.event.sequence || JSON.parse(accepted.value!).snapshot?.fingerprint !== current.prepared.delivery.receipts.snapshot.fingerprint) throw new Error("Original preparation verification changed");
  const latest = await latestDoneRetirement(input.prisma, task.id, task.primarySessionId);
  return { taskId: task.id, sessionId: task.primarySessionId, revision: latest?.sequence ?? 0, bindingDigest: retirementDigest(binding),
    preparedRevision: current.event.sequence, preparedDigest: current.digest, source: sourceIdentity(source, binding),
    ...(latest ? { saved: DoneRetirementGrant.parse(JSON.parse(latest.value!)).input } : {}) };
}

export async function assertDoneRetirement(prisma: RetirementDatabase, config: ServerConfig, taskId: string, sessionId: string, issueId: string, reference?: z.infer<typeof RetirementReference>) {
  const event = await latestDoneRetirement(prisma, taskId, sessionId);
  if (!event?.value) throw new Error("Done retirement supplement is missing");
  if (await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source: `owner:${taskId}`, action: "delivered-retirement-revoked", sequence: { gt: event.sequence } } })) throw new Error("Done retirement supplement was revoked");
  const grant = DoneRetirementGrant.parse(JSON.parse(event.value));
  const digest = retirementDigest(grant);
  if (reference && (reference.revision !== event.sequence || reference.digest !== digest)) throw new Error("Done retirement supplement was replaced");
  const current = await retirementBinding(prisma, config, taskId, issueId);
  assertRetirementBinding(current, grant.binding);
  const prior = await preparation(prisma, taskId, sessionId, grant.preparedRevision);
  assertPreparedBinding(prior.prepared, current);
  if (prior.digest !== grant.preparedDigest || prior.prepared.contractRevision !== current.contractRevision || prior.prepared.taskWorktree !== current.taskWorktree || prior.prepared.branch !== current.branch) throw new Error("Done retirement original preparation changed");
  return { grant, prepared: prior.prepared, reference: { revision: event.sequence, digest } };
}

export async function adoptDoneRetirement(input: Context & { retirement: z.infer<typeof DoneRetirementInput> }, dependencies = doneRetirementDependencies) {
  const request = DoneRetirementInput.parse(input.retirement);
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Done retirement requires the original primary");
  const sessionId = task.primarySessionId, where = { runtimeSessionId: sessionId, source: `owner:${task.id}`, action: DONE_RETIREMENT };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where: { ...where, key: request.requestKey } });
  if (prior) {
    const saved = DoneRetirementGrant.parse(JSON.parse(prior.value!));
    if (retirementDigest(saved.input) !== retirementDigest(request)) throw new Error("Done retirement requestKey belongs to another decision");
    const active = await assertDoneRetirement(input.prisma, input.config, task.id, sessionId, saved.binding.issueId, { revision: prior.sequence, digest: retirementDigest(saved) });
    sourceIdentity(await dependencies.source({ ...input, sessionId }), active.grant.binding);
    return { revision: prior.sequence, digest: retirementDigest(saved), preparedRevision: saved.preparedRevision };
  }
  const inspected = await inspectDoneRetirement(input, dependencies);
  if (inspected.revision !== request.expectedRevision || inspected.bindingDigest !== request.expectedBindingDigest || inspected.preparedRevision !== request.preparedRevision || inspected.preparedDigest !== request.preparedDigest || retirementDigest(inspected.source) !== retirementDigest(request.source)) throw new Error("Done retirement adoption was based on stale evidence");
  const binding = await retirementBinding(input.prisma, input.config, task.id, request.source.issueId, true);
  const { prepared, digest } = await preparation(input.prisma, task.id, sessionId, request.preparedRevision);
  const contract = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: binding.contractRevision } });
  const policy = JSON.parse(contract.value!);
  const url = prepared.delivery.receipts.pullRequest.url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!url || policy.repository !== url[1] || policy.pullRequest && policy.pullRequest !== Number(url[2]) || !prepared.delivery.receipts.verification.matched) throw new Error("Prepared delivery no longer matches its accepted contract");
  const delivery = RetirementDelivery.parse({ repository: url[1], pullRequest: Number(url[2]), head: prepared.revision, mergeCommit: prepared.delivery.receipts.merge.sha, baseBranch: policy.baseBranch });
  const remote = await dependencies.remote(delivery, prepared.branch, policy.reviewRequired ?? false);
  if (await realpath(getRepositoryConfig(input.config, binding.repositoryId).root) !== prepared.gitCwd || await realpath(prepared.gitDirectory) !== prepared.gitDirectory || await realpath(await finalizationGit(prepared.gitCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== prepared.gitDirectory) throw new Error("Prepared cleanup repository identity changed");
  if (await worktreeIsMissing(prepared.worktree)) await assertFinalizationRemoved(prepared);
  else {
    if (await realpath(binding.taskWorktree) !== prepared.worktree || await realpath(await finalizationGit(prepared.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== prepared.gitDirectory || retirementDigest(await dependencies.snapshot(prepared.worktree)) !== retirementDigest(prepared.delivery.receipts.snapshot)) throw new Error("Prepared original worktree changed before Done retirement");
    const entries = finalizationWorktrees(await finalizationGit(prepared.gitCwd, ["--git-dir", prepared.gitDirectory, "worktree", "list", "--porcelain", "-z"])).filter(entry => entry.worktree === prepared.registeredWorktree);
    if (entries.length !== 1 || entries[0]!.HEAD !== prepared.revision || entries[0]!.branch !== `refs/heads/${prepared.branch}`) throw new Error("Prepared original worktree registration changed");
  }
  assertPreparedBinding(prepared, binding);
  sourceIdentity(await dependencies.source({ ...input, sessionId }), binding, request.source);
  const grant = DoneRetirementGrant.parse({ version: 1, input: request, binding, delivery, baseHead: remote.baseHead, preparedRevision: request.preparedRevision, preparedDigest: digest });
  return input.prisma.$transaction(async tx => {
    const latest = await latestDoneRetirement(tx, task.id, sessionId);
    if ((latest?.sequence ?? 0) !== request.expectedRevision) throw new Error("Done retirement changed during adoption; replay the same request");
    if (retirementDigest(await retirementBinding(tx, input.config, task.id, binding.issueId, true)) !== request.expectedBindingDigest || (await preparation(tx, task.id, sessionId, request.preparedRevision)).digest !== request.preparedDigest) throw new Error("Done retirement task or preparation changed during adoption");
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where, key: request.requestKey, value: JSON.stringify(grant) } });
    await tx.remoteTask.update({ where: { id: task.id }, data: { phase: "complete" } });
    return { revision: event.sequence, digest: retirementDigest(grant), preparedRevision: request.preparedRevision };
  });
}

export async function observeDoneRetirement(input: Context & { sessionId: string; requestKey: string }, source: Awaited<ReturnType<typeof linkedSourceIssue>>, dependencies = doneRetirementDependencies) {
  const current = await assertDoneRetirement(input.prisma, input.config, input.taskId, input.sessionId, source.issue.id);
  if (current.prepared.requestKey !== input.requestKey || source.issue.state.id !== current.grant.input.source.stateId) throw new Error("Done retirement finalization or source identity changed");
  sourceIdentity(source, current.grant.binding);
  const contract = await input.prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: current.grant.binding.contractRevision } });
  await dependencies.remote(current.grant.delivery, current.prepared.branch, JSON.parse(contract.value!).reviewRequired ?? false);
  const refreshed = await dependencies.source(input);
  sourceIdentity(refreshed, current.grant.binding);
  if (refreshed.issue.state.id !== source.issue.state.id) throw new Error("Done retirement source changed during observation");
  await assertDoneRetirement(input.prisma, input.config, input.taskId, input.sessionId, source.issue.id, current.reference);
  return current.reference;
}
