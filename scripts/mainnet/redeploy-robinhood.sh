#!/usr/bin/env bash
# The Robinhood Chain mainnet redeploy (gate ROBINHOOD-REDEPLOY), for a person to run. An agent never runs
# this with --send.
#
#   ROBINHOOD_RPC_URL=<node> scripts/mainnet/redeploy-robinhood.sh          dry run: simulates every
#                                                                           transaction, sends nothing
#   ROBINHOOD_RPC_URL=<node> scripts/mainnet/redeploy-robinhood.sh --send   deploys from the deployer
#   ROBINHOOD_RPC_URL=<node> scripts/mainnet/redeploy-robinhood.sh --resume finishes a --send that stopped
#                                                                           halfway, from forge's record
#
# A send is refused while the deploy file holds a value that is still Proposed: the dry run lists them
# as one table, Thom confirms them in chat, and `pnpm ops:redeploy --confirm Thom --on <date>` then
# writes "Confirmed by Thom, <date>" into each note, in a commit of its own.
#
# --send signs with the deployer key: `--account <name>` names a cast keystore (DEPLOYER_ACCOUNT does the
# same); without it forge asks for the key once. Either way the key stays with forge and this script
# never reads it. The deploy file is contracts/script/config/4663.json as committed: the contracts, every
# asset, and the Safe proposed for both keys.
#
# After --send, the script writes the Safe's batch (ROBINHOOD-REDEPLOY.safe-accept.json, two calls:
# acceptAdmin and acceptOwnership) for the Safe's Transaction Builder. Until both owners sign it, the
# deployer still holds the keys: sign it the same hour. Then, read-only:
#   pnpm ops:redeploy --status --rpc-env ROBINHOOD_RPC_URL
#   pnpm ops:mainnet-records --safe <threshold>:<owner,owner>
#   pnpm ops:authority-check --record deployments/robinhood-mainnet.json --rpc-env ROBINHOOD_RPC_URL
# docs/vault/MAINNET-REDEPLOY.md is the whole runbook, Etherscan verification included.
set -euo pipefail

: "${ROBINHOOD_RPC_URL:?set ROBINHOOD_RPC_URL to a Robinhood Chain mainnet node (it is not printed)}"
DEPLOYER=0x04957C813932B659a9DA3B7eA2E320c1073A8938
SEND=0
RESUME=0
ACCOUNT=${DEPLOYER_ACCOUNT:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --send) SEND=1 ;;
    --resume) RESUME=1 ;;
    --account) ACCOUNT=$2; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT/contracts"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
[ "$(cast chain-id --rpc-url "$ROBINHOOD_RPC_URL")" = 4663 ] || { echo "the node is not Robinhood Chain mainnet (4663)"; exit 1; }
[ -z "$(git -C "$ROOT" status --porcelain -- contracts/src contracts/script)" ] ||
  { echo "contracts/src or contracts/script has uncommitted changes: deploy a commit"; exit 1; }
echo "commit $(git -C "$ROOT" rev-parse --short HEAD), deployer $DEPLOYER, Safe $(jq -r .safe.address script/config/4663.json)"

if [ "$SEND" = 0 ] && [ "$RESUME" = 0 ]; then
  forge script script/Deploy.s.sol --rpc-url "$ROBINHOOD_RPC_URL" --sender "$DEPLOYER"
  # What a person confirms before a send: every token whose values are still Proposed, one row each.
  echo
  (cd "$ROOT" && pnpm -s ops:redeploy --proposed)
  echo "dry run: nothing was sent. Run again with --send to deploy."
  exit 0
fi

BROADCAST=broadcast/Deploy.s.sol/4663
# Set by the first --send: from then on this checkout has a redeploy under way or done, and a second
# --send would deploy a second set of contracts. A send that stopped halfway is finished with --resume.
STARTED=$BROADCAST/redeploy-started
if [ "$SEND" = 1 ] && [ -f "$STARTED" ]; then
  echo "a redeploy was already sent from this checkout ($(cat "$STARTED")): finish it with --resume, never a second --send"
  exit 1
fi
if [ "$RESUME" = 1 ] && [ ! -f "$STARTED" ]; then
  echo "no redeploy was sent from this checkout: nothing to resume"
  exit 1
fi

read -r -p "This sends to Robinhood Chain mainnet with real money. Type deploy to go on: " answer
[ "$answer" = deploy ] || { echo "stopped: nothing was sent"; exit 1; }

if [ -n "$ACCOUNT" ]; then
  SIGNER=(--account "$ACCOUNT")
else
  SIGNER=(--interactives 1)
fi
if [ "$SEND" = 1 ]; then
  # The first deploy's record stays: forge would write over run-latest.json. A copy made by an earlier
  # run is never written over.
  mkdir -p "$BROADCAST"
  if [ -f "$BROADCAST/run-latest.json" ] && [ ! -f "$BROADCAST/run-before-redeploy.json" ]; then
    cp "$BROADCAST/run-latest.json" "$BROADCAST/run-before-redeploy.json"
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ >"$STARTED"
  forge script script/Deploy.s.sol --rpc-url "$ROBINHOOD_RPC_URL" --sender "$DEPLOYER" "${SIGNER[@]}" \
    --broadcast --slow
else
  # Sends only what forge's record says is not on chain yet, in the same order, from the same nonces.
  forge script script/Deploy.s.sol --rpc-url "$ROBINHOOD_RPC_URL" --sender "$DEPLOYER" "${SIGNER[@]}" \
    --resume --slow
fi

cd "$ROOT"
pnpm -s ops:redeploy --safe-file .
echo
echo "Next: load ROBINHOOD-REDEPLOY.safe-accept.json into the Safe's Transaction Builder, both owners sign, then"
echo "  pnpm ops:redeploy --status --rpc-env ROBINHOOD_RPC_URL"
