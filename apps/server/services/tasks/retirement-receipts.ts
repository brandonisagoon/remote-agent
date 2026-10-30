import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { normalizeRetirementPreviewTransition } from "./retirement-preview.ts";

export const RETIREMENT_AUTHORITY = "completion-retirement-authority";
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const RetirementReference = z.object({ revision: z.number().int().positive(), digest: Digest }).strict();
export const RetirementDelivery = z.object({ repository: z.string().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/), pullRequest: z.number().int().positive(),
  head: Sha, mergeCommit: Sha, baseBranch: z.string().min(1).max(200) }).strict();
const Resource = z.object({ id: z.string(), key: z.string(), kind: z.string(), purpose: z.string(), externalId: z.string(),
  state: z.string(), expiresAt: z.string().nullable(), metadata: z.unknown() }).strict();
export const RetirementBinding = z.object({ taskId: z.string(), sessionId: z.string(), repositoryId: z.string(), machineId: z.string(),
  connectionId: z.string(), issueIdentifier: z.string(), issueId: z.string(), taskWorktree: z.string(), branch: z.string(), baseCommit: z.string().nullable(),
  toolingRoot: z.string(), toolingRevision: z.string(), pinnedToolingRoot: z.string().nullable(),
  contractRevision: z.number().int().positive(), contractDigest: Digest, verificationRevision: z.number().int().positive(), verificationDigest: Digest,
  resources: z.array(Resource).max(1000) }).strict();
export const RetirementGrant = z.object({ version: z.literal(1), action: z.literal("authorize"), input: z.unknown(), binding: RetirementBinding,
  delivery: RetirementDelivery, baseHead: Sha, deliveryDigest: Digest }).strict();
export type RetirementGrant = z.infer<typeof RetirementGrant>;
export type RetirementBinding = z.infer<typeof RetirementBinding>;
export type RetirementDatabase = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeMetadataEvent" | "runtimeSessionResourceLink" | "remoteTaskResource">;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function retirementDigest(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function latestRetirement(prisma: RetirementDatabase, taskId: string, sessionId: string) {
  return prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, action: RETIREMENT_AUTHORITY, source: `owner:${taskId}` }, orderBy: { sequence: "desc" } });
}

/** Metadata paths, provider identities and archives stay pinned. Lifecycle
 * adapters may append observations, but those annotations confer no authority. */
function stableMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { observed: _observed, observedAt: _observedAt, ...stable } = value as Record<string, unknown>;
  return stable;
}

export async function retirementBinding(prisma: RetirementDatabase, config: ServerConfig, taskId: string, issueId: string): Promise<RetirementBinding> {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const session = task.primarySessionId && await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!session || session.role !== "primary" || session.status === "closed" || task.phase !== "complete" || task.ownerPaused || !task.worktreePath || !task.connectionId || !task.issueIdentifier
    || task.machineId !== config.machine || session.machineId !== task.machineId || session.repositoryId !== task.repositoryId || session.cwd !== task.worktreePath) throw new Error("Retirement requires the open complete task's original primary");
  const link = await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: session.id, provider: "linear", connectionId: task.connectionId, externalId: task.issueIdentifier, resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  if (!link) throw new Error("Retirement source ownership changed");
  const where = { runtimeSessionId: session.id, source: `owner:${task.id}` };
  const contract = await prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  const verification = await prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "completion-verification" }, orderBy: { sequence: "desc" } });
  if (!contract || JSON.parse(contract.value ?? "null")?.boundary !== "merge" || !verification) throw new Error("Retirement requires existing merge authority and accepted verification");
  const accepted = JSON.parse(verification.value ?? "null");
  if (accepted?.contractRevision !== contract.sequence || accepted?.verification?.passed !== true) throw new Error("Retirement verification is missing, stale or unsuccessful");
  const resources = await prisma.remoteTaskResource.findMany({ where: { taskId }, orderBy: { id: "asc" } });
  return RetirementBinding.parse({ taskId, sessionId: session.id, repositoryId: task.repositoryId, machineId: task.machineId, connectionId: task.connectionId, issueIdentifier: task.issueIdentifier, issueId,
    taskWorktree: task.worktreePath, branch: task.branchName, baseCommit: task.baseCommit, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot,
    contractRevision: contract.sequence, contractDigest: retirementDigest(JSON.parse(contract.value!)), verificationRevision: verification.sequence, verificationDigest: retirementDigest(accepted),
    resources: resources.map(resource => ({ id: resource.id, key: resource.key, kind: resource.kind, purpose: resource.purpose, externalId: resource.externalId,
      state: resource.state, expiresAt: resource.expiresAt?.toISOString() ?? null, metadata: stableMetadata(resource.metadata) })) });
}

export async function assertRetirementAuthority(prisma: RetirementDatabase, config: ServerConfig, taskId: string, sessionId: string, issueId: string, reference?: z.infer<typeof RetirementReference>) {
  const event = await latestRetirement(prisma, taskId, sessionId);
  const grant = event && RetirementGrant.safeParse(JSON.parse(event.value ?? "null"));
  if (!event || !grant || !grant.success) throw new Error("Retirement owner authorization is missing or revoked");
  const digest = retirementDigest(grant.data);
  if (reference && (reference.revision !== event.sequence || reference.digest !== digest)) throw new Error("Retirement owner authorization was revoked or replaced");
  const current = await retirementBinding(prisma, config, taskId, issueId);
  const expected = grant.data.binding;
  if (current.sessionId !== sessionId || expected.sessionId !== sessionId) throw new Error("Retirement primary identity changed");
  // Release is the only terminal transition accepted from a frozen resource.
  // Newly added or rebound resources and resurrected released receipts fail.
  if (current.resources.length !== expected.resources.length || current.resources.some((resource, index) => {
    const saved = expected.resources[index]!;
    return saved.state === "released" && resource.state !== "released" || retirementDigest({ ...resource, state: saved.state, metadata: normalizeRetirementPreviewTransition(saved, resource, expected.resources, current.resources) }) !== retirementDigest(saved);
  }) || retirementDigest({ ...current, resources: expected.resources }) !== retirementDigest(expected)) throw new Error("Retirement task, resource, tooling or verification binding changed");
  return { grant: grant.data, reference: { revision: event.sequence, digest } };
}
