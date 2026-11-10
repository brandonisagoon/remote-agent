import { Database } from "bun:sqlite";

/** Bun-only management child. Exiting is the database lifetime boundary;
 * Electron/Node never imports this module or a Bun SQLite implementation. */
export function readDeploymentState(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    db.exec("BEGIN DEFERRED");
    const table = (name: string) => db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
    const contracts = new Set<string>();
    const requireContracts = (value: unknown) => {
      if (value === undefined) return;
      if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,63}\/v[1-9][0-9]{0,2}$/.test(item))) throw new Error("Invalid saved server contract declaration");
      for (const contract of value) contracts.add(contract);
    };
    // Even inactive registered releases are read by release inspection/retry.
    // Preserving rows is insufficient if the candidate strips their manifest.
    if (table("ToolingRelease")) {
      const releases = db.query("SELECT manifest FROM ToolingRelease LIMIT 10001").all() as Array<{ manifest: string }>;
      if (releases.length > 10000) throw new Error("Release inventory exceeds its bound");
      for (const release of releases) requireContracts(JSON.parse(release.manifest).serverContracts);
    }
    if (table("RuntimeIssueUpdate")) {
      if (db.query('SELECT 1 FROM RuntimeIssueUpdate WHERE NOT json_valid(input) LIMIT 1').get()) throw new Error("Invalid saved publication input");
      if (db.query("SELECT 1 FROM RuntimeIssueUpdate WHERE json_type(input, '$.publication') IS NOT NULL LIMIT 1").get()) contracts.add("task-publication/v1");
    }
    if (table("RuntimeMetadataEvent")) {
      // Include accepted preparations and interrupted journals. History is
      // immutable and can be reread after completion; no status erases a reader.
      const kinds = db.query("SELECT DISTINCT j.value FROM RuntimeMetadataEvent e, json_tree(CASE WHEN json_valid(e.value) THEN e.value ELSE 'null' END) j WHERE j.key = 'kind' AND j.value IN ('clerk-assignment', 'configuration-completion/v1')").all() as Array<{ value: string }>;
      if (kinds.some(row => row.value === "clerk-assignment")) contracts.add("clerk-assignment/v1");
      if (kinds.some(row => row.value === "configuration-completion/v1")) contracts.add("configuration-completion/v1");
      if (db.query("SELECT 1 FROM RuntimeMetadataEvent WHERE action = 'completion-contract' AND json_extract(CASE WHEN json_valid(value) THEN value ELSE 'null' END, '$.boundary') = 'configuration-only' LIMIT 1").get()) contracts.add("configuration-completion/v1");
    }
    const selected = (table("ToolingSelection") ? db.query("SELECT s.repositoryId, s.generation, r.revision, r.manifest FROM ToolingSelection s LEFT JOIN ToolingRelease r ON r.id = s.releaseId ORDER BY s.repositoryId").all() : []) as Array<{ repositoryId: string; generation: number; revision: string; manifest: string }>;
    const selections = selected.map(row => ({ repositoryId: row.repositoryId, generation: row.generation, revision: row.revision, serverProtocol: JSON.parse(row.manifest).serverProtocol }));
    const operations = (table("ToolingOperation") ? db.query("SELECT DISTINCT protocol FROM ToolingOperation WHERE status != 'completed' ORDER BY protocol").all() : []) as Array<{ protocol: number }>;
    const consumers = table("ToolingRetainedConsumer")
      ? db.query("SELECT DISTINCT protocol FROM ToolingRetainedConsumer WHERE status IN ('pending', 'confirmed') ORDER BY protocol").all() as Array<{ protocol: number }> : [];
    return { selections, retainedProtocols: [...new Set([...operations, ...consumers].map(row => row.protocol))].sort((a, b) => a - b), serverContracts: [...contracts].sort() };
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
