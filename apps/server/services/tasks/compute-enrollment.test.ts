import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { beginTraffic, applyTraffic } from "../../../../lib/compute-telemetry.ts";
import { enrollCompute } from "./compute-enrollment.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { reconcileObservedCompute } from "./compute-admission.ts";
let db: TestDatabase;
const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: true, slots: 1 }) });
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function fixture() {
  const primary = await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "task", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/fixture/task", status: "idle" } });
  await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "host", branchName: "codex/task", worktreePath: primary.cwd, toolingRoot: "/fixture/tooling", toolingRevision: "c".repeat(40), primarySessionId: primary.id, phase: "working" } });
  const resource = await db.prisma.remoteTaskResource.create({ data: { id: "app", taskId: "task", key: "development", kind: "docker-compose-project", purpose: "development", externalId: "original-compose", state: "ready", metadata: { original: "unchanged" } } });
  const request = { key: resource.key, purpose: "development" as const, revision: "a".repeat(40), recipeDigest: "b".repeat(64), environmentId: crypto.randomUUID(), resourceIdentity: finalizationResourceIdentity(resource).identityDigest, configuration: { configurationFile: "/fixture/compute.json", configurationSha256: "d".repeat(64) } };
  const route = { id: "route", taskId: "task", primarySessionId: primary.id, environmentId: request.environmentId, purpose: request.purpose, revision: request.revision, resourceId: resource.id, resourceIdentity: request.resourceIdentity, service: "api", proxyId: "proxy", configurationDigest: request.configuration.configurationSha256 };
  const observation = { version: 1 as const, environmentId: request.environmentId, taskId: "task", primarySessionId: primary.id, purpose: request.purpose, revision: request.revision, recipeDigest: request.recipeDigest, resourceId: resource.id, resourceIdentity: request.resourceIdentity, observedAt: Date.now(), state: "running" as "running" | "stopped", coverage: "incomplete" as const, configurationDigest: route.configurationDigest, routes: [route], operations: { coverage: "incomplete" as const, active: 0, generation: "e".repeat(64) } };
  return { input: { prisma: db.prisma, config, taskId: "task", request }, observation, resource, traffic: beginTraffic(route, "epoch", Date.now(), false) };
}
test("owner enrollment records exact unknown coverage without rewriting resources, offers or allocations", async () => {
  const f = await fixture();
  const result = await enrollCompute(f.input, async () => ({ observation: f.observation, traffic: [f.traffic] }));
  expect(result.coverage).toBe("incomplete");
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(f.resource);
  expect(await db.prisma.computeOffer.count()).toBe(0); expect(await db.prisma.computeSlot.count()).toBe(0); expect(await db.prisma.computeWait.count()).toBe(0);
  f.observation.state = "stopped";
  await enrollCompute(f.input, async (_input, _task, _environment, _resource, previous) => { expect(previous?.length).toBe(1); return { observation: f.observation, traffic: [f.traffic] }; });
  expect(await reconcileObservedCompute({ prisma: db.prisma, machineId: "host", policy: config.compute!, environmentId: f.input.request.environmentId, runtime: {} })).toEqual({ released: true });
  expect((await db.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: f.input.request.environmentId } })).state).toBe("suspended");
});
test("enrollment retry retains in-flight traffic and refuses concurrent collector changes", async () => {
  const f = await fixture();
  f.traffic = applyTraffic(f.traffic, { version: 1, routeId: f.traffic.route.id, epoch: f.traffic.epoch, sequence: 1, observedAt: Date.now(), event: { kind: "start", requestId: "stream", classification: "meaningful" } }, Date.now());
  await enrollCompute(f.input, async () => ({ observation: f.observation, traffic: [f.traffic] }));
  await enrollCompute(f.input, async (_input, _task, _environment, _resource, previous) => {
    expect((previous![0]!.state as any).active.stream).toBeDefined(); return { observation: f.observation, traffic: [f.traffic] };
  });
  await expect(enrollCompute(f.input, async () => {
    await db.prisma.computeTraffic.update({ where: { routeId: "route" }, data: { sequence: 2 } });
    return { observation: f.observation, traffic: [f.traffic] };
  })).rejects.toThrow("changed during observation");
  expect((await db.prisma.computeTraffic.findUniqueOrThrow({ where: { routeId: "route" } })).sequence).toBe(2);
});
test.each(["pause", "pin", "resource"])("%s during enrollment grants no observation or start authority", async changed => {
  const f = await fixture();
  await expect(enrollCompute(f.input, async () => {
    if (changed === "pause") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { ownerPaused: true } });
    if (changed === "pin") await db.prisma.remoteTask.update({ where: { id: "task" }, data: { toolingRevision: "f".repeat(40) } });
    if (changed === "resource") await db.prisma.remoteTaskResource.update({ where: { id: f.resource.id }, data: { metadata: { original: "changed" } } });
    return { observation: f.observation, traffic: [f.traffic] };
  })).rejects.toThrow();
  expect(await db.prisma.computeEnvironment.count()).toBe(0); expect(await db.prisma.computeOffer.count()).toBe(0);
});
