import path from "node:path";
import type { RemoteTaskResource } from "../../../../generated/prisma/client.ts";

/** Conservative filesystem boundaries of v1's actual upkeep candidates.
 * Tooling/history and independently retained dispositions are not removals. */
export function activeCleanupRoots(resources: RemoteTaskResource[], retainedResourceIds = new Set<string>(), evidenceParents = true) {
  const roots: string[] = [];
  for (const resource of resources) {
    if (resource.state === "released" || !["browser", "development", "review"].includes(resource.purpose) || retainedResourceIds.has(resource.id)) continue;
    if (path.isAbsolute(resource.externalId) && (resource.kind !== "evidence" || evidenceParents)) roots.push(resource.kind === "evidence" ? path.dirname(resource.externalId) : resource.externalId);
    const metadata = resource.metadata as Record<string, unknown> | null;
    for (const key of ["root", "environmentRoot", "environmentDir", "runtimeRoot", "sourceRoot", "worktreePath", "profilePath", "stateDirectory"]) {
      const value = metadata?.[key]; if (typeof value === "string" && path.isAbsolute(value)) roots.push(value);
    }
    for (const key of ["envFile", "environmentFile", "recipeFile"]) {
      const value = metadata?.[key]; if (typeof value === "string" && path.isAbsolute(value)) roots.push(path.dirname(value));
    }
  }
  return [...new Set(roots)];
}
