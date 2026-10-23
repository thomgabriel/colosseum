# Robinhood Chain mainnet: the second list of tokens

**Superseded in how, not in what (2026-10-14, gate `ROBINHOOD-REDEPLOY`):** these tokens, with the values below, are listed by the redeploy at deploy (`contracts/script/config/4663.json`, [`MAINNET-REDEPLOY.md`](MAINNET-REDEPLOY.md)), not by a timelock batch on the factory of 2026-10-12.

Measured 2026-10-13, read-only, for gate `WIDER-LIST` (Thom: launch "with as much tokens we can"). Nothing was sent, signed or proposed: the Safe's two owners list these tokens through the timelock, and the app shows a token only once the chain lists it (below).

**Twelve tokens meet the bar the nine of the deploy met:** MSTR, CRCL, USO, PLTR, WETH, cbBTC, DELL, SPCX, COIN, TSM, BABA, SGOV. Seventeen do not. The batch that lists them is `contracts/script/config/4663-assets-2.json`.

## Source and read time

Every figure below is an `eth_call` on Robinhood Chain (4663) through the node in `ROBINHOOD_RPC_URL`, made by `packages/chain-evm/test/pool-quotes.ts` (method `pool-quotes-0.2`), each run at one block:

| Run | Block | Time (UTC) | Tokens |
|---|---|---|---|
| a | 87,730,091 | 2026-10-13 18:35:16 | MSTR, CRCL, USO, DELL, SPCX, MU, COIN, INTC, PLTR, GME, AMD, SLV, SNDK, QQQ, SGOV, WETH (and TSM) |
| b | 87,739,606 | 2026-10-13 18:51:14 | cbBTC, TSM, BABA, ASML, CLSK, CRWV, EWY, IONQ, NBIS, ORCL, RGTI, RKLB, USAR |

A Tuesday, in session. The raw reads are in `fixtures/risk-evm/robinhood-wider-list-quotes.json`. Candidates came from the queue (MSTR, cbBTC, USO, WETH, CRCL, DELL, TSM), every other Robinhood stock token in `scripts/risk/universe/robinhood.json`, and every Robinhood Chain feed in Chainlink's directory (`reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`, read the same day) whose token has a pool. For each: the token's `symbol()`, `decimals()` and `paused()`; the feed's `description()`, `decimals()`, `latestRoundData()` and `aggregator()`; every hookless Uniswap v4 pool of the token and USDG the PoolManager's `Initialize` events name, with its price and liquidity from the StateView and `quoteExactInputSingle` for $1,000, $2,500, $5,000, $10,000, $25,000, $50,000 and $250,000 each way (cost against the pool's own mid, fee included); and the Uniswap v3 pools of the token and USDG at fees 100, 500, 3000 and 10000 (the v3 factory's `getPool`), with liquidity and observations kept.

## The bar

What the nine of the deploy were held to (`POOL-PER-ASSET`, `OWNER-PRICE-BOUND`, `MAINNET-FILE-CONFIRMED`; `tests/evm-vault/record.test.ts`, `RobinhoodForkDeploy.t.sol`), applied unchanged except for the pool rule:

1. A token contract whose decimals answer as stated and, for a stock or fund token, whose `paused()` and schedule selector answer (`checkMainnetAsset`, the deploy script's own rule).
2. A Chainlink feed that names its aggregator, describes itself, has 8 decimals and is younger than `maxAge` (93,600 s). The app refuses a trade with no live witness.
3. A hookless Uniswap v4 pool against USDG that fills $1,000 each way for 1% or less, with its mid within 2% (`priceBoundBps`) of the feed: the smallest largest trade of the nine is GLD's $1,000.
4. On a fork, a vault on the live factory deposits $1,000, buys $500 of the token through that pool and sells half back, each fill within 2% of the feed, and withdraws everything.

**The pool rule, amended.** For the nine it was "the hookless pool with the most liquidity in range", and every deepest pool met point 3. Here the deepest pool of eight tokens is one that charges 1% and so cannot meet it, while three of them (SPCX, COIN, PLTR) have a cheaper pool that does. The rule is now "the hookless pool with the most liquidity in range among those that meet point 3": it picks the same pool for each of the nine, and the deepest where the deepest qualifies (gate `WIDER-LIST`).

From the same reads, by the rules of the nine:

- `maxTradeUsd`: the largest size asked that cost 1% or less each way in the recorded pool, every smaller size too.
- `maxWeightBps`: DESIGN-VAULT section 6, 10,000 × 0.25 × capacity / $50,000, down to a 50 bps step, at most 5000, with capacity the largest of $1,000, $10,000, $50,000 and $250,000 the pool took as a sale for 1% or less.
- `average`: the token's deepest Uniswap v3 pool against USDG with more than 3,600 observations, `usable` true; where none keeps that many, the deepest, `usable` false. `minLiquidity` is half its liquidity in range, down to two figures.
- Keeper off: `flags` 0, no average feed, no range. Session 1 (the US session) for stocks and funds, 0 for WETH and cbBTC; `maxAge` 93,600 s for all.

## The twelve that meet it

Cost is to trade in / out against the pool's own mid, fee included. "—" is a size the pool did not fill.

| Token | Address | Dec. | Feed (description) | Feed price, age | Pool (fee / spacing) | Liquidity in range | Mid vs feed | $1,000 | $5,000 | $10,000 | $25,000 | Largest trade | Ceiling (bps) | Average pool (v3 fee, observations) | Usable | Run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| MSTR | `0xec262a75e413fafd0df80480274532c79d42da09` | 18 | `0x396118bdfb181e6240e74d243f266b061c0edc3d` (Robinhood MSTR / USD) | $152.28, 2,666 s | 2400 / 24 | 1.05e18 | -1.3 bps | 0.29% / 0.29% | 0.32% / 0.32% | 0.36% / 0.36% | 0.47% / 0.47% | $50,000 | 2500 | `0x17578c0e0d15da44f31677263114f71ae76653ea` (10000, 7,200) | yes | a |
| CRCL | `0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5` | 18 | `0x6652edf64ba3731c4f2d3ce821a0fb1f1f6b482a` (Robinhood CRCL / USD) | $84.42, 1,714 s | 3000 / 30 | 2.22e17 | -17.7 bps | 0.40% / 0.40% | 0.59% / 0.59% | 0.83% / 0.83% | 1.68% / 1.47% | $10,000 | 500 | `0x654e4143e82a5824445ade0824351c2a9acd95a8` (3000, 7,200) | yes | a |
| USO | `0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344` | 18 | `0x75a9c76ef439e2c7c2e5a34ab105ecfe3766431c` (RHUSO / USD) | $152.35, 11,197 s | 1200 / 15 | 2.46e17 | -0.8 bps | 0.17% / 0.17% | 0.31% / 0.31% | 0.48% / 0.47% | 1.15% / 1.00% | $10,000 | 500 | `0x02175608f1b5e6b5ed221ccfdc7be197d111d915` (3000, 7,200) | yes | a |
| PLTR | `0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a` | 18 | `0x820abedff239034956b7a9d2f0a331f9f075eb4c` (Robinhood PLTR / USD) | $208.09, 284 s | 1500 / 15 | 1.14e17 | -8.7 bps | 0.24% / 0.24% | 0.48% / 0.46% | 0.78% / 0.73% | — / 2.15% | $10,000 | 500 | `0x851680416a4f4e1c463d45171d61acddbc8554c0` (3000, 1,801) | no | a |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` | 18 | `0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9` (ETH / USD) | $2,503.86, 5,053 s | 200 / 4 | 3.50e16 | -16 bps | 0.08% / 0.08% | 0.31% / 0.36% | 0.59% / 0.83% | 1.43% / 2.34% | $10,000 | 500 | `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` (100, 10,809) | yes | a |
| cbBTC | `0xcec185eb182c47d1ba1efc84e6959e18cd620be4` | 8 | `0xa2c5184bf03d373dc9de4876eb4bce595b460251` (BTC / USD) | $83,175.65, 11,022 s | 1500 / 15 | 2.15e11 | -13.5 bps | 0.19% / 0.19% | 0.26% / 0.26% | 0.34% / 0.34% | 0.58% / 0.58% | $50,000 | 2500 | `0x9664d869540e9d0a76f12c6623946c6d5d201e09` (500, 1,400) | no | b |
| DELL | `0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd` | 18 | `0x1c6c8cadbe02e19129c39ddb92281ce4c0bf206b` (Robinhood DELL-USD) | $572.55, 5,810 s | 5000 / 25 | 4.35e16 | -14.6 bps | 0.69% / 0.69% | 1.06% / 1.06% | 1.53% / 1.53% | 3.07% / 2.92% | $2,500 | 50 | `0xc30c89cb7815a1488b7998d15eec73961707fc5a` (10000, 1,801) | no | a |
| SPCX | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` | 18 | `0xb265810950ba6c5c0ff821c9963014a56fd8bffb` (Robinhood SPCX / USD) | $157.04, 6,853 s | 3000 / 60 | 5.49e16 | 8 bps | 0.49% / 0.49% | 1.01% / 1.07% | 1.61% / 2.13% | 3.30% / 7.41% | $2,500 | 50 | `0xc61284332117c3fb23a2a56cceffd07f7af60029` (500, 14,400) | yes | a |
| COIN | `0x6330d8c3178a418788df01a47479c0ce7ccf450b` | 18 | `0xa3a468a452940b7d6b69991207b508c609a98ef2` (Robinhood COIN / USD) | $181.42, 1,681 s | 2500 / 25 | 3.66e16 | -19.4 bps | 0.49% / 0.49% | 1.29% / 1.31% | 2.14% / 2.35% | 4.30% / 5.50% | $2,500 | 50 | `0x3a6ec0aa6c702323414d449b5f60f4b742a82ded` (500, 1) | no | a |
| TSM | `0x58ffe4a942d3885baa22d7520691f611ef09e7aa` | 18 | `0x874cf94aa8ec88fd9560094dd065f2fb3e41fc2f` (Robinhood TSM / USD) | $443.56, 5,101 s | 7500 / 75 | 8.41e16 | -27.8 bps | 0.91% / 0.91% | 1.13% / 1.13% | 1.40% / 1.40% | 2.21% / 2.22% | $2,500 | 50 | `0x07e8ea83d4c1340774c8965125e26e12bf943bf1` (10000, 1,801) | no | b |
| BABA | `0xad25ac6c84d497db898fa1e8387bf6af3532a1c4` | 18 | `0x62cc8f9b5f56a33c9c8a60c8b92779f523c4e984` (Robinhood BABA / USD) | $110.21, 8,680 s | 1000 / 10 | 3.18e16 | 26.2 bps | 0.42% / 0.42% | 1.59% / 1.59% | 3.02% / — | — / — | $2,500 | 50 | `0xa57ab582b310dd6f9e934ea1eeea152741545e6a` (3000, 1,801) | no | b |
| SGOV | `0x92fd66527192e3e61d4ddd13322aa222de86f9b5` | 18 | `0xa0df4ee0fff975306345875e3548fcc519577a11` (Robinhood SGOV-USD) | $101.25, 66,854 s | 200 / 2 | 5.77e17 | -8.6 bps | 0.04% / 0.04% | — / 0.11% | — / — | — / — | $1,000 | 50 | `0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe` (3000, 1,800) | no | a |

Sizes asked were the largest-trade ladder ($1,000 to $250,000); a $20,000 trade sits between the $10,000 and $25,000 columns. Each token's note in `4663-assets-2.json` holds its own quotes, pool id and why.

What to know about them:

- **Six are deep enough for a person's whole deposit**: MSTR and cbBTC take $50,000 a trade, CRCL, USO, PLTR and WETH $10,000. The other six take $2,500 (SGOV $1,000) a trade, like AMZN and GLD: a larger trade is refused with a line the person reads and can be made in parts.
- **SGOV is at the edge.** Its one cheap pool fills $1,000 each way at 0.04% and does not fill a $2,500 buy; on Oct 12 it did not fill $1,000 at all (`POOL-PER-ASSET`). The app quotes every trade and refuses one the pool cannot fill. Its feed updates about once a day (66,854 s old at the read), and its average pool keeps 1,800 observations, so it trades against its feed up to `maxAge`.
- **WETH and cbBTC** are priced by Chainlink's ETH / USD and BTC / USD (exchange prices), not the CBBTC / USD feed, which Chainlink builds from pools (as GLD's is). They trade at all hours (session 0). Their feeds move only on a 0.5% change, so they are often older than an hour: WETH then trades against its v3 pool's last hour (10,809 observations); cbBTC's average pool keeps 1,400 and cannot be used, so it trades against its feed up to 26 hours.
- **Seven have an average that cannot be used yet** (PLTR, cbBTC, DELL, COIN, TSM, BABA, SGOV): like META and GLD, a stock among them stops from Saturday evening to Sunday evening, until someone grows its v3 pool's history (`ROBINHOOD-MAINNET-DRYRUN.md`, about $6 of gas a pool) and the Safe sets `usable` through the record.
- **Three trade in a pool thinner than their deepest** (SPCX, COIN, PLTR; the amended rule). A thin pool can empty: the trade is then refused, never filled worse than the bound.

## The seventeen that do not

| Token | Address | Why |
|---|---|---|
| MU | `0xff080c8ce2e5feadaca0da81314ae59d232d4afd` | Its only pools that quote charge 1%: 1.15% each way at $1,000 |
| INTC | `0xc72b96e0e48ecd4dc75e1e45396e26300bc39681` | Same: 1.14% at $1,000 in its 1% pool |
| AMD | `0x86923f96303d656e4aa86d9d42d1e57ad2023fdc` | Same: 1.11% at $1,000 |
| SNDK | `0xb90a19ff0af67f7779aff50a882a9cff42446400` | Same: 1.18% at $1,000 |
| ORCL | `0xb0992820e760d836549ba69bc7598b4af75dee03` | Same: 1.22% at $1,000 |
| NBIS | `0x9d9c6684f596f66a64c030b93a886d51fd4d7931` | Its deepest pool (0.99%) costs 1.38% at $1,000 |
| RKLB | `0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2` | 1.33% at $1,000 |
| CRWV | `0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3` | 1.89% / 2.49% at $1,000 |
| EWY | `0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc` | 8.1% / 9.0% at $1,000 |
| GME | `0x1b0e319c6a659f002271b69db8a7df2f911c153e` | Its deepest pool sits 26% from the feed and does not fill a $1,000 buy |
| USAR | `0xd917b029c761d264c6a312bbbcda868658ef86a6` | Its one pool sits 23% from the feed and fills nothing at $1,000 |
| ASML | `0x47f93d52cbec7c6d2cfc080e154002370a60daea` | No pool fills $1,000 |
| QQQ | `0xd5f3879160bc7c32ebb4dc785f8a4f505888de68` | No v4 pool fills a $1,000 buy (its money is in v3: the v3 route, queued separately) |
| SLV | `0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f` | No v4 pool fills $1,000 (v3 route) |
| CLSK | `0xcbb95bbf36099d34da091dc6fa6f49efa257cee3` | No v4 pool against USDG holds liquidity |
| IONQ | `0x558378e000d634a36593e338ebacdd6207640efe` | Same |
| RGTI | `0x284358abc07f9359f19f4b5b4ac91901be2597ba` | Same |

Not measured on chain, and not listable today: the six stock tokens with no Chainlink feed (AMC, COST, DJT, HIMS, LLY, RDDT; an owner's trade needs a feed to be held to), the stablecoins (cash, not holdings), and the crypto tokens the feed directory names but no market search found a USDG pool for on Robinhood Chain (WBTC, wstETH, weETH, LBTC, BTC.B, ENA; LINK has only a $45,000 v3 pool against WETH; DexScreener search, 2026-10-13).

## On a fork

`RH_FORK_URL=<node> forge test --match-contract RobinhoodForkAddAssetsTest` (contracts/test/fork/RobinhoodForkAddAssets.t.sol), on the chain's head (2026-10-13, about 19:00 UTC): the real Safe schedules the batch (134,583 gas), a stranger cannot execute it, the Safe cannot one second early, and does after 48 hours (1,447,608 gas); then all twelve are listed with the file's settings and a vault on the live factory buys $500 of each and sells half back within 2% of its feed. `contracts/script/add-assets-fork.sh` does the same on an anvil copy with the two Transaction Builder files' own bytes, and the authority check reads the copy afterwards: `VERDICT: OK`.

## How the app shows them

The deploy record keeps the twelve under `pending` with the batch's operation id. Nothing that trades, shows or limits reads `pending` (`deploymentAssets`, `deploymentPools`, `deploymentLimits` read `assets` only), and the guard's file does not name them, so neither the app nor the guard accepts a trade in them before the chain does. Once the execute has landed, `pnpm ops:add-assets --promote --rpc-env ROBINHOOD_RPC_URL` reads `isOperationDone` and each token's `asset()` from the factory, refuses a token listed with other settings than the file's, and moves each listed one into `assets` and the guard's file together, regenerating the guard's tables. Then the rows are filled (`scripts/robinhood/basket-assets.ts deployments/robinhood-mainnet.json`) and the API restarted.

## 2026-10-14: five more through v3, two held back, one batch with the registry's upgrade

Thom chose, on Oct 14, to sign one batch that covers every token we will want rather than wait 48 hours more than once: the twelve above, five tokens whose money is in Uniswap v3, and the registry's upgrade (gate `WIDER-LIST-B`). Nothing was signed or sent.

**Still valid, re-read.** At block 88,587,740 the factory's admin was still the timelock, its delay 172,800 s, the Safe 2 of 2 with the same owners and nonce 0, and none of the twelve listed. At block 88,588,018 (18:39 UTC, in session) ten of the twelve still met the bar. DELL did not: its v4 pool held about a sixth of its Oct 13 liquidity and cost 1.16% / 1.21% at $1,000. SGOV still filled $1,000 at 0.04% and no $2,500 buy, and on a fork a $500 buy filled about 2.4% under its feed. Both stay in the batch, listed on chain, and are **held back** from the app (`heldBack` in the file, with why): the fork test holds their listing to the file and does not trade them, and `--promote` leaves them pending.

**Five through v3.** QQQ, MU, AMD, INTC and SLV have Chainlink feeds and no v4 pool against USDG that fills $1,000 for 1% or less; each has a Uniswap v3 pool that does. They are listed with a `v3Pool` and no `pool`, and stay pending, out of the app, until the app builds a v3 route; their ceiling is on chain now, so that route needs no second timelock. Read at block 88,616,978 (2026-10-14 19:27:41 UTC) by `pool-quotes.ts` with `RH_POOLS_V3_QUOTES=1` (method `pool-quotes-0.3`: Bearing's `ClQuoter` through a state override, never deployed), cost against the pool's own mid, fee included, in / out:

| Token | Feed | v3 pool (fee) | Mid vs feed | $1,000 | $10,000 | $50,000 | Largest trade | Ceiling | Average pool (observations) |
|---|---|---|---|---|---|---|---|---|---|
| QQQ | Robinhood QQQ / USD | `0xd60a5d14db690b7afad71f76b108071d7175597d` (500) | 19.9 bps | 0.07% / 0.07% | 0.21% / 0.21% | 0.63% / 0.89% | $50,000 | 25% | same pool (7,200), usable |
| MU | RHMU / USD | `0xd057b1bc54917855bbee58ead58647f47cab35e5` (3000) | -11.8 bps | 0.32% / 0.32% | 0.49% / 0.49% | 1.21% / 1.32% | $25,000 | 5% | same pool (14,400), usable |
| AMD | RHAMD / USD | `0x48d284a2a4d3dc1b3da08231fe44317e7e7aa51f` (3000) | -10 bps | 0.37% / 0.37% | 0.94% / 1.05% | — | $5,000 | 0.5% | same pool (7,200), usable |
| INTC | RHINTC / USD | `0x2e5a92f5013a64661a49312111be2e8abd33f56a` (3000) | 9.6 bps | 0.43% / 0.44% | 1.09% / 1.61% | — | $5,000 | 0.5% | same pool (14,400), usable |
| SLV | Robinhood SLV / USD | `0x8cb787e6c315d464775289bad00fdd67d53ecb3d` (3000) | -15 bps | 0.48% / 0.49% | 0.91% / 2.89% | — | $2,500 | 0.5% | same pool (1,801), not usable |

The same rules as the twelve: largest trade the largest size asked ($1,000, $2,500, $4,000, $5,000, $10,000, $25,000, $50,000, $250,000) at 1% or less each way; ceiling DESIGN-VAULT section 6 on the sale capacity at $1,000, $10,000, $50,000 and $250,000. On a fork of the head the five were listed by the batch and a vault bought $500 of each through Universal Router's v3 command (`V3_SWAP_EXACT_IN`, with 2.1's empty per-hop field) and sold half back, every fill within 2% of its feed.

**Not added.** Rodrigo's shelf (`scripts/risk/assets/shelf-robinhood.json`) names more Robinhood Chain tokens; none meets the bar today. GME (its pools sit far from its feed or cost over 1%) and SNDK ($319 of sale capacity in Bearing's curves) have feeds; HIMS, COST, LLY, AMC, RDDT, DJT, MRNA, SNAP, TTWO, RBLX, GLXY, TAO, NET, DUAL, PROLOGUE and LIT have no Chainlink feed, so an owner's trade in them would have no witness (`OWNER-PRICE-BOUND`). Bearing's capacity for the feedless ones (hosted `risk_depth_curves`, Oct 7 to 14, the worst regime at 1%): HIMS $58k, COST $52k, LLY $50k, AMC $18k, RDDT $7k, DJT $4k.

Re-read on 2026-10-23 for gate `LIST-13` ([`MAINNET-LIST-13.md`](MAINNET-LIST-13.md)): GME now fills $1,000 through a v3 pool and is in that batch; SNDK still does not; the eleven feedless stocks still have no feed.
