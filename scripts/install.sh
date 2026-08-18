#!/usr/bin/env bash
#
# One-time provisioning for the remote-agent host. Idempotent: safe to re-run
# after a rebuild, an upgrade, or a failed attempt.
#
# Provisioning is deliberately separate from startup. Creating a tunnel or a
# DNS record mints long-lived credentials against a real domain; doing that
# from a supervised process could churn DNS or mint duplicate tunnels on a
# retry loop. The running service only ever does `cloudflared tunnel run`.
set -euo pipefail

# Deliberately NOT under ~/Desktop: macOS TCC blocks launchd agents from
# reading Desktop/Documents/Downloads, and grants are per-executable, so the
# whole bash -> node -> bun chain would need Full Disk Access — and would break
# again on every `brew upgrade`. ~/Library is not TCC-protected.
# Space-free on purpose: this path is threaded through plist strings and shell
# quoting, and "Application Support" would add a space to every one of them.
ROOT="${REMOTE_AGENT_HOME:-$HOME/Library/cubic-remote-agent}"
REPO="$ROOT/repo"
APP="$ROOT/app"
STATE="$ROOT/state"
LABEL="dev.cubicsurveys.remote-agent"
POLL_LABEL="dev.cubicsurveys.remote-agent-poll"
TUNNEL="${REMOTE_AGENT_TUNNEL_NAME:-cubic-remote-agent}"
HOSTNAME_FQDN="${REMOTE_AGENT_HOSTNAME:-agents.cubicsurveys.dev}"
# Inherit the remote URL from the checkout this script is run from, so the
# deploy clone authenticates the same way your working checkout already does.
# Hardcoding an SSH URL breaks on a machine set up with HTTPS + the gh
# credential helper, which has no SSH key loaded.
default_remote() {
  git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)" \
    remote get-url origin 2>/dev/null \
    || echo "https://github.com/cubic-surveys/cubic.git"
}
GIT_REMOTE="${REMOTE_AGENT_GIT_REMOTE:-$(default_remote)}"
BRANCH="${REMOTE_AGENT_DEPLOY_BRANCH:-main}"
PORT="${REMOTE_AGENT_PORT:-9000}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
say "Directories"
# ---------------------------------------------------------------------------
mkdir -p "$ROOT" "$STATE"
chmod 700 "$STATE"
echo "  $ROOT"

# ---------------------------------------------------------------------------
say "Repository (sparse, shallow)"
# ---------------------------------------------------------------------------
# Sparse + shallow: the full monorepo is ~1GB of history and workspaces this
# service never uses. `patches` is required because the root package.json
# declares patchedDependencies and bun fails without it.
if [ ! -d "$REPO/.git" ]; then
  git clone --quiet --filter=blob:none --sparse --depth=1 \
    --branch "$BRANCH" "$GIT_REMOTE" "$REPO"
  git -C "$REPO" sparse-checkout set apps/remote-agent patches
  echo "  cloned $GIT_REMOTE"
else
  git -C "$REPO" sparse-checkout set apps/remote-agent patches
  git -C "$REPO" fetch --quiet origin \
    "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  # This is a dedicated deployment clone. Selecting another configured branch
  # must update its worktree too; fetch alone leaves the previous branch's
  # files in place and can pair an old Prisma client with a newer database.
  git -C "$REPO" reset --hard --quiet "origin/$BRANCH"
  echo "  already present, refreshed"
fi

# ---------------------------------------------------------------------------
say "Machine configuration"
# ---------------------------------------------------------------------------
# Non-secret, machine-specific values. Kept out of the repo so home-directory
# paths are never committed, and sourced by BOTH the launchd wrapper and
# deploy.sh so the two can never disagree.
if [ ! -f "$STATE/remote-agent.env" ]; then
  cat > "$STATE/remote-agent.env" <<EOF
REMOTE_AGENT_HOST=127.0.0.1
REMOTE_AGENT_PORT=$PORT
REMOTE_AGENT_PUBLIC_URL=https://$HOSTNAME_FQDN
REMOTE_AGENT_DATABASE_URL=file:$STATE/remote-agent.sqlite
REMOTE_AGENT_DEPLOY_SCRIPT=$APP/scripts/deploy.sh
REMOTE_AGENT_DEPLOY_BRANCH=$BRANCH
REMOTE_AGENT_HOME=$ROOT
REMOTE_AGENT_MACHINE=macbook-air
REMOTE_AGENT_BB_URL=http://127.0.0.1:38886
REMOTE_AGENT_ZED_HOST=cubic-remote
REMOTE_AGENT_WORKSPACE_REPO=$HOME/Desktop/cubic
EOF
  chmod 600 "$STATE/remote-agent.env"
  echo "  wrote $STATE/remote-agent.env"
else
  echo "  $STATE/remote-agent.env exists, leaving alone"
fi

# ---------------------------------------------------------------------------
say "dotenvx private key"
# ---------------------------------------------------------------------------
# The deploy clone has no .env.keys (correctly gitignored), so the one key that
# decrypts .env.production must live here. This is the single irreducible
# plaintext secret on the box — inherent to dotenvx, since something has to
# bootstrap decryption.
if [ ! -f "$STATE/remote-agent.keys" ]; then
  echo "  Paste DOTENV_PRIVATE_KEY_PRODUCTION (from .env.keys in your dev checkout)."
  printf '  > '
  read -rs PRIVATE_KEY
  echo
  printf 'DOTENV_PRIVATE_KEY_PRODUCTION=%s\n' "$PRIVATE_KEY" > "$STATE/remote-agent.keys"
  chmod 600 "$STATE/remote-agent.keys"
  unset PRIVATE_KEY
  echo "  wrote $STATE/remote-agent.keys (0600)"
else
  echo "  $STATE/remote-agent.keys exists, leaving alone"
fi

# ---------------------------------------------------------------------------
say "First build"
# ---------------------------------------------------------------------------
mkdir -p "$APP"
rsync -a --delete --exclude 'node_modules' --exclude 'src/generated' \
  "$REPO/apps/remote-agent/" "$APP/"

# Source the machine config BEFORE migrating. Without REMOTE_AGENT_DATABASE_URL
# in the environment, prisma.config.ts falls back to a dev.sqlite inside the app
# directory — which is the rsync --delete target, so the next deploy would
# silently destroy the database.
set -a; . "$STATE/remote-agent.env"; set +a

( cd "$APP" && bun install --silent && bunx prisma generate && bunx prisma migrate deploy )
chmod 600 "$STATE/remote-agent.sqlite" 2>/dev/null || true
echo "  built  (db: $REMOTE_AGENT_DATABASE_URL)"

# ---------------------------------------------------------------------------
say "launchd user agents"
# ---------------------------------------------------------------------------
# User agents keep the service in the same login context as the workspace and
# provider credentials used by bb execution hosts.
mkdir -p "$HOME/Library/LaunchAgents"

# Retire the pre-bb pane reconciliation job if an older install created it.
launchctl bootout "gui/$(id -u)/dev.cubicsurveys.agent-session-reconcile" 2>/dev/null || true

cat > "$HOME/Library/LaunchAgents/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>-c</string>
		<string>set -a; . "$STATE/remote-agent.env"; . "$STATE/remote-agent.keys"; set +a; cd "$APP"; exec "$APP/node_modules/.bin/dotenvx" run -q -f "$REPO/.env.production" -- /opt/homebrew/bin/bun "$APP/src/server.ts"</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin</string>
		<key>HOME</key><string>$HOME</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>$STATE/remote-agent.log</string>
	<key>StandardErrorPath</key><string>$STATE/remote-agent.log</string>
</dict>
</plist>
EOF

cat > "$HOME/Library/LaunchAgents/$POLL_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$POLL_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$APP/scripts/deploy.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin</string>
		<key>HOME</key><string>$HOME</string>
		<key>REMOTE_AGENT_HOME</key><string>$ROOT</string>
	</dict>
	<key>StartInterval</key><integer>300</integer>
	<key>StandardOutPath</key><string>$STATE/deploy.log</string>
	<key>StandardErrorPath</key><string>$STATE/deploy.log</string>
</dict>
</plist>
EOF

for label in "$LABEL" "$POLL_LABEL"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
  echo "  loaded $label"
done

# ---------------------------------------------------------------------------
say "Verify"
# ---------------------------------------------------------------------------
for _ in $(seq 1 30); do
  sleep 1
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health"; then
    echo "  local health OK"
    break
  fi
done

curl -fsS -o /dev/null "https://$HOSTNAME_FQDN/health" \
  && echo "  public health OK  (https://$HOSTNAME_FQDN)" \
  || echo "  public health FAILED — check: cloudflared tunnel info $TUNNEL"

cat <<EOF

Installed.

  service   launchctl print gui/$(id -u)/$LABEL
  logs      tail -f $STATE/remote-agent.log
  deploys   tail -f $STATE/deploy.log
  redeploy  bash $APP/scripts/deploy.sh --force

Remaining manual step: add the GitHub webhook
  URL          https://$HOSTNAME_FQDN/webhooks/github
  Content type application/json
  Secret       the GITHUB_WEBHOOK_SECRET value from .env.production
  Events       Just the push event
EOF
