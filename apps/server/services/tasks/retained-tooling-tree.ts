import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { observeLegacyEvidenceTree } from "./legacy-evidence-tree.ts";
import { within } from "./legacy-evidence-files.ts";
import { finalizationDigest, FinalizationInventoryEntry } from "./finalization-resources.ts";

export const RETAINED_TOOLING_TREE = "finalization-retained-tooling-tree";
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Proof = z.object({ version: z.literal(1), provenance: z.literal("observed-at-verification"),
  taskId: z.string(), sessionId: z.string(), requestKey: z.string(), resourceId: z.string(),
  preparedRevision: z.number().int().positive(), preparedRawDigest: Sha,
  operationRevision: z.number().int().positive(), operationDigest: Sha, resourceDigest: Sha,
  path: z.string(), inventory: z.array(FinalizationInventoryEntry).min(1).max(10_025), inventoryDigest: Sha,
}).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

async function binding(prisma: PrismaClient, active: Active, resourceId: string) {
  const resource = active.binding.resources.find(item => item.id === resourceId);
  const original = active.operation.binding.resources.find(item => item.id === resourceId);
  if (active.kind !== "v1" || !active.prepared.localCompletion || !active.preparation.value
    || !resource || !original || resource.kind !== "evidence" || resource.purpose !== "tooling"
    || resource.state !== "ready" || original.state !== "ready"
    || finalizationDigest(resource) !== finalizationDigest(original)) throw Error("Retained tooling tree requires its original Ready cleanup resource");
  const root = resource.externalId;
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root) throw Error("Retained tooling tree path is not exact");
  const metadata = resource.metadata as Record<string, unknown> | null;
  if (["sha256", "bytes", "byteSize", "size"].some(key => metadata?.[key] !== undefined)) throw Error("Directory retention cannot reinterpret a recorded file identity");
  const protectedRoots = [active.prepared.worktree, active.prepared.registeredWorktree, active.prepared.gitCwd,
    active.prepared.gitDirectory, active.task.toolingRoot, active.task.pinnedToolingRoot].filter((value): value is string => Boolean(value));
  if (protectedRoots.some(file => overlaps(root, file))) throw Error("Retained tooling tree overlaps a protected cleanup root");
  const ancestors: string[] = [];
  for (let cursor = root; ; cursor = path.dirname(cursor)) { ancestors.push(cursor); if (cursor === path.dirname(cursor)) break; }
  if (await prisma.remoteTaskResource.findFirst({ where: { id: { not: resourceId }, OR: [
    { externalId: { in: ancestors } }, { externalId: { startsWith: root + path.sep } },
  ] } })) throw Error("Retained tooling tree overlaps another recorded resource");
  if (await prisma.remoteTask.findFirst({ where: { id: { not: active.task.id }, OR: [
    { worktreePath: { in: ancestors } }, { worktreePath: { startsWith: root + path.sep } },
    { toolingRoot: { in: ancestors } }, { toolingRoot: { startsWith: root + path.sep } },
    { pinnedToolingRoot: { in: ancestors } }, { pinnedToolingRoot: { startsWith: root + path.sep } },
  ] } })) throw Error("Retained tooling tree overlaps another task's source");
  return { taskId: active.task.id, sessionId: active.binding.sessionId, requestKey: active.prepared.requestKey, resourceId,
    preparedRevision: active.preparation.sequence, preparedRawDigest: hash(active.preparation.value),
    operationRevision: active.operationRevision, operationDigest: finalizationDigest(active.operation),
    resourceDigest: finalizationDigest(resource), path: root };
}

/** A retained directory is never a capture target. Full preparation may record
 * its first physical inventory; confirmation can only recheck that inventory.
 * The original resource, preparation and cleanup operation remain unchanged. */
export async function verifyRetainedToolingTree(input: { prisma: PrismaClient; active: Active; resourceId: string;
  record: boolean; assertAuthority(prisma: PrismaClient): Promise<Active> }) {
  const initial = await binding(input.prisma, input.active, input.resourceId);
  const where = { runtimeSessionId: initial.sessionId, source: `finalizer:${initial.taskId}`, action: RETAINED_TOOLING_TREE, key: initial.resourceId };
  const prior = await input.prisma.runtimeMetadataEvent.findFirst({ where, orderBy: { sequence: "desc" } });
  if (!prior && !input.record) throw Error("Retained tooling tree has no full-preparation observation");
  if (!prior && !(await lstat(input.active.prepared.worktree)).isDirectory()) throw Error("Retained tooling tree cannot be first observed after source removal");
  const observed = await observeLegacyEvidenceTree(initial.path);
  const proof = Proof.parse({ version: 1, provenance: "observed-at-verification", ...initial,
    inventory: observed.inventory, inventoryDigest: observed.inventoryDigest });
  if (prior && finalizationDigest(Proof.parse(JSON.parse(prior.value!))) !== finalizationDigest(proof)) throw Error("Retained tooling tree identity or inventory changed");
  // A complete second observation catches changes spanning the first scan.
  if (finalizationDigest(await observeLegacyEvidenceTree(initial.path)) !== finalizationDigest(observed)) throw Error("Retained tooling tree changed during verification");
  const fresh = await input.assertAuthority(input.prisma);
  if (fresh.authorityEpoch !== input.active.authorityEpoch || finalizationDigest(await binding(input.prisma, fresh, input.resourceId)) !== finalizationDigest(initial)) throw Error("Retained tooling tree authority changed during verification");
  if (prior) return;
  await input.prisma.$transaction(async tx => {
    const current = await input.assertAuthority(tx as PrismaClient);
    if (current.authorityEpoch !== fresh.authorityEpoch || finalizationDigest(await binding(tx as PrismaClient, current, input.resourceId)) !== finalizationDigest(initial)) throw Error("Retained tooling tree authority changed before recording");
    if (await tx.runtimeMetadataEvent.findFirst({ where: { runtimeSessionId: initial.sessionId, source: where.source, action: "finalization-confirmed", key: initial.requestKey } })) throw Error("Confirmed cleanup cannot observe a new retained tree");
    const duplicate = await tx.runtimeMetadataEvent.findFirst({ where });
    if (duplicate) {
      if (finalizationDigest(Proof.parse(JSON.parse(duplicate.value!))) !== finalizationDigest(proof)) throw Error("Retained tooling tree was observed differently in parallel");
      return;
    }
    await tx.runtimeMetadataEvent.create({ data: { ...where, value: JSON.stringify(proof) } });
  });
}
