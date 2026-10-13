#!/bin/zsh
# Installs the risk-layer collectors as their own launchd agents, separate from the old depth job:
#   com.colosseum.risk-pools   pool snapshots (Step 2), minutes 2,7,...,57
#   com.colosseum.risk-quotes  Jupiter cross-check (Step 3), minutes 4,19,34,49
#   com.colosseum.risk-refresh import into Postgres + recompute curves, minute 10 of every hour
#   com.colosseum.risk-lending lending pools (Step 10b), minutes 1,6,...,56 (one-job mode only: `install.sh lending`)
#   com.colosseum.risk-lending-import lending files into Postgres (Step 10b item 8), minute 12
#                              (one-job mode only: `install.sh lending-import`)
# With no argument, installs pools, quotes and refresh as before. With a job name (`install.sh lending`), builds
# and loads only that job: the running jobs are not reloaded and the shared env file is not rewritten.
# Own directory (~/.colosseum/risk) and env file. Each collector is bundled with its decoders into one
# dependency-free file because launchd agents cannot read ~/Documents. Re-run after code changes.
#
# `install.sh registry <file>` (PLAN-ASSETS AS.12): puts a merged registry (`pnpm risk:registry-merge`: the stock pools
# and the shelf's) in place of <home>/registry.json, with the pools and quotes bundles that read it. It refuses unless
# the installed split bundle (<home>/risk-facts-split.mjs) carries the stock-set filter, and unless the file's stock set
# is the installed registry's, pool for pool. The file is checked first (scripts/risk/registry-check.ts: every pool
# readable by the collector, tier A or B, no address twice); the two
# bundles are built and checked beside the old ones; then the old registry and bundles are kept as *.before-<stamp>,
# the bundles moved in, the registry last. Nothing is loaded or unloaded and no plist is written: launchd starts the
# same agents on the same minutes, and their next run reads the new files. The env file is neither written nor
# printed. Undo: copy <home>/registry.before-<stamp>.json back to <home>/registry.json (the new bundles read a registry
# without shelf pools exactly as the old ones did).
#
# Rehearsal (any mode): COLOSSEUM_HOME=<folder> install.sh … --no-load writes under <folder> only (plists under
# <folder>/LaunchAgents), reads nothing from the repo's .env and loads nothing. A folder inside ~/.colosseum or
# ~/Library is refused. --no-load without a rehearsal folder is refused: a plist left in ~/Library/LaunchAgents is
# loaded at the next login all the same.
set -euo pipefail
ONLY=""
REG_FILE=""
LOAD=1
usage() { echo "usage: install.sh [lending|lending-import|registry <file>] [--no-load]"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --no-load) LOAD=0 ;;
    registry) ONLY=registry; shift; [ $# -gt 0 ] || usage; REG_FILE="$1" ;;
    *) if [ -z "$ONLY" ]; then ONLY="$1"; else usage; fi ;;
  esac
  shift
done
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEFAULT_HOME="$HOME/.colosseum/risk"
if [ -n "${COLOSSEUM_HOME+x}" ] && [ -z "$COLOSSEUM_HOME" ]; then
  echo "COLOSSEUM_HOME is set and empty: name the rehearsal folder, or unset it for the install"
  exit 1
fi
HOME_DIR="${COLOSSEUM_HOME:-$DEFAULT_HOME}"
HOME_DIR="${HOME_DIR:a}"
NODE_BIN="$(dirname "$(which node)")"
# whether $1 is $2 or inside it, links resolved
inside() {
  local p="${1:A}" root="${2:A}"
  [ "$p" = "$root" ] || [ "${p#$root/}" != "$p" ]
}
if [ "${HOME_DIR:A}" = "${DEFAULT_HOME:A}" ]; then
  REHEARSAL=0
  HOME_DIR="$DEFAULT_HOME"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  if [ "$LOAD" = 0 ]; then
    echo "refusing --no-load at $DEFAULT_HOME: the plist would be loaded at the next login all the same."
    echo "For a rehearsal, name a folder: COLOSSEUM_HOME=<folder> install.sh … --no-load"
    exit 1
  fi
else
  REHEARSAL=1
  PLIST_DIR="$HOME_DIR/LaunchAgents"
  LOAD=0
  for live in "$HOME/.colosseum" "$HOME/Library"; do
    if inside "$HOME_DIR" "$live"; then
      echo "refusing: a rehearsal folder inside $live ($HOME_DIR)"
      exit 1
    fi
  done
  echo "rehearsal: COLOSSEUM_HOME=$HOME_DIR is not the default; nothing is loaded and the repo's .env is not read"
fi
mkdir -p "$HOME_DIR" "$PLIST_DIR"
if [ -z "$ONLY" ]; then
  [ -f "$HOME_DIR/registry.json" ] || { echo "run pnpm risk:registry first"; exit 1; }
  if [ "$REHEARSAL" = 0 ]; then
    grep -E '^(SOLANA_RPC_URL|JUPITER_API_KEY)=' "$REPO/.env" > "$HOME_DIR/env" || true
    chmod 600 "$HOME_DIR/env"
  fi
fi
if [ "$REHEARSAL" = 0 ]; then
  grep -q '^SOLANA_RPC_URL=' "$HOME_DIR/env" || { echo "SOLANA_RPC_URL missing in $HOME_DIR/env (run install.sh with no argument once)"; exit 1; }
fi
ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found under $REPO/node_modules (run pnpm install)"; exit 1; }
bundle() {
  "$ESBUILD" "$REPO/scripts/risk/collector/$1.ts" --bundle --platform=node \
    --format=esm --target=node22 --tsconfig="$REPO/tsconfig.json" --outfile="$2" --log-level=warning \
    --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
}
install_job() {
  local name=$1 label=$2; shift 2
  bundle "$name" "$HOME_DIR/risk-$name.mjs"
  local minutes=""
  for m in "$@"; do minutes+="    <dict><key>Minute</key><integer>$m</integer></dict>\n"; done
  local plist="$PLIST_DIR/$label.plist"
  sed -e "s#__LABEL__#$label#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOME_DIR__#$HOME_DIR#g" \
    -e "s#__SCRIPT__#risk-$name#g" -e "s#__MINUTES__#$minutes#" \
    "$REPO/scripts/risk/collector/risk-job.plist" > "$plist"
  if [ "$LOAD" = 1 ]; then
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    echo "loaded $label -> $HOME_DIR/risk-$name.mjs"
  else
    echo "not loaded: $label -> $HOME_DIR/risk-$name.mjs ($plist)"
  fi
}
install_registry() {
  local src="${REG_FILE:a}" stamp name
  [ -f "$src" ] || { echo "no such file: $REG_FILE"; exit 1; }
  # the split snapshot reads the same registry.json: its installed bundle must leave the shelf's pools out first
  # (lib-split.ts splitKeepsTheStockSetOnly), or they would enter its cost-breakdown medians. Read only.
  local split="$HOME_DIR/risk-facts-split.mjs"
  if [ ! -f "$split" ] || ! grep -q 'splitKeepsTheStockSetOnly' "$split"; then
    echo "refusing: $split does not leave the shelf's pools out (built before the stock-set filter, or absent)."
    echo "Install the split job from this code first: scripts/risk/jobs/install.sh facts-split; nothing was changed"
    exit 1
  fi
  # the file's stock set must be the installed registry's, pool for pool: the merge reads data/risk, not the install
  [ -f "$HOME_DIR/registry.json" ] || { echo "refusing: no $HOME_DIR/registry.json to compare the stock set with; nothing was changed"; exit 1; }
  (cd "$REPO" && "$REPO/node_modules/.bin/tsx" scripts/risk/registry-check.ts "$src" --stocks-of "$HOME_DIR/registry.json") \
    || { echo "the registry fails its check; nothing was changed"; exit 1; }
  stamp="$(date +%Y%m%d-%H%M%S)"
  trap 'rm -f "$HOME_DIR/risk-pools.new.mjs" "$HOME_DIR/risk-quotes.new.mjs" "$HOME_DIR/registry.json.new"' EXIT
  for name in pools quotes; do
    bundle "$name" "$HOME_DIR/risk-$name.new.mjs"
    "$NODE_BIN/node" --check "$HOME_DIR/risk-$name.new.mjs"
  done
  cp "$src" "$HOME_DIR/registry.json.new"
  if [ -f "$HOME_DIR/registry.json" ]; then
    cp -p "$HOME_DIR/registry.json" "$HOME_DIR/registry.before-$stamp.json"
    echo "kept the registry that was there: $HOME_DIR/registry.before-$stamp.json"
  fi
  # the bundles first: a new bundle reads the old registry as the old bundle did (it has no shelf pools)
  for name in pools quotes; do
    if [ -f "$HOME_DIR/risk-$name.mjs" ]; then
      cp -p "$HOME_DIR/risk-$name.mjs" "$HOME_DIR/risk-$name.before-$stamp.mjs"
      echo "kept the bundle that was there: $HOME_DIR/risk-$name.before-$stamp.mjs"
    fi
    mv -f "$HOME_DIR/risk-$name.new.mjs" "$HOME_DIR/risk-$name.mjs"
    echo "bundled $HOME_DIR/risk-$name.mjs"
  done
  mv -f "$HOME_DIR/registry.json.new" "$HOME_DIR/registry.json"
  echo "installed $HOME_DIR/registry.json from $src"
  echo "nothing loaded or unloaded: com.colosseum.risk-pools and com.colosseum.risk-quotes read the new files at their next run"
}
if [ -n "$ONLY" ]; then
  case "$ONLY" in
    lending)
      [ -f "$HOME_DIR/lending-registry.json" ] || { echo "run pnpm risk:lending-registry first"; exit 1; }
      install_job lending com.colosseum.risk-lending 1 6 11 16 21 26 31 36 41 46 51 56 ;;
    lending-import)
      [ -f "$HOME_DIR/lending-registry.json" ] || { echo "run pnpm risk:lending-registry first"; exit 1; }
      install_job lending-import com.colosseum.risk-lending-import 12 ;;
    registry) install_registry ;;
    *) echo "unknown job: $ONLY (one-job mode supports: lending, lending-import, registry <file>)"; exit 1 ;;
  esac
  exit 0
fi
install_job pools com.colosseum.risk-pools 2 7 12 17 22 27 32 37 42 47 52 57
install_job quotes com.colosseum.risk-quotes 4 19 34 49
cp "$REPO/fixtures/risk/us-market-holidays.json" "$HOME_DIR/us-market-holidays.json"
if [ "$REHEARSAL" = 0 ]; then
  grep -q "^RISK_HOLIDAYS=" "$HOME_DIR/env" || echo "RISK_HOLIDAYS=$HOME_DIR/us-market-holidays.json" >> "$HOME_DIR/env"
fi
install_job refresh com.colosseum.risk-refresh 10
