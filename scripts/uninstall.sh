#!/usr/bin/env bash
#
# Remove the launchd agents. Leaves state/ (database, keys, logs) and the
# cloudflared daemon alone — both are deliberate: losing session registrations
# to a reinstall would be surprising, and the tunnel is shared infrastructure
# installed separately.
#
#   --purge   also delete $ROOT, including the database
set -euo pipefail

# Deliberately NOT under ~/Desktop: macOS TCC blocks launchd agents from
# reading Desktop/Documents/Downloads, and grants are per-executable, so the
# whole bash -> node -> bun chain would need Full Disk Access — and would break
# again on every `brew upgrade`. ~/Library is not TCC-protected.
# Space-free on purpose: this path is threaded through plist strings and shell
# quoting, and "Application Support" would add a space to every one of them.
ROOT="${REMOTE_AGENT_HOME:-$HOME/Library/cubic-remote-agent}"
LABEL="dev.cubicsurveys.remote-agent"
POLL_LABEL="dev.cubicsurveys.remote-agent-poll"

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
