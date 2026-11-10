import { Database } from "bun:sqlite";

/** Bun-only management child. Exiting is the database lifetime boundary;
 * Electron/Node never imports this module or a Bun SQLite implementation. */
export function readDeploymentState(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    db.exec("BEGIN DEFERRED");
    const table = (name: string) => db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
    if (!table("ToolingSelection")) return { selections: [], retainedProtocols: [] };
    const selected = db.query("SELECT s.repositoryId, s.generation, r.revision, r.manifest FROM ToolingSelection s LEFT JOIN ToolingRelease r ON r.id = s.releaseId ORDER BY s.repositoryId").all() as Array<{ repositoryId: string; generation: number; revision: string; manifest: string }>;
    const selections = selected.map(row => ({ repositoryId: row.repositoryId, generation: row.generation, revision: row.revision, serverProtocol: JSON.parse(row.manifest).serverProtocol }));
    const operations = db.query("SELECT DISTINCT protocol FROM ToolingOperation WHERE status != 'completed' ORDER BY protocol").all() as Array<{ protocol: number }>;
    const consumers = table("ToolingRetainedConsumer")
      ? db.query("SELECT DISTINCT protocol FROM ToolingRetainedConsumer WHERE status IN ('pending', 'confirmed') ORDER BY protocol").all() as Array<{ protocol: number }> : [];
    return { selections, retainedProtocols: [...new Set([...operations, ...consumers].map(row => row.protocol))].sort((a, b) => a - b) };
  } finally { db.close(); }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || !process.argv[2]) throw new Error("An exact database path is required");
    console.log(JSON.stringify(readDeploymentState(process.argv[2])));
  } catch {
    console.error("Deployment compatibility could not read the existing database; no deployment was authorized");
    process.exitCode = 1;
  }
}
