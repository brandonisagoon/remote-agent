import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../app.ts";
import * as source from "../../integrations/linear/session-store/source-issue/read.ts";
import { beginRuntimeSession } from "../../services/sessions/runtime-registry.ts";
import { linkedSourceIssue } from "../../services/sessions/questions.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";

let db: TestDatabase;
let read: ReturnType<typeof spyOn<typeof source, "getSourceIssueForUpdate">>;
beforeEach(async () => {
  db = await createTestDatabase();
  read = spyOn(source, "getSourceIssueForUpdate").mockRejectedValue(new Error("Unexpected provider read"));
});
afterEach(async () => { read.mockRestore(); await db.cleanup(); });

async function fixture(linked = false) {
  const config = testConfig();
  const session = await beginRuntimeSession(db.prisma, {
    sessionKey: "source-issue", agent: "codex", role: "primary", cwd: "/tmp/original-pilot",
    repositoryId: config.repository.id, machineId: config.machine,
    resourceLinks: linked ? [{ provider: "linear", connectionId: config.activeConnectionId,
      resourceType: "issue-identifier", relationship: "handles", externalId: "DRA-217" }] : [],
  });
  const task = await db.prisma.remoteTask.create({ data: {
    requestKey: "original-pilot", repositoryId: session.repositoryId!, machineId: config.machine,
    primarySessionId: session.id, worktreePath: session.cwd, branchName: "codex/original-pilot",
    toolingRoot: "/immutable/original", toolingRevision: "a".repeat(40), phase: "waiting",
    issueIdentifier: linked ? "DRA-217" : null,
  } });
  const options = { config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() };
  const app = createApp({ ...options, trustLocal: true });
  return { app, options, session, task, url: `/api/sessions/${session.id}/source-issue` };
}

test("an original unlinked task returns a structured absence without provider access or identity changes", async () => {
  const f = await fixture();
  const response = await f.app.request(f.url);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "no_linked_issue", error: expect.stringContaining("inspect_task") });
  expect(read).not.toHaveBeenCalled();
  expect(await db.prisma.remoteTask.findUnique({ where: { id: f.task.id } })).toEqual(f.task);
  expect(await db.prisma.runtimeSessionResourceLink.count()).toBe(0);
  // A readable task context never authorizes issue-dependent operations.
  await expect(linkedSourceIssue({ ...f.options, sessionId: f.session.id })).rejects.toThrow("no active linked Linear issue");
});

test("linked reads keep the actual issue response and use only the recorded link", async () => {
  const f = await fixture(true);
  const issue = { id: "issue-217", identifier: "DRA-217", branchName: null, title: "Actual issue", description: "Current content",
    state: { id: "working", name: "Implementing", type: "started" }, labels: { nodes: [] },
    team: { states: { nodes: [{ id: "done", name: "Done", type: "completed" }] } }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  read.mockResolvedValue(issue);
  const response = await f.app.request(`${f.url}?issueIdentifier=DRA-unrelated`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ issue: { id: issue.id, identifier: issue.identifier, title: issue.title,
    description: issue.description, state: issue.state, labels: issue.labels, availableStates: issue.team.states.nodes } });
  expect(read.mock.calls[0]![1]).toEqual({ id: "DRA-217" });
});

test("missing and closed sessions remain unavailable rather than becoming unlinked tasks", async () => {
  const f = await fixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const sessionId of ["missing-session", f.session.id]) {
      if (sessionId === f.session.id) await db.prisma.runtimeSession.update({ where: { id: sessionId }, data: { status: "closed" } });
      const response = await f.app.request(`/api/sessions/${sessionId}/source-issue`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Internal Server Error" });
    }
    expect(read).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test("network authorization is checked before returning unlinked task context", async () => {
  const f = await fixture();
  const response = await createApp(f.options).request(f.url, { headers: { authorization: "Bearer invalid" } });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
  expect(read).not.toHaveBeenCalled();
});

test("an ended issue link stays ended and never authorizes a provider read", async () => {
  const f = await fixture(true);
  await db.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: f.session.id }, data: { endedAt: new Date() } });
  const before = await db.prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: f.session.id } });
  const response = await f.app.request(f.url);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "no_linked_issue", error: expect.stringContaining("no active linked") });
  expect(read).not.toHaveBeenCalled();
  expect(await db.prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: f.session.id } })).toEqual(before);
});

test("provider failures and missing linked issues are not misclassified as unlinked", async () => {
  const f = await fixture(true);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const result of [new Error("Session has no linked Linear issue"), null]) {
      if (result instanceof Error) read.mockRejectedValue(result); else read.mockResolvedValue(result);
      const response = await f.app.request(f.url);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Internal Server Error" });
    }
    expect(read).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
});

test("read_source_issue reports the actual route's clear error through the normal Unix MCP caller", async () => {
  const f = await fixture();
  const directory = await mkdtemp(path.join(tmpdir(), "no-linked-issue-")), socket = path.join(directory, "control.sock");
  const server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../mcp/remote-agent-mcp.ts")], {
    env: { ...process.env, REMOTE_AGENT_SESSION_ID: f.session.id, REMOTE_AGENT_SOCKET: socket },
    stdin: new Blob([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_source_issue", arguments: {} } }) + "\n"]),
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toBe("");
    const result = JSON.parse(stdout).result;
    expect(result.isError).toBeTrue();
    expect(result.content[0].text).toContain("no active linked Linear issue");
    expect(result.content[0].text).toContain("inspect_task");
    expect(result.content[0].text).not.toContain("Internal Server Error");
    expect(read).not.toHaveBeenCalled();
  } finally { child.kill(); await child.exited; server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
