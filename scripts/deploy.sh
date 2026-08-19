#!/usr/bin/env bash
#
# Pull origin/<branch>, rebuild, migrate, restart, verify — roll back on failure.
#
# Invoked three ways, all of which can overlap:
#   - the GitHub push webhook (POST /webhooks/github)
#   - the launchd poller, every 5 minutes
#   - by hand, optionally with --force
#
# It restarts the very service that may have spawned it, so it must be safe to
# have its parent killed mid-run: everything before `launchctl kickstart` is
# idempotent, and the rollback path re-runs the same steps.
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

SERVICE_NAME="${REMOTE_AGENT_SERVICE_NAME:-remote-agent}"
ROOT="${REMOTE_AGENT_INSTALL_ROOT:-${REMOTE_AGENT_HOME:-$HOME/Library/Application Support/$SERVICE_NAME}}"
REPO="$ROOT/repo"
APP="$ROOT/app"
STATE="$ROOT/state"
BACKUPS="$STATE/backups"
LABEL="dev.$SERVICE_NAME.service"

# Machine-local, non-secret config (ports, paths). Sourced by the launchd
# wrapper too, so both see identical values.
[ -f "$STATE/remote-agent.env" ] && { set -a; . "$STATE/remote-agent.env"; set +a; }
export REMOTE_AGENT_CONFIG="${REMOTE_AGENT_CONFIG:-$STATE/remote-agent.config.json}"
export REMOTE_AGENT_INSTALL_ROOT="$ROOT"
export REMOTE_AGENT_SERVICE_NAME="$SERVICE_NAME"

BRANCH="${REMOTE_AGENT_DEPLOY_BRANCH:-main}"
PORT="${REMOTE_AGENT_PORT:-9000}"
HEALTH="http://127.0.0.1:$PORT/health"
LOG="$STATE/deploy.log"
DEPLOY_DB_SNAPSHOT=""

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

# ---------------------------------------------------------------------------
# Single-flight. macOS has no flock(1), so use mkdir, which is atomic on any
# POSIX filesystem. A lock older than 30 minutes is assumed dead — a deploy
# that long has already failed, and a stale lock must not wedge deploys
# permanently.
# ---------------------------------------------------------------------------
LOCK="$STATE/deploy.lock"
mkdir -p "$STATE"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    log "removing stale lock"
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || { log "lock contended, exiting"; exit 0; }
  else
    log "deploy already running, exiting"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------
# Fetch and decide whether there is anything to do.
# ---------------------------------------------------------------------------
cd "$REPO"
git fetch --quiet origin "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"

PREVIOUS=$(git rev-parse HEAD)
TARGET=$(git rev-parse "origin/$BRANCH")

if [ "$PREVIOUS" = "$TARGET" ] && [ "$FORCE" -eq 0 ]; then
  exit 0
fi

# Only rebuild when something shipped by the standalone service changed.
if [ "$FORCE" -eq 0 ] && [ "$PREVIOUS" != "$TARGET" ]; then
  if ! git diff --name-only "$PREVIOUS" "$TARGET" \
      | grep -qE '^(src/|prisma/|scripts/|package\.json$|bun\.lock$|tsconfig.*\.json$|prisma\.config\.ts$)'; then
    log "no relevant changes ($PREVIOUS -> $TARGET), fast-forwarding without rebuild"
    git reset --hard --quiet "$TARGET"
    exit 0
  fi
fi

log "deploying $PREVIOUS -> $TARGET"

restart_and_check() {
  # build() stops the service to migrate, so bootstrap it back rather than
  # assuming kickstart can restart something that is no longer loaded.
  launchctl bootstrap "gui/$(id -u)" \
    "$HOME/Library/LaunchAgents/$LABEL.plist" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

  for _ in $(seq 1 30); do
    sleep 1
    if curl -fsS -o /dev/null "$HEALTH" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

snapshot_database() {
  if [ -n "$DEPLOY_DB_SNAPSHOT" ]; then
    return
  fi

  database_path="${REMOTE_AGENT_DATABASE_URL#file:}"
  if [ "$database_path" = "$REMOTE_AGENT_DATABASE_URL" ] || [ ! -f "$database_path" ]; then
    log "SQLite database not found; no pre-migration snapshot created"
    DEPLOY_DB_SNAPSHOT="absent"
    return
  fi

  mkdir -p "$BACKUPS"
  DEPLOY_DB_SNAPSHOT="$BACKUPS/remote-agent-$(date -u +%Y%m%dT%H%M%SZ)-$PREVIOUS.sqlite"
  cp -p "$database_path" "$DEPLOY_DB_SNAPSHOT"
  chmod 600 "$DEPLOY_DB_SNAPSHOT"
  log "snapshotted SQLite database to $DEPLOY_DB_SNAPSHOT"
}

restore_database_snapshot() {
  if [ -z "$DEPLOY_DB_SNAPSHOT" ] || [ "$DEPLOY_DB_SNAPSHOT" = "absent" ]; then
    return
  fi

  database_path="${REMOTE_AGENT_DATABASE_URL#file:}"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  cp -p "$DEPLOY_DB_SNAPSHOT" "$database_path"
  chmod 600 "$database_path"
  log "restored SQLite database from $DEPLOY_DB_SNAPSHOT"
}

# ---------------------------------------------------------------------------
# Build. Any failure here aborts before the service is touched, so the running
# version keeps serving.
# ---------------------------------------------------------------------------
build() {
  git -C "$REPO" reset --hard --quiet "$1"

  mkdir -p "$APP"
  # --delete keeps removed files from lingering, but node_modules and the
  # generated Prisma client live only in APP and must survive.
  rsync -a --delete \
    --exclude 'node_modules' \
    --exclude 'src/generated' \
    --exclude '.git' \
    "$REPO/" "$APP/"

  cd "$APP"
  bun install --silent
  bunx prisma generate

  # Migrate with the service STOPPED. The running process holds the SQLite file
  # open, and `migrate deploy` fails with "database is locked" against a live
  # service — which is exactly what happened once: the migration silently
  # failed, the new code shipped anyway, and every webhook died on a missing
  # column while /health still returned 200.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  sleep 2
  snapshot_database
  bunx prisma migrate deploy
  bunx tsc --noEmit -p tsconfig.deploy.json
}

if ! build "$TARGET" >>"$LOG" 2>&1; then
  log "BUILD FAILED at $TARGET — restoring $PREVIOUS"
  # Rebuild from the previous commit rather than only resetting the repo.
  # Resetting git alone left APP populated with the new, unbuildable code, so
  # launchd's KeepAlive restarted the service straight into it.
  # Must bring the service back regardless: build() stopped it to migrate, so
  # a failure here otherwise leaves it unloaded and the host silently dead.
  restore_database_snapshot
  if build "$PREVIOUS" >>"$LOG" 2>&1 && restart_and_check; then
    log "restored $PREVIOUS"
  else
    restart_and_check || log "RESTORE FAILED — service is down, manual intervention required"
  fi
  exit 1
fi

# ---------------------------------------------------------------------------
# Restart and verify.
# ---------------------------------------------------------------------------
if restart_and_check; then
  log "deployed $TARGET OK"
  exit 0
fi

# ---------------------------------------------------------------------------
# Rollback code and the exact pre-migration SQLite snapshot together. This is
# required for intentionally destructive migrations: old code cannot safely
# run against the new schema.
# ---------------------------------------------------------------------------
log "HEALTH CHECK FAILED after deploying $TARGET — rolling back to $PREVIOUS"

restore_database_snapshot
if build "$PREVIOUS" >>"$LOG" 2>&1 && restart_and_check; then
  log "rolled back to $PREVIOUS OK"
else
  log "ROLLBACK FAILED — service is down, manual intervention required"
fi

exit 1
