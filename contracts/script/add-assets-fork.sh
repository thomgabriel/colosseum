#!/usr/bin/env bash
# The Safe's two transactions that list more tokens (script/AddAssets.s.sol), rehearsed on a local copy of
# Robinhood Chain mainnet. Nothing reaches the real chain: anvil forks it and every transaction here goes to
# that copy, sent as the Safe through anvil's impersonation. No key is used.
#
#   ROBINHOOD_RPC_URL=<node> contracts/script/add-assets-fork.sh <schedule.json> <execute.json>
#
# The two files are the ones the Safe app's Transaction Builder imports (pnpm ops:add-assets --safe-files),
# so what is rehearsed is the bytes the owners sign. In order: the files' call data is the script's own; the
# Safe schedules; executing early fails; 48 hours pass; the Safe executes; the authority check reads the
# copy against the deploy record; and AddAssets.check() finds every token listed as the file says and has a
# vault trade each one in its own pool within the bound to its feed; and the status the promotion reads. The
# node's URL is never printed.
set -euo pipefail

: "${ROBINHOOD_RPC_URL:?set ROBINHOOD_RPC_URL to a Robinhood Chain mainnet node (it is not printed)}"
SCHEDULE=${1:?the schedule file}
EXECUTE=${2:?the execute file}
SCHEDULE=$(cd "$(dirname "$SCHEDULE")" && pwd)/$(basename "$SCHEDULE")
EXECUTE=$(cd "$(dirname "$EXECUTE")" && pwd)/$(basename "$EXECUTE")
PORT=${ANVIL_PORT:-8547}
LOCAL=http://127.0.0.1:$PORT
SAFE=0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

cd "$(dirname "$0")/.."

anvil --fork-url "$ROBINHOOD_RPC_URL" --port "$PORT" --silent >/dev/null 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1 && break
  sleep 1
done
echo "fork: block $(cast block-number --rpc-url "$LOCAL") of chain $(cast chain-id --rpc-url "$LOCAL")"

field() { jq -r ".transactions[0].$2" "$1"; }
for f in "$SCHEDULE" "$EXECUTE"; do
  [ "$(jq -r '.transactions | length' "$f")" = 1 ] || { echo "FAIL: $f holds more than one transaction"; exit 1; }
  [ "$(field "$f" value)" = 0 ] || { echo "FAIL: $f sends value"; exit 1; }
done
TIMELOCK=$(field "$SCHEDULE" to)
[ "$(field "$EXECUTE" to)" = "$TIMELOCK" ] || { echo "FAIL: the two files call different contracts"; exit 1; }

# 1. The files carry exactly the call data the script builds from the committed file.
printed=$(forge script script/AddAssets.s.sol --rpc-url "$LOCAL" 2>&1) || { echo "$printed" | tail -20; exit 1; }
want=$(echo "$printed" | grep -A1 -E '^ +(1|2)\. ' | grep -oE '0x[0-9a-f]{64}' | head -2)
got=$(printf '%s\n%s\n' "$(cast keccak "$(field "$SCHEDULE" data)")" "$(cast keccak "$(field "$EXECUTE" data)")")
[ "$want" = "$got" ] || { echo "FAIL: the files' call data is not the script's"; exit 1; }
echo "ok: both files carry the script's call data"

cast rpc anvil_impersonateAccount "$SAFE" --rpc-url "$LOCAL" >/dev/null
cast rpc anvil_setBalance "$SAFE" 0xde0b6b3a7640000 --rpc-url "$LOCAL" >/dev/null
send() { cast send --unlocked --from "$SAFE" "$TIMELOCK" "$(field "$1" data)" --rpc-url "$LOCAL" --json | jq -r .status; }

# 2. The Safe schedules.
[ "$(send "$SCHEDULE")" = 0x1 ] || { echo "FAIL: the schedule reverted"; exit 1; }
echo "ok: scheduled"

# 3. It cannot run before the delay.
if cast call --from "$SAFE" "$TIMELOCK" "$(field "$EXECUTE" data)" --rpc-url "$LOCAL" >/dev/null 2>&1; then
  echo "FAIL: the batch would run before the delay"; exit 1
fi
echo "ok: executing now is refused"

# 4. Forty-eight hours later, the Safe executes.
DELAY=$(cast call "$TIMELOCK" 'getMinDelay()(uint256)' --rpc-url "$LOCAL" | awk '{print $1}')
cast rpc evm_increaseTime "$DELAY" --rpc-url "$LOCAL" >/dev/null
cast rpc evm_mine --rpc-url "$LOCAL" >/dev/null
[ "$(send "$EXECUTE")" = 0x1 ] || { echo "FAIL: the execute reverted"; exit 1; }
echo "ok: executed after $DELAY s"

# 5. Who holds what, against the record, on the copy.
(cd .. && pnpm -s ops:authority-check --record deployments/robinhood-mainnet.json --rpc "$LOCAL") |
  grep -E 'factory.assets|pending operation|^FAIL|^WARN|VERDICT|^  - '

# 6. Every token listed as the file says, and traded within the bound.
forge script script/AddAssets.s.sol --sig "check()" --rpc-url "$LOCAL" 2>&1 | grep -vE '^(Warning|Script ran|== Logs|$)' | tail -40

# 7. What `pnpm ops:add-assets --promote` would move into the record once this is the real chain.
(cd .. && FORK_RPC_URL="$LOCAL" pnpm -s ops:add-assets --status --rpc-env FORK_RPC_URL)
