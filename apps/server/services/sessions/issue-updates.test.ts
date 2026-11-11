import { reserveTaskPublication, taskPublicationContext } from "./task-publication.ts";
import { recordCapabilityOutcome } from "../tasks/tooling-capability-outcome.ts";
import { issueUpdateSource } from "./issue-update-source.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { readTaskActivity } from "../tasks/activity.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { findThreadSession } from "./threads.ts";
import { IssueUpdateInput, publishSessionIssueUpdate } from "./issue-updates.ts";
import { EvidenceReceipt, evidenceCacheDirectory, readIssueEvidence } from "./issue-evidence.ts";
import { preparedVideoPath } from "./video-evidence.ts";
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
  const config = testConfig({ acpxStateDir: path.join(directory, "state") });
  const runtime = await beginRuntimeSession(prisma, { sessionKey: "update", agent: "codex", role: "primary", cwd: directory, repositoryId: config.activeRepositoryId, machineId: config.machine });
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: runtime.id } });
  const link = await prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-8", relationship: "handles" } });
  const task = await prisma.remoteTask.create({ data: { requestKey: "task", repositoryId: session.repositoryId, machineId: session.machineId, branchName: "codex/feature", toolingRoot: directory, toolingRevision: "abc", worktreePath: directory, primarySessionId: session.id } });
  const states = [ { id: "working", name: "On Course", type: "started" }, { id: "review", name: "Manual Review", type: "completed" }, { id: "done", name: "Done", type: "completed" }, { id: "blocked", name: "Off Course", type: "started" } ];
  const issue = { id: "issue-id", identifier: "DRA-8", branchName: "codex/feature", title: "Feature", description: "Original request", state: states[0]!, team: { states: { nodes: states } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const steps: string[] = [];
  const comments = new Map<string, { id: string; body: string; issue: { id: string } }>();
  let uploads = 0;
  const uploaded: Array<{ name: string; contentType: string; bytes: Uint8Array }> = [];
  const client = {
    source: async () => ({ session, link, config, issue }),
    graph: async () => ({ id: issue.id, identifier: issue.identifier, children: [], states }),
    complete: async () => {},
    read: async () => issue,
    update: async (_config: ServerConfig, _query: { id: string }, input: { stateId?: string }) => { steps.push("state"); issue.state = states.find((state) => state.id === input.stateId)!; },
    upload: async (_key: LinearCredential, input: { name: string; contentType: string; bytes: Uint8Array }) => { expect(input.bytes.length).toBeGreaterThan(0); uploaded.push(input); steps.push("upload"); return `https://uploads.linear.app/evidence-${++uploads}`; },
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
  return { prisma, task, session, issue, states, steps, comments, client, input, capture, uploaded, config };
}

test("review uploads and attaches captures before the comment/state, keeps the session and preview, and routes replies", async () => {
  const f = await fixture();
  await f.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "preview", kind: "local-http", purpose: "review", externalId: "http://localhost:3000", state: "ready" } });
  const result = await publishSessionIssueUpdate(f.input, f.client);
  const observed = await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "issue-update-published", key: result.commentId } });
  expect(observed.source).toBe("issue-update-observer");
  expect(JSON.parse(observed.value!)).toEqual({ connectionId: f.input.config.activeConnectionId, issueId: f.issue.id, issueIdentifier: f.issue.identifier, state: "Manual Review" });
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
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "issue-update-published" } })).toBe(1);
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
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "issue-update-published" } })).toBe(0);
  expect(f.issue.state.name).toBe("On Course");
  expect(f.comments.size).toBe(0);
  await f.prisma.$disconnect();
  await expect(publishSessionIssueUpdate(f.input, client)).rejects.toThrow("comment read offline");
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "issue-update-published" } })).toBe(0);
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

test("simultaneous retries share one delivery and unknown states, workers and task closure are rejected", async () => {
  const f = await fixture();
  await expect(publishSessionIssueUpdate({ ...f.input, state: "In Progress" }, f.client)).rejects.toThrow("not in the linked issue's team");
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  await expect(publishSessionIssueUpdate(f.input, f.client)).rejects.toThrow("primary");
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "primary" } });
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  await expect(publishSessionIssueUpdate(f.input, f.client)).rejects.toThrow("closed");
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "working" } });
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
  const observed = await f.prisma.runtimeMetadataEvent.findFirstOrThrow({ where: { action: "issue-update-published", key: result.commentId } });
  expect(JSON.parse(observed.value!)).toMatchObject({ issueIdentifier: child.identifier, issueId: child.id, state: "Done" });
  expect(f.steps).toEqual(["comment", "state"]);
  expect(f.issue.state.name).toBe("On Course");
  await f.prisma.$disconnect();
  expect(await publishChildIssueUpdate(completed, client)).toEqual(result);
  expect(f.comments.size).toBe(1);
  expect(await f.prisma.runtimeSession.count()).toBe(1);
  nodes.splice(0, 1); // Owner reparented the child: even replay cannot grant access.
  await expect(publishChildIssueUpdate(completed, client)).rejects.toThrow("direct child");
});

test("confirmed review publication feeds owner-wait activity without a question or reported review phase", async () => {
  const f = await fixture();
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { connectionId: f.input.config.activeConnectionId, issueIdentifier: f.issue.identifier, phase: "working" } });
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "idle" } });
  const runtime = createFakeAgentRuntime([{ ...f.session, status: "idle" }]);
  expect((await readTaskActivity(f.prisma, runtime, f.task.id))!.activity.state).toBe("idle");
  const result = await publishSessionIssueUpdate({ ...f.input, evidence: [] }, f.client);
  expect((await readTaskActivity(f.prisma, runtime, f.task.id))!.activity).toMatchObject({ state: "waiting-owner", ownerQuestions: [], reviewHandoff: { receiptId: result.commentId, issueIdentifier: f.issue.identifier }, progress: { reportedPhase: "working" } });
  await publishSessionIssueUpdate({ ...f.input, requestKey: "resume-work", evidence: [], state: "On Course", expectedState: "Manual Review" }, f.client);
  expect((await readTaskActivity(f.prisma, runtime, f.task.id))!.activity).toMatchObject({ state: "idle", reviewHandoff: null });
  expect(runtime.sentMessages).toHaveLength(0);
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

test("child graph rejects delegates and closed tasks", async () => {
  const f = await fixture();
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  await expect(readSessionWorkGraph(f.input, f.client)).rejects.toThrow("primary");
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "primary" } });
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  await expect(readSessionWorkGraph(f.input, f.client)).rejects.toThrow("closed");
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

// Real ffmpeg/ffprobe: the published bytes must be the validated MP4.
const ffmpeg = Bun.which("ffmpeg");
const tools = Boolean(ffmpeg && Bun.which("ffprobe"));
// CI installs ffmpeg, so a missing tool fails there instead of skipping.
const media = process.env.CI ? test : test.skipIf(!tools);
if (process.env.CI) test("CI provides ffmpeg and ffprobe for real-media tests", () => { expect(tools).toBeTrue(); });
const MEDIA_TIMEOUT = 60_000;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const recording = ["-f", "lavfi", "-i", "testsrc2=size=390x844:rate=5:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest"];

function encode(file: string, args: string[]) {
  const result = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", ...recording, ...args, file], { stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return file;
}

async function inspectUpload(bytes: Uint8Array) {
  const file = path.join(directory, `uploaded-${sha256(bytes)}.mp4`);
  await writeFile(file, bytes);
  const probe = JSON.parse(Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt", "-of", "json", file]).stdout.toString());
  const decode = Bun.spawnSync([ffmpeg!, "-v", "error", "-xerror", "-i", file, "-map", "0", "-f", "null", "-"]);
  const view = Buffer.from(bytes);
  return { streams: probe.streams, decoded: decode.exitCode === 0 && !decode.stderr.length, moovFirst: view.indexOf("moov") < view.indexOf("mdat") };
}

const evidenceOf = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.prisma.runtimeIssueUpdate.findFirstOrThrow()).evidence as EvidenceReceipt[];

media("a WebM recording is prepared before any upload and published as the validated phone-compatible MP4", async () => {
  const f = await fixture();
  const webm = encode(path.join(directory, "flow.webm"), ["-c:v", "libvpx", "-c:a", "libopus"]);
  const input = { ...f.input, evidence: [{ path: f.capture, title: "Saved item" }, { path: webm, title: "Save flow" }] };
  const result = await publishSessionIssueUpdate(input, f.client);
  expect(f.steps).toEqual(["upload", "attach", "upload", "attach", "comment", "state"]);
  const [image, video] = await evidenceOf(f);
  expect(f.uploaded[0]).toMatchObject({ name: "result.png", contentType: "image/png" });
  expect(image!.prepared).toBeUndefined();
  expect(video).toMatchObject({ contentType: "video/webm", prepared: { name: "flow.mp4", contentType: "video/mp4", transform: "transcode" } });
  expect(f.uploaded[1]).toMatchObject({ name: "flow.mp4", contentType: "video/mp4" });
  expect(sha256(f.uploaded[1]!.bytes)).toBe(video!.prepared!.sha256);
  expect(f.uploaded[1]!.bytes.byteLength).toBe(video!.prepared!.size);
  expect(await inspectUpload(f.uploaded[1]!.bytes)).toEqual({ decoded: true, moovFirst: true, streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" }, { codec_type: "audio", codec_name: "aac" }] });
  expect(result.evidence[1]).toMatchObject({ title: "Save flow", name: "flow.mp4", contentType: "video/mp4", sha256: video!.prepared!.sha256 });
  expect(f.comments.get(result.commentId)?.body).toContain("\n[Save flow](<https://uploads.linear.app/evidence-2>)");
  // Replays need only the receipt; the request's private copy is released.
  expect(await Bun.file(evidenceCacheDirectory(f.config.acpxStateDir, f.session.id, "review-1")).exists()).toBeFalse();
  expect(await publishSessionIssueUpdate(input, f.client)).toEqual(result);
}, MEDIA_TIMEOUT);

media("an already compatible MP4 is published as its exact source bytes", async () => {
  const f = await fixture();
  const mp4 = encode(path.join(directory, "ready.mp4"), ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]);
  await publishSessionIssueUpdate({ ...f.input, evidence: [{ path: mp4, title: "Ready" }] }, f.client);
  expect(f.uploaded).toHaveLength(1);
  expect(f.uploaded[0]).toMatchObject({ name: "ready.mp4", contentType: "video/mp4" });
  expect(sha256(f.uploaded[0]!.bytes)).toBe(sha256(await Bun.file(mp4).bytes()));
  expect((await evidenceOf(f))[0]!.prepared?.transform).toBe("none");
}, MEDIA_TIMEOUT);

media("one unusable recording stops the whole update before any upload, comment or state change", async () => {
  const f = await fixture();
  const good = encode(path.join(directory, "good.webm"), ["-c:v", "libvpx", "-c:a", "libopus"]);
  const broken = path.join(directory, "broken.webm");
  const bytes = await Bun.file(encode(broken, ["-c:v", "libvpx", "-c:a", "libopus"])).bytes();
  await writeFile(broken, bytes.slice(0, Math.floor(bytes.byteLength * 0.6)));
  const input = { ...f.input, evidence: [{ path: f.capture, title: "Saved item" }, { path: good, title: "Good" }, { path: broken, title: "Broken" }] };
  await expect(publishSessionIssueUpdate(input, f.client)).rejects.toThrow("Could not prepare video evidence 'Broken' as phone-compatible MP4");
  expect(f.steps).toEqual([]);
  expect(f.issue.state.name).toBe("On Course");
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(0);
  // Re-recording at the same path can retry the same request.
  await writeFile(broken, bytes);
  expect((await publishSessionIssueUpdate(input, f.client)).published).toBe(true);
  expect(f.uploaded.map((upload) => upload.name)).toEqual(["result.png", "good.mp4", "broken.mp4"]);
}, MEDIA_TIMEOUT);

media("a retry uploads the persisted prepared bytes without re-encoding; changed source or output fails before upload", async () => {
  const f = await fixture();
  const webm = encode(path.join(directory, "flow.webm"), ["-c:v", "libvpx", "-c:a", "libopus"]);
  const input = { ...f.input, evidence: [{ path: webm, title: "Save flow" }] };
  await expect(publishSessionIssueUpdate(input, { ...f.client, upload: async () => { throw new Error("storage 403"); } })).rejects.toThrow("storage 403");
  const [video] = await evidenceOf(f);
  const prepared = preparedVideoPath(evidenceCacheDirectory(f.config.acpxStateDir, f.session.id, "review-1"), video!.prepared!);
  const saved = path.join(directory, "saved.mp4");
  await copyFile(prepared, saved);
  const source = await Bun.file(webm).bytes();
  await writeFile(webm, Buffer.concat([source, Buffer.from("changed")]));
  await expect(publishSessionIssueUpdate(input, f.client)).rejects.toThrow("Evidence changed");
  await writeFile(webm, source);
  await writeFile(prepared, "not the validated output");
  await expect(publishSessionIssueUpdate(input, f.client)).rejects.toThrow("Prepared video for 'Save flow' is missing or changed");
  await rm(prepared);
  await expect(publishSessionIssueUpdate(input, f.client)).rejects.toThrow("not re-encoded");
  expect(f.steps).toEqual([]);
  expect(f.issue.state.name).toBe("On Course");
  await copyFile(saved, prepared);
  // The retry never looks up a media tool: it reuses the saved file.
  const which = spyOn(Bun, "which").mockReturnValue(null);
  try { expect((await publishSessionIssueUpdate(input, f.client)).published).toBe(true); expect(which).not.toHaveBeenCalled(); } finally { which.mockRestore(); }
  expect(f.steps).toEqual(["upload", "attach", "comment", "state"]);
  expect(sha256(f.uploaded[0]!.bytes)).toBe(video!.prepared!.sha256);
}, MEDIA_TIMEOUT);

media("unpublished legacy receipts convert remaining videos; delivered legacy videos and completed receipts are kept", async () => {
  const f = await fixture();
  const webm = encode(path.join(directory, "flow.webm"), ["-c:v", "libvpx", "-c:a", "libopus"]);
  const source = (await readIssueEvidence({ path: webm, title: "Save flow" }, directory, [])).receipt;
  const legacy = async (requestKey: string, evidence: EvidenceReceipt, flags: { published?: boolean; commentPosted?: boolean } = {}) => {
    const payload = IssueUpdateInput.parse({ requestKey, body: "Recorded.", evidence: [{ path: webm, title: "Save flow" }] });
    await f.prisma.runtimeIssueUpdate.create({ data: { runtimeSessionId: f.session.id, requestKey, connectionId: f.config.activeConnectionId, issueId: f.issue.id, input: payload, evidence: [evidence], ...flags } });
    return { ...f.input, ...payload, state: undefined, expectedState: undefined };
  };
  const pending = await publishSessionIssueUpdate(await legacy("legacy-pending", source), f.client);
  expect(f.uploaded[0]).toMatchObject({ name: "flow.mp4", contentType: "video/mp4" });
  expect(pending.evidence[0]).toMatchObject({ contentType: "video/mp4", name: "flow.mp4" });
  const delivered = await publishSessionIssueUpdate(await legacy("legacy-delivered", { ...source, assetUrl: "https://uploads.linear.app/legacy" }), f.client);
  expect(f.uploaded).toHaveLength(1);
  expect(delivered.evidence[0]).toMatchObject({ url: "https://uploads.linear.app/legacy", attachmentId: "attachment-legacy", contentType: "video/webm", name: "flow.webm" });
  f.issue.state = f.states[2]!;
  const steps = f.steps.length;
  const completed = await publishSessionIssueUpdate(await legacy("legacy-done", { ...source, assetUrl: "https://uploads.linear.app/old", attachmentId: "old" }, { published: true, commentPosted: true }), f.client);
  expect(completed.evidence[0]).toMatchObject({ url: "https://uploads.linear.app/old", contentType: "video/webm" });
  expect(f.steps).toHaveLength(steps);
  expect(f.issue.state.name).toBe("Done");
  expect(await readdir(path.join(f.config.acpxStateDir, "issue-evidence"))).toHaveLength(1);
}, MEDIA_TIMEOUT);

media("a legacy receipt with earlier uploads reports only that this failed preparation made no new effects", async () => {
  const f = await fixture();
  const broken = path.join(directory, "broken.webm");
  const bytes = await Bun.file(encode(broken, ["-c:v", "libvpx", "-c:a", "libopus"])).bytes();
  await writeFile(broken, bytes.slice(0, Math.floor(bytes.byteLength * 0.6)));
  const image = (await readIssueEvidence({ path: f.capture, title: "Saved item" }, directory, [])).receipt;
  const video = (await readIssueEvidence({ path: broken, title: "Broken" }, directory, [])).receipt;
  const payload = IssueUpdateInput.parse({ requestKey: "legacy-partial", body: "Recorded.", evidence: [{ path: f.capture, title: "Saved item" }, { path: broken, title: "Broken" }] });
  await f.prisma.runtimeIssueUpdate.create({ data: { runtimeSessionId: f.session.id, requestKey: "legacy-partial", connectionId: f.config.activeConnectionId, issueId: f.issue.id, input: payload, evidence: [{ ...image, assetUrl: "https://uploads.linear.app/earlier", attachmentId: "earlier" }, video] } });
  const attempt = publishSessionIssueUpdate({ ...f.input, ...payload, state: undefined, expectedState: undefined }, f.client);
  await expect(attempt).rejects.toThrow("This attempt made no new upload, comment or status change");
  await expect(attempt).rejects.not.toThrow("Nothing was uploaded");
  expect(f.steps).toEqual([]);
  expect((await evidenceOf(f))[0]).toMatchObject({ assetUrl: "https://uploads.linear.app/earlier", attachmentId: "earlier" });
}, MEDIA_TIMEOUT);

test("mapped implementation children finish through the real update flow while their shared PR and environment remain open", async () => {
  const { recordWorkMap } = await import("./work-map.ts");
  const { WorkMapInput } = await import("../tasks/work-map-state.ts");
  const f = await fixture();
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { connectionId: f.config.activeConnectionId, issueIdentifier: f.issue.identifier } });
  const preview = await f.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "review-app", kind: "local-http", purpose: "review", externalId: "http://127.0.0.1:3000", state: "ready" } });
  const children = ["implementation", "verification"].map(id => ({ ...f.issue, id, identifier: `DRA-${id}`, title: id, parent: { id: f.issue.id, identifier: f.issue.identifier }, completedAt: null, blockedBy: [], blocks: [], url: `https://linear.app/${id}` }));
  const graph = { id: f.issue.id, identifier: f.issue.identifier, states: f.states, children };
  const client = { ...f.client, graph: async (_: ServerConfig, query: { id: string }) => query.id === f.issue.id ? graph : { ...graph, id: query.id, children: [] },
    read: async (_: ServerConfig, query: { id: string }) => children.find(c => c.id === query.id) ?? f.issue,
    create: async (_: LinearCredential, input: { issueId: string; body: string; id?: string }) => { f.comments.set(input.id!, { id: input.id!, body: input.body, issue: { id: input.issueId } }); return { id: input.id! }; },
    update: async (_: ServerConfig, query: { id: string }, input: { stateId?: string }) => { children.find(c => c.id === query.id)!.state = f.states.find(s => s.id === input.stateId)!; },
  };
  const map = WorkMapInput.parse({ version: 1, requestKey: "map", expectedRevision: 0, units: [
    { issueId: f.issue.id, kind: "outcome", acceptance: "The product ships", deliveryIds: ["shared"] },
    ...children.map(c => ({ issueId: c.id, kind: "work-item", acceptance: "Its functional check passed", deliveryIds: ["shared"] })),
  ], deliveries: [{ id: "shared", scope: "Product PR", boundary: "merge", dependsOn: [], pullRequest: { repository: "owner/product", number: 1, head: "a".repeat(40) } }], remainingConsumers: [{ issueId: f.issue.id, reason: "Retained owner review" }] });
  await recordWorkMap({ ...f.input, map }, client);
  for (const child of children) {
    const result = await publishChildIssueUpdate({ ...f.input, childIssueId: child.id, requestKey: `done-${child.id}`, state: "Done", expectedState: "On Course", evidence: [] }, client);
    expect(result.published).toBeTrue();
  }
  expect(await f.prisma.remoteTaskResource.findUnique({ where: { id: preview.id } })).toEqual(preview);
  expect(await f.prisma.runtimeSession.count()).toBe(1);
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).not.toBe("closed");
  expect(await f.prisma.runtimeInstruction.count()).toBe(0);
  await expect(publishSessionIssueUpdate({ ...f.input, requestKey: "parent-done", state: "Done", expectedState: "On Course", evidence: [] }, client)).rejects.toThrow("unobserved");
  expect(f.comments.size).toBe(2);
});


test("capability blockers publish once, preserve immutable retries and observe recovery between recurring failures", async () => {
  const f = await fixture();
  const record = (state: "blocked" | "resolved") => f.prisma.$transaction(tx => recordCapabilityOutcome(tx, {
    version: 1, capability: "runtime", state, taskId: f.task.id, sessionId: f.session.id,
    worktreePath: directory, taskToolingRevision: f.task.toolingRevision, capabilityRevision: "reviewed-release",
  }));
  const publication = { category: "blocker" as const, subject: { kind: "capability" as const, id: "runtime" as const }, code: "tooling-capability-unavailable" };
  const input = { prisma: f.prisma, config: f.config, sessionId: f.session.id, evidence: [], publication };
  await expect(publishSessionIssueUpdate({ ...input, requestKey: "invented", body: "Unavailable" }, f.client)).rejects.toThrow();
  await record("blocked");
  const first = await publishSessionIssueUpdate({ ...input, requestKey: "first", body: "Runtime instructions are unavailable." }, f.client);
  await record("blocked");
  expect((await publishSessionIssueUpdate({ ...input, requestKey: "reworded", body: "Same failure, different words." }, f.client)).commentId).toBe(first.commentId);
  expect(f.comments.size).toBe(1);
  await record("resolved");
  // No publication scan between this successful resolution and the next failure.
  await record("blocked");
  await f.prisma.$disconnect();
  const recurrence = await publishSessionIssueUpdate({ ...input, requestKey: "recurrence", body: "Runtime instructions are unavailable again." }, f.client);
  expect(recurrence.commentId).not.toBe(first.commentId);
  expect(recurrence.publication).toMatchObject({ occurrence: 2 });
  const recovery = await publishSessionIssueUpdate({ ...input, requestKey: "first-recovery", body: "The first failure resolved.",
    publication: { ...publication, category: "recovery", occurrence: 1 } }, f.client);
  expect(recovery.publication).toMatchObject({ occurrence: 1, category: "recovery" });
  expect((await publishSessionIssueUpdate({ ...input, requestKey: "first", body: "Runtime instructions are unavailable." }, f.client)).commentId).toBe(first.commentId);
  await expect(publishSessionIssueUpdate({ ...input, requestKey: "first", body: "Changed payload" }, f.client)).rejects.toThrow("different update");
  await expect(publishSessionIssueUpdate({ ...input, requestKey: "wrong-subject", body: "Browser failed", publication: { ...publication, subject: { kind: "capability", id: "browser" } } }, f.client)).rejects.toThrow();
  expect(f.comments.size).toBe(3);
  expect(await f.prisma.runtimeInstruction.count()).toBe(0);
  expect(await f.prisma.toolingOperation.count()).toBe(0);
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { issueIdentifier: "DRA-OTHER" } });
  await expect(publishSessionIssueUpdate({ ...input, requestKey: "changed-source", body: "Old failure on another source." }, f.client)).rejects.toThrow("ownership changed");
  expect(f.comments.size).toBe(3);
});

test("RA-25: reworded explicit and fallback reports reserve one receipt; original retry payload stays immutable", async () => {
  const f = await fixture();
  await f.prisma.runtimeInstruction.create({ data: { id: "failed-work", sessionId: f.session.id, text: "private instruction", state: "unknown" } });
  const base = { prisma: f.prisma, config: f.config, sessionId: f.session.id, evidence: [], publication: { category: "blocker" as const, subject: { kind: "instruction" as const, id: "failed-work" }, code: "instruction-unknown" } };
  const [explicit, fallback] = await Promise.all([
    publishSessionIssueUpdate({ ...base, requestKey: "primary-result", body: "The original operation needs recovery." }, f.client),
    publishSessionIssueUpdate({ ...base, requestKey: "fallback-result", body: "Different wording of the same failure." }, f.client),
  ]);
  expect(fallback.commentId).toBe(explicit.commentId);
  expect(f.comments.size).toBe(1);
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
  expect(explicit.publication).toMatchObject({ occurrence: 1 });
  await f.prisma.$disconnect();
  await f.prisma.runtimeInstruction.update({ where: { id: "failed-work" }, data: { state: "completed" } });
  expect((await publishSessionIssueUpdate({ ...base, requestKey: "fallback-result", body: "Different wording of the same failure." }, f.client)).commentId).toBe(explicit.commentId);
  await expect(publishSessionIssueUpdate({ ...base, requestKey: "primary-result", body: "Edited retry" }, f.client)).rejects.toThrow("different update");
  expect(f.comments.size).toBe(1);
});

test("RA-25: same text on distinct subjects, recovery, and recurrence retain separate durable identities", async () => {
  const f = await fixture();
  for (const id of ["one", "two"]) await f.prisma.runtimeInstruction.create({ data: { id, sessionId: f.session.id, text: "Work", state: "unknown" } });
  const publish = (key: string, id: string, category: "blocker" | "recovery" = "blocker") => publishSessionIssueUpdate({ prisma: f.prisma, config: f.config, sessionId: f.session.id, requestKey: key, body: "Same text", evidence: [], publication: { category, subject: { kind: "instruction", id }, code: "instruction-unknown" } }, f.client);
  const first = await publish("first", "one");
  const second = await publish("second", "two");
  expect(second.commentId).not.toBe(first.commentId);
  await f.prisma.runtimeInstruction.update({ where: { id: "one" }, data: { state: "completed" } });
  const recovery = await publish("recovery", "one", "recovery");
  expect(recovery.publication).toMatchObject({ category: "recovery", occurrence: 1 });
  await f.prisma.runtimeInstruction.update({ where: { id: "one" }, data: { state: "unknown" } });
  const recurrence = await publish("recurrence", "one");
  expect(recurrence.publication).toMatchObject({ occurrence: 2 });
  expect(f.comments.size).toBe(4);
  expect(await f.prisma.runtimeMetadataEvent.count({ where: { action: "task-publication-episode" } })).toBe(4);
});

test("RA-25: invented failures, foreign subjects, conflicting state/evidence, and fabricated versions reserve nothing", async () => {
  const f = await fixture();
  const base = { prisma: f.prisma, config: f.config, sessionId: f.session.id, requestKey: "claim", body: "Result", evidence: [] };
  const subject = { kind: "instruction" as const, id: "work" };
  await f.prisma.runtimeInstruction.create({ data: { id: subject.id, sessionId: f.session.id, text: "Work", state: "queued" } });
  await expect(publishSessionIssueUpdate({ ...base, publication: { category: "blocker", subject, code: "instruction-unknown" } }, f.client)).rejects.toThrow("does not match");
  await expect(publishSessionIssueUpdate({ ...base, publication: { category: "milestone", subject, version: "completed" } }, f.client)).rejects.toThrow("version");
  const other = await beginRuntimeSession(f.prisma, { sessionKey: "other", agent: "codex", role: "primary", cwd: f.session.cwd, repositoryId: f.session.repositoryId, machineId: f.session.machineId });
  await f.prisma.runtimeInstruction.update({ where: { id: subject.id }, data: { state: "unknown", sessionId: other.id } });
  await expect(publishSessionIssueUpdate({ ...base, publication: { category: "blocker", subject, code: "instruction-unknown" } }, f.client)).rejects.toThrow("another primary");
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(0);
  expect(await f.prisma.runtimeEventCursor.count()).toBe(0);
  await f.prisma.runtimeInstruction.update({ where: { id: subject.id }, data: { sessionId: f.session.id } });
  const publication = { category: "blocker" as const, subject, code: "instruction-unknown" };
  await publishSessionIssueUpdate({ ...base, publication }, f.client);
  await expect(publishSessionIssueUpdate({ ...base, requestKey: "changed-state", state: "Off Course", expectedState: "On Course", publication }, f.client)).rejects.toThrow("incompatible state or evidence");
  expect(f.comments.size).toBe(1);
});


test("RA-25: direct SQL reservations race on one operation identity, and inspect_task supplies its real failure code", async () => {
  const f = await fixture();
  const owner = { sessionId: f.session.id, taskId: f.task.id, repositoryId: f.session.repositoryId, machineId: f.session.machineId, connectionId: f.config.activeConnectionId, issueId: f.issue.id };
  for (const id of ["operation-one", "operation-two"]) {
    await f.prisma.toolingOperation.create({ data: { id, taskId: f.task.id, requestKey: id, kind: "compute.configure", repositoryId: f.session.repositoryId, sessionId: f.session.id, inputDigest: "a".repeat(64), generation: 1, releaseId: "release", protocol: 3, status: "running" } });
    await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `tooling-operation:${f.task.id}`, action: "tooling-operation-association", key: `outcome:${id}`, value: JSON.stringify({ operationId: id, inputDigest: "a".repeat(64), state: "refused", attemptId: `${id}:attempt` }) } });
    await f.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: f.session.id, source: `compute:${f.task.id}`, action: "compute-configuration-failure", key: `${id}:attempt`, value: JSON.stringify({ operationId: id, attemptId: `${id}:attempt`, code: "configuration-source-failed" }) } });
  }
  const publication = { category: "blocker" as const, subject: { kind: "operation" as const, id: "operation-one" }, code: "configuration-source-failed" };
  const records = await Promise.all(["one", "two"].map(requestKey => reserveTaskPublication(f.prisma, owner, { requestKey, body: `Reporter ${requestKey}`, evidence: [], publication }, [])));
  expect(records[0]!.id).toBe(records[1]!.id);
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
  const inspection = await taskPublicationContext(f.prisma, f.task);
  expect(inspection.publicationSubjects).toContainEqual({ subject: publication.subject, status: "blocked", code: publication.code });
  expect(inspection.publicationEpisodes[0]).toMatchObject({ subject: publication.subject, code: publication.code, occurrence: 1 });
  const base = { prisma: f.prisma, config: f.config, sessionId: f.session.id, evidence: [], body: "Same failure", publication };
  const one = await publishSessionIssueUpdate({ ...base, requestKey: "report-one" }, f.client);
  const two = await publishSessionIssueUpdate({ ...base, requestKey: "report-two", publication: { ...publication, subject: { kind: "operation", id: "operation-two" } } }, f.client);
  expect(one.commentId).not.toBe(two.commentId);
  expect(f.comments.size).toBe(2);
});

test("RA-25: retained mirrors resolve their recorded source and share the primary publication path", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    const mirror = await f.prisma.sessionMirror.create({ data: { sessionKey: "retained", connectionId: f.config.activeConnectionId, externalId: "agent-issue", machineId: f.session.machineId } });
    await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { sessionMirrorId: mirror.id } });
    await f.prisma.runtimeSessionResourceLink.updateMany({ where: { runtimeSessionId: f.session.id, relationship: "handles" }, data: { endedAt: new Date() } });
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("AgentIssueById")) return Response.json({ data: { issue: { id: "agent-issue", identifier: "AGENT-1", title: "Session", description: "| Runtime field | Value |\n| --- | --- |\n| Source issue | `DRA-8` |", team: { id: "team", key: "AGENT" }, assignee: null, state: { id: "error", name: "Error", type: "started" }, labels: { nodes: [] } } } });
      if (body.query.includes("SourceIssueForWorkflow")) return Response.json({ data: { issue: f.issue } });
      throw new Error("Unexpected provider request");
    }) as typeof fetch;
    const source = await issueUpdateSource({ prisma: f.prisma, config: f.config, sessionId: f.session.id });
    expect(source.link.id).toBe(`mirror:${mirror.id}`);
    expect(source.link.connectionId).toBe(f.config.activeConnectionId);
    expect(source.issue.id).toBe(f.issue.id);
    await f.prisma.runtimeInstruction.create({ data: { id: "mirror-work", sessionId: f.session.id, text: "Work", state: "unknown" } });
    const result = await publishSessionIssueUpdate({ prisma: f.prisma, config: f.config, sessionId: f.session.id, requestKey: "mirror-result", body: "Current failure", evidence: [], publication: { category: "blocker", subject: { kind: "instruction", id: "mirror-work" }, code: "instruction-unknown" } }, { ...f.client, source: async () => source });
    expect(result.published).toBe(true);
    expect(f.comments.size).toBe(1);
    expect(await f.prisma.runtimeSessionResourceLink.count({ where: { relationship: "handles", endedAt: null } })).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});


media("RA-25: a fallback resumes the first report's prepared video bytes and cache", async () => {
  const f = await fixture();
  const webm = encode(path.join(directory, "transition.webm"), ["-c:v", "libvpx", "-c:a", "libopus"]);
  await f.prisma.runtimeInstruction.create({ data: { id: "video-work", sessionId: f.session.id, text: "Work", state: "completed" } });
  const input = { prisma: f.prisma, config: f.config, sessionId: f.session.id, requestKey: "primary-video", body: "Verified result", evidence: [{ path: webm, title: "Flow" }], publication: { category: "milestone" as const, subject: { kind: "instruction" as const, id: "video-work" }, version: "completed" } };
  await expect(publishSessionIssueUpdate(input, { ...f.client, upload: async () => { throw new Error("upload offline"); } })).rejects.toThrow("upload offline");
  const receipt = await f.prisma.runtimeIssueUpdate.findFirstOrThrow();
  const saved = IssueUpdateInput.parse(receipt.input);
  expect(saved.requestKey).not.toBe(input.requestKey);
  await f.prisma.$disconnect();
  const result = await publishSessionIssueUpdate({ prisma: f.prisma, config: f.config, sessionId: f.session.id, ...saved }, f.client);
  expect(result.commentId).toBe(receipt.id);
  expect(f.uploaded).toHaveLength(1);
  expect(f.uploaded[0]!.contentType).toBe("video/mp4");
  await rm(webm);
  expect((await publishSessionIssueUpdate({ ...input, requestKey: "later-reworded-report", body: "The same verified result" }, f.client)).commentId).toBe(receipt.id);
  expect(f.comments.size).toBe(1);
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(1);
}, MEDIA_TIMEOUT);
