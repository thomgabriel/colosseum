#!/bin/zsh
# The asset metrics job of one chain (PLAN-ASSETS AS.6, gate ASSET-METRICS) as its own launchd agent. It is called by
# the chain's installer, never alone:
#   scripts/risk/assets/install-job-solana.sh      com.colosseum.assets-solana     minute 44
#   scripts/risk-evm/install-assets-job.sh         com.colosseum.assets-robinhood  minute 38
# Usage (through those): install | COLOSSEUM_HOME=<folder> install --no-load (a rehearsal: bundle and plist under
# <folder>, nothing loaded) | install --hosted (the same job beside the hosted collectors in ~/.colosseum/hosted-risk,
# whose env file names the hosted database, as com.colosseum.hosted-assets-<chain>: it writes the hosted
# asset_observations the asset lookups read in production, at minutes 21 (Solana) and 17 (Robinhood Chain), inside
# the hourly import's window; on Robinhood Chain the discovery file is the hosted loop's, $HOME_DIR/evm, unless
# RISK_EVM_DIR names another folder).
#
# The hosted job (gate ASSET-METRICS, amended 2026-10-22) reads only the rows the asset lookups answer for (the
# shelf, the listed rows and the deploy records' tokens and models: about 100 Solana rows and 46 Robinhood Chain
# rows, not 2,249 and 272; ASSET_METRICS_SCOPE=served), touches the database from about :10 to about :25 UTC
# (ASSET_METRICS_WRITE_WINDOW=10-25, checked once a phase: its slow reads stop 90 s before :25, past :25 it writes
# nothing, and what was not done is done the next hour), reads SOL's supply once a day with the daily metrics, waits up to two minutes for
# the network after a wake and otherwise ends with one line. Its plist sets
# NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000: Neon (Oregon) answers in about 240 ms, near
# Node's 250 ms per address, and connections failed at random without it, as they did in the hosted loop.
#
# It sits beside the collectors and touches none of them, the way the price and raw-arrays jobs were added (gate
# PRICE-JOB): it builds one bundle, writes one plist, and loads that one agent. It reads
# scripts/risk/collector/risk-job.plist as its template and leaves it as it is; it neither writes nor prints the shared
# env file (~/.colosseum/risk/env), and checks only that it exists (and, for Solana, that it names an RPC). launchd
# agents cannot read ~/Documents, so the job is bundled with its dependencies, the chain's asset list
# (scripts/risk/assets/<chain>.json) and the reviewed map (metrics.sources.json) into <home>/risk-assets-<chain>.mjs;
# on Robinhood Chain it also writes an extract of the newest discovery file (RISK_EVM_DIR, read only) beside its
# answers, since the job cannot read that folder either. Run it again after a code change, a new list, a new map or a
# new discovery file.
#
# The job's folder (<home>/asset-metrics: answers per run under <chain>/metrics/, one line per run in runs.jsonl) is
# put inside the bundle: the source has no default, so only an installed bundle knows where to write. Settings taken
# from this command's environment and put in the bundle the same way:
#   ASSET_METRICS_SOLANA_PRICES=none|unresolved   which Solana prices it writes (none by default: PLAN-ASSETS AS.5)
# A line in the env file still wins over the bundle.
#
# Minutes. Hosted: Solana 21, Robinhood Chain 17 (above). Solana, 44: after the price job (14, which reads the prices this job may write), refresh (10), lending
# import (12), split (15), lending facts (20) and the raw arrays (25); between the pool collector's runs of 42 and 47
# and the lending collector's of 41 and 46; its hourly part takes about half a minute. Robinhood Chain, 38: outside
# minutes 1 to 14, when the hourly loop reads the same public RPC (the reader also waits them out).
#
# A rehearsal is any run whose COLOSSEUM_HOME is not ~/.colosseum/risk: nothing is loaded, and the plist goes under
# $COLOSSEUM_HOME/LaunchAgents. A plist left in ~/Library/LaunchAgents is loaded at the next login whether or not this
# script loaded it, so --no-load is refused without a rehearsal folder. Remove a job with:
#   launchctl unload ~/Library/LaunchAgents/com.colosseum.assets-<chain>.plist
#   rm ~/Library/LaunchAgents/com.colosseum.assets-<chain>.plist
set -euo pipefail

CHAIN="${1:-}"
shift || true
case "$CHAIN" in
  solana) MINUTE=44 ;;
  robinhood) MINUTE=38 ;;
  *) echo "the chain's installer calls this: install-job-solana.sh or install-assets-job.sh"; exit 1 ;;
esac
usage() { echo "usage: <installer> [--hosted] | COLOSSEUM_HOME=<folder> <installer> [--hosted] --no-load"; exit 1; }
LOAD=1
HOSTED=0
for a in "$@"; do
  case "$a" in
    --no-load) LOAD=0 ;;
    --hosted) HOSTED=1 ;;
    *) usage ;;
  esac
done

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEFAULT_HOME="$HOME/.colosseum/risk"
if [ "$HOSTED" = 1 ]; then DEFAULT_HOME="$HOME/.colosseum/hosted-risk"; fi
if [ -n "${COLOSSEUM_HOME+x}" ] && [ -z "$COLOSSEUM_HOME" ]; then
  echo "COLOSSEUM_HOME is set and empty: name the rehearsal folder, or unset it for the install"
  exit 1
fi
HOME_DIR="${COLOSSEUM_HOME:-$DEFAULT_HOME}"
HOME_DIR="${HOME_DIR:a}"
NODE_BIN="$(dirname "$(which node)")"
LABEL="com.colosseum.assets-$CHAIN"
if [ "$HOSTED" = 1 ]; then
  LABEL="com.colosseum.hosted-assets-$CHAIN"
  # inside the hourly import's window (about :10 to :25 UTC), when the hosted database is awake anyway: Neon's free
  # compute is the limit that binds (gate SNAPSHOT-IN-API, amended 2026-10-19); Robinhood Chain after minute 14
  case "$CHAIN" in solana) MINUTE=21 ;; robinhood) MINUTE=17 ;; esac
fi
NAME="assets-$CHAIN"

id_of() { stat -f '%d:%i' "$1" 2>/dev/null || stat -c '%d:%i' "$1" 2>/dev/null || true; }
canon() { local p="${1:A}"; echo "${p:l}"; }
same_folder() {
  local a="$(id_of "$1")" b="$(id_of "$2")"
  if [ -n "$a" ] && [ "$a" = "$b" ]; then return 0; fi
  [ "$(canon "$1")" = "$(canon "$2")" ]
}
inside() {
  local p="$1"
  while :; do
    if same_folder "$p" "$2"; then return 0; fi
    if [ "$p" = "${p:h}" ]; then return 1; fi
    p="${p:h}"
  done
}
if same_folder "$HOME_DIR" "$DEFAULT_HOME"; then
  REHEARSAL=0
  HOME_DIR="$DEFAULT_HOME"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  if [ "$LOAD" = 0 ]; then
    echo "refusing --no-load at $DEFAULT_HOME: the plist would be loaded at the next login all the same."
    echo "For a rehearsal, name a folder: COLOSSEUM_HOME=<folder> <installer> --no-load"
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
  echo "rehearsal: COLOSSEUM_HOME=$HOME_DIR is not the default; nothing is loaded"
fi
case "$HOME_DIR$NODE_BIN" in
  *[[:space:]\#\&\\\'\"]*)
    echo "refusing: $HOME_DIR or $NODE_BIN holds a space, a quote, #, & or a backslash, which the plist cannot carry"
    exit 1 ;;
esac

need() {
  if [ "$REHEARSAL" = 1 ]; then echo "rehearsal: $1"; else echo "$1"; exit 1; fi
}
[ -f "$HOME_DIR/env" ] || need "$HOME_DIR/env missing: the collectors are not installed on this machine"
if [ "$HOSTED" = 1 ] && [ -f "$HOME_DIR/env" ] && ! grep -q '^DATABASE_URL=' "$HOME_DIR/env"; then
  need "$HOME_DIR/env names no DATABASE_URL (the hosted database)"
fi
if [ "$CHAIN" = solana ] && [ -f "$HOME_DIR/env" ] && ! grep -q '^SOLANA_RPC_URL=' "$HOME_DIR/env"; then
  need "SOLANA_RPC_URL missing in $HOME_DIR/env (run scripts/risk/collector/install.sh with no argument once)"
fi

ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found under $REPO/node_modules (run pnpm install)"; exit 1; }

# the settings are checked before anything is written
case "${ASSET_METRICS_SOLANA_PRICES:-}" in
  ''|none|unresolved) ;;
  *) echo "refusing: ASSET_METRICS_SOLANA_PRICES is none or unresolved, not $ASSET_METRICS_SOLANA_PRICES (all changes the price job's rows)"; exit 1 ;;
esac
DATA="$HOME_DIR/asset-metrics"
mkdir -p "$DATA" "$PLIST_DIR"
js() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
SETTINGS="process.env.ASSET_METRICS_CHAIN ??= $(js "$CHAIN"); process.env.ASSET_METRICS_DIR ??= $(js "$DATA");"
if [ "$HOSTED" = 1 ]; then
  SETTINGS+=" process.env.ASSET_METRICS_SCOPE ??= 'served'; process.env.ASSET_METRICS_WRITE_WINDOW ??= '10-25';"
  echo "hosted: the rows the asset lookups answer for, written inside minutes 10 to 25 UTC"
fi
echo "the job's folder: $DATA"
if [ "$CHAIN" = robinhood ]; then
  # the job cannot read RISK_EVM_DIR (under ~/Documents): the pools of the newest discovery file go beside it. The
  # hosted job's is the hosted loop's folder, whose collectors read the same discovery
  EVM_DEFAULT="$HOME/Documents/Colosseum-data/risk-evm"
  if [ "$HOSTED" = 1 ]; then EVM_DEFAULT="$HOME_DIR/evm"; fi
  EXTRACT="$DATA/robinhood-discovery.json"
  (cd "$REPO" && RISK_EVM_DIR="${RISK_EVM_DIR:-$EVM_DEFAULT}" \
    "$REPO/node_modules/.bin/tsx" scripts/risk/assets/metrics-extract.ts --out "$EXTRACT")
  SETTINGS+=" process.env.ASSET_METRICS_RH_DISCOVERY ??= $(js "$EXTRACT");"
fi
for key in ASSET_METRICS_SOLANA_PRICES; do
  value="${(P)key:-}"
  if [ -n "$value" ]; then
    SETTINGS+=" process.env.$key ??= $(js "$value");"
    echo "setting put in the bundle: $key=$value"
  fi
done

OUT="$HOME_DIR/risk-$NAME.mjs"
NEW="$HOME_DIR/risk-$NAME.new.mjs"
trap 'rm -f "$NEW"' EXIT
"$ESBUILD" "$REPO/scripts/risk/assets/metrics-job.ts" --bundle --platform=node \
  --format=esm --target=node22 --tsconfig="$REPO/tsconfig.json" --outfile="$NEW" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url); $SETTINGS"
"$NODE_BIN/node" --check "$NEW"
# a bundle can parse and still not start: --plan loads every module, the list and the map, with no network, no
# database and nothing written
(cd / && "$NODE_BIN/node" "$NEW" --plan > /dev/null) || { echo "the new bundle does not start; the old one is left in place"; exit 1; }
echo "the new bundle starts (--plan)"
PLIST="$PLIST_DIR/$LABEL.plist"
NEW_PLIST="$PLIST.new"
trap 'rm -f "$NEW" "$NEW_PLIST"' EXIT
MINUTES="    <dict><key>Minute</key><integer>$MINUTE</integer></dict>\n"
sed -e "s#__LABEL__#$LABEL#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOME_DIR__#$HOME_DIR#g" \
  -e "s#__SCRIPT__#risk-$NAME#g" -e "s#__MINUTES__#$MINUTES#" \
  "$REPO/scripts/risk/collector/risk-job.plist" > "$NEW_PLIST"
if grep -q '__[A-Z_]*__' "$NEW_PLIST"; then echo "the plist template has a slot this installer does not fill"; exit 1; fi
if [ "$HOSTED" = 1 ]; then
  # the template is the collectors' too, so the hosted job's NODE_OPTIONS is added here, not there
  awk '/<key>StandardErrorPath<\/key>/ { print "  <key>EnvironmentVariables</key>"; print "  <dict><key>NODE_OPTIONS</key><string>--network-family-autoselection-attempt-timeout=3000</string></dict>" } { print }' \
    "$NEW_PLIST" > "$NEW_PLIST.env" && mv -f "$NEW_PLIST.env" "$NEW_PLIST"
  grep -q 'network-family-autoselection-attempt-timeout=3000' "$NEW_PLIST" || { echo "the plist did not take NODE_OPTIONS"; exit 1; }
fi
if command -v plutil > /dev/null; then plutil -lint "$NEW_PLIST" > /dev/null || { echo "the new plist is not a plist"; exit 1; }; fi

if [ -f "$OUT" ]; then
  BEFORE="$HOME_DIR/risk-$NAME.before-$(date +%Y%m%d-%H%M%S).mjs"
  cp -p "$OUT" "$BEFORE"
  echo "kept the bundle that was there: $BEFORE"
fi
mv -f "$NEW" "$OUT"
echo "bundled $OUT ($(du -h "$OUT" | cut -f1))"
mv -f "$NEW_PLIST" "$PLIST"
echo "wrote $PLIST"
if [ "$LOAD" = 1 ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $LABEL -> $OUT (minute $MINUTE)"
else
  echo "not loaded: $LABEL (minute $MINUTE)"
fi
echo "answers: $DATA/$CHAIN/metrics/<stamp>.jsonl.gz, one line per run in $DATA/runs.jsonl"
echo "log: $HOME_DIR/risk-$NAME.log"
