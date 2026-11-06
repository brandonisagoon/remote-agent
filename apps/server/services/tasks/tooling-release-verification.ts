import { isDeepStrictEqual } from "node:util";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ToolingReleaseRecord } from "../../../../types/tooling-release.ts";
import { verifyPreparedToolingRelease } from "./tooling.ts";

/** Verify the immutable selection immediately before executing its composer.
 * The install digest comes from storage, never a caller-provided snapshot. */
export async function verifyStoredToolingRelease(prisma: PrismaClient, release: ToolingReleaseRecord) {
  const stored = await prisma.toolingRelease.findUnique({ where: { id: release.id } });
  if (!stored || stored.repositoryId !== release.repositoryId || stored.revision !== release.revision
    || stored.tree !== release.tree || stored.policyBlob !== release.policyBlob || stored.checkout !== release.checkout
    || !isDeepStrictEqual(stored.manifest, release.manifest)) throw new Error("Tooling release provenance changed before preparation");
  await verifyPreparedToolingRelease(stored);
}
