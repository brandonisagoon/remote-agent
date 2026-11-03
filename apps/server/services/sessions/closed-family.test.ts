import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createAcpxSessionRuntime } from "../../transports/acpx/session-runtime.ts";
import { createApp } from "../../app.ts";
import { prepareClosedFamily, commitClosedFamily, closedFamilyReceipt, ClosedFamilyCommit } from "./closed-family.ts";
import { closedFamilyDigest, closedTextDigest } from "./closed-family-ownership.ts";
import { resolveTaskInstruction } from "./inbox.ts";
async function fixture(work: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
    const f = await createFixture();
    try {
        await work(f);
    }
    finally {
        await f.db.cleanup();
        await rm(f.root, { recursive: true, force: true });
    }
}
async function createFixture() {
    const db = await createTestDatabase(), root = await mkdtemp(path.join(tmpdir(), "closed-family-test-")), config = testConfig({ machine: "macbook-air", acpxStateDir: root });
    const scope = { primarySessionId: "primary", delegateSessionId: "delegate", repositoryId: "repo", machineId: config.machine, worktreePath: root, toolingRevision: "a".repeat(40) };
    for (const id of ["primary", "delegate"])
        await db.prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", cwd: root, repositoryId: "repo", machineId: config.machine, role: id === "primary" ? "primary" : "delegate", lifecycle: "persistent", status: id === "primary" ? "closed" : "idle", closedAt: id === "primary" ? new Date("2026-01-01") : null, acpxRecordId: id, acpxSessionId: "provider-" + id } });
    await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: config.machine, branchName: "branch", baseCommit: "b".repeat(40), worktreePath: root, toolingRoot: root, toolingRevision: scope.toolingRevision, primarySessionId: "primary", phase: "closed" } });
    for (const relationship of ["spawned-by", "notifies-parent"])
        await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "delegate", targetSessionId: "primary", relationship } });
    const id = (suffix: string) => `delegate-instruction:primary:delegate:${suffix}`, unknown = await db.prisma.runtimeInstruction.create({ data: { id: id("unknown"), sessionId: "delegate", state: "unknown", text: "Report the original result without replay" } });
    const queued = await db.prisma.runtimeInstruction.create({ data: { id: id("queued"), sessionId: "delegate", state: "queued", text: "Later followup" } });
    await db.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: "delegate", requestId: unknown.id, phase: "started", occurredAt: new Date("2026-01-02") } });
    const store = createRuntimeStore({ stateDir: root });
    for (const session of ["primary", "delegate"]) {
        const record: AcpSessionRecord = { schema: "acpx.session.v1", acpxRecordId: session, acpSessionId: "provider-" + session, agentCommand: "codex", cwd: root, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-02T00:00:01Z", lastSeq: 1, pid: 2147483647, lastPromptAt: "2026-01-02T00:00:00Z", lastRequestId: session === "delegate" ? unknown.id : "primary-last", eventLog: { active_path: path.join(root, session + ".stream"), segment_count: 1, max_segment_bytes: 100000, max_segments: 1 }, messages: session === "delegate" ? [{ User: { id: "user", content: [{ Text: unknown.text }] } }, { Agent: { content: [{ Text: "Original result report; no execution success claimed" }], tool_results: {} } }] : [], updated_at: "2026-01-02T00:00:01Z", cumulative_token_usage: {}, request_token_usage: {} };
        await store.save(record);
    }
    const runtime = createAcpxSessionRuntime(db.prisma, config), ctx = { prisma: db.prisma, runtime, config, taskId: "task" }, input = { requestKey: "reviewed-recovery", scope };
    const prepare = () => prepareClosedFamily(ctx, input);
    const commitInput = (preparation: any) => ClosedFamilyCommit.parse({ ...input, preparationDigest: preparation.digest, reason: "Original owner closed this exact task", acknowledgeUnknown: preparation.candidates.filter((c: any) => c.state === "unknown").map((c: any) => ({ id: c.id, textSHA256: c.textSHA256, historyDigest: c.historyDigest, reason: "Inspected exact original final response; transport outcome remains unknown" })) });
    return { db, root, config, scope, unknown, queued, store, runtime, ctx, input, prepare, commitInput };
}
test("explicit prepare/commit preserves unknown execution and original provenance, never replays or fabricates provider closure", () => fixture(async (f) => {
    const rows = await f.db.prisma.runtimeInstruction.findMany(), record = await f.store.load("delegate"), prepared = await f.prepare();
    expect(prepared.state).toBe("prepared");
    const p = (prepared as any).preparation;
    expect(p.candidates.find((c: any) => c.id === f.unknown.id).executionOutcome).toBe("unknown");
    expect(p.candidates[0].textSHA256).toBe(closedTextDigest(f.unknown.text));
    expect((await f.prepare() as any).preparation.digest).toBe(p.digest);
    const input = f.commitInput(p), receipt = await commitClosedFamily(f.ctx, input);
    expect(receipt.dispositions.find((d: any) => d.id === f.unknown.id)).toMatchObject({ deliveryState: "acknowledged", executionOutcome: "unknown" });
    expect(await f.db.prisma.runtimeInstruction.findUnique({ where: { id: f.queued.id } })).toMatchObject({ state: "cancelled", text: f.queued.text });
    expect(await f.db.prisma.runtimeSession.findUnique({ where: { id: "delegate" } })).toMatchObject({ status: "closed" });
    for (const row of rows)
        expect((await f.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: row.id } })).text).toBe(row.text);
    expect(await f.store.load("delegate")).toEqual(record);
    expect(await commitClosedFamily(f.ctx, input)).toEqual(receipt);
    expect(await closedFamilyReceipt(f.ctx, f.input.requestKey)).toEqual(receipt);
    expect(await f.db.prisma.runtimeMetadataEvent.count({ where: { action: "closed-family-committed" } })).toBe(1);
    expect(receipt.originalRelations).toHaveLength(2);
    expect(await f.db.prisma.runtimeLifecycleEvent.count()).toBe(1);
}));
test("unknown is not cancelled/completed by default and existing ordinary closed-task guard stays strict", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation, input = f.commitInput(p);
    input.acknowledgeUnknown = [];
    await expect(commitClosedFamily(f.ctx, input)).rejects.toThrow("explicit history-reviewed");
    expect((await f.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.unknown.id } })).state).toBe("unknown");
    await expect(resolveTaskInstruction(f.db.prisma, f.runtime, { taskId: "task", instructionId: f.unknown.id, action: "acknowledge", reason: "Inspect" })).rejects.toThrow("closed");
}));
for (const change of ["paused", "reopened", "foreign-host", "pin", "foreign-delegate", "reparented", "active-session", "source-origin", "dispatching"] as const)
    test(`preparation refuses ${change}`, () => fixture(async (f) => {
        if (change === "paused")
            await f.db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
        if (change === "reopened")
            await f.db.prisma.remoteTask.update({ where: { id: "task" }, data: { phase: "waiting" } });
        if (change === "foreign-host")
            f.input.scope.machineId = "macbook-pro";
        if (change === "pin")
            f.input.scope.toolingRevision = "c".repeat(40);
        if (change === "foreign-delegate")
            await f.db.prisma.runtimeSession.update({ where: { id: "delegate" }, data: { cwd: "/foreign" } });
        if (change === "reparented")
            await f.db.prisma.runtimeSessionRelation.updateMany({ where: { relationship: "spawned-by" }, data: { endedAt: new Date() } });
        if (change === "active-session")
            await f.db.prisma.runtimeSession.update({ where: { id: "delegate" }, data: { status: "active" } });
        if (change === "source-origin")
            await f.db.prisma.runtimeInstruction.update({ where: { id: f.queued.id }, data: { sourceMessageId: "foreign-source" } });
        if (change === "dispatching")
            await f.db.prisma.runtimeInstruction.update({ where: { id: f.queued.id }, data: { state: "dispatching" } });
        await expect(f.prepare()).rejects.toThrow();
        expect(await f.db.prisma.runtimeMetadataEvent.count({ where: { action: "closed-family-prepared" } })).toBe(0);
    }));
for (const change of ["live-provider", "missing-record", "changed-provider-id", "missing-exit-proof", "runtime-handle"] as const)
    test(`reservation refuses ${change} without provider actions`, () => fixture(async (f) => {
        const record = (await f.store.load("delegate"))!;
        if (change === "live-provider")
            record.pid = process.pid;
        if (change === "changed-provider-id")
            record.acpSessionId = "foreign";
        if (change === "missing-exit-proof")
            delete record.pid;
        if (change === "missing-record")
            await rm(path.join(f.root, "sessions/delegate.json"));
        else
            await f.store.save(record);
        if (change === "runtime-handle")
            (f.runtime as any).handles.set("delegate", {});
        await expect(f.prepare()).rejects.toThrow();
        expect((await f.db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "delegate" } })).status).toBe("idle");
    }));
for (const evidence of ["started-event", "retry-audit", "rewritten-queued-row", "provider-newer-than-queue"] as const)
    test(`queued cancellation requires real never-dispatched evidence: ${evidence}`, () => fixture(async (f) => {
        if (evidence === "started-event")
            await f.db.prisma.runtimeLifecycleEvent.create({ data: { id: "queued-started", runtimeSessionId: "delegate", requestId: f.queued.id, phase: "started", occurredAt: new Date() } });
        if (evidence === "retry-audit")
            await f.db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "delegate", source: "task-supervisor:task", action: "instruction-resolved", key: f.queued.id, value: JSON.stringify({ action: "retry" }) } });
        if (evidence === "rewritten-queued-row")
            await f.db.prisma.runtimeInstruction.update({ where: { id: f.queued.id }, data: { detail: "previous attempt" } });
        if (evidence === "provider-newer-than-queue") {
            const record = (await f.store.load("delegate"))!;
            record.lastUsedAt = new Date().toISOString();
            await f.store.save(record);
        }
        await expect(f.prepare()).rejects.toThrow("never-dispatched");
    }));
test("runtime reservation prevents turn, recovery, enqueue and close races", () => fixture(async (f) => {
    await f.runtime.withClosedFamilyReservation!({ scope: { ...f.scope, taskId: "task" }, run: async () => {
            expect(() => f.runtime.startTurn({ sessionId: "delegate", text: "new", requestId: "new" })).toThrow("reconciled");
            await expect(f.runtime.reconcileInterruptedSession!("delegate")).rejects.toThrow("in flight");
            await expect(f.runtime.enqueue({ sessionId: "delegate", text: "new" })).rejects.toThrow("reconciled");
            await expect(f.runtime.close("delegate", "racingclose")).rejects.toThrow("reconciled");
        } });
    expect((await f.prepare()).state).toBe("prepared");
}));
test("changed provider record during reserved commit rolls back every SQL disposition", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation, before = await f.db.prisma.runtimeInstruction.findMany(), reserve = f.runtime.withClosedFamilyReservation!.bind(f.runtime);
    let calls = 0;
    f.runtime.withClosedFamilyReservation = async (input) => reserve({ ...input, run: (evidence, assert) => input.run(evidence, async () => {
            if (++calls === 2) {
                const record = (await f.store.load("delegate"))!;
                record.lastUsedAt = "2026-01-03T00:00:00Z";
                await f.store.save(record);
            }
            await assert();
        }) });
    await expect(commitClosedFamily(f.ctx, f.commitInput(p))).rejects.toThrow("record changed");
    expect(await f.db.prisma.runtimeInstruction.findMany()).toEqual(before);
    expect(await f.db.prisma.runtimeMetadataEvent.count({ where: { action: "closed-family-committed" } })).toBe(0);
}));
test("audit write failure rolls back instructions, logical closure and ended relations", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation, before = closedFamilyDigest({ instructions: await f.db.prisma.runtimeInstruction.findMany(), sessions: await f.db.prisma.runtimeSession.findMany(), relations: await f.db.prisma.runtimeSessionRelation.findMany() });
    const transaction = f.db.prisma.$transaction.bind(f.db.prisma);
    const prisma = new Proxy(f.db.prisma, { get(target, key) {
            if (key === "$transaction")
                return (work: any) => transaction(async (tx: any) => work(new Proxy(tx, { get(t, k) {
                        if (k === "runtimeMetadataEvent")
                            return new Proxy(t[k], { get(model, method) {
                                    if (method === "create")
                                        return async () => { throw Error("injected audit failure"); };
                                    return model[method];
                                } });
                        return t[k];
                    } })));
            return (target as any)[key];
        } });
    await expect(commitClosedFamily({ ...f.ctx, prisma }, f.commitInput(p))).rejects.toThrow("audit failure");
    expect(closedFamilyDigest({ instructions: await f.db.prisma.runtimeInstruction.findMany(), sessions: await f.db.prisma.runtimeSession.findMany(), relations: await f.db.prisma.runtimeSessionRelation.findMany() })).toBe(before);
}));
test("late text/event changes and conflicting idempotency decisions refuse", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation, input = f.commitInput(p);
    await f.db.prisma.runtimeInstruction.update({ where: { id: f.queued.id }, data: { text: "changed after prepare" } });
    await expect(commitClosedFamily(f.ctx, input)).rejects.toThrow();
}));
test("same key cannot change an acknowledged decision or hide changed provenance", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation, input = f.commitInput(p);
    await commitClosedFamily(f.ctx, input);
    await expect(commitClosedFamily(f.ctx, { ...input, reason: "anotherdecision" })).rejects.toThrow("another decision");
    await f.db.prisma.runtimeSession.update({ where: { id: "delegate" }, data: { acpxSessionId: "foreign" } });
    await expect(closedFamilyReceipt(f.ctx, f.input.requestKey)).rejects.toThrow("identity changed");
}));
test("authenticated operator route keeps strict schemas and no implicit unknown disposition", () => fixture(async (f) => {
    const app = createApp({ config: f.config, prisma: f.db.prisma, agentRuntime: f.runtime }), url = "/api/tasks/task/closed-family/prepare";
    expect((await app.request(url, { method: "POST", body: JSON.stringify(f.input), headers: { "content-type": "application/json" } })).status).toBe(401);
    const headers = { authorization: `Bearer ${f.config.apiKey}`, "content-type": "application/json" };
    expect((await app.request(url, { method: "POST", body: JSON.stringify({ ...f.input, providerStopped: true }), headers })).status).toBe(400);
    expect((await app.request(url, { method: "POST", body: JSON.stringify(f.input), headers })).status).toBe(200);
}));
for (const change of ["partial-user-text", "duplicate-user-text", "trailing-user", "terminal-event", "unknown-retry", "foreign-parent", "other-pending"] as const)
    test(`ambiguous original history or family refuses: ${change}`, () => fixture(async (f) => {
        const record = (await f.store.load("delegate"))!;
        if (change === "partial-user-text")
            record.messages[0] = { User: { content: [{ Text: "Quoted only: " + f.unknown.text }] } } as any;
        if (change === "duplicate-user-text")
            record.messages.unshift(structuredClone(record.messages[0]!));
        if (change === "trailing-user")
            record.messages.push({ User: { content: [{ Text: "unsettled later prompt" }] } } as any);
        if (["partial-user-text", "duplicate-user-text", "trailing-user"].includes(change))
            await f.store.save(record);
        if (change === "terminal-event")
            await f.db.prisma.runtimeLifecycleEvent.create({ data: { id: "late-terminal", runtimeSessionId: "delegate", requestId: f.unknown.id, phase: "completed", occurredAt: new Date() } });
        if (change === "unknown-retry")
            await f.db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "delegate", source: "task-supervisor:task", action: "instruction-resolved", key: f.unknown.id, value: JSON.stringify({ action: "retry" }) } });
        if (change === "foreign-parent") {
            await f.db.prisma.runtimeSession.create({ data: { id: "foreign", scopeKey: "foreign", agentCommand: "codex", cwd: f.root, status: "closed" } });
            await f.db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "delegate", targetSessionId: "foreign", relationship: "notifies-parent" } });
        }
        if (change === "other-pending")
            await f.db.prisma.runtimeInstruction.create({ data: { id: "primary-unknown", sessionId: "primary", text: "unknown primary", state: "unknown" } });
        await expect(f.prepare()).rejects.toThrow();
        expect((await f.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.unknown.id } })).state).toBe("unknown");
        expect(await f.db.prisma.runtimeMetadataEvent.count({ where: { action: "closed-family-prepared" } })).toBe(0);
    }));
test("a late lifecycle event invalidates a preparation without disposing work", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation;
    await f.db.prisma.runtimeLifecycleEvent.create({ data: { id: "late-start", runtimeSessionId: "delegate", requestId: f.queued.id, phase: "started", occurredAt: new Date() } });
    await expect(commitClosedFamily(f.ctx, f.commitInput(p))).rejects.toThrow();
    expect((await f.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.queued.id } })).state).toBe("queued");
    expect(await f.db.prisma.runtimeSessionRelation.count({ where: { endedAt: null } })).toBe(2);
}));
for (const flag of ["runtimes", "activeTurns", "turnChains", "waitingTurns", "executionDirectories", "recoveringSessions", "releasingSessions", "shuttingDown"] as const)
    test(`reservation refuses unsettled runtime ownership: ${flag}`, () => fixture(async (f) => {
        const runtime = f.runtime as any;
        if (flag === "shuttingDown")
            runtime.shuttingDown = true;
        else if (flag === "recoveringSessions" || flag === "releasingSessions")
            runtime[flag].add("delegate");
        else
            runtime[flag].set("delegate", flag === "waitingTurns" ? new Set([new AbortController()]) : {});
        await expect(f.prepare()).rejects.toThrow("runtime ownership");
        expect(await f.db.prisma.runtimeMetadataEvent.count()).toBe(0);
    }));
for (const change of ["text-digest", "history-digest", "duplicate-ack", "foreign-ack"] as const)
    test(`commit refuses an unreviewed unknown acknowledgment: ${change}`, () => fixture(async (f) => {
        const p = (await f.prepare() as any).preparation, input = f.commitInput(p);
        if (change === "text-digest")
            input.acknowledgeUnknown[0]!.textSHA256 = "f".repeat(64);
        if (change === "history-digest")
            input.acknowledgeUnknown[0]!.historyDigest = "f".repeat(64);
        if (change === "duplicate-ack")
            input.acknowledgeUnknown.push({ ...input.acknowledgeUnknown[0]! });
        if (change === "foreign-ack")
            input.acknowledgeUnknown[0]!.id = "foreign";
        await expect(commitClosedFamily(f.ctx, input)).rejects.toThrow("explicit history-reviewed");
        expect((await f.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.unknown.id } })).state).toBe("unknown");
        expect(await f.db.prisma.runtimeSessionRelation.count({ where: { endedAt: null } })).toBe(2);
    }));
test("reservation is exclusive and a committed preparation replays only its original owner", () => fixture(async (f) => {
    await f.runtime.withClosedFamilyReservation!({ scope: { ...f.scope, taskId: "task" }, run: async () => {
            await expect(f.prepare()).rejects.toThrow("runtime ownership");
        } });
    const p = (await f.prepare() as any).preparation, receipt = await commitClosedFamily(f.ctx, f.commitInput(p));
    expect(await f.prepare()).toEqual({ state: "committed", receipt });
    f.input.scope.delegateSessionId = "foreign";
    await expect(f.prepare()).rejects.toThrow("another owner");
}));
test("receipt readback rejects a new parent link and changed original task binding", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation;
    await commitClosedFamily(f.ctx, f.commitInput(p));
    await f.db.prisma.remoteTask.update({ where: { id: "task" }, data: { baseCommit: "c".repeat(40) } });
    await expect(closedFamilyReceipt(f.ctx, f.input.requestKey)).rejects.toThrow("task binding changed");
    await f.db.prisma.remoteTask.update({ where: { id: "task" }, data: { baseCommit: "b".repeat(40) } });
    await f.db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "primary", targetSessionId: "primary", relationship: "notifies-parent" } });
    await expect(closedFamilyReceipt(f.ctx, f.input.requestKey)).rejects.toThrow("provenance changed");
}));
async function nestedDelegate(f: Awaited<ReturnType<typeof createFixture>>, mode: string, parent = "delegate") {
    await f.db.prisma.runtimeSession.create({ data: { id: "grandchild", scopeKey: "grandchild", agentCommand: "codex", status: mode === "active" ? "active" : "closed", closedAt: new Date(), role: "delegate", cwd: mode === "moved" ? path.join(f.root, "moved") : f.root, repositoryId: "repo", machineId: f.config.machine } });
    await f.db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "grandchild", targetSessionId: parent, relationship: "spawned-by", endedAt: ["moved", "settled", "cycle"].includes(mode) ? new Date() : null } });
    if (mode === "pending")
        await f.db.prisma.runtimeInstruction.create({ data: { id: "grandchild-unknown", sessionId: "grandchild", state: "unknown", text: "Original unresolved descendant instruction" } });
    if (mode === "cycle")
        await f.db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "primary", targetSessionId: "grandchild", relationship: "spawned-by", endedAt: new Date() } });
}
for (const mode of ["active", "pending", "moved", "cycle", "settled"])
    test(`narrow recovery refuses nested original family including historical edges: ${mode}`, () => fixture(async (f) => {
        await nestedDelegate(f, mode);
        const before = closedFamilyDigest({ sessions: await f.db.prisma.runtimeSession.findMany(), instructions: await f.db.prisma.runtimeInstruction.findMany(), relations: await f.db.prisma.runtimeSessionRelation.findMany() });
        await expect(f.prepare()).rejects.toThrow("family provenance");
        expect(closedFamilyDigest({ sessions: await f.db.prisma.runtimeSession.findMany(), instructions: await f.db.prisma.runtimeInstruction.findMany(), relations: await f.db.prisma.runtimeSessionRelation.findMany() })).toBe(before);
        expect(await f.db.prisma.runtimeMetadataEvent.count()).toBe(0);
    }));
test("nested history under another original direct child also refuses", () => fixture(async (f) => {
    await f.db.prisma.runtimeSession.create({ data: { id: "sibling", scopeKey: "sibling", agentCommand: "codex", status: "closed", role: "delegate", cwd: f.root, repositoryId: "repo", machineId: f.config.machine } });
    await f.db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "sibling", targetSessionId: "primary", relationship: "spawned-by", endedAt: new Date() } });
    await nestedDelegate(f, "moved", "sibling");
    await expect(f.prepare()).rejects.toThrow("family provenance");
}));
test("a nested edge appearing after prepared plan observation invalidates the commit snapshot", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation, reserve = f.runtime.withClosedFamilyReservation!.bind(f.runtime);
    f.runtime.withClosedFamilyReservation = async (input) => reserve({ ...input, run: (evidence, assert) => {
            let inserted = false;
            return input.run(evidence, async () => {
                if (!inserted) {
                    inserted = true;
                    await nestedDelegate(f, "pending");
                }
                await assert();
            });
        } });
    await expect(commitClosedFamily(f.ctx, f.commitInput(p))).rejects.toThrow("family provenance");
    expect((await f.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.unknown.id } })).state).toBe("unknown");
    expect((await f.db.prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: f.queued.id } })).state).toBe("queued");
    expect((await f.db.prisma.runtimeSession.findUniqueOrThrow({ where: { id: "delegate" } })).status).toBe("idle");
    expect(await f.db.prisma.runtimeMetadataEvent.count({ where: { action: "closed-family-committed" } })).toBe(0);
}));
test("a late nested edge invalidates receipt readback and both idempotent API replays", () => fixture(async (f) => {
    const p = (await f.prepare() as any).preparation, input = f.commitInput(p);
    await commitClosedFamily(f.ctx, input);
    await nestedDelegate(f, "moved");
    await expect(closedFamilyReceipt(f.ctx, f.input.requestKey)).rejects.toThrow("provenance changed");
    await expect(commitClosedFamily(f.ctx, input)).rejects.toThrow("provenance changed");
    await expect(f.prepare()).rejects.toThrow("provenance changed");
    expect(await f.db.prisma.runtimeMetadataEvent.count({ where: { action: "closed-family-committed" } })).toBe(1);
}));
