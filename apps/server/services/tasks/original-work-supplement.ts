import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { finalizationDigest, finalizationResourceObservation, type ResourceObservation } from "./finalization-resources.ts";
import { FINALIZATION_PREPARED } from "./finalization-receipts.ts";
import { type PreparedExternalFinalization } from "./external-finalization-schema.ts";
import { OriginalAdministrationProof, OriginalAdministrationReceipt } from "./original-work-schema.ts";
import { assertOriginalAdministration, prepareOriginalAdministration, originalAdministrationAlreadyRetired } from "./original-work-administration.ts";

export const ORIGINAL_ADMINISTRATION = "finalization-original-administration";
type Database = Pick<PrismaClient, "runtimeMetadataEvent">;
const scope = (prepared: PreparedExternalFinalization) => ({ runtimeSessionId: prepared.sessionId, source: `finalizer-original:${prepared.taskId}`, action: ORIGINAL_ADMINISTRATION, key: prepared.requestKey });
async function preparation(db: Database, prepared: PreparedExternalFinalization, revision: number) {
  const event = await db.runtimeMetadataEvent.findUnique({ where: { sequence: revision } });
  if (!event?.value || event.action !== FINALIZATION_PREPARED || event.runtimeSessionId !== prepared.sessionId || event.source !== `finalizer:${prepared.taskId}` || event.key !== prepared.requestKey
    || finalizationDigest(JSON.parse(event.value)) !== finalizationDigest(prepared)) throw new Error("Original administration requires its unchanged historical preparation");
  return event;
}

/** Database-only projection. This extension never replaces the preparation or
 * accepted binding, and grants no independent execution authority. */
export async function originalAdministrationReceipt(db: Database, prepared: PreparedExternalFinalization, preparedRevision: number) {
  const event = await db.runtimeMetadataEvent.findFirst({ where: scope(prepared) });
  if (!event) return undefined;
  if (!prepared.originalWork || prepared.originalWork.administration) throw new Error("Unexpected original administration supplement");
  const original = await preparation(db, prepared, preparedRevision), proof = OriginalAdministrationProof.parse(JSON.parse(event.value!));
  if (proof.taskId !== prepared.taskId || proof.sessionId !== prepared.sessionId || proof.requestKey !== prepared.requestKey || proof.preparedRevision !== preparedRevision
    || proof.preparedDigest !== finalizationDigest(JSON.parse(original.value!)) || proof.originalWorkDigest !== finalizationDigest(prepared.originalWork)) throw new Error("Original administration supplement belongs to another preparation");
  return OriginalAdministrationReceipt.parse({ revision: event.sequence, digest: finalizationDigest(proof), proof });
}

export async function ensureOriginalAdministration(input: { prisma: PrismaClient; prepared: PreparedExternalFinalization; preparedRevision: number; removed: boolean; create: boolean;
  assertAuthority: (db: PrismaClient) => Promise<void>; observation?: ResourceObservation }) {
  const { prepared, preparedRevision } = input, original = prepared.originalWork;
  if (!original || original.administration) return undefined;
  const observation = input.observation ?? finalizationResourceObservation;
  const existing = await originalAdministrationReceipt(input.prisma, prepared, preparedRevision);
  if (existing) {
    if (existing.proof.administration) await assertOriginalAdministration({ taskId: prepared.taskId, originalWork: original, administration: existing.proof.administration, removed: input.removed }, observation);
    else if (!await originalAdministrationAlreadyRetired(prepared.taskId, original)) throw new Error("Historical original retirement changed");
    return existing;
  }
  // Historical receipts whose exact source is already captured and registration
  // independently absent remain confirmable. No fictitious admin capture is made.
  const alreadyRetired = await originalAdministrationAlreadyRetired(prepared.taskId, original);
  if (!input.create) {
    if (alreadyRetired) return undefined;
    throw new Error("Original administration requires a full preparation supplement before retirement");
  }
  if (input.removed && !alreadyRetired) throw new Error("Original administration retirement is incomplete");
  const administration = alreadyRetired ? null : await prepareOriginalAdministration(prepared.taskId, original);
  if (administration) await assertOriginalAdministration({ taskId: prepared.taskId, originalWork: original, administration, removed: false }, observation);
  await input.assertAuthority(input.prisma);
  const proof = OriginalAdministrationProof.parse({ version: 1, taskId: prepared.taskId, sessionId: prepared.sessionId, requestKey: prepared.requestKey,
    preparedRevision, preparedDigest: finalizationDigest(prepared), originalWorkDigest: finalizationDigest(original), administration });
  // All expensive physical observations finished above. Only local authority and
  // immutable receipt CAS run in this transaction; unique index prevents forks.
  return input.prisma.$transaction(async tx => {
    await input.assertAuthority(tx as PrismaClient);
    await preparation(tx, prepared, preparedRevision);
    const prior = await originalAdministrationReceipt(tx, prepared, preparedRevision);
    if (prior) throw new Error("Original administration was supplemented concurrently; retry the same preparation");
    const event = await tx.runtimeMetadataEvent.create({ data: { ...scope(prepared), value: JSON.stringify(proof) } });
    return OriginalAdministrationReceipt.parse({ revision: event.sequence, digest: finalizationDigest(proof), proof });
  });
}
