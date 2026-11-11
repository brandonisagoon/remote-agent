import { afterEach, expect, test } from "bun:test";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { readToolingOperation } from "./tooling-releases.ts";
import { completedReviewConfigurationAllows } from "./tooling-operations.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(admission = false) {
  const db = await createTestDatabase(); cleanups.push(db.cleanup); const { prisma } = db;
  await prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", repositoryId: "repo", machineId: "host", role: "primary", cwd: "/review", status: "active" } });
  const task = await prisma.remoteTask.create({ data: { id: "task", requestKey: "task", primarySessionId: "primary", repositoryId: "repo", machineId: "host", branchName: "original", toolingRoot: "/tooling/old", toolingRevision: "a".repeat(40), phase: "review" } });
  for (const id of ["old", "new"]) await prisma.toolingRelease.create({ data: { id, revision: (id === "old" ? "a" : "b").repeat(40), repositoryId: "repo", tree: "c".repeat(40), policyBlob: "d".repeat(40), checkout: "/tooling/" + id,
    manifest: { contract: "remote-agent.tooling-release/v1", serverProtocol: { min: 3, max: 3 }, stateFormats: {} }, lockfileDigest: "e".repeat(64), bunVersion: "1.3.14" } });
  const operation = async (id: string, kind: string, parentOperationId: string | null, current = false) => prisma.toolingOperation.create({ data: {
    id, taskId: "task", sessionId: "primary", repositoryId: "repo", requestKey: id, inputDigest: "1".repeat(64), kind, parentOperationId,
    resourceKey: "runtime-review", existingOperationId: kind === "compute-configure" ? "offer" : null, releaseId: current ? "new" : "old", generation: current ? 3 : 2, protocol: 3, status: current ? "running" : "completed",
  } });
  await operation("earlier", "adapter-command", null);
  await operation("parent", "adapter-command", null, true);
  await operation("owner", "compute-configure", "earlier");
  await operation("admitted", "compute-admission", "earlier");
  await operation("configured", "compute-configure", "earlier");
  await operation("current", admission ? "compute-admission" : "compute-configure", "parent", true);
  await prisma.remoteTaskResource.create({ data: { id: "runtime", taskId: "task", key: "runtime-review", kind: "task-runtime", purpose: "review", externalId: "/review/runtime.json", state: "ready" } });
  await prisma.computeEnvironment.create({ data: { id: "environment", taskId: "task", primarySessionId: "primary", machineId: "host", key: "runtime-review", purpose: "review", revision: "f".repeat(40), recipeDigest: "2".repeat(64), taskIdentity: "3".repeat(64), resourceId: "runtime", state: "running" } });
  await prisma.computeOffer.create({ data: { id: "offer", environmentId: "environment", machineId: "host", instructionId: "instruction", dispatchDeadline: new Date(Date.now() + 60000), expiresAt: new Date(Date.now() + 60000), state: "running" } });
  const event = (key: string, value: unknown) => prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "tooling-operation:task", action: "tooling-operation-association", key, value: JSON.stringify(value) } });
  const outcome = async (id: string, attemptId = id, state = "acknowledged") => {
    for (const status of ["intent", state]) await event(`outcome:${id}`, { version: 1, operationId: id, inputDigest: "1".repeat(64), role: "outcome", state: status, attemptId, route: "POST /api/tasks/:taskId/compute-configure", status: status === "acknowledged" ? 200 : null });
  };
  for (const id of ["owner", "admitted", "configured"]) await outcome(id);
  const association = (role: string, id: string, operationId: string, state = "confirmed") => event(`${role}:${id}`, { version: 1, operationId, role, state });
  await association("producer", "compute-environment:environment", "configured");
  await association("admission", "environment-key:runtime-review", "admitted");
  const proof = { environmentId: "environment", resourceId: "runtime", offerId: "offer", recipeHash: "2".repeat(64) };
  const journal = (value: unknown) => prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", source: "compute:task", action: "compute-runtime-configuration", key: "environment", value: JSON.stringify(value) } });
  if (admission) {
    await operation("own-configured", "compute-configure", "parent", true); await outcome("own-configured");
    await association("producer", "compute-environment:environment", "own-configured");
    await journal({ operationId: "own-configured", proof });
  }
  const binding = (await readToolingOperation({ prisma, operationId: "current" }))!;
  const reference = admission ? { environmentKey: "runtime-review", owner: "admitted" } : { offerId: "offer", owner: "owner" };
  return { prisma, task, binding, reference, outcome, association, journal, proof,
    run: () => completedReviewConfigurationAllows(prisma, task, binding, reference) };
}

test.each([false, true])("later review configuration retains settled predecessors across releases: admission=%s", async admission => {
  const f = await fixture(admission), before = await f.prisma.toolingOperation.findMany();
  expect(await f.run()).toBe(true);
  expect(await f.run()).toBe(true);
  expect(await f.prisma.toolingOperation.findMany()).toEqual(before);
  // Its own retry intent does not transfer or hide another operation's work.
  await f.association(admission ? "admission" : "producer", admission ? "environment-key:runtime-review" : "compute-environment:environment", "current", "intent");
  expect(await f.run()).toBe(true);
});

test.each(["paused", "closed", "foreign-task", "foreign-session", "foreign-repository", "foreign-release", "foreign-generation", "finished-parent", "development", "wrong-host", "pending-config", "wrong-offer", "owner-running", "producer-running", "admission-running", "parent-running", "owner-unknown", "producer-unknown", "admission-unknown", "newer-producer", "producer-pin", "producer-parent-pin", "unknown-producer", "unknown-admission", "pending-reader"])("later review configuration refuses changed or uncertain authority: %s", async fault => {
  const f = await fixture();
  if (fault === "paused") f.task.ownerPaused = true;
  if (fault === "closed") f.task.phase = "closed";
  if (fault === "foreign-task") f.binding.taskId = "foreign";
  if (fault === "foreign-session") f.binding.sessionId = "foreign";
  if (fault === "foreign-repository") f.binding.repositoryId = "foreign";
  if (fault === "foreign-release") f.binding.release.id = "old";
  if (fault === "foreign-generation") f.binding.generation++;
  if (fault === "finished-parent") await f.prisma.toolingOperation.update({ where: { id: "parent" }, data: { status: "completed" } });
  if (fault === "development") await f.prisma.computeEnvironment.update({ where: { id: "environment" }, data: { purpose: "development" } });
  if (fault === "wrong-host") await f.prisma.computeEnvironment.update({ where: { id: "environment" }, data: { machineId: "foreign" } });
  if (fault === "pending-config") await f.prisma.computeEnvironment.update({ where: { id: "environment" }, data: { configuration: { pending: true } } });
  if (fault === "wrong-offer") f.binding.existingOperationId = "foreign";
  const ids: Record<string, string> = { owner: "owner", producer: "configured", admission: "admitted", parent: "earlier" };
  if (fault.endsWith("-running")) await f.prisma.toolingOperation.update({ where: { id: ids[fault.split("-")[0]!]! }, data: { status: "running" } });
  if (fault.endsWith("-unknown")) await f.outcome(ids[fault.split("-")[0]!]!, "later", "unknown");
  if (fault === "newer-producer") await f.prisma.toolingOperation.update({ where: { id: "configured" }, data: { generation: 4 } });
  if (fault === "producer-pin") await f.prisma.toolingOperation.update({ where: { id: "configured" }, data: { releaseId: "new" } });
  if (fault === "producer-parent-pin") await f.prisma.toolingOperation.update({ where: { id: "earlier" }, data: { releaseId: "new" } });
  if (fault === "unknown-producer") await f.association("producer", "compute-environment:environment", "foreign", "intent");
  if (fault === "unknown-admission") await f.association("admission", "environment-key:runtime-review", "foreign", "intent");
  if (fault === "pending-reader") await f.prisma.toolingRetainedConsumer.create({ data: { id: "reader", taskId: "task", repositoryId: "repo", operationId: "configured", releaseId: "old", generation: 2, protocol: 3, consumerKind: "compute-environment", consumerId: "environment", scopeKey: "runtime-review", status: "pending" } });
  expect(await f.run()).toBe(false);
});

test.each(["missing-journal", "old-command", "environment", "resource", "recipe", "offer", "unacknowledged-own", "foreign-own-parent"])("review re-admission requires this command's acknowledged committed configuration: %s", async fault => {
  const f = await fixture(true);
  if (fault === "missing-journal") await f.prisma.runtimeMetadataEvent.deleteMany({ where: { action: "compute-runtime-configuration" } });
  if (fault === "old-command") await f.journal({ operationId: "configured", proof: f.proof });
  const fields: Record<string, string> = { environment: "environmentId", resource: "resourceId", recipe: "recipeHash", offer: "offerId" };
  if (fields[fault]) await f.journal({ operationId: "own-configured", proof: { ...f.proof, [fields[fault]!]: "foreign" } });
  if (fault === "unacknowledged-own") await f.outcome("own-configured", "later", "unknown");
  if (fault === "foreign-own-parent") await f.prisma.toolingOperation.update({ where: { id: "own-configured" }, data: { parentOperationId: "earlier" } });
  expect(await f.run()).toBe(false);
});
