import type { PrismaClient } from "../../../../generated/prisma/client.ts";

type Database = Pick<PrismaClient, "remoteTask" | "remoteTaskResource">;
/** Numeric process identities are host-local. An unresolved second claim is
 * preserved even if one claimant has already ended its session. */
export async function assertConnectorOwnership(prisma: Database, taskId: string, machineId: string, candidate?: { key: string; externalId: string }) {
  const own = candidate ? [candidate] : await prisma.remoteTaskResource.findMany({ where: { taskId, kind: "cloudflared-connector" }, select: { key: true, externalId: true } });
  if (!own.length) return;
  const tasks = await prisma.remoteTask.findMany({ where: { machineId }, select: { id: true } });
  const claims = await prisma.remoteTaskResource.findMany({ where: { taskId: { in: tasks.map(task => task.id) }, kind: "cloudflared-connector", state: { not: "released" }, externalId: { in: own.map(resource => resource.externalId) } }, select: { taskId: true, key: true, externalId: true } });
  if (own.some(resource => claims.some(claim => claim.externalId === resource.externalId && (claim.taskId !== taskId || claim.key !== resource.key)))) throw new Error("Connector has another unresolved owner on this host; preserve it");
}
