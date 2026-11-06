import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../../app.ts";
import { contextMiddleware, type AppEnv } from "../../middleware/context.ts";
import { bunCommandClient } from "../../transports/command/index.ts";
import { ToolingActivationError } from "../../services/tasks/tooling-releases.ts";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { toolingReleaseRoutes } from "./index.ts";

let db: TestDatabase;
const config = testConfig();
const auth = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
const body = JSON.stringify({ requestKey: "k", revision: "a".repeat(40), expectedGeneration: 0 });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });

test("activation exists only on the bearer TCP app and is disabled until adoption is integrated", async () => {
  const tcp = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() });
  expect((await tcp.request("/api/tooling-releases/test-repository/activations", { method: "POST", body })).status).toBe(401);
  const disabled = await tcp.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body });
  expect(disabled.status).toBe(409);
  expect(await disabled.json()).toMatchObject({ code: "activation-unavailable" });
  expect(await (await tcp.request("/api/tooling-releases/test-repository", { headers: auth })).json()).toEqual({ selection: null, activationEnabled: false });

  const socket = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
  expect((await socket.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body })).status).toBe(404);
  expect((await socket.request("/api/tooling-releases/test-repository", { headers: auth })).status).toBe(404);
});

test("enabled route rechecks the owner token and maps activation outcomes", async () => {
  const outcomes: Error[] = [new ToolingActivationError("restart-required", "policy", { generation: 2 }), new ToolingActivationError("generation-conflict", "raced")];
  const app = new Hono<AppEnv>();
  app.use("*", contextMiddleware({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), commandClient: bunCommandClient }));
  app.route("/api/tooling-releases", toolingReleaseRoutes({ enabled: true, activate: async () => { throw outcomes.shift()!; } }));
  expect((await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", body })).status).toBe(401);
  const pending = await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body });
  expect(pending.status).toBe(202);
  expect(await pending.json()).toMatchObject({ status: "restart-required", generation: 2 });
  expect((await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body })).status).toBe(409);
  expect((await app.request("/api/tooling-releases/test-repository/activations", { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
});
