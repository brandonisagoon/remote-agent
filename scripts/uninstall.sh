#!/usr/bin/env bash
#
# Remove the launchd agents. Leaves state/ (database, keys, logs) and the
# cloudflared daemon alone — both are deliberate: losing session registrations
# to a reinstall would be surprising, and the tunnel is shared infrastructure
# installed separately.
#
#   --purge   also delete $ROOT, including the database
set -euo pipefail

CONFIG_SOURCE="${REMOTE_AGENT_CONFIG:-remote-agent.config.json}"
[ -f "$CONFIG_SOURCE" ] || { echo "REMOTE_AGENT_CONFIG must point to a config file" >&2; exit 1; }
config_value() {
  bun -e 'let value = await Bun.file(process.argv[1]).json(); for (const key of process.argv[2].split(".")) value = value?.[key]; if (value != null) process.stdout.write(String(value))' "$CONFIG_SOURCE" "$1"
}
SERVICE_NAME="$(config_value serviceName)"
ROOT="$(config_value deployment.installRoot)"
[ -n "$ROOT" ] || ROOT="$HOME/Library/Application Support/$SERVICE_NAME"
case "$ROOT" in "~/"*) ROOT="$HOME/${ROOT#\~/}" ;; esac
LABEL="dev.$SERVICE_NAME.service"
POLL_LABEL="dev.$SERVICE_NAME.deploy"

for label in "$LABEL" "$POLL_LABEL"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "removed $label"
done

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$ROOT"
  echo "purged $ROOT"
else
  echo "left $ROOT in place (use --purge to delete state, including the database)"
fi

echo
echo "The cloudflared tunnel is untouched. To remove it as well:"
echo "  sudo launchctl bootout system/com.cloudflare.cloudflared"
echo "  sudo rm /Library/LaunchDaemons/com.cloudflare.cloudflared.plist"
