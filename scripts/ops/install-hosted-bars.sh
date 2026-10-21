#!/bin/zsh
# Installs the hosted bars job of Robinhood Chain as the launchd agent com.colosseum.hosted-bars-robinhood, beside
# the hosted collectors in ~/.colosseum/hosted-risk, whose env file names the hosted database (DATABASE_URL). Once a
# day at 05:18 local (an hour after the loop's 04:00 daily rewalk of the swap history, and inside the hourly import's
# window, when the hosted database is awake anyway; a Mac that slept through it runs it on waking) it builds the bars from the loop's swap history (scripts/risk/assets/bars.ts, the held path) and writes
# only what the asset lookups read (--lookups-only, scripts/risk/assets/lookup-rows.ts): the token bars of the last
# 72 hours and, for each token's top five pools by the newest pool_tvl_usd reading, their bars of the last two
# days; it then deletes the pool bars older than that (--drop-old-pool-bars, never a backfill row). The token bars
# are kept 31 days by the daily prune (risk-retention.ts, market_bars).
#
#   install-hosted-bars.sh [--evm-dir <dir>]   bundle, copy the stock list, write the plist, load it. The folder of
#                                    the loop's Robinhood Chain files (history/robinhood, the cut, the universe
#                                    file) defaults to ~/.colosseum/hosted-risk/evm
#   install-hosted-bars.sh --dry-run-now   after installing, one dry run (counts only) against the env file's database
#   install-hosted-bars.sh --fill-now      after installing, one run of the token bars of the last 30 days (720 hours):
#                                    the loop's rewalk goes back about 28 days, so it fills the days between the
#                                    backfill's last (Oct 13) and the daily runs' 72 hours. Once, at the first install
#   install-hosted-bars.sh --no-load       write everything, load nothing (needs HOSTED_HOME, a rehearsal folder)
#
# Solana has no job: no collector keeps its swap history (the held files stopped on 2026-10-06), so its bars on the
# hosted database are what ops:copy-token-bars puts there and age out after 31 days.
#
# HOSTED_HOME names another folder (a rehearsal): the plist goes to $HOSTED_HOME/LaunchAgents and nothing is loaded.
# The job is bundled with its dependencies into one file because launchd agents cannot read ~/Documents; for the same
# reason the stock list (scripts/risk/universe/robinhood.json) and the market calendar are copied beside it. The env file is read by the job
# only; this script checks that it names DATABASE_URL and prints nothing from it.
set -euo pipefail
DRY_NOW=0
FILL_NOW=0
LOAD=1
EVM_DIR=""
usage() { echo "usage: install-hosted-bars.sh [--evm-dir <dir>] [--dry-run-now] [--fill-now] [--no-load]"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run-now) DRY_NOW=1 ;;
    --fill-now) FILL_NOW=1 ;;
    --no-load) LOAD=0 ;;
    --evm-dir) shift; [ $# -gt 0 ] || usage; EVM_DIR="$1" ;;
    *) usage ;;
  esac
  shift
done
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
CHAIN=robinhood
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
    echo "refusing $EVM_DIR: launchd agents cannot read under ~/Documents, ~/Desktop or ~/Downloads"; exit 1 ;;
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
# what the held path reads (scripts/risk/assets/bars-read.ts readRobinhood)
LIST="$REPO/scripts/risk/universe/$CHAIN.json"
CUT="$(node -e 'const l=require(process.argv[1]); process.stdout.write(l.inputs?.cut ?? "")' "$LIST")"
[ -n "$CUT" ] || { echo "$LIST names no cut file (inputs.cut)"; exit 1; }
[ -f "$EVM_DIR/history/$CHAIN/cursor.json" ] || need "no swap history at $EVM_DIR/history/$CHAIN (the loop's rewalk)"
[ -f "$EVM_DIR/$CUT" ] || need "no cut file $CUT in $EVM_DIR"
ls "$EVM_DIR"/universe-$CHAIN-*.json > /dev/null 2>&1 || need "no universe-$CHAIN-*.json in $EVM_DIR"

ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found under $REPO/node_modules (run pnpm install)"; exit 1; }
UNIVERSE="$HOME_DIR/universe"
mkdir -p "$UNIVERSE"
cp "$LIST" "$UNIVERSE/$CHAIN.json"
echo "copied the stock list to $UNIVERSE/$CHAIN.json"
# the market calendar the bars' regime reads; an env file's RISK_HOLIDAYS (the collectors' copy) still wins
HOLIDAYS="$HOME_DIR/us-market-holidays.json"
[ -f "$HOLIDAYS" ] || cp "$REPO/fixtures/risk/us-market-holidays.json" "$HOLIDAYS"
js() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
SETTINGS="process.env.RISK_EVM_DIR ??= $(js "$EVM_DIR"); process.env.RISK_UNIVERSE_DIR ??= $(js "$UNIVERSE"); process.env.RISK_HOLIDAYS ??= $(js "$HOLIDAYS");"
OUT="$HOME_DIR/risk-hosted-bars.mjs"
NEW="$HOME_DIR/risk-hosted-bars.new.mjs"
trap 'rm -f "$NEW"' EXIT
"$ESBUILD" "$REPO/scripts/risk/assets/bars.ts" --bundle --platform=node --format=esm --target=node22 \
  --tsconfig="$REPO/tsconfig.json" --outfile="$NEW" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url); $SETTINGS"
"$NODE_BIN/node" --check "$NEW"
if [ -f "$OUT" ]; then
  BEFORE="$HOME_DIR/risk-hosted-bars.before-$(date +%Y%m%d-%H%M%S).mjs"
  cp -p "$OUT" "$BEFORE"
  echo "kept the bundle that was there: $BEFORE"
fi
mv -f "$NEW" "$OUT"
echo "bundled $OUT ($(du -h "$OUT" | cut -f1))"

PLIST="$PLIST_DIR/com.colosseum.hosted-bars-$CHAIN.plist"
sed -e "s#__HOME_DIR__#$HOME_DIR#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__CHAIN__#$CHAIN#g" \
  -e "s#__HOUR__#5#" -e "s#__MINUTE__#18#" \
  "$REPO/scripts/launchd/com.colosseum.hosted-bars.plist" > "$PLIST"
if grep -q '__[A-Z_]*__' "$PLIST"; then echo "the plist template has a slot this installer does not fill"; exit 1; fi
if command -v plutil > /dev/null; then plutil -lint "$PLIST" > /dev/null; fi
if [ "$LOAD" = 1 ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded com.colosseum.hosted-bars-$CHAIN (daily 05:18); log $HOME_DIR/risk-hosted-bars.log"
else
  echo "not loaded: $PLIST"
fi
# a rehearsal's database is a scratch one on this machine, which the job refuses without --local-rehearsal
REH=()
[ "$REHEARSAL" = 1 ] && REH=(--local-rehearsal)
run_once() {
  [ -f "$HOME_DIR/env" ] || { echo "no env file at $HOME_DIR/env: nothing run"; return 0; }
  (set -a; . "$HOME_DIR/env"; set +a
   cd "$HOME_DIR" && "$NODE_BIN/node" "$OUT" "$CHAIN" --lookups-only "$@" "${REH[@]}")
}
if [ "$DRY_NOW" = 1 ]; then run_once --since-hours 72 --drop-old-pool-bars --dry-run; fi
if [ "$FILL_NOW" = 1 ]; then run_once --since-hours 720; fi
