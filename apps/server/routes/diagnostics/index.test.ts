import { expect, test } from "bun:test";
import { createApp } from "../../app.ts";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";

test("control diagnostic is authenticated, read-only and exposes bounded timing without task data", async () => {
  const db = await createTestDatabase();
  try {
    const config = testConfig();
    const options = { config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() };
    const app = createApp(options);
    expect((await app.request("/api/diagnostics/control")).status).toBe(401);
    const response = await app.request("/api/diagnostics/control", { headers: { authorization: `Bearer ${config.apiKey}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toMatch(/^diagnostics;dur=/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.store.status).toBe("ok");
    expect(body.store.budgetMs).toBe(250);
    expect(body.eventLoop.schedulingDelayMs).toBeGreaterThanOrEqual(0);
    expect(body.host.loadAverage).toHaveLength(3);
    expect(body.host.availableParallelism).toBeGreaterThan(0);
    expect(body.scope).toBe("current-request-window");
    expect(await db.prisma.runtimeMetadataEvent.count()).toBe(0);
    expect(await db.prisma.remoteTask.count()).toBe(0);
    const local = createApp({ ...options, trustLocal: true });
    expect((await local.request("/api/diagnostics/control")).status).toBe(200);
    expect((await app.request("/api/diagnostics/control", { method: "POST", headers: { authorization: `Bearer ${config.apiKey}` } })).status).toBe(404);
  } finally { await db.cleanup(); }
});

test("HTTP diagnostic reports an unresolved store probe without blocking subsequent requests or adding queries", async () => {
  const db = await createTestDatabase();
  try {
    let queries = 0;
    const prisma = new Proxy(db.prisma, { get(target, key, receiver) {
      if (key === "$queryRaw") return () => { queries++; return new Promise(() => {}); };
      return Reflect.get(target, key, receiver);
    } });
    const app = createApp({ config: testConfig(), prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const startedAt = performance.now();
    const responses = await Promise.all([app.request("/api/diagnostics/control"), app.request("/api/diagnostics/control")]);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.json()).store.status).toBe("timeout");
    }
    expect(queries).toBe(1);
    expect((await app.request("/api/diagnostics/control")).status).toBe(200);
    expect(queries).toBe(1);
  } finally { await db.cleanup(); }
});
