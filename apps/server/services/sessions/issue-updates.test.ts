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

let db: TestDatabase;
let directory: string;
afterEach(async () => { await db?.cleanup(); if (directory) await rm(directory, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII=", "base64");

async function fixture() {
  db = await createTestDatabase();
  directory = await mkdtemp(path.join(tmpdir(), "issue-update-"));
  const prisma = db.prisma;
  const config = testConfig();
  const runtime = await beginRuntimeSession(prisma, { sessionKey: "update", agent: "codex", cwd: directory, repositoryId: config.activeRepositoryId, machineId: config.machine });
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
