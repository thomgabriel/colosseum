# Robinhood Chain mainnet: the redeploy (gate ROBINHOOD-REDEPLOY)

New contracts on Robinhood Chain mainnet (4663), held by the team's 2-of-2 Safe `0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc` directly, with no timelock. The registry runs the second rules (`SHARED-RULES-V2`) from its first block, and the 27 tokens of `WIDER-LIST-B` are listed at deploy. Every step that sends a transaction is a person's. The contracts of 2026-10-12 ([`MAINNET-DEPLOY.md`](MAINNET-DEPLOY.md)) are not touched.

## What is deployed

`contracts/script/config/4663.json` as committed:

- the vault logic, the beacon, the factory and the registry (both UUPS proxies), as on 2026-10-12;
- the cash token USDG and 26 tokens: the nine of 2026-10-12 with their confirmed values, the twelve of `WIDER-LIST`, and QQQ, MU, AMD, INTC and SLV with a Uniswap v3 pool (`v3Pool`);
- the guardian `0x0a1c…4cc98`, no keeper, no deposit cap, the Universal Router, the publish delay of 48 hours;
- the Safe proposed for the factory's admin and the beacon's owner. No `TimelockController`.

The app shows 19 of the 26 tokens. DELL and SGOV are listed and held back until their pools meet the bar again; the v3 five wait for the app to build a v3 route. The record keeps all seven under `hidden`, with the reason, and the guard's file does not list them.

## The steps

Every command runs from the repository root, with `ROBINHOOD_RPC_URL` set to a Robinhood Chain mainnet node. The scripts never print it.

1. **Dry run.** `scripts/mainnet/redeploy-robinhood.sh`. It simulates all 54 transactions from the deployer `0x0495…8A938`, prints the Safe's owners and threshold as the chain answers them (compare them with the people who hold them) and sends nothing. On 2026-10-14: about 23.4M gas, 0.001 ETH at 0.043 gwei.
2. **Thom confirms the new tokens' values** (done 2026-10-15: "overall follow the recommendations", relayed by the orchestrator; the notes say "Confirmed by Thom, 2026-10-15"). The dry run ends with one table of the 17 tokens whose values are still Proposed (the twelve of `WIDER-LIST` and the v3 five): each one's ceiling, largest trade, feed, pool, average pool and whether the app shows it (`pnpm ops:redeploy --proposed` prints it again). A send is refused while any value is Proposed (`checkMainnet`); a dry run is not. Thom confirms them in chat, and the agent then runs `pnpm ops:redeploy --confirm Thom --on <date>`, which turns each note into "Confirmed by Thom, <date>, as proposed <date>" and changes no value, formats the file with biome, and commits it on its own. Then the dry run again: no table, and no "NOT CONFIRMED" line.
3. **Deploy.** `scripts/mainnet/redeploy-robinhood.sh --send` (add `--account <keystore>` to sign from a cast keystore; without it forge asks for the key once). Type `deploy` to go on. The script keeps the first deploy's broadcast as `run-before-redeploy.json`, then writes `ROBINHOOD-REDEPLOY.safe-accept.json`.
4. **The Safe takes both keys, the same hour.** Load `ROBINHOOD-REDEPLOY.safe-accept.json` in the Safe's Transaction Builder: two calls, `acceptAdmin()` on the factory and `acceptOwnership()` on the beacon. Both owners sign. Until then the deployer still holds the admin.
5. **Read it back.** `pnpm ops:redeploy --status --rpc-env ROBINHOOD_RPC_URL` says the Safe holds both. `FACTORY=<factory> forge script script/Deploy.s.sol --sig "check()" --rpc-url $ROBINHOOD_RPC_URL` (from `contracts/`) checks the registry, the roles and every asset against the file.
6. **Write the records.** `pnpm ops:mainnet-records --safe 2:0x0a1c3312c808b23D019bF241028f6B5624f4cc98,0xAC3cBBCd6e51dBFAf4e79d5E8Cf54a1622D71e0e` writes `deployments/robinhood-mainnet.json` and `packages/sdk/deployments/mainnet.json` from the broadcast and regenerates the guard's tables. In the same commit set `TRUST_STATUS.mainnet.robinhood.delayHours` to 0 and a new `textVersion` in `packages/schemas/src/trust.ts`: `trust.test.ts` fails until both are done, so the notice says the Safe changes things at once.
7. **Authority check.** `pnpm ops:authority-check --record deployments/robinhood-mainnet.json --rpc-env ROBINHOOD_RPC_URL` must end `VERDICT: OK`.
8. **Verify the sources on Etherscan** (below), then merge the records commit into `staging` and deploy the API (Render `tenonfi-api`, a person's click). The API and the snapshot worker read the addresses from the record; no environment variable names them.

## A send that stops halfway

The deploy is 54 transactions, sent one after another (`--slow`). If the run stops before the last (the node drops, the terminal closes, a transaction is not mined), never run `--send` again: it would deploy a second set of contracts, and the first would stay with the deployer as its admin. The script refuses a second `--send` from the same checkout once one has broadcast a transaction (a send refused before it broadcast, for a Proposed value, leaves no mark and may be run again). Run `scripts/mainnet/redeploy-robinhood.sh --resume` (with the same `--account`): forge reads its record of the run (`contracts/broadcast/Deploy.s.sol/4663/run-latest.json`) and sends only the transactions not yet on chain, from the same nonces, in the same order. `--resume` itself refuses a record older than this send (the deploy of 2026-10-12's) and one in which a transaction reverted. A transaction that reverted is never sent again as it was: stop, read why (`cast run <hash>`), and decide with the team before anything else is sent. The record of the deploy of 2026-10-12 is kept as `run-before-redeploy.json` beside it, written once and never over.

## Verifying the sources

From `contracts/`, with an Etherscan API key in `ETHERSCAN_API_KEY` (never in a file) and the addresses from the record:

```
forge verify-contract <vaultLogic>    src/BasketVault.sol:BasketVault     --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --watch
forge verify-contract <beacon>        src/VaultBeacon.sol:VaultBeacon     --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --guess-constructor-args --watch
forge verify-contract <factoryLogic>  src/VaultFactory.sol:VaultFactory   --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --watch
forge verify-contract <registryLogic> src/IndexRegistry.sol:IndexRegistry --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --watch
forge verify-contract <factory>  node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --guess-constructor-args --watch
forge verify-contract <registry> node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --guess-constructor-args --watch
```

Then mark each proxy as a proxy on https://robin.etherscan.io ("Is this a proxy?"), so its page reads through to the logic.

## The contracts of 2026-10-12

They stay deployed, held by their timelock. Their factory lists two vaults, both owned by `0xAC3c…1e0e`, about $15 between them on 2026-10-14 (5 USDG and four stocks in one, SPY in the other); the registry has no portfolio. Before the records change, their owner withdraws through the app (Withdraw on each vault). After it, the app no longer lists them, and `withdrawAll()` on each vault's page on Etherscan does the same: it reads no feed and calls neither the factory nor the timelock, so nothing on the old contracts can stop it.

## When the timelock comes back

Gate `ROBINHOOD-REDEPLOY` names the condition: the four portfolios of `PRODUCTS-MAINNET-ONLY` are published, a week of trading with the keeper off has run without an incident, and Thom says so. Then the Safe hands the factory's admin and the beacon to a new `TimelockController` of 48 hours, `delayHours` goes back to 48 with a new `textVersion`, and the record names the timelock again.

## Rehearsal

`ROBINHOOD_RPC_URL=<node> contracts/script/redeploy-fork.sh [out dir]` runs steps 3 to 7 on an anvil copy of mainnet, as the impersonated deployer and Safe. It first sends the committed file and expects the refusal for its Proposed values with nothing sent, then deploys a copy whose values read as confirmed (`script/config/.rehearsal/`, removed when it ends). It fails on a `check()` revert and on any verdict but OK. On 2026-10-15 at block 88,817,888: the refusal, then the same as below. On 2026-10-14 at block 88,777,239: 54 transactions with receipts; the Safe's two calls; the Safe holds both; `Deploy.check()` passes on 27 assets; both records written; `authority-check` `VERDICT: OK`. `RH_FORK_URL=<node> forge test --match-path test/fork/RobinhoodForkDeploy.t.sol` deploys the same file on a fork and buys and sells back every one of the 26 tokens through the real router.
