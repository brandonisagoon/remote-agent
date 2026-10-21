import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { beginTask } from "./store.ts";
import { provisionTaskWorktree } from "./provision.ts";
import { readToolingSource } from "../../../../lib/tooling-source.ts";
import { assertTaskAutomationAllowed, changeTaskControl, reconcileTaskControls } from "./control.ts";
import { prepareTaskPrompt } from "./preparation.ts";

let db: TestDatabase;
let directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = mkdtempSync(path.join(tmpdir(), "drafted-task-test-")); });
afterEach(async () => { await db.cleanup(); rmSync(directory, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  const output = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (output.exitCode) throw new Error(output.stderr.toString());
  return output.stdout.toString().trim();
}

function repository() {
  const root = path.join(directory, "product");
  mkdirSync(root);
  git(root, "init", "-b", "staging");
  git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.com");
  writeFileSync(path.join(root, "README.md"), "product\n");
  git(root, "add", "."); git(root, "commit", "-m", "fixture");
  return { ...testConfig().repository, root, worktreeRoot: path.join(directory, "worktrees"), baseBranch: "staging", preparation: "agent" as const, tooling: { root: path.join(directory, "tooling"), revision: "a".repeat(40) } };
}

test("task survives client disposal, keeps its tooling revision, and retries the same worktree without bootstrap", async () => {
  const repo = repository();
  const input = { requestKey: "launch-one", repository: repo, machineId: "macbook-air", branchName: "codex/task-one" };
  const task = await beginTask(db.prisma, input);
  expect(task.primarySessionId).toBeNull();
  const worktree = await provisionTaskWorktree(db.prisma, task.id, repo, "task-one");
  writeFileSync(path.join(worktree, "unfinished.txt"), "retain me");
  await db.prisma.$disconnect();
  const retried = await beginTask(db.prisma, { ...input, repository: { ...repo, tooling: { ...repo.tooling, revision: "b".repeat(40) } } });
  expect(retried.id).toBe(task.id);
  expect(retried.toolingRevision).toBe("a".repeat(40));
  expect(await provisionTaskWorktree(db.prisma, task.id, repo, "ignored-on-retry")).toBe(worktree);
  expect(readFileSync(path.join(worktree, "unfinished.txt"), "utf8")).toBe("retain me");
  expect(git(repo.root, "status", "--porcelain")).toBe("");
  await expect(beginTask(db.prisma, { ...input, branchName: "codex/another" })).rejects.toThrow("different launch");
});

test("tooling policy is read from a commit, not dirty source changes", () => {
  const repo = repository();
  writeFileSync(path.join(repo.root, ".remote-agent.config.json"), JSON.stringify({ preparation: "agent" }));
  git(repo.root, "add", "."); git(repo.root, "commit", "-m", "tooling policy");
  const revision = git(repo.root, "rev-parse", "HEAD");
  writeFileSync(path.join(repo.root, ".remote-agent.config.json"), JSON.stringify({ preparation: "command" }));
  expect(readToolingSource(repo.root, revision)).toEqual({ revision, settings: { preparation: "agent" } });
});

test("unavailable tooling yields a repair prompt in the existing worktree and retains the failure", async () => {
  const repo = repository();
  const task = await beginTask(db.prisma, { requestKey: "repair-test", repository: repo, machineId: "macbook-air", branchName: "codex/repair" });
  const worktreePath = await provisionTaskWorktree(db.prisma, task.id, repo, "repair");
  const prepared = await prepareTaskPrompt({ prisma: db.prisma, task, repository: repo, installRoot: path.join(directory, "runtime"), worktreePath, provider: "codex", seed: "Use {{SKILL:prepare}}. Preserve the original request." });
  expect(prepared.prompt).toContain("tooling preparation failed");
  expect(prepared.prompt).toContain("Preserve the original request");
  const failed = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
  expect(failed.phase).toBe("blocked");
  expect(failed.environmentStatus).toBe("degraded");
  expect(failed.worktreePath).toBe(worktreePath);
  expect(git(worktreePath, "status", "--porcelain")).toBe("");
});

test("network task APIs require authentication and resource identity cannot be replaced", async () => {
  const repo = repository();
  const config = testConfig({ repository: repo });
  const task = await beginTask(db.prisma, { requestKey: "resource-test", repository: repo, machineId: config.machine, branchName: "codex/resources" });
  await db.prisma.remoteTask.update({ where: { id: task.id }, data: { primarySessionId: "session-one" } });
  const app = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() });
  expect((await app.request("/api/tasks")).status).toBe(401);
  const route = "/api/sessions/session-one/task/resources";
  const resource = { key: "database", kind: "container", purpose: "development", externalId: "owned-container" };
  const put = (body: object) => app.request(route, { method: "PUT", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const replies = await Promise.all([put(resource), put({ ...resource, externalId: "unowned-container" })]);
  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
  expect(await db.prisma.remoteTaskResource.count()).toBe(1);
  const first = await db.prisma.remoteTaskResource.findFirstOrThrow();
  expect((await put({ ...resource, externalId: first.externalId, state: "ready" })).status).toBe(200);
});

test("human control blocks all worktree sessions, survives restart paused, and requires the same viewer to resume", async () => {
  const repo = repository();
  const task = await beginTask(db.prisma, { requestKey: "control-test", repository: repo, machineId: "macbook-air", branchName: "codex/control" });
  await db.prisma.remoteTask.update({ where: { id: task.id }, data: { worktreePath: "/task/control" } });
  const runtime = createFakeAgentRuntime([{ id: "primary", cwd: "/task/control", status: "active" }, { id: "delegate", cwd: "/task/control", status: "active" }]);
  runtime.cancel = async (id) => {
    await expect(assertTaskAutomationAllowed(db.prisma, "/task/control")).rejects.toThrow("draining");
    runtime.cancelledSessionIds.push(id);
    runtime.putSession({ id, cwd: "/task/control", status: "idle" });
  };
  const controllerId = "viewer-owner-123456";
  const granted = await changeTaskControl(db.prisma, runtime, { taskId: task.id, controllerId, action: "take" });
  expect(granted.controlMode).toBe("human");
  expect(runtime.cancelledSessionIds.sort()).toEqual(["delegate", "primary"]);
  await expect(assertTaskAutomationAllowed(db.prisma, "/task/control")).rejects.toThrow("human");
  await reconcileTaskControls(db.prisma);
  await expect(assertTaskAutomationAllowed(db.prisma, "/task/control")).rejects.toThrow("paused");
  await expect(changeTaskControl(db.prisma, runtime, { taskId: task.id, controllerId: "another-viewer-123", action: "resume" })).rejects.toThrow("Another viewer");
  await changeTaskControl(db.prisma, runtime, { taskId: task.id, controllerId, action: "resume" });
  await assertTaskAutomationAllowed(db.prisma, "/task/control");
});
