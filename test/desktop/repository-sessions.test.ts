import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import example from "../../remote-agent.config.example.json";
import { parseServiceFile } from "../../lib/config.ts";
import { canonicalGitOrigin, combineMachineSessions, type SessionSummary } from "../../lib/desktop-sessions.ts";
import { desktopRepositoryReference, desktopRepositorySessions } from "../../management/desktop-sessions.ts";
import { desktopOperation, DesktopOperationSchema } from "../../management/desktop-operations.ts";
import { chatgptReviewForSession, chatgptReviewLink } from "../../lib/chatgpt-review.ts";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(machineId: string, repositoryId: string, origin: string | null) {
  const directory = mkdtempSync(path.join(tmpdir(), "repo-sessions-"));
  directories.push(directory);
  const root = path.join(directory, "checkout");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  if (origin) execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
  const socket = path.join(directory, "control.sock");
  const file = path.join(directory, "remote-agent.config.json");
  const config = parseServiceFile(structuredClone(example));
  config.machine.id = machineId;
  config.machine.server.controlSocketPath = socket;
  config.connections = {};
  config.repositories = { [repositoryId]: { name: "Same display name", root, worktreeRoot: "../worktrees", worktreeNaming: { "*": "{branch}" } } };
  writeFileSync(file, JSON.stringify(config));
  return { file, socket, machineId, repositoryId, root };
}

function session(machineId: string, repositoryId: string, id = "same-session-id"): SessionSummary {
  return { id, machineId, repositoryId, name: "Existing session", status: "idle", role: "primary", agentCommand: "codex", cwd: "/worktree", worktreePath: "/worktree", updatedAt: "2026-10-21T12:00:00.000Z", labels: [], resourceLinks: [] };
}

async function serve(socket: string, sessions: SessionSummary[], tasks: unknown[] = []) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/api/tasks" ? { tasks } : { sessions }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return requests;
}

test("Git identity matches SSH and HTTPS without retaining credentials or conflating local paths", () => {
  const expected = "github.com/drafted-ai/greenfield";
  for (const url of ["git@github.com:drafted-ai/greenfield.git", "https://private:secret@github.com/Drafted-AI/Greenfield.git?token=secret", "ssh://git@github.com:22/drafted-ai/greenfield.git", "https://github.com/drafted-ai/greenfield/"]) {
    expect(canonicalGitOrigin(url)).toBe(expected);
  }
  for (const url of ["/Users/owner/greenfield", "../greenfield", "file:///Users/owner/greenfield", "C:\\repos\\greenfield"]) expect(canonicalGitOrigin(url)).toBeNull();
  expect(canonicalGitOrigin("ssh://git@example.com:2222/owner/repo.git")).toBe("example.com:2222/owner/repo");
});

test("one repository combines independently named checkouts and preserves each machine's session identity", async () => {
  const air = fixture("macbook-air", "repo-air", "git@github.com:drafted-ai/greenfield.git");
  const pro = fixture("macbook-pro", "repo-pro", "https://github.com/drafted-ai/greenfield.git");
  const airCalls = await serve(air.socket, [session(air.machineId, air.repositoryId)]);
  const proCalls = await serve(pro.socket, [session(pro.machineId, pro.repositoryId)]);
  const reference = await desktopRepositoryReference(air.file, air.repositoryId);
  const [airData, proData] = await Promise.all([desktopRepositorySessions(air.file, reference), desktopRepositorySessions(pro.file, reference)]);
  const rows = combineMachineSessions([
    { hostId: "air", machineName: "MacBook Air", data: airData, unavailable: false },
    { hostId: "pro", machineName: "This Mac", data: proData, unavailable: false },
  ]);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => [row.machineId, row.repositoryId, row.machineName])).toEqual([
    ["macbook-air", "repo-air", "MacBook Air"], ["macbook-pro", "repo-pro", "This Mac"],
  ]);
  expect(airCalls).toEqual(["/api/tasks", "/api/sessions?includeClosed=true&repositoryId=repo-air"]);
  expect(proCalls).toEqual(["/api/tasks", "/api/sessions?includeClosed=true&repositoryId=repo-pro"]);
});

test("matching display names and local IDs never merge unrelated repositories", async () => {
  const air = fixture("macbook-air", "same-id", "https://github.com/drafted-ai/greenfield.git");
  const other = fixture("macbook-pro", "same-id", "https://github.com/other/greenfield.git");
  const reference = await desktopRepositoryReference(air.file, air.repositoryId);
  // No server exists for the unrelated machine; it must not be queried.
  expect(await desktopRepositorySessions(other.file, reference)).toEqual({ machineId: "macbook-pro", sessions: [] });
});

test("a checkout without a network origin stays scoped to its original machine", async () => {
  const air = fixture("macbook-air", "same-id", null);
  const pro = fixture("macbook-pro", "same-id", null);
  await serve(air.socket, [session(air.machineId, air.repositoryId)]);
  const reference = await desktopRepositoryReference(air.file, air.repositoryId);
  expect(reference.origin).toBeNull();
  expect((await desktopRepositorySessions(air.file, reference)).sessions).toHaveLength(1);
  expect((await desktopRepositorySessions(pro.file, reference)).sessions).toHaveLength(0);
});

test("unavailable machines keep cached rows explicitly stale while fresh machines remain visible", async () => {
  const air = fixture("macbook-air", "air-repo", "https://github.com/drafted-ai/greenfield.git");
  const reference = await desktopRepositoryReference(air.file, air.repositoryId);
  await expect(desktopRepositorySessions(air.file, reference)).rejects.toThrow();
  const cached = { machineId: "macbook-air", sessions: [session("macbook-air", "air-repo")] };
  const rows = combineMachineSessions([
    { hostId: "air", machineName: "MacBook Air", data: cached, unavailable: true },
    { hostId: "pro", machineName: "This Mac", data: { machineId: "macbook-pro", sessions: [session("macbook-pro", "pro-repo")] }, unavailable: false },
    { hostId: "offline", machineName: "Offline", unavailable: true },
  ]);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.machineId === "macbook-air")?.unavailable).toBe(true);
  expect(rows.find((row) => row.machineId === "macbook-pro")?.unavailable).toBe(false);
  const recovered = combineMachineSessions([
    { hostId: "air", machineName: "MacBook Air", data: cached, unavailable: true },
    { hostId: "alias", machineName: "Air alias", data: cached, unavailable: false },
  ]);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.unavailable).toBe(false);
});

test("cross-machine reads reject sessions belonging to another repository or machine", async () => {
  const air = fixture("macbook-air", "repo-air", "https://github.com/drafted-ai/greenfield.git");
  await serve(air.socket, [session("another-machine", air.repositoryId)]);
  const reference = await desktopRepositoryReference(air.file, air.repositoryId);
  await expect(desktopRepositorySessions(air.file, reference)).rejects.toThrow("does not match");
});

test("repository session operations use the supplied config without changing process-wide selection", async () => {
  const air = fixture("macbook-air", "repo-air", "https://github.com/drafted-ai/greenfield.git");
  await serve(air.socket, [session(air.machineId, air.repositoryId)]);
  const previous = process.env.REMOTE_AGENT_CONFIG;
  const reference = await desktopOperation(air.file, { method: "sessions:repository-reference", args: [air.repositoryId] });
  const result = await desktopOperation(air.file, { method: "sessions:repository", args: [reference] });
  expect(result).toMatchObject({ machineId: "macbook-air", sessions: [{ id: "same-session-id" }] });
  expect(process.env.REMOTE_AGENT_CONFIG).toBe(previous);
  expect(DesktopOperationSchema.safeParse({ method: "sessions:repository", args: [{ ...reference as object, action: "close" }] }).success).toBe(false);
});

test("ChatGPT preview handoff preserves the exact remote task and primary session", async () => {
  const air = fixture("macbook-air", "repo-air", "https://github.com/drafted-ai/greenfield.git");
  const row = session(air.machineId, air.repositoryId);
  const preview = { kind: "local-http", purpose: "development", state: "ready", metadata: { publicUrl: "https://preview.example.com/designs/one?view=brief&mode=review", chatgptSkill: "drafted-review" } };
  const task = { id: "original-task", primarySessionId: row.id, machineId: row.machineId, repositoryId: row.repositoryId, resources: [preview] };
  await serve(air.socket, [row], [task]);
  const data = await desktopRepositorySessions(air.file, await desktopRepositoryReference(air.file, air.repositoryId));
  const review = data.sessions[0]!.chatgptReview!;
  expect(review).toEqual({ taskId: task.id, url: preview.metadata.publicUrl, skill: "drafted-review" });
  const link = new URL(chatgptReviewLink(row, review));
  expect(link.protocol).toBe("codex:");
  expect(link.hostname).toBe("new");
  expect([...link.searchParams.keys()]).toEqual(["prompt"]);
  const prompt = link.searchParams.get("prompt")!;
  const context = JSON.parse(prompt.slice(prompt.indexOf("{")));
  expect(context).toEqual({ taskId: task.id, sessionId: row.id, machineId: row.machineId, repositoryId: row.repositoryId, previewUrl: preview.metadata.publicUrl });
  for (const change of [{ machineId: "other-machine" }, { repositoryId: "other-repo" }, { id: "delegate-session" }]) {
    expect(chatgptReviewForSession({ ...row, ...change }, { tasks: [task] })).toBeUndefined();
  }
  for (const change of [{ purpose: "browser" }, { state: "released" }, { state: "failed" }, { kind: "browser-profile" }]) {
    expect(chatgptReviewForSession(row, { tasks: [{ ...task, resources: [{ ...preview, ...change }] }] })).toBeUndefined();
  }
  for (const url of ["http://localhost:19304", "https://secret:password@preview.example.com", "javascript:alert(1)"]) {
    expect(chatgptReviewForSession(row, { tasks: [{ ...task, resources: [{ ...preview, metadata: { ...preview.metadata, publicUrl: url } }] }] })).toBeUndefined();
  }
  expect(chatgptReviewForSession(row, { error: "Old host without task previews" })).toBeUndefined();
});
