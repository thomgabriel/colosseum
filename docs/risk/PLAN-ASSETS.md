# PLAN-ASSETS.md — every token of the product's classes on Solana and Robinhood Chain, and the pipeline that keeps its data

*Written Sat 2026-10-10 on branch `universe/assets-plan` (cut from `staging` at `4f2585c9`). It continues `docs/risk/PLAN-UNIVERSE.md`, whose decisions DU1 to DU8 still apply, and fills what its section 5 left out. Build prompt: `docs/risk/PROMPT-BUILD-ASSETS.md`. Ledger rows: ASSET-1 and ASSET-2 in `docs/vault/STATE-VAULT.md`. Gates proposed for Rodrigo: `ASSET-UNIVERSE`, `ASSET-METRICS`; decided by him: `ASSET-HISTORY` (`docs/GATES.md`).*

*Scope: Solana and Robinhood Chain. Base is not enumerated (gate `BASE`).*

---

## 1. Summary

- **What it builds.** One list per chain of every token of the classes the product knows: tokenized stocks and funds, gold and commodities, dollar yield in its four leg types, stablecoins and cash, crypto, and the other real-world assets. Each row says what the token is, read on chain and from its issuer, and where it stands (`listed`, `candidate`, `held_out`, `excluded`) with the reason. Then two tables and the jobs that fill them: facts over time per token (`asset_observations`) and hourly bars per pool and per token (`market_bars`), with the backfill each series allows.
- **What it does not decide.** Which tokens a plan may hold. The lists hold verdicts the research already gave, with their source, and the defaults of section 4; the shelf is Rodrigo's (`/decide` under `UNIVERSE`).
- **What stays as it is.** The stock lists of `PLAN-UNIVERSE.md` (18 rows on Solana, 30 on Robinhood Chain), `TrackedAsset`, the collectors, the `/risk/*` routes. A tracked stock's row here names its row there and copies none of it.
- **Most likely failure:** the size of the Solana stock class. Jupiter's verified list of Oct 1 tags 1,171 tokens `xstocks`, 449 `ondo` and 1,701 `stocks`, where the plan's names assumed a few dozen. The Solana list classifies by rules over the listing's tags and the mint's authorities, each rule with its source, and says per rule how many rows it decided.
- **Second risk: the disk.** The prompt's stop line is 100 GB; this machine has 68 GB free on Oct 10. The backfill is counted first and runs inside a budget of 35 GB, stopping if free space falls below 25 GB (DA14, amended, pending Rodrigo).

## 2. What we know now

Checked against `origin/staging` at `4f2585c9` and the files on this machine, 2026-10-10.

| Fact | Evidence |
|---|---|
| Stocks and funds: 18 tracked on Solana (10 with a Scope entry), 30 on Robinhood Chain (24 with a Chainlink feed), both by the 80% rule | `scripts/risk/universe/solana.json`, `robinhood.json`; gate `UNIVERSE` |
| The issuer's registry on Robinhood Chain answered 194 tokens on 2026-10-05 18:05Z, all `ASSET_STATUS_ACTIVE`, each confirmed on chain, each with an ISIN and a multiplier in the registry's own text. The prompt and the launch-shelf note say 195 | `~/Documents/Colosseum-data/risk-evm/universe-robinhood-20261005T1805.json` (`counts.tokens` 194) |
| Jupiter's verified list on Solana, 2026-10-01 00:46Z: 3,762 tokens. Tags: `xstocks` 1,171, `stocks` 1,701, `rwa` 1,708, `ondo` 449, `equities` 115, `prestocks` 9, `lst` 147, `original-lst` 122, `stable` 20, `yield` 178, `yb` 16, `jup-lend-earn` 7, `commodities` 3, `meme` 818, `launchpad` 482, `duplicate` 3, `deprecated` 1. Each row carries `tokenProgram`, supply, holder count, price and liquidity: the last are Jupiter's figures, not ours | `data/risk/jup-verified-20261001T0046Z.json` in the main checkout |
| The structurer's registry holds 8 rows, not nine: USDC, USDT, kUSDC, syrupUSDC, USDY, SPYx, QQQx and the abstract BRL leg | `packages/engine/src/assets/registry.ts` |
| Dollar yield: 19 rows on the Solana extended shelf (7 a plan may hold, 4 non-dollar bonds held out, 8 on hold) and 5 on Robinhood Chain (2 to add with caution, the PT listed and held out, 2 on hold). They are fixture rows with a verdict, a source and what was not verified; none is read by a job | `packages/engine/src/personal/fixtures/shelves/solana-yield.json`, `robinhood-yield.json`; ledger rows SHELF-YIELD-SOL, SHELF-YIELD-RH |
| Gold on Solana is PAXG (Token-2022, 6 decimals, Paxos holds a permanent delegate); it is in no list | gate `GOLD-PAXG` |
| Prices: pool mid, Scope and Jupiter Lend for the tracked stocks and the lending assets, one reference price per asset and hour on Solana (RISK-4); Chainlink beside the pool price each hour on Robinhood Chain (RU.7), in `risk_price_observations` | `scripts/risk/prices/`, `scripts/risk-evm/oracle.ts` |
| Yields: the registry's rows through `pnpm feeds:refresh`; jlUSDC and SGOV through `feeds:refresh-models`; nothing else | `scripts/feeds/` |
| Pool TVL and volume: every registered Solana pool at registry build, DexScreener's 24 h volume at discovery; Robinhood Chain's in the cut files, not in the database (DU6) | `risk_pools`, `~/Documents/Colosseum-data/risk-evm/` |
| Supply, holders, protocol TVL, token standard and authorities: nothing systematic on either chain | |
| Trades held today: Solana, every swap of 34 pools over 28 days (Step 5b, `data/risk/history-full`, 23 GB with the rest of `data/risk`); Robinhood Chain, every swap of the cut's 427 pools over 30 days (RU.14, 6.0 GB) | `docs/risk/STATE-RISK.md` Step 5b; `PLAN-UNIVERSE.md` §6 RU.14 |
| Free disk on this machine: 68 GB of 460 GB | `df -h ~`, 2026-10-10 |
| The last migration on `staging` is `0020_vault_numbers.sql`. The ledger's MIGRATION row still names API-THREAD-STORAGE, whose `0019` merged on Oct 8; `0020` was generated after it (API-VAULT-NUMBER, PR #212). No open pull request and no branch on the remote holds a `0021` | `packages/db/migrations/`; `gh pr list`; `git ls-tree` of every remote branch, 2026-10-10 |

## 3. The steps

**Who does what:** the session builds. Rodrigo does what is marked **YOU**. Each step ends with its check, `pnpm verify`, and its row in section 6.

**Constraints for the whole plan.** Those of `PROMPT-BUILD-ASSETS.md` section 7, in short: read-only on mainnet; nothing running is disturbed (no collector file edited, no job reloaded, nothing written under `~/.colosseum/` or `~/Documents/Colosseum-data/`); additive only; every figure with `source`, `fetched_at`, `method`, `provenance`; a missing fact is `null` with a reason; oracle, pool and aggregator prices kept apart; no paid or keyed source; nothing under `data/` committed.

**AS.1 — The plan and the row** (branch `universe/assets-plan`).
This document; the zod schemas `UniverseAsset`, `UniverseList`, `UniverseVerdicts` and the category table `CATEGORY_CLASS` in `packages/schemas/src/asset-universe.ts` (additive; imports nothing outside the package).
- **The statuses the schema holds** (the plan's decisions, so no builder can drift from them): a permissioned token, a token with a maturity or in another currency, a token with no class and a dollar-yield token with no leg type are never `listed` or `candidate` (DA4, DA7, the prompt's 5.3); a tracked stock names its tracked row and no other row does.
- **Check:** `pnpm exec vitest run tests/asset-universe-schema.test.ts tests/asset-universe-assemble.test.ts`: a row of each kind parses; every rule of the row refuses what it should (a null without its reason, a class that is not the category's, leg types outside dollar yield, a tracked stock that copies its pools or oracle or names none, a listed row with no shelf, an offered status the plan holds out, the other chain's standard, symbol source, authorities or registry, an EVM implementation without a proxy); the rules a token matches apply in the table's order, each once; the schema's leg types equal the engine's `LegType`.

**AS.2 — The Solana list** (branch `universe/assets-solana`).
`pnpm risk:assets solana` writes `scripts/risk/assets/solana.json` from reads, in the order of the prompt's section 5.2: Jupiter's verified list with every tag; the reserves the lending import knows (`risk_lending_pools`); the two screening notes and their inputs; DefiLlama's public lists as names only; the issuers' pages. Every candidate address is then read on chain in batches (`getMultipleAccounts` on the mints and their metadata accounts): decimals, the token program, the Token-2022 extensions by name, the mint, freeze and permanent-delegate authorities, symbol and name. The verdict columns come from `scripts/risk/assets/solana.verdicts.json` (schema `UniverseVerdicts`): rules for a class a listing names in one way (the `xstocks` and `ondo` tags, the LSTs), and one verdict per address elsewhere; the command refuses a verdict for an address it did not read. Memecoins are not enumerated (the Oct 1 note: no meme index in the MVP), and neither is BRS (gate `G-NORA`).
- **Check:** the file validates; every row's identity was read on chain at a recorded slot and carries a source; a test holds the committed list to its frozen inputs (`fixtures/risk/assets/`), as `tests/risk-universe-list.test.ts` does; the run prints rows per category, status and null reason, and the calls and seconds of each read.

**AS.3 — The Robinhood Chain list** (branch `universe/assets-robinhood`).
`pnpm risk:assets robinhood` writes `scripts/risk/assets/robinhood.json`: every row of the issuer's registry, not only the cut, with the chain's `decimals()` and `symbol()` beside the registry's and the registry's status, ISIN and multiplier kept; Chainlink's directory for the feeds; the dollar and yield tokens of the screening note; DexScreener's pairs for the chain as names of what else trades there, each confirmed on chain before it is a row. Each token's code is read: whether it is an EIP-1967 proxy and its implementation, whether its bytecode carries a pause or a blacklist, and its owner and admin. Venues other than Uniswap stay unread (D4, `BYREAL-D4`): their pools are counted from DexScreener's listing and marked unconfirmed.
- **Check:** as AS.2, on `fixtures/risk-evm/assets/`; every registry row has a list row.

**AS.4 — Two tables, one migration** (branch `universe/assets-metrics`).
`asset_observations` (one narrow row per chain, token, metric, source and time, with a `null_reason`, a `detail` and the four provenance columns) and `market_bars` (one hour of one pool, or of one token across its pools, from the swap history), by migration `0021`, under the migration token claimed on 2026-10-10 (DA3). `tests/db-schema.test.ts`, `docs/DATA-MODEL.md` and `DESIGN-VAULT.md` section 4 say the new tables.
- **Check:** `pnpm db:migrate` on a scratch database applies `0021` and nothing else; the schema test lists the tables; a row with a value and a reason both, or neither, is refused by the table's check.

**AS.5 — The readers and the import.**
Pure code in `packages/risk/src/assets/` takes reads and returns rows (no I/O, no clock); I/O in `scripts/risk/assets/` and `scripts/risk-evm/`; `pnpm risk:assets-import` upserts and prints the counts. The metrics of the prompt's section 6.2, each with its method: `supply_total`, `supply_issuer`, `holders_top20_share`, `pool_tvl_usd`, `dex_volume_24h_usd`, `protocol_tvl_usd`, `exchange_rate`, `yield_realised_30d`, `yield_quoted`. Prices go to `risk_price_observations` under their own source (`external:<name>`, `pool_mid`, `kamino_scope`, the Chainlink id RU.7 writes); the registry's yields keep going to `yield_observations`. Exit cost is not read here (Bearing's curves).
- **Check:** on frozen reads every metric's row is recomputed by hand; a fact a free source does not give is `null` with its reason; the import against the local database writes rows for every row of both lists and a second run inserts nothing new for the same reads; `tests/no-yield-literals.test.ts` stays green.

**AS.6 — The jobs.** One installer per chain in the pattern of `scripts/risk/prices/install-job.sh`: a new launchd bundle beside the collectors' that edits none of their files and reloads none of their jobs (`PRICE-JOB`); every run appends a line to a run log with its calls, duration and errors per token.
- **Check:** the dry run of each job completes with no write; the installer run into a temporary folder with no load produces a bundle that runs the dry run. **YOU:** install them (DA9).

**AS.7 — Bars from the trades already held.** The 28 days of Solana swaps (`data/risk/history-full`) and the 30 days on Robinhood Chain (RU.14's files) become hourly bars per pool and per token in `market_bars`, before anything older is fetched.
- **Check:** for every pool the bars' swaps and volume over each of `risk_pool_flow`'s windows equal that table's, or the difference is listed with its cause; the unpriced swaps are counted, never priced at par.

**AS.8 — The backfill, counted first** (the prompt's section 6.4, limits decided by Rodrigo on 2026-10-10).
In order: (1) Robinhood Chain logs for the whole life of every pool and token of the list, swaps first, then transfers at the zero address, then liquidity events; (2) every Chainlink round; (3) Solana: count, then every swap and liquidity event of the pools of the tracked stocks and of every listed or candidate token over the last 90 days, newest day first, then the sampled walk from day 91 back to each pool's first transaction; (4) the mints of the listed and candidate tokens on Solana, whole life (USDC and USDT not walked, DA15); (5) the external daily series for every row. Raw events stay on disk, compressed per pool or token and day, under `data/assets/` in the main checkout, with a manifest per pool or token; the bars and facts go to Postgres.
- **Check:** each series is counted before it is fetched and the count, the estimated bytes and the budget are recorded here; each step records its window, counts, errors, bytes and duration in section 6 before the next starts; a series that would pass the budget stops and is reported, never truncated silently.
- **Where this session stops (Rodrigo, 2026-10-10):** the walkers are built, tested on frozen reads and run on a short window to measure their rate; every series is counted with its estimated bytes and hours; then the full ingestion waits. **YOU:** start it (`pnpm risk:assets-backfill`, in the order above), or say which series first.

## 4. Decisions

| # | Question | Default | Status |
|---|---|---|---|
| DA1 | The fine categories and their class | `UniverseCategory` and `CATEGORY_CLASS` in `packages/schemas/src/asset-universe.ts`: the table of the prompt's section 5.3 with four added from what the reads name: `savings_rate` (sUSDS) as dollar yield, `stablecoin_synthetic` (USDe) as cash, `wrapped_other` as crypto, and `other` with no class and its reason. A row's class is always its category's | default (pending Rodrigo) |
| DA2 | Where the all-class list lives | `scripts/risk/assets/<chain>.json`, generated and committed; the stock list unchanged beside it | default |
| DA3 | One narrow `asset_observations` table, by migration `0021` | Yes. The ledger's row named a holder whose migration had merged, and the migration after it was taken without the row changing (section 2), so the token was claimed for ASSET-2 on 2026-10-10 in the plan's pull request, before `0021` was generated. Thom may take it back: `0021` is renumbered then | stated, not chosen (Thom to confirm) |
| DA4 | Permissioned funds (BUIDL, OUSG, BENJI, USTB, USYC, VBILL, WTGXX, ACRED) | In the list, `held_out`, metrics read where public; never on a shelf, since a vault cannot be put on an allowlist | default |
| DA5 | Which screened dollar-yield tokens join the structurer's registry | None by this work; their readings go to `asset_observations` until he decides by `/decide` under `UNIVERSE` | default |
| DA6 | Crypto: native, LSTs, wrapped BTC and ETH, governance | Enumerated and read, class `crypto`, status `candidate`; memecoins not enumerated | default |
| DA7 | Non-dollar assets (EURC, the Etherfuse bonds) | Enumerated with `currency`, `held_out` under `USD-ONLY` | default |
| DA8 | Free sources accepted as `external:<name>` | DefiLlama, DexScreener, CoinGecko's free endpoint without a key, the issuers' and protocols' public APIs, Jupiter's lite API, Chainlink's directory; nothing that needs a key | default; stop before any paid or keyed source |
| DA9 | Cadence and where the jobs run | The prompt's section 6.2; on Rodrigo's machine beside the other jobs (DU5), installed by him | the install is his |
| DA10 | A `chain` column | Not on the existing tables (DU6); the new tables have one from the start | default |
| DA11 | How far back | The prompt's section 6.4: whole life where cheap, 90 days of per-swap history on Solana and a sampled walk beyond, state from Oct 1 | decided 2026-10-10 (Rodrigo) |
| DA12 | The grain kept | Raw events on disk, hourly bars in Postgres, facts at every change; per-swap rows in Postgres only for the reference pools of the shelf, and only if he asks | default |
| DA13 | Pool state on Robinhood Chain before Oct 2 | Not rebuilt; a v3 and v4 replay is a later step | default |
| DA14 | Disk and RPC budget | Count before fetching. **Amended for this machine:** 68 GB are free, so the prompt's 100 GB cannot be reached; the backfill may take 35 GB and stops if free space falls below 25 GB. A keyed indexer is DA8's question | stated, not chosen (pending Rodrigo) |
| DA15 | USDC and USDT supply history | The external daily series only; their mints are not walked | default |
| DA16 | A stock token that is not tracked | A row with `status: candidate` and the reason "outside the 80% cut": not tracked, its pools counted where the chain's files know them, no oracle read for it beyond the directory | stated, not chosen (pending Rodrigo) |
| DA17 | BRS, the BRL stablecoin on Solana | Not enumerated: no BRS-specific code or row until `G-NORA` passes (`CLAUDE.md`) | default |

## 5. Not in this plan

- Base.
- Memecoins, and any token outside the classes of DA1.
- Which tokens a plan may hold, a change to the structurer's registry, or a cap. The lists carry verdicts; the shelf is decided elsewhere (DA5).
- Exit cost and depth: Bearing's collectors and curves, read as the API already reads them.
- Pool state on Robinhood Chain before Oct 2 (DA13), and a Solana replay outside the 90 days.
- A decoder for a venue we do not read (D4).
- Installing the jobs, a deploy, any change to live data beyond the local database's new tables, a paid or keyed source.
- The full backfill fetch: built and counted here, started by Rodrigo (AS.8).

## 6. Status

| Step | Status | Evidence |
|---|---|---|
| AS.1 The plan and the row | done 2026-10-10 | The row: `packages/schemas/src/asset-universe.ts` (`UniverseAsset`, `UniverseList`, `UniverseVerdicts`, `CATEGORY_CLASS`, `universeCounts`). The join both chains use: `packages/risk/src/assets/universe.ts` (`universeRow`, `universeList`, `verdictOf`, `unreadVerdicts`), pure; the command `pnpm risk:assets <chain>` (`scripts/risk/assets/build.ts`, README beside it), which validates what a chain's builder returns before it writes. `pnpm exec vitest run tests/asset-universe-schema.test.ts tests/asset-universe-assemble.test.ts`: 21 passed. `pnpm verify` on `89ef75c0`: lint, typechecks and build pass; 9,331 tests pass, 11 failed in three files that read the local database. Ten were the local database missing `0020_vault_numbers` (applied with `pnpm db:migrate`, after which those files pass); the eleventh, `tests/solana-vault/deployment.test.ts`, fails on the local database's content: its `basket_assets` holds rows of another deploy record (`solana:usdc`, `solana:spyx`, `solana:qqqx` at addresses not in `solana-devnet`). That table is left as it is; CI's Postgres is clean |
| AS.2 The Solana list | todo | |
| AS.3 The Robinhood Chain list | done 2026-10-11 (branch `universe/assets-robinhood`; review findings fixed the same day) | `RISK_EVM_DIR=~/Documents/Colosseum-data/risk-evm pnpm risk:assets robinhood`, then `pnpm risk-evm:assets-freeze --from <reads>`: `scripts/risk/assets/robinhood.json`, 250 rows at block 85,496,958 (2026-10-11 02:43 UTC), from `scripts/risk/assets/robinhood.verdicts.json` (7 rules, 30 verdicts) and the reads frozen in `fixtures/risk-evm/assets/robinhood-reads-20261011T0243.json.gz` (168 KB) with six code samples (18 KB). By category: tokenized_stock 188, tokenized_etf 2, tokenized_gold 3, tokenized_commodity 2, treasury_fund_open 1, lending_deposit 1, private_credit 3, savings_rate 1, basis_strategy 1, fixed_maturity 1, stablecoin_usd 4, stablecoin_synthetic 1, native 1, wrapped_eth 1, wrapped_btc 1, liquid_staking 1, lp_share 1, yield_claim 1, other 36. By status: listed 31, candidate 170, held_out 13, excluded 36. By class: stock 188, etf 2, gold 3, commodity 2, dollar_yield 8, cash 5, crypto 4, none 38. Null reasons: owner `no_owner_function` 219; admin `no_owner_function` 194 (the stock tokens' beacon has no owner()), `none` 44, `admin_slot_empty_code_delegates` 3, `uups_upgrade_in_implementation` 2; pausable `code_may_run_elsewhere` 5, blacklist 6, proxy unknown 3; oracle `no_feed` 164, `excluded_row` 36, `in_tracked_row` 30, `feed_named_in_other_case_not_tied` 3, `symbol_shared_by_tokens` 2, `issuer_not_confirmed` 1; pools `no_known_pool` 12, `in_tracked_row` 30; access, mint and redeem, yield mechanism `not_read_on_an_issuer_source` 194 (the registry tokens). Reads: issuer registry 1 call 0.6 s (194 rows, the same 194 addresses as on Oct 5; chain and registry agree on symbol and decimals for all 194); Chainlink directory 1 call 0.1 s (58 feeds); DexScreener 147 calls 197 s (790 pairs, 462 tokens named, 94 with a class name), 0 errors; chain 9 `eth_call` 2.5 s, 789 `eth_getStorageAt` 51.8 s, 273 `eth_getCode` 74.7 s, feeds 1 `eth_call` 0.3 s, 0 errors, 4 requests answered with a Cloudflare challenge and asked again. `pnpm exec vitest run tests/risk-assets-robinhood.test.ts`: 21 passed (the committed list rebuilt from the frozen reads key for key, every registry row a row, the four refusals, the decoders and the selector scan on frozen bytes, no flag false where the running code delegates, USDG through its facet router, the selectors and slots as hashes, a pool count by hand). Details: `scripts/risk/assets/README.md` ("Robinhood Chain"), `scripts/risk-evm/README.md` ("The asset universe (ASSET-1)") |
| AS.4 Two tables, one migration | todo | |
| AS.5 The readers and the import | todo | |
| AS.6 The jobs | todo | |
| AS.7 Bars from the trades already held | todo | |
| AS.8 The backfill | todo | |

### Stated, not chosen

- The disk budget of DA14 and the status of an untracked stock token (DA16): the orchestrator's, for Rodrigo to confirm.
- Four categories added to the prompt's table (DA1), each with the token that asked for it.
- The migration token, claimed from a stale row (DA3), for Thom to confirm.
- The two counts that differ from the prompt (section 2): the registry's 8 rows and the issuer's 194 tokens.

### Discovered

- **AS.3, Robinhood Chain (2026-10-11).** The public RPC sits behind Cloudflare, which answers some requests from Node's fetch with a challenge (HTTP 403, `cf-mitigated`; curl is let through). The hourly loop does not retry a 403: by its run log, 7 of its 12 runs from 14:04 UTC on Oct 10 to 01:04 UTC on Oct 11, and the run of 02:04, lost the same 16 tokens to it, the first at 15:04 on Oct 10, before this work. The asset list asks such a request again after 15 seconds and reads nothing between minutes 1 and 14 of an hour. Not fixed in the loop (its files are not edited before Oct 12): for Rodrigo, with DA8's question of a keyed endpoint.
- **AS.3.** 26 tokens on the chain carry the symbol of a stock token of the issuer's registry without being in it (GME 4, PLTR 4, AMD 3, AMC, CRCL, MSTR and NVDA 2 each, AAPL, AUR, FLY, NBIS, QQQ, SPCX, USAR); one deployer (owner `0x3f5d…7dbe`) names its copies as the issuer does ("NVIDIA • Robinhood Token", "Strategy Inc. • Robinhood Token"), and made a USDG at `0x5fc591…d168`, an address that begins and ends as USDG's. Each is excluded by a rule over DexScreener's names; a symbol alone never identifies a token here.
- **AS.3.** The "USDT" of the screening note (`0x5b54…c09b`) has 18 decimals, no owner() and no pause or blacklist: held out as not shown to be Tether's deployment. Both "USDC" call themselves dog and cat coins and are excluded.
- **AS.3 (review).** USDG's implementation (`0x6818…6f8f`) is a facet router: it pushes `getFacet(bytes4)`, and `getFacet()` of USDG sends `paused()`, `pause()`, `unpause()`, `isFrozen(address)` and `freeze(address)` to facet `0x58ca…e942`, so USDG is pausable and can freeze an address; a first version of the list read the implementation alone and wrote both false. A flag is now never false where the code that runs has a DELEGATECALL (7 flags moved from false to null: rUSDG, spUSDG, weETH, USAR's copy). USDG and spUSDG are UUPS proxies: their empty admin slot is `uups_upgrade_in_implementation`, not `none`.
- **AS.3.** All 194 registry tokens are proxies of one beacon (`0xe10b…1b00`, implementation `0xb354…5ae2`, pausable, with `isBlocked(address)`); the beacon answers no owner(), so who can change the code of every stock token at once was not read (an AccessControl role, most likely).
- **AS.3.** Chainlink's directory prices USDE, WEETH, WSTETH, CBBTC, WBTC, LBTC, BTC, BTC.B, LINK, ENA, EURC, USDS, USDC and USDT on the chain. By the oracle map's rule (letters as written) only ETH / USD and USDG / USD tie to a row here: USDe and weETH are spelled otherwise, and no wstETH address was found on DexScreener, so wstETH, named by the note and the directory, is not a row. Whether a feed may be tied regardless of case is a decision.
- **AS.3.** frxUSD (`0x0000…f1e5`, a proxy whose code can pause and block) and aUSD ("Arrow USD") trade on the chain and are in no note: held out as not screened. cbBTC (`0xcec1…0be4`) is named only by DexScreener: held out until a source ties the address to Coinbase.
- **AS.3.** A pool with a registry stock on one side is counted from the discovery file of Oct 5 only, so a pool made since is not counted (the 12 `no_known_pool` rows include impostor tokens of NBIS and PLTR that trade against the real ones).
- **AS.3.** DexScreener names venues beyond the five of D4: up, Sushiswap, Swaphood, flap.sh, Uniswap v2. None is read; their pools are `unconfirmed`.

- The ledger's MIGRATION row is stale: it names a holder whose migration merged, and the migration after it was generated without the row changing (section 2).
