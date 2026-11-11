import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../../app.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { ToolingActivationError } from "../../services/tasks/tooling-releases.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { toolingReleaseRoutes } from "./index.ts";

// Real Git repositories and SQLite fixtures; keep hooks reliable on a loaded host.
setDefaultTimeout(120_000);
let db: TestDatabase;
const config = testConfig();
const auth = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
const body = JSON.stringify({ requestKey: "k", revision: "a".repeat(40), expectedGeneration: 0 });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

test("integrated activation exists only on the bearer TCP app and validates owner requests", async () => {
  const tcp = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() });
  expect((await tcp.request("/api/tooling-releases/test-repository/activations", { method: "POST", body })).status).toBe(401);
  const invalid = await tcp.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth,
    body: JSON.stringify({ requestKey: "moving-ref", revision: "main", expectedGeneration: 0 }) });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ code: "invalid-request" });
  expect(await (await tcp.request("/api/tooling-releases/test-repository", { headers: auth })).json()).toEqual({ selection: null, activationEnabled: true });

  const socket = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  expect((await socket.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body })).status).toBe(404);
  expect((await socket.request("/api/tooling-releases/test-repository", { headers: auth })).status).toBe(404);
  const repairPath = "/api/tooling-releases/test-repository/tasks/task/identity-preparation-repairs";
  expect((await tcp.request(repairPath, { method: "POST", body })).status).toBe(401);
  expect((await tcp.request(repairPath, { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
  expect((await socket.request(repairPath, { method: "POST", headers: auth, body })).status).toBe(404);
});

test("a disabled route refuses activation before preparing any candidate", async () => {
  const app = new Hono<AppEnv>();
  app.use("*", contextMiddleware({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }));
  app.route("/api/tooling-releases", toolingReleaseRoutes({ enabled: false, activate: async () => { throw new Error("Disabled activation must not run"); } }));
  const disabled = await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body });
  expect(disabled.status).toBe(409);
  expect(await disabled.json()).toMatchObject({ code: "activation-unavailable" });
  expect(await (await app.request("/api/tooling-releases/test-repository", { headers: auth })).json()).toEqual({ selection: null, activationEnabled: false });
});

test("enabled route rechecks the owner token and maps activation outcomes", async () => {
  const outcomes: Error[] = [new ToolingActivationError("restart-required", "policy", { generation: 2 }), new ToolingActivationError("generation-conflict", "raced")];
  const app = new Hono<AppEnv>();
  app.use("*", contextMiddleware({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }));
  app.route("/api/tooling-releases", toolingReleaseRoutes({ enabled: true, activate: async () => { throw outcomes.shift()!; } }));
  expect((await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", body })).status).toBe(401);
  const pending = await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body });
  expect(pending.status).toBe(409);
  expect(await pending.json()).toMatchObject({ code: "restart-required" });
  expect((await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body })).status).toBe(409);
  expect((await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
});
