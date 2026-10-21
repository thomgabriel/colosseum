#!/bin/zsh
# Installs a hosted bars job (gate HOURLY-BARS, Rodrigo 2026-10-21) as a launchd agent beside the hosted collectors in
# ~/.colosseum/hosted-risk, whose env file names the hosted database (DATABASE_URL). Each runs every hour inside the
# hourly import's window (the import at :10, so the hosted database is awake anyway, SNAPSHOT-IN-API amended; a Mac
# that slept through a run runs it on waking) and writes only what the asset lookups read:
#
#   robinhood (the default)  com.colosseum.hosted-bars-robinhood, minute 18. It walks the Swap events of the cut's pools
#       since its last run on the chain's public endpoint into its own folder, $HOME_DIR/bars-walk/robinhood (about
#       the last 30 hours; scripts/risk-evm/recent-walk.ts; the loop's history/ folder is never read or written), builds
#       the bars from it (scripts/risk/assets/bars.ts --walk, the held path, bars-0.1) and writes the complete hours no
#       earlier run wrote (--lookups-only, scripts/risk/assets/lookup-rows.ts): the token bars and, for each token's
#       top five pools by the newest pool_tvl_usd reading, their bars; it then deletes the pool bars older than two days
#       (--drop-old-pool-bars, never a backfill row). After the run at HH:18 the newest bar is hour HH-1. Measured on
#       Oct 21: one hour of the chain is about 40,000 blocks, 25,000 swaps, 16 RPC calls in 5 requests, 7 s; the first
#       run walks 30 hours (a few minutes); the folder holds up to about 600 MB (whole days are deleted).
#   solana  com.colosseum.hosted-bars-solana, minute 19. It builds the token bars of the last six complete hours from
#       the pool collector's mid prices in the same database (scripts/risk/assets/mid-bars.ts, mids-0.1: one USDC pool
#       an hour, the deepest; prices only, no volume) and writes them over its own rows of those hours. No RPC, no file.
#
# The token bars are kept 31 days by the daily prune (risk-retention.ts, market_bars).
#
#   install-hosted-bars.sh [robinhood] [--evm-dir <dir>]   bundle, copy the stock list, write the plist, load it. The
#                                    folder of the loop's Robinhood Chain files (the cut, the universe file, and for
#                                    --fill-now history/robinhood) defaults to ~/.colosseum/hosted-risk/evm
#   install-hosted-bars.sh solana    the same for Solana's job (it reads nothing but the env file)
#   --dry-run-now   after installing, one dry run (counts only) against the env file's database; Robinhood Chain's walks
#                   the chain into its own folder all the same
#   --fill-now      after installing, one run over the days the hourly job does not reach. Robinhood Chain: the token
#                   bars of the last 30 days (720 hours) from the loop's rewalk (it goes back about 28 days), so the
#                   days between the backfill's last (Oct 13) and the hourly job's first are written too. Solana: the
#                   mids of the last 96 hours (the four days the database keeps of pool snapshots). Once, at the install
#   --fill-from-files [dir]   solana only, after --fill-now: once, the mids of the hours between the copied backfill's
#                   last bar (Oct 15) and the first snapshot the database keeps, read from the collector's own day
#                   files (default $HOME_DIR/pools; scripts/risk/assets/mid-bars.ts --fill-from-files), the same rule.
#                   With --dry-run-now it is a dry run (counts only)
#   --no-load       write everything, load nothing (needs HOSTED_HOME, a rehearsal folder)
#
# HOSTED_HOME names another folder (a rehearsal): the plist goes to $HOSTED_HOME/LaunchAgents and nothing is loaded.
# The job is bundled with its dependencies into one file because launchd agents cannot read ~/Documents; for the same
# reason the stock list (scripts/risk/universe/robinhood.json) and the market calendar are copied beside it. The env
# file is read by the job only; this script checks that it names DATABASE_URL and prints nothing from it.
set -euo pipefail
DRY_NOW=0
FILL_NOW=0
LOAD=1
EVM_DIR=""
CHAIN=robinhood
FILES_NOW=0
FILES_DIR=""
usage() { echo "usage: install-hosted-bars.sh [robinhood|solana] [--evm-dir <dir>] [--dry-run-now] [--fill-now] [--fill-from-files [dir]] [--no-load]"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --fill-from-files) FILES_NOW=1
      if [ $# -gt 1 ] && [ "${2#-}" = "$2" ] && [ "$2" != robinhood ] && [ "$2" != solana ]; then shift; FILES_DIR="$1"; fi ;;
    robinhood|solana) CHAIN="$1" ;;
    --dry-run-now) DRY_NOW=1 ;;
    --fill-now) FILL_NOW=1 ;;
    --no-load) LOAD=0 ;;
    --evm-dir) shift; [ $# -gt 0 ] || usage; EVM_DIR="$1" ;;
    *) usage ;;
  esac
  shift
done
[ "$CHAIN" = solana ] && [ -n "$EVM_DIR" ] && { echo "--evm-dir is for robinhood: the Solana job reads no file"; exit 1; }
[ "$CHAIN" = robinhood ] && [ "$FILES_NOW" = 1 ] && { echo "--fill-from-files is for solana"; exit 1; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEFAULT_HOME="$HOME/.colosseum/hosted-risk"
if [ -n "${HOSTED_HOME+x}" ] && [ -z "$HOSTED_HOME" ]; then
  echo "HOSTED_HOME is set and empty: name the rehearsal folder, or unset it for the install"; exit 1
fi
HOME_DIR="${HOSTED_HOME:-$DEFAULT_HOME}"
HOME_DIR="${HOME_DIR%/}"
HOME_DIR="${HOME_DIR:a}"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
NODE_BIN="$(dirname "$NODE")"
if [ "$HOME_DIR" = "$DEFAULT_HOME" ]; then
  REHEARSAL=0
  PLIST_DIR="$HOME/Library/LaunchAgents"
  if [ "$LOAD" = 0 ]; then
    echo "refusing --no-load at $DEFAULT_HOME: the plist would be loaded at the next login all the same"
    exit 1
  fi
else
  REHEARSAL=1
  PLIST_DIR="$HOME_DIR/LaunchAgents"
  LOAD=0
  echo "rehearsal: HOSTED_HOME=$HOME_DIR; nothing is loaded"
fi
EVM_DIR="${EVM_DIR:-$HOME_DIR/evm}"
EVM_DIR="${EVM_DIR:a}"
case "$EVM_DIR" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
    [ "$CHAIN" = robinhood ] && { echo "refusing $EVM_DIR: launchd agents cannot read under ~/Documents, ~/Desktop or ~/Downloads"; exit 1; } ;;
esac
case "$HOME_DIR$NODE_BIN$EVM_DIR" in
  *[[:space:]\#\&\\\'\"]*)
    echo "refusing: a folder holds a space, a quote, #, & or a backslash, which the plist cannot carry"; exit 1 ;;
esac
need() {
  if [ "$REHEARSAL" = 1 ]; then echo "rehearsal: $1"; else echo "$1"; exit 1; fi
}
mkdir -p "$HOME_DIR" "$PLIST_DIR"
[ -f "$HOME_DIR/env" ] || need "no env file at $HOME_DIR/env"
if [ -f "$HOME_DIR/env" ] && ! grep -q '^DATABASE_URL=' "$HOME_DIR/env"; then
  need "$HOME_DIR/env names no DATABASE_URL"
fi

ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found under $REPO/node_modules (run pnpm install)"; exit 1; }
js() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

if [ "$CHAIN" = robinhood ]; then
  # what the held path reads (scripts/risk/assets/bars-read.ts readRobinhood): the cut and the universe file for
  # the hourly walk, and the loop's swap history for --fill-now
  LIST="$REPO/scripts/risk/universe/$CHAIN.json"
  CUT="$(node -e 'const l=require(process.argv[1]); process.stdout.write(l.inputs?.cut ?? "")' "$LIST")"
  [ -n "$CUT" ] || { echo "$LIST names no cut file (inputs.cut)"; exit 1; }
  [ -f "$EVM_DIR/$CUT" ] || need "no cut file $CUT in $EVM_DIR"
  ls "$EVM_DIR"/universe-$CHAIN-*.json > /dev/null 2>&1 || need "no universe-$CHAIN-*.json in $EVM_DIR"
  if [ "$FILL_NOW" = 1 ]; then
    [ -f "$EVM_DIR/history/$CHAIN/cursor.json" ] || need "no swap history at $EVM_DIR/history/$CHAIN (the loop's rewalk), which --fill-now reads"
  fi
  UNIVERSE="$HOME_DIR/universe"
  mkdir -p "$UNIVERSE"
  cp "$LIST" "$UNIVERSE/$CHAIN.json"
  echo "copied the stock list to $UNIVERSE/$CHAIN.json"
  # the market calendar the bars' regime reads; an env file's RISK_HOLIDAYS (the collectors' copy) still wins
  HOLIDAYS="$HOME_DIR/us-market-holidays.json"
  [ -f "$HOLIDAYS" ] || cp "$REPO/fixtures/risk/us-market-holidays.json" "$HOLIDAYS"
  SETTINGS="process.env.RISK_EVM_DIR ??= $(js "$EVM_DIR"); process.env.RISK_UNIVERSE_DIR ??= $(js "$UNIVERSE"); process.env.RISK_HOLIDAYS ??= $(js "$HOLIDAYS");"
  SRC="$REPO/scripts/risk/assets/bars.ts"
  BUNDLE=risk-hosted-bars
  WALK="$HOME_DIR/bars-walk/$CHAIN"
  mkdir -p "$WALK"
  ARGS="$CHAIN --lookups-only --walk $WALK --drop-old-pool-bars --write-by-minute 25"
  MINUTE=18
else
  SETTINGS=""
  SRC="$REPO/scripts/risk/assets/mid-bars.ts"
  BUNDLE=risk-hosted-mid-bars
  ARGS="--since-hours 6"
  MINUTE=19
fi
LOG="$HOME_DIR/risk-hosted-bars-$CHAIN.log"

OUT="$HOME_DIR/$BUNDLE.mjs"
NEW="$HOME_DIR/$BUNDLE.new.mjs"
trap 'rm -f "$NEW"' EXIT
"$ESBUILD" "$SRC" --bundle --platform=node --format=esm --target=node22 \
  --tsconfig="$REPO/tsconfig.json" --outfile="$NEW" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url); $SETTINGS"
"$NODE_BIN/node" --check "$NEW"
if [ -f "$OUT" ]; then
  BEFORE="$HOME_DIR/$BUNDLE.before-$(date +%Y%m%d-%H%M%S).mjs"
  cp -p "$OUT" "$BEFORE"
  echo "kept the bundle that was there: $BEFORE"
fi
mv -f "$NEW" "$OUT"
echo "bundled $OUT ($(du -h "$OUT" | cut -f1))"

PLIST="$PLIST_DIR/com.colosseum.hosted-bars-$CHAIN.plist"
sed -e "s#__HOME_DIR__#$HOME_DIR#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__CHAIN__#$CHAIN#g" \
  -e "s#__BUNDLE__#$BUNDLE#g" -e "s#__ARGS__#$ARGS#g" -e "s#__LOG__#$LOG#g" -e "s#__MINUTE__#$MINUTE#" \
  "$REPO/scripts/launchd/com.colosseum.hosted-bars.plist" > "$PLIST"
if grep -q '__[A-Z_]*__' "$PLIST"; then echo "the plist template has a slot this installer does not fill"; exit 1; fi
if command -v plutil > /dev/null; then plutil -lint "$PLIST" > /dev/null; fi
if [ "$LOAD" = 1 ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded com.colosseum.hosted-bars-$CHAIN (every hour at minute $MINUTE); log $LOG"
else
  echo "not loaded: $PLIST"
fi
# a rehearsal's database is a scratch one on this machine, which the Robinhood Chain job refuses without
# --local-rehearsal (the Solana job deletes nothing and empties nothing, and takes no such flag)
REH=()
[ "$REHEARSAL" = 1 ] && [ "$CHAIN" = robinhood ] && REH=(--local-rehearsal)
run_once() {
  [ -f "$HOME_DIR/env" ] || { echo "no env file at $HOME_DIR/env: nothing run"; return 0; }
  (set -a; . "$HOME_DIR/env"; set +a
   cd "$HOME_DIR" && "$NODE_BIN/node" "$OUT" "$@" "${REH[@]}")
}
if [ "$CHAIN" = robinhood ]; then
  if [ "$DRY_NOW" = 1 ]; then run_once $CHAIN --lookups-only --walk "$WALK" --drop-old-pool-bars --dry-run; fi
  if [ "$FILL_NOW" = 1 ]; then run_once $CHAIN --lookups-only --since-hours 720; fi
else
  if [ "$DRY_NOW" = 1 ]; then run_once --since-hours 6 --dry-run; fi
  if [ "$FILL_NOW" = 1 ]; then run_once --since-hours 96; fi
  # after the snapshots' 96 hours, so the hour the database's first snapshot cuts short comes from the files
  if [ "$FILES_NOW" = 1 ]; then
    DRY=()
    [ "$DRY_NOW" = 1 ] && DRY=(--dry-run)
    run_once --fill-from-files "${FILES_DIR:-$HOME_DIR/pools}" "${DRY[@]}"
  fi
fi
