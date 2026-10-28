import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { findThreadSession } from "./threads.ts";
import { IssueUpdateInput, publishSessionIssueUpdate } from "./issue-updates.ts";
import { readIssueEvidence } from "./issue-evidence.ts";
import { publishChildIssueUpdate, readSessionWorkGraph } from "./child-issues.ts";
import type { WorkIssue } from "../../integrations/linear/session-store/source-issue/work-graph.ts";

let db: TestDatabase;
let directory: string;
afterEach(async () => { await db?.cleanup(); if (directory) await rm(directory, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII=", "base64");

async function fixture() {
  db = await createTestDatabase();
  directory = await mkdtemp(path.join(tmpdir(), "issue-update-"));
  const prisma = db.prisma;
  const config = testConfig();
  const runtime = await beginRuntimeSession(prisma, { sessionKey: "update", agent: "codex", role: "primary", cwd: directory, repositoryId: config.activeRepositoryId, machineId: config.machine });
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: runtime.id } });
  const link = await prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-8", relationship: "handles" } });
  const task = await prisma.remoteTask.create({ data: { requestKey: "task", repositoryId: session.repositoryId, machineId: session.machineId, branchName: "codex/feature", toolingRoot: directory, toolingRevision: "abc", worktreePath: directory, primarySessionId: session.id } });
  const states = [ { id: "working", name: "On Course", type: "started" }, { id: "review", name: "Manual Review", type: "completed" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Off Course", type: "started" } ];
  const issue = { id: "issue-id", identifier: "DRA-8", branchName: "codex/feature", title: "Feature", description: "Original request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const steps: string[] = [];
  const comments = new Map<string, { id: string; body: string; issue: { id: string } }>();
  let uploads = 0;
  const client = {
    source: async () => ({ session, link, config, issue }),
    graph: async () => ({ id: issue.id, identifier: issue.identifier, children: [], states }),
    complete: async () => {},
    read: async () => issue,
    update: async (_config: ServerConfig, _query: { id: string }, input: { stateId?: string }) => { steps.push("state"); issue.state = states.find((state) => state.id === input.stateId)!; },
    upload: async (_key: LinearCredential, input: { name: string; contentType: string; bytes: Uint8Array }) => { expect(input.bytes.length).toBeGreaterThan(0); steps.push("upload"); return `https://uploads.linear.app/evidence-${++uploads}`; },
    attach: async (_key: LinearCredential, input: { issueId: string; title: string; url: string }) => { expect(input.issueId).toBe(issue.id); steps.push("attach"); return "attachment-" + input.url.split("/").pop(); },
    create: async (_key: LinearCredential, input: { issueId: string; body: string; id?: string }) => {
      expect((await findThreadSession(prisma, { provider: "linear", connectionId: link.connectionId, threadRootCommentId: input.id! }))?.runtimeSessionId).toBe(session.id);
      steps.push("comment"); comments.set(input.id!, { id: input.id!, body: input.body, issue: { id: input.issueId } }); return { id: input.id! };
    },
    comment: async (_key: LinearCredential, id: string) => comments.get(id) ?? null,
  };
  const capture = path.join(directory, "result.png");
  await writeFile(capture, png);
  const input = { prisma, config, sessionId: session.id, ...IssueUpdateInput.parse({ requestKey: "review-1", body: "Implemented and tested.\n\n1. Open the preview.\n2. Save; the new item appears.", state: "Manual Review", expectedState: "On Course", evidence: [{ path: capture, title: "Saved item" }] }) };
  return { prisma, task, session, issue, states, steps, comments, client, input, capture };
}

test("review uploads and attaches captures before the comment/state, keeps the session and preview, and routes replies", async () => {
  const f = await fixture();
  await f.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "preview", kind: "local-http", purpose: "review", externalId: "http://localhost:3000", state: "ready" } });
  const result = await publishSessionIssueUpdate(f.input, f.client);
  expect(result.state).toBe("Manual Review");
  expect(f.steps).toEqual(["upload", "attach", "comment", "state"]);
  expect(f.comments.get(result.commentId)?.body).toContain("![Saved item](<https://uploads.linear.app/evidence-1>)");
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).not.toBe("closed");
  expect((await f.prisma.remoteTaskResource.findFirstOrThrow()).state).toBe("ready");
  expect(f.issue.description).toBe("Original request");
  f.issue.state = f.states[2]!; // owner subsequently approves
  await rm(f.capture);
  expect(await publishSessionIssueUpdate(f.input, f.client)).toEqual(result);
  expect(f.issue.state.name).toBe("Done");
  expect(f.steps).toHaveLength(4);
});

test("a failed attachment and lost comment response recover after reconnect without reuploading or duplicate comments", async () => {
  const f = await fixture();
  let failAttachment = true;
  let lostResponse = true;
  const client = { ...f.client,
    attach: async (...args: Parameters<typeof f.client.attach>) => { if (failAttachment) { failAttachment = false; throw new Error("attachment offline"); } return f.client.attach(...args); },
    create: async (...args: Parameters<typeof f.client.create>) => { await f.client.create(...args); return null; },
    comment: async (...args: Parameters<typeof f.client.comment>) => { if (lostResponse) { lostResponse = false; throw new Error("comment read offline"); } return f.client.comment(...args); },
  };
  await expect(publishSessionIssueUpdate(f.input, client)).rejects.toThrow("attachment offline");
  expect(f.issue.state.name).toBe("On Course");
  expect(f.comments.size).toBe(0);
  await f.prisma.$disconnect();
  await expect(publishSessionIssueUpdate(f.input, client)).rejects.toThrow("comment read offline");
  expect(f.issue.state.name).toBe("On Course");
  await f.prisma.$disconnect();
  expect((await publishSessionIssueUpdate(f.input, client)).published).toBe(true);
  expect(f.steps.filter((step) => step === "upload")).toHaveLength(1);
  expect(f.steps.filter((step) => step === "attach")).toHaveLength(1);
  expect(f.comments.size).toBe(1);
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
  await expect(publishSessionIssueUpdate({ ...f.input, body: "Changed" }, client)).rejects.toThrow("different update");
});

test("failed upload leaves status unchanged; capture changes and stale owner status cannot be overwritten", async () => {
  const f = await fixture();
  await expect(publishSessionIssueUpdate(f.input, { ...f.client, upload: async () => { throw new Error("storage 403"); } })).rejects.toThrow("storage 403");
  expect(f.issue.state.name).toBe("On Course");
  expect(f.comments.size).toBe(0);
  await writeFile(f.capture, Buffer.concat([png, Buffer.from("changed")]));
  await expect(publishSessionIssueUpdate(f.input, f.client)).rejects.toThrow("Evidence changed");
  await writeFile(f.capture, png);
  f.issue.state = f.states[3]!;
  await expect(publishSessionIssueUpdate(f.input, f.client)).rejects.toThrow("Issue is now 'Off Course'");
  expect(f.steps).toEqual([]);
});

test("simultaneous retries share one delivery and unknown states, workers and human control are rejected", async () => {
  const f = await fixture();
  await expect(publishSessionIssueUpdate({ ...f.input, state: "In Progress" }, f.client)).rejects.toThrow("not in the linked issue's team");
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  await expect(publishSessionIssueUpdate(f.input, f.client)).rejects.toThrow("primary");
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "primary" } });
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { controlMode: "human" } });
  await expect(publishSessionIssueUpdate(f.input, f.client)).rejects.toThrow("human");
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { controlMode: "agent" } });
  const results = await Promise.all([publishSessionIssueUpdate(f.input, f.client), publishSessionIssueUpdate(f.input, f.client)]);
  expect(results[0]).toEqual(results[1]);
  expect(f.steps).toEqual(["upload", "attach", "comment", "state"]);
});

test("backend Done accepts no screenshots; phase is separate and status transitions require a current state", async () => {
  const f = await fixture();
  expect(IssueUpdateInput.safeParse({ requestKey: "key", body: "Result", state: "Done" }).success).toBe(false);
  expect((await publishSessionIssueUpdate({ ...f.input, state: "Done", evidence: [] }, f.client)).state).toBe("Done");
  expect(f.steps).toEqual(["comment", "state"]);
  expect((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).phase).toBe("preparing");
});

test("child graph rejects a primary whose task worktree identity changed", async () => {
  const f = await fixture();
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { worktreePath: directory + "-other" } });
  await expect(readSessionWorkGraph(f.input, f.client)).rejects.toThrow("owning task primary");
  expect(await f.prisma.runtimeSessionResourceLink.count({ where: { relationship: "child" } })).toBe(0);
});

test("terminal parent updates obey the observed completion boundary before publishing; review does not require shipping", async () => {
  const f = await fixture();
  const client = { ...f.client, complete: async () => { throw new Error("Local commit has not been published"); } };
  await expect(publishSessionIssueUpdate({ ...f.input, state: "Done", evidence: [] }, client)).rejects.toThrow("not been published");
  expect(f.steps).toEqual([]);
  expect((await publishSessionIssueUpdate({ ...f.input, requestKey: "review-after-local" }, client)).state).toBe("Manual Review");
});

test("media detection rejects non-captures and paths outside the worktree including symlink escapes", async () => {
  const f = await fixture();
  const worktree = path.join(directory, "nested");
  await mkdir(worktree);
  const link = path.join(worktree, "outside.png");
  await symlink(f.capture, link);
  await expect(readIssueEvidence({ path: link, title: "Escape" }, worktree, [])).rejects.toThrow("exact task resource");
  const realCapture = await realpath(f.capture);
  expect((await readIssueEvidence({ path: f.capture, title: "Owned external" }, worktree, [realCapture])).receipt.contentType).toBe("image/png");
  await writeFile(f.capture, "SECRET=not-an-image");
  await expect(readIssueEvidence({ path: f.capture, title: "Invalid" }, directory, [])).rejects.toThrow("capture");
});

test("child updates are scoped, dependency-aware, durable and remain in the parent's task", async () => {
  const f = await fixture();
  const child = { ...f.issue, id: "child-id", identifier: "DRA-29" };
  const prerequisite = { ...f.issue, id: "prerequisite", identifier: "DRA-30" };
  const nodes: WorkIssue[] = [child, prerequisite].map((issue) => ({
    id: issue.id, identifier: issue.identifier, title: issue.title, url: `https://linear.app/issue/${issue.identifier}`,
    state: issue.state, parent: { id: f.issue.id, identifier: f.issue.identifier }, completedAt: null,
    blocks: [], blockedBy: issue.id === child.id ? [prerequisite.id] : [],
  }));
  const client = { ...f.client,
    graph: async (_config: ServerConfig, query: { id: string }) => ({ id: query.id, identifier: f.issue.identifier, states: f.states, children: query.id === f.issue.id ? nodes : [] }),
    read: async (_config: ServerConfig, query: { id: string }) => query.id === child.id ? child : prerequisite,
    update: async (_config: ServerConfig, query: { id: string }, change: { stateId?: string }) => {
      expect(query.id).toBe(child.id);
      child.state = f.states.find((state) => state.id === change.stateId)!;
      f.steps.push("state");
    },
  };
  const input = { ...f.input, evidence: [], childIssueId: child.identifier, state: "On Course", expectedState: "On Course" };
  expect((await readSessionWorkGraph(input, client)).children).toHaveLength(2);
  expect(await f.prisma.runtimeSessionResourceLink.count({ where: { relationship: "child" } })).toBe(2);
  await expect(publishChildIssueUpdate({ ...input, childIssueId: f.issue.id }, client)).rejects.toThrow("direct child");
  await expect(publishChildIssueUpdate(input, client)).rejects.toThrow("prerequisite");
  nodes[1]!.state = f.states[2]!;
  const completed = { ...input, state: "Done" };
  const result = await publishChildIssueUpdate(completed, client);
  expect(result.issueIdentifier).toBe(child.identifier);
  expect(f.steps).toEqual(["comment", "state"]);
  expect(f.issue.state.name).toBe("On Course");
  await f.prisma.$disconnect();
  expect(await publishChildIssueUpdate(completed, client)).toEqual(result);
  expect(f.comments.size).toBe(1);
  expect(await f.prisma.runtimeSession.count()).toBe(1);
  nodes.splice(0, 1); // Owner reparented the child: even replay cannot grant access.
  await expect(publishChildIssueUpdate(completed, client)).rejects.toThrow("direct child");
});

test("required unfinished children prevent parent handoff before any external write", async () => {
  const f = await fixture();
  const node: WorkIssue = {
    id: "child", identifier: "DRA-31", title: "Verify", url: "https://linear.app/issue/DRA-31",
    state: { id: "todo", name: "Todo", type: "unstarted" }, completedAt: null,
    parent: { id: f.issue.id, identifier: f.issue.identifier }, blocks: [], blockedBy: [],
  };
  const client = { ...f.client, graph: async () => ({ id: f.issue.id, identifier: f.issue.identifier, states: f.states, children: [node] }) };
  await expect(publishSessionIssueUpdate(f.input, client)).rejects.toThrow("DRA-31 (Todo)");
  expect(f.steps).toEqual([]);
  node.state = f.states[2]!;
  expect((await publishSessionIssueUpdate(f.input, client)).state).toBe("Manual Review");
});

test("child graph rejects delegates and paused task automation", async () => {
  const f = await fixture();
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  await expect(readSessionWorkGraph(f.input, f.client)).rejects.toThrow("primary");
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "primary" } });
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { controlMode: "paused" } });
  await expect(readSessionWorkGraph(f.input, f.client)).rejects.toThrow("paused");
});

test("DRA-28 implementation scopes advance independently while verification waits for all three and gates parent review", async () => {
  const f = await fixture();
  f.issue.identifier = "DRA-28";
  const todo = { id: "todo", name: "Todo", type: "unstarted" };
  const verifying = { id: "verifying", name: "Verification", type: "started" };
  f.states.push(todo, verifying);
  const definitions = [
    ["DRA-29", "Persist semantic question identities"],
    ["DRA-30", "Apply history to lot and survey asks"],
    ["DRA-32", "Share question guards across structured tools"],
    ["DRA-31", "Verify no-repeat behavior"],
  ] as const;
  const children = definitions.map(([identifier, title]) => ({ ...f.issue, id: identifier, identifier, title, state: todo }));
  const implementations = children.slice(0, 3);
  const verification = children[3]!;
  const graph = () => children.map((child): WorkIssue => ({
    id: child.id, identifier: child.identifier, title: child.title, url: `https://linear.app/issue/${child.identifier}`,
    state: child.state, parent: { id: f.issue.id, identifier: f.issue.identifier }, completedAt: null,
    blocks: child === verification ? [] : [verification.id],
    blockedBy: child === verification ? implementations.map(({ id }) => id) : [],
  }));
  const client = { ...f.client,
    graph: async (_config: ServerConfig, query: { id: string }) => ({ id: query.id, identifier: f.issue.identifier, states: f.states, children: query.id === f.issue.id ? graph() : [] }),
    read: async (_config: ServerConfig, query: { id: string }) => [f.issue, ...children].find(({ id }) => id === query.id)!,
    update: async (_config: ServerConfig, query: { id: string }, change: { stateId?: string }) => {
      const issue = [f.issue, ...children].find(({ id }) => id === query.id)!;
      issue.state = f.states.find(({ id }) => id === change.stateId)!;
      f.steps.push(`${issue.identifier}:${issue.state.name}`);
    },
  };
  const update = (child: typeof verification, state: string) => ({
    ...f.input, evidence: [], childIssueId: child.id, requestKey: `${child.id}:${state}`,
    body: `${child.title}: ${state === "Done" ? "Focused acceptance passed" : "Work started"}.`, state, expectedState: child.state.name,
  });
  expect((await readSessionWorkGraph(f.input, client)).children.map(({ identifier, blockedBy }) => ({ identifier, blockedBy }))).toEqual([
    { identifier: "DRA-29", blockedBy: [] }, { identifier: "DRA-30", blockedBy: [] },
    { identifier: "DRA-32", blockedBy: [] }, { identifier: "DRA-31", blockedBy: ["DRA-29", "DRA-30", "DRA-32"] },
  ]);
  for (const child of implementations) await publishChildIssueUpdate(update(child, "On Course"), client);
  expect(children.map(({ state }) => state.name)).toEqual(["On Course", "On Course", "On Course", "Todo"]);
  for (const child of implementations) {
    const writes = f.steps.length;
    await expect(publishChildIssueUpdate(update(verification, "Verification"), client)).rejects.toThrow("prerequisite");
    expect(f.steps).toHaveLength(writes);
    const completed = update(child, "Done");
    const receipt = await publishChildIssueUpdate(completed, client);
    await f.prisma.$disconnect();
    expect(await publishChildIssueUpdate(completed, client)).toEqual(receipt);
    expect(f.comments.size).toBe(f.steps.filter((step) => step === "comment").length);
  }
  await publishChildIssueUpdate(update(verification, "Verification"), client);
  const handoff = { ...f.input, evidence: [], requestKey: "parent-review", body: "All three changes verified together; owner review is ready." };
  const writes = f.steps.length;
  await expect(publishSessionIssueUpdate(handoff, client)).rejects.toThrow("DRA-31 (Verification)");
  expect(f.steps).toHaveLength(writes);
  await publishChildIssueUpdate(update(verification, "Done"), client);
  expect((await publishSessionIssueUpdate(handoff, client)).state).toBe("Manual Review");
  expect(f.comments.size).toBe(9); // Three start/result pairs, verification start/result, one parent handoff.
  expect(await f.prisma.remoteTask.count()).toBe(1);
  expect(await f.prisma.runtimeSession.count()).toBe(1);
  expect((await f.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.task.id } })).primarySessionId).toBe(f.session.id);
});
