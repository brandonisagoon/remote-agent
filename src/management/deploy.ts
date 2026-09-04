import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";

import { configFilePath, readConfig, type ServerConfig } from "../lib/config.ts";
import { findExecutable, installLayout, type InstallLayout } from "./paths.ts";
import { runOrThrow } from "./run.ts";
import { daemonDefinition, serviceLabel, supervisor, type ServiceDefinition } from "./supervisor/index.ts";
import { syncTree } from "./sync-tree.ts";
import { waitForHealth } from "./provision.ts";

/** Pull origin/<branch>, rebuild, migrate, restart, verify — roll back on
    failure (TS port of the retired deploy.sh).

    This restarts the very service that may have spawned it, so it must be
    safe to have its parent killed mid-run: everything before the restart is
    idempotent, and the rollback path re-runs the same steps. */

const LOCK_STALE_MS = 30 * 60_000;
/** Files that affect the standalone service; other diffs fast-forward
    without a rebuild. */
const RELEVANT_CHANGE = /^(src\/|prisma\/|bin\/|scripts\/|package\.json$|bun\.lock$|tsconfig.*\.json$|prisma\.config\.ts$)/m;

export type DeployOutcome = "deployed" | "up-to-date" | "skipped" | "already-running" | "failed";

interface DeployContext {
  config: ServerConfig;
  layout: InstallLayout;
  definition: ServiceDefinition;
  bun: string;
  branch: string;
  health: string;
  databasePath: string | null;
  snapshot: string | null | "absent";
  log: (line: string) => void;
}

export async function deploy(options: { force?: boolean } = {}): Promise<DeployOutcome> {
  const config = readConfig();
  const layout = installLayout(config.installRoot);
  const bun = findExecutable("bun");
  if (!bun) throw new Error("bun was not found on PATH or in known install locations");

  mkdirSync(layout.state, { recursive: true });
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(layout.deployLog, `${stamped}\n`);
    console.log(stamped);
  };

  if (!acquireLock(layout, log)) return "already-running";
  try {
    return await deployLocked({
      config,
      layout,
      definition: daemonDefinition({
        serviceName: config.serviceName,
        appRoot: layout.app,
        configFile: configFilePath(),
        logFile: layout.serviceLog,
      }),
      bun,
      branch: config.deployBranch,
      health: `http://127.0.0.1:${config.port}/health`,
      databasePath: config.databaseUrl.startsWith("file:") ? config.databaseUrl.slice(5) : null,
      snapshot: null,
      log,
    }, options.force ?? false);
  } finally {
    try {
      rmdirSync(path.join(layout.state, "deploy.lock"));
    } catch {
      // Already released (e.g. a stale-lock takeover race); nothing to do.
    }
  }
}

/** macOS has no flock(1); mkdir is atomic on any filesystem, and works the
    same on Windows. A lock older than 30 minutes is assumed dead. */
function acquireLock(layout: InstallLayout, log: (line: string) => void): boolean {
  const lock = path.join(layout.state, "deploy.lock");
  try {
    mkdirSync(lock);
    return true;
  } catch {
    const stat = statSync(lock, { throwIfNoEntry: false });
    const age = stat ? Date.now() - stat.mtimeMs : Infinity;
    if (age > LOCK_STALE_MS) {
      log("removing stale lock");
      try {
        rmdirSync(lock);
        mkdirSync(lock);
        return true;
      } catch {
        log("lock contended, exiting");
        return false;
      }
    }
    log("deploy already running, exiting");
    return false;
  }
}

async function deployLocked(context: DeployContext, force: boolean): Promise<DeployOutcome> {
  const { layout, branch, log } = context;
  await runOrThrow("git", ["-C", layout.repo, "fetch", "--quiet", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const previous = (await runOrThrow("git", ["-C", layout.repo, "rev-parse", "HEAD"])).trim();
  const target = (await runOrThrow("git", ["-C", layout.repo, "rev-parse", `origin/${branch}`])).trim();

  if (previous === target && !force) return "up-to-date";

  if (!force && previous !== target) {
    const changed = await runOrThrow("git", ["-C", layout.repo, "diff", "--name-only", previous, target]);
    if (!RELEVANT_CHANGE.test(changed)) {
      log(`no relevant changes (${previous} -> ${target}), fast-forwarding without rebuild`);
      await runOrThrow("git", ["-C", layout.repo, "reset", "--hard", "--quiet", target]);
      return "skipped";
    }
  }

  log(`deploying ${previous} -> ${target}`);

  if (!(await tryBuild(context, target))) {
    log(`BUILD FAILED at ${target} — restoring ${previous}`);
    // Rebuild from the previous commit rather than only resetting the repo:
    // resetting git alone leaves the app copy populated with the new,
    // unbuildable code, and the supervisor restarts the service into it.
    // The service must come back regardless — build() stopped it to migrate.
    await restoreDatabaseSnapshot(context);
    if ((await tryBuild(context, previous)) && (await restartAndCheck(context))) {
      log(`restored ${previous}`);
    } else if (!(await restartAndCheck(context))) {
      log("RESTORE FAILED — service is down, manual intervention required");
    }
    return "failed";
  }

  if (await restartAndCheck(context)) {
    log(`deployed ${target} OK`);
    return "deployed";
  }

  // Roll back code and the exact pre-migration SQLite snapshot together:
  // after an intentionally destructive migration, old code cannot safely run
  // against the new schema.
  log(`HEALTH CHECK FAILED after deploying ${target} — rolling back to ${previous}`);
  await restoreDatabaseSnapshot(context);
  if ((await tryBuild(context, previous)) && (await restartAndCheck(context))) {
    log(`rolled back to ${previous} OK`);
  } else {
    log("ROLLBACK FAILED — service is down, manual intervention required");
  }
  return "failed";
}

/** Any failure before the service is touched leaves the running version
    serving. Migration runs with the service STOPPED: the running process
    holds the SQLite file open, and `migrate deploy` fails with "database is
    locked" against a live service — which once shipped new code over a
    silently failed migration while /health still returned 200. */
async function tryBuild(context: DeployContext, commit: string): Promise<boolean> {
  const { layout, bun, log } = context;
  const env = { REMOTE_AGENT_CONFIG: configFilePath() };
  try {
    await runOrThrow("git", ["-C", layout.repo, "reset", "--hard", "--quiet", commit]);
    syncTree(layout.repo, layout.app);
    await runOrThrow(bun, ["install", "--silent"], { cwd: layout.app, env });
    await runOrThrow(bun, ["x", "prisma", "generate"], { cwd: layout.app, env });
    await supervisor().stop(serviceLabel(context.config.serviceName));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    snapshotDatabase(context, commit);
    await runOrThrow(bun, ["x", "prisma", "migrate", "deploy"], { cwd: layout.app, env });
    await runOrThrow(bun, ["x", "tsc", "--noEmit", "-p", "tsconfig.deploy.json"], { cwd: layout.app, env });
    return true;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function restartAndCheck(context: DeployContext): Promise<boolean> {
  await supervisor().restart(context.definition);
  return waitForHealth(context.health, 30);
}

function snapshotDatabase(context: DeployContext, commit: string): void {
  if (context.snapshot !== null) return;
  const { databasePath, layout, log } = context;
  if (!databasePath || !existsSync(databasePath)) {
    log("SQLite database not found; no pre-migration snapshot created");
    context.snapshot = "absent";
    return;
  }
  mkdirSync(layout.backups, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const snapshot = path.join(layout.backups, `remote-agent-${stamp}-${commit}.sqlite`);
  copyFileSync(databasePath, snapshot);
  if (process.platform !== "win32") chmodSync(snapshot, 0o600);
  context.snapshot = snapshot;
  log(`snapshotted SQLite database to ${snapshot}`);
}

async function restoreDatabaseSnapshot(context: DeployContext): Promise<void> {
  if (context.snapshot === null || context.snapshot === "absent") return;
  const { databasePath, log } = context;
  if (!databasePath) return;
  await supervisor().stop(serviceLabel(context.config.serviceName));
  copyFileSync(context.snapshot, databasePath);
  if (process.platform !== "win32") chmodSync(databasePath, 0o600);
  log(`restored SQLite database from ${context.snapshot}`);
}

// `bun src/management/deploy.ts [--force]` — invoked by the CLI/GUI update
// action and by hand.
if (import.meta.main) {
  const outcome = await deploy({ force: process.argv.includes("--force") });
  if (outcome === "failed") process.exitCode = 1;
}
