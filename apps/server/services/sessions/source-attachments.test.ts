import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { downloadSourceAttachment } from "./source-attachments.ts";
import { beginRuntimeSession } from "./runtime-registry.ts";

let db: TestDatabase;
let directory: string;
afterEach(async () => { await db?.cleanup(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  db = await createTestDatabase();
  directory = await mkdtemp(path.join(tmpdir(), "source-attachment-"));
  const config = testConfig({ acpxStateDir: path.join(directory, "private-state") });
  const prisma = db.prisma;
  const runtime = await beginRuntimeSession(prisma, { sessionKey: "source", agent: "claude", cwd: path.join(directory, "product"), repositoryId: config.activeRepositoryId, machineId: config.machine });
  const session = await prisma.runtimeSession.findUniqueOrThrow({ where: { id: runtime.id } });
  const task = await prisma.remoteTask.create({ data: { requestKey: "source", repositoryId: session.repositoryId, machineId: session.machineId, branchName: "codex/source", toolingRoot: directory, toolingRevision: "pinned", worktreePath: session.cwd, primarySessionId: session.id } });
  const link = await prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-8", relationship: "handles" } });
  const issue = { id: "bound-issue", identifier: "DRA-8", title: "Screenshot", description: "image", branchName: "codex/source", state: { id: "todo", name: "Todo", type: "unstarted" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } };
  const url = "https://uploads.linear.app/workspace/image/file";
  let downloads = 0;
  const client = {
    source: async () => ({ session, config, link, issue }),
    contains: async (key: unknown, id: string, _description: unknown, value: string) => { expect(key).toBe(config.linearApiKey); expect(id).toBe(issue.id); return value === url; },
    download: async (key: unknown, value: string) => { expect(key).toBe(config.linearApiKey); expect(value).toBe(url); downloads++; return { bytes: Buffer.from([137, 80, 78, 71]), contentType: "image/png" }; },
  };
  return { prisma, config, session, task, client, downloads: () => downloads, input: { prisma, config, sessionId: session.id, url } };
}

test("authorized input becomes a private local file outside the product; retries never overwrite it", async () => {
  const f = await fixture();
  const result = await downloadSourceAttachment(f.input, f.client);
  expect(result.path.startsWith(f.config.acpxStateDir + path.sep)).toBeTrue();
  expect(result.path.startsWith(f.session.cwd + path.sep)).toBeFalse();
  expect(result).toMatchObject({ issueIdentifier: "DRA-8", contentType: "image/png", size: 4 });
  expect(await readFile(result.path)).toEqual(Buffer.from([137, 80, 78, 71]));
  expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  expect((await stat(path.dirname(result.path))).mode & 0o777).toBe(0o700);
  const second = await downloadSourceAttachment(f.input, f.client);
  expect(second.path).not.toBe(result.path);
  expect(second.sha256).toBe(result.sha256);
  expect(JSON.stringify(result)).not.toContain(f.config.linearApiKey as string);
});

test("unrelated URLs and human control are rejected before downloading or writing", async () => {
  const f = await fixture();
  await expect(downloadSourceAttachment({ ...f.input, url: f.input.url + "-unrelated" }, f.client)).rejects.toThrow("not linked");
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { controlMode: "human" } });
  await expect(downloadSourceAttachment(f.input, f.client)).rejects.toThrow("human");
  expect(f.downloads()).toBe(0);
  expect(await readdir(directory)).toEqual([]);
});

test("download failure, closure and control takeover leave no completed file", async () => {
  const f = await fixture();
  await expect(downloadSourceAttachment(f.input, { ...f.client, download: async () => { throw new Error("HTTP 401"); } })).rejects.toThrow("401");
  await expect(downloadSourceAttachment(f.input, { ...f.client, download: async (...args) => {
    await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { controlMode: "paused" } });
    return f.client.download(...args);
  } })).rejects.toThrow("paused");
  await f.prisma.remoteTask.update({ where: { id: f.task.id }, data: { controlMode: "agent" } });
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status: "closed" } });
  await expect(downloadSourceAttachment(f.input, f.client)).rejects.toThrow("closed");
  expect(await readdir(directory)).toEqual([]);
});
