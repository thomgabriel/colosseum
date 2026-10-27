# Robinhood Chain mainnet: the thirteen stocks of Oct 23 (gate LIST-13)

Thom and Rodrigo asked on 2026-10-23 for thirteen more stock tokens on the redeploy's factory ([`MAINNET-REDEPLOY.md`](MAINNET-REDEPLOY.md)): AMC, COST, DJT, GLXY, GME, HIMS, LLY, MRNA, RBLX, RDDT, SNAP, SNDK, TTWO. Measured read-only on the same day. Nothing was sent, signed or proposed: the Safe's two owners list what passes with one batch they sign in the Safe app.

**One passes: GME**, through its Uniswap v3 pool. Once the batch lists it, the app trades and shows it through the v3 route, as QQQ, MU, AMD, INTC and SLV (gate `V3-ROUTE`). **Twelve do not**: eleven have no Chainlink feed on the chain, and SNDK's pools cost more than 1% at $1,000.

## Source and read time

| Read | Block | Time (UTC) | What |
|---|---|---|---|
| Feeds | none (a file) | 2026-10-23 15:41 | Chainlink's directory for Robinhood Chain mainnet, `reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`: 58 feeds |
| Tokens | 96,097,359 | 2026-10-23 17:00:48 | `symbol()`, `decimals()`, `paused()`, the schedule selector `0x97a4064f` and the factory's `isAsset()` for all thirteen, through `rpc.mainnet.chain.robinhood.com` |
| Pools | 96,096,520 | 2026-10-23 16:59:24 | `packages/chain-evm/test/pool-quotes.ts` (method `pool-quotes-0.3`, `RH_POOLS_V3_QUOTES=1`) for GME and SNDK: every hookless v4 pool against USDG and the v3 pools at fees 100, 500, 3000 and 10000, quoted at $1,000, $2,500, $4,000, $5,000, $10,000, $25,000, $50,000 and $250,000 each way, cost against the pool's own mid, fee included |
| Fork | 96,112,816 | 2026-10-23 17:27:39 | `RobinhoodForkAddAssetsTest` (below) |

A Friday, in session. The raw reads are in `fixtures/risk-evm/robinhood-list-13-quotes.json`. Every token answered its symbol, 18 decimals, `paused()` false and the schedule selector, and none is listed on the factory `0x7E2B…B8aA`.

## The bar

Unchanged from `WIDER-LIST` and `WIDER-LIST-B` ([`MAINNET-WIDER-LIST.md`](MAINNET-WIDER-LIST.md), "The bar"): a live Chainlink feed that names its aggregator, 8 decimals; a hookless Uniswap v4 pool against USDG, or else a Uniswap v3 pool (traded through the v3 route, `V3-ROUTE`), that fills $1,000 each way for 1% or less with its mid within 2% of the feed; on a fork, a vault on the live factory buys $500 and sells half back within 2% of the feed. `maxTradeUsd` is the largest size asked at 1% or less each way, every smaller size too; `maxWeightBps` is DESIGN-VAULT section 6 on the pool's sale capacity; `average` is the deepest v3 pool against USDG keeping more than 3,600 observations. Session 1 and `maxAge` 93,600 s, as every Robinhood stock (their feeds are the same product, "us_equities_24/5", heartbeat 86,400 s). Keeper off.

## GME

| | |
|---|---|
| Token | `0x1b0e319c6a659f002271b69db8a7df2f911c153e`, 18 decimals |
| Feed | `0x27c71df6a64fb476468edf256cf72c038bab5b67`, "Robinhood GME / USD", aggregator `0xf83c…d679`, $25.45, 1,918 s old |
| v4 | No pool fills $1,000: the deepest hookless one (fee 10000, spacing 200) costs 41.7% to buy and 10.4% to sell; the rest are empty or far from the feed |
| v3 pool | `0xe2b46c905e12ab8e2f864e4821a4325884c1b126`, fee 500, mid -19.6 bps from the feed |
| Cost, in / out | $1,000 0.12% / 0.12%; $5,000 0.42% / 0.41%; $10,000 0.81% / 0.81%; $25,000 2.07% / 4.44% |
| Largest trade | $10,000 |
| Ceiling | 500 bps (capacity $10,000) |
| Average | the same pool, 4,101 observations (re-read at block 96,171,268, 19:08 UTC; 3,601 at the measured block), `observe([3600, 0])` answers: usable. `minLiquidity` 130,000,000,000,000,000 |

The deeper v3 pool (fee 10000, `0xe971…2fdf`) costs 1.02% at $1,000 and keeps 1,860 observations, so it is neither the route nor the average.

## The twelve that do not pass

| Token | Address | Why |
|---|---|---|
| AMC | `0x05a3d1cd21d0c88145e82600e62e7e496e0f222b` | No Chainlink feed on the chain |
| COST | `0x4ea005168d7f09a7a0ba9d1def21a479950e44c2` | No Chainlink feed on the chain |
| DJT | `0x1d11f0496982706c5e14a514d4e79f2e6bde4516` | No Chainlink feed on the chain |
| GLXY | `0x2d427692e928fa156ec22acfabafa0447c5805b7` | No Chainlink feed on the chain |
| HIMS | `0xccee82fe024c36fa15e1005ede3e9e4787e23d09` | No Chainlink feed on the chain |
| LLY | `0x8005d266423c7ea827372c9c864491e5786600ea` | No Chainlink feed on the chain |
| MRNA | `0x43b07d15ce533bec5476d70c22a78a1b2b662155` | No Chainlink feed on the chain |
| RBLX | `0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8` | No Chainlink feed on the chain |
| RDDT | `0x05b37fb53a299a1b874a619e1c4c404d52c36f4c` | No Chainlink feed on the chain |
| SNAP | `0xf6589f11bc40b669e584073f428b05562f568733` | No Chainlink feed on the chain |
| TTWO | `0x5e81213613b6b86eab4c6c50d718d34359459786` | No Chainlink feed on the chain |
| SNDK | `0xb90a19ff0af67f7779aff50a882a9cff42446400` | Feed "RHSNDK / USD" live ($1,270.61, 451 s), but no pool fills $1,000 for 1% or less: its deepest v4 pool (fee 10000) costs 1.16% each way and sits 77 bps from the feed; the fee-4000 pool sits 7.6% from the feed and does not fill a sale; its v3 pool (fee 10000) costs 1.61% / 2.01% |

Without a feed an owner's trade has no witness, and the app refuses to build it (`OWNER-PRICE-BOUND`); the contract would list such a token, but nothing could trade it, so it is not listed. They pass once Chainlink publishes a feed for them on Robinhood Chain: re-run the reads above and add them to a new file. SNDK passes when a pool deepens: the same.

## The batch

`contracts/script/config/4663-assets-3.json` names the factory `0x7E2Bbb8483eB1BaA6D87210Bc83b63ad7A1bB8aA`, the Safe `0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc` (its admin, no timelock), USDG and GME, with every value's note. `pnpm ops:add-assets --safe-files contracts/script/config` writes `4663-assets-3.safe.json`, the Transaction Builder file: one call from the Safe to the factory, `setAsset(GME, config)`, value 0, with the Builder's own checksum `0x22be…d4e4` in its `meta`. The tests hold the committed file to what the builder makes (`tests/add-assets.test.ts`).

What the call sets, in the struct's order: feed `0x27C7…5B67`, token decimals 18, feed decimals 8, `maxAge` 93,600, session 1, source 1 (Chainlink), `maxWeightBps` 500, pause probe the token with `paused()` (`0x5c975abb`), schedule selector `0x97a4064f`, `haltUntil` 0, flags 0, no average feed, no price range. `maxTradeUsd`, the v3 pool and the average are the app's, kept in the record, not on chain.

**On a fork.** `RH_FORK_URL=<node> forge test --match-test theSafeListsTheRedeploysTokens -vv` (from `contracts/`): the Safe file's target and bytes are the batch's, a stranger cannot send them, the Safe can (117,912 gas), GME is then listed exactly as the file says (`AddAssets.check()`), and a vault deposits $1,000, buys $500 of GME through Universal Router's v3 command (19.7446 GME at a feed of $25.32, 0.08% under) and sells half back ($249.80, 0.04% over), and withdraws everything. Passed at block 96,112,816.

## The record, before and after

Before the Safe signs (this pull request): GME is under `pending` in `deployments/robinhood-mainnet.json`, with the batch's id. Nothing that trades, shows or limits reads `pending`, and the guard's file does not name it.

After the Safe's transaction lands (a second pull request, opened then; prepared on branch `evm/list-13-promote`, whose record is exactly what `--promote` writes): `pnpm ops:add-assets --status --rpc-env ROBINHOOD_RPC_URL` must say "GME listed as the file says"; then `pnpm ops:add-assets --promote --rpc-env ROBINHOOD_RPC_URL` reads the factory's `asset(GME)`, refuses any other settings than the file's, and moves GME from `pending` to the record's `assets` with its `v3Pool` and into the guard's file, exactly as QQQ is, and regenerates the guard's tables. Then the hosted `basket_assets` gets GME's row (`scripts/robinhood/basket-assets.ts deployments/robinhood-mainnet.json`, a person applies it) before the API's next deploy, and `GET /v1/config` must show `"missingAssets":[]` for `robinhood`.

## Executed

The Safe executed the batch on 2026-10-27: transaction `0x0d2a50a40f5965f388e56f9f0aa2e8bd13002b124fe6a7c19e57c187c5767d2c`, block 99,480,911. `isAsset(GME)` returns true, and `pnpm ops:add-assets --status` reads "GME listed as the file says". The record's `pending` entry moved to `assets` with `--promote`.

## For the signers

1. **Open** the Safe `0x4568…5Fdc` on Robinhood Chain in the Safe app, Apps, Transaction Builder, and drag in `contracts/script/config/4663-assets-3.safe.json` from this pull request's head. No warning about the checksum may show; one means the file was changed after it was written.
2. **Check what it does.** One transaction: to `0x7E2Bbb8483eB1BaA6D87210Bc83b63ad7A1bB8aA` (the Tenonfi factory, MAINNET-REDEPLOY.md), value 0, method `setAsset` (data begins `0xc03633a6`), first argument `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` (GME, robin.etherscan.io names it), then the config above: the feed `0x27C71df6A64fB476468EdF256CF72c038baB5B67` ("Robinhood GME / USD" on Etherscan), 500 for `maxWeightBps`, zero for the keeper's fields. Nothing else is in the batch.
3. **Sign**, first owner; the second owner opens the queued transaction, checks the same, signs and executes. The Safe's simulation must pass before executing.
4. **Confirm on chain.** On robin.etherscan.io the transaction shows one `AssetSet` event of the factory for GME, status success. Read-only, from a checkout: `cast call 0x7E2Bbb8483eB1BaA6D87210Bc83b63ad7A1bB8aA "isAsset(address)(bool)" 0x1b0E319c6A659F002271B69dB8A7df2F911c153E --rpc-url https://rpc.mainnet.chain.robinhood.com` answers `true`, and `pnpm ops:add-assets --status --rpc-env ROBINHOOD_RPC_URL` says "listed as the file says". Then the agent opens the second pull request (`--promote`).
