/** Bun-only SQLite helper. Never import this from deploy.ts or anything the
 * Electron/Node graph loads: management runs it as an explicit Bun child
 * (`bun management/sqlite-snapshot.ts snapshot|restore ...`). */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

/** Another connection (a live or half-stopped server, a manual shell) has
 * the database open. Nothing was copied, moved or removed. */
export class LiveDatabaseConnection extends Error {
  constructor(file: string, action: string) {
    super(`${action} refused: another connection holds ${file} open, so the service is not proven stopped; the database, WAL and shared-memory files were left untouched`);
  }
}

const sidecars = (file: string) => ({ wal: `${file}-wal`, shm: `${file}-shm`, journal: `${file}-journal` });
const isBusy = (error: unknown) => /locked|busy/i.test(error instanceof Error ? error.message : String(error));

/**
 * Proof of a quiescent database, not a timer. In WAL mode (the server's
 * journal mode) SQLite's exclusive locking mode cannot be entered while any
 * other connection has the file open, even idle; in rollback-journal mode an
 * idle connection holds no lock, but all committed data is already in the
 * main file. Waiting only bounds how long a stopping server may take to close.
 * POSIX locks are per process, so this proves the absence of OTHER processes'
 * connections; it cannot stop a process from opening the file afterwards
 * (the supervisor stop and the deploy lock do that). Out of WAL mode only an
 * active writer is provable; a later write from an idle connection lands in
 * the preserved evidence file (POSIX rename keeps its inode), never lost.
 *
 * Once the lock is held the database immediately leaves WAL mode: SQLite
 * checkpoints every committed frame (including those of a killed writer)
 * into the main file and removes the WAL itself. Closing an exclusive WAL
 * connection would otherwise leave a truncated WAL beside a stale index that
 * a normal connection can fail to open. The server re-enables WAL on boot.
 */
async function withExclusiveDatabase<T>(file: string, action: string, fn: (db: Database) => T, busyTimeoutMs: number): Promise<T> {
  const deadline = Date.now() + Math.max(0, busyTimeoutMs);
  for (;;) {
    let db: Database;
    try { db = new Database(file, { readwrite: true, create: false }); }
    catch (error) { throw new Error(`${action} could not open ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    let locked = false;
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("BEGIN IMMEDIATE");
      db.exec("COMMIT");
      locked = true;
      const mode = db.query("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string } | null;
      if (mode?.journal_mode !== "delete") throw new Error(`${action} could not checkpoint ${file} out of WAL mode; nothing was copied or moved`);
      // SQLite removes the WAL only when no other connection uses it.
      if (existsSync(sidecars(file).wal)) throw new LiveDatabaseConnection(file, action);
      return fn(db);
    } catch (error) {
      if (locked || !isBusy(error)) throw error;
    } finally { db.close(); }
    if (Date.now() >= deadline) throw new LiveDatabaseConnection(file, action);
    await Bun.sleep(25);
  }
}

function assertIntact(file: string, label: string) {
  const db = new Database(file, { readonly: true });
  try {
    const result = db.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
    if (result?.quick_check !== "ok") throw new Error(`${label} ${file} failed its integrity check`);
  } finally { db.close(); }
}

function fsyncPath(target: string) {
  const descriptor = openSync(target, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Consistent single-file copy of a stopped database (VACUUM INTO), including
 * committed transactions that were still only in its WAL. */
export async function snapshotStoppedDatabase(file: string, snapshot: string, options: { busyTimeoutMs?: number } = {}): Promise<void> {
  if (existsSync(snapshot)) throw new Error(`Database snapshot ${snapshot} already exists; refusing to overwrite it`);
  await withExclusiveDatabase(file, "Database snapshot", db => {
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  }, options.busyTimeoutMs ?? 5_000);
  if (process.platform !== "win32") chmodSync(snapshot, 0o600);
  fsyncPath(snapshot);
  assertIntact(snapshot, "Database snapshot");
}

/**
 * Replace a stopped database with an exact snapshot. The current database is
 * made self-contained under the exclusive lock and preserved at `evidence`,
 * never deleted; an old shared-memory index is moved beside it. A remaining
 * WAL or rollback journal refuses the restore. On POSIX the lock is held
 * across the swap so no connection can open the path in between.
 */
export async function restoreStoppedDatabase(file: string, snapshot: string, evidence: string, options: { busyTimeoutMs?: number } = {}): Promise<void> {
  assertIntact(snapshot, "Database snapshot");
  for (const target of [evidence, ...Object.values(sidecars(evidence))]) if (existsSync(target)) throw new Error(`Restore evidence path ${target} already exists; refusing to overwrite it`);
  const staged = `${file}.restore-${crypto.randomUUID()}.tmp`, live = sidecars(file);
  const swap = () => {
    if (existsSync(live.wal) || existsSync(live.journal)) throw new Error(`Database ${file} still has a WAL or rollback journal after checkpoint; it was preserved and not restored`);
    renameSync(file, evidence);
    if (existsSync(live.shm)) renameSync(live.shm, sidecars(evidence).shm);
    renameSync(staged, file);
  };
  try {
    copyFileSync(snapshot, staged);
    if (process.platform !== "win32") chmodSync(staged, 0o600);
    fsyncPath(staged);
    // Windows cannot rename an open file; there the swap follows the close.
    await withExclusiveDatabase(file, "Database restore", () => { if (process.platform !== "win32") swap(); }, options.busyTimeoutMs ?? 5_000);
    if (process.platform === "win32") swap();
  } finally {
    // Only this function's own staged copy; never the database or evidence.
    if (existsSync(staged)) rmSync(staged);
  }
  if (process.platform !== "win32") fsyncPath(path.dirname(file));
  for (const target of [live.wal, live.journal]) {
    if (existsSync(target)) throw new Error(`Restored database ${file} has an unexpected ${path.basename(target)}; inspect it before starting the service`);
  }
}

// Explicit Bun child entry point used by management/deploy.ts. Prints one
// JSON line on success; any refusal is a nonzero exit with its message.
if (import.meta.main) {
  const [action, ...args] = process.argv.slice(2);
  try {
    const busyTimeoutMs = Number(args.at(-1));
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw new Error("A non-negative busy timeout in milliseconds is required");
    if (action === "snapshot" && args.length === 3) await snapshotStoppedDatabase(args[0]!, args[1]!, { busyTimeoutMs });
    else if (action === "restore" && args.length === 4) await restoreStoppedDatabase(args[0]!, args[1]!, args[2]!, { busyTimeoutMs });
    else throw new Error("Use snapshot <database> <snapshot> <busy-ms> or restore <database> <snapshot> <evidence> <busy-ms>");
    console.log(JSON.stringify({ ok: true, action }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
