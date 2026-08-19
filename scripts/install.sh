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

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_SOURCE="${REMOTE_AGENT_CONFIG:-$SOURCE_ROOT/remote-agent.config.json}"
ENV_SOURCE="${REMOTE_AGENT_ENV_FILE:-}"
[ -f "$CONFIG_SOURCE" ] || { echo "REMOTE_AGENT_CONFIG must point to a config file" >&2; exit 1; }
[ -f "$ENV_SOURCE" ] || { echo "REMOTE_AGENT_ENV_FILE must point to a secrets env file" >&2; exit 1; }

SERVICE_NAME="${REMOTE_AGENT_SERVICE_NAME:-$(bun -e 'const value = await Bun.file(process.argv[1]).json(); process.stdout.write(value.serviceName)' "$CONFIG_SOURCE")}"
ROOT="${REMOTE_AGENT_INSTALL_ROOT:-$HOME/Library/Application Support/$SERVICE_NAME}"
REPO="$ROOT/repo"
APP="$ROOT/app"
STATE="$ROOT/state"
LABEL="dev.$SERVICE_NAME.service"
POLL_LABEL="dev.$SERVICE_NAME.deploy"
TUNNEL="${REMOTE_AGENT_TUNNEL_NAME:-$SERVICE_NAME}"
# Inherit the remote URL from the checkout this script is run from, so the
# deploy clone authenticates the same way your working checkout already does.
# Hardcoding an SSH URL breaks on a machine set up with HTTPS + the gh
# credential helper, which has no SSH key loaded.
default_remote() {
  git -C "$SOURCE_ROOT" \
    remote get-url origin 2>/dev/null \
    || true
}
GIT_REMOTE="${REMOTE_AGENT_GIT_REMOTE:-$(default_remote)}"
[ -n "$GIT_REMOTE" ] || { echo "REMOTE_AGENT_GIT_REMOTE is required when the source checkout has no origin" >&2; exit 1; }
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
say "Repository"
# ---------------------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  git clone --quiet --depth=1 --branch "$BRANCH" "$GIT_REMOTE" "$REPO"
  echo "  cloned $GIT_REMOTE"
else
  git -C "$REPO" fetch --quiet origin \
    "refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  # This is a dedicated deployment clone. Selecting another configured branch
  # must update its worktree too; fetch alone leaves the previous branch's
  # files in place and can pair an old Prisma client with a newer database.
  git -C "$REPO" reset --hard --quiet "origin/$BRANCH"
  echo "  already present, refreshed"
fi

# ---------------------------------------------------------------------------
say "Configuration"
# ---------------------------------------------------------------------------
cp "$CONFIG_SOURCE" "$STATE/remote-agent.config.json"
cp "$ENV_SOURCE" "$STATE/remote-agent.env"
chmod 600 "$STATE/remote-agent.config.json" "$STATE/remote-agent.env"
printf '%s\n' "$SERVICE_NAME" > "$STATE/service-name"
echo "  installed config and environment"

# ---------------------------------------------------------------------------
say "First build"
# ---------------------------------------------------------------------------
mkdir -p "$APP"
rsync -a --delete --exclude 'node_modules' --exclude 'src/generated' \
  --exclude '.git' "$REPO/" "$APP/"

# Source the machine config BEFORE migrating. Without REMOTE_AGENT_DATABASE_URL
# in the environment, prisma.config.ts falls back to a dev.sqlite inside the app
# directory — which is the rsync --delete target, so the next deploy would
# silently destroy the database.
set -a; . "$STATE/remote-agent.env"; set +a
export REMOTE_AGENT_CONFIG="$STATE/remote-agent.config.json"
export REMOTE_AGENT_INSTALL_ROOT="$ROOT"
export REMOTE_AGENT_SERVICE_NAME="$SERVICE_NAME"

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
		<string>set -a; . "$STATE/remote-agent.env"; set +a; export REMOTE_AGENT_CONFIG="$STATE/remote-agent.config.json" REMOTE_AGENT_INSTALL_ROOT="$ROOT" REMOTE_AGENT_SERVICE_NAME="$SERVICE_NAME"; cd "$APP"; exec /opt/homebrew/bin/bun "$APP/src/server.ts"</string>
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
		<key>REMOTE_AGENT_SERVICE_NAME</key><string>$SERVICE_NAME</string>
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

PUBLIC_URL="${REMOTE_AGENT_PUBLIC_URL%/}"
curl -fsS -o /dev/null "$PUBLIC_URL/health" \
  && echo "  public health OK  ($PUBLIC_URL)" \
  || echo "  public health FAILED — check: cloudflared tunnel info $TUNNEL"

cat <<EOF

Installed.

  service   launchctl print gui/$(id -u)/$LABEL
  logs      tail -f $STATE/remote-agent.log
  deploys   tail -f $STATE/deploy.log
  redeploy  bash $APP/scripts/deploy.sh --force

Remaining manual step: add the GitHub webhook
  URL          $PUBLIC_URL/webhooks/github
  Content type application/json
  Secret       the GITHUB_WEBHOOK_SECRET value from $STATE/remote-agent.env
  Events       Just the push event
EOF
