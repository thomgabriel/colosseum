#!/usr/bin/env bash
# Deploys the registry's second logic (gate SHARED-RULES-V2) on Robinhood Chain mainnet, where the CREATE2
# deployer puts it: 0x3200F7b8F56590F41D3F2fD9448F706A04bF3129. A person runs this, never an agent.
#
#   ROBINHOOD_RPC_URL=<node> scripts/mainnet/deploy-registry-v2.sh          a dry run: no key, nothing sent
#   ROBINHOOD_RPC_URL=<node> scripts/mainnet/deploy-registry-v2.sh --send   sends one transaction, signed by
#                                                                           the keystore account in ACCOUNT
#                                                                           (default deployer-rh)
#
# The deploy owns nothing and changes nothing: the registry keeps the first rules until the timelock runs
# the Safe's batch that upgrades it. Any funded key will do; it costs about 3.1M gas (0.00014 ETH at
# 0.045 gwei on 2026-10-14). Run it before the owners sign the schedule, so they can see the code at the
# address the batch names. Running it twice sends nothing the second time.
#
# The script (contracts/script/DeployRegistryV2.s.sol) refuses another chain, and code that does not give
# the address the batch names; after the deploy it checks the logic answers as the second rules, is a UUPS
# logic and cannot be initialised. The node's URL is never printed.
set -euo pipefail

: "${ROBINHOOD_RPC_URL:?set ROBINHOOD_RPC_URL to a Robinhood Chain mainnet node (it is not printed)}"
ACCOUNT=${ACCOUNT:-deployer-rh}
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
cd "$(dirname "$0")/../../contracts"

if [ "${1:-}" != "--send" ]; then
  forge script script/DeployRegistryV2.s.sol --rpc-url "$ROBINHOOD_RPC_URL" \
    --sender 0x04957C813932B659a9DA3B7eA2E320c1073A8938
  echo "dry run: nothing was sent. Add --send to deploy, signed by the keystore account $ACCOUNT."
  exit 0
fi

read -r -p "Deploy the registry's second logic on Robinhood Chain mainnet, signed by $ACCOUNT? Type deploy: " answer
[ "$answer" = deploy ] || { echo "not sent"; exit 1; }
forge script script/DeployRegistryV2.s.sol --rpc-url "$ROBINHOOD_RPC_URL" \
  --account "$ACCOUNT" --broadcast --slow
echo "Record the transaction hash and https://robin.etherscan.io/address/0x3200F7b8F56590F41D3F2fD9448F706A04bF3129 in docs/vault/STATE-VAULT.md."
