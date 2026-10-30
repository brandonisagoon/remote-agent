import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createApp } from "../../app.ts";
import { finalizationResourceIdentity } from "../../services/tasks/finalization-resources.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function fixture() {
  const config = testConfig();
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", primarySessionId: "primary", repositoryId: config.repository.id,
    machineId: config.machine, worktreePath: "/original", branchName: "codex/original", phase: "working", toolingRoot: "/tooling", pinnedToolingRoot: "/tooling/pinned", toolingRevision: "a".repeat(40) } });
  await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", cwd: task.worktreePath!, repositoryId: task.repositoryId, machineId: task.machineId, role: "primary", status: "idle" } });
  const compute = await db.prisma.remoteTaskResource.create({ data: { id: "compute", taskId: task.id, key: "development-api", kind: "docker-container", purpose: "development", externalId: "c".repeat(64), state: "ready", metadata: { image: "saved-image", createdAt: "original" } } });
  const data = await db.prisma.remoteTaskResource.create({ data: { id: "data", taskId: task.id, key: "development-data", kind: "docker-volume", purpose: "development", externalId: "saved-volume", state: "ready", metadata: { createdAt: "original" } } });
  const review = await db.prisma.remoteTaskResource.create({ data: { id: "review", taskId: task.id, key: "review-runtime", kind: "task-runtime", purpose: "review", externalId: "/review/runtime.json", state: "ready", expiresAt: new Date(Date.now() + 3_600_000), metadata: { configHash: "b".repeat(64) } } });
  await db.prisma.runtimeInstruction.create({ data: { id: "follow-up", sessionId: "primary", text: "Keep the genuine pending owner instruction", state: "queued" } });
  const runtime = createFakeAgentRuntime();
  runtime.listSessions = async () => (await db.prisma.runtimeSession.findMany()).map(session => ({ ...session, agent: "codex" as const } as any));
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime, trustLocal: true });
  const post = (suffix: string, body: unknown) => app.request(`/api/tasks/task/${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = async () => (await (await app.request("/api/tasks/task")).json() as any).task;
  const intent = async (action: "pause" | "resume", requestKey: string = action) => {
    const response = await post("automation", { action, development: true, requestKey });
    return { response, body: await response.json() as any };
  };
  const renew = (value: any, keys = [compute.key]) => post("development-authority", { intentRevision: value.revision, intentDigest: value.digest, resourceKeys: keys });
  return { config, task, compute, data, review, runtime, app, post, get, intent, renew };
}

test("maintenance pause/resume creates no compute intent; explicit pause persists before an interrupted cancellation", async () => {
  const f = await fixture(), resources = await db.prisma.remoteTaskResource.findMany();
  expect((await f.post("automation", { action: "pause" })).status).toBe(200);
  expect((await f.get()).developmentIntent).toBeUndefined();
  expect((await f.post("automation", { action: "resume" })).status).toBe(200);
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(0);
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "active" } });
  f.runtime.cancel = async () => { throw new Error("Interrupted provider cancellation"); };
  const failed = await f.intent("pause"); expect(failed.response.status).toBe(202);
  const saved = failed.body.task.developmentIntent; expect(saved).toMatchObject({ action: "stop", reason: "owner-pause", state: "pending" });
  expect((await f.renew(saved)).status).toBe(409);
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "idle" } });
  expect((await f.renew(saved)).status).toBe(200);
  expect((await f.intent("pause")).body.task.developmentIntent).toEqual(saved);
  expect(await db.prisma.runtimeMetadataEvent.count()).toBe(1);
  expect(await db.prisma.remoteTaskResource.findMany()).toEqual(resources);
  expect(await db.prisma.runtimeInstruction.findUnique({ where: { id: "follow-up" } })).toMatchObject({ state: "queued", text: "Keep the genuine pending owner instruction" });
});

test("completion covers exact compute membership and current saved resources, and lost acknowledgment retries without new effects or authority", async () => {
  const f = await fixture(), saved = (await f.intent("pause")).body.task.developmentIntent;
  const value = await (await f.renew(saved)).json() as any;
  const complete = { intentRevision: saved.revision, intentDigest: saved.digest, resourcesEpoch: value.resourcesEpoch, resources: value.resources };
  expect((await f.post("development-complete", { ...complete, resources: [] })).status).toBe(409);
  expect((await f.renew(saved, [f.data.key])).status).toBe(409);
  expect((await f.renew(saved, [f.review.key])).status).toBe(409);
  expect((await f.renew(saved, [f.compute.key, f.compute.key])).status).toBe(400);
  expect((await f.post("development-complete", complete)).status).toBe(200);
  const before = await db.prisma.runtimeMetadataEvent.findMany();
  expect((await f.post("development-complete", complete)).status).toBe(200);
  expect(await db.prisma.runtimeMetadataEvent.findMany()).toEqual(before);
  expect((await f.get()).developmentIntent.state).toBe("complete");
  await db.prisma.remoteTaskResource.update({ where: { id: f.data.id }, data: { metadata: { createdAt: "changed-data" } } });
  expect((await f.get()).developmentIntent.state).toBe("pending");
  expect((await f.post("development-complete", complete)).status).toBe(409);
  const changed = await (await f.renew(saved)).json() as any;
  await db.prisma.remoteTaskResource.create({ data: { taskId: f.task.id, key: "new-compute", kind: "native-app", purpose: "development", externalId: "/new-native", state: "ready" } });
  expect((await f.post("development-complete", { ...complete, resourcesEpoch: changed.resourcesEpoch })).status).toBe(409);
});

test("explicit resume supersedes stop; stale pause retries cannot rewind the owner or turn maintenance unpause into resume", async () => {
  const f = await fixture(), stop = (await f.intent("pause")).body.task.developmentIntent;
  expect((await f.post("automation", { action: "resume" })).status).toBe(200);
  expect((await f.get()).developmentIntent).toEqual(stop);
  expect((await f.renew(stop)).status).toBe(409);
  const resumed = await f.intent("resume"); expect(resumed.response.status).toBe(200);
  const resume = resumed.body.task.developmentIntent; expect(resume).toMatchObject({ action: "resume", reason: "owner-resume", state: "pending" });
  expect((await f.renew(stop)).status).toBe(409);
  expect((await f.intent("pause")).response.status).toBe(409);
  expect((await f.get()).ownerPaused).toBeFalse();
  expect((await f.renew(resume)).status).toBe(200);
  await f.post("automation", { action: "pause" }); expect((await f.renew(resume)).status).toBe(409);
  await f.post("automation", { action: "resume" }); expect((await f.renew(resume)).status).toBe(200);
});

test.each(["pin", "branch", "session", "closed"])("saved development intent rejects changed %s and never grants read-only projection as authority", async changed => {
  const f = await fixture(), saved = (await f.intent("pause")).body.task.developmentIntent;
  if (changed === "pin") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { pinnedToolingRoot: "/another-pin" } });
  if (changed === "branch") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { branchName: "codex/another" } });
  if (changed === "session") await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { cwd: "/another-worktree" } });
  if (changed === "closed") await db.prisma.remoteTask.update({ where: { id: f.task.id }, data: { phase: "closed" } });
  expect((await f.renew(saved)).status).toBe(409);
  const observed = await f.get(); expect(observed.developmentIntent).toBeUndefined(); expect(observed.developmentBlocked).toBeString();
});

test("resume refuses current cleanup, preserves historical revoked operations, and renews the conflict check before effects", async () => {
  const f = await fixture(); await f.intent("pause");
  const operation = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "finalizer:task", action: "finalization-cleanup-started", key: "finalize:task", value: "unchanged historical operation bytes" } });
  expect((await f.intent("resume", "current-cleanup")).response.status).toBe(409); expect((await f.get()).ownerPaused).toBeTrue();
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "owner:task", action: "delivered-retirement-revoked", key: "owner-revoke", value: JSON.stringify({ basis: "Owner returned to work" }) } });
  const transport = await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "runtime", action: "cleanup-provider-transport", key: "transport", value: JSON.stringify({ mode: "cleanup" }) } });
  expect((await f.intent("resume", "still-cleanup-transport")).response.status).toBe(409);
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "runtime", action: "cleanup-provider-transport", key: "return-work", value: JSON.stringify({ mode: "work", previousRevision: transport.sequence }) } });
  const resumed = await f.intent("resume", "returned-work"); expect(resumed.response.status).toBe(200);
  expect((await f.renew(resumed.body.task.developmentIntent)).status).toBe(200);
  await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "owner:task", action: "prepared-done-retirement", key: "owner-regrant", value: "{}" } });
  expect((await f.renew(resumed.body.task.developmentIntent)).status).toBe(409);
  expect(await db.prisma.runtimeMetadataEvent.findUnique({ where: { sequence: operation.sequence } })).toEqual(operation);
});

test("review handoff binds a separate ready leased runtime; a checkout-ready flag or expired/changed review cannot stop development", async () => {
  const f = await fixture();
  const selected = { key: f.review.key, identityDigest: finalizationResourceIdentity(f.review).identityDigest };
  const response = await f.post("automation", { action: "stop-development", requestKey: "review-handoff", review: selected });
  expect(response.status).toBe(200); const saved = (await response.json() as any).task.developmentIntent;
  expect((await f.get()).ownerPaused).toBeFalse(); expect((await f.renew(saved)).status).toBe(200);
  await db.prisma.remoteTaskResource.update({ where: { id: f.review.id }, data: { expiresAt: new Date(0) } });
  expect((await f.renew(saved)).status).toBe(409);
  const checkout = await db.prisma.remoteTaskResource.update({ where: { id: f.review.id }, data: { kind: "git-worktree", expiresAt: new Date(Date.now() + 3_600_000) } });
  expect((await f.post("automation", { action: "stop-development", requestKey: "checkout-only", review: { key: checkout.key, identityDigest: finalizationResourceIdentity(checkout).identityDigest } })).status).toBe(409);
  expect((await f.get()).ownerPaused).toBeFalse();
});

test.each(["active", "provisioning", "unknown", "dispatching"])("paused development stop refuses %s writers and preserves every instruction", async state => {
  const f = await fixture(), saved = (await f.intent("pause")).body.task.developmentIntent;
  if (state === "dispatching") await db.prisma.runtimeInstruction.update({ where: { id: "follow-up" }, data: { state } });
  else await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: state } });
  expect((await f.renew(saved)).status).toBe(409);
  expect((await f.get()).ownerPaused).toBeTrue();
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
});

test("ordinary paused stop acknowledgment preserves saved data and separate review", async () => {
  const f = await fixture(); await f.intent("pause");
  const write = (body: unknown) => f.app.request("/api/sessions/primary/task/resources", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const receipt = { key: f.compute.key, kind: f.compute.kind, purpose: f.compute.purpose, externalId: f.compute.externalId, state: "allocated", metadata: { ...(f.compute.metadata as object), observed: "stopped-data-retained", observedAt: new Date().toISOString() } };
  expect((await write(receipt)).status).toBe(200);
  const saved = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.compute.id } });
  expect(saved.state).toBe("allocated"); expect(finalizationResourceIdentity(saved).identityDigest).toBe(finalizationResourceIdentity(f.compute).identityDigest);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.data.id } })).toEqual(f.data);
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.review.id } })).toEqual(f.review);
});

test("a newer explicit resume prevents an older pause from cancelling the resumed turn", async () => {
  const f = await fixture(); let calls = 0;
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "active" } });
  const list = f.runtime.listSessions;
  f.runtime.listSessions = async query => {
    const rows = await list(query);
    if (!calls++) await f.intent("resume", "new-owner-resume");
    return rows;
  };
  let cancelled = false; f.runtime.cancel = async () => { cancelled = true; };
  const result = await f.intent("pause"); expect(result.response.status).toBe(409); expect(cancelled).toBeFalse();
  expect((await f.get()).ownerPaused).toBeFalse(); expect((await f.get()).developmentIntent.reason).toBe("owner-resume");
});

test.each(["pause", "resume"] as const)("an older %s route cannot overwrite the opposite intent committed before its task reread", async action => {
  const f = await fixture(), opposite = action === "pause" ? "resume" : "pause";
  if (action === "resume") await f.intent("pause", "initial-pause");
  let newer: Awaited<ReturnType<typeof f.intent>> | undefined;
  const prisma = new Proxy(db.prisma, { get(target, key) {
    if (key === "$transaction") return async (...args: any[]) => {
      const result = await (target.$transaction as any)(...args);
      // The first request is suspended after its real transaction commits,
      // while the opposite request completes through the real route.
      if (result?.intentRevision && !newer) newer = await f.intent(opposite, "newer-opposite");
      return result;
    };
    return Reflect.get(target, key);
  } });
  const app = createApp({ config: f.config, prisma, agentRuntime: f.runtime, trustLocal: true });
  const old = await app.request("/api/tasks/task/automation", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, development: true, requestKey: "older-request" }) });
  expect(newer!.response.status).toBe(200); expect(old.status).toBe(409);
  expect((await f.get()).ownerPaused).toBe(opposite === "pause");
  expect((await f.get()).developmentIntent.requestKey).toBe("newer-opposite");
  expect((await f.get()).developmentIntent.action).toBe(opposite === "pause" ? "stop" : "resume");
  expect(await db.prisma.runtimeInstruction.findUnique({ where: { id: "follow-up" } })).toMatchObject({ state: "queued" });
});

const draftedRoot = process.env.DRAFTED_DEVELOPMENT_INTEGRATION_ROOT;
test.skipIf(!draftedRoot)("actual client retries only the saved pending cancellation through the real automation route", async () => {
  const f = await fixture();
  await db.prisma.remoteTaskResource.update({ where: { id: f.compute.id }, data: { state: "released" } });
  await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "active" } });
  let cancels = 0;
  f.runtime.cancel = async () => {
    if (++cancels === 1) throw new Error("Lost cancellation response before terminal receipt");
    await db.prisma.runtimeSession.update({ where: { id: "primary" }, data: { status: "idle" } });
  };
  const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
  const { requestDevelopmentChange } = await import(path.join(draftedRoot!, "src/development-intent.ts"));
  const socket = path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `settling-${randomUUID().slice(0, 8)}.sock`);
  const server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const result = await requestDevelopmentChange(taskRegistry(socket, f.task.id), "pause", "same-pending-key", undefined, { settleTimeoutMs: 2000, pollIntervalMs: 10 });
    expect(result.developmentIntent).toMatchObject({ requestKey: "same-pending-key", state: "complete" }); expect(cancels).toBe(2);
    expect(await db.prisma.runtimeMetadataEvent.count({ where: { action: "development-compute-intent" } })).toBe(1);
    expect((await f.get()).ownerPaused).toBeTrue(); expect(await db.prisma.remoteTaskResource.findUnique({ where: { id: f.data.id } })).toEqual(f.data);
    expect(await db.prisma.runtimeInstruction.findUnique({ where: { id: "follow-up" } })).toMatchObject({ state: "queued" });
  } finally { server.stop(true); }
});

test.skipIf(!draftedRoot)("actual control client finishes interrupted paused stop and explicit resume with unchanged saved data and review", async () => {
  const f = await fixture();
  const { taskRegistry } = await import(path.join(draftedRoot!, "src/control.ts"));
  const { upkeepTask } = await import(path.join(draftedRoot!, "src/upkeep.ts"));
  const { manageResource } = await import(path.join(draftedRoot!, "src/resources.ts"));
  const socket = path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `development-${randomUUID().slice(0, 8)}.sock`);
  const server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  try {
    const registry = taskRegistry(socket, f.task.id), saved = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.data.id } });
    const review = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.review.id } });
    const scenario = Buffer.from('{"design":"original","lot":[1,2,3]}'), original = Buffer.from(scenario);
    let running = true, stops = 0, starts = 0, loseStop = true;
    const docker = {
      inspect: async (_kind: string, id: string) => { expect(id).toBe(f.compute.externalId); return { id, image: "saved-image", running,
        labels: { "dev.drafted.task": f.task.id, "dev.drafted.purpose": "development" }, networks: [], volumes: [saved.externalId] }; },
      stop: async () => { running = false; stops++; if (loseStop) { loseStop = false; throw new Error("Lost stop response"); } },
      start: async () => { running = true; starts++; },
      remove: async () => { throw new Error("No development data or compute removal is authorized"); },
    };
    const manage = (input: any) => manageResource({ ...input, docker });
    await f.intent("pause");
    await expect(upkeepTask(registry, "expired", manage)).rejects.toThrow("Lost stop response");
    expect((await f.get()).ownerPaused).toBeTrue(); expect((await f.get()).developmentIntent.state).toBe("pending");
    await upkeepTask(registry, "expired", manage);
    expect(running).toBeFalse(); expect(stops).toBe(1); expect((await f.get()).developmentIntent.state).toBe("complete");
    await f.post("automation", { action: "resume" }); await upkeepTask(registry, "expired", manage);
    expect(running).toBeFalse(); expect(starts).toBe(0);
    await f.intent("resume");
    const complete = registry.completeDevelopmentIntent!;
    registry.completeDevelopmentIntent = async (input: unknown) => { await complete(input); throw new Error("Lost completion response"); };
    await expect(upkeepTask(registry, "expired", manage)).rejects.toThrow("Lost completion response");
    await upkeepTask(registry, "expired", manage);
    expect(running).toBeTrue(); expect(starts).toBe(1); expect((await f.get()).ownerPaused).toBeFalse();
    expect(scenario).toEqual(original);
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.data.id } })).toEqual(saved);
    expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.review.id } })).toEqual(review);
    expect(await db.prisma.remoteTaskResource.count({ where: { state: "released" } })).toBe(0);
    expect(await db.prisma.runtimeInstruction.findUnique({ where: { id: "follow-up" } })).toMatchObject({ state: "queued" });
  } finally { await server.stop(true); }
});
