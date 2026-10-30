import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
export const DELIVERED_RETIREMENT_REVOKED = "delivered-retirement-revoked";
export const DeliveredRetirementRevocation = z.object({ requestKey: z.string().trim().min(1).max(180), expectedRevision: z.number().int().positive(), basis: z.string().trim().min(1).max(4000) }).strict();
export async function revokeDeliveredRetirement(input: { prisma: PrismaClient; taskId: string; revocation: z.infer<typeof DeliveredRetirementRevocation> }) {
  const request = DeliveredRetirementRevocation.parse(input.revocation);
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: input.taskId } });
  if (!task.primarySessionId) throw new Error("Delivered retirement has no original primary");
  const where = { runtimeSessionId: task.primarySessionId, source: `owner:${task.id}` };
  return input.prisma.$transaction(async tx => {
    const prior = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: DELIVERED_RETIREMENT_REVOKED, key: request.requestKey } });
    if (prior) { if (prior.value !== JSON.stringify(request)) throw new Error("Revocation requestKey belongs to another decision"); return { revision: prior.sequence }; }
    const latest = await tx.runtimeMetadataEvent.findFirst({ where: { ...where, action: { in: ["prepared-done-retirement", "external-delivery-binding", DELIVERED_RETIREMENT_REVOKED] } }, orderBy: { sequence: "desc" } });
    if (latest?.sequence !== request.expectedRevision) throw new Error("Delivered retirement changed before revocation");
    const event = await tx.runtimeMetadataEvent.create({ data: { ...where, action: DELIVERED_RETIREMENT_REVOKED, key: request.requestKey, value: JSON.stringify(request) } });
    return { revision: event.sequence };
  });
}
