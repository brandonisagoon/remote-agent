import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { CleanupTarget } from "./cleanup-observer-schema.ts";
import { finalizationResourceIdentity, type FinalizationResourcePlan } from "./finalization-resources.ts";

type Clerk = Extract<CleanupTarget, { kind: "clerk-user" | "clerk-session" }>;
const metadata = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type ClerkSelection = { resourceId: string; purpose: string; identityDigest: string; kind: Clerk["kind"]; id: string; userId?: string };

/** Local registry checks supplement provider identity. A legacy user's external
 * ID may be its email, so provider IDs in the recorded metadata must also be
 * considered. These reads grant no effect and perform no provider IO. */
export async function assertClerkCleanupSharing(prisma: Pick<PrismaClient, "remoteTaskResource">, taskId: string, plan: FinalizationResourcePlan[]) {
  const selected = plan.flatMap(entry => entry.disposition === "retire-adapter" && entry.adapter === "clerk"
    ? entry.targets.filter((target): target is Clerk => target.kind === "clerk-user" || target.kind === "clerk-session").map(target => ({ entry, target })) : []);
  for (const { entry, target } of selected) if (target.scope.taskId !== taskId || target.scope.purpose !== entry.purpose) throw new Error("Clerk target belongs to another task or purpose");
  await assertClerkResourceSharing(prisma, taskId, selected.map(({ entry, target }) => ({ resourceId: entry.id, purpose: entry.purpose,
    identityDigest: entry.identityDigest, kind: target.kind, id: target.id, ...(target.kind === "clerk-session" ? { userId: target.userId } : {}) })));
}

/** The same bounded registry check also protects exact v1 receipt scopes. It
 * does not manufacture a provider target or replace its independent observer. */
export async function assertClerkResourceSharing(prisma: Pick<PrismaClient, "remoteTaskResource">, taskId: string, selected: ClerkSelection[]) {
  if (!selected.length) return;
  const records = await prisma.remoteTaskResource.findMany({ where: { kind: { in: ["clerk-test-user", "clerk-test-session"] }, state: { not: "released" } },
    take: 10001, select: { id: true, taskId: true, key: true, kind: true, purpose: true, externalId: true, state: true, expiresAt: true, metadata: true } });
  if (records.length > 10000) throw new Error("Clerk ownership inventory exceeds its bounded scope");
  for (const target of selected) {
    for (const record of records) {
      const meta = metadata(record.metadata);
      const user = record.kind === "clerk-test-user" ? record.externalId.startsWith("user_") ? record.externalId : meta.clerkUserId : meta.userId;
      const claims = record.kind === "clerk-test-user" ? [record.externalId, meta.clerkUserId] : [meta.userId];
      const matches = target.kind === "clerk-user" ? claims.includes(target.id) : record.kind === "clerk-test-session" && record.externalId === target.id;
      if (!matches) continue;
      const own = selected.find(item => item.resourceId === record.id);
      if (record.taskId !== taskId || record.purpose !== target.purpose || !own || finalizationResourceIdentity(record).identityDigest !== own.identityDigest
        || (record.kind === "clerk-test-user" ? own.kind !== "clerk-user" || own.id !== user
          : own.kind !== "clerk-session" || own.id !== record.externalId || own.userId !== user)) throw new Error("Clerk authentication identity is shared with another active resource");
    }
  }
}
