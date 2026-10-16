#!/bin/zsh
# Installs the daily prune of the hosted database (scripts/ops/prune-risk.ts) as the launchd agent
# com.colosseum.risk-prune, beside the hosted collectors in ~/.colosseum/hosted-risk, whose env file names the
# database (DATABASE_URL). The job runs once a day at 05:30 local, after the loop's 04:00 daily work; a Mac that
# slept through it runs it on waking.
#
#   install-prune.sh                 bundle, write the plist, load it
#   install-prune.sh --importers     also rebuild the loop's two importers that skip rows older than the window
#                                    (risk-lending-import.mjs, risk-evm-import.mjs); the ones there are kept as
#                                    *.before-<stamp>.mjs. Needed once, before the first prune: the importers built
#                                    before it re-insert what the prune deletes.
#   install-prune.sh --dry-run-now   after installing, one dry run (counts only) against the env file's database
#   install-prune.sh --no-load       write everything, load nothing (needs PRUNE_HOME, a rehearsal folder)
#
# PRUNE_HOME names another folder (a rehearsal): the plist goes to $PRUNE_HOME/LaunchAgents and nothing is loaded.
# The prune is bundled with its dependencies into one file because launchd agents cannot read ~/Documents. The env
# file is read by the job only; this script checks that it names DATABASE_URL and prints nothing from it.
set -euo pipefail
IMPORTERS=0
DRY_NOW=0
LOAD=1
for a in "$@"; do
  case "$a" in
    --importers) IMPORTERS=1 ;;
    --dry-run-now) DRY_NOW=1 ;;
    --no-load) LOAD=0 ;;
    *) echo "usage: install-prune.sh [--importers] [--dry-run-now] [--no-load]"; exit 1 ;;
  esac
done
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEFAULT_HOME="$HOME/.colosseum/hosted-risk"
HOME_DIR="${PRUNE_HOME:-$DEFAULT_HOME}"
HOME_DIR="${HOME_DIR%/}"
NODE_BIN="$(dirname "$(which node)")"
if [ "$HOME_DIR" = "$DEFAULT_HOME" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  if [ "$LOAD" = 0 ]; then
    echo "refusing --no-load at $DEFAULT_HOME: the plist would be loaded at the next login all the same"
    exit 1
  fi
else
  PLIST_DIR="$HOME_DIR/LaunchAgents"
  LOAD=0
  echo "rehearsal: PRUNE_HOME=$HOME_DIR; nothing is loaded"
fi
mkdir -p "$HOME_DIR" "$PLIST_DIR"
[ -f "$HOME_DIR/env" ] || { echo "no env file at $HOME_DIR/env"; exit 1; }
grep -q '^DATABASE_URL=' "$HOME_DIR/env" || { echo "$HOME_DIR/env names no DATABASE_URL"; exit 1; }

ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found under $REPO/node_modules (run pnpm install)"; exit 1; }
bundle() {
  "$ESBUILD" "$REPO/$1" --bundle --platform=node --format=esm --target=node22 \
    --tsconfig="$REPO/tsconfig.json" --outfile="$2" --log-level=warning \
    --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
  "$NODE_BIN/node" --check "$2"
}
stamp="$(date +%Y%m%d-%H%M%S)"
# swap a bundle in, keeping the one that was there
place() {
  local src=$1 name=$2
  bundle "$src" "$HOME_DIR/$name.new.mjs"
  if [ -f "$HOME_DIR/$name.mjs" ]; then
    cp -p "$HOME_DIR/$name.mjs" "$HOME_DIR/$name.before-$stamp.mjs"
    echo "kept $HOME_DIR/$name.before-$stamp.mjs"
  fi
  mv -f "$HOME_DIR/$name.new.mjs" "$HOME_DIR/$name.mjs"
  echo "bundled $HOME_DIR/$name.mjs"
}

if [ "$IMPORTERS" = 1 ]; then
  place scripts/risk/collector/lending-import.ts risk-lending-import
  place scripts/risk-evm/import.ts risk-evm-import
fi
place scripts/ops/prune-risk.ts risk-prune

PLIST="$PLIST_DIR/com.colosseum.risk-prune.plist"
sed -e "s#__HOME_DIR__#$HOME_DIR#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOUR__#5#" -e "s#__MINUTE__#30#" \
  "$REPO/scripts/launchd/com.colosseum.risk-prune.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
if [ "$LOAD" = 1 ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded com.colosseum.risk-prune (daily 05:30) -> $HOME_DIR/risk-prune.mjs; log $HOME_DIR/risk-prune.log"
else
  echo "not loaded: $PLIST"
fi
if [ "$DRY_NOW" = 1 ]; then
  (set -a; . "$HOME_DIR/env"; set +a; "$NODE_BIN/node" "$HOME_DIR/risk-prune.mjs" --dry-run)
fi
