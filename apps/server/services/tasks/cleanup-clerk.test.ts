import { expect, test } from "bun:test";
import path from "node:path";
import { CleanupAdapterPlan } from "./cleanup-adapter-resources.ts";
import { assertRegisteredCaptureSharing } from "./cleanup-filesystem.ts";
import { cleanupTargetDigest } from "./cleanup-observer-schema.ts";
import { assertFinalizationResources, finalizationResourceIdentity, prepareFinalizationResources, type FinalizationResourceRecord, type ResourceObservation } from "./finalization-resources.ts";

function fixture() {
  const records = [
    { id: "user", taskId: "task", key: "user", kind: "clerk-test-user", purpose: "development", externalId: "synthetic@example.com", state: "ready", expiresAt: null, metadata: { clerkUserId: "user_Exact" } },
    { id: "session", taskId: "task", key: "session", kind: "clerk-test-session", purpose: "development", externalId: "sess_Exact", state: "ready", expiresAt: null, metadata: { userId: "user_Exact" } },
  ];
  const scope = { taskId: "task", purpose: "development", instanceId: "ins_Exact", credentials: { backupFile: "/private/credentials.enc.json", backupSha256: "a".repeat(64), keyFile: "/private/key", keyId: "b".repeat(64) } };
  const plan = records.map(record => {
    const target = record.kind === "clerk-test-user" ? { kind: "clerk-user", id: "user_Exact", scope, creation: { createdAt: 10, emailDigest: "c".repeat(64) }, presentAtPrepare: true }
      : { kind: "clerk-session", id: "sess_Exact", userId: "user_Exact", scope, creation: { createdAt: 11 }, presentAtPrepare: true };
    return CleanupAdapterPlan.parse({ ...finalizationResourceIdentity(record), disposition: "retire-adapter", adapter: "clerk", dependencies: record.kind === "clerk-test-user" ? ["session"] : [], stoppedConsumers: [],
      targets: [{ ...target, identityDigest: cleanupTargetDigest(target as never) }], observer: { task: { id: "task", primarySessionId: "primary", worktreePath: "/private/worktree", toolingRevision: "a".repeat(40) },
        capability: { version: 1, source: "configured-host", checkout: "/private/tooling", revision: "b".repeat(40), adapter: "/private/tooling/src/cli.ts", adapterSha256: "c".repeat(64) } } });
  });
  let query: unknown;
  const database = { remoteTaskResource: { findMany: async (input: unknown) => { query = input; return records.filter(record => record.state !== "released"); } } };
  return { records, plan, database, query: () => query, check: () => assertRegisteredCaptureSharing(database as never, "task", plan) };
}
test("local Clerk sharing checks bind email-backed user IDs and exact same-purpose session plans", async () => {
  const f = fixture(); await f.check(); expect(f.query()).toEqual(expect.objectContaining({ take: 10001 }));
  f.records[1]!.state = "released"; await f.check();
});
test.each(["foreign-user-email", "foreign-user-id", "foreign-conflicting-id", "foreign-session", "alias", "other-purpose", "changed-own-identity"])("Clerk cleanup rejects %s on the same local authority seam", async change => {
  const f = fixture();
  if (change === "changed-own-identity") f.records[0]!.metadata = { clerkUserId: "user_Exact", unrelated: true } as never;
  else {
    const record = structuredClone(change === "foreign-session" || change === "other-purpose" ? f.records[1]! : f.records[0]!);
    record.id = "another"; record.key = "another";
    if (change.startsWith("foreign")) record.taskId = "another-task";
    if (change === "foreign-user-id") record.externalId = "user_Exact";
    if (change === "foreign-conflicting-id") record.externalId = "user_Other";
    if (change === "other-purpose") record.purpose = "review";
    f.records.push(record);
  }
  await expect(f.check()).rejects.toThrow("shared");
});
test("session-only retirement does not claim all sessions belonging to the user", async () => {
  const f = fixture(); f.plan.splice(0, 1);
  f.records.push({ ...f.records[1]!, id: "other-session", taskId: "another-task", externalId: "sess_Other" });
  await f.check();
  f.records.push({ ...f.records[1]!, id: "alias", taskId: "another-task" });
  await expect(f.check()).rejects.toThrow("shared");
});
test("incomplete ownership inventory cannot authorize provider effects", async () => {
  const f = fixture(); f.database.remoteTaskResource.findMany = async () => Array.from({ length: 10001 }, () => f.records[0]!);
  await expect(f.check()).rejects.toThrow("bounded");
});

const draftedRoot = process.env.DRAFTED_INTEGRATION_ROOT;
test.skipIf(!draftedRoot)("actual prepared client revokes the exact session before its user and verifies a lost provider acknowledgment", async () => {
  const taskId = "cmvsm93qx000c42xcn57mcobj", email = "dra98.cmvsm93q+clerk_test@example.com", userId = "user_Task98", sessionId = "sess_Task98";
  const resources: FinalizationResourceRecord[] = [
    { id: "user", key: "development-user", kind: "clerk-test-user", purpose: "development", externalId: email, state: "ready", metadata: { clerkUserId: userId, instance: "Clerk development/test instance (jwks kid ins_Development)", credentialsFile: "/never/read/receipt.env" } },
    { id: "session", key: "development-session", kind: "clerk-test-session", purpose: "development", externalId: sessionId, state: "ready", metadata: { userId, instance: "Clerk test instance (sk_test_ guarded)" } },
  ];
  const descriptor = { id: taskId, primarySessionId: "primary", worktreePath: "/private/disposable-product", toolingRevision: "a".repeat(40) };
  const capability = { version: 1 as const, source: "configured-host" as const, checkout: "/private/disposable-tooling", revision: "b".repeat(40), adapter: "/private/disposable-tooling/src/cli.ts", adapterSha256: "c".repeat(64) };
  const credentials = { backupFile: "/private/fixed.enc.json", backupSha256: "a".repeat(64), keyFile: "/private/fixed.key", keyId: "b".repeat(64) }, effects: string[] = [];
  let userPresent = true, sessionStatus = "active", lost = true;
  const clerk = { credentials: async () => credentials, request: async (method: string, route: string, expected: unknown, beforeEffect?: () => Promise<void>) => {
    expect(expected).toEqual(credentials);
    if (method !== "GET") {
      expect(beforeEffect).toBeFunction(); await beforeEffect!(); effects.push(`${method} ${route}`);
      if (route === `/sessions/${sessionId}/revoke`) sessionStatus = "revoked";
      else if (route === `/users/${userId}`) { userPresent = false; if (lost) { lost = false; throw new Error("lost provider acknowledgment"); } }
      else throw new Error("Unselected provider mutation");
    }
    if (route === "/instance") return { id: "ins_Development", environment_type: "development" };
    if (route === `/users/${userId}`) return userPresent ? { id: userId, created_at: 10, email_addresses: [{ email_address: email }] } : null;
    if (route === `/sessions/${sessionId}` || route === `/sessions/${sessionId}/revoke`) return { id: sessionId, user_id: userId, created_at: 11, status: sessionStatus };
    throw new Error("Unselected provider read");
  } };
  const { observeCleanupBatch } = await import(path.join(draftedRoot!, "src/cleanup-observer.ts"));
  const { releasePreparedResources } = await import(path.join(draftedRoot!, "src/finalization-resources.ts"));
  const { FinalizationResourcePlan: ClientPlan } = await import(path.join(draftedRoot!, "src/finalization-plan.ts"));
  const { adapterReceipt } = await import(path.join(draftedRoot!, "test/fixtures/prepared-adapter.ts"));
  const observation: ResourceObservation = { rootIdle: async () => {}, endpointAbsent: async () => {}, browserAbsent: async () => {}, adapters: ({ request }) => observeCleanupBatch(request, { clerk }) };
  const plan = await prepareFinalizationResources({ taskId, sessionId: "primary", resources, sourcePaths: [], deliveries: [], toolingRoot: "/private/old-tooling", originalWork: true, ownership: { ownedPaths: [] }, adapterContext: { task: descriptor, capability } }, observation);
  const task = { ...descriptor, phase: "waiting", finalizationVersion: 2, resources }, prepared = adapterReceipt(task, plan.map(entry => ClientPlan.parse(entry))), writes: string[] = [];
  const verify = (removed = false) => assertFinalizationResources({ taskId, resources, plan, originalWork: true, removed }, observation);
  const registry = { task: async () => structuredClone(task), prepareFinalization: async () => structuredClone(prepared), resource: async (update: { key: string; state: string }) => {
    writes.push(update.key); Object.assign(resources.find(record => record.key === update.key)!, update); await verify();
  } };
  const run = () => releasePreparedResources({ registry, prepared, adapters: { observer: { clerk } }, assertAuthority: () => verify(), observation });
  const partial = await run(); expect(partial.results.some((result: { outcome: string }) => result.outcome === "failed")).toBeTrue();
  expect(effects).toEqual([`POST /sessions/${sessionId}/revoke`, `DELETE /users/${userId}`]); expect(writes).toEqual(["development-session"]);
  expect(sessionStatus).toBe("revoked"); await verify();
  const replay = await run(); expect(replay.results.filter((result: { outcome: string }) => result.outcome === "failed")).toEqual([]); await verify(true);
  await run(); await verify(true); expect(effects).toHaveLength(2); expect(writes).toEqual(["development-session", "development-user"]);
  expect((resources[0]!.metadata as Record<string, unknown>).credentialsFile).toBe("/never/read/receipt.env");
}, 30_000);
