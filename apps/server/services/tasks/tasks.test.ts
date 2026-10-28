import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { prepareTooling } from "./tooling.ts";

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

test("new tasks pin fetched staging while retries preserve their base, worktree and unfinished edits", async () => {
  const repo = repository();
  const remote = path.join(directory, "upstream");
  git(directory, "clone", repo.root, remote);
  git(remote, "config", "user.name", "Fixture");
  git(remote, "config", "user.email", "fixture@example.com");
  git(repo.root, "remote", "add", "origin", remote);
  git(repo.root, "fetch", "origin");
  repo.baseBranch = "origin/staging";
  const advance = (message: string) => {
    writeFileSync(path.join(remote, "README.md"), message);
    git(remote, "add", "."); git(remote, "commit", "-m", message);
    return git(remote, "rev-parse", "HEAD");
  };
  const latest = advance("new staging");
  const task = await beginTask(db.prisma, { requestKey: "fresh-task", repository: repo, machineId: "air", branchName: "codex/fresh-task" });
  const worktree = await provisionTaskWorktree(db.prisma, task.id, repo, "fresh-task");
  expect(git(worktree, "rev-parse", "HEAD")).toBe(latest);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).baseCommit).toBe(latest);
  writeFileSync(path.join(worktree, "README.md"), "unfinished owner work");
  const next = advance("next task base");
  git(repo.root, "remote", "set-url", "origin", path.join(directory, "missing"));
  expect(await provisionTaskWorktree(db.prisma, task.id, repo, "ignored")).toBe(worktree);
  expect(readFileSync(path.join(worktree, "README.md"), "utf8")).toBe("unfinished owner work");
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).baseCommit).toBe(latest);
  const second = await beginTask(db.prisma, { requestKey: "next-task", repository: repo, machineId: "air", branchName: "codex/next-task" });
  await expect(provisionTaskWorktree(db.prisma, second.id, repo, "next-task")).rejects.toThrow("Worktree base preparation failed");
  expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ worktreePath: null, baseCommit: null });
  expect(existsSync(path.join(repo.worktreeRoot, "next-task"))).toBeFalse();
  git(repo.root, "remote", "set-url", "origin", remote);
  const secondWorktree = await provisionTaskWorktree(db.prisma, second.id, repo, "next-task");
  expect(git(secondWorktree, "rev-parse", "HEAD")).toBe(next);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(latest);
});

test("launch content remains bound to its request key after client disposal", async () => {
  const repo = repository();
  const input = { requestKey: "bound-launch", repository: repo, machineId: "air", branchName: "codex/bound", requestFingerprint: "original-prompt-and-provider" };
  const first = await beginTask(db.prisma, input);
  await db.prisma.$disconnect();
  expect((await beginTask(db.prisma, input)).id).toBe(first.id);
  await expect(beginTask(db.prisma, { ...input, requestFingerprint: "different-prompt-or-provider" })).rejects.toThrow("launch content");
  expect(await db.prisma.remoteTask.count()).toBe(1);
  await db.prisma.remoteTask.update({ where: { id: first.id }, data: { requestFingerprint: null } });
  await expect(beginTask(db.prisma, input)).rejects.toThrow("unverifiable");
});

test("a pinned tooling checkout with modified or untracked policy fails closed without discarding work", async () => {
  const repo = repository();
  const revision = git(repo.root, "rev-parse", "HEAD");
  repo.tooling = { root: repo.root, revision };
  const installRoot = path.join(directory, "runtime");
  const pinned = path.join(installRoot, "tooling", repo.id, revision);
  mkdirSync(path.dirname(pinned), { recursive: true });
  git(repo.root, "worktree", "add", "--detach", pinned, revision);
  writeFileSync(`${pinned}.ready`, `${revision}\n`);
  expect(await prepareTooling(repo, installRoot)).toBe(pinned);
  writeFileSync(path.join(pinned, "README.md"), "uncommitted policy");
  await expect(prepareTooling(repo, installRoot)).rejects.toThrow("local changes");
  expect(readFileSync(path.join(pinned, "README.md"), "utf8")).toBe("uncommitted policy");
  writeFileSync(path.join(pinned, "README.md"), "product\n");
  writeFileSync(path.join(pinned, "AGENTS.md"), "untracked policy");
  await expect(prepareTooling(repo, installRoot)).rejects.toThrow("local changes");
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

test("launch and composition repair deliver the task's pinned owner policy instead of dirty source policy", async () => {
  const repo = repository();
  const source = path.join(directory, "tooling");
  git(directory, "clone", repo.root, source);
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.com");
  const policy = "Owner authorizes task-owned headless browser verification.\n";
  writeFileSync(path.join(source, "AGENTS.md"), policy);
  git(source, "add", "AGENTS.md");
  git(source, "commit", "-m", "owner policy");
  const revision = git(source, "rev-parse", "HEAD");
  repo.tooling = { root: source, revision };
  const task = await beginTask(db.prisma, { requestKey: "policy-launch", repository: repo, machineId: "air", branchName: "codex/policy" });
  const worktreePath = await provisionTaskWorktree(db.prisma, task.id, repo, "policy");
  const installRoot = path.join(directory, "runtime");
  const pinned = path.join(installRoot, "tooling", repo.id, revision);
  mkdirSync(path.dirname(pinned), { recursive: true });
  git(source, "worktree", "add", "--detach", pinned, revision);
  writeFileSync(`${pinned}.ready`, `${revision}\n`);
  writeFileSync(path.join(source, "AGENTS.md"), "New mutable policy must not enter this task.\n");
  const input = { prisma: db.prisma, task, repository: repo, installRoot, worktreePath, provider: "codex" as const, seed: "Verify the retained preview." };
  const prepared = await prepareTaskPrompt(input);
  expect(prepared.prompt).toContain(policy.trim());
  expect(prepared.prompt).toContain(path.join(pinned, "AGENTS.md"));
  expect(prepared.prompt).not.toContain("New mutable policy");
  const failed = await prepareTaskPrompt({ ...input, compose: async () => { throw new Error("composer unavailable"); } });
  expect(failed.prompt).toContain(policy.trim());
  expect(failed.prompt).toContain("composer unavailable");
  expect(failed.prompt).toContain(input.seed);
  expect(git(worktreePath, "status", "--porcelain")).toBe("");
  expect(existsSync(path.join(worktreePath, "AGENTS.md"))).toBeFalse();
  expect(git(pinned, "rev-parse", "HEAD")).toBe(revision);
  expect((await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).toolingRevision).toBe(revision);
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
