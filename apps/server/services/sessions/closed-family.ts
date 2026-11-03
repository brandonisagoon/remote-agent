import { z } from "zod";
import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import type { ClosedFamilyScope, ClosedProviderEvidence, ClosedFamilyReservation } from "../../../../types/runtime/closed-family.ts";
import { canonical, closedFamilyRelations, closedFamilyDigest as digest, readClosedFamilyOwnership, requireClosedTask, closedTextDigest as textDigest } from "./closed-family-ownership.ts";
const Hash = z.string().regex(/^[a-f0-9]{64}$/), Id = z.string().min(1).max(200);
const Selection = z.strictObject({ primarySessionId: Id, delegateSessionId: Id, repositoryId: Id, machineId: Id, worktreePath: z.string().refine(v => path.isAbsolute(v) && path.normalize(v) === v), toolingRevision: z.string().regex(/^[a-f0-9]{40}$/) });
export const ClosedFamilyPrepare = z.strictObject({ requestKey: Id, scope: Selection });
export const ClosedFamilyCommit = ClosedFamilyPrepare.extend({ preparationDigest: Hash, reason: z.string().trim().min(1).max(1000), acknowledgeUnknown: z.array(z.strictObject({ id: Id, textSHA256: Hash, historyDigest: Hash, reason: z.string().trim().min(1).max(1000) })).max(100).default([]) });
type Store = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionRelation" | "runtimeInstruction" | "runtimeLifecycleEvent" | "runtimeMetadataEvent">;
type Context = {
    prisma: PrismaClient;
    runtime: AgentSessionRuntime;
    config: ServerConfig;
    taskId: string;
};
const source = (taskId: string) => `operator-closed-family:${taskId}`;
async function audit(db: Pick<Store, "runtimeMetadataEvent">, scope: Pick<ClosedFamilyScope, "taskId" | "primarySessionId">, key: string, action: string) {
    const rows = await db.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: scope.primarySessionId, source: source(scope.taskId), key, action }, take: 2 });
    if (rows.length > 1)
        throw Error("Closed-family receipt is ambiguous");
    return rows[0] ? JSON.parse(rows[0].value!) : null;
}
async function snapshot(db: Store, scope: ClosedFamilyScope, host: string) {
    const ownership = await readClosedFamilyOwnership(db, scope, host);
    const instructions = await db.runtimeInstruction.findMany({ where: { sessionId: scope.delegateSessionId, state: { in: ["queued", "unknown", "preparing", "dispatching", "steered"] } }, orderBy: { sequence: "asc" }, take: 201 });
    if (instructions.length > 200 || instructions.some(i => !["queued", "unknown"].includes(i.state) || i.sourceMessageId || !i.id.startsWith(`delegate-instruction:${scope.primarySessionId}:${scope.delegateSessionId}:`)))
        throw Error("Closed family has unsupported or in-flight instructions");
    if (await db.runtimeInstruction.count({ where: { sessionId: { in: ownership.ids.filter(id => id !== scope.delegateSessionId) }, state: { in: ["queued", "unknown", "preparing", "dispatching", "steered"] } } }))
        throw Error("Another original family session has unsettled instructions");
    const events = await db.runtimeLifecycleEvent.findMany({ where: { runtimeSessionId: scope.delegateSessionId, OR: instructions.map(i => ({ requestId: { startsWith: i.id } })) }, orderBy: { sequence: "asc" }, take: 1001 });
    const resolutions = await db.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: scope.delegateSessionId, action: "instruction-resolved", key: { in: instructions.map(i => i.id) } }, orderBy: { sequence: "asc" }, take: 201 });
    if (events.length > 1000 || resolutions.length > 200)
        throw Error("Instruction history exceeds bounded reconciliation scope");
    return { ownership, instructions: instructions.map(({ text, ...row }) => ({ ...row, textSHA256: textDigest(text) })), events, resolutions };
}
function text(message: unknown, role: "User" | "Agent") {
    const content = (message as any)?.[role]?.content;
    if (!Array.isArray(content))
        return "";
    return content.map((v: any) => typeof v?.Text === "string" ? v.Text : "").filter(Boolean).join("\n");
}
async function plan(db: Store, scope: ClosedFamilyScope, host: string, evidence: ClosedProviderEvidence[]) {
    const state = await snapshot(db, scope, host), provider = evidence.find(e => e.sessionId === scope.delegateSessionId);
    if (!provider)
        throw Error("Selected provider proof is missing");
    const rows = await db.runtimeInstruction.findMany({ where: { id: { in: state.instructions.map(i => i.id) } } });
    const candidates = [];
    for (const instruction of state.instructions) {
        const row = rows.find(r => r.id === instruction.id)!;
        if (!row || textDigest(row.text) !== instruction.textSHA256)
            throw Error("Instruction text changed during observation");
        const turns = state.events.filter(e => e.requestId === instruction.id || e.requestId.startsWith(instruction.id + ":retry:"));
        const retries = state.resolutions.filter(e => e.key === instruction.id);
        if (instruction.state === "queued") {
            const prompted = Date.parse(provider.lastPromptAt ?? ""), used = Date.parse(provider.lastUsedAt);
            if (row.executionRequestId || row.updatedAt.getTime() !== row.createdAt.getTime() || turns.length || retries.length || !Number.isFinite(prompted) || !Number.isFinite(used) || prompted > used || used >= row.createdAt.getTime() || used > Date.now() || provider.lastRequestId === row.id || provider.messages.some(m => text(m, "User").includes(row.text)))
                throw Error("Queued cancellation lacks never-dispatched inbox, lifecycle and provider-watermark evidence");
            candidates.push({ id: row.id, textSHA256: instruction.textSHA256, state: "queued" as const, disposition: "cancelled-never-dispatched" as const });
        }
        else {
            if (retries.length || row.executionRequestId && row.executionRequestId !== row.id || provider.lastRequestId !== row.id || turns.some(e => e.phase !== "started"))
                throw Error("Unknown instruction attempt is ambiguous or already terminal");
            const matches = provider.messages.map((m, index) => text(m, "User") === row.text ? index : -1).filter(index => index >= 0);
            const user = matches.length === 1 ? matches[0]! : -1;
            if (user < 0 || user !== provider.messages.length - 2 || !text(provider.messages[user + 1], "Agent"))
                throw Error("Unknown instruction lacks its exact final response history");
            candidates.push({ id: row.id, textSHA256: instruction.textSHA256, state: "unknown" as const, executionOutcome: "unknown" as const, historyDigest: provider.historyDigest, userDigest: digest(provider.messages[user]), responseDigest: digest(provider.messages[user + 1]) });
        }
    }
    const providers = evidence.map(({ messages, ...summary }) => summary).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const body = { version: 1, scope, state, providers, candidates };
    return { ...body, digest: digest(body) };
}
async function staticScope(ctx: Context, scope: ClosedFamilyScope) { await requireClosedTask(ctx.prisma, scope, ctx.config.machine); }
function selection(ctx: Context, input: z.infer<typeof ClosedFamilyPrepare>): ClosedFamilyScope { return { ...input.scope, taskId: ctx.taskId }; }
function reservation<T>(ctx: Context, input: ClosedFamilyReservation<T>): Promise<T> {
    if (!ctx.runtime.withClosedFamilyReservation)
        throw Error("Runtime cannot reserve and verify this closed family");
    return ctx.runtime.withClosedFamilyReservation<T>(input);
}
export async function prepareClosedFamily(ctx: Context, input: z.infer<typeof ClosedFamilyPrepare>) {
    const scope = selection(ctx, input);
    await staticScope(ctx, scope);
    const done = await audit(ctx.prisma, scope, input.requestKey, "closed-family-committed");
    if (done) {
        if (digest(done.scope) !== digest(scope))
            throw Error("Reconciliation key belongs to another owner");
        return { state: "committed" as const, receipt: await closedFamilyReceipt(ctx, input.requestKey) };
    }
    return reservation(ctx, { scope, run: async (evidence, assertUnchanged) => {
            const prepared = await plan(ctx.prisma, scope, ctx.config.machine, evidence);
            await assertUnchanged();
            return ctx.prisma.$transaction(async (tx) => {
                if (digest(await snapshot(tx, scope, ctx.config.machine)) !== digest(prepared.state))
                    throw Error("Closed family changed before preparation");
                const existing = await audit(tx, scope, input.requestKey, "closed-family-prepared");
                if (existing) {
                    if (existing.digest !== prepared.digest)
                        throw Error("Preparation is stale; use a new reviewed request key");
                    return { state: "prepared" as const, preparation: existing };
                }
                await assertUnchanged();
                await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: scope.primarySessionId, source: source(scope.taskId), key: input.requestKey, action: "closed-family-prepared", value: JSON.stringify(prepared) } });
                return { state: "prepared" as const, preparation: prepared };
            });
        } });
}
export async function commitClosedFamily(ctx: Context, input: z.infer<typeof ClosedFamilyCommit>) {
    const scope = selection(ctx, input);
    await staticScope(ctx, scope);
    const decision = { ...input, acknowledgeUnknown: [...input.acknowledgeUnknown].sort((a, b) => a.id.localeCompare(b.id)) }, decisionDigest = digest(decision);
    const done = await audit(ctx.prisma, scope, input.requestKey, "closed-family-committed");
    if (done) {
        if (done.decisionDigest !== decisionDigest)
            throw Error("Reconciliation key belongs to another decision");
        return closedFamilyReceipt(ctx, input.requestKey);
    }
    const prepared = await audit(ctx.prisma, scope, input.requestKey, "closed-family-prepared");
    if (!prepared || prepared.digest !== input.preparationDigest)
        throw Error("An exact original preparation is required");
    return reservation(ctx, { scope, run: async (evidence, assertUnchanged) => {
            const current = await plan(ctx.prisma, scope, ctx.config.machine, evidence);
            if (current.digest !== prepared.digest)
                throw Error("Closed family or provider evidence changed after preparation");
            const unknown = current.candidates.filter(c => c.state === "unknown"), acks = decision.acknowledgeUnknown;
            if (new Set(acks.map(a => a.id)).size !== acks.length || unknown.length !== acks.length || unknown.some(c => !acks.some(a => a.id === c.id && a.textSHA256 === c.textSHA256 && a.historyDigest === c.historyDigest)))
                throw Error("Each unknown outcome needs an explicit history-reviewed acknowledgment; it cannot be cancelled or completed");
            await assertUnchanged();
            return ctx.prisma.$transaction(async (tx) => {
                if (digest(await snapshot(tx, scope, ctx.config.machine)) !== digest(prepared.state))
                    throw Error("Closed family changed before commit");
                await assertUnchanged();
                const at = new Date();
                for (const original of current.state.instructions) {
                    const ack = acks.find(a => a.id === original.id), changed = await tx.runtimeInstruction.updateMany({ where: { id: original.id, sessionId: scope.delegateSessionId, state: original.state, updatedAt: original.updatedAt }, data: { state: ack ? "acknowledged" : "cancelled", detail: ack ? `History reviewed; execution outcome remains unknown. ${ack.reason}` : `Original owner closed task; never-dispatched instruction cancelled. ${input.reason}` } });
                    if (changed.count !== 1)
                        throw Error("Instruction changed during reconciliation");
                }
                const target = current.state.ownership.sessions.find(s => s.id === scope.delegateSessionId)!;
                if (target.status !== "closed") {
                    const changed = await tx.runtimeSession.updateMany({ where: { id: target.id, status: target.status, updatedAt: target.updatedAt }, data: { status: "closed", closedAt: at, recoveryDetail: "Closed family logically reconciled; original execution outcomes retained in audit" } });
                    if (changed.count !== 1)
                        throw Error("Delegate changed during reconciliation");
                }
                const ended = current.state.ownership.relations.filter(r => r.sourceSessionId === scope.delegateSessionId && r.targetSessionId === scope.primarySessionId && !r.endedAt);
                for (const relation of ended) {
                    const changed = await tx.runtimeSessionRelation.updateMany({ where: { id: relation.id, endedAt: null }, data: { endedAt: at } });
                    if (changed.count !== 1)
                        throw Error("Delegate provenance changed during reconciliation");
                }
                for (const original of current.state.instructions) {
                    const after = await tx.runtimeInstruction.findUniqueOrThrow({ where: { id: original.id } });
                    if (textDigest(after.text) !== original.textSHA256)
                        throw Error("Original instruction text changed");
                }
                await assertUnchanged();
                const receipt = canonical({ version: 1, scope, requestKey: input.requestKey, preparationDigest: prepared.digest, decisionDigest, at: at.toISOString(), reason: input.reason, originalTask: current.state.ownership.task, endedRelationIds: ended.map(r => r.id), originalRelations: current.state.ownership.relations, originalSessions: current.state.ownership.sessions, originalInstructions: current.state.instructions,
                    dispositions: current.candidates.map(c => c.state === "unknown" ? { ...c, deliveryState: "acknowledged", executionOutcome: "unknown", reason: acks.find(a => a.id === c.id)!.reason } : { ...c, deliveryState: "cancelled", executionOutcome: "never-dispatched" }), providers: current.providers });
                await tx.runtimeMetadataEvent.create({ data: { runtimeSessionId: scope.primarySessionId, source: source(scope.taskId), key: input.requestKey, action: "closed-family-committed", value: JSON.stringify(receipt) } });
                await assertUnchanged();
                return receipt;
            });
        } });
}
/** Historical ownership remains queryable after the audited relation ends.
 * This receipt is provenance, never resource/process cleanup authority. */
export async function closedFamilyReceipt(ctx: Omit<Context, "runtime">, key: string) {
    const task = await ctx.prisma.remoteTask.findUniqueOrThrow({ where: { id: ctx.taskId } });
    if (!task.primarySessionId)
        throw Error("Original primary is missing");
    const receipt = await audit(ctx.prisma, { taskId: task.id, primarySessionId: task.primarySessionId }, key, "closed-family-committed");
    if (!receipt)
        throw Error("Closed family receipt not found");
    const originalTask = await requireClosedTask(ctx.prisma, receipt.scope, ctx.config.machine);
    for (const key of ["toolingRoot", "branchName", "baseCommit"])
        if ((originalTask as any)[key] !== receipt.originalTask[key])
            throw Error("Audited original task binding changed");
    for (const original of receipt.originalSessions) {
        const row = await ctx.prisma.runtimeSession.findUnique({ where: { id: original.id } });
        if (!row || row.status !== "closed" || ["id", "role", "lifecycle", "repositoryId", "machineId", "cwd", "acpxRecordId", "acpxSessionId", "agentSessionId"].some(key => (row as any)[key] !== original[key]))
            throw Error("Audited original session identity changed");
    }
    for (const disposition of receipt.dispositions) {
        const row = await ctx.prisma.runtimeInstruction.findUnique({ where: { id: disposition.id } });
        if (!row || row.sessionId !== receipt.scope.delegateSessionId || row.state !== disposition.deliveryState || textDigest(row.text) !== disposition.textSHA256)
            throw Error("Audited instruction disposition changed");
    }
    if (await ctx.prisma.runtimeInstruction.count({ where: { sessionId: receipt.scope.delegateSessionId, state: { in: ["queued", "unknown", "dispatching", "preparing", "steered"] } } }))
        throw Error("Audited delegate has new unsettled work");
    for (const relation of receipt.originalRelations) {
        const row = await ctx.prisma.runtimeSessionRelation.findUnique({ where: { id: relation.id } });
        if (!row || row.sourceSessionId !== relation.sourceSessionId || row.targetSessionId !== relation.targetSessionId || row.relationship !== relation.relationship || (row.endedAt?.toISOString() ?? null) !== (receipt.endedRelationIds.includes(relation.id) ? receipt.at : relation.endedAt))
            throw Error("Audited original relation changed");
    }
    const relations = await closedFamilyRelations(ctx.prisma, receipt.originalSessions.map((session: {
        id: string;
    }) => session.id));
    if (relations.length !== receipt.originalRelations.length || relations.some(r => !receipt.originalRelations.some((original: {
        id: string;
    }) => original.id === r.id)))
        throw Error("Audited original family provenance changed");
    return receipt;
}
