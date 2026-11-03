import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ClosedFamilyScope } from "../../../../types/runtime/closed-family.ts";
type Canonical<T> = T extends Date ? string : T extends readonly (infer U)[] ? Canonical<U>[] : T extends object ? {
    [K in keyof T]: Canonical<T[K]>;
} : T;
export function canonical<T>(value: T): Canonical<T>;
export function canonical(v: unknown): unknown {
    return Array.isArray(v) ? v.map(canonical) : v instanceof Date ? v.toISOString() : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
}
export const closedFamilyDigest = (v: unknown) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
export const closedTextDigest = (text: string) => createHash("sha256").update(text).digest("hex");
export type OwnershipStore = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionRelation">;
export async function requireClosedTask(db: Pick<PrismaClient, "remoteTask">, scope: ClosedFamilyScope, host: string) {
    const task = await db.remoteTask.findUniqueOrThrow({ where: { id: scope.taskId } });
    if (task.phase !== "closed" || task.ownerPaused || task.primarySessionId !== scope.primarySessionId || task.repositoryId !== scope.repositoryId || task.machineId !== scope.machineId || task.machineId !== host || task.worktreePath !== scope.worktreePath || task.toolingRevision !== scope.toolingRevision || scope.primarySessionId === scope.delegateSessionId)
        throw Error("Exact unpaused closed-task ownership is required");
    return task;
}
/** Bind every historical parent edge touching the admitted direct family.
 * Nested, moved and cyclic families are outside this narrow operator repair. */
export async function closedFamilyRelations(db: Pick<OwnershipStore, "runtimeSessionRelation">, ids: string[]) {
    const relations = await db.runtimeSessionRelation.findMany({ where: { relationship: { in: ["spawned-by", "notifies-parent"] }, OR: [{ sourceSessionId: { in: ids } }, { targetSessionId: { in: ids } }] }, orderBy: { id: "asc" }, take: 129 });
    if (relations.length > 128)
        throw Error("Closed family relation history exceeds its bounded scope");
    return relations;
}
export async function readClosedFamilyOwnership(db: OwnershipStore, scope: ClosedFamilyScope, host: string) {
    const task = await requireClosedTask(db, scope, host);
    const directRelations = await db.runtimeSessionRelation.findMany({ where: { OR: [{ targetSessionId: scope.primarySessionId, relationship: { in: ["spawned-by", "notifies-parent"] } }, { sourceSessionId: scope.delegateSessionId, relationship: { in: ["spawned-by", "notifies-parent"] } }] }, orderBy: { id: "asc" }, take: 129 });
    if (directRelations.length > 128)
        throw Error("Closed family relation history exceeds its bounded scope");
    const links = directRelations.filter(r => r.sourceSessionId === scope.delegateSessionId && r.relationship === "spawned-by");
    if (links.length !== 1 || links[0]!.targetSessionId !== scope.primarySessionId || links[0]!.endedAt)
        throw Error("Original live delegate provenance is required");
    if (directRelations.some(r => r.sourceSessionId === scope.delegateSessionId && r.targetSessionId !== scope.primarySessionId))
        throw Error("Selected delegate has foreign parent provenance");
    const ids = [...new Set([scope.primarySessionId, ...directRelations.filter(r => r.relationship === "spawned-by" && r.targetSessionId === scope.primarySessionId).map(r => r.sourceSessionId)])].sort();
    if (ids.length > 32)
        throw Error("Closed family exceeds its bounded reconciliation scope");
    const relations = await closedFamilyRelations(db, ids);
    if (relations.some(r => r.sourceSessionId === scope.primarySessionId || r.targetSessionId !== scope.primarySessionId || !ids.includes(r.sourceSessionId)))
        throw Error("Nested, moved or cyclic family provenance requires separate reconciliation");
    const sessions = await db.runtimeSession.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    if (sessions.length !== ids.length)
        throw Error("Original family session is missing");
    for (const session of sessions) {
        if (session.repositoryId !== scope.repositoryId || session.machineId !== host || session.cwd !== scope.worktreePath || !["idle", "closed"].includes(session.status))
            throw Error("Closed family contains a foreign or unsettled session");
        if (session.id === scope.primarySessionId && (session.role !== "primary" || session.status !== "closed"))
            throw Error("Original primary must already be closed");
        if (session.id === scope.delegateSessionId && (session.role !== "delegate" || session.lifecycle !== "persistent"))
            throw Error("Original persistent delegate is required");
        if (session.id !== scope.primarySessionId && session.id !== scope.delegateSessionId && session.status !== "closed")
            throw Error("Another original delegate remains unsettled");
    }
    return { task: { id: task.id, primarySessionId: task.primarySessionId, repositoryId: task.repositoryId, machineId: task.machineId, worktreePath: task.worktreePath, toolingRoot: task.toolingRoot, toolingRevision: task.toolingRevision, phase: task.phase, ownerPaused: task.ownerPaused, branchName: task.branchName, baseCommit: task.baseCommit, updatedAt: task.updatedAt }, relations,
        sessions: sessions.map(s => ({ id: s.id, role: s.role, lifecycle: s.lifecycle, repositoryId: s.repositoryId, machineId: s.machineId, cwd: s.cwd, status: s.status, closedAt: s.closedAt, updatedAt: s.updatedAt, acpxRecordId: s.acpxRecordId, acpxSessionId: s.acpxSessionId, agentSessionId: s.agentSessionId })), ids };
}
