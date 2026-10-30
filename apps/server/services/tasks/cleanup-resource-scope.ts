import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { z } from "zod";
import { assertClerkResourceSharing } from "./cleanup-clerk.ts";
import { assertRegisteredPathSharing } from "./cleanup-filesystem.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { ArchiveRetentionProof } from "./archive-retention-schema.ts";
import { assertPreparedCleanup, cleanupRetainedResourceIds } from "./cleanup-lifecycle.ts";

export const CleanupResourceKeys = z.array(z.string().min(1).max(100)).min(1).max(100)
  .refine(keys => new Set(keys).size === keys.length, "Cleanup resource keys must be unique");
type Database = Pick<PrismaClient, "remoteTask" | "runtimeSession" | "runtimeSessionResourceLink" | "remoteTaskResource" | "runtimeMetadataEvent">;
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;
const within = (root: string, file: string) => root === file || file.startsWith(`${root}${path.sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const directoryKinds = new Set(["directory", "private-env-files"]);

/** This is a local ownership recheck of an already frozen v1 operation, not a
 * new plan or proof of physical absence. Client adapters still verify held
 * filesystem/provider identities and their durable retry journals. */
export async function cleanupResourceScope(prisma: Database, config: Parameters<typeof cleanupRetainedResourceIds>[1], active: Active, keys: string[]) {
  CleanupResourceKeys.parse(keys);
  if (active.kind !== "v1") throw new Error("Legacy resource scope requires the existing version 1 cleanup");
  const selected = keys.map(key => active.binding.resources.find(resource => resource.key === key));
  if (selected.some(resource => !resource)) throw new Error("Cleanup resource scope contains an unknown key");
  const resources = selected.map(resource => resource!);
  const identities = resources.map(resource => ({ id: resource.id, key: resource.key, identityDigest: finalizationResourceIdentity(resource).identityDigest }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const retained = await cleanupRetainedResourceIds(prisma, config, active);
  if (resources.some(resource => retained.has(resource.id))) throw new Error("Retained resources cannot receive legacy cleanup authority");
  if (resources.every(resource => directoryKinds.has(resource.kind))) {
    const first = resources[0]!, root = first.externalId;
    if (!path.isAbsolute(root) || path.normalize(root) !== root || root.includes("\0") || !["development", "review"].includes(first.purpose)
      || resources.some(resource => resource.externalId !== root || resource.purpose !== first.purpose)) throw new Error("Legacy environment scope requires one exact same-purpose root");
    const parts = root.split(path.sep);
    const environment = first.purpose === "development" && parts.at(-2) === "environments" && parts.at(-1) === active.task.id;
    const review = first.purpose === "review" && parts.at(-4) === "reviews" && parts.at(-3) === active.task.id
      && /^[a-f0-9]{40}$/.test(parts.at(-2) ?? "") && parts.at(-1) === "env";
    if (!environment && !review) throw new Error("Legacy directory is not an exact registered task environment");
    const aliases = active.binding.resources.filter(resource => resource.externalId === root);
    if (aliases.length !== resources.length || aliases.some(resource => !keys.includes(resource.key))) throw new Error("Legacy environment scope must include every exact-root receipt");
    const directories = resources.filter(resource => resource.kind === "directory");
    if (directories.length !== 1 || directories[0]!.key !== `${first.purpose}-env-directory`
      || z.record(z.string(), z.unknown()).parse(directories[0]!.metadata ?? {}).trackedGreenfieldEdits !== false
      || resources.some(resource => resource.kind === "private-env-files" && (first.purpose !== "development" || resource.key !== "development-provider-credentials"))) throw new Error("Legacy environment scope has no supported original directory receipt");
    // The client derives these same private recovery names from the witnessed
    // identity. Check their global claims as well as the retiring source.
    const token = finalizationDigest({ task: active.task.id, root, resources: identities });
    const scopes = [root, path.join(path.dirname(root), `.drafted-finalization-${token}`), path.join(path.dirname(root), `.drafted-environment-${token}.json`)];
    const protectedPaths = [active.binding.worktree, active.binding.repositoryRoot, active.binding.toolingRoot, active.binding.pinnedToolingRoot].filter((file): file is string => Boolean(file));
    for (const reference of active.binding.authority) {
      if (reference.action !== "finalization-archive-retention" && reference.action !== "legacy-evidence-retained") continue;
      const event = await prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: reference.revision } });
      const value: unknown = JSON.parse(event.value!);
      if (reference.action === "finalization-archive-retention") protectedPaths.push(...ArchiveRetentionProof.parse(value).resources.map(resource => resource.archive.root));
      else protectedPaths.push(z.object({ archiveRoot: z.string() }).parse(value).archiveRoot);
    }
    if (protectedPaths.some(file => scopes.some(scope => overlaps(scope, file)))) throw new Error("Legacy environment overlaps original source, tooling or retained material");
    // This deliberately retains the existing global registered-path policy,
    // including historical claims, and adds tasks with no resource receipt.
    await assertRegisteredPathSharing(prisma, active.task.id, scopes);
    const ancestors = new Set<string>();
    for (const scope of scopes) for (let cursor = scope; ; cursor = path.dirname(cursor)) { ancestors.add(cursor); if (cursor === path.dirname(cursor)) break; }
    if (await prisma.remoteTask.findFirst({ where: { OR: [{ worktreePath: { in: [...ancestors] } }, ...scopes.map(scope => ({ worktreePath: { startsWith: `${scope}${path.sep}` } }))] } })) throw new Error("Legacy environment overlaps a registered task worktree");
  } else {
    const resource = resources[0]!;
    const metadata = z.record(z.string(), z.unknown()).parse(resource.metadata ?? {});
    if (resources.length !== 1 || resource.kind !== "clerk-test-user" || resource.purpose !== "development"
      || !/^user_[A-Za-z0-9]+$/.test(resource.externalId) || metadata.createdByTask !== true) throw new Error("Legacy resource scope is not a supported task-created test user");
    await assertClerkResourceSharing(prisma, active.task.id, [{ resourceId: resource.id, purpose: resource.purpose,
      identityDigest: finalizationResourceIdentity(resource).identityDigest, kind: "clerk-user", id: resource.externalId }]);
  }
  return identities;
}
