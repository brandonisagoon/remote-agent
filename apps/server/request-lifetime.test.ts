import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertRequestActive, RequestLifetimeError, withRequestLifetime } from "./request-lifetime.ts";
import { taskRequest } from "./middleware/request-lifetime.ts";
import { preparationStage } from "./services/tasks/preparation-diagnostics.ts";
import { createApp } from "./app.ts";
import { createTestDatabase } from "../../test-support/db.ts";
import { testConfig } from "../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../test-support/agent-runtime.ts";
import { startControlSocket } from "./control-socket.ts";
import type { AppEnv } from "./middleware/context.ts";

test("deadline returns bounded safe diagnostics and late observations cannot advance", async () => {
  let release!: () => void, done!: () => void, advanced = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { done = resolve; });
  const app = new Hono<AppEnv>();
  app.get("/", c => taskRequest(c, 30, async () => {
    try { await preparationStage("retained-archives", () => gate); advanced = true; return c.json({ accepted: true }); }
    finally { done(); }
  }));
  const timeoutCalls: number[] = [];
  const response = await app.request("/", {}, { timeout: (_request: Request, seconds: number) => timeoutCalls.push(seconds) });
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ error: "Request deadline exceeded", code: "REQUEST_DEADLINE", stages: ["retained-archives"], deadlineMs: 30,
    retry: "Repeat inspection. For adoption, replay the same requestKey and exact request body to recover an already accepted result." });
  expect(timeoutCalls).toEqual([0, 15]);
  release(); await settled;
  expect(advanced).toBe(false);
});

test("disconnect invalidates the same context before a late acceptance checkpoint", async () => {
  const controller = new AbortController();
  let release!: () => void, done!: () => void, accepted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { done = resolve; });
  const pending = withRequestLifetime({ timeoutMs: 1_000, signal: controller.signal }, async () => {
    try { await gate; assertRequestActive(); accepted = true; } finally { done(); }
  });
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(RequestLifetimeError);
  release(); await settled;
  expect(accepted).toBe(false);
});

test("a swallowed observation error cannot turn expiration into success", async () => {
  await expect(withRequestLifetime({ timeoutMs: 20 }, async () => {
    await preparationStage("source", () => Bun.sleep(35)).catch(() => undefined);
    return { accepted: true };
  })).rejects.toThrow("deadline exceeded");
});

test("unauthenticated owner inspection never extends transport lifetime", async () => {
  const config = testConfig();
  const app = createApp({ config, agentRuntime: createFakeAgentRuntime(), prisma: {} as never, trustLocal: true });
  const calls: number[] = [];
  const response = await app.request("/api/tasks/task/completion/delivered-retirement?mode=legacy-delivery", {}, { timeout: (_request: Request, seconds: number) => calls.push(seconds) });
  expect(response.status).toBe(401); expect(calls).toEqual([]);
});

// One parallel real-socket matrix crosses Bun 1.3.14's observed ~12s default
// cutoff. It uses the actual activity route and never accesses a live daemon.
test("authenticated activity GET survives slow runtime history on TCP and Unix", async () => {
  const db = await createTestDatabase(), directory = await mkdtemp(path.join(tmpdir(), "request-lifetime-"));
  const config = testConfig(), runtime = createFakeAgentRuntime();
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", cwd: directory, repositoryId: "repo", machineId: "air", status: "idle", role: "primary" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "air", worktreePath: directory, primarySessionId: "primary", branchName: "codex/task", toolingRoot: directory, toolingRevision: "a".repeat(40), phase: "waiting" } });
  runtime.history = async () => { await Bun.sleep(14_000); return []; };
  const app = createApp({ config, agentRuntime: runtime, prisma: db.prisma });
  const tcp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const socketPath = path.join(directory, "control.sock");
  const unix = await startControlSocket({ path: socketPath, app });
  try {
    const started = performance.now();
    const results = await Promise.all([
      fetch(`http://127.0.0.1:${tcp.port}/api/tasks/task/activity`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(25_000) }),
      fetch("http://local/api/tasks/task/activity", { unix: socketPath, headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(25_000) } as RequestInit),
    ]);
    for (const result of results) { expect(result.status).toBe(200); expect(result.headers.get("server-timing")).toContain("activity-history;dur="); expect((await result.json() as { task: { id: string } }).task.id).toBe("task"); }
    expect(performance.now() - started).toBeGreaterThanOrEqual(14_000);
  } finally { await unix.close(); await tcp.stop(true); await db.cleanup(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
