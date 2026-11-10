import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findExecutable } from "./paths.ts";
import { z } from "zod";
import { runOrThrow } from "./run.ts";

const VersionRange = z.object({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine(value => value.min <= value.max);
const Contracts = z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}\/v[1-9][0-9]{0,2}$/)).max(32).refine(values => new Set(values).size === values.length);
const ServerProtocol = z.object({ contract: z.literal("remote-agent.server-tooling/v1"), selectionVersion: z.literal(1), operationProtocol: VersionRange, serverContracts: Contracts.optional() });

export interface ToolingDeploymentState {
  selections: Array<{ repositoryId: string; generation: number; revision: string; serverProtocol: { min: number; max: number } }>;
  retainedProtocols: number[];
  serverContracts?: string[];
}

/** Read only. This management seam does not load server modules or Prisma,
 * create a missing database, migrate, or resolve a moving tooling ref. */
export async function readToolingDeploymentState(databaseUrl: string): Promise<ToolingDeploymentState> {
  if (!databaseUrl.startsWith("file:")) throw new Error("Tooling deployment compatibility requires the configured local SQLite database");
  const databasePath = databaseUrl.slice(5);
  if (!existsSync(databasePath)) return { selections: [], retainedProtocols: [], serverContracts: [] };
  const bun = findExecutable("bun");
  if (!bun) throw new Error("Bun is required to inspect deployment compatibility");
  // Native libSQL reads can retain WAL handles after close until GC. Keep
  // management's database lifetime inside an awaited child, just like the
  // snapshot helper, so no inspection handle survives into service stop.
  const helper = fileURLToPath(new URL("./tooling-deployment-read.ts", import.meta.url));
  const value = JSON.parse(await runOrThrow(bun, ["--no-env-file", helper, databasePath]));
  return z.object({
    selections: z.array(z.object({ repositoryId: z.string(), generation: z.number().int().positive(), revision: z.string(), serverProtocol: VersionRange }).strict()),
    retainedProtocols: z.array(z.number().int().nonnegative()),
    serverContracts: Contracts,
  }).strict().parse(value);
}

/** Inspect the candidate Git object before resetting/copying/stopping anything.
 * A pre-selection server may never silently become the release selector again. */
export async function assertToolingServerCompatibility(input: { databaseUrl: string; repository: string; revision: string },
  dependencies = { read: readToolingDeploymentState, run: runOrThrow }): Promise<void> {
  const state = await dependencies.read(input.databaseUrl);
  if (!state.selections.length && !state.retainedProtocols.length && !state.serverContracts?.length) return;
  let protocol: z.infer<typeof ServerProtocol>;
  try {
    const source = await dependencies.run("git", ["-C", input.repository, "show", `${input.revision}:lib/tooling-server-protocol.json`]);
    protocol = ServerProtocol.parse(JSON.parse(source));
  } catch {
    throw new Error("Server deployment refused: candidate cannot preserve durable tooling selection. Keep the database and deploy a release-aware server through coordinated recovery.");
  }
  const range = protocol.operationProtocol;
  const missing = (state.serverContracts ?? []).filter(contract => !protocol.serverContracts?.includes(contract));
  if (missing.length) throw new Error("Server deployment refused: candidate cannot read preserved data contracts " + missing.join(", ") + ". Keep the existing database and use a compatible server.");
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
  if (state.selections.length || state.retainedProtocols.length || state.serverContracts?.length) {
    throw new Error("Automatic database rewind refused after tooling activation; preserve operation history and use coordinated compatible server recovery");
  }
}
