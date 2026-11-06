import { existsSync } from "node:fs";
import { createClient } from "@libsql/client";
import { z } from "zod";
import { runOrThrow } from "./run.ts";

const VersionRange = z.object({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine(value => value.min <= value.max);
const ServerProtocol = z.object({ contract: z.literal("remote-agent.server-tooling/v1"), selectionVersion: z.literal(1), operationProtocol: VersionRange });
const ReleaseProtocol = z.object({ serverProtocol: VersionRange });

export interface ToolingDeploymentState {
  selections: Array<{ repositoryId: string; generation: number; revision: string; serverProtocol: { min: number; max: number } }>;
  retainedProtocols: number[];
}

/** Read only. This management seam does not load server modules or Prisma,
 * create a missing database, migrate, or resolve a moving tooling ref. */
export async function readToolingDeploymentState(databaseUrl: string): Promise<ToolingDeploymentState> {
  if (!databaseUrl.startsWith("file:")) throw new Error("Tooling deployment compatibility requires the configured local SQLite database");
  const databasePath = databaseUrl.slice(5);
  if (!existsSync(databasePath)) return { selections: [], retainedProtocols: [] };
  const client = createClient({ url: databaseUrl });
  try {
    const tx = await client.transaction("read");
    try {
      const tables = await tx.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ToolingSelection'");
      if (!tables.rows.length) return { selections: [], retainedProtocols: [] };
      const selected = await tx.execute("SELECT s.repositoryId, s.generation, r.revision, r.manifest FROM ToolingSelection s LEFT JOIN ToolingRelease r ON r.id = s.releaseId ORDER BY s.repositoryId");
      const selections = selected.rows.map(row => {
        const value = z.object({ repositoryId: z.string(), generation: z.number().int().positive(), revision: z.string(), manifest: z.string() }).parse(row);
        return { repositoryId: value.repositoryId, generation: value.generation, revision: value.revision,
          serverProtocol: ReleaseProtocol.parse(JSON.parse(value.manifest)).serverProtocol };
      });
      const operations = await tx.execute("SELECT DISTINCT protocol FROM ToolingOperation WHERE status != 'completed' ORDER BY protocol");
      const retainedTable = await tx.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ToolingRetainedConsumer'");
      const consumers = retainedTable.rows.length
        ? (await tx.execute("SELECT DISTINCT protocol FROM ToolingRetainedConsumer WHERE status IN ('pending', 'confirmed') ORDER BY protocol")).rows : [];
      // Producing callbacks can be complete while their resources still run.
      // A server rollback must continue to understand those retained readers.
      return { selections, retainedProtocols: [...new Set([...operations.rows, ...consumers].map(row => z.number().int().nonnegative().parse(row.protocol)))].sort((a, b) => a - b) };
    } finally { await tx.rollback(); }
  } finally { client.close(); }
}

/** Inspect the candidate Git object before resetting/copying/stopping anything.
 * A pre-selection server may never silently become the release selector again. */
export async function assertToolingServerCompatibility(input: { databaseUrl: string; repository: string; revision: string },
  dependencies = { read: readToolingDeploymentState, run: runOrThrow }): Promise<void> {
  const state = await dependencies.read(input.databaseUrl);
  if (!state.selections.length && !state.retainedProtocols.length) return;
  let protocol: z.infer<typeof ServerProtocol>;
  try {
    const source = await dependencies.run("git", ["-C", input.repository, "show", `${input.revision}:lib/tooling-server-protocol.json`]);
    protocol = ServerProtocol.parse(JSON.parse(source));
  } catch {
    throw new Error("Server deployment refused: candidate cannot preserve durable tooling selection. Keep the database and deploy a release-aware server through coordinated recovery.");
  }
  const range = protocol.operationProtocol;
  if (state.selections.some(selection => Math.max(range.min, selection.serverProtocol.min) > Math.min(range.max, selection.serverProtocol.max))
    || state.retainedProtocols.some(version => version !== 0 && (version < range.min || version > range.max))) {
    throw new Error("Server deployment refused: candidate cannot execute the active or retained tooling operation protocol");
  }
}

/** A snapshot predates work admitted after the new server started. Restoring
 * it could erase activation/bindings while provider effects remain. Preserve
 * the original DB; DRA-33's coordinated recovery owns any compatible rollback. */
export async function assertToolingSnapshotRestoreSafe(databaseUrl: string): Promise<void> {
  const state = await readToolingDeploymentState(databaseUrl);
  if (state.selections.length || state.retainedProtocols.length) {
    throw new Error("Automatic database rewind refused after tooling activation; preserve operation history and use coordinated compatible server recovery");
  }
}
