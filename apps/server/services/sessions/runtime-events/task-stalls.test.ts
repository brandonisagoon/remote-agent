import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../../test-support/db.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../runtime-registry.ts";
import { issueUpdateDelivery } from "../issue-updates.ts";
import { projectTaskStalls } from "./task-stalls.ts";
import { listRuntimeProjectionRetries } from "./projection-retries.ts";

let db: TestDatabase;
afterEach(async () => { await db?.cleanup(); });

async function fixture() {
  db = await createTestDatabase();
  const prisma = db.prisma, config = testConfig();
  const row = await beginRuntimeSession(prisma, { sessionKey: "stall", agent: "codex", role: "primary", cwd: "/task", repositoryId: config.activeRepositoryId, machineId: config.machine });
  const session = await prisma.runtimeSession.update({ where: { id: row.id }, data: { status: "idle" } });
  const link = await prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-57", relationship: "handles" } });
  const task = await prisma.remoteTask.create({ data: { requestKey: "task", repositoryId: session.repositoryId, machineId: session.machineId, worktreePath: session.cwd, primarySessionId: session.id, branchName: "codex/stall", toolingRoot: "/tooling", toolingRevision: "pin", phase: "working" } });
  const runtime = createFakeAgentRuntime([{ ...row, status: "idle" }]);
  const issue = { id: "issue", identifier: "DRA-57", title: "Activity", description: null, branchName: "codex/stall", state: { id: "working", name: "Working", type: "started" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const comments = new Map<string, { id: string; body: string; issue: { id: string } }>();
  let at = Date.now();
  const client: typeof issueUpdateDelivery = {
    ...issueUpdateDelivery, source: async () => ({ session, link, config, issue }), read: async () => issue,
    create: async (_auth, comment) => { comments.set(comment.id!, { id: comment.id!, body: comment.body, issue: { id: comment.issueId } }); return { id: comment.id! }; },
    comment: async (_auth, id) => comments.get(id) ?? null,
    update: async () => { throw new Error("No issue-state changes allowed"); },
  };
  const scan = async (advance = 30_000) => { at += advance; await projectTaskStalls({ prisma, config, runtime }, client, () => at); };
  const instruction = (id = "instruction", state = "unknown", sessionId = session.id) => prisma.runtimeInstruction.create({ data: { id, sessionId, text: "Internal instruction never copied", state, updatedAt: new Date(at - 90_000) } });
  return { prisma, config, session, task, link, issue, comments, client, runtime, scan, instruction, time: () => at };
}

test("one durable concise stall notification survives reconnect; changed delivery evidence publishes again", async () => {
  const f = await fixture();
  await f.instruction();
  await f.scan();
  await f.prisma.$disconnect();
  await f.scan();
  expect(f.comments.size).toBe(1);
  expect([...f.comments.values()][0]!.body).toContain("Instruction delivery is unconfirmed");
  expect([...f.comments.values()][0]!.body).not.toContain("Internal instruction never copied");
  await f.prisma.runtimeInstruction.update({ where: { id: "instruction" }, data: { updatedAt: new Date(f.time()) } });
  await f.scan();
  expect(f.comments.size).toBe(2);
  expect(await f.prisma.runtimeIssueUpdate.count({ where: { published: true } })).toBe(2);
  expect(f.runtime.sentMessages).toEqual([]);
  expect(f.issue.state.name).toBe("Working");
});

test("lost comment reply retries its original receipt and UUID, with bounded failure telemetry", async () => {
  const f = await fixture();
  await f.instruction();
  const create = f.client.create;
  let attempts = 0;
  f.client.create = async (auth, comment) => { await create(auth, comment); if (++attempts === 1) throw new Error("reply lost"); return { id: comment.id! }; };
  await f.scan();
  expect((await listRuntimeProjectionRetries(f.prisma, [f.session.id]))[0]).toMatchObject({ stage: "stall", state: "backoff", attempts: 1 });
  await f.prisma.$disconnect();
  await f.scan();
  expect(f.comments.size).toBe(1);
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
  expect(await listRuntimeProjectionRetries(f.prisma, [f.session.id])).toEqual([]);
});

test("ordinary queue/capacity waits, live turns and posted questions never create stall comments", async () => {
  const f = await fixture();
  await f.instruction("queued", "queued");
  await f.prisma.runtimeQuestion.create({ data: { runtimeSessionId: f.session.id, requestKey: "owner", connectionId: f.link.connectionId, issueId: f.issue.id, body: "Owner decision", state: "posted" } });
  for (const state of ["queued", "executing", "unknown"] as const) {
    f.runtime.observeSessionActivity = () => ({ state, observedAt: f.time() });
    await f.scan(120_000);
  }
  expect(f.comments.size).toBe(0);
  expect(f.runtime.sentMessages).toEqual([]);
});

test("complete, closed, stopped and terminal-source tasks stay silent", async () => {
  const f = await fixture();
  await f.instruction();
  for (const change of [{ phase: "complete" }, { phase: "closed" }, { environmentStatus: "stopped" }]) {
    await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working", environmentStatus: "ready", ...change } });
    await f.scan();
  }
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { environmentStatus: "ready" } });
  for (const type of ["completed", "canceled"]) { f.issue.state.type = type; await f.scan(); }
  expect(f.comments.size).toBe(0);
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(0);
});

test("a terminal delegate result is reported after enqueue grace, not as executing; queued receipt suppresses the alert", async () => {
  const f = await fixture();
  const child = await beginRuntimeSession(f.prisma, { sessionKey: "child", agent: "codex", cwd: f.session.cwd, repositoryId: f.session.repositoryId, machineId: f.session.machineId, role: "delegate" });
  await f.prisma.runtimeSessionRelation.createMany({ data: ["spawned-by", "notifies-parent"].map((relationship) => ({ sourceSessionId: child.id, targetSessionId: f.session.id, relationship })) });
  await f.prisma.runtimeLifecycleEvent.create({ data: { id: "terminal", runtimeSessionId: child.id, requestId: "turn", phase: "completed", occurredAt: new Date(f.time()) } });
  await f.scan();
  expect(f.comments.size).toBe(0);
  await f.scan(31_000);
  expect(f.comments.size).toBe(1);
  expect([...f.comments.values()][0]!.body).toContain("terminal delegate result is journaled");
  await f.instruction(`delegate-result:${f.session.id}:terminal`, "queued");
  await f.scan(120_000);
  expect(f.comments.size).toBe(1);
  expect(f.runtime.sentMessages).toEqual([]);
});

test("ambiguous source, foreign delegates and changed local control cannot publish", async () => {
  const f = await fixture();
  const foreign = await beginRuntimeSession(f.prisma, { sessionKey: "foreign", agent: "codex", role: "delegate", cwd: "/foreign", repositoryId: f.session.repositoryId, machineId: f.session.machineId });
  await f.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: foreign.id, targetSessionId: f.session.id, relationship: "spawned-by" } });
  await f.instruction("foreign", "unknown", foreign.id);
  await f.scan();
  expect(f.comments.size).toBe(0);
  await f.instruction();
  const other = await f.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: f.session.id, provider: "linear", connectionId: f.link.connectionId, resourceType: "issue-identifier", externalId: "DRA-other", relationship: "handles" } });
  await f.scan();
  expect(f.comments.size).toBe(0);
  await f.prisma.runtimeSessionResourceLink.update({ where: { id: other.id }, data: { endedAt: new Date() } });
  const source = f.client.source;
  f.client.source = async (input) => { await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } }); return source(input); };
  await f.scan();
  expect(f.comments.size).toBe(0);
});
