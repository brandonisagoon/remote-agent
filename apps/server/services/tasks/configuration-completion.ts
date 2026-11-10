import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { CompletionDelivery, PreparedFinalization } from "./finalization-receipts.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/), Commit = z.string().regex(/^[a-f0-9]{40}$/);
export const ConfigurationCompletion = z.strictObject({ kind: z.literal("configuration-completion/v1"), baseCommit: Commit,
  verificationRevision: z.number().int().positive(), verificationDigest: Hash });
export type ConfigurationCompletion = z.infer<typeof ConfigurationCompletion>;
type Store = Pick<PrismaClient, "remoteTask" | "runtimeMetadataEvent" | "runtimeSessionResourceLink">;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** An explicit owner contract supplies non-PR scope. A missing PR or clean
 * checkout never selects this path, and unlinked local completion is separate. */
export async function readConfigurationCompletion(prisma: Store, taskId: string, sessionId: string) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  const source = "owner:" + taskId;
  const contract = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  if (JSON.parse(contract?.value ?? "null")?.boundary !== "configuration-only") return null;
  if (!contract || task.primarySessionId !== sessionId || !task.connectionId || !task.issueIdentifier || !Commit.safeParse(task.baseCommit).success
    || !await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: sessionId, provider: "linear", connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", ...(task.phase === "closed" ? {} : { endedAt: null }) } })) throw new Error("Configuration completion requires its original linked task and recorded base commit");
  const policy = JSON.parse(contract.value!);
  if (policy.verificationRequired !== true || policy.reviewRequired === true || policy.pullRequest !== undefined) throw new Error("Configuration completion cannot waive verification or stand in for PR review");
  const verification = await prisma.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: sessionId, source, action: "completion-verification" }, orderBy: { sequence: "desc" } });
  const verified = z.object({ contractRevision: z.number().int(), verification: z.object({ passed: z.literal(true), evidence: z.array(z.string().min(1)).min(1) }),
    snapshot: z.object({ head: Commit, branch: z.string(), clean: z.literal(true), fingerprint: z.string() }) }).safeParse(JSON.parse(verification?.value ?? "null"));
  if (!verification?.value || !verified.success || verified.data.contractRevision !== contract.sequence || verified.data.snapshot.head !== task.baseCommit
    || verified.data.snapshot.branch !== task.branchName) throw new Error("Configuration completion requires current owner verification of unchanged product source at its original base");
  return { task, contract, verified: verified.data, reference: ConfigurationCompletion.parse({ kind: "configuration-completion/v1",
    baseCommit: task.baseCommit, verificationRevision: verification.sequence, verificationDigest: digest(verification.value) }) };
}

export function assertConfigurationDelivery(delivery: CompletionDelivery, reference: ConfigurationCompletion, revision: number) {
  const receipt = delivery.receipts;
  if (delivery.boundary !== "configuration-only" || receipt.contractRevision !== revision || !receipt.verification.matched || !receipt.snapshot.clean
    || receipt.snapshot.head !== reference.baseCommit || !receipt.commit.observed || !receipt.commit.clean || receipt.commit.sha !== reference.baseCommit
    || receipt.push.observed || receipt.pullRequest.observed || receipt.pullRequest.url !== null || receipt.review.observed
    || receipt.merge.observed || receipt.merge.merged || receipt.merge.sha !== null) throw new Error("Configuration-only delivery cannot claim a commit, PR or merge beyond its verified unchanged base");
}

export async function assertConfigurationCompletion(prisma: Store, prepared: PreparedFinalization) {
  const current = await readConfigurationCompletion(prisma, prepared.taskId, prepared.sessionId);
  if (!prepared.configurationCompletion || !current || current.contract.sequence !== prepared.contractRevision
    || JSON.stringify(current.reference) !== JSON.stringify(prepared.configurationCompletion)
    || prepared.connectionId !== current.task.connectionId || prepared.issueIdentifier !== current.task.issueIdentifier || !prepared.issueId
    || prepared.revision !== current.task.baseCommit || prepared.branch !== current.task.branchName
    || JSON.stringify(current.verified.snapshot) !== JSON.stringify(prepared.delivery.receipts.snapshot)) throw new Error("Configuration completion authority, source or verified work changed");
  assertConfigurationDelivery(prepared.delivery, current.reference, current.contract.sequence);
}
