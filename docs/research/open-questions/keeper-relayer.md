# Keeper: can OpenZeppelin Relayer and Monitor do it?

Oct 1, 2026. Read from source (Relayer v1.8.0 at commit `b790686`, Sep 30, 2026; Monitor v1.6.0 at `f9c6f53`) plus docs. Nothing was run: the Docker daemon is off on this machine and Relayer needs Redis, so every Relayer claim below is from reading code and docs, not from a live submit. Robinhood Chain facts are from read-only RPC calls today.

## Answer

**No for Solana, yes-but-not-worth-it for the two EVM chains. Use a plain TypeScript worker (viem + @solana/kit) for the demo.**

- Relayer's Solana path only handles **legacy transactions**. It cannot send a v0 transaction with address lookup tables, and our keeper leg (vault wrapper + Jupiter route) needs them.
- On Base and Robinhood Chain it would work (custom chain is a JSON entry), but it adds a Rust service, Redis and a config surface to do what a sequential viem signer does on two sequencer chains with no public mempool.
- Monitor is a notifier. A 30-line poll loop over registry state is simpler and more robust for a trigger that has a 12-hour delay built in.
- Two lines in the brief need correcting: "Relayer ... works on Solana and both EVM chains", and the post-MVP "Chainlink Automation on Base" (Automation is deprecated, see below).

## Relayer on Solana: what it actually does

It is more than a fee payer. With `fee_payment_strategy: "relayer"`, `POST /api/v1/relayers/{id}/transactions` accepts either a base64 transaction whose fee payer is the relayer, or an **array of arbitrary instructions** that the relayer builds, signs with its own key and submits. `allowed_programs` / `allowed_accounts` policies can restrict it. ([docs/solana.mdx](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/b790686deafed19a1b682462cf83b1fcd58e8345/docs/solana.mdx))

The blocker is the transaction format:

- Instruction mode builds with `Transaction::new_with_payer(...)`, the legacy type. No lookup-table parameter exists. ([src/domain/transaction/solana/utils.rs#L160](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/b790686deafed19a1b682462cf83b1fcd58e8345/src/domain/transaction/solana/utils.rs#L160))
- Encoded mode decodes with `Transaction::try_from` (legacy bincode), as do `signTransaction`, `signAndSendTransaction`, `prepareTransaction` and `feeEstimate`. ([src/models/transaction/request/solana.rs](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/b790686deafed19a1b682462cf83b1fcd58e8345/src/models/transaction/request/solana.rs))
- `VersionedTransaction` appears only in the relayer's own Jupiter fee-token swap and in the provider. No issue or changelog entry mentions versioned transactions or lookup tables.
- Raw `sign` is "not supported for Solana relayers", so it cannot be used as a signing oracle for a v0 message we build ourselves.

Why that kills it for us: `research/vaults/solana-feasibility.md` measured one Jupiter leg at 23–48 accounts and the vault wrapper at 10–14 more. 33+ accounts at 32 bytes each is over 1,050 bytes before signatures and instruction data, against a 1,232-byte limit. The design already says "v0 + Jupiter's ALTs + one ALT of our own".

Other Solana behaviour, for the record: blockhash-expiry resubmit only for single-signer transactions (it swaps the blockhash, re-signs and resends the same instructions, so a stale Jupiter route would be resent as is); status tracked Processed/Confirmed → Finalized; request limits 64 instructions, 64 accounts, 1,232 bytes of data per instruction.

The design's pre-build test "Relayer submits one transaction on each chain" would give a false pass with a simple transfer. If anyone reruns it, the test has to be a v0 transaction with a lookup table.

## Relayer on EVM

- **Custom chain:** any EVM chain via JSON. Base is bundled (`config/networks/optimism.json`, tag `optimism-based`). Robinhood Chain would be:

```json
{ "type": "evm", "network": "robinhood-chain", "chain_id": 4663, "symbol": "ETH",
  "required_confirmations": 1, "average_blocktime_ms": 100, "features": ["eip1559"],
  "rpc_urls": ["https://rpc.mainnet.chain.robinhood.com"],
  "explorer_urls": ["https://robinhoodchain.blockscout.com"],
  "tags": ["arbitrum-based", "rollup", "no-mempool"], "is_testnet": false }
```

  The `arbitrum-based` tag switches on Arbitrum handling (no-mempool replacement logic, 20 s resubmit, NOOP gas sized by estimate). Docs warn that L2s "may also work" and should be tested. ([network_configuration.mdx](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/b790686deafed19a1b682462cf83b1fcd58e8345/docs/network_configuration.mdx)) **Unverified:** nobody has run it against 4663.
- Read today from `rpc.mainnet.chain.robinhood.com`: chain id 4663, client `nitro/v3.12.0-rc.3`, about 0.1 s blocks (990 blocks in 100 s), `baseFeePerGas` 0.02 gwei, `eth_maxPriorityFeePerGas` = 0, no `txpool_*`.
- **Queue, nonce, retry:** Redis-backed job queue (SQS, Pub/Sub, RabbitMQ optional, Redis still required); per-relayer nonce counter with nonce-too-low/too-high reconciliation; resubmit with a minimum 10% gas bump; NOOP replacement to unstick a nonce; prepare/submit timeouts; `valid_until`; weighted RPC failover; webhook notifications signed with `WEBHOOK_SIGNING_KEY`.
- **One trap for a keeper:** if `eth_estimateGas` fails, it falls back to a default gas limit (200,000 for contract calls) and still submits. A vault that rejects a trade would cost gas on every attempt. Simulate first and pass `gas_limit` explicitly. ([docs/evm.mdx](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/b790686deafed19a1b682462cf83b1fcd58e8345/docs/evm.mdx))

## Signers

| Signer | EVM | Solana |
|---|---|---|
| `local` (encrypted keystore file + passphrase env) | yes | yes |
| `turnkey` | yes | yes |
| `aws_kms`, `google_cloud_kms` | yes | yes |
| `cdp` (Coinbase) | yes | yes |
| `vault` (HashiCorp secret) | yes | yes |
| `vault_transit` | no | yes |
| `azure_key_vault` | yes | no |

Source: [docs/configuration/signers.mdx](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/b790686deafed19a1b682462cf83b1fcd58e8345/docs/configuration/signers.mdx).

## Running it

`docker compose up` from an example folder: image `openzeppelin/openzeppelin-relayer` plus `redis:bookworm`, port 8080, `config/config.json` (relayers, signers, notifications, networks), env `API_KEY` (32+ chars, bearer auth), `WEBHOOK_SIGNING_KEY`, `KEYSTORE_PASSPHRASE`, `REDIS_URL`. `REPOSITORY_STORAGE_TYPE=in-memory` drops Redis for storage only; the queue still needs it. Docs say not to expose it to the internet. An OpenAPI file ships in the repo (`openapi.json`).

## License (AGPL-3.0)

Relayer, Monitor and the TypeScript SDK (`@openzeppelin/relayer-sdk` 1.10.0, `AGPL-3.0-or-later` on npm) are all AGPL. Not legal advice:

- Running the unmodified Docker image next to our code and calling it over HTTP does not put our repo under AGPL.
- Importing the SDK into `apps/keeper` makes the keeper a combined work that must be AGPL-compatible. Avoid by calling the REST API with `fetch`.
- Modifying Relayer (for example to add v0 support) means publishing the modified source to anyone who uses it over a network.
- OpenZeppelin Contracts (the Solidity library the vault uses) is MIT and unaffected.

## Monitor

- Polls on a cron per network (EVM: `eth_getBlockByNumber` + logs; Solana: `getBlock`, or `getSignaturesForAddress` per monitored address), with `confirmation_blocks`, `max_past_blocks` and an optional missed-block recovery job. Custom EVM chain is one JSON file with `chain_id` and RPC URLs.
- EVM: matches events and functions by Solidity signature with expressions on decoded arguments.
- Solana: **substring match on program log lines** (an Anchor event name such as `Deposit`). No argument decoding, and instruction matching is not implemented ([filter.rs#L89](https://github.com/OpenZeppelin/openzeppelin-monitor/blob/f9c6f532e8a4fea24e5eb08103c155f2380f72d6/src/services/filter/filters/solana/filter.rs#L89)).
- Triggers: Slack, Discord, Telegram, email, webhook (templated or raw match payload), or a Python/JS/Bash script. It does not submit transactions; a webhook would call our keeper.

For us this is the wrong shape. The keeper acts 12 hours after `RecipePublished`, so it has to keep its own schedule anyway, and what it needs is current state (recipe version versus each vault's accepted version), which a missed event cannot corrupt.

## Alternatives

| Option | Solana | Base | Robinhood Chain | Verdict |
|---|---|---|---|---|
| Plain TS worker (viem + @solana/kit) | yes, v0 + ALTs | yes | yes | **Use this** |
| OpenZeppelin Relayer | legacy transactions only | yes | yes by config, untested | EVM only, later if volume needs it |
| Gelato (hosted relay, Web3 Functions) | no | yes | **unverified** (docs URLs returned 404 today) | Third-party account and a trusted executor; skip |
| Chainlink Automation | no | listed, but **deprecated** | not listed | Do not plan on it |
| Tuk Tuk (Helium, Apache-2.0, pushed Sep 22, 2026) | yes | no | no | On-chain task queue with its own crank; tasks are fixed at queue time, which does not fit a fresh Jupiter route per leg |

- Chainlink: "Chainlink Automation has been deprecated (v1.x: June 30, 2026 | v2.1: July 31, 2026 ...)", with migration to the Chainlink Runtime Environment (CRE). Supported list is Arbitrum One, Avalanche, Base, BNB, Ethereum, Gnosis, OP, Polygon, Scroll, ZkSync. ([supported networks](https://docs.chain.link/chainlink-automation/overview/supported-networks), [overview](https://docs.chain.link/chainlink-automation)) CRE on Base or 4663 was not checked.
- Clockwork shut down in 2023; Tuk Tuk is the maintained successor ([helium/tuktuk](https://github.com/helium/tuktuk)).

## Recommended setup for the demo

One Node process, `apps/keeper`, no extra services beyond the Postgres the backend already has.

1. **Reconcile loop, not event handlers.** Every 30–60 s, through the adapters: list auto-follow vaults whose accepted version is behind a recipe version with `effectiveAt` in the past. Missed events and restarts cannot lose work.
2. **Jobs in Postgres.** The `rebalance_jobs` table from the design, one row per leg, unique on (vault, recipe version, leg index) so a restart never double-submits. The app and any agent read status from here.
3. **One submitter per chain, strictly serial.** Serial submission removes nonce races; the vault's one-hour cooldown means volume is tiny.
   - EVM: viem wallet client with `nonceManager`; `simulateContract` before every send and skip on revert; explicit gas limit; `maxFeePerGas` at 2× base fee; wait for the receipt with a timeout. Both chains are single-sequencer with no public mempool, so there is no gas-bump logic to write.
   - Solana: @solana/kit; v0 message with Jupiter's lookup tables plus ours; simulate to set the compute limit; priority fee from recent fees; rebroadcast every 2 s until confirmed or the blockhash expires; on expiry **requote and rebuild**, never resend the old route.
4. **Keys.** One new key per chain family, in the host's secret store, holding gas only. The vault's checks bound what a leaked key can do. After the hackathon move to Turnkey, which is already on the wallet-provider shortlist and signs for both viem and Solana.
5. **Keep a `Submitter` interface** (`submit`, `status`) so Relayer can sit behind it for EVM later without touching the planner.

Docs to fix: the keeper lines in `basket-app-brief.md` (Vaults section) and `design/technical-design.md` (sections 2, 8, 9, 10), and the Chainlink Automation line in "After the MVP".

## For agents

The keeper stays internal: it holds a key and has no reason to take outside requests. What an outside agent needs is on the owner path, which the adapter already has: `build*` calls that return unsigned transactions the agent signs with its own wallet, plus read access to vault state and `rebalance_jobs` status. Expose those through `apps/api` with an OpenAPI description and idempotency keys; an agent that owns a vault can then follow, rebalance, toggle auto-follow and withdraw without the web app.

## Not verified

- Relayer was not started; no transaction was submitted on any chain.
- Relayer against chain 4663 (Arbitrum handling triggered by the tag) is untested.
- Gelato's current network list and whether it covers Robinhood Chain.
- Whether CRE covers Base or Robinhood Chain as an Automation replacement.
