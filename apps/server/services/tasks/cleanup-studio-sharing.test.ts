import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { finalizationResourceIdentity } from "./finalization-resources.ts";
import { assertLegacyStudioScope, assertStudioResourceSharing } from "./cleanup-studio-sharing.ts";

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.cleanup(); });
async function fixture() {
  const task = await db.prisma.remoteTask.create({ data: { id: "original", requestKey: "original", repositoryId: "repo", machineId: "host", worktreePath: "/source/original", branchName: "codex/original", toolingRoot: "/tooling", toolingRevision: "a".repeat(40) } });
  const metadata = { composeFile: "/source/original/tools/studio/compose.yaml", containers: { workspace: "a".repeat(12), mysql: "b".repeat(12), spatial: "c".repeat(12) }, volumes: ["modules", "cache", "mysql-data", "spatial-data"], network: "d".repeat(64) };
  const resource = await db.prisma.remoteTaskResource.create({ data: { id: "group", taskId: task.id, key: "development-compose", kind: "docker-compose-project", purpose: "development", externalId: "original-project", state: "ready", metadata } });
  await db.prisma.computeEnvironment.create({ data: { id: crypto.randomUUID(), taskId: task.id, primarySessionId: "primary", machineId: "host", taskIdentity: "a".repeat(64), key: resource.key, purpose: "development", revision: "a".repeat(40), recipeDigest: "b".repeat(64), resourceId: resource.id, resourceIdentity: finalizationResourceIdentity(resource).identityDigest,
    configuration: { configurationFile: "/private/original/coverage.json", configurationSha256: "c".repeat(64) }, state: "suspended" } });
  const check = () => assertLegacyStudioScope(db.prisma, task.id, task.worktreePath!, resource);
  const foreign = async (kind: string, externalId: string, metadata: object = {}, state = "ready") => {
    const other = await db.prisma.remoteTask.upsert({ where: { id: "foreign" }, create: { id: "foreign", requestKey: "foreign", repositoryId: "repo", machineId: "host", worktreePath: "/source/foreign", branchName: "codex/foreign", toolingRoot: "/tooling", toolingRevision: "a".repeat(40) }, update: {} });
    return db.prisma.remoteTaskResource.create({ data: { taskId: other.id, key: crypto.randomUUID(), kind, purpose: "development", externalId, state, metadata } });
  };
  return { task, resource, check, foreign };
}
test("stock selected scope preserves shared proxy/network users but rejects a late registered member claim", async () => {
  const f = await fixture(), before = await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } });
  await f.foreign("docker-container", "e".repeat(64)); await f.foreign("docker-network", "f".repeat(64));
  await f.check();
  // A later registry claim is checked independently of a fresh physical reader.
  await f.foreign("task-runtime", "other-runtime", { containerId: "a".repeat(64) });
  await expect(f.check()).rejects.toThrow("another registered owner");
  expect(await db.prisma.remoteTaskResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toEqual(before);
});
test.each(["project", "container", "released-container", "volume", "network", "annotated-network", "malformed-network", "compose-member", "runtime-volume", "source-path", "proof-path", "task-worktree", "missing-enrollment", "changed-enrollment"])("stock scope refuses %s without physical effects", async condition => {
  const f = await fixture();
  if (condition === "project") await f.foreign("docker-compose-project", f.resource.externalId);
  if (condition === "container") await f.foreign("docker-container", "b".repeat(64));
  if (condition === "released-container") await f.foreign("docker-container", "b".repeat(64), {}, "released");
  if (condition === "volume") await f.foreign("docker-volume", "mysql-data");
  if (condition === "network") await f.foreign("docker-network", "d".repeat(64));
  if (condition === "annotated-network") await f.foreign("docker-compose-project", "other-project", { network: `${"d".repeat(64)} (original-default)` });
  if (condition === "malformed-network") await f.foreign("docker-compose-project", "other-project", { network: `${"d".repeat(64)} malformed` });
  if (condition === "compose-member") await f.foreign("docker-compose-project", "other-project", { containers: { database: { id: "c".repeat(64) } } });
  if (condition === "runtime-volume") await f.foreign("task-runtime", "other-runtime", { dependencyVolume: { name: "modules" } });
  if (condition === "source-path") await f.foreign("evidence", "/source/original/nested");
  if (condition === "proof-path") await f.foreign("private-file", "/private/original/enrolled.json");
  if (condition === "task-worktree") await db.prisma.remoteTask.create({ data: { id: "other", requestKey: "other", repositoryId: "repo", machineId: "host", worktreePath: "/source/original/nested", branchName: "codex/other", toolingRoot: "/tooling", toolingRevision: "a".repeat(40) } });
  if (condition === "missing-enrollment") await db.prisma.computeEnvironment.deleteMany();
  if (condition === "changed-enrollment") await db.prisma.computeEnvironment.updateMany({ data: { resourceIdentity: "f".repeat(64) } });
  await expect(f.check()).rejects.toThrow();
  expect(await db.prisma.remoteTaskResource.findUnique({ where: { id: f.resource.id } })).toMatchObject({ state: "ready", metadata: f.resource.metadata });
});
test("prepared full IDs still reject historical prefix claims and inventory read failures", async () => {
  const f = await fixture(), selection = { resourceId: f.resource.id, identityDigest: finalizationResourceIdentity(f.resource).identityDigest, project: f.resource.externalId, worktree: f.task.worktreePath!,
    containers: ["a", "b", "c"].map(value => value.repeat(64)), volumes: ["modules", "cache", "mysql-data", "spatial-data"], network: "d".repeat(64), proofPaths: ["/private/original"] };
  await assertStudioResourceSharing(db.prisma, f.task.id, [selection]);
  await f.foreign("docker-container", "c".repeat(12));
  await expect(assertStudioResourceSharing(db.prisma, f.task.id, [selection])).rejects.toThrow("another registered owner");
  await expect(assertStudioResourceSharing({ ...db.prisma, remoteTaskResource: { findMany: async () => { throw Error("read failed"); } } } as never, f.task.id, [selection])).rejects.toThrow("read failed");
});
