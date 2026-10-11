# The asset universe, one file per chain

`pnpm risk:assets <chain>` (`docs/risk/PLAN-ASSETS.md` AS.2 and AS.3, gate `ASSET-UNIVERSE`, decision DA2) writes `solana.json` and `robinhood.json` in this folder: every token of the classes the product knows on that chain, whether or not a plan may hold it, each with a status and its reason. They are generated and committed, as the stock lists in `scripts/risk/universe/` are, and those stock lists are not changed: a tracked stock's row here names its row there (`tracked`) and copies neither its pools nor its oracle.

```sh
pnpm risk:assets solana      # the Solana builder, scripts/risk/assets/solana.ts
pnpm risk:assets robinhood   # the Robinhood Chain builder, scripts/risk-evm/assets.ts
```

## How a list is made

- **`build.ts`** loads the chain's builder (each exports `buildList(args: string[]): Promise<{ list, lines? }>`), validates what it returns with `UniverseList` (`packages/schemas/src/asset-universe.ts`), checks that every verdict of `<chain>.verdicts.json` names a row of the list, writes `<chain>.json`, formats it, and prints the counts per category, status, class, deciding layer and null reason and each read's calls and seconds. A list that does not validate, or a verdict for an address that is not a row, writes nothing.
- **The builder** reads the chain and its listings and decides which verdict rules each token matches. It never types a verdict.
- **The verdicts** are `<chain>.verdicts.json` (schema `UniverseVerdicts`), reviewed by hand: `rules` for every token a listing names in one way, each with its sources, and `verdicts` for one address each. The builder refuses a verdict for an address it did not read (`unreadVerdicts`), and the command checks it again on the list.
- **A row** is joined by `universeRow` in `packages/risk/src/assets/universe.ts`: the identity read on chain, the context from the chain's own files (pools, oracle, shelf, tracked row), and the verdict fields, taken in this order with the later winning: what the builder derived by a method it states, each matching rule in the table's order (each once), the token's own verdict; the row's `decidedBy` names the layers. The class is always the category's (`CATEGORY_CLASS`). A field no layer sets stops the run, naming the token and the field.
- **What the schema refuses besides missing reasons:** a status that offers what the plan holds out (a permissioned token, a token with a maturity or in another currency, a token with no class, a dollar-yield token with no leg type: these are `held_out` or `excluded`); a tracked stock without its tracked row, or any other row pointing at one; a standard, a symbol source, an authority or the issuer registry of the other chain; an EVM implementation without a proxy.

Nothing in a row is a price, a TVL, a supply or a yield: those are observations with their own time (AS.4 and AS.5).

## Files

| File | What it is |
|---|---|
| `build.ts` | The command |
| `solana.ts`, `solana.verdicts.json`, `solana.json` | The Solana builder, its verdicts, its list (AS.2) |
| `robinhood.verdicts.json`, `robinhood.json` | Robinhood Chain's verdicts and list; its builder is `scripts/risk-evm/assets.ts` (AS.3) |

## Hourly bars from the held trades (AS.7)

```sh
RISK_DATA_DIR=…/data/risk pnpm risk:assets-bars solana [--dry-run]                 # Step 5b's 34 pools
RISK_EVM_DIR=…/Colosseum-data/risk-evm pnpm risk:assets-bars robinhood [--dry-run]  # RU.14's walk, read-only
pnpm risk:assets-bars-check <solana|robinhood>                                      # against risk_pool_flow
```

- **`bars.ts`** (the command) reads the held event files through **`bars-read.ts`** (no RPC) and upserts `market_bars` under `bars-0.1`: one row per pool and hour it logged a swap, and one per token and hour across the pools it is filed under (`pool = 'asset'`). A second run rewrites the same rows. `detail.layer` is `raw_events`; `source` names the files; `fetched_at` is the day file's `.done` time on Solana and the walk's end on Robinhood Chain; `provenance` is the source rows'.
- **The bar** is `@colosseum/risk`'s (`packages/risk/src/assets/bars.ts`): a swap's price is the quote amount over the token amount (the venue's fee included); open and close by place in the chain (slot and walk order on Solana, block and log index on Robinhood Chain); VWAP Σ quote ÷ Σ tokens; dollars are the quote figures × the hour's `quoteUsd`.
- **The quote in dollars is exactly what `risk_pool_flow` used**, so the two reconcile: on Solana the pool's hourly reconstruction (`history-full/hourly/<pool>.jsonl`: USDC at par, decision D20, other quotes implied from the asset's USDC pool); on Robinhood Chain `hourlyRows` of `scripts/risk-evm/history.ts` over the whole walk (USDG at par, as RU.14's method states; another stock at its own dollar pool's price; the gas coin at the chain's median). Nothing else is put at par. An hour without a price, or a pool whose quote decimals the registry does not give, counts its swaps as `unpriced_swaps` and has no dollar figure.
- **Two differences from the flow import, kept on purpose:** a Robinhood v4 swap that logged nothing going in is not a purchase: it stays out of the sides and is counted in `detail.swapsWithoutSide` (an hour with only such swaps keeps a bar with no swap); and the sides of a pool without quote decimals come from the signs of its amounts, where the flow import counts them all as purchases.
- **The check** (`bars-check.ts`) sums each pool's bars over each `risk_pool_flow` row's window (24 h, 7 d, 28 d to its `data_to`) and regime (the bar's `detail.regime`, set by the flow import's own rule: the hour's row, else the first swap read) and compares swaps, sides, unpriced swaps and the two dollar sums. Counts must be equal; dollars equal or within the float summation bound (`withinRounding`: 2·n·ε·|sum|). Each differing row gets its cause where the check can show it (`swaps_without_side`, `sides_of_a_pool_without_quote_decimals`, `history_extended_after_import`, `hourly_prices_rebuilt`), else `unexplained`; the full list goes to `<ASSETS_DATA_DIR>/<chain>/bars-check-<stamp>.json`.
- **Tests:** `tests/risk-layer/assets-bars.test.ts` on real hours frozen by `freeze-bars-fixture.ts` (`fixtures/risk/assets/bars/`), every figure worked out by hand from the raw amounts.

## The backfill, counted first (AS.8)

```sh
pnpm risk:assets-backfill <series> [--count]          # the default: sample, estimate, write the count file
pnpm risk:assets-backfill <series> --fetch --window … # one window, to measure the walker
pnpm risk:assets-backfill <series> --fetch --all      # the whole series: Rodrigo's to start (refused without a count that fits)
```

| Series | Walker | Count | A window |
|---|---|---|---|
| `robinhood-logs` | `scripts/risk-evm/backfill-logs.ts` | the chain's life in strata (`--strata 16`), one 100,000-block window sampled in each, every log of six filters counted by class | `--window <fromBlock>-<toBlock> [--pool <pool or v4 id> \| --token <address>] [--kind swaps\|supply\|liquidity]` |
| `chainlink-rounds` | `scripts/risk-evm/backfill-rounds.ts` | exact: phases, each phase's aggregator, its latest round | `--feed <proxy>` |
| `solana-swaps` | `backfill-solana.ts` | anchored pages per pool (below), the dust pools sampled (`--dust-every 20`), calibrated on Step 5b's exact walk (`--exact`) | `--pool <address> --window <fromISO>..<toISO> [--per-hour 30]` |
| `solana-mints` | `backfill-solana.ts` | anchored pages per mint | `--mint <address> --window <fromISO>..<toISO>` |
| `external-daily` | `backfill-external.ts` | DefiLlama's first price and daily depth on a sample, five protocols' TVL | `--coin <chain:address>` or `--protocol <slug>` |

- **Where files go:** `ASSETS_DATA_DIR` (default `data/assets`; this machine: the main checkout's `data/assets`, never committed): `<chain>/<series>/count-<stamp>.json`; raw rows gzip per subject and UTC day, `robinhood/<swaps|supply|liquidity>/<subject>/<day>.jsonl.gz`, `robinhood/chainlink/<proxy>/<day>.jsonl.gz`, `solana/<swaps|mints>/<address>/<day>.jsonl.gz`, `external/<subject>/daily.jsonl.gz`, each folder with a `manifest.json` (`Manifest` in `packages/risk/src/assets/backfill.ts`: the windows covered, rows and bytes per day, the checks). Every run appends to `<out>/runs.jsonl`.
- **Resumable and windowed:** a Robinhood piece already fetched for the same filters is skipped (`<out>/robinhood/fetched.json`); a Solana window continues below the oldest signature the previous one kept. A gzip file may hold several members, one per piece; readers dedupe by (block, log index) or by signature.
- **The budget (DA14, amended):** at most 35 GB of new data under `<out>`, and never below 25 GB free (`fitsBudget`), checked before a fetch and after each piece; `--all` refuses unless the newest count file's estimate fits.
- **Robinhood Chain's endpoint:** nothing is read from minute 1 to minute 14 of an hour (`quietWaitMs`: the live loop's minutes); a refusal for size halves the window; rate, outages and a Cloudflare 403 wait 30 s to 10 min and ask again.
- **Solana's anchored pages:** `getSignaturesForAddress(address, { before: <a signature at time T>, limit })` gives the signatures just before T; a page at each of a fixed set of times (now, every 15 days to day 90, monthly to 2025-06-25) gives the rate there, and a short page reaches the address's first transaction. The anchors are signatures of walks already on disk (the lending history's day files, Step 5b's), chosen by date and never fetched. Calls go through `scripts/risk/lib-pools.ts`'s `rpc()`; run with `DOTENV_CONFIG_PATH` set to the main checkout's `.env`, or they silently use the public endpoint (the count file names which).
- **Tests:** `tests/risk-layer/assets-backfill.test.ts`: the pure parts by hand, and a recorded fetch of each Robinhood walker replayed (`fixtures/risk/assets/backfill/`, recorded with `--record <file>`).
