import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, RemoteTask } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { cleanupFamily } from "./closed-cleanup.ts";
import type { CompletionDelivery, PreparedFinalization } from "./finalization-receipts.ts";
import { PreparationDiagnosticError } from "./preparation-errors.ts";

export const LocalCompletion = z.object({ kind: z.literal("local-completion/v1"), boundary: z.enum(["research", "local-only"]),
  verificationRevision: z.number().int().positive(), verificationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCaptureRequired: z.boolean(),
}).strict();
export type LocalCompletion = z.infer<typeof LocalCompletion>;
type Store = Pick<PrismaClient, "remoteTask" | "runtimeMetadataEvent" | "runtimeSessionResourceLink">;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function assertLocalCleanupFamily(prisma: Pick<PrismaClient, "runtimeSession" | "runtimeInstruction" | "runtimeLifecycleEvent">, task: RemoteTask,
  runtime?: Pick<AgentSessionRuntime, "observeSessionActivity">) {
  const family = await cleanupFamily(prisma, task, task.primarySessionId!);
  if (family.some(session => session.id !== task.primarySessionId && (!["idle", "closed"].includes(session.status)
    || runtime?.observeSessionActivity && runtime.observeSessionActivity(session.id).state !== "unknown"))) throw new PreparationDiagnosticError("AUTHORITY_CHANGED");
  const instructions = await prisma.runtimeInstruction.findMany({ where: { sessionId: { in: family.map(session => session.id) }, state: { in: ["preparing", "queued", "dispatching", "unknown"] } }, orderBy: { sequence: "asc" }, take: 2 });
  const turn = await prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: task.primarySessionId! }, orderBy: { sequence: "desc" } });
  if (instructions.length && (instructions.length !== 1 || instructions[0]!.sessionId !== task.primarySessionId || instructions[0]!.state !== "dispatching"
    || !instructions[0]!.executionRequestId || turn?.phase !== "started" || turn.requestId !== instructions[0]!.executionRequestId)) throw new PreparationDiagnosticError("AUTHORITY_CHANGED");
}

/** The existing bearer-authenticated completion records are the authority.
 * Absence of a source issue is an exact original identity, not a fallback for
 * broken linked ownership. No publication or model progress creates this. */
export async function readLocalCompletion(prisma: Store, taskId: string, sessionId: string) {
  const task = await prisma.remoteTask.findUniqueOrThrow({ where: { id: taskId } });
  if (task.primarySessionId !== sessionId || task.connectionId !== null || task.issueIdentifier !== null
    || await prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: sessionId, provider: "linear", resourceType: "issue-identifier", relationship: "handles" } })) throw new PreparationDiagnosticError("LOCAL_COMPLETION_IDENTITY");
  const where = { runtimeSessionId: sessionId, source: `owner:${taskId}` };
  const contract = await prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "completion-contract" }, orderBy: { sequence: "desc" } });
  const policy = z.object({ boundary: z.enum(["research", "local-only"]) }).passthrough().safeParse(JSON.parse(contract?.value ?? "null"));
  if (!contract || !policy.success) throw new PreparationDiagnosticError("LOCAL_COMPLETION_REQUIRED");
  const verification = await prisma.runtimeMetadataEvent.findFirst({ where: { ...where, action: "completion-verification" }, orderBy: { sequence: "desc" } });
  const verified = z.object({ contractRevision: z.number().int(), verification: z.object({ passed: z.literal(true), evidence: z.array(z.string().min(1)).min(1) }),
    snapshot: z.object({ head: z.string(), branch: z.string(), clean: z.boolean(), fingerprint: z.string() }) }).safeParse(JSON.parse(verification?.value ?? "null"));
  if (!verification?.value || !verified.success || verified.data.contractRevision !== contract.sequence) throw new PreparationDiagnosticError("VERIFICATION_MISSING");
  return { contract, verification, verified: verified.data, reference: LocalCompletion.parse({ kind: "local-completion/v1", boundary: policy.data.boundary,
    verificationRevision: verification.sequence, verificationDigest: digest(verification.value), sourceCaptureRequired: false }) };
}

export async function assertLocalCompletion(prisma: Store, prepared: PreparedFinalization) {
  if (!prepared.localCompletion) throw new PreparationDiagnosticError("LOCAL_COMPLETION_REQUIRED");
  const current = await readLocalCompletion(prisma, prepared.taskId, prepared.sessionId), receipt = prepared.delivery.receipts;
  if (prepared.connectionId !== null || prepared.issueIdentifier !== null || prepared.issueId !== null
    || current.contract.sequence !== prepared.contractRevision || JSON.stringify({ ...current.reference, sourceCaptureRequired: prepared.localCompletion.sourceCaptureRequired }) !== JSON.stringify(prepared.localCompletion)
    || prepared.revision !== receipt.snapshot.head || prepared.branch !== receipt.snapshot.branch
    || current.verified.snapshot.fingerprint !== receipt.snapshot.fingerprint || JSON.stringify(current.verified.snapshot) !== JSON.stringify(receipt.snapshot)) throw new PreparationDiagnosticError("AUTHORITY_CHANGED");
  assertLocalDelivery(prepared.delivery, prepared.localCompletion, prepared.contractRevision);
  return current;
}

export function assertLocalDelivery(delivery: CompletionDelivery, local: LocalCompletion, contractRevision: number) {
  const receipt = delivery.receipts;
  if (delivery.boundary !== local.boundary || receipt.contractRevision !== contractRevision || !receipt.verification.matched
    || !receipt.snapshot.clean || !receipt.commit.clean || !receipt.commit.observed || receipt.commit.sha !== receipt.snapshot.head
    || receipt.push.observed || receipt.pullRequest.observed || receipt.pullRequest.url !== null || receipt.merge.observed || receipt.merge.merged || receipt.merge.sha !== null) throw new PreparationDiagnosticError("LOCAL_COMPLETION_UNSAFE");
}
