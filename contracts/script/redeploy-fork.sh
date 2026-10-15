#!/usr/bin/env bash
# The Robinhood Chain redeploy (gate ROBINHOOD-REDEPLOY) rehearsed on a local copy of mainnet, step for step
# as a person runs it. Nothing reaches the real chain: anvil forks it, and every transaction goes to that
# copy, signed by anvil for the impersonated deployer and the impersonated Safe. No key is used.
#
#   ROBINHOOD_RPC_URL=<node> contracts/script/redeploy-fork.sh [out dir]
#
# In order: the deploy script broadcasts script/config/4663.json from Thom's deployer address; the Safe's
# batch is written from that broadcast (pnpm ops:redeploy --safe-file) and the Safe sends its two calls;
# the hand-over is read back (ops:redeploy --status, then Deploy.check()); the two records are written from
# the broadcast into the out dir (ops:mainnet-records), never over the committed ones; and the authority
# check reads the copy against that record. The node's URL is never printed. A broadcast of a real deploy
# already in contracts/broadcast is moved aside for the run and put back after it.
set -euo pipefail

: "${ROBINHOOD_RPC_URL:?set ROBINHOOD_RPC_URL to a Robinhood Chain mainnet node (it is not printed)}"
PORT=${ANVIL_PORT:-8548}
LOCAL=http://127.0.0.1:$PORT
DEPLOYER=0x04957C813932B659a9DA3B7eA2E320c1073A8938
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

cd "$(dirname "$0")/.."
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
SAFE=$(jq -r '.safe.address' script/config/4663.json)
BROADCAST=broadcast/Deploy.s.sol/4663
KEPT="$OUT/kept-broadcast"

anvil --fork-url "$ROBINHOOD_RPC_URL" --port "$PORT" --silent >/dev/null 2>&1 &
ANVIL=$!
# The values Thom has still to confirm are taken as confirmed for the rehearsal, in a copy: the committed
# file is refused for a send until he has (Deploy.s.sol, checkMainnet).
REHEARSED=script/config/.rehearsal/4663.json
mkdir -p "$(dirname "$REHEARSED")"
cp script/config/4663.json "$REHEARSED"
(cd .. && pnpm -s ops:redeploy --config "contracts/$REHEARSED" --confirm "the rehearsal" --on "$(date -u +%Y-%m-%d)" >/dev/null)
export DEPLOY_CONFIG=$REHEARSED
restore() {
  rm -rf "$(dirname "$REHEARSED")"
  kill "$ANVIL" 2>/dev/null || true
  if [ -d "$KEPT" ]; then rm -rf "$BROADCAST" && mkdir -p "$(dirname "$BROADCAST")" && mv "$KEPT" "$BROADCAST"; fi
}
trap restore EXIT
for _ in $(seq 1 60); do
  cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1 && break
  sleep 1
done
echo "fork: block $(cast block-number --rpc-url "$LOCAL") of chain $(cast chain-id --rpc-url "$LOCAL"); out: $OUT"
[ -d "$BROADCAST" ] && mv "$BROADCAST" "$KEPT"

# 0. While a value of the committed file is Proposed, a send of it is refused before anything is sent.
cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$LOCAL" >/dev/null
cast rpc anvil_setBalance "$DEPLOYER" 0xde0b6b3a7640000 --rpc-url "$LOCAL" >/dev/null
if grep -q '": "Proposed' script/config/4663.json; then
  NONCE=$(cast nonce "$DEPLOYER" --rpc-url "$LOCAL")
  if DEPLOY_CONFIG=script/config/4663.json forge script script/Deploy.s.sol --rpc-url "$LOCAL" --broadcast \
    --unlocked --sender "$DEPLOYER" >"$OUT/proposed.log" 2>&1; then
    echo "FAIL: a send of a file with Proposed values went through"; exit 1
  fi
  grep -q 'Proposed value' "$OUT/proposed.log" || { tail -5 "$OUT/proposed.log"; echo "FAIL: refused for another reason"; exit 1; }
  [ "$(cast nonce "$DEPLOYER" --rpc-url "$LOCAL")" = "$NONCE" ] || { echo "FAIL: something was sent"; exit 1; }
  rm -rf "$BROADCAST"
  echo "ok: a send of the committed file is refused while it holds Proposed values; nothing was sent"
fi

# 1. The deploy, as Thom sends it once the values are confirmed: from his deployer's address.
forge script script/Deploy.s.sol --rpc-url "$LOCAL" --broadcast --unlocked --sender "$DEPLOYER" --slow \
  >"$OUT/deploy.log" 2>&1 || { tail -30 "$OUT/deploy.log"; echo "FAIL: the deploy"; exit 1; }
cp "$BROADCAST/run-latest.json" "$OUT/run-latest.json"
grep -E '^  (transactions|factory \(proxy\)|registry \(proxy\)|beacon|proposed for both)' "$OUT/deploy.log"
echo "ok: deployed, $(jq '.transactions | length' "$OUT/run-latest.json") transactions, each with a receipt"

# 2. The Safe's batch, written from the broadcast, and sent as the Safe.
(cd .. && pnpm -s ops:redeploy --safe-file "$OUT" --broadcast "$OUT/run-latest.json")
FILE="$OUT/ROBINHOOD-REDEPLOY.safe-accept.json"
[ "$(jq -r '.transactions | length' "$FILE")" = 2 ] || { echo "FAIL: the Safe's batch is not two calls"; exit 1; }
FACTORY=$(jq -r '.transactions[0].to' "$FILE")
cast rpc anvil_impersonateAccount "$SAFE" --rpc-url "$LOCAL" >/dev/null
cast rpc anvil_setBalance "$SAFE" 0xde0b6b3a7640000 --rpc-url "$LOCAL" >/dev/null
for i in 0 1; do
  to=$(jq -r ".transactions[$i].to" "$FILE")
  data=$(jq -r ".transactions[$i].data" "$FILE")
  status=$(cast send --unlocked --from "$SAFE" "$to" "$data" --rpc-url "$LOCAL" --json | jq -r .status)
  [ "$status" = 0x1 ] || { echo "FAIL: the Safe's call $i reverted"; exit 1; }
done
echo "ok: the Safe sent its batch"
(cd .. && FORK_RPC_URL="$LOCAL" pnpm -s ops:redeploy --status --rpc-env FORK_RPC_URL --broadcast "$OUT/run-latest.json")

# 3. Everything where the file says.
FACTORY="$FACTORY" forge script script/Deploy.s.sol --sig "check()" --rpc-url "$LOCAL" >"$OUT/check.log" 2>&1 ||
  { tail -20 "$OUT/check.log"; echo "FAIL: Deploy.check() reverted"; exit 1; }
grep -E 'checked|factory:|assets listed' "$OUT/check.log"

# 4. The two records, written from the broadcast into the out dir, and the authority check against them.
THRESHOLD=$(cast call "$SAFE" 'getThreshold()(uint256)' --rpc-url "$LOCAL" | awk '{print $1}')
OWNERS=$(cast call "$SAFE" 'getOwners()(address[])' --rpc-url "$LOCAL" | tr -d '[] ')
cp ../packages/sdk/deployments/mainnet.json "$OUT/guard.json"
(cd .. && pnpm -s ops:mainnet-records --broadcast "$OUT/run-latest.json" --record "$OUT/record.json" \
  --guard "$OUT/guard.json" --safe "$THRESHOLD:$OWNERS" | grep -vE '^(> |\$ )' | tail -8)
(cd .. && pnpm -s ops:authority-check --record "$OUT/record.json" --rpc "$LOCAL") >"$OUT/authority.log" 2>&1 ||
  true
grep -E 'Safe is the admin|safe |factory.admin|beacon.owner|registry|^FAIL|^WARN|VERDICT' "$OUT/authority.log" || true
grep -q '^VERDICT: OK' "$OUT/authority.log" || { echo "FAIL: the authority check did not answer OK"; exit 1; }
echo "ok: the rehearsal passed"
