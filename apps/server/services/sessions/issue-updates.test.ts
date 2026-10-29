import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";
import { findThreadSession } from "./threads.ts";
import { IssueUpdateInput, publishSessionIssueUpdate } from "./issue-updates.ts";
import { EvidenceReceipt, evidenceCacheDirectory, readIssueEvidence } from "./issue-evidence.ts";
import { preparedVideoPath } from "./video-evidence.ts";

let db: TestDatabase;
let directory: string;
afterEach(async () => { await db?.cleanup(); if (directory) await rm(directory, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII=", "base64");

async function fixture() {
  db = await createTestDatabase();
  directory = await mkdtemp(path.join(tmpdir(), "issue-update-"));
  const prisma = db.prisma;
  const config = testConfig({ acpxStateDir: path.join(directory, "state") });
  const runtime = await beginRuntimeSession(prisma, { sessionKey: "update", agent: "codex", cwd: directory, repositoryId: config.activeRepositoryId, machineId: config.machine });
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
