import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { assertLegacyEvidenceWriters } from "./legacy-evidence-writers.ts";
import { CleanupWritersInput, CleanupWritersResult } from "./cleanup-writers-schema.ts";
import { cleanupDigest } from "./cleanup-observer-schema.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function fixture() {
  const config = testConfig();
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: config.repository.id, machineId: config.machine, primarySessionId: "primary", branchName: "codex/task", worktreePath: "/private/task/work", toolingRoot: "/private/tooling", toolingRevision: "a".repeat(40) } });
  const evidence = await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "turns", kind: "evidence", purpose: "development", state: "ready", externalId: "/private/task/env/turns" } });
  const proof = { version: 1 as const, file: "/private/task/native.json", sha256: "b".repeat(64) };
  const writer = await db.prisma.remoteTaskResource.create({ data: { taskId: task.id, key: "proxy", kind: "local-http", purpose: "development", state: "allocated", externalId: "http://localhost:12345", metadata: { observed: { legacyNative: proof, previous: { error: "Cloudflare 403" } } } } });
  const input = { prisma: db.prisma, config, task, entry: { resourceId: evidence.id, target: { path: evidence.externalId } } };
  const dependencies = { resolve: async () => ({ version: 1 as const, source: "configured-host" as const, checkout: "/private/tooling", revision: "a".repeat(40), adapter: "/private/tooling/src/cli.ts", adapterSha256: "c".repeat(64) }),
    observe: async ({ request }: { request: unknown }) => {
      const value = CleanupWritersInput.parse(request);
      return CleanupWritersResult.parse({ version: 1, mode: "stopped-writers", requestDigest: cleanupDigest(value), writers: value.writerResourceIds.map(id => ({ resourceId: id, resourceDigest: cleanupDigest(value.resources.find(record => record.id === id)), anchorKey: "compose", proof, planDigest: "d".repeat(64), stopped: true })) });
    } };
  return { input, dependencies, writer };
}

test("writer response binds the complete request and cannot be reused for another directory", async () => {
  const f = await fixture(), observe = f.dependencies.observe;
  f.dependencies.observe = async input => ({ ...await observe(input), requestDigest: "f".repeat(64) });
  await expect(assertLegacyEvidenceWriters(f.input, f.dependencies)).rejects.toThrow("exact current request");
});
test.each(["during observation", "before capture"])("new writer resources cannot cross the observed epoch: %s", async when => {
  const f = await fixture();
  const add = () => db.prisma.remoteTaskResource.create({ data: { taskId: f.input.task.id, key: "later-writer", kind: "docker-container", purpose: "development", state: "ready", externalId: "e".repeat(64) } });
  if (when === "during observation") { const observe = f.dependencies.observe; f.dependencies.observe = async input => { const result = await observe(input); await add(); return result; };
    await expect(assertLegacyEvidenceWriters(f.input, f.dependencies)).rejects.toThrow("inventory changed");
  } else { const recheck = await assertLegacyEvidenceWriters(f.input, f.dependencies); await add(); await expect(recheck()).rejects.toThrow("inventory changed"); }
});
test("a changed proof pointer or unsupported recipe cannot reuse stopped evidence", async () => {
  const f = await fixture(), recheck = await assertLegacyEvidenceWriters(f.input, f.dependencies);
  await db.prisma.remoteTaskResource.update({ where: { id: f.writer.id }, data: { metadata: { observed: { legacyNative: { version: 1, file: "/private/replacement.json", sha256: "e".repeat(64) } } } } });
  await expect(recheck()).rejects.toThrow("inventory changed");
  await db.prisma.remoteTaskResource.update({ where: { id: f.writer.id }, data: { kind: "native-app" } });
  await expect(assertLegacyEvidenceWriters(f.input, f.dependencies)).rejects.toThrow("independently verified");
});
