import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../app.ts";
import * as source from "../../integrations/linear/session-store/source-issue/read.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { issueUpdateDelivery } from "./issue-updates.ts";

let db: TestDatabase, directory: string;
let read: ReturnType<typeof spyOn<typeof source, "getSourceIssueForUpdate">>;
let server: ReturnType<typeof Bun.serve> | undefined;
const original = { ...issueUpdateDelivery };
afterEach(async () => {
  server?.stop(true); server = undefined;
  read?.mockRestore(); Object.assign(issueUpdateDelivery, original);
  await db?.cleanup(); if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  db = await createTestDatabase();
  directory = await mkdtemp(path.join(tmpdir(), "child-review-"));
  const prisma = db.prisma, config = testConfig({ acpxStateDir: path.join(directory, "state") });
  const session = await beginRuntimeSession(prisma, { sessionKey: "original", agent: "codex", role: "primary", cwd: directory,
    repositoryId: config.activeRepositoryId, machineId: config.machine, resourceLinks: [{ provider: "linear", connectionId: config.activeConnectionId,
      resourceType: "issue-identifier", externalId: "DRA-parent", relationship: "handles" }] });
  const task = await prisma.remoteTask.create({ data: { requestKey: "original", primarySessionId: session.id, repositoryId: config.activeRepositoryId,
    machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-parent", worktreePath: directory,
    branchName: "codex/original", toolingRoot: "/original/tooling", toolingRevision: "a".repeat(40), phase: "working" } });
  const preview = await prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "review", kind: "local-http", purpose: "review", state: "ready", externalId: "http://localhost:3456" } });
  const states = [
    { id: "todo", name: "Todo", type: "unstarted" }, { id: "verification", name: "Verification", type: "started" },
    { id: "review", name: "Manual Review", type: "completed" }, { id: "merge", name: "Merge", type: "started" },
    { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Blocked", type: "started" },
  ];
  const makeIssue = (id: string) => ({ id, identifier: `DRA-${id}`, title: id, description: "Verified work", branchName: "codex/original",
    state: states[1]!, updatedAt: "2026-10-30T10:00:00.000Z", team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } });
  const parent = makeIssue("parent"), children = [makeIssue("first"), makeIssue("second")];
  const find = (id: string) => [parent, ...children].find(x => x.id === id || x.identifier === id) ?? null;
  read = spyOn(source, "getSourceIssueForUpdate").mockImplementation(async (_config, query) => find(query.id));
  const comments = new Map<string, { id: string; body: string; issue: { id: string } }>();
  const effects: string[] = [];
  let loseComment = false, failAttach = false, beforeGraph: (() => void) | undefined;
  Object.assign(issueUpdateDelivery, {
    read: async (_config: unknown, query: { id: string }) => find(query.id),
    graph: async (_config: unknown, query: { id: string }) => {
      beforeGraph?.();
      return { id: query.id, identifier: find(query.id)!.identifier, states, children: query.id === parent.id ? children.map(child => ({
        id: child.id, identifier: child.identifier, title: child.title, url: `https://linear.app/issue/${child.identifier}`, state: child.state,
        parent: { id: parent.id, identifier: parent.identifier }, completedAt: null, blockedBy: [], blocks: [],
      })) : [] };
    },
    update: async (_config: unknown, query: { id: string }, change: { stateId?: string }) => { find(query.id)!.state = states.find(s => s.id === change.stateId)!; effects.push(`state:${query.id}`); },
    upload: async () => { effects.push("upload"); return "https://uploads.linear.app/verified.png"; },
    attach: async (_key: unknown, input: { issueId: string }) => { if (failAttach) throw new Error("attachment unavailable"); effects.push(`attach:${input.issueId}`); return `attachment:${input.issueId}`; },
    create: async (_key: unknown, input: { id?: string; issueId: string; body: string }) => {
      comments.set(input.id!, { id: input.id!, issue: { id: input.issueId }, body: input.body }); effects.push(`comment:${input.issueId}`);
      return loseComment ? null : { id: input.id! };
    },
    comment: async (_key: unknown, id: string) => { if (loseComment) { loseComment = false; throw new Error("lost comment acknowledgment"); } return comments.get(id) ?? null; },
    complete: async () => { effects.push("completion-check"); },
  });
  const capture = path.join(directory, "verified.png");
  await writeFile(capture, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII=", "base64"));
  const options = { prisma, config, agentRuntime: createFakeAgentRuntime() };
  const app = createApp({ ...options, trustLocal: true });
  const payload = (child?: typeof parent, requestKey = child ? `review:${child.id}` : "parent-review") => ({ requestKey,
    body: "Acceptance checks passed. Review the saved result and confirm the behavior.", state: "Manual Review", expectedState: "Verification",
    evidence: child ? [{ path: capture, title: "Verified result" }] : [], ...(child ? { childIssueId: child.id } : {}) });
  const request = async (input = payload(), sessionId = session.id, appInput = app) => {
    const response = await appInput.request(`/api/sessions/${sessionId}/${"childIssueId" in input ? "child-issue-update" : "issue-update"}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const ready = async () => { for (const child of children) expect((await request(payload(child))).status).toBe(200); };
  return { prisma, config, session, task, preview, parent, children, states, comments, effects, options, app, payload, request, ready,
    loseNextComment: () => { loseComment = true; }, failAttachment: (value: boolean) => { failAttach = value; }, onGraph: (value?: () => void) => { beforeGraph = value; } };
}

test("the normal child and parent APIs hand off verified Manual Review children without closing them", async () => {
  const f = await fixture();
  const originalSession = await f.prisma.runtimeSession.findUnique({ where: { id: f.session.id } });
  const initial = await f.request(); expect(initial.status).toBe(409); expect(f.effects).toEqual([]);
  await f.ready();
  const childRows = await f.prisma.runtimeIssueUpdate.findMany({ where: { issueId: { in: f.children.map(x => x.id) } }, orderBy: { id: "asc" } });
  const events = await f.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } });
  const socket = path.join(directory, "control.sock"); server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  const send = () => fetch(`http://localhost/api/sessions/${f.session.id}/issue-update`, { unix: socket, method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(f.payload()) });
  expect((await send()).status).toBe(200);
  await f.prisma.$disconnect();
  expect((await send()).status).toBe(200);
  expect(f.children.map(x => x.state.name)).toEqual(["Manual Review", "Manual Review"]);
  expect(f.parent.state.name).toBe("Manual Review");
  expect(f.effects.filter(x => x === "comment:parent")).toHaveLength(1);
  expect(f.effects).not.toContain("completion-check");
  expect(await f.prisma.remoteTask.findUnique({ where: { id: f.task.id } })).toEqual(f.task);
  expect(await f.prisma.runtimeSession.findUnique({ where: { id: f.session.id } })).toEqual(originalSession);
  expect(await f.prisma.remoteTaskResource.findUnique({ where: { id: f.preview.id } })).toEqual(f.preview);
  expect(await f.prisma.runtimeIssueUpdate.findMany({ where: { issueId: { in: f.children.map(x => x.id) } }, orderBy: { id: "asc" } })).toEqual(childRows);
  expect((await f.prisma.runtimeMetadataEvent.findMany({ orderBy: { sequence: "asc" } })).slice(0, events.length)).toEqual(events);
});

test("an uncertain parent comment acknowledgment retries its original receipt and leaves child evidence intact", async () => {
  const f = await fixture(); await f.ready(); f.loseNextComment();
  expect((await f.request()).body.error).toContain("lost comment acknowledgment");
  const receipt = await f.prisma.runtimeIssueUpdate.findFirstOrThrow({ where: { issueId: f.parent.id } });
  expect(receipt.published).toBeFalse();
  expect((await f.request()).body.commentId).toBe(receipt.id);
  expect(f.comments.size).toBe(3); expect(f.children.map(x => x.state.name)).toEqual(["Manual Review", "Manual Review"]);
});

test.each(["Todo", "Verification"])("current %s child work still prevents review", async name => {
  const f = await fixture(); await f.ready(); f.children[0]!.state = f.states.find(s => s.name === name)!; f.effects.length = 0;
  expect((await f.request()).body.error).toContain(`DRA-first (${name})`); expect(f.effects).toEqual([]);
});

test("a bare review state and an interrupted evidence publication do not count as a handoff", async () => {
  const f = await fixture(); for (const child of f.children) child.state = f.states[2]!;
  expect((await f.request()).status).toBe(409);
  f.failAttachment(true);
  expect((await f.request(f.payload(f.children[0]))).body.error).toContain("attachment unavailable");
  f.effects.length = 0; expect((await f.request()).status).toBe(409); expect(f.effects).toEqual([]);
  f.failAttachment(false); await f.ready(); expect((await f.request()).status).toBe(200);
});

test("later published unverified work supersedes a child's earlier review receipt", async () => {
  const f = await fixture(); await f.ready();
  expect((await f.request({ ...f.payload(f.children[0], "correction"), state: "Verification", expectedState: "Manual Review", evidence: [] })).status).toBe(200);
  f.children[0]!.state = f.states[2]!; // A stale/external status cannot replace the latest published work.
  f.effects.length = 0; expect((await f.request()).status).toBe(409); expect(f.effects).toEqual([]);
});

test("unrelated metadata edits and an owner returning verified work to review need no new receipt format", async () => {
  const f = await fixture(); await f.ready();
  f.children[0]!.state = f.states[1]!; f.children[0]!.state = f.states[2]!;
  for (const child of f.children) { child.title = "Owner clarified the title"; child.updatedAt = "2026-10-30T12:00:00.000Z"; }
  expect((await f.request()).status).toBe(200);
});

test("a published nonvisual verification handoff and the existing explicit Blocked exception remain supported", async () => {
  const f = await fixture();
  expect((await f.request({ ...f.payload(f.children[0]), evidence: [], body: "Backend acceptance: exact API request and assertions passed; no visual capture applies." })).status).toBe(200);
  expect((await f.request({ ...f.payload(f.children[1]), evidence: [], state: "Blocked", body: "Remaining optional review scope is blocked by unavailable provider access." })).status).toBe(200);
  expect((await f.request()).status).toBe(200);
  expect(f.children.map(x => x.state.name)).toEqual(["Manual Review", "Blocked"]);
});

test.each(["foreign-session", "foreign-connection", "missing-comment", "missing-attachment"])("%s receipt cannot authorize parent review", async kind => {
  const f = await fixture(); await f.ready();
  const receipt = await f.prisma.runtimeIssueUpdate.findFirstOrThrow({ where: { issueId: f.children[0]!.id } });
  if (kind === "foreign-session") {
    const other = await beginRuntimeSession(f.prisma, { sessionKey: "foreign", agent: "codex", role: "primary", cwd: `${directory}/foreign`, repositoryId: f.config.activeRepositoryId, machineId: f.config.machine });
    await f.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { runtimeSessionId: other.id } });
  } else if (kind === "foreign-connection") await f.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { connectionId: "foreign" } });
  else if (kind === "missing-comment") await f.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { commentPosted: false } });
  else await f.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { evidence: (receipt.evidence as any[]).map(({ attachmentId: _id, ...rest }) => rest) } });
  f.effects.length = 0; expect((await f.request()).status).toBe(409); expect(f.effects).toEqual([]);
});

test.each(["Merge", "Done"])("verified child review does not satisfy parent %s delivery", async state => {
  const f = await fixture(); await f.ready(); f.parent.state = f.states.find(x => x.name === state)!; f.effects.length = 0;
  expect((await f.request({ ...f.payload(), state, expectedState: state })).status).toBe(409);
  expect(f.effects.filter(x => x !== "completion-check")).toEqual([]);
});

test("child readiness is checked again after the parent's comment before changing its state", async () => {
  const f = await fixture(); await f.ready();
  f.onGraph(() => { if (f.effects.includes("comment:parent")) f.children[0]!.state = f.states[1]!; });
  expect((await f.request()).status).toBe(409); expect(f.parent.state.name).toBe("Verification");
  expect((await f.prisma.runtimeIssueUpdate.findFirstOrThrow({ where: { issueId: f.parent.id } })).published).toBeFalse();
});

test("delegate and unauthenticated routes still refuse review publication", async () => {
  const f = await fixture(); await f.ready();
  const publicApp = createApp(f.options);
  expect((await f.request(f.payload(), f.session.id, publicApp)).status).toBe(401);
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  expect((await f.request()).status).toBe(409); expect((await f.request(f.payload(f.children[0]))).status).toBe(409);
});
