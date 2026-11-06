import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { ComputePolicy } from "../../../../lib/compute-policy.ts";
import { claimCompute, confirmComputeDelivery, offerNextCompute, readComputeCapacity, reconcileComputeOffers, requestCompute } from "./compute-admission.ts";
import { refreshComputeBaselines } from "./compute-baseline.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await createTestDatabase(); cleanups.push(db.cleanup);
  const prisma = db.prisma, runtime = createFakeAgentRuntime(), now = new Date("2030-01-01T00:00:00Z");
  runtime.observeSessionActivity = () => ({ state: "unknown", observedAt: now.getTime() });
  const config = testConfig({ machine: "host", compute: ComputePolicy.parse({ enabled: false, slots: 1 }) });
  for (const id of ["old", "waiting"]) {
    await prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: `/${id}`, status: id === "old" ? "closed" : "idle", ...(id === "old" ? { closedAt: now } : {}) } });
    await prisma.remoteTask.create({ data: { id, requestKey: id, repositoryId: "repo", machineId: "host", branchName: `codex/${id}`, worktreePath: `/${id}`, toolingRoot: "/old/tooling", toolingRevision: "a".repeat(40), primarySessionId: id, phase: id === "old" ? "closed" : "working", ownerPaused: id === "old" } });
  }
  for (const key of ["app", "database"]) await prisma.remoteTaskResource.create({ data: { id: key, taskId: "old", key, kind: "docker-container", purpose: "development", externalId: key.repeat(32), state: "ready", metadata: { original: key } } });
  const context = { prisma, config, runtime, now };
  const admission = { prisma, runtime, now, machineId: "host", policy: ComputePolicy.parse({ enabled: true, slots: 1 }) };
  const request = { key: "new", purpose: "development" as const, revision: "b".repeat(40), recipeDigest: "c".repeat(64) };
  await requestCompute({ ...admission, taskId: "waiting", request });
  const read: NonNullable<Parameters<typeof refreshComputeBaselines>[1]> = async (_input, _task, raw: any) => ({ version: 1, kind: "compute-baseline", machineId: raw.machineId, taskId: raw.task.id,
    primarySessionId: raw.task.primarySessionId, purpose: raw.purpose, resourceSetDigest: raw.resourceSetDigest, observedAt: now.getTime(),
    resources: raw.resources.map((resource: any) => ({ resourceId: resource.id, resourceIdentity: resource.identityDigest, state: "stopped", proofDigest: "d".repeat(64) })) });
  return { ...context, context, admission, request, read };
}
test("unbound closed/paused original group frees one justified slot, without enrollment or changing original facts", async () => {
  const f = await fixture();
  const original = { task: await f.prisma.remoteTask.findUnique({ where: { id: "old" } }), resources: await f.prisma.remoteTaskResource.findMany({ where: { taskId: "old" }, orderBy: { id: "asc" } }), session: await f.prisma.runtimeSession.findUnique({ where: { id: "old" } }) };
  expect(await readComputeCapacity({ ...f.admission, taskId: "waiting" })).toMatchObject({ unaccounted: 1, occupied: 0, headroom: 0 });
  expect(await offerNextCompute(f.admission)).toBeNull();
  expect(await refreshComputeBaselines(f.context, f.read)).toEqual({ observed: 1, unavailable: 0 });
  expect(await readComputeCapacity({ ...f.admission, taskId: "waiting" })).toMatchObject({ unaccounted: 0, occupied: 0, headroom: 1 });
  const offer = await offerNextCompute(f.admission); expect(offer).not.toBeNull();
  await f.prisma.runtimeInstruction.update({ where: { id: offer!.instructionId }, data: { state: "dispatching", executionRequestId: offer!.instructionId } });
  await f.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: "waiting", requestId: offer!.instructionId, phase: "started", occurredAt: f.now } });
  const delivered = await confirmComputeDelivery({ ...f.admission, sessionId: "waiting", requestId: offer!.instructionId });
  expect(delivered?.state).toBe("offered");
  expect(await readComputeCapacity({ ...f.admission, taskId: "waiting" })).toMatchObject({ unaccounted: 0, occupied: 1, headroom: 0 });
  expect((await claimCompute({ ...f.admission, taskId: "waiting", offerId: offer!.id, request: f.request })).offer.state).toBe("claimed");
  expect(await f.prisma.computeEnvironment.count({ where: { taskId: "old" } })).toBe(0);
  expect(await f.prisma.remoteTask.findUnique({ where: { id: "old" } })).toEqual(original.task);
  expect(await f.prisma.runtimeSession.findUnique({ where: { id: "old" } })).toEqual(original.session);
  expect(await f.prisma.remoteTaskResource.findMany({ where: { taskId: "old" }, orderBy: { id: "asc" } })).toEqual(original.resources);
});
test.each(["running", "unknown", "read-failure", "missing", "duplicate", "wrong-owner", "stale"])("%s cannot reuse an earlier stopped proof", async kind => {
  const f = await fixture(); await refreshComputeBaselines(f.context, f.read);
  expect(await refreshComputeBaselines(f.context, async (...args) => {
    if (kind === "read-failure") throw new Error("unavailable");
    const result = await f.read(...args) as any;
    if (["running", "unknown"].includes(kind)) result.resources[1].state = kind;
    if (kind === "missing") result.resources.pop();
    if (kind === "duplicate") result.resources[1] = result.resources[0];
    if (kind === "wrong-owner") result.taskId = "foreign";
    if (kind === "stale") result.observedAt -= 60_000;
    return result;
  })).toEqual({ observed: 0, unavailable: 1 });
  expect(await readComputeCapacity({ ...f.admission, taskId: "waiting" })).toMatchObject({ unaccounted: 1, headroom: 0 });
  expect(await offerNextCompute(f.admission)).toBeNull();
});
test.each(["changed", "new-member", "active-grandchild", "pending-grandchild", "late-claim"])("late %s invalidates complete original-group proof", async kind => {
  const f = await fixture(); await refreshComputeBaselines(f.context, f.read);
  if (kind === "changed") await f.prisma.remoteTaskResource.update({ where: { id: "app" }, data: { metadata: { original: "replacement" } } });
  if (kind === "new-member") await f.prisma.remoteTaskResource.create({ data: { taskId: "old", key: "new", kind: "native-app", purpose: "development", externalId: "999", state: "ready" } });
  if (kind.endsWith("grandchild")) {
    for (const [id, parent] of [["child", "old"], ["grandchild", "child"]]) {
      await f.prisma.runtimeSession.create({ data: { id, scopeKey: id!, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "delegate", cwd: `/moved/${id}`, status: kind === "active-grandchild" && id === "grandchild" ? "active" : "idle" } });
      await f.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: id!, targetSessionId: parent!, relationship: "spawned-by", endedAt: f.now } });
    }
    if (kind === "pending-grandchild") await f.prisma.runtimeInstruction.create({ data: { id: "pending", sessionId: "grandchild", text: "work", state: "unknown" } });
  }
  if (kind === "late-claim") await f.prisma.remoteTaskResource.create({ data: { taskId: "waiting", key: "overlap", kind: "docker-container", purpose: "development", externalId: "app".repeat(32), state: "ready" } });
  expect(await readComputeCapacity({ ...f.admission, taskId: "waiting" })).toMatchObject({ unaccounted: kind === "late-claim" ? 2 : 1, headroom: 0 });
  expect(await offerNextCompute(f.admission)).toBeNull();
});
test.each(["running", "failed"])("Released original members retain reservation after %s physical refresh", async kind => {
  const f = await fixture(); await refreshComputeBaselines(f.context, f.read);
  await f.prisma.remoteTaskResource.updateMany({ where: { taskId: "old" }, data: { state: "released" } });
  expect(await offerNextCompute(f.admission)).toBeNull();
  await refreshComputeBaselines(f.context, async (...args) => {
    if (kind === "failed") throw new Error("read failed");
    const result = await f.read(...args) as any; result.resources[0].state = "running"; return result;
  });
  expect(await offerNextCompute(f.admission)).toBeNull();
  expect(await refreshComputeBaselines(f.context, f.read)).toEqual({ observed: 1, unavailable: 0 });
  expect(await offerNextCompute(f.admission)).not.toBeNull();
});
test("older in-flight observation cannot overwrite a newer failed refresh", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const old = refreshComputeBaselines(f.context, async (...args) => { const result = await f.read(...args); entered(); await gate; return result; });
  await ready;
  expect(await refreshComputeBaselines(f.context, async () => { throw new Error("new unavailable read"); })).toEqual({ observed: 0, unavailable: 1 });
  release(); expect(await old).toEqual({ observed: 0, unavailable: 1 });
  expect(await offerNextCompute(f.admission)).toBeNull();
});
test("old inventory cannot erase a newer retained member after its registry release", async () => {
  const f = await fixture(); await refreshComputeBaselines(f.context, f.read);
  const findMany = f.prisma.computeBaseline.findMany;
  let entered!: () => void, release!: () => void, first = true;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.prisma.computeBaseline.findMany = (async (...args: any[]) => {
    const rows = await (findMany as any)(...args);
    if (first) { first = false; entered(); await gate; }
    return rows;
  }) as typeof findMany;
  const read: typeof f.read = async (...args) => {
    const result = await f.read(...args) as any;
    for (const resource of result.resources) if (resource.resourceId === "late") resource.state = "running";
    return result;
  };
  try {
    const old = refreshComputeBaselines(f.context, read); await ready;
    await f.prisma.remoteTaskResource.create({ data: { id: "late", taskId: "old", key: "late", kind: "docker-container", purpose: "development", externalId: "late-container", state: "ready" } });
    expect(await refreshComputeBaselines(f.context, read)).toEqual({ observed: 0, unavailable: 1 });
    await f.prisma.remoteTaskResource.update({ where: { id: "late" }, data: { state: "released" } });
    release(); expect(await old).toEqual({ observed: 0, unavailable: 1 });
    expect((await f.prisma.computeBaseline.findFirstOrThrow()).resourceIds).toEqual(["app", "database", "late"]);
    expect(await offerNextCompute(f.admission)).toBeNull();
  } finally { release(); f.prisma.computeBaseline.findMany = findMany; }
});
test("inventory failure invalidates old credit before the failing read", async () => {
  const f = await fixture(); await refreshComputeBaselines(f.context, f.read);
  const read = f.prisma.remoteTaskResource.findMany;
  f.prisma.remoteTaskResource.findMany = (() => { throw new Error("inventory unavailable"); }) as typeof read;
  try { await expect(refreshComputeBaselines(f.context, f.read)).rejects.toThrow("inventory unavailable"); }
  finally { f.prisma.remoteTaskResource.findMany = read; }
  expect(await offerNextCompute(f.admission)).toBeNull();
});
test("four bounded readers reconcile fourteen original groups before one-slot admission", async () => {
  const f = await fixture();
  for (let index = 1; index < 14; index++) {
    const id = `old-${index}`;
    await f.prisma.runtimeSession.create({ data: { id, scopeKey: id, agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: `/${id}`, status: "closed", closedAt: f.now } });
    await f.prisma.remoteTask.create({ data: { id, requestKey: id, repositoryId: "repo", machineId: "host", branchName: `codex/${id}`, worktreePath: `/${id}`, toolingRoot: "/old/tooling", toolingRevision: "a".repeat(40), primarySessionId: id, phase: "closed" } });
    await f.prisma.remoteTaskResource.create({ data: { taskId: id, key: "app", kind: "docker-container", purpose: "development", externalId: `${id}-container`, state: "ready" } });
  }
  let active = 0, maximum = 0, reads = 0;
  expect(await refreshComputeBaselines(f.context, async (...args) => {
    active++; maximum = Math.max(maximum, active); reads++;
    try { await new Promise(resolve => setTimeout(resolve, 5)); return await f.read(...args); }
    finally { active--; }
  })).toEqual({ observed: 14, unavailable: 0 });
  expect(reads).toBe(14); expect(maximum).toBeLessThanOrEqual(4);
  expect(await offerNextCompute(f.admission)).not.toBeNull();
  expect(await f.prisma.computeEnvironment.count()).toBe(1);
});
test.each(["task", "member", "active", "stale"])("%s changed during the physical read cannot publish credit", async kind => {
  const f = await fixture();
  expect(await refreshComputeBaselines(f.context, async (...args) => {
    const result = await f.read(...args) as any;
    if (kind === "task") await f.prisma.remoteTask.update({ where: { id: "old" }, data: { toolingRevision: "e".repeat(40) } });
    if (kind === "member") await f.prisma.remoteTaskResource.update({ where: { id: "app" }, data: { externalId: "replacement" } });
    if (kind === "active") f.runtime.observeSessionActivity = () => ({ state: "executing", observedAt: f.now.getTime() });
    if (kind === "stale") result.observedAt -= 60_000;
    return result;
  })).toEqual({ observed: 0, unavailable: 1 });
  expect(await offerNextCompute(f.admission)).toBeNull();
});
test.each(["normal", "restart-before-delivery", "restart-before-claim", "broken-capability"])("configured immutable adapter refreshes ordinary admission: %s", async mode => {
  const f = await fixture(), root = await realpath(await mkdtemp(path.join(tmpdir(), "compute-baseline-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const staging = path.join(root, "source"), state = path.join(root, "physical.json"), calls = path.join(root, "calls");
  await mkdir(staging); await writeFile(state, JSON.stringify("stopped"));
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", "-C", staging, ...args]); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  git("init", "-q");
  await writeFile(path.join(staging, "observer.ts"), `import {appendFile} from 'node:fs/promises';
const input=JSON.parse(await Bun.stdin.text());
if(process.argv.at(-1)!=='baseline-observe') throw new Error('Wrong read-only contract');
await appendFile(${JSON.stringify(calls)},'read\\n');
const state=await Bun.file(${JSON.stringify(state)}).json();
console.log(JSON.stringify({version:1,kind:'compute-baseline',machineId:input.machineId,taskId:input.task.id,primarySessionId:input.task.primarySessionId,purpose:input.purpose,resourceSetDigest:input.resourceSetDigest,observedAt:${f.now.getTime()},resources:input.resources.map(r=>({resourceId:r.id,resourceIdentity:r.identityDigest,state,proofDigest:'d'.repeat(64)}))}));`);
  await writeFile(path.join(staging, ".remote-agent-capabilities.json"), JSON.stringify({ capabilities: { runtime: { adapter: "observer.ts", observationContracts: ["compute-traffic/v1", "compute-baseline/v1"] } } }));
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD"), checkout = path.join(root, "tooling", "repo", revision);
  await mkdir(path.dirname(checkout), { recursive: true }); await rename(staging, checkout);
  const config = { ...f.config, compute: f.admission.policy, installRoot: root, repositories: { repo: { ...f.config.repository, id: "repo", tooling: { repository: "https://example.invalid/tooling.git", revision } } } } as unknown as typeof f.config;
  const admission = { ...f.admission, config };
  const offer = await offerNextCompute(admission); expect(offer).not.toBeNull();
  await f.prisma.runtimeInstruction.update({ where: { id: offer!.instructionId }, data: { state: "dispatching", executionRequestId: offer!.instructionId } });
  await f.prisma.runtimeLifecycleEvent.create({ data: { id: "started", runtimeSessionId: "waiting", requestId: offer!.instructionId, phase: "started", occurredAt: f.now } });
  if (mode === "restart-before-delivery") await writeFile(state, JSON.stringify("running"));
  if (mode === "broken-capability") await writeFile(path.join(checkout, "observer.ts"), "throw new Error('changed');");
  const delivered = await confirmComputeDelivery({ ...admission, sessionId: "waiting", requestId: offer!.instructionId });
  // DRA-34: selection reserved after a fresh refresh; delivery only records
  // progress and never re-scans. The claim makes the next fresh decision.
  expect(delivered?.state).toBe("offered");
  expect(await f.prisma.computeSlot.count({ where: { allocationId: offer!.id } })).toBe(1);
  if (mode === "restart-before-claim") await writeFile(state, JSON.stringify("running"));
  if (mode === "normal") expect((await claimCompute({ ...admission, taskId: "waiting", offerId: offer!.id, request: f.request })).offer.state).toBe("claimed");
  else {
    await expect(claimCompute({ ...admission, taskId: "waiting", offerId: offer!.id, request: f.request })).rejects.toThrow("reservation is unavailable");
    // A refused claim never frees the running turn's reservation.
    expect(await f.prisma.computeSlot.count({ where: { allocationId: offer!.id } })).toBe(1);
  }
  // Selection's fresh read always happened; the claim reads again only when the
  // family is settled and the capability verifies.
  const reads = (await readFile(calls, "utf8")).trim().split("\n").length;
  if (mode === "normal") expect(reads).toBe(2); else { expect(reads).toBeGreaterThanOrEqual(1); expect(reads).toBeLessThanOrEqual(2); }
  expect(await f.prisma.computeEnvironment.count({ where: { taskId: "old" } })).toBe(0);
  expect(await f.prisma.runtimeMetadataEvent.count()).toBe(0);
});

test.each(["stale", "missing-runtime", "executing", "queued"])("diagnostic cannot turn %s activity/proof into free credit", async kind => {
  const f = await fixture(); await refreshComputeBaselines(f.context, f.read);
  const input = { ...f.admission, taskId: "waiting" };
  if (kind === "missing-runtime") {
    await expect(readComputeCapacity({ ...input, runtime: {} })).rejects.toThrow("observation is unavailable");
  } else {
    if (kind === "stale") input.now = new Date(f.now.getTime() + 15_001);
    else f.runtime.observeSessionActivity = () => ({ state: kind as "executing" | "queued", observedAt: f.now.getTime() });
    expect(await readComputeCapacity(input)).toMatchObject({ unaccounted: 1, headroom: 0 });
    expect(await offerNextCompute(input)).toBeNull();
  }
});
test.each(["running", "unknown", "starting"])("unallocated %s environments remain debited even with a stopped original group", async state => {
  const f = await fixture(); await refreshComputeBaselines(f.context, f.read);
  await f.prisma.computeEnvironment.updateMany({ where: { taskId: "waiting" }, data: { state } });
  expect(await readComputeCapacity({ ...f.admission, taskId: "waiting" })).toMatchObject({ unaccounted: 1, occupied: 0, headroom: 0 });
  expect(await offerNextCompute(f.admission)).toBeNull();
});

test("changing original credit with two eligible waiters never exceeds one managed reservation or claim", async () => {
  const f = await fixture(), admission = { ...f.admission, policy: ComputePolicy.parse({ enabled: true, slots: 3, maxManagedAllocations: 1 }) };
  await f.prisma.runtimeSession.create({ data: { id: "second", scopeKey: "second", agentCommand: "codex", machineId: "host", repositoryId: "repo", role: "primary", cwd: "/second", status: "idle" } });
  await f.prisma.remoteTask.create({ data: { id: "second", requestKey: "second", machineId: "host", repositoryId: "repo", primarySessionId: "second", worktreePath: "/second", branchName: "codex/second", toolingRoot: "/tooling", toolingRevision: "a".repeat(40), phase: "working" } });
  await requestCompute({ ...admission, taskId: "second", request: f.request });
  const originals = await f.prisma.remoteTaskResource.findMany({ where: { taskId: "old" } });
  expect(await readComputeCapacity({ ...admission, taskId: "waiting" })).toMatchObject({ unaccounted: 1, budgetUsable: 2, usable: 1 });
  const first = (await offerNextCompute(admission))!;
  await f.prisma.runtimeInstruction.update({ where: { id: first.instructionId }, data: { state: "dispatching", executionRequestId: first.instructionId } });
  await f.prisma.runtimeLifecycleEvent.create({ data: { id: "cap-start", runtimeSessionId: "waiting", requestId: first.instructionId, phase: "started", occurredAt: f.now } });
  expect((await confirmComputeDelivery({ ...admission, sessionId: "waiting", requestId: first.instructionId }))?.state).toBe("offered");
  await refreshComputeBaselines(f.context, f.read);
  expect(await readComputeCapacity({ ...admission, taskId: "waiting" })).toMatchObject({ unaccounted: 0, budgetUsable: 3, usable: 1, occupied: 1, headroom: 0 });
  expect(await offerNextCompute(admission)).toBeNull();
  await refreshComputeBaselines(f.context, async () => { throw Error("physical proof unavailable"); });
  expect(await readComputeCapacity({ ...admission, taskId: "waiting" })).toMatchObject({ unaccounted: 1, occupied: 1, usable: 1, headroom: 0 });
  expect((await claimCompute({ ...admission, taskId: "waiting", offerId: first.id, request: f.request })).offer.state).toBe("claimed");
  await reconcileComputeOffers({ ...admission, now: new Date(f.now.getTime() + 600000) });
  expect((await f.prisma.computeOffer.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("unknown");
  expect(await offerNextCompute({ ...admission, now: new Date(f.now.getTime() + 600001) })).toBeNull();
  expect(await f.prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(1);
  expect(await f.prisma.remoteTaskResource.findMany({ where: { taskId: "old" } })).toEqual(originals);
});

test("DRA-36: a long refresh of one group never clears another group's fresh proof, and names the exact pending group", async () => {
  const f = await fixture();
  await f.prisma.runtimeSession.create({ data: { id: "old-2", scopeKey: "old-2", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/old-2", status: "closed", closedAt: f.now } });
  await f.prisma.remoteTask.create({ data: { id: "old-2", requestKey: "old-2", repositoryId: "repo", machineId: "host", branchName: "codex/old-2", worktreePath: "/old-2", toolingRoot: "/old/tooling", toolingRevision: "a".repeat(40), primarySessionId: "old-2", phase: "closed" } });
  await f.prisma.remoteTaskResource.create({ data: { id: "old-2-app", taskId: "old-2", key: "app", kind: "docker-container", purpose: "development", externalId: "old-2-container", state: "ready" } });
  const policy = ComputePolicy.parse({ enabled: true, slots: 2 }), input = { ...f.admission, policy, taskId: "waiting" };
  expect(await refreshComputeBaselines(f.context, f.read)).toEqual({ observed: 2, unavailable: 0 });
  expect(await readComputeCapacity(input)).toMatchObject({ unaccounted: 0 });
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const pass = refreshComputeBaselines(f.context, async (input, task, raw) => { if (task.id === "old-2") { entered(); await gate; } return f.read(input, task, raw); });
  await held;
  // Only the group whose own refresh is in progress loses credit.
  const during = await readComputeCapacity(input);
  expect(during).toMatchObject({ unaccounted: 1 });
  expect(during.blockers.unaccounted).toEqual([{ group: "old-2:development", reason: "uncredited-baseline", ids: ["old-2-app"], detail: "baseline missing-proof", action: expect.stringContaining("baseline refresh") }]);
  release();
  expect(await pass).toEqual({ observed: 2, unavailable: 0 });
  expect(await readComputeCapacity(input)).toMatchObject({ unaccounted: 0 });
});
