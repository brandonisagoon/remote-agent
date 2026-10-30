import path from "node:path";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { z } from "zod";
import type { assertPreparedCleanup } from "./cleanup-lifecycle.ts";
import { legacyPrivateExportScope, exportContains } from "./private-export-scope.ts";
import { assertRegisteredPathSharing } from "./cleanup-filesystem.ts";
import { ArchiveRetentionProof } from "./archive-retention-schema.ts";

type Database = Pick<PrismaClient, "remoteTask" | "remoteTaskResource" | "runtimeMetadataEvent">;
type Active = Awaited<ReturnType<typeof assertPreparedCleanup>>;

/** Local scope only: the client separately authenticates backup bytes and
 * verifies stopped consumers, held files and the native retained capture. */
export async function assertPrivateExportScope(prisma: Database, active: Active, key: string) {
  if (active.kind !== "v1") throw new Error("Private export scope requires its original v1 operation");
  const scope = legacyPrivateExportScope({ id: active.task.id, worktreePath: active.binding.worktree, toolingRevision: active.binding.toolingRevision,
    pinnedToolingRoot: active.binding.pinnedToolingRoot, resources: active.binding.resources }, key);
  const paths = [scope.source, scope.storage, scope.plan, scope.quarantine.directory];
  const protectedPaths = [active.binding.worktree, active.binding.repositoryRoot, active.binding.toolingRoot, active.binding.pinnedToolingRoot].filter((file): file is string => Boolean(file));
  for (const reference of active.binding.authority) {
    if (reference.action !== "finalization-archive-retention" && reference.action !== "legacy-evidence-retained") continue;
    const event = await prisma.runtimeMetadataEvent.findUniqueOrThrow({ where: { sequence: reference.revision } }), value: unknown = JSON.parse(event.value!);
    if (reference.action === "finalization-archive-retention") protectedPaths.push(...ArchiveRetentionProof.parse(value).resources.map(resource => resource.archive.root));
    else protectedPaths.push(z.object({ archiveRoot: z.string() }).parse(value).archiveRoot);
  }
  if (protectedPaths.some(root => paths.some(file => exportContains(root, file) || exportContains(file, root)))) throw new Error("Private export scope overlaps source, tooling or retained material");
  await assertRegisteredPathSharing(prisma, active.task.id, paths);
  const ancestors = new Set<string>();
  for (const file of paths) for (let cursor = file; ; cursor = path.dirname(cursor)) { ancestors.add(cursor); if (cursor === path.dirname(cursor)) break; }
  if (await prisma.remoteTask.findFirst({ where: { OR: [{ worktreePath: { in: [...ancestors] } }, ...paths.map(file => ({ worktreePath: { startsWith: file + path.sep } }))] } })) throw new Error("Private export scope overlaps a registered task worktree");
}
