import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { RoutingConfigSchema } from "../../../../lib/routing-config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { placeTask, queueRoutedRequest, dispatchPlacements } from "./routing.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
const routing = RoutingConfigSchema.parse({ ingress: true, peers: { workstation: { url: "http://127.0.0.1:19002", apiKey: "private-peer-key-123456", repositories: ["test-repository"] } } });

test("lost launch response retries one persisted placement on the same host after ingress restart", async () => {
  const config = testConfig({ routing });
  const placement = await placeTask(db.prisma, config, { sourceKey: "launch:one", machineId: "workstation", repositoryId: config.repository.id });
  const input = { placementId: placement.id, requestKey: "launch:one", kind: "launch" as const, payload: { repositoryId: config.repository.id, branchName: "codex/one", prompt: "hello", provider: "codex" } };
  await queueRoutedRequest(db.prisma, input);
  await queueRoutedRequest(db.prisma, input);
  const remoteTasks = new Map<string, string>();
  const hosts: string[] = [];
  let loseResponse = true;
  const recipient = async (host: string, _method: string, _route: string, body?: unknown) => {
    hosts.push(host);
    const key = (body as { requestKey: string }).requestKey;
    if (!remoteTasks.has(key)) remoteTasks.set(key, "owned-task");
    if (loseResponse) { loseResponse = false; throw new Error("Response lost after recipient persisted task"); }
    return Response.json({ task: { id: remoteTasks.get(key), machineId: host, repositoryId: config.repository.id } });
  };
  await dispatchPlacements(db.prisma, recipient);
  expect((await db.prisma.taskDelivery.findFirstOrThrow()).state).toBe("retrying");
  await db.prisma.$disconnect();
  await db.prisma.taskDelivery.updateMany({ data: { retryAt: new Date(0) } });
  await dispatchPlacements(db.prisma, recipient);
  expect(remoteTasks.size).toBe(1);
  expect(hosts).toEqual(["workstation", "workstation"]);
  expect((await db.prisma.taskPlacement.findUniqueOrThrow({ where: { id: placement.id } })).taskId).toBe("owned-task");
  expect((await db.prisma.taskDelivery.findFirstOrThrow()).state).toBe("acknowledged");
  await expect(placeTask(db.prisma, config, { sourceKey: "launch:one", machineId: config.machine, repositoryId: config.repository.id })).rejects.toThrow("another host");
  await expect(queueRoutedRequest(db.prisma, { ...input, payload: { ...input.payload, prompt: "different" } })).rejects.toThrow("another request");
});

test("instructions wait for launch acknowledgement and use a stable destination request key", async () => {
  const config = testConfig({ routing });
  const placement = await placeTask(db.prisma, config, { sourceKey: "launch:two", machineId: config.machine, repositoryId: config.repository.id });
  await queueRoutedRequest(db.prisma, { placementId: placement.id, requestKey: "first", kind: "launch", payload: {} });
  const instruction = await queueRoutedRequest(db.prisma, { placementId: placement.id, requestKey: "second", kind: "instruction", payload: { text: "continue" } });
  const paths: string[] = [];
  const send = async (_host: string, _method: string, route: string, body?: unknown) => {
    paths.push(route);
    if (route === "/api/tasks") return Response.json({ task: { id: "task-123", machineId: config.machine, repositoryId: config.repository.id } });
    expect(body).toEqual({ text: "continue", requestKey: instruction.id });
    return Response.json({ instruction: { state: "queued" } });
  };
  await dispatchPlacements(db.prisma, send);
  expect(paths).toEqual(["/api/tasks"]);
  await dispatchPlacements(db.prisma, send);
  expect(paths).toEqual(["/api/tasks", "/api/tasks/task-123/instructions"]);
});

test("Linear ingress rejects other and missing actors before persisting placement or delivery", async () => {
  const config = testConfig({ routing });
  const webhookId = config.activeWebhookId;
  config.webhooks = { ...config.webhooks, [webhookId]: { ...config.webhooks[webhookId]!, repositoryRouting: { [config.repository.id]: { when: [{ "linear.organizationId": ["org"], "linear.userId": ["owner"] }] } } } };
  const app = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() });
  const post = async (actor: string | undefined, delivery: string) => {
    const body = JSON.stringify({ type: "Issue", action: "update", webhookTimestamp: Date.now(), organizationId: "org", actor: actor ? { id: actor } : undefined, data: { id: "issue", identifier: "DRA-1", state: { name: "Planning", type: "unstarted" } } });
    return app.request(`/webhooks/${webhookId}`, { method: "POST", headers: { "content-type": "application/json", "linear-delivery": delivery, "linear-signature": createHmac("sha256", config.webhooks[webhookId]!.webhookSecret).update(body).digest("hex") }, body });
  };
  expect((await post("other", "denied-one")).status).toBe(409);
  expect((await post(undefined, "denied-two")).status).toBe(409);
  expect(await db.prisma.taskPlacement.count()).toBe(0);
  expect(await db.prisma.taskDelivery.count()).toBe(0);
  expect((await post("owner", "allowed")).status).toBe(202);
  expect(await db.prisma.taskPlacement.count()).toBe(1);
  expect(await db.prisma.taskDelivery.count()).toBe(1);
  expect((await app.request(`/api/routing/linear/${webhookId}`, { method: "POST", body: "{}" })).status).toBe(401);
});

test("peer endpoints reject plaintext remote transports and embedded credentials", () => {
  for (const url of ["http://100.1.2.3:9000", "https://secret@example.com", "https://example.com/path"]) {
    expect(RoutingConfigSchema.safeParse({ peers: { host: { url, apiKey: "long-enough-private-key", repositories: ["repo"] } } }).success).toBe(false);
  }
});
