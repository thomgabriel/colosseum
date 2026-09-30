#!/bin/zsh
# Installs the depth cron as a launchd agent running from ~/.colosseum (outside ~/Documents, which
# macOS privacy controls hide from launchd agents). Re-run after editing scripts/depth-snapshot.mjs.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="$HOME/.colosseum"
NODE_BIN="$(dirname "$(which node)")"
mkdir -p "$HOME_DIR/depth" "$HOME/Library/LaunchAgents"
cp "$REPO/scripts/depth-snapshot.mjs" "$HOME_DIR/depth-snapshot.mjs"
[ -f "$REPO/.env" ] && grep -E '^JUPITER_API_KEY=' "$REPO/.env" > "$HOME_DIR/env" || : > "$HOME_DIR/env"
PLIST="$HOME/Library/LaunchAgents/com.colosseum.depth-snapshot.plist"
sed -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOME_DIR__#$HOME_DIR#g" "$REPO/scripts/launchd/com.colosseum.depth-snapshot.plist" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded; log: $HOME_DIR/cron.log; data: $HOME_DIR/depth/"
